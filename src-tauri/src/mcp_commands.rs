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
            for candidate in [resources.join(&exe_name), resources.join("binaries").join(&exe_name)] {
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
    collected
}

#[tauri::command]
pub async fn riga_mcp_list_tools(app: AppHandle, state: State<'_, McpState>) -> Result<Value, String> {
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
pub async fn riga_mcp_list_resources(app: AppHandle, state: State<'_, McpState>) -> Result<Value, String> {
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
pub async fn riga_mcp_list_prompts(app: AppHandle, state: State<'_, McpState>) -> Result<Value, String> {
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
pub async fn tac_mcp_list_tools(app: AppHandle, state: State<'_, McpState>) -> Result<Value, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(candidates[0], std::path::Path::new("/ws/modules/riga-flow/target/release/riga-mcp"));
        assert_eq!(candidates[1], std::path::Path::new("/ws/modules/riga-flow/target/debug/riga-mcp"));
        assert_eq!(candidates[candidates.len() - 1], std::path::Path::new("/ws/target/debug/riga-mcp"));
    }

    #[test]
    fn resolve_engine_binary_reports_the_missing_binary_and_env_var() {
        let err = resolve_engine_binary(None, "RIGA_MCP_BIN_TEST_UNSET_VAR", "definitely-not-a-submodule", "no-such-binary").unwrap_err();
        assert!(err.contains("RIGA_MCP_BIN_TEST_UNSET_VAR"), "unhelpful: {err}");
        assert!(err.contains("no-such-binary"), "unhelpful: {err}");
    }

    #[test]
    fn resolve_engine_binary_honours_the_env_override() {
        let dir = std::env::temp_dir().join("fina-builder-mcp-path-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("riga-mcp");
        std::fs::write(&file, b"").unwrap();
        std::env::set_var("RIGA_MCP_BIN_TEST_OVERRIDE", &file);
        let resolved = resolve_engine_binary(None, "RIGA_MCP_BIN_TEST_OVERRIDE", "riga-flow", "riga-mcp").unwrap();
        assert_eq!(resolved, file.to_string_lossy());
        std::env::remove_var("RIGA_MCP_BIN_TEST_OVERRIDE");
    }
}
