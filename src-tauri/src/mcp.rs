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
use std::sync::OnceLock;

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
    fn spawn(binary: &str, env: &[(String, String)]) -> Result<Self, String> {
        let mut child = Command::new(binary)
            .envs(env.iter().map(|(key, value)| (key.clone(), value.clone())))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("Could not start {binary}: {e}"))?;
        let stdin = child.stdin.take().ok_or(format!("{binary} stdin unavailable"))?;
        let stdout = child.stdout.take().ok_or(format!("{binary} stdout unavailable"))?;
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

/// Registry of named MCP stdio connections owned by the Tauri runtime.
///
/// `fina` is the bundled demo server; `riga` is `riga-mcp`; `tac` is
/// `tac-engine`. Each server is spawned lazily on first use and kept alive.
#[derive(Default)]
pub struct McpRuntime {
    processes: Mutex<HashMap<String, McpProcess>>,
    /// Extra environment (loaded from `.env` files) forwarded to child servers.
    /// Process env always wins; this only fills gaps.
    env: OnceLock<Vec<(String, String)>>,
}

impl McpRuntime {
    /// Install the `.env`-derived environment the engine children inherit.
    pub fn configure_env(&self, env: Vec<(String, String)>) {
        let _ = self.env.set(env);
    }

    fn child_env(&self) -> Vec<(String, String)> {
        self.env.get().cloned().unwrap_or_default()
    }

    fn with_process<F, R>(&self, server: &str, binary: &str, run: F) -> Result<R, String>
    where
        F: FnOnce(&mut McpProcess) -> Result<R, String>,
    {
        let mut guard = self
            .processes
            .lock()
            .map_err(|_| "MCP state is unavailable")?;
        if !guard.contains_key(server) {
            guard.insert(server.to_string(), McpProcess::spawn(binary, &self.child_env())?);
        }
        let process = guard
            .get_mut(server)
            .ok_or("MCP process is unavailable")?;
        run(process)
    }

    /// Connect if not already connected, returning the advertised tools.
    pub fn list_tools(
        &self,
        server: &str,
        binary: &str,
    ) -> Result<(String, String, Vec<McpTool>), String> {
        self.with_process(server, binary, |process| {
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
            Ok((process.server_name.clone(), process.server_version.clone(), tools))
        })
    }

    pub fn call_tool(
        &self,
        server: &str,
        binary: &str,
        name: &str,
        arguments: Value,
    ) -> Result<McpCallResult, String> {
        self.with_process(server, binary, |process| {
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
        })
    }

    pub fn list_resources(&self, server: &str, binary: &str) -> Result<Value, String> {
        self.with_process(server, binary, |process| {
            let result = process.request("resources/list", json!({}), INIT_TIMEOUT)?;
            Ok(result.get("resources").cloned().unwrap_or_else(|| json!([])))
        })
    }

    pub fn read_resource(&self, server: &str, binary: &str, uri: &str) -> Result<Value, String> {
        self.with_process(server, binary, |process| {
            let result = process.request("resources/read", json!({ "uri": uri }), CALL_TIMEOUT)?;
            Ok(result)
        })
    }

    pub fn list_prompts(&self, server: &str, binary: &str) -> Result<Value, String> {
        self.with_process(server, binary, |process| {
            let result = process.request("prompts/list", json!({}), INIT_TIMEOUT)?;
            Ok(result.get("prompts").cloned().unwrap_or_else(|| json!([])))
        })
    }

    pub fn get_prompt(
        &self,
        server: &str,
        binary: &str,
        name: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        self.with_process(server, binary, |process| {
            process.request(
                "prompts/get",
                json!({ "name": name, "arguments": arguments }),
                CALL_TIMEOUT,
            )
        })
    }

    /// Poll a SEP-2663 task (`tasks/get`).
    pub fn get_task(&self, server: &str, binary: &str, task_id: &str) -> Result<Value, String> {
        self.with_process(server, binary, |process| {
            process.request("tasks/get", json!({ "taskId": task_id }), CALL_TIMEOUT)
        })
    }

    /// Non-blocking reset for async command handlers: if a call currently holds
    /// the connection, leave it alone rather than stalling a runtime worker.
    pub fn try_reset(&self, server: &str) {
        if let Ok(mut guard) = self.processes.try_lock() {
            guard.remove(server);
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
        let (server, _version, tools) = runtime.list_tools("fina", &binary).expect("tools/list");
        assert_eq!(server, "fina-mcp");
        assert!(tools.iter().any(|tool| tool.name == "health"));

        let result = runtime
            .call_tool("fina", &binary, "health", json!({}))
            .expect("tools/call");
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
        let again = runtime
            .call_tool("fina", &binary, "health", json!({}))
            .expect("second call");
        assert!(!again.is_error);

        // A larger, argument-less demo tool (the shape the chat calls).
        let distributions = runtime
            .call_tool("fina", &binary, "get_distributions", json!({}))
            .expect("get_distributions");
        assert!(!distributions.is_error);

        // The resource/prompt/task surfaces route through the same connection.
        // fina-mcp answers `Method not found`; the point is that the client
        // frames the request, reads the reply and returns without hanging.
        let _ = runtime.list_resources("fina", &binary);
        let _ = runtime.list_prompts("fina", &binary);
        let _ = runtime.read_resource("fina", &binary, "riga://fixtures/termsheet1");
        let _ = runtime.get_prompt("fina", &binary, "explain_pv_change", json!({}));
        let _ = runtime.get_task("fina", &binary, "task-1");
        runtime.try_reset("fina");
    }

    /// Resolve the vendored `riga-mcp` binary (submodule default relative path).
    fn riga_binary() -> Option<String> {
        if let Ok(path) = std::env::var("RIGA_MCP_BIN") {
            if std::path::Path::new(&path).is_file() {
                return Some(path);
            }
        }
        let manifest = env!("CARGO_MANIFEST_DIR");
        for profile in ["release", "debug"] {
            let candidate = std::path::Path::new(manifest)
                .join("..")
                .join("modules")
                .join("riga-flow")
                .join("target")
                .join(profile)
                .join("riga-mcp");
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
        None
    }

    #[test]
    fn lists_and_calls_riga_flow_tools_over_stdio() {
        let Some(binary) = riga_binary() else {
            // Built by `cargo build --release -p riga-mcp` in the submodule.
            eprintln!("skipping: riga-mcp binary not built");
            return;
        };
        let runtime = McpRuntime::default();
        let (server, _version, tools) = runtime.list_tools("riga", &binary).expect("tools/list");
        assert!(server.to_lowercase().contains("riga"), "unexpected server name {server}");
        assert!(
            tools.iter().any(|tool| tool.name == "price_put"),
            "expected the riga-flow tool catalogue, got {} tools",
            tools.len()
        );
        // price_put is fixture-only, so it needs no arguments.
        let result = runtime
            .call_tool("riga", &binary, "price_put", json!({}))
            .expect("price_put");
        assert!(!result.is_error);
        let pv = result
            .structured_content
            .as_ref()
            .and_then(|value| value.pointer("/result/pv"))
            .and_then(Value::as_f64);
        assert!(pv.is_some_and(|value| value > 0.0), "price_put returned no pv");
    }
}
