//! fina-builder desktop shell: thin kernel-command adapters plus a local-agent service.
//!
//! All product-domain logic lives in `fina-kernel`; commands in `commands/` are
//! pure pass-throughs (see `FEATURES.md` §5c). `local_agent` is separate native
//! application infrastructure for app-data, GGUF model lifecycle, in-process
//! inference, and local session files; it does not implement kernel formulas.

pub mod commands;
pub mod local_agent;

use fina_kernel::api::HealthResponse;
use fina_kernel::FinaErrorWire;

/// `health` — one line, no domain inputs.
#[tauri::command]
fn health() -> Result<HealthResponse, FinaErrorWire> {
    Ok(HealthResponse {
        version: fina_kernel::VERSION.to_string(),
        core_version: fina_kernel::VERSION.to_string(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .manage(local_agent::LocalAgentRuntime::default())
        .setup(|app| {
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
            local_agent::get_app_paths,
            local_agent::curated_model_catalog,
            local_agent::list_local_models,
            local_agent::open_models_folder,
            local_agent::start_model_download,
            local_agent::cancel_model_download,
            local_agent::load_model,
            local_agent::unload_model,
            local_agent::get_loaded_model,
            local_agent::run_local_inference,
            local_agent::cancel_local_inference,
            local_agent::save_local_agent_session,
            local_agent::list_local_agent_sessions,
            local_agent::load_local_agent_session,
            local_agent::get_preferred_model,
            local_agent::get_mcp_server_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
