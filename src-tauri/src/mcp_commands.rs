//! MCP server commands: the vendored `riga-mcp` and `tac-engine` servers the
//! visual atlas calls.
//!
//! The child processes are owned here (never by the webview). One `McpRuntime`
//! holds a named connection per server; the engine binaries resolve from the
//! submodule default relative path, and `.env` files are forwarded to them.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::mcp::McpRuntime;
use crate::nip_bridge::NipBridgeInfo;
use crate::nip_http::NipServiceState;

/// Managed state for the MCP registry.
#[derive(Default)]
pub struct McpState {
    pub runtime: Arc<McpRuntime>,
}

// ---------------------------------------------------------------------------
// riga-mcp + tac-engine (§3.4 / §3.10)
// ---------------------------------------------------------------------------

/// Ordered candidate paths for an engine binary, excluding the env override.
///
/// The shared `modules/target` directory is canonical; old submodule-local
/// paths remain as compatibility fallbacks for existing checkouts.
pub fn engine_binary_candidates(
    workspace: &std::path::Path,
    submodule_dir: &str,
    exe_name: &str,
) -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::new();
    for profile in ["release", "debug"] {
        candidates.push(
            workspace
                .join("modules")
                .join("target")
                .join(profile)
                .join(exe_name),
        );
    }
    for profile in ["release", "debug"] {
        candidates.push(
            workspace
                .join("modules")
                .join(submodule_dir)
                .join("target")
                .join(profile)
                .join(exe_name),
        );
    }
    for profile in ["release", "debug"] {
        candidates.push(workspace.join("target").join(profile).join(exe_name));
    }
    candidates
}

fn resolve_engine_binary(
    app: Option<&AppHandle>,
    env_var: &str,
    submodule_dir: &str,
    bin_name: &str,
) -> Result<String, String> {
    if let Ok(explicit) = std::env::var(env_var) {
        if std::path::Path::new(&explicit).is_file() {
            return Ok(explicit);
        }
    }
    let exe_name = if cfg!(windows) {
        format!("{bin_name}.exe")
    } else {
        bin_name.to_string()
    };
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace = manifest.join("..");
    for candidate in engine_binary_candidates(&workspace, submodule_dir, &exe_name) {
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    if let Some(app) = app {
        if let Ok(resources) = app.path().resource_dir() {
            for candidate in [
                resources.join(&exe_name),
                resources.join("binaries").join(&exe_name),
            ] {
                if candidate.is_file() {
                    return Ok(candidate.to_string_lossy().into_owned());
                }
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sidecar = dir.join(&exe_name);
            if sidecar.is_file() {
                return Ok(sidecar.to_string_lossy().into_owned());
            }
        }
    }
    Err(format!(
        "{bin_name} binary not found. Run `npm run runtime:prepare` or set {env_var}."
    ))
}

#[tauri::command]
pub fn get_riga_mcp_path(app: AppHandle) -> Result<String, String> {
    resolve_engine_binary(Some(&app), "RIGA_MCP_BIN", "riga-flow", "riga-mcp")
}

#[tauri::command]
pub fn get_tac_engine_path(app: AppHandle) -> Result<String, String> {
    resolve_engine_binary(Some(&app), "TAC_ENGINE_BIN", "tac-engine", "tac-engine")
}

/// Resolve the checked-in tac-qlib book launcher. The launcher performs the
/// module-local `uv sync --locked` and starts the Python MCP service; it is a
/// named service path, not renderer-selectable executable configuration.
#[tauri::command]
pub fn get_tac_qlib_book_path(app: AppHandle) -> Result<String, String> {
    if let Ok(explicit) = std::env::var("TAC_QLIB_BOOK_BIN") {
        if std::path::Path::new(&explicit).is_file() {
            return Ok(explicit);
        }
    }
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace = manifest.join("..");
    let mut candidates = vec![workspace.join("scripts").join("tac-qlib-book-mcp")];
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("tac-qlib-book-mcp"));
    }
    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    Err("tac-qlib book launcher not found. Run from a fina-builder checkout with scripts/tac-qlib-book-mcp and uv installed, or set TAC_QLIB_BOOK_BIN.".into())
}

/// Resolve the checked-in tac-qlib R&D launcher.
#[tauri::command]
pub fn get_tac_qlib_rd_path(app: AppHandle) -> Result<String, String> {
    if let Ok(explicit) = std::env::var("TAC_QLIB_RD_BIN") {
        if std::path::Path::new(&explicit).is_file() {
            return Ok(explicit);
        }
    }
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace = manifest.join("..");
    let mut candidates = vec![workspace.join("scripts").join("tac-qlib-rd-mcp")];
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("tac-qlib-rd-mcp"));
    }
    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    Err("tac-qlib R&D launcher not found. Run from a fina-builder checkout with scripts/tac-qlib-rd-mcp and uv installed, or set TAC_QLIB_RD_BIN.".into())
}

#[tauri::command]
pub fn get_nip_engine_path(app: AppHandle) -> Result<String, String> {
    resolve_engine_binary(Some(&app), "NIP_ENGINE_BIN", "..", "nip-engine")
}

/// Resolve fina-scraper for the NIP-owned acquisition initialization/worker
/// boundary. This is not exposed as a product-facing renderer command.
pub fn resolve_fina_scraper_binary(app: &AppHandle) -> Result<String, String> {
    resolve_engine_binary(
        Some(app),
        "FINA_SCRAPER_BIN",
        "fina-scraper",
        "fina-scraper",
    )
}

/// NIP-owned app-data paths plus the loopback bridge credentials. These entries
/// are attached to the `nip` server only; RIGA and TAC children never receive
/// the token.
pub fn nip_engine_env(app: &AppHandle, bridge: &NipBridgeInfo) -> Vec<(String, String)> {
    let lake_dir = resolve_nip_lake_dir(app).unwrap_or_else(|_| {
        app.path()
            .app_data_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
            .join("NIPLake")
    });
    nip_engine_env_values(&lake_dir, bridge)
}

pub fn nip_engine_env_values(
    lake_dir: &std::path::Path,
    bridge: &NipBridgeInfo,
) -> Vec<(String, String)> {
    let data_dir = lake_dir.join("_nip");
    vec![
        (
            "NIP_DATA_DIR".to_string(),
            data_dir.to_string_lossy().into_owned(),
        ),
        (
            "NIP_LAKE_DIR".to_string(),
            lake_dir.to_string_lossy().into_owned(),
        ),
        ("NIP_RIGA_BRIDGE_URL".to_string(), bridge.url.clone()),
        ("NIP_RIGA_BRIDGE_TOKEN".to_string(), bridge.token.clone()),
    ]
}

/// Parse a `.env` file: `KEY=VALUE` lines, `#` comments, optional quotes and an
/// optional `export ` prefix. Blank/malformed lines are skipped.
pub fn parse_dotenv(contents: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for raw in contents.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            continue;
        }
        let mut value = value.trim().to_string();
        let quoted = value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"'))
                || (value.starts_with('\'') && value.ends_with('\'')));
        if quoted {
            value = value[1..value.len() - 1].to_string();
        }
        out.push((key.to_string(), value));
    }
    out
}

fn process_env_overrides_dotenv(
    key: &str,
    process_value: Option<&str>,
    profile_lake_default: Option<&str>,
) -> bool {
    process_value.is_some_and(|value| {
        !((key == "TAC_LAKE_DIR" || key == "NIP_LAKE_DIR") && profile_lake_default == Some(value))
    })
}

fn normalized_workspace_path(workspace: &std::path::Path, path: &str) -> std::path::PathBuf {
    let path = std::path::Path::new(path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        workspace.join(path)
    }
}

fn default_nip_lake_dir(
    workspace: &std::path::Path,
    app_data: Option<&std::path::Path>,
    profile: Option<&str>,
) -> Option<std::path::PathBuf> {
    match profile {
        Some("packaged") => app_data.map(|path| path.join("NIPLake")),
        Some("ci") => Some(workspace.join(".fina/ci-data/nip/lake")),
        _ if cfg!(debug_assertions) => Some(workspace.join(".fina/data/nip/lake")),
        _ => app_data.map(|path| path.join("NIPLake")),
    }
}

/// Resolve the same narrative root used by the child NIP engine. Explicit
/// process values win; profile defaults may be replaced by ordered dotenv.
pub fn resolve_nip_lake_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace = manifest.join("..");
    let profile = std::env::var("FINA_PROFILE").ok();
    let app_data = app.path().app_data_dir().ok();
    let profile_default = std::env::var("FINA_PROFILE_NIP_LAKE_DIR")
        .ok()
        .filter(|value| !value.is_empty());
    let current = std::env::var("NIP_LAKE_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty() && !value.starts_with("${"));
    if let Some(value) = current
        .as_ref()
        .filter(|value| profile_default.as_deref() != Some(value.as_str()))
    {
        return Ok(normalized_workspace_path(&workspace, value));
    }
    let dotenv = engine_env(app);
    if let Some((_, value)) = dotenv.iter().find(|(key, _)| key == "NIP_LAKE_DIR") {
        return Ok(normalized_workspace_path(&workspace, value));
    }
    if let Some(value) = current {
        return Ok(normalized_workspace_path(&workspace, &value));
    }
    default_nip_lake_dir(&workspace, app_data.as_deref(), profile.as_deref())
        .ok_or_else(|| "Could not resolve NIP_LAKE_DIR or the Tauri app-data directory".to_owned())
}

fn engine_env_candidates(
    workspace: &std::path::Path,
    working_dir: &std::path::Path,
    app_data: Option<&std::path::Path>,
) -> Vec<std::path::PathBuf> {
    let mut candidates = vec![working_dir.join(".env")];
    if let Some(data) = app_data {
        let path = data.join(".env");
        if !candidates.contains(&path) {
            candidates.push(path);
        }
    }
    let workspace_env = workspace.join(".env");
    if !candidates.contains(&workspace_env) {
        candidates.push(workspace_env);
    }
    candidates.push(workspace.join("modules").join("tac-engine").join(".env"));
    candidates.push(workspace.join("modules").join("riga-flow").join(".env"));
    candidates
}

/// Extra environment the engine children inherit, loaded from `.env` files so
/// the user can drop one next to the app or in the repo root rather than only
/// exporting shell variables. Search order (first wins, then explicit process
/// env overrides): working-directory `.env`, app-data `.env`, workspace `.env`,
/// `modules/tac-engine/.env`, `modules/riga-flow/.env`.
pub fn engine_env(app: &AppHandle) -> Vec<(String, String)> {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace = manifest.join("..");
    let working_dir = std::env::current_dir().unwrap_or_else(|_| workspace.clone());
    let app_data = app.path().app_data_dir().ok();
    let candidates = engine_env_candidates(&workspace, &working_dir, app_data.as_deref());

    let mut collected: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let profile_tac_default = std::env::var("FINA_PROFILE_TAC_LAKE_DIR")
        .ok()
        .filter(|value| !value.is_empty());
    let profile_nip_default = std::env::var("FINA_PROFILE_NIP_LAKE_DIR")
        .ok()
        .filter(|value| !value.is_empty());
    for path in candidates {
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        for (key, value) in parse_dotenv(&contents) {
            if key == "NIP_DATA_DIR" {
                continue;
            }
            let process_value = std::env::var(&key).ok();
            let profile_default = if key == "TAC_LAKE_DIR" {
                profile_tac_default.as_deref()
            } else if key == "NIP_LAKE_DIR" {
                profile_nip_default.as_deref()
            } else {
                None
            };
            if process_env_overrides_dotenv(&key, process_value.as_deref(), profile_default) {
                continue;
            }
            if !seen.insert(key.clone()) {
                continue;
            }
            collected.push((key, value));
        }
    }
    // Match `dev:http`: a clean desktop checkout may not have a `.env` yet,
    // but TAC and the qlib R&D service still require an explicit lake root.
    // Keep credentials/configuration host-owned while making the disposable
    // workspace lake deterministic for local development.
    if std::env::var_os("TAC_LAKE_DIR").is_none()
        && !collected.iter().any(|(key, _)| key == "TAC_LAKE_DIR")
    {
        collected.push((
            "TAC_LAKE_DIR".to_string(),
            workspace.join(".lake").to_string_lossy().into_owned(),
        ));
    }
    let process_nip_default = std::env::var("NIP_LAKE_DIR").ok().map_or(true, |value| {
        profile_nip_default.as_deref() == Some(value.as_str()) || value.trim().is_empty()
    });
    if process_nip_default && !collected.iter().any(|(key, _)| key == "NIP_LAKE_DIR") {
        let profile = std::env::var("FINA_PROFILE").ok();
        if let Some(default) =
            default_nip_lake_dir(&workspace, app_data.as_deref(), profile.as_deref())
        {
            collected.push((
                "NIP_LAKE_DIR".to_string(),
                default.to_string_lossy().into_owned(),
            ));
        }
    }
    collected
}

#[tauri::command]
pub async fn riga_mcp_list_tools(
    app: AppHandle,
    state: State<'_, McpState>,
) -> Result<Value, String> {
    let binary = get_riga_mcp_path(app)?;
    let mcp = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (server, version, tools) = mcp.list_tools("riga", &binary)?;
        Ok::<Value, String>(json!({ "server": server, "version": version, "tools": tools }))
    })
    .await
    .map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub async fn riga_mcp_call_tool(
    app: AppHandle,
    state: State<'_, McpState>,
    name: String,
    arguments: Option<Value>,
) -> Result<crate::mcp::McpCallResult, String> {
    let binary = get_riga_mcp_path(app)?;
    let mcp = state.runtime.clone();
    let arguments = arguments.unwrap_or_else(|| json!({}));
    tauri::async_runtime::spawn_blocking(move || mcp.call_tool("riga", &binary, &name, arguments))
        .await
        .map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub async fn riga_mcp_list_resources(
    app: AppHandle,
    state: State<'_, McpState>,
) -> Result<Value, String> {
    let binary = get_riga_mcp_path(app)?;
    let mcp = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || mcp.list_resources("riga", &binary))
        .await
        .map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub async fn riga_mcp_read_resource(
    app: AppHandle,
    state: State<'_, McpState>,
    uri: String,
) -> Result<Value, String> {
    let binary = get_riga_mcp_path(app)?;
    let mcp = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || mcp.read_resource("riga", &binary, &uri))
        .await
        .map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub async fn riga_mcp_list_prompts(
    app: AppHandle,
    state: State<'_, McpState>,
) -> Result<Value, String> {
    let binary = get_riga_mcp_path(app)?;
    let mcp = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || mcp.list_prompts("riga", &binary))
        .await
        .map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub async fn riga_mcp_get_prompt(
    app: AppHandle,
    state: State<'_, McpState>,
    name: String,
    arguments: Option<Value>,
) -> Result<Value, String> {
    let binary = get_riga_mcp_path(app)?;
    let mcp = state.runtime.clone();
    let arguments = arguments.unwrap_or_else(|| json!({}));
    tauri::async_runtime::spawn_blocking(move || mcp.get_prompt("riga", &binary, &name, arguments))
        .await
        .map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub async fn riga_mcp_get_task(
    app: AppHandle,
    state: State<'_, McpState>,
    task_id: String,
) -> Result<Value, String> {
    let binary = get_riga_mcp_path(app)?;
    let mcp = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || mcp.get_task("riga", &binary, &task_id))
        .await
        .map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub fn riga_mcp_reset(state: State<'_, McpState>) -> Result<(), String> {
    state.runtime.try_reset("riga");
    Ok(())
}

#[tauri::command]
pub async fn tac_mcp_list_tools(
    app: AppHandle,
    state: State<'_, McpState>,
) -> Result<Value, String> {
    let binary = get_tac_engine_path(app)?;
    let mcp = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (server, version, tools) = mcp.list_tools("tac", &binary)?;
        Ok::<Value, String>(json!({ "server": server, "version": version, "tools": tools }))
    })
    .await
    .map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub async fn tac_mcp_call_tool(
    app: AppHandle,
    state: State<'_, McpState>,
    name: String,
    arguments: Option<Value>,
) -> Result<crate::mcp::McpCallResult, String> {
    let binary = get_tac_engine_path(app)?;
    let mcp = state.runtime.clone();
    let arguments = arguments.unwrap_or_else(|| json!({}));
    validate_tac_tool_call(&name, &arguments)?;
    tauri::async_runtime::spawn_blocking(move || mcp.call_tool("tac", &binary, &name, arguments))
        .await
        .map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub fn tac_mcp_reset(state: State<'_, McpState>) -> Result<(), String> {
    state.runtime.try_reset("tac");
    Ok(())
}

#[tauri::command]
pub async fn book_mcp_list_tools(
    app: AppHandle,
    state: State<'_, McpState>,
) -> Result<Value, String> {
    let binary = get_tac_qlib_book_path(app)?;
    let mcp = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (server, version, tools) = mcp.list_tools("book", &binary)?;
        Ok::<Value, String>(json!({ "server": server, "version": version, "tools": tools }))
    })
    .await
    .map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub async fn book_mcp_call_tool(
    app: AppHandle,
    state: State<'_, McpState>,
    name: String,
    arguments: Option<Value>,
) -> Result<crate::mcp::McpCallResult, String> {
    let binary = get_tac_qlib_book_path(app)?;
    let mcp = state.runtime.clone();
    let arguments = arguments.unwrap_or_else(|| json!({}));
    tauri::async_runtime::spawn_blocking(move || mcp.call_tool("book", &binary, &name, arguments))
        .await
        .map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub fn book_mcp_reset(state: State<'_, McpState>) -> Result<(), String> {
    state.runtime.try_reset("book");
    Ok(())
}

#[tauri::command]
pub async fn rd_mcp_list_tools(
    app: AppHandle,
    state: State<'_, McpState>,
) -> Result<Value, String> {
    let binary = get_tac_qlib_rd_path(app)?;
    let mcp = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (server, version, tools) = mcp.list_tools("rd", &binary)?;
        Ok::<Value, String>(json!({ "server": server, "version": version, "tools": tools }))
    })
    .await
    .map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub async fn rd_mcp_call_tool(
    app: AppHandle,
    state: State<'_, McpState>,
    name: String,
    arguments: Option<Value>,
) -> Result<crate::mcp::McpCallResult, String> {
    let binary = get_tac_qlib_rd_path(app)?;
    let mcp = state.runtime.clone();
    let arguments = arguments.unwrap_or_else(|| json!({}));
    validate_rd_tool_call(&name, &arguments)?;
    tauri::async_runtime::spawn_blocking(move || mcp.call_tool("rd", &binary, &name, arguments))
        .await
        .map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub fn rd_mcp_reset(state: State<'_, McpState>) -> Result<(), String> {
    state.runtime.try_reset("rd");
    Ok(())
}

pub fn validate_rd_tool_call(name: &str, arguments: &Value) -> Result<(), String> {
    let allowed: &[&str] = match name {
        "rd_status" => &["market"],
        "rd_dataset" => &[
            "market",
            "universe",
            "start_time",
            "end_time",
            "fit_start_time",
            "fit_end_time",
            "freq",
            "features",
            "label",
            "train_start",
            "train_end",
            "valid_start",
            "valid_end",
            "test_start",
            "test_end",
        ],
        "rd_exp_list" => &[],
        "rd_exp_get_experiment" => &["experiment_id"],
        "rd_exp_get_run" | "rd_exp_input" | "rd_exp_result" | "rd_exp_model" | "rd_exp_blotter"
        | "rd_exp_lineage" => &["run_id", "experiment_id"],
        "rd_exp_dataset" => &[
            "run_id",
            "experiment_id",
            "group",
            "instrument",
            "page",
            "page_size",
            "sort",
            "representation",
        ],
        "rd_trace_start" => &["rational", "details", "experiment_name", "evolved_from"],
        "rd_trace_get" => &["experiment_id"],
        "rd_trace_list" => &["limit"],
        "rd_validate_workflow" => &["config_yaml"],
        "rd_run_workflow" => &["config_yaml", "experiment_name"],
        "rd_train" => &[
            "wait",
            "market",
            "universe",
            "train_start",
            "train_end",
            "valid_start",
            "valid_end",
            "test_start",
            "test_end",
            "freq",
            "features",
            "label",
            "learning_rate",
            "num_leaves",
            "num_boost_round",
            "early_stopping_rounds",
            "colsample_bytree",
            "subsample",
            "subsample_freq",
            "reg_alpha",
            "reg_lambda",
            "seed",
            "experiment_name",
            "record_analysis",
            "benchmark",
            "topk",
            "n_drop",
            "account",
            "risk_degree",
            "open_cost",
            "close_cost",
            "min_cost",
            "risk_limits",
        ],
        _ => return Err(format!("R&D tool is not allowed: {name}")),
    };
    let object = arguments
        .as_object()
        .ok_or_else(|| "R&D arguments must be an object".to_string())?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("R&D argument is not allowed: {key}"));
    }
    if name == "rd_exp_dataset" {
        let run_id = object
            .get("run_id")
            .and_then(Value::as_str)
            .ok_or_else(|| "R&D run_id must be a string".to_string())?;
        if run_id.is_empty()
            || run_id.len() > 128
            || !run_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err("R&D run_id is invalid".into());
        }
        let group = object
            .get("group")
            .and_then(Value::as_str)
            .ok_or_else(|| "R&D dataset group must be a string".to_string())?;
        if !matches!(group, "train" | "valid" | "test" | "backtest") {
            return Err("R&D dataset group is invalid".into());
        }
        let instrument = object
            .get("instrument")
            .and_then(Value::as_str)
            .ok_or_else(|| "R&D dataset instrument must be a string".to_string())?;
        if instrument.is_empty()
            || instrument.len() > 16
            || !instrument
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        {
            return Err("R&D dataset instrument is invalid".into());
        }
        let page = object
            .get("page")
            .and_then(Value::as_u64)
            .ok_or_else(|| "R&D dataset page must be an integer".to_string())?;
        let page_size = object
            .get("page_size")
            .and_then(Value::as_u64)
            .ok_or_else(|| "R&D dataset page_size must be an integer".to_string())?;
        if !(1..=100000).contains(&page) || !(1..=200).contains(&page_size) {
            return Err("R&D dataset pagination is invalid".into());
        }
        let sort = object
            .get("sort")
            .and_then(Value::as_str)
            .ok_or_else(|| "R&D dataset sort must be a string".to_string())?;
        if !matches!(sort, "asc" | "desc") {
            return Err("R&D dataset sort is invalid".into());
        }
        if let Some(representation) = object.get("representation") {
            let representation = representation
                .as_str()
                .ok_or_else(|| "R&D dataset representation must be a string".to_string())?;
            if !matches!(representation, "raw" | "inference") {
                return Err("R&D dataset representation is invalid".into());
            }
        }
    }
    if name == "rd_validate_workflow" || name == "rd_run_workflow" {
        let yaml = object
            .get("config_yaml")
            .and_then(Value::as_str)
            .ok_or_else(|| "R&D config_yaml must be a string".to_string())?;
        if yaml.trim().is_empty() || yaml.len() > 128 * 1024 {
            return Err("R&D config_yaml must be non-empty and no larger than 128 KiB".into());
        }
        if name == "rd_run_workflow" {
            let experiment_name = object
                .get("experiment_name")
                .and_then(Value::as_str)
                .ok_or_else(|| "R&D experiment_name must be a string".to_string())?;
            if experiment_name.trim().is_empty() || experiment_name.len() > 64 {
                return Err("R&D experiment_name must be 1-64 characters".into());
            }
        }
    }
    Ok(())
}

fn validate_tac_tool_call(name: &str, arguments: &Value) -> Result<(), String> {
    let allowed: &[&str] = match name {
        "place_order" => &[
            "symbol",
            "side",
            "type",
            "time_in_force",
            "qty",
            "notional",
            "limit_price",
            "stop_price",
            "trail_price",
            "trail_percent",
            "extended_hours",
            "client_order_id",
            "order_class",
            "position_intent",
        ],
        "cancel_order" | "get_order" => &["order_id"],
        _ => return Ok(()),
    };
    let object = arguments
        .as_object()
        .ok_or_else(|| "TAC arguments must be an object".to_string())?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("TAC argument is not allowed: {key}"));
    }
    if name == "cancel_order" || name == "get_order" {
        let id = object
            .get("order_id")
            .and_then(Value::as_str)
            .ok_or_else(|| "TAC order_id is required".to_string())?;
        if id.is_empty()
            || id.len() > 128
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err("TAC order_id is invalid".into());
        }
        return Ok(());
    }
    let symbol = object
        .get("symbol")
        .and_then(Value::as_str)
        .ok_or_else(|| "TAC symbol is required".to_string())?;
    if symbol.is_empty()
        || symbol.len() > 16
        || !symbol
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err("TAC symbol is invalid".into());
    }
    if !matches!(
        object.get("side").and_then(Value::as_str),
        Some("buy") | Some("sell")
    ) {
        return Err("TAC side must be buy or sell".into());
    }
    if !matches!(
        object.get("type").and_then(Value::as_str),
        Some("market") | Some("limit") | Some("stop") | Some("stop_limit") | Some("trailing_stop")
    ) {
        return Err("TAC order type is invalid".into());
    }
    if !matches!(
        object.get("time_in_force").and_then(Value::as_str),
        Some("day") | Some("gtc") | Some("opg") | Some("cls") | Some("ioc") | Some("fok")
    ) {
        return Err("TAC time_in_force is invalid".into());
    }
    if object.get("qty").is_some() == object.get("notional").is_some() {
        return Err("TAC order requires exactly one of qty or notional".into());
    }
    for key in [
        "qty",
        "notional",
        "limit_price",
        "stop_price",
        "trail_price",
        "trail_percent",
    ] {
        if let Some(value) = object.get(key) {
            let text = value
                .as_str()
                .ok_or_else(|| format!("TAC {key} must be a decimal string"))?;
            if text.is_empty()
                || text.len() > 32
                || !text.chars().all(|c| c.is_ascii_digit() || c == '.')
                || text.matches('.').count() > 1
                || text.parse::<f64>().unwrap_or(0.0) <= 0.0
            {
                return Err(format!("TAC {key} must be a positive decimal string"));
            }
        }
    }
    Ok(())
}

pub fn validate_riskcube_tool_call(name: &str, arguments: &Value) -> Result<(), String> {
    let allowed: &[&str] = match name {
        "riskcube_capabilities" | "risk_cube_partitions" => &[],
        "olap_query" => &[
            "scope",
            "dimensions",
            "measures",
            "aggregation",
            "filters",
            "limit",
        ],
        _ => return Err(format!("RiskCube tool is not allowed: {name}")),
    };
    let object = arguments
        .as_object()
        .ok_or_else(|| "RiskCube arguments must be an object".to_string())?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("RiskCube argument is not allowed: {key}"));
    }
    Ok(())
}

/// RiskCube has no checked-in engine submodule until a canonical OLAP/pricer
/// implementation is selected. Desktop mode therefore accepts only an
/// explicit host-side binary override and must report setup as unavailable
/// rather than suggesting a nonexistent `modules/riskcube` checkout.
pub fn resolve_riskcube_binary() -> Result<String, String> {
    match std::env::var("RISK_CUBE_MCP_BIN") {
        Ok(path) if std::path::Path::new(&path).is_file() => Ok(path),
        Ok(path) => Err(format!(
            "RiskCube OLAP sidecar is unavailable: RISK_CUBE_MCP_BIN does not point to a file ({path}). Configure an approved canonical sidecar on the host."
        )),
        Err(_) => Err(
            "RiskCube OLAP sidecar is unavailable: no approved canonical sidecar is configured. Set RISK_CUBE_MCP_BIN on the host; no RiskCube engine is bundled.".into()
        ),
    }
}

#[tauri::command]
pub async fn riskcube_mcp_call_tool(
    _app: AppHandle,
    state: State<'_, McpState>,
    name: String,
    arguments: Option<Value>,
) -> Result<crate::mcp::McpCallResult, String> {
    let arguments = arguments.unwrap_or_else(|| json!({}));
    validate_riskcube_tool_call(&name, &arguments)?;
    let binary = resolve_riskcube_binary()?;
    let mcp = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || {
        mcp.call_tool("riskcube", &binary, &name, arguments)
    })
    .await
    .map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub fn riskcube_mcp_reset(state: State<'_, McpState>) -> Result<(), String> {
    state.runtime.try_reset("riskcube");
    Ok(())
}

#[tauri::command]
pub async fn nip_mcp_list_tools(state: State<'_, NipServiceState>) -> Result<Value, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let listing = state.list_tools()?;
        Ok::<Value, String>(json!({
            "server": listing.server,
            "version": listing.version,
            "tools": listing.tools,
        }))
    })
    .await
    .map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub async fn nip_mcp_call_tool(
    state: State<'_, NipServiceState>,
    name: String,
    arguments: Option<Value>,
) -> Result<crate::mcp::McpCallResult, String> {
    let state = state.inner().clone();
    let arguments = arguments.unwrap_or_else(|| json!({}));
    tauri::async_runtime::spawn_blocking(move || state.call_tool(&name, arguments))
        .await
        .map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub fn nip_mcp_reset(state: State<'_, NipServiceState>) -> Result<(), String> {
    state.reset();
    Ok(())
}

/// Loopback base URL of the running NIP service. The webview uses it to play
/// cached audio/video from `/media/<job_id>/<name>` without exposing filesystem
/// paths to the renderer.
#[tauri::command]
pub fn nip_service_url(state: State<'_, NipServiceState>) -> Result<String, String> {
    state
        .url()
        .ok_or_else(|| "NIP service is not running".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nip_environment_is_scoped_to_nip_paths_and_bridge_credentials() {
        let bridge = NipBridgeInfo {
            url: "http://127.0.0.1:49152".into(),
            token: "fixture-bridge-token".into(),
        };
        let env = nip_engine_env_values(std::path::Path::new("/tmp/nip-lake"), &bridge);
        assert_eq!(
            env,
            vec![
                ("NIP_DATA_DIR".into(), "/tmp/nip-lake/_nip".into()),
                ("NIP_LAKE_DIR".into(), "/tmp/nip-lake".into()),
                ("NIP_RIGA_BRIDGE_URL".into(), bridge.url.clone()),
                ("NIP_RIGA_BRIDGE_TOKEN".into(), bridge.token.clone()),
            ]
        );
        assert!(!env.iter().any(|(key, _)| key.contains("TAC_")));
    }

    #[test]
    fn dotenv_parser_handles_quotes_comments_and_exports() {
        let parsed = parse_dotenv(
            "# comment\nAPCA_API_KEY_ID=PK123\nTAC_LAKE_DIR=\"/data/lake\"\nexport FRED_API_KEY='abc'\n\nBAD LINE\n=novalue\n",
        );
        assert_eq!(
            parsed,
            vec![
                ("APCA_API_KEY_ID".to_string(), "PK123".to_string()),
                ("TAC_LAKE_DIR".to_string(), "/data/lake".to_string()),
                ("FRED_API_KEY".to_string(), "abc".to_string()),
            ]
        );
    }

    #[test]
    fn dotenv_can_replace_only_the_launcher_profile_lake_default() {
        assert!(!process_env_overrides_dotenv(
            "TAC_LAKE_DIR",
            Some("/workspace/.fina/data/lake"),
            Some("/workspace/.fina/data/lake"),
        ));
        assert!(!process_env_overrides_dotenv(
            "NIP_LAKE_DIR",
            Some("/workspace/.fina/data/nip/lake"),
            Some("/workspace/.fina/data/nip/lake"),
        ));
        assert!(process_env_overrides_dotenv(
            "TAC_LAKE_DIR",
            Some("/Users/user/lake"),
            Some("/workspace/.fina/data/lake"),
        ));
        assert!(process_env_overrides_dotenv(
            "TAC_LAKE_START_DATE",
            Some("2026-05-26"),
            Some("/workspace/.fina/data/lake"),
        ));
    }

    #[test]
    fn engine_dotenv_search_includes_working_directory_before_checkout_defaults() {
        let paths = engine_env_candidates(
            std::path::Path::new("/workspace"),
            std::path::Path::new("/working"),
            Some(std::path::Path::new("/app-data")),
        );
        assert_eq!(paths[0], std::path::Path::new("/working/.env"));
        assert_eq!(paths[1], std::path::Path::new("/app-data/.env"));
        assert_eq!(paths[2], std::path::Path::new("/workspace/.env"));
        assert_eq!(
            paths[3],
            std::path::Path::new("/workspace/modules/tac-engine/.env")
        );

        let same_dir = engine_env_candidates(
            std::path::Path::new("/workspace"),
            std::path::Path::new("/workspace"),
            None,
        );
        assert_eq!(
            same_dir
                .iter()
                .filter(|path| path.as_path() == std::path::Path::new("/workspace/.env"))
                .count(),
            1
        );
    }

    #[test]
    fn engine_binary_search_prefers_the_shared_target_path() {
        let workspace = std::path::Path::new("/ws");
        let candidates = engine_binary_candidates(workspace, "riga-flow", "riga-mcp");
        assert_eq!(
            candidates[0],
            std::path::Path::new("/ws/modules/target/release/riga-mcp")
        );
        assert_eq!(
            candidates[1],
            std::path::Path::new("/ws/modules/target/debug/riga-mcp")
        );
        assert_eq!(
            candidates[candidates.len() - 1],
            std::path::Path::new("/ws/target/debug/riga-mcp")
        );
    }

    #[test]
    fn resolve_engine_binary_reports_the_missing_binary_and_env_var() {
        let err = resolve_engine_binary(
            None,
            "RIGA_MCP_BIN_TEST_UNSET_VAR",
            "definitely-not-a-submodule",
            "no-such-binary",
        )
        .unwrap_err();
        assert!(
            err.contains("RIGA_MCP_BIN_TEST_UNSET_VAR"),
            "unhelpful: {err}"
        );
        assert!(err.contains("no-such-binary"), "unhelpful: {err}");
    }

    #[test]
    fn resolve_engine_binary_honours_the_env_override() {
        let dir = std::env::temp_dir().join("fina-builder-mcp-path-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("riga-mcp");
        std::fs::write(&file, b"").unwrap();
        std::env::set_var("RIGA_MCP_BIN_TEST_OVERRIDE", &file);
        let resolved =
            resolve_engine_binary(None, "RIGA_MCP_BIN_TEST_OVERRIDE", "riga-flow", "riga-mcp")
                .unwrap();
        assert_eq!(resolved, file.to_string_lossy());
        std::env::remove_var("RIGA_MCP_BIN_TEST_OVERRIDE");
    }

    #[test]
    fn rd_tool_validation_rejects_renderer_paths_and_mutations() {
        assert!(validate_rd_tool_call(
            "rd_exp_result",
            &json!({"run_id": "r1", "experiment_id": "e1"})
        )
        .is_ok());
        assert!(
            validate_rd_tool_call("rd_exp_result", &json!({"uri": "file:///tmp/mlruns"})).is_err()
        );
        assert!(validate_rd_tool_call("rd_exp_result", &json!({"path": "/tmp/mlruns"})).is_err());
        assert!(
            validate_rd_tool_call("rd_exp_result", &json!({"tracking_store": "/tmp/mlruns"}))
                .is_err()
        );
        let dataset_args = json!({
            "run_id": "r1", "group": "train", "instrument": "AAPL",
            "page": 1, "page_size": 50, "sort": "asc", "representation": "raw"
        });
        assert!(validate_rd_tool_call("rd_exp_dataset", &dataset_args).is_ok());
        let invalid_dataset_args = json!({
            "run_id": "r1", "group": "train", "instrument": "AAPL",
            "page": 1, "page_size": 50, "sort": "asc", "representation": "learn"
        });
        assert!(validate_rd_tool_call("rd_exp_dataset", &invalid_dataset_args).is_err());
        assert!(validate_rd_tool_call("delete_experiment", &json!({})).is_err());
    }

    #[test]
    fn rd_workflow_yaml_calls_are_bounded_and_pathless() {
        let yaml = "experiment_name: alpha\ntask: {}";
        assert!(
            validate_rd_tool_call("rd_validate_workflow", &json!({"config_yaml": yaml})).is_ok()
        );
        assert!(validate_rd_tool_call(
            "rd_run_workflow",
            &json!({"config_yaml": yaml, "experiment_name": "alpha"})
        )
        .is_ok());
        assert!(validate_rd_tool_call(
            "rd_run_workflow",
            &json!({"config_yaml": yaml, "experiment_name": "alpha", "config_path": "/tmp/x"})
        )
        .is_err());
        assert!(validate_rd_tool_call(
            "rd_validate_workflow",
            &json!({"config_yaml": "x".repeat(128 * 1024 + 1)})
        )
        .is_err());
    }

    #[test]
    fn riskcube_tool_validation_rejects_sql_paths_and_unknown_tools() {
        assert!(validate_riskcube_tool_call(
            "olap_query",
            &json!({
                "scope": {"partition_id": "p1"}, "dimensions": ["underlying"],
                "measures": ["pv_amount"], "aggregation": "sum", "filters": [], "limit": 10
            })
        )
        .is_ok());
        assert!(validate_riskcube_tool_call(
            "olap_query",
            &json!({"sql": "select * from riskcube_cells"})
        )
        .is_err());
        assert!(
            validate_riskcube_tool_call("olap_query", &json!({"uri": "file:///tmp/cube"})).is_err()
        );
        assert!(validate_riskcube_tool_call("riskcube_write", &json!({})).is_err());
    }

    #[test]
    fn riskcube_binary_resolution_reports_explicit_unavailable_setup() {
        let previous = std::env::var_os("RISK_CUBE_MCP_BIN");
        std::env::remove_var("RISK_CUBE_MCP_BIN");
        let error = resolve_riskcube_binary().unwrap_err();
        assert!(error.contains("no approved canonical sidecar is configured"));
        assert!(!error.contains("modules/riskcube/Cargo.toml"));
        match previous {
            Some(value) => std::env::set_var("RISK_CUBE_MCP_BIN", value),
            None => std::env::remove_var("RISK_CUBE_MCP_BIN"),
        }
    }
}
