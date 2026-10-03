//! MC diagnostics pass-through command.

use fina_kernel::api::McDiagnosticsResponse;
use fina_kernel::diagnostics::{final_mc, mc_diagnostics, mc_efficiency};
use fina_kernel::FinaErrorWire;

/// `get_mc_diagnostics` — `{ points, efficiency, final }` per §5.0.
#[tauri::command]
pub fn get_mc_diagnostics() -> Result<McDiagnosticsResponse, FinaErrorWire> {
    Ok(McDiagnosticsResponse {
        points: mc_diagnostics(),
        efficiency: mc_efficiency(),
        final_mc: final_mc(),
    })
}
