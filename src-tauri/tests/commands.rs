//! Tauri commands are pure pass-throughs: their output must be byte-identical
//! to `fina_kernel::api::dispatch`, which is what the CLI and HTTP transports
//! emit. This is invariant I-3 held from the Tauri side: any command that
//! reshapes, rounds or defaults differently fails here even though the kernel
//! itself is already golden-verified.

use fina_kernel::api::{
    dispatch_sync, CashflowRequest, ComputeRiskRequest, ExplainRequest, GeneratePathsRequest,
    PathRequest, TradeRequest,
};
use fina_kernel::path_generator::SimulationConfig;
use fina_kernel::types::{MarketSnapshot, TradeEconomics};
use fina_kernel::FinaErrorWire;

fn must_serialise<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap()
}

fn from_wire<T: serde::Serialize>(e: Result<T, FinaErrorWire>) -> String {
    match e {
        Ok(v) => must_serialise(&v),
        Err(w) => serde_json::to_string(&w.wire()).unwrap(),
    }
}

/// Helper: the `FinaErrorWire` inner serialises as `{code,message}`, same as
/// `WireError` — the `MapErr` variant used by the other transports.
trait WireExt {
    fn wire(&self) -> fina_kernel::WireError;
}
impl WireExt for FinaErrorWire {
    fn wire(&self) -> fina_kernel::WireError {
        fina_kernel::WireError::from(&self.0)
    }
}

#[test]
fn generate_paths_matches_dispatch() {
    let req = GeneratePathsRequest {
        config: SimulationConfig::demo(),
    };
    let body = serde_json::to_vec(&req).unwrap();
    let channel = tauri::ipc::Channel::new(|_| Ok(()));
    let via_tauri = from_wire(fina_tauri::commands::path_generator::generate_paths(
        req, channel,
    ));
    let via_dispatch = String::from_utf8(dispatch_sync("generate_paths", &body).unwrap()).unwrap();
    assert_eq!(via_tauri, via_dispatch);
}

#[test]
fn get_path_matches_dispatch() {
    let req = PathRequest { path_index: 1 };
    let body = serde_json::to_vec(&req).unwrap();
    let via_tauri = from_wire(fina_tauri::commands::path_generator::get_path(req));
    let via_dispatch = String::from_utf8(dispatch_sync("get_path", &body).unwrap()).unwrap();
    assert_eq!(via_tauri, via_dispatch);
}

#[test]
fn compute_risk_matches_dispatch() {
    let req = ComputeRiskRequest {
        trade: TradeEconomics::default(),
        market: MarketSnapshot::demo(),
    };
    let body = serde_json::to_vec(&req).unwrap();
    let via_tauri = from_wire(fina_tauri::commands::risk_engine::compute_risk(req));
    let via_dispatch = String::from_utf8(dispatch_sync("compute_risk", &body).unwrap()).unwrap();
    assert_eq!(via_tauri, via_dispatch);
}

#[test]
fn trade_analytics_and_mc_diagnostics_match_dispatch() {
    let req = TradeRequest {
        trade: TradeEconomics::default(),
    };
    let body = serde_json::to_vec(&req).unwrap();
    let via_tauri = from_wire(fina_tauri::commands::economics::compute_trade_analytics(
        req,
    ));
    let via_dispatch =
        String::from_utf8(dispatch_sync("compute_trade_analytics", &body).unwrap()).unwrap();
    assert_eq!(via_tauri, via_dispatch);

    let via_tauri = from_wire(fina_tauri::commands::diagnostics::get_mc_diagnostics());
    let via_dispatch =
        String::from_utf8(dispatch_sync("get_mc_diagnostics", b"{}").unwrap()).unwrap();
    assert_eq!(via_tauri, via_dispatch);
}

#[test]
fn valuation_commands_match_dispatch() {
    let cf = CashflowRequest {
        trade: TradeEconomics::default(),
        path_index: 1,
    };
    let body = serde_json::to_vec(&cf).unwrap();
    let via_tauri = from_wire(fina_tauri::commands::valuation::build_cashflows(cf));
    let via_dispatch = String::from_utf8(dispatch_sync("build_cashflows", &body).unwrap()).unwrap();
    assert_eq!(via_tauri, via_dispatch);

    let ex = ExplainRequest {
        trade: TradeEconomics::default(),
        market: MarketSnapshot::demo(),
        path_index: 1,
        as_of: "2026-01-15".to_string(),
    };
    let body = serde_json::to_vec(&ex).unwrap();
    let via_tauri = from_wire(fina_tauri::commands::valuation::valuation_explain(
        ex.clone(),
    ));
    let via_dispatch =
        String::from_utf8(dispatch_sync("valuation_explain", &body).unwrap()).unwrap();
    assert_eq!(via_tauri, via_dispatch);

    let via_tauri = from_wire(fina_tauri::commands::valuation::explain_ledger(ex));
    let via_dispatch = String::from_utf8(dispatch_sync("explain_ledger", &body).unwrap()).unwrap();
    assert_eq!(via_tauri, via_dispatch);
}

#[test]
fn out_of_range_error_matches_dispatch() {
    let req = PathRequest { path_index: 500 };
    let body = serde_json::to_vec(&req).unwrap();
    let via_tauri = from_wire(fina_tauri::commands::path_generator::get_path(req));
    let via_dispatch_err = dispatch_sync("get_path", &body).unwrap_err();
    let via_dispatch = must_serialise(&fina_kernel::WireError::from(&via_dispatch_err));
    assert_eq!(via_tauri, via_dispatch);
}

#[test]
fn branch_distributions_and_execution_events_match_dispatch() {
    use fina_tauri::commands::path_generator as pg;

    let via_tauri = from_wire(pg::get_branch_stats());
    let via_dispatch =
        String::from_utf8(dispatch_sync("get_branch_stats", b"{}").unwrap()).unwrap();
    assert_eq!(via_tauri, via_dispatch);

    let via_tauri = from_wire(pg::get_distributions());
    let via_dispatch =
        String::from_utf8(dispatch_sync("get_distributions", b"{}").unwrap()).unwrap();
    assert_eq!(via_tauri, via_dispatch);

    let req = PathRequest { path_index: 1 };
    let body = serde_json::to_vec(&req).unwrap();
    let via_tauri = from_wire(pg::execution_events(req));
    let via_dispatch =
        String::from_utf8(dispatch_sync("execution_events", &body).unwrap()).unwrap();
    assert_eq!(via_tauri, via_dispatch);
}
