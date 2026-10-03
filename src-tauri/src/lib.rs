//! fina-builder desktop shell: a **thin Tauri adapter** over `fina-kernel`.
//!
//! All domain logic lives in `fina-kernel`; this crate only translates Tauri
//! IPC into kernel calls (see `PHASE1_MIGRATION_PROMPT.md` §5c). Commands in
//! `commands/` are pure pass-throughs: no formulas, no defaults, no branching
//! on domain values.

pub mod commands;

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
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
