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
/// The **default relative path** (`modules/<dir>/target/{release,debug}`) comes
/// first so a submodule build resolves with no per-developer configuration.
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
        "{bin_name} binary not found. Build it (cargo build --release --manifest-path modules/{submodule_dir}/Cargo.toml) or set {env_var}."
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
        if std::path::Path::new(&explicit).is_file() { return Ok(explicit); }
    }
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace = manifest.join("..");
    let mut candidates = vec![workspace.join("scripts").join("tac-qlib-rd-mcp")];
    if let Ok(dir) = app.path().resource_dir() { candidates.push(dir.join("tac-qlib-rd-mcp")); }
    for candidate in candidates {
        if candidate.is_file() { return Ok(candidate.to_string_lossy().into_owned()); }
    }
    Err("tac-qlib R&D launcher not found. Run from a fina-builder checkout with scripts/tac-qlib-rd-mcp and uv installed, or set TAC_QLIB_RD_BIN.".into())
}

#[tauri::command]
pub fn get_nip_engine_path(app: AppHandle) -> Result<String, String> {
    resolve_engine_binary(Some(&app), "NIP_ENGINE_BIN", "..", "nip-engine")
}

/// NIP-owned app-data paths plus the loopback bridge credentials. These entries
/// are attached to the `nip` server only; RIGA and TAC children never receive
/// the token.
pub fn nip_engine_env(app: &AppHandle, bridge: &NipBridgeInfo) -> Vec<(String, String)> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|dir| dir.join("NIP"))
        .unwrap_or_else(|_| std::path::PathBuf::from(".nip-data"));
    nip_engine_env_values(&data_dir, bridge)
}

pub fn nip_engine_env_values(
    data_dir: &std::path::Path,
    bridge: &NipBridgeInfo,
) -> Vec<(String, String)> {
    vec![
        (
            "NIP_DATA_DIR".to_string(),
            data_dir.to_string_lossy().into_owned(),
        ),
        (
            "NIP_LAKE_DIR".to_string(),
            data_dir.join("lake").to_string_lossy().into_owned(),
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

/// Extra environment the engine children inherit, loaded from `.env` files so
/// the user can drop one next to the app or in the repo root rather than only
/// exporting shell variables. Search order (first wins, then the process env
/// always overrides): app-data `.env`, workspace `.env`,
/// `modules/tac-engine/.env`, `modules/riga-flow/.env`.
pub fn engine_env(app: &AppHandle) -> Vec<(String, String)> {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace = manifest.join("..");
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(data) = app.path().app_data_dir() {
        candidates.push(data.join(".env"));
    }
    candidates.push(workspace.join(".env"));
    candidates.push(workspace.join("modules").join("tac-engine").join(".env"));
    candidates.push(workspace.join("modules").join("riga-flow").join(".env"));

    let mut collected: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for path in candidates {
        let Ok(contents) = std::fs::read_to_string(&path) else {
            continue;
        };
        for (key, value) in parse_dotenv(&contents) {
            if std::env::var_os(&key).is_some() {
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
pub async fn rd_mcp_list_tools(app: AppHandle, state: State<'_, McpState>) -> Result<Value, String> {
    let binary = get_tac_qlib_rd_path(app)?;
    let mcp = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || { let (server, version, tools) = mcp.list_tools("rd", &binary)?; Ok::<Value, String>(json!({ "server": server, "version": version, "tools": tools })) }).await.map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub async fn rd_mcp_call_tool(app: AppHandle, state: State<'_, McpState>, name: String, arguments: Option<Value>) -> Result<crate::mcp::McpCallResult, String> {
    let binary = get_tac_qlib_rd_path(app)?;
    let mcp = state.runtime.clone();
    let arguments = arguments.unwrap_or_else(|| json!({}));
    validate_rd_tool_call(&name, &arguments)?;
    tauri::async_runtime::spawn_blocking(move || mcp.call_tool("rd", &binary, &name, arguments)).await.map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub fn rd_mcp_reset(state: State<'_, McpState>) -> Result<(), String> { state.runtime.try_reset("rd"); Ok(()) }

pub fn validate_rd_tool_call(name: &str, arguments: &Value) -> Result<(), String> {
    let allowed: &[&str] = match name {
        "rd_exp_list" => &[],
        "rd_exp_get_experiment" => &["experiment_id"],
        "rd_exp_get_run" | "rd_exp_input" | "rd_exp_result" | "rd_exp_model" | "rd_exp_lineage" => &["run_id", "experiment_id"],
        _ => return Err(format!("R&D tool is not allowed: {name}")),
    };
    let object = arguments.as_object().ok_or_else(|| "R&D arguments must be an object".to_string())?;
    if let Some(key) = object.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("R&D argument is not allowed: {key}"));
    }
    Ok(())
}

pub fn validate_riskcube_tool_call(name: &str, arguments: &Value) -> Result<(), String> {
    let allowed: &[&str] = match name {
        "riskcube_capabilities" | "risk_cube_partitions" => &[],
        "olap_query" => &["scope", "dimensions", "measures", "aggregation", "filters", "limit"],
        _ => return Err(format!("RiskCube tool is not allowed: {name}")),
    };
    let object = arguments.as_object().ok_or_else(|| "RiskCube arguments must be an object".to_string())?;
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
pub async fn riskcube_mcp_call_tool(_app: AppHandle, state: State<'_, McpState>, name: String, arguments: Option<Value>) -> Result<crate::mcp::McpCallResult, String> {
    let arguments = arguments.unwrap_or_else(|| json!({}));
    validate_riskcube_tool_call(&name, &arguments)?;
    let binary = resolve_riskcube_binary()?;
    let mcp = state.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || mcp.call_tool("riskcube", &binary, &name, arguments)).await.map_err(|e| format!("MCP worker failed: {e}"))?
}

#[tauri::command]
pub fn riskcube_mcp_reset(state: State<'_, McpState>) -> Result<(), String> { state.runtime.try_reset("riskcube"); Ok(()) }

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
        let env = nip_engine_env_values(std::path::Path::new("/tmp/nip-data"), &bridge);
        assert_eq!(
            env,
            vec![
                ("NIP_DATA_DIR".into(), "/tmp/nip-data".into()),
                ("NIP_LAKE_DIR".into(), "/tmp/nip-data/lake".into()),
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
    fn engine_binary_search_prefers_the_submodule_default_relative_path() {
        let workspace = std::path::Path::new("/ws");
        let candidates = engine_binary_candidates(workspace, "riga-flow", "riga-mcp");
        assert_eq!(
            candidates[0],
            std::path::Path::new("/ws/modules/riga-flow/target/release/riga-mcp")
        );
        assert_eq!(
            candidates[1],
            std::path::Path::new("/ws/modules/riga-flow/target/debug/riga-mcp")
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
        assert!(validate_rd_tool_call("rd_exp_result", &json!({"run_id": "r1", "experiment_id": "e1"})).is_ok());
        assert!(validate_rd_tool_call("rd_exp_result", &json!({"uri": "file:///tmp/mlruns"})).is_err());
        assert!(validate_rd_tool_call("rd_exp_result", &json!({"path": "/tmp/mlruns"})).is_err());
        assert!(validate_rd_tool_call("rd_exp_result", &json!({"tracking_store": "/tmp/mlruns"})).is_err());
        assert!(validate_rd_tool_call("delete_experiment", &json!({})).is_err());
    }

    #[test]
    fn riskcube_tool_validation_rejects_sql_paths_and_unknown_tools() {
        assert!(validate_riskcube_tool_call("olap_query", &json!({
            "scope": {"partition_id": "p1"}, "dimensions": ["underlying"],
            "measures": ["pv_amount"], "aggregation": "sum", "filters": [], "limit": 10
        })).is_ok());
        assert!(validate_riskcube_tool_call("olap_query", &json!({"sql": "select * from riskcube_cells"})).is_err());
        assert!(validate_riskcube_tool_call("olap_query", &json!({"uri": "file:///tmp/cube"})).is_err());
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
