//! fina-builder desktop shell: the MCP server registry (visual atlas) and the
//! in-process RIGA agent that backs the chat panel.
//!
//! The shell owns no pricing logic: it drives the vendored `riga-mcp` and
//! `tac-engine` servers over stdio, and the chat panel is RIGA's
//! `@rigai/assistant-ui`, driven by the `riga-server` IPC service in
//! `riga_agent`.

pub mod mcp;
pub mod mcp_commands;
pub mod nip_bridge;
pub mod nip_http;
pub mod riga_agent;

use riga_kernel::Agent;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

/// Open an external URL in the OS browser. The chat's markdown links are
/// `target="_blank"`; in the webview that would spawn a second app window, so the
/// UI routes them here instead. A first-party command avoids requiring a plugin
/// capability in the webview.
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

/// Persist uncaught webview errors next to the app data. The window can go
/// blank when React throws; without this the only evidence is a white screen.
#[tauri::command]
fn report_frontend_error(
    app: tauri::AppHandle,
    context: String,
    message: String,
) -> Result<(), String> {
    use std::io::Write;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let logs = directory.join("logs");
    std::fs::create_dir_all(&logs).map_err(|error| error.to_string())?;
    let path = logs.join("frontend-errors.log");
    if std::fs::metadata(&path)
        .map(|metadata| metadata.len() > 1024 * 1024)
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(&path);
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    let observed_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let entry = serde_json::json!({
        "at_ms": observed_at,
        "context": context,
        "message": message.chars().take(20_000).collect::<String>(),
    });
    writeln!(file, "{entry}").map_err(|error| error.to_string())?;
    eprintln!("{entry}");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(mcp_commands::McpState::default())
        .manage(Agent::new())
        .setup(|app| {
            // Forward `.env`-derived variables (TAC_LAKE_DIR, APCA_*, FRED_API_KEY,
            // RIGA_MCP_BIN, …) to the MCP engine children, so a `.env` next to the
            // app or in the repo root works without exporting shell variables.
            let engine_env = mcp_commands::engine_env(app.handle());
            app.state::<mcp_commands::McpState>()
                .runtime
                .configure_env(engine_env);
            // The RIGA agent host: one IpcService powering the chat panel.
            let ipc = riga_agent::install(app);
            // The NIP sidecar may use the user's configured RIGA provider only
            // through this loopback bridge. Inject its URL/token and NIP-owned
            // app-data paths into the NIP child alone.
            let bridge = match nip_bridge::start(ipc) {
                Ok(bridge) => Some(bridge),
                Err(error) => {
                    eprintln!("NIP: provider bridge unavailable; remote extraction stays disabled: {error}");
                    None
                }
            };
            // One NIP process, shared by the Narrative tab (Tauri commands) and
            // the RIGA chat (HTTP MCP). A second stdio child would contend for
            // the single-writer DuckDB file.
            let nip_state = nip_http::NipServiceState::default();
            let nip_url = match nip_http::start(app.handle(), bridge.as_ref()) {
                Ok(service) => {
                    let url = service.url().to_owned();
                    nip_state.set(service);
                    Some(url)
                }
                Err(error) => {
                    eprintln!("NIP: service unavailable: {error}");
                    nip_state.set_error(error);
                    None
                }
            };
            app.manage(nip_state);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                riga_agent::register_engines(handle, nip_url).await;
            });
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_external,
            report_frontend_error,
            // MCP registry (visual atlas + vendored engines).
            mcp_commands::get_riga_mcp_path,
            mcp_commands::get_tac_engine_path,
            mcp_commands::get_nip_engine_path,
            mcp_commands::riga_mcp_list_tools,
            mcp_commands::riga_mcp_call_tool,
            mcp_commands::riga_mcp_list_resources,
            mcp_commands::riga_mcp_read_resource,
            mcp_commands::riga_mcp_list_prompts,
            mcp_commands::riga_mcp_get_prompt,
            mcp_commands::riga_mcp_get_task,
            mcp_commands::riga_mcp_reset,
            mcp_commands::tac_mcp_list_tools,
            mcp_commands::tac_mcp_call_tool,
            mcp_commands::tac_mcp_reset,
            mcp_commands::nip_mcp_list_tools,
            mcp_commands::nip_mcp_call_tool,
            mcp_commands::nip_mcp_reset,
            mcp_commands::nip_service_url,
            nip_http::nip_get_local_model_settings,
            nip_http::nip_check_local_model,
            nip_http::nip_save_local_model_settings,
            nip_http::nip_media_file,
            // RIGA agent (chat panel).
            riga_agent::kernel_health,
            riga_agent::riga_transport_connect,
            riga_agent::riga_transport_disconnect,
            riga_agent::riga_health,
            riga_agent::riga_catalog,
            riga_agent::riga_list_sessions,
            riga_agent::riga_create_session,
            riga_agent::riga_session_history,
            riga_agent::riga_rename_session,
            riga_agent::riga_workspace_entries,
            riga_agent::riga_workspace_file,
            riga_agent::riga_git_status,
            riga_agent::riga_git_diff,
            riga_agent::riga_git_commit,
            riga_agent::riga_git_push,
            riga_agent::riga_git_log,
            riga_agent::riga_git_commit_diff,
            riga_agent::riga_list_active_runs,
            riga_agent::riga_list_mcp_registry,
            riga_agent::riga_save_mcp_registry,
            riga_agent::riga_configure_provider,
            riga_agent::riga_remote_models,
            riga_agent::riga_provider_profiles,
            riga_agent::riga_save_provider_profile,
            riga_agent::riga_delete_provider_profile,
            riga_agent::riga_start_run,
            riga_agent::riga_resume_run,
            riga_agent::riga_cancel_run,
            riga_agent::riga_respond_to_approval,
            riga_agent::riga_local_models,
            riga_agent::riga_local_model_action,
            riga_agent::riga_upload_attachment,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            handle.state::<nip_http::NipServiceState>().stop();
        }
    });
}
