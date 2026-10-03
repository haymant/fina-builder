//! Risk-engine pass-through command.

use fina_kernel::api::ComputeRiskRequest;
use fina_kernel::risk_engine::{compute_risk as kernel_compute_risk, RiskState};
use fina_kernel::FinaErrorWire;

/// `compute_risk`.
#[tauri::command]
pub fn compute_risk(req: ComputeRiskRequest) -> Result<RiskState, FinaErrorWire> {
    kernel_compute_risk(&req.trade, &req.market).map_err(FinaErrorWire::from)
}
