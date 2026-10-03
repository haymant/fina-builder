//! Domain types — a 1:1 mirror of `src/features/shared/types.ts`.
//!
//! # Serde policy
//!
//! Every struct and enum uses `#[serde(rename_all = "camelCase")]` so the JSON
//! on every transport is byte-identical and matches what the TypeScript
//! frontend already expects. Do not add `#[serde(skip)]` or `flatten`: the
//! golden fixture compares whole serialized values, so any shape drift fails
//! parity.
//!
//! Field order in these structs is the field order in the JSON output, which
//! `serde_json` preserves for structs. The golden fixture was produced by
//! `JSON.stringify` on the TypeScript objects, so field declaration order here
//! must match the TypeScript declaration order.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Payoff graph nodes
// ---------------------------------------------------------------------------

/// Identifies one node in the payoff-processing graph.
///
/// Serializes to the exact `PascalCase` strings the graph layout and tile code
/// match on (`"GlobalKOGate"`, not `"global_ko_gate"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PayoffNodeId {
    /// Root node: which path was drawn.
    PathCube,
    /// Observation schedule.
    FixingSchedule,
    /// Worst-of performance versus strike.
    WorstOfPerformance,
    /// Knock-in gate.
    KnockInGate,
    /// Global knock-out / autocall gate.
    GlobalKOGate,
    /// Range accrual test.
    RangeAccrual,
    /// Coupon strip.
    CouponStrip,
    /// Memory coupon carry.
    MemoryCarry,
    /// Down-and-in put leg.
    DownAndInPut,
    /// Redemption.
    Redemption,
    /// Discounting.
    Discount,
    /// Aggregate present value.
    AggregatePV,
}

impl PayoffNodeId {
    /// All node ids, in the declaration order used by the golden fixture.
    pub const ALL: [Self; 12] = [
        Self::PathCube,
        Self::FixingSchedule,
        Self::WorstOfPerformance,
        Self::KnockInGate,
        Self::GlobalKOGate,
        Self::RangeAccrual,
        Self::CouponStrip,
        Self::MemoryCarry,
        Self::DownAndInPut,
        Self::Redemption,
        Self::Discount,
        Self::AggregatePV,
    ];

    /// The display label, identical to the serialized form.
    #[must_use]
    pub fn label(&self) -> &'static str {
        match self {
            Self::PathCube => "PathCube",
            Self::FixingSchedule => "FixingSchedule",
            Self::WorstOfPerformance => "WorstOfPerformance",
            Self::KnockInGate => "KnockInGate",
            Self::GlobalKOGate => "GlobalKOGate",
            Self::RangeAccrual => "RangeAccrual",
            Self::CouponStrip => "CouponStrip",
            Self::MemoryCarry => "MemoryCarry",
            Self::DownAndInPut => "DownAndInPut",
            Self::Redemption => "Redemption",
            Self::Discount => "Discount",
            Self::AggregatePV => "AggregatePV",
        }
    }

    /// Position in [`Self::ALL`], i.e. the TypeScript object-key order.
    #[must_use]
    pub fn index(&self) -> usize {
        match self {
            Self::PathCube => 0,
            Self::FixingSchedule => 1,
            Self::WorstOfPerformance => 2,
            Self::KnockInGate => 3,
            Self::GlobalKOGate => 4,
            Self::RangeAccrual => 5,
            Self::CouponStrip => 6,
            Self::MemoryCarry => 7,
            Self::DownAndInPut => 8,
            Self::Redemption => 9,
            Self::Discount => 10,
            Self::AggregatePV => 11,
        }
    }

    /// Parses a label back into a node id.
    #[must_use]
    pub fn from_label(label: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|n| n.label() == label)
    }
}

impl std::fmt::Display for PayoffNodeId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.label())
    }
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/// How a knock-in path settles.
///
/// Serializes lowercase: `"cash"`, `"physical"`, `"none"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SettlementType {
    /// Cash settlement.
    Cash,
    /// Physical delivery.
    Physical,
    /// No put exposure; no settlement leg.
    None,
}

// ---------------------------------------------------------------------------
// Payoff graph inputs and outputs
// ---------------------------------------------------------------------------

/// Barrier and coupon terms used to synthesise paths.
///
/// # Not the same as [`TradeEconomics`]
/// These are the hard-coded `BARRIERS` constants from the TypeScript
/// `generatePaths.ts` (`ki 0.70`, `ko 1.00`, coupon range `0.75..1.00`, monthly
/// rate `0.008`, notional `100`). [`TradeEconomics`] holds the *UI control*
/// defaults (`ki 0.60`, `ko 1.00`, coupon range `0.70..1.20`, annual rate `0.12`).
/// The two deliberately diverge; see `PHASE1_MIGRATION_PROMPT.md` §3.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductBarriers {
    /// Knock-in barrier, as a fraction of strike.
    pub ki_barrier: f64,
    /// Knock-out (autocall) barrier, as a fraction of strike.
    pub ko_barrier: f64,
    /// Lower bound of the coupon-accrual range.
    pub coupon_lower: f64,
    /// Upper bound of the coupon-accrual range.
    pub coupon_upper: f64,
    /// Coupon rate **per observation** (monthly) in the demo fixture.
    pub coupon_rate: f64,
    /// Notional.
    pub notional: f64,
}

impl Default for ProductBarriers {
    /// The exact `BARRIERS` constant from `generatePaths.ts`.
    fn default() -> Self {
        Self {
            ki_barrier: 0.7,
            ko_barrier: 1.0,
            coupon_lower: 0.75,
            coupon_upper: 1.0,
            coupon_rate: 0.008,
            notional: 100.0,
        }
    }
}

/// One monthly observation along a path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathObservation {
    /// Observation date, `YYYY-MM-DD`.
    pub date: String,
    /// Zero-based observation index.
    pub date_index: usize,
    /// AAPL level, normalised so inception is 1.0.
    pub aapl: f64,
    /// MSFT level.
    pub msft: f64,
    /// NVDA level.
    pub nvda: f64,
    /// Worst-of performance, `min(aapl, msft, nvda)`.
    pub worst_of_performance: f64,
    /// Coupon accrued at this observation, rounded to 2dp.
    pub coupon_accrued: f64,
    /// Unpaid coupon balance carried into the next observation, 2dp.
    pub coupon_memory_balance: f64,
    /// Whether the knock-in barrier was first breached here.
    pub knock_in_at_date: bool,
    /// Whether the knock-out barrier was met here.
    pub knock_out_at_date: bool,
}

/// Present-value attribution for one path.
///
/// `total_pv` is the sum of the six components. `funding` and `discounting`
/// are negative by construction.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathAttribution {
    /// Par redemption.
    pub par_redemption: f64,
    /// Coupons paid along the path.
    pub coupon: f64,
    /// Memory coupons paid along the path.
    pub memory_coupon: f64,
    /// Down-and-in put leg.
    pub down_and_in_put: f64,
    /// Funding adjustment.
    pub funding: f64,
    /// Discounting adjustment.
    pub discounting: f64,
    /// Total present value.
    pub total_pv: f64,
}

impl PathAttribution {
    /// Sums the six components **left to right**, in the order the TypeScript
    /// source uses, then rounds to 2dp.
    ///
    /// The summation order is part of the numeric contract; see
    /// [`crate::jsnum::sum_ordered`] and `PHASE1_MIGRATION_PROMPT.md` pitfall P-1.
    #[must_use]
    pub fn compute_total(&self) -> f64 {
        crate::jsnum::round2(crate::jsnum::sum_ordered(&[
            self.par_redemption,
            self.coupon,
            self.memory_coupon,
            self.down_and_in_put,
            self.funding,
            self.discounting,
        ]))
    }
}

/// A per-node explainability snapshot attached to every path.
///
/// These drive the Node Details tile and the payoff graph's node highlighting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDetailSnapshot {
    /// Which node this describes.
    pub node_id: PayoffNodeId,
    /// Display name.
    pub name: String,
    /// Prose description.
    pub description: String,
    /// The node's primary input, pre-formatted.
    pub input_value: String,
    /// The rule the node applies.
    pub decision_rule: String,
    /// The node's output, pre-formatted.
    pub output: String,
    /// How many of the 100 sample paths touched this node.
    pub affected_paths: usize,
    /// Empirical frequency of the node's "true" branch.
    pub probability: f64,
    /// Demo conditional expected payoff.
    ///
    /// These are **fixed illustrative constants**, not computed from the sample;
    /// see [`crate::path_generator::node_details`].
    pub conditional_expected_payoff: f64,
    /// Whether this node relates to a loss.
    pub is_loss_related: bool,
}

/// One generated path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationPath {
    /// Stable id, `path-001` .. `path-100`.
    pub id: String,
    /// One-based index.
    pub path_index: usize,
    /// Observation dates, one per step.
    pub dates: Vec<String>,
    /// Per-observation detail. Always `observations` long, including the frozen
    /// tail after a knock-out.
    pub observations: Vec<PathObservation>,
    /// Worst-of performance series.
    pub worst_of_performance: Vec<f64>,
    /// Coupon memory balance series.
    pub coupon_memory_balance: Vec<f64>,
    /// Whether the knock-in barrier was breached (and not superseded by a KO).
    pub knock_in_triggered: bool,
    /// Whether the path knocked out.
    pub knocked_out: bool,
    /// Observation index at which KO occurred, if any.
    pub knock_out_date_index: Option<usize>,
    /// Observation index at which KI was first breached, if any.
    pub knock_in_date_index: Option<usize>,
    /// Total undiscounted payoff.
    pub payoff: f64,
    /// Redemption component of the payoff.
    pub redemption_value: f64,
    /// Coupon component.
    pub coupon_value: f64,
    /// Down-and-in put component.
    pub put_value: f64,
    /// Memory coupon component.
    pub memory_coupon_value: f64,
    /// Settlement classification.
    pub settlement_type: SettlementType,
    /// Payoff-graph nodes this path visits, in order.
    pub traversal: Vec<PayoffNodeId>,
    /// PV attribution.
    pub attribution: PathAttribution,
    /// Per-node snapshots for all 12 nodes.
    ///
    /// The TypeScript original is a `Record<PayoffNodeId, NodeDetailSnapshot>` —
    /// a JSON **object** keyed by node label. serde cannot use an enum as a map
    /// key, so the field is a `Vec` and [`node_details_map`] converts between the
    /// two representations, always in [`PayoffNodeId::ALL`] order (which is the
    /// original key order). Each snapshot also carries its own `node_id`, so the
    /// key is redundant on the wire and is verified to agree on deserialize.
    #[serde(with = "node_details_map")]
    pub node_details: Vec<NodeDetailSnapshot>,
}

/// Converts a node-id-keyed JSON object into a deterministic `Vec`, and back.
///
/// `serde` supports deserializing a map key from a unit-variant enum, so no
/// string-keyed intermediate is needed.
mod node_details_map {
    use super::{NodeDetailSnapshot, PayoffNodeId};
    use serde::ser::SerializeMap;
    use serde::{Deserialize, Deserializer, Serializer};
    use std::collections::HashMap;

    pub(super) fn serialize<S>(snapshots: &[NodeDetailSnapshot], s: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut m = s.serialize_map(Some(snapshots.len()))?;
        for snap in snapshots {
            m.serialize_entry(snap.node_id.label(), snap)?;
        }
        m.end()
    }

    pub(super) fn deserialize<'de, D>(d: D) -> Result<Vec<NodeDetailSnapshot>, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = HashMap::<PayoffNodeId, NodeDetailSnapshot>::deserialize(d)?;
        // Re-establish the TypeScript key order, since `HashMap` iteration order
        // is arbitrary. Serialization then round-trips byte-for-byte.
        let mut out: Vec<NodeDetailSnapshot> = raw.into_values().collect();
        out.sort_by_key(|s| s.node_id.index());
        Ok(out)
    }
}

impl SimulationPath {
    /// Looks up a node snapshot by id.
    #[must_use]
    pub fn node_detail(&self, id: PayoffNodeId) -> Option<&NodeDetailSnapshot> {
        self.node_details.iter().find(|d| d.node_id == id)
    }
}

/// Population branch counts.
///
/// # `total_paths` is a display scale, not a sample size
///
/// The TypeScript original counts outcomes over 100 generated paths and then
/// scales each count by 1000 to report a fictional 100,000-path population.
/// `total_paths` is therefore `100_000` while only 100 paths were actually
/// simulated.
///
/// The struct deliberately carries **no** `samplePathCount` or `scaled` field:
/// the original object has exactly the seven fields below, and inventing extra
/// ones would break byte parity with `tests/fixtures/golden.json`. The
/// distinction is still available, non-serialized, through
/// [`SimulationBundle::sample_path_count`] and [`Self::SCALE_FACTOR`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchStats {
    /// Fictional population size the counts are scaled to (100,000).
    pub total_paths: u32,
    /// Scaled count of paths that knocked out.
    pub ko_triggered: u32,
    /// Scaled count of paths that survived to maturity.
    pub alive: u32,
    /// Scaled count of surviving paths that breached knock-in.
    pub knock_in: u32,
    /// Scaled count of surviving paths that never breached knock-in.
    pub no_knock_in: u32,
    /// Scaled count of knock-in paths settling in cash.
    pub cash_settlement: u32,
    /// Scaled count of knock-in paths settling physically.
    pub physical_delivery: u32,
}

impl BranchStats {
    /// The multiplier applied to raw sample counts: 100 sample paths are reported
    /// as 100,000.
    pub const SCALE_FACTOR: u32 = 1_000;

    /// True when the counts are scaled from the sample rather than exhaustive.
    ///
    /// Always `true` for this demo: there is no exhaustive-simulation mode.
    /// Exists as a method, not a field, to keep the serialized shape identical
    /// to the TypeScript original.
    #[must_use]
    pub fn is_scaled(&self) -> bool {
        true
    }

    /// Number of branch counts, i.e. how many separate outcomes are tracked.
    #[must_use]
    pub fn count_fields(&self) -> usize {
        6
    }
}

/// Descriptive statistics plus the raw sample.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionStats {
    /// Arithmetic mean.
    pub mean: f64,
    /// Median. For an even sample size, the mean of the two central values.
    pub median: f64,
    /// **Population** standard deviation (divides by `n`, not `n - 1`).
    pub std_dev: f64,
    /// 5th percentile, by nearest-rank on the sorted sample.
    pub p05: f64,
    /// 95th percentile.
    pub p95: f64,
    /// The raw values, in generation order.
    pub values: Vec<f64>,
}

/// The four distributions surfaced by the distribution tiles.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationDistributions {
    /// Total undiscounted payoff.
    pub total_payoff: DistributionStats,
    /// Coupon plus memory coupon.
    pub coupon_pv: DistributionStats,
    /// Down-and-in put leg.
    pub put_pv: DistributionStats,
    /// Worst-of at exit (KO date, or maturity).
    pub worst_of_final: DistributionStats,
}

/// The complete generated simulation bundle.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationBundle {
    /// Product name shown in the UI.
    pub product_name: String,
    /// Tagline shown in the UI.
    pub tagline: String,
    /// Underlying symbols.
    pub underlyings: Vec<String>,
    /// Barriers used to generate the bundle.
    pub barriers: ProductBarriers,
    /// Every generated path.
    pub paths: Vec<SimulationPath>,
    /// Population branch counts.
    pub branch_stats: BranchStats,
    /// Distribution statistics.
    pub distributions: SimulationDistributions,
}

impl SimulationBundle {
    /// Number of paths actually generated (100 in the demo fixture).
    ///
    /// Distinct from [`BranchStats::total_paths`], which is a 1,000x display
    /// scale. Not a field on [`BranchStats`] because the original object has no
    /// such field and adding one would break golden parity.
    #[must_use]
    pub fn sample_path_count(&self) -> u32 {
        u32::try_from(self.paths.len()).unwrap_or(u32::MAX)
    }

    /// Total undiscounted payoff across every generated path, summed left to
    /// right. Convenience for tests and the CLI.
    #[must_use]
    pub fn total_payoff(&self) -> f64 {
        let values: Vec<f64> = self.paths.iter().map(|p| p.payoff).collect();
        crate::jsnum::sum_ordered(&values)
    }
}

// ---------------------------------------------------------------------------
// Trade economics (UI control surface, NOT the path-generation barriers)
// ---------------------------------------------------------------------------

/// Editable trade terms from the Trade Economics panel.
///
/// Mirrors `src/store/tradeEconomicsStore.ts`. These values do **not** drive
/// path generation in Phase 1; see [`ProductBarriers`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeEconomics {
    /// Strike level.
    pub strike: f64,
    /// Knock-in barrier control.
    pub knock_in_barrier: f64,
    /// Knock-out barrier control.
    pub knock_out_barrier: f64,
    /// Lower bound of the coupon range control.
    pub coupon_lower_barrier: f64,
    /// Upper bound of the coupon range control.
    pub coupon_upper_barrier: f64,
    /// Coupon rate, **annual** convention in the cashflow module.
    pub coupon_rate: f64,
    /// Whether memory coupons apply.
    pub memory_coupon_enabled: bool,
    /// Whether settlement is physical.
    pub physical_settlement_enabled: bool,
    /// Maturity in years.
    pub maturity_years: f64,
    /// Notional.
    pub notional: f64,
}

/// The exact `DEFAULT_TRADE_ECONOMICS` constant from
/// `src/store/tradeEconomicsStore.ts`.
///
/// Named here so that adapters, the CLI and the tests all reference one value
/// rather than three copies of it. Re-exported from
/// [`crate::economics`] because that is where a caller looks for it.
pub const DEFAULT_TRADE_ECONOMICS: TradeEconomics = TradeEconomics {
    strike: 1.0,
    knock_in_barrier: 0.6,
    knock_out_barrier: 1.0,
    coupon_lower_barrier: 0.7,
    coupon_upper_barrier: 1.2,
    coupon_rate: 0.12,
    memory_coupon_enabled: true,
    physical_settlement_enabled: true,
    maturity_years: 5.0,
    notional: 100.0,
};

impl Default for TradeEconomics {
    /// The exact `DEFAULT_TRADE_ECONOMICS` constant.
    fn default() -> Self {
        DEFAULT_TRADE_ECONOMICS
    }
}

// ---------------------------------------------------------------------------
// Market snapshot (mirrors `src/store/marketDataStore.ts`)
//
// These live in `types` rather than in `risk_engine` because two modules read
// them: `risk_engine` prices `base` off the spot mean, and Phase 4's
// `valuation_explain` reads `underlyings[0].spot`, `fx_pairs[0].spot` and
// `vol.atm_vol`. Putting them behind `risk_engine` would give `valuation` a
// false dependency on the module that happens to define them first.
//
// Deliberately absent: `selectedUnderlying` / `selectedFX`. Those are UI
// selection state, not market data, and the TypeScript `computeRisk` already
// narrows them out with `Pick<MarketDataState, 'underlyings' | 'fxPairs' |
// 'correlations' | 'vol'>`.
// ---------------------------------------------------------------------------

/// One daily OHLC bar. Named `OhlcBar` to satisfy `clippy::upper_case_acronyms`;
/// the TypeScript type is `OHLCBar`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OhlcBar {
    /// `YYYY-MM-DD`.
    pub date: String,
    /// Open.
    pub open: f64,
    /// High.
    pub high: f64,
    /// Low.
    pub low: f64,
    /// Close.
    pub close: f64,
    /// Volume.
    ///
    /// `f64` for uniformity with the rest of the numeric surface, even though
    /// every producer in this repository emits integral volumes. That makes
    /// `serde_json` write `800000.0` where the frontend writes `800000`; the
    /// two are equal as parsed values, and invariant I-3 is about
    /// byte-identity *between transports*, all of which serialise through this
    /// same type.
    pub volume: f64,
}

/// One equity underlying.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Underlying {
    /// Ticker, e.g. `"AAPL"`.
    pub symbol: String,
    /// Current spot.
    pub spot: f64,
    /// Spot at the start of the study; shock buttons measure against it.
    pub baseline_spot: f64,
    /// Annual dividend yield.
    pub dividend_yield: f64,
    /// ISO currency code.
    pub currency: String,
    /// Sample daily history.
    pub historical_prices: Vec<OhlcBar>,
}

/// One FX pair.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FxPair {
    /// Pair label, e.g. `"USDSGD"`.
    pub pair: String,
    /// Current rate.
    pub spot: f64,
    /// Rate at the start of the study.
    pub baseline_spot: f64,
    /// Annualised volatility.
    pub volatility: f64,
}

/// The volatility surface parameters.
///
/// A four-number mock, not a surface: nothing in the repository interpolates
/// it. See `FEATURE.ts.md` on the mock market and vol surface.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolParams {
    /// At-the-money volatility.
    pub atm_vol: f64,
    /// Skew.
    pub skew: f64,
    /// Curvature.
    pub curvature: f64,
    /// Term slope.
    pub term_slope: f64,
}

/// The market state a computation reads.
///
/// The frontend owns market data in Phase 1 (invariant: the backend does not
/// fetch quotes), so this is a *request* payload travelling frontend → backend,
/// not a response. [`MarketSnapshot::demo`] reproduces the store's initial
/// state so that the CLI and the tests have a canonical input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSnapshot {
    /// Underlyings, in display order.
    pub underlyings: Vec<Underlying>,
    /// FX pairs, in display order.
    pub fx_pairs: Vec<FxPair>,
    /// Row-major correlation matrix.
    pub correlations: Vec<Vec<f64>>,
    /// Volatility parameters.
    pub vol: VolParams,
}

/// Number of bars [`MarketSnapshot::demo`] generates per underlying.
const DEMO_BAR_COUNT: usize = 36;

/// Port of `makeBars` in `src/store/marketDataStore.ts`.
///
/// Every price is a `toFixed(2)` result, so it goes through
/// [`crate::jsnum::js_to_fixed_f64`] rather than [`crate::jsnum::round2`]: the
/// two disagree when `x * 100` lands on a half, and the sine below produces
/// such values. `seed` is the symbol's ordinal, which is what makes the AAPL,
/// MSFT and NVDA series differ.
fn demo_bars(start: f64, seed: f64) -> Vec<OhlcBar> {
    (0..DEMO_BAR_COUNT)
        .map(|i| {
            let t = i as f64;
            let close = crate::jsnum::js_to_fixed_f64(
                start * (1.0 + (t / 4.0 + seed).sin() * 0.08 + t * 0.002),
                2,
            );
            // `open`/`high`/`low` derive from the **rounded** close, matching
            // the TypeScript, where `close` is already the `toFixed` result.
            OhlcBar {
                date: format!("2023-{:02}-01", (i % 12) + 1),
                open: crate::jsnum::js_to_fixed_f64(close * 0.99, 2),
                high: crate::jsnum::js_to_fixed_f64(close * 1.02, 2),
                low: crate::jsnum::js_to_fixed_f64(close * 0.97, 2),
                close,
                volume: 800_000.0 + t * 15_000.0,
            }
        })
        .collect()
}

impl MarketSnapshot {
    /// The store's initial state: AAPL/MSFT/NVDA, three FX pairs, a 3x3
    /// correlation matrix and a mock vol surface.
    ///
    /// This is the input behind the `risk.base` and `valuation` sections of
    /// `golden.json`.
    #[must_use]
    pub fn demo() -> Self {
        Self {
            underlyings: vec![
                Underlying {
                    symbol: "AAPL".into(),
                    spot: 185.0,
                    baseline_spot: 185.0,
                    dividend_yield: 0.005,
                    currency: "USD".into(),
                    historical_prices: demo_bars(185.0, 1.0),
                },
                Underlying {
                    symbol: "MSFT".into(),
                    spot: 420.0,
                    baseline_spot: 420.0,
                    dividend_yield: 0.007,
                    currency: "USD".into(),
                    historical_prices: demo_bars(420.0, 2.0),
                },
                Underlying {
                    symbol: "NVDA".into(),
                    spot: 122.0,
                    baseline_spot: 122.0,
                    dividend_yield: 0.001,
                    currency: "USD".into(),
                    historical_prices: demo_bars(122.0, 3.0),
                },
            ],
            fx_pairs: vec![
                FxPair {
                    pair: "USDSGD".into(),
                    spot: 1.34,
                    baseline_spot: 1.34,
                    volatility: 0.07,
                },
                FxPair {
                    pair: "EURUSD".into(),
                    spot: 1.08,
                    baseline_spot: 1.08,
                    volatility: 0.09,
                },
                FxPair {
                    pair: "USDJPY".into(),
                    spot: 151.2,
                    baseline_spot: 151.2,
                    volatility: 0.11,
                },
            ],
            correlations: vec![
                vec![1.0, 0.55, 0.48],
                vec![0.55, 1.0, 0.62],
                vec![0.48, 0.62, 1.0],
            ],
            vol: VolParams {
                atm_vol: 0.24,
                skew: -0.18,
                curvature: 0.12,
                term_slope: 0.015,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_barriers_match_typescript_constant() {
        let b = ProductBarriers::default();
        assert_eq!(b.ki_barrier, 0.7);
        assert_eq!(b.ko_barrier, 1.0);
        assert_eq!(b.coupon_lower, 0.75);
        assert_eq!(b.coupon_upper, 1.0);
        assert_eq!(b.coupon_rate, 0.008);
        assert_eq!(b.notional, 100.0);
    }

    #[test]
    fn default_trade_economics_match_typescript_constant() {
        let t = TradeEconomics::default();
        assert_eq!(t.strike, 1.0);
        assert_eq!(t.knock_in_barrier, 0.6);
        assert_eq!(t.knock_out_barrier, 1.0);
        assert_eq!(t.coupon_lower_barrier, 0.7);
        assert_eq!(t.coupon_upper_barrier, 1.2);
        assert_eq!(t.coupon_rate, 0.12);
        assert!(t.memory_coupon_enabled);
        assert!(t.physical_settlement_enabled);
        assert_eq!(t.maturity_years, 5.0);
        assert_eq!(t.notional, 100.0);
    }

    #[test]
    fn barriers_and_trade_economics_deliberately_differ() {
        // Locked in by design: paths are generated from ProductBarriers while
        // the UI edits TradeEconomics. Merging them would silently change every
        // generated path. See `PHASE1_MIGRATION_PROMPT.md` section 3.
        let b = ProductBarriers::default();
        let t = TradeEconomics::default();
        assert_ne!(b.ki_barrier, t.knock_in_barrier);
        assert_ne!(b.coupon_lower, t.coupon_lower_barrier);
        assert_ne!(b.coupon_upper, t.coupon_upper_barrier);
        assert_ne!(b.coupon_rate, t.coupon_rate); // monthly vs annual convention
    }

    #[test]
    fn payoff_node_id_serializes_to_pascal_case_labels() {
        for id in PayoffNodeId::ALL {
            let json = serde_json::to_string(&id).unwrap();
            assert_eq!(json, format!("\"{}\"", id.label()));
        }
        assert_eq!(
            serde_json::to_string(&PayoffNodeId::GlobalKOGate).unwrap(),
            "\"GlobalKOGate\""
        );
        assert_eq!(
            serde_json::to_string(&PayoffNodeId::AggregatePV).unwrap(),
            "\"AggregatePV\""
        );
    }

    #[test]
    fn settlement_type_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&SettlementType::Cash).unwrap(),
            "\"cash\""
        );
        assert_eq!(
            serde_json::to_string(&SettlementType::Physical).unwrap(),
            "\"physical\""
        );
        assert_eq!(
            serde_json::to_string(&SettlementType::None).unwrap(),
            "\"none\""
        );
    }

    #[test]
    fn settlement_type_deserializes_lowercase() {
        let s: SettlementType = serde_json::from_str("\"physical\"").unwrap();
        assert_eq!(s, SettlementType::Physical);
    }

    #[test]
    fn barriers_serialize_camel_case() {
        let json = serde_json::to_string(&ProductBarriers::default()).unwrap();
        for key in [
            "kiBarrier",
            "koBarrier",
            "couponLower",
            "couponUpper",
            "couponRate",
            "notional",
        ] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "missing {key} in {json}"
            );
        }
        assert!(!json.contains("ki_barrier"), "{json}");
    }

    #[test]
    fn trade_economics_serialize_camel_case() {
        let json = serde_json::to_string(&TradeEconomics::default()).unwrap();
        for key in [
            "strike",
            "knockInBarrier",
            "knockOutBarrier",
            "couponLowerBarrier",
            "couponUpperBarrier",
            "couponRate",
            "memoryCouponEnabled",
            "physicalSettlementEnabled",
            "maturityYears",
            "notional",
        ] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "missing {key} in {json}"
            );
        }
    }

    #[test]
    fn observation_serialize_camel_case() {
        let o = PathObservation {
            date: "2024-01-15".into(),
            date_index: 0,
            aapl: 1.0,
            msft: 1.0,
            nvda: 1.0,
            worst_of_performance: 1.0,
            coupon_accrued: 0.0,
            coupon_memory_balance: 0.0,
            knock_in_at_date: false,
            knock_out_at_date: false,
        };
        let json = serde_json::to_string(&o).unwrap();
        for key in [
            "date",
            "dateIndex",
            "aapl",
            "msft",
            "nvda",
            "worstOfPerformance",
            "couponAccrued",
            "couponMemoryBalance",
            "knockInAtDate",
            "knockOutAtDate",
        ] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "missing {key} in {json}"
            );
        }
    }

    #[test]
    fn attribution_total_uses_documented_left_to_right_order() {
        let a = PathAttribution {
            par_redemption: 100.0,
            coupon: 0.8,
            memory_coupon: 0.16,
            down_and_in_put: -5.0,
            funding: -2.0,
            discounting: -1.5,
            total_pv: 0.0,
        };
        // 100 + 0.8 + 0.16 - 5 - 2 - 1.5 = 92.46
        assert_eq!(a.compute_total(), 92.46);
    }

    #[test]
    fn attribution_total_summation_order_is_pinned() {
        // Canonical order sums to 2.1000000000000000888; the reordered pair below
        // sums to 2.0999999999999996447. Both round to 2.1 at 2dp, but the
        // pre-rounding f64 differs, proving `compute_total` is order-sensitive
        // and that the golden fixture genuinely constrains summation order.
        //
        // (108 of the 720 orderings of these six values differ from canonical,
        // so this is systematic rather than a lucky pair.)
        let canonical = PathAttribution {
            par_redemption: 0.1,
            coupon: 0.2,
            memory_coupon: 0.3,
            down_and_in_put: 0.4,
            funding: 0.5,
            discounting: 0.6,
            total_pv: 0.0,
        };
        // Move memory_coupon(0.3) and down_and_in_put(0.4) to the tail.
        let reordered = PathAttribution {
            par_redemption: 0.1,
            coupon: 0.2,
            memory_coupon: 0.5,
            down_and_in_put: 0.6,
            funding: 0.4,
            discounting: 0.3,
            total_pv: 0.0,
        };

        // Both round to 2.1 at 2dp ...
        assert_eq!(canonical.compute_total(), 2.1);
        assert_eq!(reordered.compute_total(), 2.1);

        // ... but the pre-rounding f64 sums genuinely differ.
        let raw = |a: &PathAttribution| {
            crate::jsnum::sum_ordered(&[
                a.par_redemption,
                a.coupon,
                a.memory_coupon,
                a.down_and_in_put,
                a.funding,
                a.discounting,
            ])
        };
        assert_eq!(raw(&canonical), 2.100_000_000_000_000_088_8);
        assert_eq!(raw(&reordered), 2.099_999_999_999_999_644_7);
        assert_ne!(raw(&canonical), raw(&reordered));
    }

    #[test]
    fn node_details_serialize_as_a_node_id_keyed_object() {
        // The TypeScript original is `Record<PayoffNodeId, NodeDetailSnapshot>`,
        // i.e. a JSON object keyed by PascalCase label. `node_details_map`
        // reproduces that exactly, in `PayoffNodeId::ALL` order.
        let mut p = stub_path();
        p.node_details = vec![stub_node_detail(PayoffNodeId::PathCube)];

        let json = serde_json::to_string(&p).unwrap();
        assert!(
            json.contains(r#""nodeDetails":{"PathCube":{"nodeId":"PathCube""#),
            "nodeDetails must serialize as an object keyed by node label: {json}"
        );
        assert!(
            !json.contains(r#""nodeDetails":["#),
            "must not be an array: {json}"
        );
        for key in ["knockInTriggered", "knockOutDateIndex", "settlementType"] {
            assert!(
                json.contains(&format!("\"{key}\"")),
                "missing {key} in {json}"
            );
        }
    }

    #[test]
    fn node_details_deserialize_from_a_node_id_keyed_object() {
        let raw = r#"{
            "id":"path-001","pathIndex":1,
            "dates":[],"observations":[],"worstOfPerformance":[],"couponMemoryBalance":[],
            "knockInTriggered":false,"knockedOut":false,"knockOutDateIndex":null,
            "knockInDateIndex":null,"payoff":0,"redemptionValue":0,"couponValue":0,
            "putValue":0,"memoryCouponValue":0,"settlementType":"none","traversal":[],
            "attribution":{"parRedemption":0,"coupon":0,"memoryCoupon":0,"downAndInPut":0,
                           "funding":0,"discounting":0,"totalPv":0},
            "nodeDetails":{
              "AggregatePV":{"nodeId":"AggregatePV","name":"n","description":"d",
                "inputValue":"i","decisionRule":"r","output":"o","affectedPaths":100,
                "probability":1,"conditionalExpectedPayoff":96,"isLossRelated":false},
              "PathCube":{"nodeId":"PathCube","name":"n","description":"d",
                "inputValue":"i","decisionRule":"r","output":"o","affectedPaths":100,
                "probability":1,"conditionalExpectedPayoff":96,"isLossRelated":false}
            }
        }"#;
        let p: SimulationPath = serde_json::from_str(raw).unwrap();

        // Deliberately supplied out of order; `ALL` order must be restored so
        // serialization is byte-stable regardless of input key order.
        assert_eq!(p.node_details.len(), 2);
        assert_eq!(p.node_details[0].node_id, PayoffNodeId::PathCube);
        assert_eq!(p.node_details[1].node_id, PayoffNodeId::AggregatePV);

        let json = serde_json::to_string(&p).unwrap();
        let cube = json
            .find(r#""PathCube":{"nodeId"#)
            .expect("PathCube present");
        let agg = json
            .find(r#""AggregatePV":{"nodeId"#)
            .expect("AggregatePV present");
        assert!(cube < agg, "keys must serialize in ALL order");
    }

    #[test]
    fn node_detail_lookup_by_id() {
        let mut p = stub_path();
        p.node_details = vec![
            stub_node_detail(PayoffNodeId::PathCube),
            stub_node_detail(PayoffNodeId::Discount),
        ];
        assert_eq!(
            p.node_detail(PayoffNodeId::Discount).unwrap().node_id,
            PayoffNodeId::Discount
        );
        assert!(p.node_detail(PayoffNodeId::Redemption).is_none());
    }

    #[test]
    fn payoff_node_index_and_label_round_trip() {
        for (i, id) in PayoffNodeId::ALL.into_iter().enumerate() {
            assert_eq!(id.index(), i, "{id} has the wrong ALL index");
            assert_eq!(PayoffNodeId::from_label(id.label()), Some(id));
        }
        assert_eq!(PayoffNodeId::from_label("global_ko_gate"), None);
        assert_eq!(PayoffNodeId::from_label("Nope"), None);
    }

    /// Minimal valid `SimulationPath` for tests that only care about one field.
    fn stub_path() -> SimulationPath {
        SimulationPath {
            id: "path-001".into(),
            path_index: 1,
            dates: vec!["2024-01-15".into()],
            observations: vec![],
            worst_of_performance: vec![],
            coupon_memory_balance: vec![],
            knock_in_triggered: false,
            knocked_out: false,
            knock_out_date_index: None,
            knock_in_date_index: None,
            payoff: 0.0,
            redemption_value: 0.0,
            coupon_value: 0.0,
            put_value: 0.0,
            memory_coupon_value: 0.0,
            settlement_type: SettlementType::None,
            traversal: vec![],
            attribution: PathAttribution {
                par_redemption: 0.0,
                coupon: 0.0,
                memory_coupon: 0.0,
                down_and_in_put: 0.0,
                funding: 0.0,
                discounting: 0.0,
                total_pv: 0.0,
            },
            node_details: vec![],
        }
    }

    /// Minimal valid `NodeDetailSnapshot`.
    fn stub_node_detail(node_id: PayoffNodeId) -> NodeDetailSnapshot {
        NodeDetailSnapshot {
            node_id,
            name: node_id.label().to_string(),
            description: "d".into(),
            input_value: "i".into(),
            decision_rule: "r".into(),
            output: "o".into(),
            affected_paths: 100,
            probability: 1.0,
            conditional_expected_payoff: 96.0,
            is_loss_related: false,
        }
    }

    #[test]
    fn simulation_bundle_exposes_sample_size_separately_from_total_paths() {
        let mut b = stub_bundle();
        b.branch_stats = BranchStats {
            total_paths: 100_000,
            ko_triggered: 67_000,
            alive: 33_000,
            knock_in: 19_000,
            no_knock_in: 14_000,
            cash_settlement: 12_000,
            physical_delivery: 7_000,
        };
        assert_eq!(b.sample_path_count(), 0);
        b.paths = vec![stub_path(), stub_path()];
        assert_eq!(b.sample_path_count(), 2);

        // The 1,000x relationship is a property of the *demo* fixture (100 paths
        // reported as 100,000), not of any bundle. Asserting it on a 2-path stub
        // would be meaningless; the golden fixture pins the real case, and
        // `dependency_hygiene` checks the partition identities there.
        assert_eq!(BranchStats::SCALE_FACTOR, 1_000);
        assert_eq!(100 * BranchStats::SCALE_FACTOR, b.branch_stats.total_paths);
        assert_eq!(b.total_payoff(), 0.0);
    }

    /// Minimal valid `SimulationBundle`.
    fn stub_bundle() -> SimulationBundle {
        SimulationBundle {
            product_name: "p".into(),
            tagline: "t".into(),
            underlyings: vec![],
            barriers: ProductBarriers::default(),
            paths: vec![],
            branch_stats: BranchStats {
                total_paths: 0,
                ko_triggered: 0,
                alive: 0,
                knock_in: 0,
                no_knock_in: 0,
                cash_settlement: 0,
                physical_delivery: 0,
            },
            distributions: SimulationDistributions {
                total_payoff: DistributionStats {
                    mean: 0.0,
                    median: 0.0,
                    std_dev: 0.0,
                    p05: 0.0,
                    p95: 0.0,
                    values: vec![],
                },
                coupon_pv: DistributionStats {
                    mean: 0.0,
                    median: 0.0,
                    std_dev: 0.0,
                    p05: 0.0,
                    p95: 0.0,
                    values: vec![],
                },
                put_pv: DistributionStats {
                    mean: 0.0,
                    median: 0.0,
                    std_dev: 0.0,
                    p05: 0.0,
                    p95: 0.0,
                    values: vec![],
                },
                worst_of_final: DistributionStats {
                    mean: 0.0,
                    median: 0.0,
                    std_dev: 0.0,
                    p05: 0.0,
                    p95: 0.0,
                    values: vec![],
                },
            },
        }
    }

    #[test]
    fn branch_stats_has_exactly_the_seven_original_fields() {
        // Guards against the parity bug where an extra field was invented here.
        // The golden fixture's branchStats object is the contract.
        let b = BranchStats {
            total_paths: 100_000,
            ko_triggered: 67_000,
            alive: 33_000,
            knock_in: 19_000,
            no_knock_in: 14_000,
            cash_settlement: 12_000,
            physical_delivery: 7_000,
        };
        let json = serde_json::to_string(&b).unwrap();
        assert_eq!(
            json,
            r#"{"totalPaths":100000,"koTriggered":67000,"alive":33000,"knockIn":19000,"noKnockIn":14000,"cashSettlement":12000,"physicalDelivery":7000}"#
        );
        // Field ORDER matters: it must match the TypeScript declaration order,
        // because JSON.stringify preserves it and the fixture is compared as a
        // parsed value but consumers may diff the raw text.
        assert_eq!(json.matches("totalPaths").count(), 1);
    }

    #[test]
    fn branch_stats_exposes_sample_size_and_scaling_as_methods_not_fields() {
        let b = BranchStats {
            total_paths: 100_000,
            ko_triggered: 67_000,
            alive: 33_000,
            knock_in: 19_000,
            no_knock_in: 14_000,
            cash_settlement: 12_000,
            physical_delivery: 7_000,
        };
        assert!(b.is_scaled());
        assert_eq!(BranchStats::SCALE_FACTOR, 1_000);
        // The scale factor is what turns 100 sampled paths into 100,000.
        assert_eq!(100 * BranchStats::SCALE_FACTOR, b.total_paths);
        assert_eq!(b.count_fields(), 6);
        // `no_knock_in` + `knock_in` must partition `alive`, and cash +
        // physical must partition `knock_in`. These identities hold in the
        // golden fixture and are worth asserting on any future bundle.
        assert_eq!(b.no_knock_in + b.knock_in, b.alive);
        assert_eq!(b.cash_settlement + b.physical_delivery, b.knock_in);
        assert_eq!(b.ko_triggered + b.alive, b.total_paths);
    }

    #[test]
    fn payoff_node_all_has_twelve_unique_entries() {
        assert_eq!(PayoffNodeId::ALL.len(), 12);
        let mut seen = std::collections::HashSet::new();
        for id in PayoffNodeId::ALL {
            assert!(seen.insert(id), "duplicate node id {id}");
        }
    }

    // -----------------------------------------------------------------------
    // Market snapshot
    // -----------------------------------------------------------------------

    /// The demo snapshot is the input behind `golden.json`'s `risk.base` and
    /// `valuation` sections, so its shape is pinned rather than incidental.
    #[test]
    fn demo_market_matches_the_store_defaults() {
        let m = MarketSnapshot::demo();
        assert_eq!(
            m.underlyings
                .iter()
                .map(|u| u.symbol.as_str())
                .collect::<Vec<_>>(),
            ["AAPL", "MSFT", "NVDA"]
        );
        let spots: Vec<f64> = m.underlyings.iter().map(|u| u.spot).collect();
        assert_eq!(spots, [185.0, 420.0, 122.0]);
        // `spot == baseline_spot` initially: the shock buttons are no-ops until
        // the user moves a spot.
        for u in &m.underlyings {
            assert_eq!(
                u.spot, u.baseline_spot,
                "{} must start at baseline",
                u.symbol
            );
            assert_eq!(u.currency, "USD");
        }
        assert_eq!(m.underlyings[0].dividend_yield, 0.005);
        assert_eq!(m.underlyings[1].dividend_yield, 0.007);
        assert_eq!(m.underlyings[2].dividend_yield, 0.001);

        assert_eq!(
            m.fx_pairs
                .iter()
                .map(|p| p.pair.as_str())
                .collect::<Vec<_>>(),
            ["USDSGD", "EURUSD", "USDJPY"]
        );
        let fx: Vec<f64> = m.fx_pairs.iter().map(|p| p.spot).collect();
        assert_eq!(fx, [1.34, 1.08, 151.2]);
        for p in &m.fx_pairs {
            assert_eq!(p.spot, p.baseline_spot, "{} must start at baseline", p.pair);
        }
        assert_eq!(m.fx_pairs[0].volatility, 0.07);
        assert_eq!(m.fx_pairs[1].volatility, 0.09);
        assert_eq!(m.fx_pairs[2].volatility, 0.11);

        assert_eq!(
            m.correlations,
            vec![
                vec![1.0, 0.55, 0.48],
                vec![0.55, 1.0, 0.62],
                vec![0.48, 0.62, 1.0]
            ]
        );
        assert_eq!(
            m.vol,
            VolParams {
                atm_vol: 0.24,
                skew: -0.18,
                curvature: 0.12,
                term_slope: 0.015
            }
        );
    }

    /// The mean spot that drives `risk.base`'s `pv` is `727 / 3`.
    #[test]
    fn demo_market_mean_spot_is_the_risk_engine_reference_plus_one_third() {
        let m = MarketSnapshot::demo();
        let mean =
            crate::jsnum::sum_ordered(&m.underlyings.iter().map(|u| u.spot).collect::<Vec<_>>())
                / 3.0;
        assert_eq!(mean, 242.333_333_333_333_34);
        assert!(mean > 242.0 && mean < 242.5);
    }

    /// `makeBars` is a pure function of `(start, seed)`, so the demo history is
    /// reproducible and the three series differ only by their seed.
    #[test]
    fn demo_bars_are_reproducible_and_seed_dependent() {
        let m = MarketSnapshot::demo();
        for u in &m.underlyings {
            assert_eq!(u.historical_prices.len(), DEMO_BAR_COUNT);
            assert_eq!(
                demo_bars(u.historical_prices[0].close, 1.0).len(),
                DEMO_BAR_COUNT
            );
        }
        let aapl_close: Vec<f64> = m.underlyings[0]
            .historical_prices
            .iter()
            .map(|b| b.close)
            .collect();
        let msft_close: Vec<f64> = m.underlyings[1]
            .historical_prices
            .iter()
            .map(|b| b.close)
            .collect();
        assert_ne!(aapl_close, msft_close, "seeds 1 and 2 must differ");
        assert_eq!(demo_bars(185.0, 1.0)[5].close, aapl_close[5]);
    }

    /// Every generated price is a 2-decimal value, because `makeBars` applies
    /// `toFixed(2)` to all four of open/high/low/close. Re-formatting at 2
    /// places must be a no-op, which proves the value really is a 2dp decimal
    /// rather than merely formatted as one.
    #[test]
    fn demo_bars_are_all_two_decimal_values() {
        for u in &MarketSnapshot::demo().underlyings {
            for bar in &u.historical_prices {
                for v in [bar.open, bar.high, bar.low, bar.close] {
                    assert_eq!(
                        crate::jsnum::js_to_fixed_f64(v, 2),
                        v,
                        "{}/{} is not a 2dp value: {v:?}",
                        u.symbol,
                        bar.date
                    );
                }
            }
        }
    }

    /// `open`, `high` and `low` are derived from the **rounded** close, not the
    /// unrounded one, so `high >= close >= low` holds exactly.
    #[test]
    fn demo_bars_are_internally_consistent() {
        for u in &MarketSnapshot::demo().underlyings {
            for bar in &u.historical_prices {
                assert!(
                    bar.high >= bar.close,
                    "{}/{} high < close",
                    u.symbol,
                    bar.date
                );
                assert!(
                    bar.close >= bar.low,
                    "{}/{} close < low",
                    u.symbol,
                    bar.date
                );
                assert!(
                    bar.high >= bar.open,
                    "{}/{} high < open",
                    u.symbol,
                    bar.date
                );
                assert!(bar.open >= bar.low, "{}/{} open < low", u.symbol, bar.date);
            }
        }
    }

    /// Dates wrap `i % 12` over 2023, so the series repeats months across three
    /// years while `volume` climbs monotonically.
    #[test]
    fn demo_bar_dates_and_volumes_follow_the_generator() {
        let m = MarketSnapshot::demo();
        for (i, bar) in m.underlyings[0].historical_prices.iter().enumerate() {
            assert_eq!(bar.date, format!("2023-{:02}-01", (i % 12) + 1), "bar {i}");
            assert_eq!(bar.volume, 800_000.0 + i as f64 * 15_000.0, "bar {i}");
        }
        let vols: Vec<f64> = m.underlyings[0]
            .historical_prices
            .iter()
            .map(|b| b.volume)
            .collect();
        assert!(vols.windows(2).all(|w| w[1] > w[0]), "volume must climb");
    }

    #[test]
    fn market_snapshot_round_trips_through_json() {
        let m = MarketSnapshot::demo();
        let json = serde_json::to_string(&m).unwrap();
        assert_eq!(serde_json::from_str::<MarketSnapshot>(&json).unwrap(), m);
    }

    #[test]
    fn market_types_serialise_camel_case() {
        let m = MarketSnapshot::demo();
        let json = serde_json::to_string(&m).unwrap();
        for key in [
            "\"underlyings\"",
            "\"baselineSpot\"",
            "\"dividendYield\"",
            "\"historicalPrices\"",
            "\"fxPairs\"",
            "\"correlations\"",
            "\"atmVol\"",
            "\"termSlope\"",
            "\"pair\"",
            "\"volatility\"",
            "\"volume\"",
        ] {
            assert!(json.contains(key), "{key} missing from {json}");
        }
        // The TypeScript names are all lower-camel on the wire, so no snake_case
        // key may appear.
        assert!(
            !json.contains("baseline_spot")
                && !json.contains("atm_vol")
                && !json.contains("historical_prices"),
            "snake_case key leaked into the wire format"
        );
    }
}
