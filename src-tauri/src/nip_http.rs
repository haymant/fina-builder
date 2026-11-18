//! One NIP service, shared by the Narrative workspace and the RIGA chat.
//!
//! NIP owns a DuckDB file with a single writer. Spawning a separate stdio
//! `nip-engine` per UI surface made the RIGA chat and the Narrative tab fight
//! over that lock (and left NIP absent from RIGA's tool registry entirely).
//! Instead the host starts one Streamable HTTP MCP server and both clients use
//! it:
//!
//! - RIGA connects through its native HTTP MCP transport.
//! - The Narrative UI goes through the Tauri commands in `mcp_commands`, which
//!   use the small blocking MCP client below. The webview never talks to the
//!   loopback port directly (and the server stays CORS-closed).

use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::{
    mcp::{McpCallResult, McpTool},
    nip_bridge::NipBridgeInfo,
};

const PROTOCOL_VERSION: &str = "2025-11-25";
const CALL_TIMEOUT: Duration = Duration::from_secs(1_800);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NipToolListing {
    pub server: String,
    pub version: String,
    pub tools: Vec<McpTool>,
}

struct HttpSession {
    session_id: Option<String>,
    initialized: bool,
    next_id: i64,
}

/// Minimal MCP Streamable HTTP client. NIP is configured with
/// `with_json_response(true)`, so terminal responses are JSON; the SSE branch is
/// kept for protocol compatibility.
struct NipHttpClient {
    agent: ureq::Agent,
    endpoint: String,
    session: Mutex<HttpSession>,
}

impl NipHttpClient {
    fn new(endpoint: String) -> Self {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .timeout_global(Some(CALL_TIMEOUT))
            .build();
        Self {
            agent: config.into(),
            endpoint,
            session: Mutex::new(HttpSession {
                session_id: None,
                initialized: false,
                next_id: 1,
            }),
        }
    }

    fn post(
        &self,
        message: &Value,
        session_id: Option<&str>,
    ) -> Result<(u16, Option<String>, String), String> {
        let mut request = self
            .agent
            .post(&self.endpoint)
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", PROTOCOL_VERSION);
        if let Some(session_id) = session_id {
            request = request.header("Mcp-Session-Id", session_id);
        }
        let mut response = request
            .send_json(message)
            .map_err(|error| format!("NIP HTTP request failed: {error}"))?;
        let status = response.status().as_u16();
        let session_id = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = response
            .body_mut()
            .read_to_string()
            .map_err(|error| format!("NIP HTTP response could not be read: {error}"))?;
        Ok((status, session_id, body))
    }

    fn ensure_session(&self, session: &mut HttpSession) -> Result<(), String> {
        if session.initialized {
            return Ok(());
        }
        let message = json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "fina-builder-desktop", "version": env!("CARGO_PKG_VERSION") }
            }
        });
        let (status, session_id, body) = self.post(&message, None)?;
        if status >= 400 {
            return Err(format!(
                "NIP MCP initialize failed ({status}): {}",
                body.trim()
            ));
        }
        let value = parse_rpc_body(&body)?;
        if let Some(error) = value.get("error") {
            return Err(format!("NIP MCP initialize error: {error}"));
        }
        session.session_id = session_id;
        session.initialized = true;
        let initialized = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        let (status, _, body) = self.post(&initialized, session.session_id.as_deref())?;
        if status >= 400 {
            return Err(format!(
                "NIP MCP initialized notification failed ({status}): {}",
                body.trim()
            ));
        }
        Ok(())
    }

    fn request(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        let mut session = self
            .session
            .lock()
            .map_err(|_| "NIP HTTP session lock failed".to_owned())?;
        self.ensure_session(&mut session)?;
        let id = session.next_id;
        session.next_id += 1;
        let mut message = json!({"jsonrpc": "2.0", "id": id, "method": method});
        if let Some(params) = params {
            message["params"] = params;
        }
        let session_id = session.session_id.clone();
        let (status, _, body) = self.post(&message, session_id.as_deref())?;
        if status == 404 {
            // The server may have expired a stateful session. Re-initialize once.
            session.session_id = None;
            session.initialized = false;
            self.ensure_session(&mut session)?;
            let session_id = session.session_id.clone();
            let (status, _, body) = self.post(&message, session_id.as_deref())?;
            return rpc_result(status, &body);
        }
        rpc_result(status, &body)
    }

    fn list_tools(&self) -> Result<NipToolListing, String> {
        let result = self.request("tools/list", None)?;
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
                                .unwrap_or_else(|| json!({"type": "object"})),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let server = result
            .pointer("/serverInfo/name")
            .and_then(Value::as_str)
            .unwrap_or("nip-engine")
            .to_string();
        let version = result
            .pointer("/serverInfo/version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        Ok(NipToolListing {
            server,
            version,
            tools,
        })
    }

    fn call_tool(&self, name: &str, arguments: Value) -> Result<McpCallResult, String> {
        let result = self.request(
            "tools/call",
            Some(json!({"name": name, "arguments": arguments})),
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

    fn reset_session(&self) {
        if let Ok(mut session) = self.session.lock() {
            session.session_id = None;
            session.initialized = false;
        }
    }
}

fn parse_rpc_body(body: &str) -> Result<Value, String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Ok(Value::Null);
    }
    if trimmed.starts_with('{') {
        return serde_json::from_str(trimmed)
            .map_err(|error| format!("NIP MCP returned invalid JSON: {error}"));
    }
    // SSE compatibility: take the first complete `data:` JSON object.
    for line in trimmed.lines() {
        if let Some(data) = line.strip_prefix("data:") {
            if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                return Ok(value);
            }
        }
    }
    Err(format!(
        "NIP MCP returned an unsupported response: {}",
        trimmed.chars().take(160).collect::<String>()
    ))
}

fn rpc_result(status: u16, body: &str) -> Result<Value, String> {
    if status >= 400 {
        return Err(format!(
            "NIP MCP request failed ({status}): {}",
            body.trim()
        ));
    }
    let value = parse_rpc_body(body)?;
    if let Some(error) = value.get("error") {
        return Err(format!("NIP MCP error: {error}"));
    }
    Ok(value.get("result").cloned().unwrap_or(Value::Null))
}

/// The one process that owns the NIP DuckDB file for this app run.
pub struct NipService {
    client: NipHttpClient,
    child: Child,
    url: String,
    pidfile: PathBuf,
}

impl NipService {
    pub fn url(&self) -> &str {
        &self.url
    }
}

impl Drop for NipService {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Remove the record before the next run can mistake this pid for a
        // stale engine, and after the kill so it cannot race a fresh spawn.
        let _ = std::fs::remove_file(&self.pidfile);
    }
}

fn pidfile_for(data_dir: &Path) -> PathBuf {
    data_dir.join("nip-engine.pid")
}

#[cfg(unix)]
fn process_is_engine(pid: i32) -> bool {
    let output = match Command::new("ps")
        .arg("-p")
        .arg(pid.to_string())
        .arg("-o")
        .arg("command=")
        .output()
    {
        Ok(output) => output,
        Err(_) => return false,
    };
    output.status.success() && String::from_utf8_lossy(&output.stdout).contains("nip-engine")
}

/// DuckDB accepts a single writer. Killing the host (a dev restart or a crash)
/// leaves the child alive on macOS, where a child does not die with its parent:
/// it keeps the database lock and every new engine then fails at startup with
/// "NIP storage could not be initialized". Reap the engine recorded by the
/// previous run before spawning a replacement.
#[cfg(unix)]
fn reap_stale_engine(pidfile: &Path) {
    let pid = std::fs::read_to_string(pidfile)
        .ok()
        .and_then(|text| text.trim().parse::<i32>().ok())
        .filter(|pid| *pid > 0);
    let Some(pid) = pid else {
        let _ = std::fs::remove_file(pidfile);
        return;
    };
    // Signal only a live process whose command line still names the engine: a
    // recycled pid must never be killed.
    let alive = || unsafe { libc::kill(pid, 0) } == 0;
    if alive() && process_is_engine(pid) {
        unsafe { libc::kill(pid, libc::SIGTERM) };
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while alive() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        if alive() {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
    let _ = std::fs::remove_file(pidfile);
}

#[cfg(not(unix))]
fn reap_stale_engine(pidfile: &Path) {
    // Windows releases the database lock with the process, so there is nothing
    // to reap; leave the record alone rather than guess at a pid.
    let _ = pidfile;
}

/// Tauri-managed handle. Registration can fail without preventing the app from
/// starting; the Narrative tab then reports the real startup error.
#[derive(Clone, Default)]
pub struct NipServiceState {
    inner: Arc<Mutex<Option<NipService>>>,
    error: Arc<Mutex<Option<String>>>,
}

impl NipServiceState {
    pub fn set(&self, service: NipService) {
        if let Ok(mut slot) = self.inner.lock() {
            *slot = Some(service);
        }
        if let Ok(mut error) = self.error.lock() {
            *error = None;
        }
    }

    pub fn set_error(&self, message: String) {
        if let Ok(mut error) = self.error.lock() {
            *error = Some(message);
        }
    }

    pub fn service(&self) -> Result<(), String> {
        if let Ok(slot) = self.inner.lock() {
            if slot.is_some() {
                return Ok(());
            }
        }
        let message = self
            .error
            .lock()
            .ok()
            .and_then(|error| error.clone())
            .unwrap_or_else(|| "NIP service is not running".to_owned());
        Err(message)
    }

    pub fn url(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|service| service.url().to_owned()))
    }

    pub fn list_tools(&self) -> Result<NipToolListing, String> {
        self.service()?;
        self.inner
            .lock()
            .map_err(|_| "NIP service lock failed".to_owned())?
            .as_ref()
            .ok_or_else(|| "NIP service is not running".to_owned())?
            .client
            .list_tools()
    }

    pub fn call_tool(&self, name: &str, arguments: Value) -> Result<McpCallResult, String> {
        self.service()?;
        self.inner
            .lock()
            .map_err(|_| "NIP service lock failed".to_owned())?
            .as_ref()
            .ok_or_else(|| "NIP service is not running".to_owned())?
            .client
            .call_tool(name, arguments)
    }

    pub fn reset(&self) {
        if let Ok(slot) = self.inner.lock() {
            if let Some(service) = slot.as_ref() {
                service.client.reset_session();
            }
        }
    }

    /// Kill the child during an orderly host shutdown. Idempotent.
    pub fn stop(&self) {
        if let Ok(mut slot) = self.inner.lock() {
            slot.take();
        }
    }
}

/// Start the single NIP Streamable HTTP MCP server for this app run.
pub fn start(app: &AppHandle, bridge: Option<&NipBridgeInfo>) -> Result<NipService, String> {
    let binary = crate::mcp_commands::get_nip_engine_path(app.clone())?;
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("could not reserve a NIP HTTP port: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("could not read the NIP HTTP port: {error}"))?
        .port();
    drop(listener);

    let data_dir = app
        .path()
        .app_data_dir()
        .map(|dir| dir.join("NIP"))
        .unwrap_or_else(|_| std::path::PathBuf::from(".nip-data"));
    let pidfile = pidfile_for(&data_dir);
    // A previous run that was killed rather than shut down still owns the
    // DuckDB lock; starting a second engine would only fail.
    reap_stale_engine(&pidfile);
    let mut env = vec![
        (
            "NIP_DATA_DIR".to_string(),
            data_dir.to_string_lossy().into_owned(),
        ),
        (
            "NIP_LAKE_DIR".to_string(),
            data_dir.join("lake").to_string_lossy().into_owned(),
        ),
    ];
    if let Some(bridge) = bridge {
        env.push(("NIP_RIGA_BRIDGE_URL".to_string(), bridge.url.clone()));
        env.push(("NIP_RIGA_BRIDGE_TOKEN".to_string(), bridge.token.clone()));
    }
    // The optional local ASR boundary is configured by the user, not hard-coded.
    // Read the host environment first, then the same `.env` files the engine
    // children inherit.
    let comfyui_url = std::env::var("NIP_COMFYUI_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            crate::mcp_commands::engine_env(app)
                .into_iter()
                .find(|(key, _)| key == "NIP_COMFYUI_URL")
                .map(|(_, value)| value)
                .filter(|value| !value.trim().is_empty())
        });
    if let Some(url) = comfyui_url {
        env.push(("NIP_COMFYUI_URL".to_string(), url));
    }
    // The external `comfy` pack is configured by the user as well. Forward only
    // NIP-owned tooling keys, never unrelated secrets from .env.
    let tooling_keys = [
        "NIP_COMFY_DIR",
        "NIP_COMFY_REPO",
        "NIP_COMFY_RENDER",
        "NIP_ASR_CHUNK_SECONDS",
        "NIP_ASR_CHUNK_TIMEOUT_SECONDS",
        "NIP_PYTHON_BIN",
        "NIP_FFMPEG_BIN",
        "NIP_FFPROBE_BIN",
    ];
    for key in tooling_keys {
        if env.iter().any(|(existing, _)| existing == key) {
            continue;
        }
        if let Ok(value) = std::env::var(key) {
            if !value.trim().is_empty() {
                env.push((key.to_string(), value));
            }
        }
    }
    for (key, value) in crate::mcp_commands::engine_env(app) {
        let wanted = tooling_keys.contains(&key.as_str());
        if wanted && !env.iter().any(|(existing, _)| existing == &key) {
            env.push((key, value));
        }
    }
    let logs_dir = data_dir.join("logs");
    let engine_log = logs_dir.join("nip-engine.log");
    let log_handle = std::fs::create_dir_all(&logs_dir).ok().and_then(|_| {
        // Keep the diagnostic file bounded; it is rotated only at startup.
        if std::fs::metadata(&engine_log)
            .map(|metadata| metadata.len() > 2 * 1024 * 1024)
            .unwrap_or(false)
        {
            let _ = std::fs::remove_file(&engine_log);
        }
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&engine_log)
            .ok()
    });

    let bind = format!("127.0.0.1:{port}");
    let mut command = Command::new(&binary);
    command
        .arg("--transport")
        .arg("http")
        .arg("--bind")
        .arg(&bind)
        .envs(env.iter().map(|(key, value)| (key.clone(), value.clone())))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(match log_handle {
            // Every failed ASR step stays reviewable instead of disappearing.
            Some(handle) => Stdio::from(handle),
            None => Stdio::null(),
        });
    // A dev restart (or a crash) must not leave an orphaned nip-engine holding
    // the single-writer DuckDB lock. On Linux the child dies with the host.
    #[cfg(target_os = "linux")]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("could not start nip-engine ({binary}): {error}"))?;

    if let Err(error) = wait_until_ready(&mut child, port) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    let url = format!("http://{bind}");
    // Record the pid only once the engine is ready: a failed start must not
    // leave a pidfile that a later run would try to reap.
    let _ = std::fs::write(&pidfile, child.id().to_string());
    Ok(NipService {
        client: NipHttpClient::new(format!("{url}/mcp")),
        child,
        url,
        pidfile,
    })
}

fn wait_until_ready(child: &mut Child, port: u16) -> Result<(), String> {
    let config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(2)))
        .build();
    let agent: ureq::Agent = config.into();
    let health = format!("http://127.0.0.1:{port}/health");
    let deadline = std::time::Instant::now() + STARTUP_TIMEOUT;
    while std::time::Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("could not inspect the NIP process: {error}"))?
        {
            return Err(format!("nip-engine exited during startup ({status})"));
        }
        if let Ok(mut response) = agent.get(&health).call() {
            if let Ok(body) = response.body_mut().read_to_string() {
                let ready = serde_json::from_str::<Value>(&body).ok().and_then(|value| {
                    value
                        .get("readiness")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                });
                if ready.as_deref() == Some("ready") {
                    return Ok(());
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "timed out after {}s waiting for the NIP HTTP service on {port}",
        STARTUP_TIMEOUT.as_secs()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine_binary() -> Option<std::path::PathBuf> {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        ["target/release/nip-engine", "target/debug/nip-engine"]
            .iter()
            .map(|relative| root.join(relative))
            .find(|candidate| candidate.is_file())
    }

    #[test]
    fn a_stale_pidfile_never_kills_an_unrelated_process() {
        let dir = std::env::temp_dir().join(format!("nip-reap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pidfile = pidfile_for(&dir);
        let mut unrelated = Command::new("sleep").arg("30").spawn().unwrap();
        std::fs::write(&pidfile, unrelated.id().to_string()).unwrap();

        reap_stale_engine(&pidfile);

        assert!(!pidfile.exists(), "the stale record is cleared");
        assert!(
            unrelated.try_wait().unwrap().is_none(),
            "a pid that no longer names nip-engine must survive"
        );
        let _ = unrelated.kill();
        let _ = unrelated.wait();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn lists_and_calls_nip_tools_over_streamable_http() {
        let Some(binary) = engine_binary() else {
            eprintln!("skipping: nip-engine binary is not built");
            return;
        };
        let data_dir = std::env::temp_dir().join(format!("nip-http-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&data_dir).unwrap();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut child = Command::new(binary)
            .arg("--transport")
            .arg("http")
            .arg("--bind")
            .arg(format!("127.0.0.1:{port}"))
            .env("NIP_DATA_DIR", &data_dir)
            .env("NIP_LAKE_DIR", data_dir.join("lake"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let result = wait_until_ready(&mut child, port).and_then(|()| {
            let client = NipHttpClient::new(format!("http://127.0.0.1:{port}/mcp"));
            let listing = client.list_tools()?;
            assert!(
                listing
                    .tools
                    .iter()
                    .any(|tool| tool.name == "create_source"),
                "nip-engine must advertise create_source: {:?}",
                listing
                    .tools
                    .iter()
                    .map(|tool| &tool.name)
                    .collect::<Vec<_>>()
            );
            let health = client.call_tool("health", json!({}))?;
            assert!(!health.is_error);
            assert_eq!(
                health
                    .structured_content
                    .as_ref()
                    .and_then(|value| value.get("schema_version"))
                    .and_then(Value::as_u64),
                Some(10)
            );
            Ok(())
        });
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&data_dir);
        result.unwrap();
    }
}
