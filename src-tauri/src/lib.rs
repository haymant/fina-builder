//! fina-builder desktop shell: kernel-command adapters, the MCP server registry
//! (visual atlas), and the in-process RIGA agent that backs the chat panel.
//!
//! All product-domain logic lives in `fina-kernel`; commands in `commands/` are
//! pure pass-throughs (see `FEATURES.md` §5c). The chat panel is RIGA's
//! `@rigai/assistant-ui`, driven by the `riga-server` IPC service in
//! `riga_agent` — this shell owns no agent logic of its own.

pub mod commands;
pub mod mcp;
pub mod mcp_commands;
pub mod riga_agent;

use fina_kernel::api::HealthResponse;
use fina_kernel::FinaErrorWire;
use riga_kernel::Agent;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

/// `health` — one line, no domain inputs.
#[tauri::command]
fn health() -> Result<HealthResponse, FinaErrorWire> {
    Ok(HealthResponse {
        version: fina_kernel::VERSION.to_string(),
        core_version: fina_kernel::VERSION.to_string(),
    })
}

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            riga_agent::install(app);
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
            health,
            open_external,
            commands::path_generator::generate_paths,
            commands::path_generator::get_path,
            commands::path_generator::get_branch_stats,
            commands::path_generator::get_distributions,
            commands::path_generator::execution_events,
            commands::economics::compute_trade_analytics,
            commands::risk_engine::compute_risk,
            commands::diagnostics::get_mc_diagnostics,
            commands::valuation::build_cashflows,
            commands::valuation::valuation_explain,
            commands::valuation::explain_ledger,
            // MCP registry (visual atlas + bundled fina-mcp).
            mcp_commands::get_mcp_server_path,
            mcp_commands::mcp_list_tools,
            mcp_commands::mcp_call_tool,
            mcp_commands::mcp_reset,
            mcp_commands::get_riga_mcp_path,
            mcp_commands::get_tac_engine_path,
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
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
