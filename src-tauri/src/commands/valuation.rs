//! Valuation pass-through commands.

use fina_kernel::api::{CashflowRequest, CashflowResponse, ExplainRequest};
use fina_kernel::valuation::{
    build_cashflows as kernel_build_cashflows, cashflow_analytics,
    explain_ledger as kernel_explain_ledger, valuation_explain as kernel_valuation_explain,
    ExplainLedger, ValuationExplain,
};
use fina_kernel::FinaErrorWire;

/// `build_cashflows`.
#[tauri::command]
pub fn build_cashflows(req: CashflowRequest) -> Result<CashflowResponse, FinaErrorWire> {
    let path = crate::commands::dispatch_demo_path(req.path_index).map_err(FinaErrorWire::from)?;
    Ok(CashflowResponse {
        cashflows: kernel_build_cashflows(&path, &req.trade),
        analytics: cashflow_analytics(&path, &req.trade),
    })
}

/// `valuation_explain`.
#[tauri::command]
pub fn valuation_explain(req: ExplainRequest) -> Result<ValuationExplain, FinaErrorWire> {
    let path = crate::commands::dispatch_demo_path(req.path_index).map_err(FinaErrorWire::from)?;
    let cash = cashflow_analytics(&path, &req.trade);
    Ok(kernel_valuation_explain(&cash, &req.market))
}

/// `explain_ledger`.
#[tauri::command]
pub fn explain_ledger(req: ExplainRequest) -> Result<ExplainLedger, FinaErrorWire> {
    let path = crate::commands::dispatch_demo_path(req.path_index).map_err(FinaErrorWire::from)?;
    let cash = cashflow_analytics(&path, &req.trade);
    let explain = kernel_valuation_explain(&cash, &req.market);
    Ok(kernel_explain_ledger(&explain, &cash, &req.as_of))
}
