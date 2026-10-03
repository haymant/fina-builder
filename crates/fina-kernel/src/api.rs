//! The wire contract: the request/response shape every transport adapter
//! speaks, defined once here and reused verbatim (`FEATURES.md`
//! §5.0, invariant I-3).
//!
//! # Why dispatch lives in the kernel
//!
//! The spec puts the *request types* here and leaves each adapter to wire them
//! up. [`dispatch`] goes one step further: it is the actual command router, so
//! the CLI, the HTTP server and the Tauri handler all call **the same code**
//! that serialises a command name + request JSON into a response. An adapter
//! therefore contains no mapping table of its own to drift out of sync — a
//! reviewer can confirm each command produces identical bytes across all three
//! transports without diffing three routers.
//!
//! [`dispatch`] is still not business logic: it owns no formulas, no defaults,
//! no branching on domain values. Every arm is parse → call the kernel →
//! serialise.

use crate::diagnostics::{final_mc, mc_diagnostics, mc_efficiency};
use crate::economics::derive_trade_analytics;
use crate::execution::ExecutionEvent;
use crate::path_generator::{generate_paths, SimulationConfig};
use crate::progress::ProgressEvent;
use crate::risk_engine::compute_risk;
use crate::types::{MarketSnapshot, SimulationBundle, SimulationPath, TradeEconomics};
use crate::valuation::{
    build_cashflows, cashflow_analytics, explain_ledger, valuation_explain, Cashflow,
    CashflowAnalytics,
};
use crate::{FinaError, Result, VERSION};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The twelve commands, in §5.0's table order. Names are the single source of
/// truth for the CLI's kebab-case subcommands (`generate_paths` →
/// `generate-paths`) and the HTTP `/api/cmd/{command}` path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandId {
    /// Generate the full path bundle (`simulationStore.load`).
    GeneratePaths,
    /// One path by index (`explorerStore` selection).
    GetPath,
    /// Population branch counts.
    GetBranchStats,
    /// The four payoff distributions.
    GetDistributions,
    /// Trade analytics panel.
    ComputeTradeAnalytics,
    /// Risk panel Greeks.
    ComputeRisk,
    /// The MC convergence series + efficiency table + final row.
    GetMcDiagnostics,
    /// The cashflow schedule + aggregates for one path.
    BuildCashflows,
    /// Taylor + PLVA explain for one path.
    ValuationExplain,
    /// The ten-entry explain ledger for one path.
    ExplainLedger,
    /// The per-observation event stream for one path.
    ExecutionEvents,
    /// Service liveness + version.
    Health,
}

impl CommandId {
    /// All commands, in the order the command table lists them.
    pub const ALL: [Self; 12] = [
        Self::GeneratePaths,
        Self::GetPath,
        Self::GetBranchStats,
        Self::GetDistributions,
        Self::ComputeTradeAnalytics,
        Self::ComputeRisk,
        Self::GetMcDiagnostics,
        Self::BuildCashflows,
        Self::ValuationExplain,
        Self::ExplainLedger,
        Self::ExecutionEvents,
        Self::Health,
    ];

    /// The `snake_case` wire name, e.g. `` `"generate_paths"` ``.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::GeneratePaths => "generate_paths",
            Self::GetPath => "get_path",
            Self::GetBranchStats => "get_branch_stats",
            Self::GetDistributions => "get_distributions",
            Self::ComputeTradeAnalytics => "compute_trade_analytics",
            Self::ComputeRisk => "compute_risk",
            Self::GetMcDiagnostics => "get_mc_diagnostics",
            Self::BuildCashflows => "build_cashflows",
            Self::ValuationExplain => "valuation_explain",
            Self::ExplainLedger => "explain_ledger",
            Self::ExecutionEvents => "execution_events",
            Self::Health => "health",
        }
    }

    /// Parses a wire name back into a command.
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.iter().copied().find(|c| c.as_str() == name)
    }
}

// ---------------------------------------------------------------------------
// Request types (§5.0)
// ---------------------------------------------------------------------------

/// `generate_paths`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratePathsRequest {
    /// The simulation configuration; `config: default` reproduces
    /// `golden.json`.
    pub config: SimulationConfig,
}

/// `get_path` / `execution_events`.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathRequest {
    /// 1-based path index, matching `SimulationPath::path_index`.
    pub path_index: usize,
}

/// `compute_trade_analytics`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeRequest {
    /// The trade terms to analyse.
    pub trade: TradeEconomics,
}

/// `compute_risk`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputeRiskRequest {
    /// The trade terms.
    pub trade: TradeEconomics,
    /// The market state the Greeks are computed against.
    pub market: MarketSnapshot,
}

/// `build_cashflows`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CashflowRequest {
    /// The trade terms (annual coupon convention).
    pub trade: TradeEconomics,
    /// 1-based path index.
    pub path_index: usize,
}

/// `valuation_explain` / `explain_ledger`.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainRequest {
    /// The trade terms.
    pub trade: TradeEconomics,
    /// The market state.
    pub market: MarketSnapshot,
    /// 1-based path index.
    pub path_index: usize,
    /// Ledger `timestamp`, `YYYY-MM-DD`, injected by the caller (not the
    /// clock) so responses are reproducible.
    pub as_of: String,
}

// ---------------------------------------------------------------------------
// Response helpers (each response is one kernel type serialised directly —
// no wrapper objects, per §5.0)
// ---------------------------------------------------------------------------

/// `get_mc_diagnostics`: the spec's `{ points, efficiency, final }` envelope.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McDiagnosticsResponse {
    /// The ten-row convergence series.
    pub points: Vec<crate::diagnostics::McPoint>,
    /// The four literal efficiency rows.
    pub efficiency: Vec<crate::diagnostics::McEfficiency>,
    /// The converged final row. `final` per §5.0's table — not serde's
    /// camelCase `finalMc`.
    #[serde(rename = "final")]
    pub final_mc: crate::diagnostics::McPoint,
}

/// `health`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    /// The kernel's crate version.
    pub version: String,
    /// The `.coreVersion` key the frontend reads.
    pub core_version: String,
}

/// `build_cashflows`: the spec's `{ cashflows, analytics }` envelope.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CashflowResponse {
    /// One row per observation date.
    pub cashflows: Vec<Cashflow>,
    /// The aggregate panel values.
    pub analytics: CashflowAnalytics,
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

/// The canonical demo bundle every path-indexed command reads from. Every
/// transport regenerates it per request; it is deterministic (I-2), so the
/// results are stable, and 100 paths is cheaper than a shared cache would be to
/// keep correct across transports.
fn demo_bundle() -> Result<SimulationBundle> {
    generate_paths(SimulationConfig::demo(), |_| {})
}

/// Looks up a path, returning the §8.2 error message verbatim.
fn demo_path(index: usize) -> Result<SimulationPath> {
    let bundle = demo_bundle()?;
    bundle
        .paths
        .iter()
        .find(|p| p.path_index == index)
        .cloned()
        .ok_or(FinaError::PathOutOfRange {
            index,
            len: bundle.paths.len(),
        })
}

/// Serialises a response value into the wire bytes. Kept separate so every
/// dispatch arm serialises through exactly this one path.
fn encode(value: &impl Serialize) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|e| FinaError::InvalidRequest(e.to_string()))
}

/// Routes one command to the kernel and returns the serialised response.
///
/// `on_progress` receives every [`ProgressEvent`] the operation emits; commands
/// that produce none (everything except `generate_paths`) simply never invoke
/// it. Adapters bridge it to their transport without inspecting it.
///
/// The return value is the **exact bytes** of the response JSON — `serde_json`
/// serialises the kernel type directly, so every transport emits identical
/// text (I-3).
///
/// # Errors
///
/// Returns [`FinaError::InvalidRequest`] for an unknown command or a body that
/// does not deserialise, and whatever domain error the command's kernel
/// function reports (e.g. [`FinaError::PathOutOfRange`] for a bad
/// `path_index`).
pub fn dispatch(
    command: &str,
    body: &[u8],
    on_progress: &mut dyn FnMut(ProgressEvent),
) -> Result<Vec<u8>> {
    match CommandId::parse(command) {
        Some(CommandId::GeneratePaths) => {
            let req: GeneratePathsRequest = serde_json::from_slice(body)?;
            let bundle = generate_paths(req.config, on_progress)?;
            encode(&bundle)
        }
        Some(CommandId::GetPath) => {
            let req: PathRequest = serde_json::from_slice(body)?;
            encode(&demo_path(req.path_index)?)
        }
        Some(CommandId::GetBranchStats) => encode(&demo_bundle()?.branch_stats),
        Some(CommandId::GetDistributions) => encode(&demo_bundle()?.distributions),
        Some(CommandId::ComputeTradeAnalytics) => {
            let req: TradeRequest = serde_json::from_slice(body)?;
            encode(&derive_trade_analytics(&req.trade))
        }
        Some(CommandId::ComputeRisk) => {
            let req: ComputeRiskRequest = serde_json::from_slice(body)?;
            encode(&compute_risk(&req.trade, &req.market)?)
        }
        Some(CommandId::GetMcDiagnostics) => {
            let resp = McDiagnosticsResponse {
                points: mc_diagnostics(),
                efficiency: mc_efficiency(),
                final_mc: final_mc(),
            };
            encode(&resp)
        }
        Some(CommandId::BuildCashflows) => {
            let req: CashflowRequest = serde_json::from_slice(body)?;
            let path = demo_path(req.path_index)?;
            let cashflows = build_cashflows(&path, &req.trade);
            let analytics = cashflow_analytics(&path, &req.trade);
            encode(&CashflowResponse {
                cashflows,
                analytics,
            })
        }
        Some(CommandId::ValuationExplain) => {
            let req: ExplainRequest = serde_json::from_slice(body)?;
            let path = demo_path(req.path_index)?;
            let cash = cashflow_analytics(&path, &req.trade);
            encode(&valuation_explain(&cash, &req.market))
        }
        Some(CommandId::ExplainLedger) => {
            let req: ExplainRequest = serde_json::from_slice(body)?;
            let path = demo_path(req.path_index)?;
            let cash = cashflow_analytics(&path, &req.trade);
            let explain = valuation_explain(&cash, &req.market);
            encode(&explain_ledger(&explain, &cash, &req.as_of))
        }
        Some(CommandId::ExecutionEvents) => {
            let req: PathRequest = serde_json::from_slice(body)?;
            let events: Vec<ExecutionEvent> =
                crate::execution::execution_events(&demo_path(req.path_index)?);
            encode(&events)
        }
        Some(CommandId::Health) => {
            let resp = HealthResponse {
                version: VERSION.to_string(),
                core_version: VERSION.to_string(),
            };
            encode(&resp)
        }
        None => Err(FinaError::InvalidRequest(format!(
            "unknown command `{command}`; expected one of {}",
            CommandId::ALL
                .iter()
                .map(|c| c.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

/// Convenience: [`dispatch`] without a progress sink.
///
/// # Errors
///
/// Same as [`dispatch`].
pub fn dispatch_sync(command: &str, body: &[u8]) -> Result<Vec<u8>> {
    dispatch(command, body, &mut |_| {})
}

/// The JSON value of a dispatch, for tests and for adapters that need the
/// parsed form rather than the bytes.
///
/// # Errors
///
/// Same as [`dispatch`], plus [`FinaError::InvalidRequest`] if the response
/// bytes are not valid JSON (which cannot happen for a successful dispatch).
pub fn dispatch_value(command: &str, body: &[u8]) -> Result<Value> {
    let bytes = dispatch(command, body, &mut |_| {})?;
    serde_json::from_slice(&bytes).map_err(|e| FinaError::InvalidRequest(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_names_are_snake_case_and_unique() {
        let mut seen = std::collections::HashSet::new();
        for c in CommandId::ALL {
            assert!(seen.insert(c.as_str()), "duplicate name {}", c.as_str());
            assert_eq!(c.as_str(), c.as_str().replace('-', "_"));
            assert!(c
                .as_str()
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch == '_'));
        }
        assert_eq!(CommandId::ALL.len(), 12);
    }

    #[test]
    fn command_names_round_trip_through_parse() {
        for c in CommandId::ALL {
            assert_eq!(CommandId::parse(c.as_str()), Some(c));
        }
        assert_eq!(CommandId::parse("nope"), None);
    }

    /// Every command dispatches a valid response (or the documented error) for
    /// a canonical request. This is the smoke test the adapters lean on: if the
    /// kernel router serialises wrong, every transport fails identically.
    #[test]
    fn every_command_dispatches() {
        let path = r#"{"pathIndex":1}"#.as_bytes();
        let config = serde_json::to_vec(&GeneratePathsRequest {
            config: SimulationConfig::demo(),
        })
        .unwrap();

        let cases: &[(&str, &[u8])] = &[
            ("generate_paths", &config),
            ("get_path", path),
            ("get_branch_stats", b"{}"),
            ("get_distributions", b"{}"),
            (
                "compute_trade_analytics",
                &serde_json::to_vec(&TradeRequest {
                    trade: TradeEconomics::default(),
                })
                .unwrap(),
            ),
            (
                "compute_risk",
                &serde_json::to_vec(&ComputeRiskRequest {
                    trade: TradeEconomics::default(),
                    market: MarketSnapshot::demo(),
                })
                .unwrap(),
            ),
            ("get_mc_diagnostics", b"{}"),
            (
                "build_cashflows",
                &serde_json::to_vec(&CashflowRequest {
                    trade: TradeEconomics::default(),
                    path_index: 1,
                })
                .unwrap(),
            ),
            (
                "valuation_explain",
                &serde_json::to_vec(&ExplainRequest {
                    trade: TradeEconomics::default(),
                    market: MarketSnapshot::demo(),
                    path_index: 1,
                    as_of: "2026-01-15".into(),
                })
                .unwrap(),
            ),
            (
                "explain_ledger",
                &serde_json::to_vec(&ExplainRequest {
                    trade: TradeEconomics::default(),
                    market: MarketSnapshot::demo(),
                    path_index: 1,
                    as_of: "2026-01-15".into(),
                })
                .unwrap(),
            ),
            ("execution_events", path),
            ("health", b"{}"),
        ];
        for (name, body) in cases {
            let out = dispatch_sync(name, body).unwrap_or_else(|e| panic!("{name} failed: {e}"));
            let v: Value = serde_json::from_slice(&out).unwrap();
            assert!(!v.is_null(), "{name} returned null");
        }
    }

    /// The path-out-of-range error matches the §5.0 wire example verbatim.
    #[test]
    fn path_out_of_range_wire_shape() {
        let err = dispatch_sync("get_path", br#"{"pathIndex":500}"#).unwrap_err();
        assert_eq!(err.code(), "PATH_OUT_OF_RANGE");
        assert_eq!(
            err.to_string(),
            "path index 500 out of range (bundle has 100)"
        );
    }

    /// An unknown command is an `INVALID_REQUEST`, not a panic or a `500`.
    #[test]
    fn unknown_command_is_invalid_request() {
        let err = dispatch_sync("sudo_rm_rf", b"{}").unwrap_err();
        assert_eq!(err.code(), "INVALID_REQUEST");
    }

    /// A malformed body is an `INVALID_REQUEST`, so all transports return the
    /// same 400-class error rather than a 500.
    #[test]
    fn malformed_body_is_invalid_request() {
        let err = dispatch_sync("compute_risk", b"not json").unwrap_err();
        assert_eq!(err.code(), "INVALID_REQUEST");
    }

    /// `dispatch` byte-identity: the same command on the same request must give
    /// the same bytes every time, because the frontend compares against the
    /// golden fixture.
    #[test]
    fn dispatch_is_deterministic() {
        let body = serde_json::to_vec(&GeneratePathsRequest {
            config: SimulationConfig::demo(),
        })
        .unwrap();
        let a = dispatch_sync("generate_paths", &body).unwrap();
        let b = dispatch_sync("generate_paths", &body).unwrap();
        assert_eq!(a, b);
    }

    /// Progress events must flow through the callback for `generate_paths`.
    #[test]
    fn generate_paths_reports_progress() {
        let body = serde_json::to_vec(&GeneratePathsRequest {
            config: SimulationConfig::demo(),
        })
        .unwrap();
        let mut events = Vec::new();
        let out = dispatch("generate_paths", &body, &mut |e| events.push(e)).unwrap();
        assert!(!events.is_empty(), "generate_paths must emit progress");
        assert!(
            events.windows(2).all(|w| w[0].completed <= w[1].completed),
            "progress completed must be monotonic"
        );
        let last = events.last().unwrap();
        assert_eq!(last.completed, last.total, "progress must end complete");
        assert!(!out.is_empty(), "dispatch must return bytes");
    }

    /// Non-progress commands never invoke the callback.
    #[test]
    fn non_progress_commands_do_not_invoke_the_callback() {
        let mut called = 0;
        dispatch("health", b"{}", &mut |_| called += 1).unwrap();
        assert_eq!(called, 0);
    }
}
