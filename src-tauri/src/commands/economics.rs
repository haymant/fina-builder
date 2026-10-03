//! Trade-economics pass-through command.

use fina_kernel::api::TradeRequest;
use fina_kernel::economics::{derive_trade_analytics, TradeAnalytics};
use fina_kernel::FinaErrorWire;

/// `compute_trade_analytics`.
#[tauri::command]
pub fn compute_trade_analytics(req: TradeRequest) -> Result<TradeAnalytics, FinaErrorWire> {
    Ok(derive_trade_analytics(&req.trade))
}
