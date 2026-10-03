//! # fina-kernel
//!
//! The structured-product analytics domain kernel: the **single source of truth**
//! for every numeric result in the application.
//!
//! This crate contains all domain logic and **no** transport, UI, async-runtime
//! or framework dependencies. That constraint is what allows four thin adapters
//! — Tauri IPC, HTTP, CLI and (Phase 2) MCP — to serve byte-identical results.
//!
//! ```text
//!   React frontend
//!        |  Tauri IPC        |  HTTP/REST
//!        v                   v
//!   src-tauri          fina-server          <-- thin adapters: no formulas
//!        \                   /
//!         \                 /
//!          v               v
//!            fina-kernel                     <-- all business logic
//! ```
//!
//! ## Numeric contract
//!
//! Every value here is validated against `tests/fixtures/golden.json`, a capture
//! of the original TypeScript implementation. Reproducing it byte-for-byte
//! requires JavaScript numeric semantics, so:
//!
//! - Rounding goes through [`jsnum`] ([`jsnum::js_round`] is **not**
//!   [`f64::round`]; see the module docs for the tie-breaking difference).
//! - Sums go through [`jsnum::sum_ordered`], because IEEE-754 addition is not
//!   associative and the order is pinned by the fixture.
//! - The PRNG is [`rng::Mulberry32`], bit-exact with the TypeScript original,
//!   consumed in a fixed draw order.
//!
//! ## Scope
//!
//! The models here are **deterministic demo engines**, not production pricing.
//! `path_generator` synthesises scenario-constrained paths rather than running a
//! calibrated stochastic simulation; several outputs are documented constants or
//! structural artifacts. ``FEATURES.md Part I`` is the authoritative inventory, and
//! `FEATURES.md` §10 lists the traps.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(clippy::pedantic)]
#![allow(
    clippy::module_name_repetitions,
    clippy::must_use_candidate,
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_lossless
)]
// EXACT float comparison is the point of this crate, not an oversight.
//
// Golden parity means asserting `result == 2.1000000000000000888`, not
// `abs(a - b) < 1e-9`. An epsilon here would let a `js_round` regression or a
// reordered sum pass silently, which is precisely the class of bug the fixture
// exists to catch (`FEATURES.md` pitfalls P-1, P-2). Production
// code paths compute values; `assert_eq!` appears only in tests, where bitwise
// comparison is the correct assertion.
#![allow(clippy::float_cmp, clippy::excessive_precision)]

pub mod api;
pub mod dates;
pub mod diagnostics;
pub mod economics;
pub mod error;
pub mod execution;
pub mod jsnum;
pub mod path_generator;
pub mod progress;
pub mod risk_engine;
pub mod rng;
pub mod types;
pub mod valuation;

pub use api::{
    dispatch, dispatch_sync, dispatch_value, CashflowRequest, CommandId, ComputeRiskRequest,
    ExplainRequest, GeneratePathsRequest, HealthResponse, McDiagnosticsResponse, PathRequest,
    TradeRequest,
};
pub use error::{FinaError, FinaErrorWire, Result, WireError};
pub use execution::{execution_events, ExecutionEvent, ExecutionEventType};
pub use progress::{ProgressEvent, ProgressLog};
pub use types::{
    BranchStats, DistributionStats, FxPair, MarketSnapshot, NodeDetailSnapshot, OhlcBar,
    PathAttribution, PathObservation, PayoffNodeId, ProductBarriers, SettlementType,
    SimulationBundle, SimulationDistributions, SimulationPath, TradeEconomics, Underlying,
    VolParams, DEFAULT_TRADE_ECONOMICS,
};
pub use valuation::{
    build_cashflows, cashflow_analytics, explain_ledger, valuation_explain, Cashflow,
    CashflowAnalytics, CashflowType, ExplainEntry, ExplainLedger, ExplainReconciliation,
    ExplainSource, PlvaContribution, TaylorExplain, ValuationExplain, ValuationExplainState,
};

/// Crate version, surfaced by the `health` command on every transport.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_populated() {
        assert!(!super::VERSION.is_empty());
    }

    #[test]
    fn modules_compile_without_transport_dependencies() {
        // The layering rule is a compile-time fact, not just documentation:
        // if this crate compiled with tauri/actix/clap available it would not
        // matter, but CI's `dependency-hygiene` job asserts the Cargo.toml
        // allowlist directly. This test at least pins the public surface.
        let _ = super::jsnum::js_round(0.5);
        let _ = super::rng::Mulberry32::new(42);
        let _ = super::dates::demo_dates(60);
    }
}
