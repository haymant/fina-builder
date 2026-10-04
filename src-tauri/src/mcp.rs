//! Rust-managed MCP stdio client for the local agent.
//!
//! The chat needs the tools the bundled `fina-mcp` server advertises. Driving
//! the child process through the webview shell plugin is fragile (it depends on
//! the sidecar permission scope and the exact `externalBin` name), so the
//! process is owned here instead: the desktop shell spawns `fina-mcp`, performs
//! the MCP `initialize` handshake, and exposes `mcp_list_tools` / `mcp_call_tool`
//! to the frontend. The webview never spawns a process.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use serde::Serialize;
use serde_json::{json, Value};

const PROTOCOL_VERSION: &str = "2025-11-25";
const INIT_TIMEOUT: Duration = Duration::from_secs(20);
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// One tool advertised by the MCP server, in the shape the UI/agent needs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCallResult {
    pub content: Value,
    pub structured_content: Option<Value>,
    pub is_error: bool,
}

/// A running MCP server connection.
struct McpProcess {
    child: Child,
    stdin: ChildStdin,
    next_id: i64,
    /// Responses delivered by the reader thread, keyed by JSON-RPC id.
    responses: Arc<Mutex<HashMap<i64, Value>>>,
    /// Woken by the reader thread whenever a response arrives.
    wake: mpsc::Receiver<()>,
    server_name: String,
    server_version: String,
}

impl McpProcess {
    fn spawn(binary: &str) -> Result<Self, String> {
        let mut child = Command::new(binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Could not start fina-mcp ({binary}): {e}"))?;
        let stdin = child.stdin.take().ok_or("fina-mcp stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("fina-mcp stdout unavailable")?;
        let responses: Arc<Mutex<HashMap<i64, Value>>> = Arc::new(Mutex::new(HashMap::new()));
        let (wake_tx, wake) = mpsc::channel();
        let reader_responses = responses.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                if let Some(id) = message.get("id").and_then(Value::as_i64) {
                    if let Ok(mut store) = reader_responses.lock() {
                        store.insert(id, message);
                    }
                    let _ = wake_tx.send(());
                }
            }
            // Reader ended: wake any waiter so it can time out promptly.
            let _ = wake_tx.send(());
        });

        let mut process = McpProcess {
            child,
            stdin,
            next_id: 1,
            responses,
            wake,
            server_name: String::new(),
            server_version: String::new(),
        };
        process.initialize()?;
        Ok(process)
    }

    fn write_message(&mut self, message: &Value) -> Result<(), String> {
        let line = format!("{message}\n");
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("Could not write to fina-mcp: {e}"))
    }

    fn wait_for(&mut self, id: i64, timeout: Duration) -> Result<Value, String> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if let Ok(mut store) = self.responses.lock() {
                if let Some(value) = store.remove(&id) {
                    return Ok(value);
                }
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(format!("fina-mcp did not respond to request {id} in time"));
            }
            match self.wake.recv_timeout(remaining) {
                Ok(()) | Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("fina-mcp connection closed".into())
                }
            }
        }
    }

    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let message = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        // Drain stale wake signals so an earlier response cannot satisfy us.
        while self.wake.try_recv().is_ok() {}
        self.write_message(&message)?;
        let response = self.wait_for(id, timeout)?;
        if let Some(error) = response.get("error") {
            return Err(format!("fina-mcp error: {error}"));
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    fn initialize(&mut self) -> Result<(), String> {
        let result = self.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "fina-builder-local-agent", "version": env!("CARGO_PKG_VERSION") }
            }),
            INIT_TIMEOUT,
        )?;
        self.server_name = result
            .pointer("/serverInfo/name")
            .and_then(Value::as_str)
            .unwrap_or("fina-mcp")
            .to_string();
        self.server_version = result
            .pointer("/serverInfo/version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        self.write_message(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))?;
        Ok(())
    }
}

impl Drop for McpProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Serialized MCP connection owned by `LocalAgentRuntime`.
#[derive(Default)]
pub struct McpRuntime {
    process: Mutex<Option<McpProcess>>,
}

impl McpRuntime {
    /// Connect if not already connected, returning the advertised tools.
    pub fn list_tools(&self, binary: &str) -> Result<(String, String, Vec<McpTool>), String> {
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "MCP state is unavailable")?;
        if guard.is_none() {
            *guard = Some(McpProcess::spawn(binary)?);
        }
        let process = guard.as_mut().ok_or("MCP process is unavailable")?;
        let result = process.request("tools/list", json!({}), INIT_TIMEOUT)?;
        let tools = result
            .get("tools")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|tool| {
                        let name = tool.get("name").and_then(Value::as_str)?.to_string();
                        Some(McpTool {
                            name,
                            title: tool
                                .get("title")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            description: tool
                                .get("description")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            input_schema: tool
                                .get("inputSchema")
                                .cloned()
                                .unwrap_or_else(|| json!({"type":"object"})),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok((
            process.server_name.clone(),
            process.server_version.clone(),
            tools,
        ))
    }

    pub fn call_tool(&self, name: &str, arguments: Value) -> Result<McpCallResult, String> {
        let mut guard = self
            .process
            .lock()
            .map_err(|_| "MCP state is unavailable")?;
        let process = guard.as_mut().ok_or("MCP is not connected")?;
        let result = process.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
            CALL_TIMEOUT,
        )?;
        Ok(McpCallResult {
            content: result.get("content").cloned().unwrap_or_else(|| json!([])),
            structured_content: result.get("structuredContent").cloned(),
            is_error: result
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    /// Drop the connection so the next call respawns the server.
    pub fn reset(&self) {
        if let Ok(mut guard) = self.process.lock() {
            *guard = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Resolve the workspace `fina-mcp` binary for an integration-style test.
    fn test_binary() -> Option<String> {
        if let Ok(path) = std::env::var("FINA_MCP_BIN") {
            if std::path::Path::new(&path).is_file() {
                return Some(path);
            }
        }
        let manifest = env!("CARGO_MANIFEST_DIR");
        for profile in ["debug", "release"] {
            let candidate = std::path::Path::new(manifest)
                .join("..")
                .join("target")
                .join(profile)
                .join("fina-mcp");
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
        None
    }

    #[test]
    fn lists_and_calls_tools_over_stdio() {
        let Some(binary) = test_binary() else {
            // The mcp binary is built by `cargo build -p fina-mcp`; skip when absent.
            eprintln!("skipping: fina-mcp binary not built");
            return;
        };
        let runtime = McpRuntime::default();
        let (server, _version, tools) = runtime.list_tools(&binary).expect("tools/list");
        assert_eq!(server, "fina-mcp");
        assert!(tools.iter().any(|tool| tool.name == "health"));

        let result = runtime.call_tool("health", json!({})).expect("tools/call");
        assert!(!result.is_error);
        assert_eq!(
            result
                .structured_content
                .as_ref()
                .and_then(|value| value.get("version"))
                .and_then(Value::as_str),
            Some(fina_kernel::VERSION)
        );
        // Reuse: a second call should not respawn and should still work.
        let again = runtime.call_tool("health", json!({})).expect("second call");
        assert!(!again.is_error);
    }
}
