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
    collections::HashSet,
    net::{Ipv4Addr, Ipv6Addr},
    path::{Component, Path, PathBuf},
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
const LOCAL_MODEL_RESPONSE_LIMIT: u64 = 4 * 1024 * 1024;
const LOCAL_MODEL_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SavedLocalModelSettings {
    base_url: String,
    model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelSettingsResponse {
    base_url: Option<String>,
    model: Option<String>,
    saved: bool,
    env_override: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelCheckResponse {
    ready: bool,
    model: String,
    available_model_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelSaveResponse {
    restart_required: bool,
    env_override: bool,
}

fn validate_local_model_settings(base_url: &str, model: &str) -> Result<(), String> {
    let parsed = url::Url::parse(base_url).map_err(|_| {
        "Base URL must be a valid HTTP(S) URL using a literal loopback IP address".to_owned()
    })?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Base URL must be HTTP(S), without credentials, query, or fragment".to_owned());
    }
    let host_is_loopback = match parsed.host() {
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address == Ipv6Addr::LOCALHOST,
        _ => false,
    };
    // URL parsers accept shorthand and encoded host spellings. Require the host
    // as written to be a conventional IP literal, not a DNS-like alias.
    let raw_authority = base_url
        .split_once("://")
        .map(|(_, rest)| rest.split(['/', '?', '#']).next().unwrap_or_default())
        .unwrap_or_default();
    let raw_host_is_loopback = if let Some(bracketed) = raw_authority.strip_prefix('[') {
        bracketed
            .split_once(']')
            .and_then(|(host, _)| host.parse::<Ipv6Addr>().ok())
            .map(|address| address == Ipv6Addr::LOCALHOST)
            .unwrap_or(false)
    } else {
        raw_authority
            .split_once(':')
            .map(|(host, _)| host)
            .unwrap_or(raw_authority)
            .parse::<Ipv4Addr>()
            .map(|address| address.is_loopback())
            .unwrap_or(false)
    };
    if raw_authority.contains('@') || !host_is_loopback || !raw_host_is_loopback {
        return Err("Base URL host must be a literal loopback IP (127.0.0.0/8 or ::1)".to_owned());
    }
    if model.trim().is_empty() || model.chars().count() > 256 || model.chars().any(char::is_control)
    {
        return Err(
            "Model ID must be non-empty, at most 256 characters, and contain no control characters"
                .to_owned(),
        );
    }
    Ok(())
}

fn local_model_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    crate::mcp_commands::resolve_nip_lake_dir(app)
        .map(|lake| lake.join("_nip").join("local-model.json"))
}

fn read_saved_local_model_settings(path: &Path) -> Result<Option<SavedLocalModelSettings>, String> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Could not read saved local model settings".to_owned()),
    };
    let settings: SavedLocalModelSettings = serde_json::from_str(&contents)
        .map_err(|_| "Saved local model settings are invalid".to_owned())?;
    validate_local_model_settings(&settings.base_url, &settings.model)?;
    Ok(Some(settings))
}

fn save_local_model_settings(path: &Path, base_url: &str, model: &str) -> Result<(), String> {
    validate_local_model_settings(base_url, model)?;
    let settings = SavedLocalModelSettings {
        base_url: base_url.to_owned(),
        model: model.to_owned(),
    };
    let contents = serde_json::to_vec(&settings)
        .map_err(|_| "Could not serialize local model settings".to_owned())?;
    let parent = path
        .parent()
        .ok_or_else(|| "Could not determine settings directory".to_owned())?;
    std::fs::create_dir_all(parent)
        .map_err(|_| "Could not create local model settings directory".to_owned())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, contents)
        .map_err(|_| "Could not save local model settings".to_owned())?;
    std::fs::rename(&temporary, path).map_err(|_| "Could not save local model settings".to_owned())
}

fn local_model_env_keys() -> [&'static str; 3] {
    [
        "NIP_CLAIM_PROVIDER",
        "NIP_LOCAL_LLM_URL",
        "NIP_LOCAL_LLM_MODEL",
    ]
}

fn explicit_local_model_env(app: &AppHandle) -> HashSet<&'static str> {
    let dotenv = crate::mcp_commands::engine_env(app);
    local_model_env_keys()
        .into_iter()
        .filter(|key| std::env::var_os(key).is_some() || dotenv.iter().any(|(name, _)| name == key))
        .collect()
}

fn check_local_model(base_url: &str, model: &str) -> Result<usize, String> {
    validate_local_model_settings(base_url, model)?;
    let endpoint = format!("{}/models", base_url.trim_end_matches('/'));
    let config = ureq::Agent::config_builder()
        .proxy(None)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(LOCAL_MODEL_TIMEOUT))
        .build();
    let agent: ureq::Agent = config.into();
    let mut response = agent
        .get(&endpoint)
        .call()
        .map_err(|_| "Could not reach the local model endpoint".to_owned())?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(format!(
            "Local model endpoint returned HTTP {status}; expected 200"
        ));
    }
    let bytes = response
        .body_mut()
        .with_config()
        // Read one sentinel byte so an exactly-at-limit response is accepted;
        // ureq's limiter otherwise errors when the reader reaches the limit.
        .limit(LOCAL_MODEL_RESPONSE_LIMIT + 1)
        .read_to_vec()
        .map_err(|_| {
            "Local model endpoint returned an unreadable or oversized response".to_owned()
        })?;
    if bytes.len() as u64 > LOCAL_MODEL_RESPONSE_LIMIT {
        return Err("Local model endpoint response exceeded the 4 MiB limit".to_owned());
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Local model endpoint returned invalid model-list JSON".to_owned())?;
    let models = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "Local model endpoint response did not contain a model list".to_owned())?;
    if !models
        .iter()
        .any(|entry| entry.get("id").and_then(Value::as_str) == Some(model))
    {
        return Err("The requested model ID is not listed by the local endpoint".to_owned());
    }
    Ok(models.len())
}

#[tauri::command(rename_all = "camelCase")]
pub fn nip_get_local_model_settings(app: AppHandle) -> Result<LocalModelSettingsResponse, String> {
    let saved = read_saved_local_model_settings(&local_model_settings_path(&app)?)?;
    Ok(LocalModelSettingsResponse {
        base_url: saved.as_ref().map(|settings| settings.base_url.clone()),
        model: saved.as_ref().map(|settings| settings.model.clone()),
        saved: saved.is_some(),
        env_override: !explicit_local_model_env(&app).is_empty(),
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn nip_check_local_model(
    base_url: String,
    model: String,
) -> Result<LocalModelCheckResponse, String> {
    let available_model_count = check_local_model(&base_url, &model)?;
    Ok(LocalModelCheckResponse {
        ready: true,
        model,
        available_model_count,
    })
}

#[tauri::command(rename_all = "camelCase")]
pub fn nip_save_local_model_settings(
    app: AppHandle,
    base_url: String,
    model: String,
) -> Result<LocalModelSaveResponse, String> {
    save_local_model_settings(&local_model_settings_path(&app)?, &base_url, &model)?;
    Ok(LocalModelSaveResponse {
        restart_required: true,
        env_override: !explicit_local_model_env(&app).is_empty(),
    })
}

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

/// The data directory owned by the single NIP engine for this host run.
fn nip_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::mcp_commands::resolve_nip_lake_dir(app).map(|lake| lake.join("_nip"))
}

/// Resolve a managed media file for the webview's asset protocol.
///
/// Only files beneath `<NIP_DATA_DIR>/media` are returned. Absolute paths,
/// parent traversal and symlinks that escape the media root are rejected; the
/// command never exposes the rest of the filesystem.
#[tauri::command]
pub fn nip_media_file(app: AppHandle, relative_path: String) -> Result<String, String> {
    let root = nip_data_dir(&app)?.join("media");
    let root = root
        .canonicalize()
        .map_err(|_| "NIP media directory is not available".to_owned())?;
    let trimmed = relative_path.trim();
    if trimmed.is_empty() {
        return Err("A media relative path is required".to_owned());
    }
    let relative = Path::new(trimmed);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err("Media path must stay inside the managed media directory".to_owned());
    }
    let canonical = root
        .join(relative)
        .canonicalize()
        .map_err(|_| "Media file was not found".to_owned())?;
    if !canonical.starts_with(&root) {
        return Err("Media path escaped the managed media directory".to_owned());
    }
    if !canonical.is_file() {
        return Err("Media path is not a file".to_owned());
    }
    Ok(canonical.to_string_lossy().into_owned())
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

    let lake_dir = crate::mcp_commands::resolve_nip_lake_dir(app)?;
    // Share the scraper's lock and safety checks. This occurs before NIP logs,
    // pidfiles, media directories, or the engine process are created.
    let storage_init = fina_scraper::storage::initialize(&lake_dir, None)
        .map_err(|error| format!("could not initialize NIP_LAKE_DIR: {error}"))?;
    let data_dir = lake_dir.join("_nip");
    eprintln!(
        "NIP storage: NIP_LAKE_DIR={} NIP_DATA_DIR={} (legacy app-data storage location is unused)",
        lake_dir.display(),
        data_dir.display()
    );
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
            lake_dir.to_string_lossy().into_owned(),
        ),
    ];
    let scraper_owned_feeds: Vec<String> = storage_init
        .site_inventory
        .iter()
        .filter(|site| site.enabled && site.kind == "podcast")
        .filter_map(|site| site.feed_url.clone())
        .collect();
    env.push((
        "NIP_SCRAPER_OWNED_PODCAST_FEEDS".to_string(),
        serde_json::to_string(&scraper_owned_feeds)
            .map_err(|error| format!("could not serialize scraper feed ownership: {error}"))?,
    ));
    if let Some(bridge) = bridge {
        env.push(("NIP_RIGA_BRIDGE_URL".to_string(), bridge.url.clone()));
        env.push(("NIP_RIGA_BRIDGE_TOKEN".to_string(), bridge.token.clone()));
    }
    let dotenv_env = crate::mcp_commands::engine_env(app);
    let explicit_local_keys: HashSet<&str> = local_model_env_keys()
        .into_iter()
        .filter(|key| {
            std::env::var_os(key).is_some() || dotenv_env.iter().any(|(name, _)| name == key)
        })
        .collect();
    // The optional local ASR boundary is configured by the user, not hard-coded.
    // Read the host environment first, then the same `.env` files the engine
    // children inherit.
    let comfyui_url = std::env::var("NIP_COMFYUI_URL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            dotenv_env
                .iter()
                .find(|(key, _)| key == "NIP_COMFYUI_URL")
                .map(|(_, value)| value.clone())
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
        // These NIP-owned settings contain only a provider selection, loopback
        // URL, and model ID. Direct-local mode has no API-key field.
        "NIP_CLAIM_PROVIDER",
        "NIP_LOCAL_LLM_URL",
        "NIP_LOCAL_LLM_MODEL",
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
    for (key, value) in &dotenv_env {
        let wanted = tooling_keys.contains(&key.as_str());
        if wanted && !env.iter().any(|(existing, _)| existing == key) {
            env.push((key.clone(), value.clone()));
        }
    }
    let saved_path = data_dir.join("local-model.json");
    match read_saved_local_model_settings(&saved_path) {
        Ok(Some(settings)) => {
            if !explicit_local_keys.contains("NIP_CLAIM_PROVIDER") {
                env.push(("NIP_CLAIM_PROVIDER".to_owned(), "direct_local".to_owned()));
            }
            if !explicit_local_keys.contains("NIP_LOCAL_LLM_URL") {
                env.push(("NIP_LOCAL_LLM_URL".to_owned(), settings.base_url));
            }
            if !explicit_local_keys.contains("NIP_LOCAL_LLM_MODEL") {
                env.push(("NIP_LOCAL_LLM_MODEL".to_owned(), settings.model));
            }
        }
        Ok(None) => {}
        Err(error) => eprintln!("NIP: ignoring saved local model settings: {error}"),
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

    #[test]
    fn validates_literal_loopback_urls_and_model_ids() {
        for base_url in [
            "http://127.0.0.1:1234/v1",
            "https://127.255.4.9",
            "http://[::1]:8080",
        ] {
            assert!(validate_local_model_settings(base_url, "model-id").is_ok());
        }
        for base_url in [
            "ftp://127.0.0.1",
            "http://localhost:1234",
            "http://192.168.1.4",
            "http://127.1",
            "http://user:password@127.0.0.1",
            "http://127.0.0.1/path?key=value",
            "http://127.0.0.1/path#fragment",
            "http://127.0.0.1:bad",
        ] {
            assert!(
                validate_local_model_settings(base_url, "model-id").is_err(),
                "accepted invalid URL: {base_url}"
            );
        }
        for model in ["", " \t", &"x".repeat(257), "bad\nmodel"] {
            assert!(validate_local_model_settings("http://127.0.0.1", model).is_err());
        }
        assert!(validate_local_model_settings("http://127.0.0.1", &"x".repeat(256)).is_ok());
    }

    #[test]
    fn saved_settings_round_trip_only_url_and_model() {
        let directory = std::env::temp_dir().join(format!("nip-settings-{}", uuid::Uuid::new_v4()));
        let path = directory
            .join("NIPLake")
            .join("_nip")
            .join("local-model.json");
        save_local_model_settings(&path, "http://127.0.0.1:11434/v1", "model:latest").unwrap();
        let serialized = std::fs::read_to_string(&path).unwrap();
        let json: Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(json.as_object().unwrap().len(), 2);
        assert_eq!(json["baseUrl"], "http://127.0.0.1:11434/v1");
        assert_eq!(json["model"], "model:latest");
        assert_eq!(
            read_saved_local_model_settings(&path).unwrap(),
            Some(SavedLocalModelSettings {
                base_url: "http://127.0.0.1:11434/v1".to_owned(),
                model: "model:latest".to_owned(),
            })
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn readiness_checks_exact_model_from_loopback_models_endpoint() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            loop {
                let count = stream.read(&mut chunk).unwrap();
                request.extend_from_slice(&chunk[..count]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let body = r#"{"data":[{"id":"wanted"},{"id":"other"}]}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            String::from_utf8(request).unwrap()
        });

        let count = check_local_model(&format!("http://{address}/v1/"), "wanted").unwrap();
        let request = server.join().unwrap();
        assert_eq!(count, 2);
        assert!(request.starts_with("GET /v1/models HTTP/1.1\r\n"));
        assert!(!request.to_ascii_lowercase().contains("authorization:"));
    }

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
        let root = std::env::temp_dir().join(format!("nip-http-test-{}", uuid::Uuid::new_v4()));
        let lake_dir = root.join("lake");
        let data_dir = lake_dir.join("_nip");
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut child = Command::new(binary)
            .arg("--transport")
            .arg("http")
            .arg("--bind")
            .arg(format!("127.0.0.1:{port}"))
            .env("NIP_DATA_DIR", &data_dir)
            .env("NIP_LAKE_DIR", &lake_dir)
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
                Some(18)
            );
            Ok(())
        });
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&root);
        result.unwrap();
    }
}
