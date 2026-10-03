//! Valuation: cashflows, Taylor/PLVA explain and the explain ledger.
//!
//! Port of three stores:
//!
//! - `src/store/cashflowStore.ts` → [`build_cashflows`], [`cashflow_analytics`]
//! - `src/store/valuationExplainStore.ts` → [`valuation_explain`]
//! - `src/store/explainLedgerStore.ts` → [`explain_ledger`]
//!
//! All three are pure functions of their inputs — the only non-determinism in
//! the TypeScript is the ledger's `new Date().toISOString().slice(0, 10)`, which
//! is injected here as `as_of` so every entry stays a pure function of `(explain,
//! cash, as_of)` and is byte-for-byte reproducible.
//!
//! # The `toFixed` idiom runs all the way through here
//!
//! `build_cashflows` formats three values per row, each through the unary `+`
//! wrapper, so all six of Phase 3's `js_to_fixed_f64` lessons apply. Note
//! especially:
//!
//! - `amount` is `+(...).toFixed(2)`, **not** [`crate::jsnum::round2`]. The two
//!   would agree on every row of the demo cashflow (none sits on a 2dp tie), but
//!   the contract is `toFixed`, and the whole point of the corpus is that the
//!   difference is only ever caught when it bites.
//! - `discountFactor` is `+(...).toFixed(4)` — the **first** 4-decimal site in
//!   the port. The toFixed corpus previously had no 4-decimal entries at all, so
//!   `extend-tofixed-cases.mjs` gained a 4dp tie sweep in Phase 4;
//!   `tests/tofixed_conformance.rs` covers the 60 demo discount factors.
//! - `presentValue` is `+(amount * df).toFixed(2)` with `df` already rounded to
//!   4 places. The spec's pseudocode says "uses the ROUNDED df", and it does;
//!   `present_value_uses_the_rounded_discount_factor` proves the alternative
//!   differs on at least one row.
//!
//! # The Taylor sum is the same order-pinned sum as Phase 1
//!
//! `taylor.predicted` is `delta + gamma + vega + fx + rates + correlation +
//! dividend + theta` in exactly that order — the same eight-term canonical sum
//! (`1.6860000000000004`) that `jsnum::sum_ordered` pins for `PathAttribution`.
//! Phase 1's test showed 38,622 of the 40,320 reorderings change the answer;
//! `predicted_summation_order_is_pinned` re-checks it from here.
//!
//! # Ledger fields that look wrong are faithful
//!
//! - `total_risk` is always `0.0` — there are no risk entries in the source, and
//!   the reconciliation still sums the (empty) risk bucket.
//! - `explained` omits `taylor.residual` (`0.12`), so an entry's contributions
//!   never reconcile to `total_pnl` by themselves — the residual is the
//!   difference on purpose.
//!
//! Both are documented in the TypeScript and preserved verbatim; see
//! `FEATURES.md` §4.3 and Appendix E.

use crate::jsnum::{js_to_fixed_f64, sum_ordered};
use crate::types::{MarketSnapshot, SimulationPath, TradeEconomics};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Cashflows (`cashflowStore.ts`)
// ---------------------------------------------------------------------------

/// One cashflow row, mirroring the TypeScript union exactly.
///
/// The field is `kind` in Rust and `type` on the wire, because `type` is a
/// keyword; the serde rename keeps the JSON byte-identical with the store.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cashflow {
    /// `cf-{i}`.
    pub id: String,
    /// Observation date, verbatim from `path.dates`.
    pub date: String,
    /// `coupon`, `physical_delivery` or `redemption` here; the enum carries the
    /// full TypeScript union because `cash_settlement` and `funding` are
    /// produced by other modules in the codebase.
    #[serde(rename = "type")]
    pub kind: CashflowType,
    /// Undiscounted amount; the final row is the notional.
    pub amount: f64,
    /// Always `"USD"` — a literal in the store, not a market lookup.
    pub currency: String,
    /// `0.98` for the final maturity row, `0.85` otherwise.
    pub probability: f64,
    /// `+(1 / 1.04 ** ((i + 1) / 12)).toFixed(4)`, a literal curve.
    pub discount_factor: f64,
    /// `+(amount * discount_factor).toFixed(2)` — the **rounded** df.
    pub present_value: f64,
    /// `i < 2`, i.e. exactly the first two rows.
    pub realized: bool,
}

/// The TypeScript `CashflowType` union, strings verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CashflowType {
    /// Monthly coupon leg.
    Coupon,
    /// Terminal redemption at par.
    Redemption,
    /// Cash-settled knock-in payoff.
    CashSettlement,
    /// Physically delivered knock-in payoff.
    PhysicalDelivery,
    /// Funding leg — produced by other modules, part of the shared union.
    Funding,
}

/// The aggregates `useCashflowAnalytics` computes.
///
/// The store also returns the `cashflows` and the `path` it was called with;
/// both are dropped here because they are trivially recoverable from the
/// arguments (`build_cashflows` reproduces the former) and identical to one of
/// them (the latter). Nothing downstream reads them from the analytics object.
///
/// The `*.PnL` fields carry explicit renames: `serde`'s naive camelCase would
/// write `realizedPnl`, and the frontend's object literal says `realizedPnL`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CashflowAnalytics {
    /// `Σ amounts`, left to right, unrounded.
    pub gross_cashflow: f64,
    /// `Σ present_values`, left to right, unrounded.
    pub present_value: f64,
    /// `Σ amounts` over realized rows (the first two).
    pub realized: f64,
    /// `gross_cashflow - realized`.
    pub future: f64,
    /// `realized - notional * 0.02`.
    #[serde(rename = "realizedPnL")]
    pub realized_pnl: f64,
    /// `= mtm_pnl`: the present-value mark.
    #[serde(rename = "unrealizedPnL")]
    pub unrealized_pnl: f64,
    /// `present_value - notional`.
    #[serde(rename = "mtmPnL")]
    pub mtm_pnl: f64,
    /// `realized * 0.02 + coupon_rate * notional`.
    #[serde(rename = "carryPnL")]
    pub carry_pnl: f64,
    /// `= mtm_pnl + carry_pnl`.
    #[serde(rename = "totalPnL")]
    pub total_pnl: f64,
}

/// `path.dates.map(...)` from `cashflowStore.ts`, verbatim.
///
/// Iterates `path.dates`, indexing `path.observations[i]` exactly as the
/// TypeScript does, so a path whose `dates` are shorter than its `observations`
/// (the knocked-out shape) works, and one whose `observations` are shorter
/// panics in Rust exactly where it throws in TypeScript.
#[must_use]
pub fn build_cashflows(path: &SimulationPath, trade: &TradeEconomics) -> Vec<Cashflow> {
    path.dates
        .iter()
        .enumerate()
        .map(|(i, date)| {
            let final_row = i == path.dates.len() - 1;
            let amount = if final_row {
                trade.notional
            } else {
                js_to_fixed_f64(
                    trade.notional * trade.coupon_rate / 12.0
                        * if path.observations[i].coupon_accrued > 0.0 {
                            1.0
                        } else {
                            0.0
                        },
                    2,
                )
            };
            let discount_factor = js_to_fixed_f64(1.0 / 1.04_f64.powf((i as f64 + 1.0) / 12.0), 4);
            Cashflow {
                id: format!("cf-{i}"),
                date: date.clone(),
                kind: if final_row {
                    if trade.physical_settlement_enabled {
                        CashflowType::PhysicalDelivery
                    } else {
                        CashflowType::Redemption
                    }
                } else {
                    CashflowType::Coupon
                },
                amount,
                currency: "USD".to_string(),
                probability: if final_row { 0.98 } else { 0.85 },
                discount_factor,
                present_value: js_to_fixed_f64(amount * discount_factor, 2),
                realized: i < 2,
            }
        })
        .collect()
}

/// The `useCashflowAnalytics` arithmetic, as a pure function.
#[must_use]
pub fn cashflow_analytics(path: &SimulationPath, trade: &TradeEconomics) -> CashflowAnalytics {
    let cashflows = build_cashflows(path, trade);
    let gross_cashflow = cashflows.iter().fold(0.0, |s, c| s + c.amount);
    let present_value = cashflows.iter().fold(0.0, |s, c| s + c.present_value);
    let realized = cashflows
        .iter()
        .filter(|c| c.realized)
        .fold(0.0, |s, c| s + c.amount);
    let future = gross_cashflow - realized;
    let carry = realized * 0.02 + trade.coupon_rate * trade.notional;
    let mtm = present_value - trade.notional;
    CashflowAnalytics {
        gross_cashflow,
        present_value,
        realized,
        future,
        realized_pnl: realized - trade.notional * 0.02,
        unrealized_pnl: mtm,
        mtm_pnl: mtm,
        carry_pnl: carry,
        total_pnl: mtm + carry,
    }
}

// ---------------------------------------------------------------------------
// Valuation explain (`valuationExplainStore.ts`)
// ---------------------------------------------------------------------------

/// The Taylor explain terms. All raw floats, none rounded.
///
/// `predicted` is filled in [`valuation_explain`] *after* the struct literal,
/// exactly like the store mutates `taylor.predicted` after construction, because
/// the sum must read the member values in the pinned order.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaylorExplain {
    /// `underlyings[0]?.spot ?? 100` × 0.006.
    pub delta: f64,
    /// Literal `0.42`.
    pub gamma: f64,
    /// `vol.atm_vol` × 1.2.
    pub vega: f64,
    /// `fx_pairs[0]?.spot ?? 1` × 0.2.
    pub fx: f64,
    /// Literal `-0.18`.
    pub rates: f64,
    /// Literal `0.24`.
    pub correlation: f64,
    /// Literal `-0.11`.
    pub dividend: f64,
    /// Literal `-0.35`.
    pub theta: f64,
    /// The eight terms summed in the pinned order — `1.6860000000000004` for the
    /// demo market. See the module docs.
    pub predicted: f64,
    /// Literal `0.12`, **not** part of `predicted`. The ledger's residual is the
    /// difference between `total_pnl` and the explained contributions *because*
    /// this is omitted.
    pub residual: f64,
}

/// One PLVA row. A fixed four-row literal table, not market data.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlvaContribution {
    /// Display category, e.g. `"Volatility Calibration"`.
    pub category: String,
    /// Value before the methodology change.
    pub old_value: f64,
    /// Value after the methodology change.
    pub new_value: f64,
    /// Contribution to P&L, in `{category}` units.
    pub contribution: f64,
}

/// The `ValuationExplainState` object the store returns, with **raw** floats —
/// `total_pnl` is `94.89 - 93.09 = 1.7999999999999972` in IEEE-754, and that is
/// what is emitted, not `1.8`.
///
/// The `PV`/`PnL` acronym fields carry explicit renames; serde's naive
/// camelCase would write `previousPv` / `plvaPnl`, and the frontend's object
/// literal says `previousPV` / `plvaPnL`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValuationExplainState {
    /// `current_pv - 1.8`.
    #[serde(rename = "previousPV")]
    pub previous_pv: f64,
    /// `= cash.present_value`.
    #[serde(rename = "currentPV")]
    pub current_pv: f64,
    /// `= taylor.predicted`.
    #[serde(rename = "marketExplainedPnL")]
    pub market_explained_pnl: f64,
    /// `Σ plva contributions` — `1.0000000000000002` for the demo, unrounded.
    #[serde(rename = "plvaPnL")]
    pub plva_pnl: f64,
    /// `total_pnl - market_explained_pnl - plva_pnl`.
    #[serde(rename = "residualPnL")]
    pub residual_pnl: f64,
    /// `current_pv - previous_pv`.
    #[serde(rename = "totalPnL")]
    pub total_pnl: f64,
}

/// The whole `useValuationExplain` return value, minus the `trade` it also
/// carries (which the caller already has).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValuationExplain {
    /// `current_pv - 1.8`.
    #[serde(rename = "previousPV")]
    pub previous_pv: f64,
    /// `= cash.present_value`.
    #[serde(rename = "currentPV")]
    pub current_pv: f64,
    /// The nine Taylor explain terms.
    pub taylor: TaylorExplain,
    /// The four PLVA rows, literal.
    pub plva: Vec<PlvaContribution>,
    /// The unrounded four-contribution sum (`1.0000000000000002` for the demo).
    #[serde(rename = "plvaPnL")]
    pub plva_pnl: f64,
    /// The six-field state object the UI renders.
    pub state: ValuationExplainState,
}

/// The four PLVA rows, literally.
///
/// The sum [`ValuationExplainState::plva_pnl`] is deliberately **not** equal to
/// the mathematical `1.0`: `0.8 + 0.3 - 0.2 + 0.1` is `1.0000000000000002` in
/// IEEE-754, and the frontend emits that raw double. Reproducing it is the
/// point, not repairing it.
fn plva_table() -> Vec<PlvaContribution> {
    vec![
        PlvaContribution {
            category: "Volatility Calibration".to_string(),
            old_value: 24.1,
            new_value: 24.8,
            contribution: 0.8,
        },
        PlvaContribution {
            category: "Correlation Calibration".to_string(),
            old_value: 0.62,
            new_value: 0.65,
            contribution: 0.3,
        },
        PlvaContribution {
            category: "Funding Curve Update".to_string(),
            old_value: 4.1,
            new_value: 4.2,
            contribution: -0.2,
        },
        PlvaContribution {
            category: "Reserve Update".to_string(),
            old_value: 1.2,
            new_value: 1.3,
            contribution: 0.1,
        },
    ]
}

/// `useValuationExplain`, as a pure function of the cashflow analytics and the
/// market.
#[must_use]
pub fn valuation_explain(cash: &CashflowAnalytics, market: &MarketSnapshot) -> ValuationExplain {
    let previous_pv = cash.present_value - 1.8;

    // `?? 100` / `?? 1`: the store falls back when an array is empty; kept even
    // though the demo market always has three underlyings and three FX pairs.
    let mut taylor = TaylorExplain {
        delta: market.underlyings.first().map_or(100.0, |u| u.spot) * 0.006,
        gamma: 0.42,
        vega: market.vol.atm_vol * 1.2,
        fx: market.fx_pairs.first().map_or(1.0, |p| p.spot) * 0.2,
        rates: -0.18,
        correlation: 0.24,
        dividend: -0.11,
        theta: -0.35,
        predicted: 0.0,
        residual: 0.12,
    };
    taylor.predicted = sum_ordered(&[
        taylor.delta,
        taylor.gamma,
        taylor.vega,
        taylor.fx,
        taylor.rates,
        taylor.correlation,
        taylor.dividend,
        taylor.theta,
    ]);

    let plva = plva_table();
    let plva_pnl = sum_ordered(&[0.8, 0.3, -0.2, 0.1]);

    let market_explained_pnl = taylor.predicted;
    let current_pv = cash.present_value;
    let total_pnl = current_pv - previous_pv;
    let residual_pnl = current_pv - previous_pv - market_explained_pnl - plva_pnl;

    ValuationExplain {
        previous_pv,
        current_pv,
        taylor,
        plva,
        plva_pnl,
        state: ValuationExplainState {
            previous_pv,
            current_pv,
            market_explained_pnl,
            plva_pnl,
            residual_pnl,
            total_pnl,
        },
    }
}

// ---------------------------------------------------------------------------
// Explain ledger (`explainLedgerStore.ts`)
// ---------------------------------------------------------------------------

/// The `ExplainSource` union, strings verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExplainSource {
    /// Taylor market-move contributions.
    Market,
    /// Valuation methodology adjustments.
    Plva,
    /// Realized cashflows.
    Cashflow,
    /// Discounting and other present-value effects.
    Valuation,
    /// Never populated; the reconciliation still sums the bucket.
    Risk,
}

/// One ledger entry. `sub_category`, `parent_id` and `metadata` are optional in
/// the TypeScript; only `sub_category` is ever set, and `parent_id` /
/// `metadata` are never, so they are omitted rather than carried as `null`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainEntry {
    /// `market-delta`, `plva-{Category}` — note the category keeps its spaces
    /// (`plva-Volatility Calibration`), a detail the golden test would catch.
    pub id: String,
    /// The injected `as_of`, `YYYY-MM-DD`.
    pub timestamp: String,
    /// Which bucket the contribution belongs to.
    pub source: ExplainSource,
    /// `spot`, `volatility`, `time`, the PLVA category, `coupon`,
    /// `discounting`.
    pub category: String,
    /// Present only on the four market rows (`delta`, `gamma`, `vega`, `theta`);
    /// omitted from the wire when `None`, like the TypeScript's optional field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sub_category: Option<String>,
    /// The P&L contribution this entry explains.
    pub contribution: f64,
    /// Always `"USD"`.
    pub currency: String,
    /// Human-readable explanation.
    pub description: String,
}

/// `ExplainReconciliation`. `total_risk` is structurally `0.0` — no risk
/// entries exist — and `explained` omits `taylor.residual`; both are faithful to
/// the prototype and documented, not repaired.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainReconciliation {
    /// Σ market contributions.
    pub total_market: f64,
    /// `totalPLVA`, not serde's naive `totalPlva` — the frontend's literal.
    #[serde(rename = "totalPLVA")]
    pub total_plva: f64,
    /// Σ cashflow contributions.
    pub total_cashflow: f64,
    /// Σ valuation contributions.
    pub total_valuation: f64,
    /// Structural zero: the ledger has no `risk` entries, so this bucket always
    /// sums to nothing. Kept because the frontend renders the five buckets.
    pub total_risk: f64,
    /// `total_market + total_plva + total_cashflow + total_valuation +
    /// total_risk` — deliberately excluding `taylor.residual`.
    pub explained: f64,
    /// `= explain.state.total_pnl`.
    #[serde(rename = "actualPnL")]
    pub actual_pnl: f64,
    /// `actual_pnl - explained`; nonzero on purpose, see the module docs.
    pub residual: f64,
}

/// The ledger: the fixed ten entries plus their reconciliation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainLedger {
    /// The ten entries in display order.
    pub entries: Vec<ExplainEntry>,
    /// The five-bucket reconciliation.
    pub reconciliation: ExplainReconciliation,
}

/// The four market entries: one per Taylor term, in display order.
fn market_entries(as_of: &str, taylor: &TaylorExplain) -> Vec<ExplainEntry> {
    let market = |id: &str, sub: &str, contribution: f64, description: &str| ExplainEntry {
        id: id.to_string(),
        timestamp: as_of.to_string(),
        source: ExplainSource::Market,
        category: "spot".to_string(),
        sub_category: Some(sub.to_string()),
        contribution,
        currency: "USD".to_string(),
        description: description.to_string(),
    };
    vec![
        market(
            "market-delta",
            "delta",
            taylor.delta,
            "Spot move × delta contribution",
        ),
        market(
            "market-gamma",
            "gamma",
            taylor.gamma,
            "Convexity contribution",
        ),
        market(
            "market-vega",
            "vega",
            taylor.vega,
            "Volatility move × vega contribution",
        ),
        market(
            "market-theta",
            "theta",
            taylor.theta,
            "Time decay contribution",
        ),
    ]
}

/// The four PLVA entries, one per table row, ids keeping the category spaces.
fn plva_entries(as_of: &str, plva: &[PlvaContribution]) -> Vec<ExplainEntry> {
    plva.iter()
        .map(|x| ExplainEntry {
            id: format!("plva-{}", x.category),
            timestamp: as_of.to_string(),
            source: ExplainSource::Plva,
            category: x.category.clone(),
            sub_category: None,
            contribution: x.contribution,
            currency: "USD".to_string(),
            description: "Valuation methodology adjustment".to_string(),
        })
        .collect()
}

/// The cashflow and valuation rows that close out the ledger.
fn tail_entries(as_of: &str, cash: &CashflowAnalytics) -> Vec<ExplainEntry> {
    vec![
        ExplainEntry {
            id: "cashflow-coupon".to_string(),
            timestamp: as_of.to_string(),
            source: ExplainSource::Cashflow,
            category: "coupon".to_string(),
            sub_category: None,
            contribution: cash.realized,
            currency: "USD".to_string(),
            description: "Realized coupon cashflows".to_string(),
        },
        ExplainEntry {
            id: "valuation-discounting".to_string(),
            timestamp: as_of.to_string(),
            source: ExplainSource::Valuation,
            category: "discounting".to_string(),
            sub_category: None,
            contribution: cash.present_value - cash.gross_cashflow,
            currency: "USD".to_string(),
            description: "Discounting impact on cashflows".to_string(),
        },
    ]
}

/// The five-bucket reconciliation, summed off the entries themselves.
fn reconcile(entries: &[ExplainEntry], actual_pnl: f64) -> ExplainReconciliation {
    let total = |source: ExplainSource| {
        entries
            .iter()
            .filter(|e| e.source == source)
            .fold(0.0, |n, e| n + e.contribution)
    };
    let total_market = total(ExplainSource::Market);
    let total_plva = total(ExplainSource::Plva);
    let total_cashflow = total(ExplainSource::Cashflow);
    let total_valuation = total(ExplainSource::Valuation);
    let total_risk = total(ExplainSource::Risk);
    let explained = total_market + total_plva + total_cashflow + total_valuation + total_risk;
    ExplainReconciliation {
        total_market,
        total_plva,
        total_cashflow,
        total_valuation,
        total_risk,
        explained,
        actual_pnl,
        residual: actual_pnl - explained,
    }
}

/// `useExplainLedger`, with the timestamp injected instead of read from the
/// clock. Pure in `as_of`: same inputs, same bytes.
#[must_use]
pub fn explain_ledger(
    explain: &ValuationExplain,
    cash: &CashflowAnalytics,
    as_of: &str,
) -> ExplainLedger {
    let mut entries = market_entries(as_of, &explain.taylor);
    entries.extend(plva_entries(as_of, &explain.plva));
    entries.extend(tail_entries(as_of, cash));

    let actual_pnl = explain.state.total_pnl;
    let reconciliation = reconcile(&entries, actual_pnl);
    ExplainLedger {
        entries,
        reconciliation,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path_generator::{generate_paths, SimulationConfig};
    use crate::types::MarketSnapshot;

    /// The demo path 0 — the same `paths[0]` the golden fixture's `cashflow`
    /// section was captured from, and the same default trade.
    fn demo() -> (SimulationPath, TradeEconomics) {
        let mut bundle =
            generate_paths(SimulationConfig::demo(), |_| {}).expect("demo config valid");
        (bundle.paths.remove(0), TradeEconomics::default())
    }

    // -----------------------------------------------------------------------
    // Cashflow rows
    // -----------------------------------------------------------------------

    /// The full 60-row series against the values the real TypeScript produced
    /// (captured in `golden.json` and re-verified here without the fixture).
    #[test]
    fn demo_cashflow_rows_match_typescript() {
        let (path, trade) = demo();
        let rows = build_cashflows(&path, &trade);

        assert_eq!(rows.len(), 60, "one row per observation date");
        assert_eq!(rows[0].id, "cf-0");
        assert_eq!(rows[0].date, "2024-01-15");
        assert_eq!(rows[0].kind, CashflowType::Coupon);
        assert_eq!(rows[0].amount, 1.0);
        assert_eq!(rows[0].currency, "USD");
        assert_eq!(rows[0].probability, 0.85);
        assert_eq!(rows[0].discount_factor, 0.9967);
        assert_eq!(rows[0].present_value, 1.0);
        assert!(rows[0].realized);

        // Row 1 is the second realized coupon.
        assert_eq!(rows[1].id, "cf-1");
        assert_eq!(rows[1].amount, 1.0);
        assert_eq!(rows[1].discount_factor, 0.9935);
        assert_eq!(rows[1].present_value, 0.99);
        assert!(rows[1].realized);

        // The knocked-out path accrues coupons for 13 months, then stops: row 13
        // is the first zero-amount coupon.
        assert_eq!(rows[12].amount, 1.0, "12th observation still accrued");
        assert_eq!(rows[13].amount, 0.0, "13th observation did not accrue");
        assert!(!rows[13].realized);

        // The final row is the notional, physical settlement, probability 0.98.
        assert_eq!(rows[59].id, "cf-59");
        assert_eq!(rows[59].date, "2028-12-15");
        assert_eq!(rows[59].kind, CashflowType::PhysicalDelivery);
        assert_eq!(rows[59].amount, 100.0);
        assert_eq!(rows[59].probability, 0.98);
        assert_eq!(rows[59].discount_factor, 0.8219);
        assert_eq!(rows[59].present_value, 82.19);
        assert!(!rows[59].realized);
    }

    /// With physical settlement disabled, the final row is `redemption` — the
    /// only other terminal type the builder can produce.
    #[test]
    fn cash_settlement_trade_yields_redemption_final_row() {
        let (path, mut trade) = demo();
        trade.physical_settlement_enabled = false;
        let rows = build_cashflows(&path, &trade);
        assert_eq!(rows.last().unwrap().kind, CashflowType::Redemption);
        assert_eq!(rows.last().unwrap().amount, 100.0);
        assert!(rows
            .iter()
            .all(|r| r.kind == CashflowType::Coupon || r.kind == CashflowType::Redemption));
    }

    /// Discount factors strictly decrease month over month and start at
    /// `round4(1 / 1.04)`.
    #[test]
    fn discount_factors_are_monotonic_and_start_at_round_four_of_one_over_one_p04() {
        let (path, trade) = demo();
        let rows = build_cashflows(&path, &trade);
        for w in rows.windows(2) {
            assert!(
                w[0].discount_factor > w[1].discount_factor,
                "df must decrease: {} vs {}",
                w[0].discount_factor,
                w[1].discount_factor
            );
        }
        assert_eq!(
            rows[0].discount_factor,
            js_to_fixed_f64(1.0 / 1.04_f64.powf(1.0 / 12.0), 4)
        );
    }

    /// The spec (test 3) demands proof that `present_value` uses the *rounded*
    /// df. Two assertions: the identity holds on every demo row, and a
    /// constructible case actually distinguishes the two — because the identity
    /// alone would be vacuous if `round2(amount * raw)` always agreed.
    ///
    /// The distinguishing case: row 0's raw df is `1 / 1.04^(1/12) =
    /// 0.996736942…`, rounded to `0.9967`. With a coupon amount of `1.52`
    /// (notional 152 at the default 12% annual rate), `round2(1.52 * 0.9967) =
    /// 1.51` but `round2(1.52 * 0.9967369…) = 1.52`.
    #[test]
    fn present_value_uses_the_rounded_discount_factor() {
        let (path, trade) = demo();

        // Identity on every demo row.
        for (i, row) in build_cashflows(&path, &trade).iter().enumerate() {
            let raw = 1.0 / 1.04_f64.powf((i as f64 + 1.0) / 12.0);
            let rounded = js_to_fixed_f64(raw, 4);
            assert_eq!(
                row.discount_factor, rounded,
                "row {i} must carry the rounded df"
            );
            assert_eq!(
                row.present_value,
                js_to_fixed_f64(row.amount * rounded, 2),
                "row {i} must discount off the rounded df"
            );
        }

        // The discriminating construction.
        let mut big = trade;
        big.notional = 152.0; // 152 * 0.12 / 12 = 1.52 exactly
        let rows = build_cashflows(&path, &big);
        assert_eq!(rows[0].amount, 1.52);
        let raw = 1.0 / 1.04_f64.powf(1.0 / 12.0);
        let rounded = js_to_fixed_f64(raw, 4);
        assert_ne!(
            js_to_fixed_f64(1.52 * rounded, 2),
            js_to_fixed_f64(1.52 * raw, 2),
            "1.52 * rounded = 1.51 vs 1.52 * raw = 1.52 — this case must discriminate"
        );
        assert_eq!(rows[0].present_value, js_to_fixed_f64(1.52 * rounded, 2));
    }

    /// Exactly two realized rows (`i < 2`), regardless of the trade.
    #[test]
    fn exactly_two_realized_cashflows() {
        let (path, trade) = demo();
        let rows = build_cashflows(&path, &trade);
        let realized: Vec<&Cashflow> = rows.iter().filter(|r| r.realized).collect();
        assert_eq!(realized.len(), 2);
        assert_eq!(realized[0].id, "cf-0");
        assert_eq!(realized[1].id, "cf-1");
    }

    /// Spec test 11: a KO-shaped path (dates shorter than observations) must not
    /// panic and must return `dates.len()` rows — with the truncated dates the
    /// last row is simply the maturity row for the shorter series.
    #[test]
    fn short_dates_with_full_observations_do_not_panic() {
        let (mut path, trade) = demo();
        path.dates.truncate(3); // knocked-out paths carry fewer dates
        assert_eq!(path.dates.len(), 3);
        assert!(path.observations.len() > 3);
        let rows = build_cashflows(&path, &trade);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].id, "cf-0");
        assert_eq!(rows[0].kind, CashflowType::Coupon);
        assert!(rows[0].realized && rows[1].realized);
        assert_eq!(rows[2].id, "cf-2");
        assert_eq!(
            rows[2].kind,
            CashflowType::PhysicalDelivery,
            "row 2 is the final row now"
        );
        assert_eq!(rows[2].probability, 0.98);
        assert!(!rows[2].realized);
    }

    // -----------------------------------------------------------------------
    // Cashflow analytics
    // -----------------------------------------------------------------------

    /// The exact aggregates from the real TypeScript run (see Appendix E).
    #[test]
    fn demo_cashflow_analytics_match_typescript() {
        let (path, trade) = demo();
        let a = cashflow_analytics(&path, &trade);

        assert_eq!(a.gross_cashflow, 113.0);
        assert_eq!(a.present_value, 94.89);
        assert_eq!(a.realized, 2.0);
        assert_eq!(a.future, 111.0);
        assert_eq!(a.realized_pnl, 0.0);
        assert_eq!(a.unrealized_pnl, -5.109_999_999_999_999);
        assert_eq!(a.mtm_pnl, -5.109_999_999_999_999);
        assert_eq!(a.carry_pnl, 12.04);
        assert_eq!(a.total_pnl, 6.93);
    }

    /// Spec tests 5 and 6, as identities over an arbitrary trade rather than a
    /// single fixture point.
    #[test]
    fn carry_and_total_pnl_hold_for_arbitrary_trades() {
        let mut trade = TradeEconomics::default();
        for notional in [1.0, 10.0, 47.5, 100.0, 1_000.0] {
            for rate in [0.02, 0.06, 0.12, 0.18] {
                trade.notional = notional;
                trade.coupon_rate = rate;
                let (path, _) = demo();
                let a = cashflow_analytics(&path, &trade);
                assert_eq!(
                    a.carry_pnl,
                    a.realized * 0.02 + rate * notional,
                    "carry for notional {notional} rate {rate}"
                );
                assert_eq!(a.mtm_pnl, a.present_value - notional);
                assert_eq!(
                    a.total_pnl,
                    a.mtm_pnl + a.carry_pnl,
                    "totalPnl for notional {notional} rate {rate}"
                );
            }
        }
    }

    // -----------------------------------------------------------------------
    // Valuation explain
    // -----------------------------------------------------------------------

    fn demo_explain() -> ValuationExplain {
        let (path, trade) = demo();
        let cash = cashflow_analytics(&path, &trade);
        valuation_explain(&cash, &MarketSnapshot::demo())
    }

    /// Taylor terms, PLVA, and the state — exact doubles from the TypeScript run.
    #[test]
    fn demo_valuation_explain_matches_typescript() {
        let v = demo_explain();

        assert_eq!(v.previous_pv, 93.09);
        assert_eq!(v.current_pv, 94.89);
        assert_eq!(v.taylor.delta, 1.11);
        assert_eq!(v.taylor.gamma, 0.42);
        assert_eq!(v.taylor.vega, 0.288);
        assert_eq!(v.taylor.fx, 0.268);
        assert_eq!(v.taylor.rates, -0.18);
        assert_eq!(v.taylor.correlation, 0.24);
        assert_eq!(v.taylor.dividend, -0.11);
        assert_eq!(v.taylor.theta, -0.35);
        assert_eq!(v.taylor.predicted, 1.686_000_000_000_000_4);
        assert_eq!(v.taylor.residual, 0.12);

        // PLVA: the four literal rows.
        assert_eq!(v.plva.len(), 4);
        let cats: Vec<&str> = v.plva.iter().map(|p| p.category.as_str()).collect();
        assert_eq!(
            cats,
            [
                "Volatility Calibration",
                "Correlation Calibration",
                "Funding Curve Update",
                "Reserve Update"
            ]
        );
        let contribs: Vec<f64> = v.plva.iter().map(|p| p.contribution).collect();
        assert_eq!(contribs, [0.8, 0.3, -0.2, 0.1]);

        // `plvaPnL` is the *unrounded* IEEE sum — 1.0000000000000002, not 1.0.
        assert_eq!(v.plva_pnl, 1.000_000_000_000_000_2);

        assert_eq!(v.state.previous_pv, 93.09);
        assert_eq!(v.state.current_pv, 94.89);
        assert_eq!(v.state.market_explained_pnl, 1.686_000_000_000_000_4);
        assert_eq!(v.state.plva_pnl, 1.000_000_000_000_000_2);
        assert_eq!(v.state.residual_pnl, -0.886_000_000_000_003_5);
        assert_eq!(v.state.total_pnl, 1.799_999_999_999_997_2);
    }

    /// Spec test 2: the predicted sum is order-pinned. A deliberately wrong
    /// order must change the answer — the same result Phase 1 proved for the
    /// eight-term canonical sum, and the only way the golden assertion has
    /// teeth.
    #[test]
    fn predicted_summation_order_is_pinned() {
        let v = demo_explain();
        let t = &v.taylor;

        let canonical = [
            t.delta,
            t.gamma,
            t.vega,
            t.fx,
            t.rates,
            t.correlation,
            t.dividend,
            t.theta,
        ];
        assert_eq!(sum_ordered(&canonical), 1.686_000_000_000_000_4);

        // A different order (theta first) must differ.
        let wrong = [
            t.theta,
            t.delta,
            t.gamma,
            t.vega,
            t.fx,
            t.rates,
            t.correlation,
            t.dividend,
        ];
        assert_ne!(sum_ordered(&wrong), v.taylor.predicted);
    }

    /// The `?? 100` / `?? 1` fallbacks the store applies to empty arrays.
    #[test]
    fn empty_market_uses_the_store_fallbacks() {
        let (path, trade) = demo();
        let cash = cashflow_analytics(&path, &trade);
        let mut market = MarketSnapshot::demo();
        market.underlyings.clear();
        market.fx_pairs.clear();

        let v = valuation_explain(&cash, &market);
        assert_eq!(v.taylor.delta, 100.0 * 0.006);
        assert_eq!(v.taylor.fx, 1.0 * 0.2);
        assert_eq!(v.taylor.vega, market.vol.atm_vol * 1.2);
    }

    // -----------------------------------------------------------------------
    // Ledger
    // -----------------------------------------------------------------------

    fn demo_ledger(as_of: &str) -> ExplainLedger {
        let (path, trade) = demo();
        let cash = cashflow_analytics(&path, &trade);
        let explain = valuation_explain(&cash, &MarketSnapshot::demo());
        explain_ledger(&explain, &cash, as_of)
    }

    /// Spec test 7: exactly ten entries, in the pinned order, with the pinned
    /// ids — including `plva-*` categories keeping their spaces.
    #[test]
    fn ledger_has_exactly_ten_entries_in_order() {
        let ledger = demo_ledger("2026-01-15");
        let ids: Vec<&str> = ledger.entries.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "market-delta",
                "market-gamma",
                "market-vega",
                "market-theta",
                "plva-Volatility Calibration",
                "plva-Correlation Calibration",
                "plva-Funding Curve Update",
                "plva-Reserve Update",
                "cashflow-coupon",
                "valuation-discounting",
            ]
        );
    }

    /// The four market entries wear their sub-categories; the PLVA, cashflow and
    /// valuation entries carry `None` and must not serialise a `subCategory`
    /// key.
    #[test]
    fn sub_categories_are_only_present_where_the_store_sets_them() {
        let ledger = demo_ledger("2026-01-15");
        for e in &ledger.entries {
            let json = serde_json::to_value(e).unwrap();
            match e.id.as_str() {
                "market-delta" => assert_eq!(json["subCategory"], "delta"),
                "market-gamma" => assert_eq!(json["subCategory"], "gamma"),
                "market-vega" => assert_eq!(json["subCategory"], "vega"),
                "market-theta" => assert_eq!(json["subCategory"], "theta"),
                _ => assert!(
                    json.get("subCategory").is_none(),
                    "{} must not serialise subCategory",
                    e.id
                ),
            }
        }
    }

    /// Spec tests 8 and 9: reconciliation totals, the structural `total_risk`
    /// zero, and the residual recomputed independently.
    #[test]
    fn ledger_reconciliation_matches_typescript() {
        let ledger = demo_ledger("2026-01-15");
        let r = &ledger.reconciliation;

        assert_eq!(r.total_market, 1.468);
        assert_eq!(r.total_plva, 1.000_000_000_000_000_2);
        assert_eq!(r.total_cashflow, 2.0);
        assert_eq!(r.total_valuation, -18.11);
        assert_eq!(r.total_risk, 0.0, "no risk entries exist");

        // Independence: recompute `explained` from the entries themselves.
        let by_source = |s: ExplainSource| {
            ledger
                .entries
                .iter()
                .filter(|e| e.source == s)
                .fold(0.0, |n, e| n + e.contribution)
        };
        assert_eq!(r.total_market, by_source(ExplainSource::Market));
        assert_eq!(r.total_plva, by_source(ExplainSource::Plva));
        assert_eq!(r.total_cashflow, by_source(ExplainSource::Cashflow));
        assert_eq!(r.total_valuation, by_source(ExplainSource::Valuation));

        let replayed = by_source(ExplainSource::Market)
            + by_source(ExplainSource::Plva)
            + by_source(ExplainSource::Cashflow)
            + by_source(ExplainSource::Valuation)
            + by_source(ExplainSource::Risk);
        assert_eq!(r.explained, replayed);
        assert_eq!(r.explained, -13.642);

        // `explained` omits taylor.residual on purpose, so the residual is real.
        assert_eq!(r.actual_pnl, 1.799_999_999_999_997_2);
        assert_eq!(r.residual, r.actual_pnl - r.explained);
        assert_eq!(r.residual, 15.441_999_999_999_997);
        assert!(
            (r.residual - 0.12).abs() > 13.0,
            "the 0.12 taylor.residual is deliberately unexplained"
        );
    }

    /// Spec test 10: `as_of` is the only nondeterminism; same inputs, same
    /// bytes; changing `as_of` changes only the timestamps.
    #[test]
    fn ledger_is_pure_in_as_of() {
        let a = demo_ledger("2026-01-15");
        let b = demo_ledger("2026-01-15");
        assert_eq!(
            serde_json::to_vec(&a).unwrap(),
            serde_json::to_vec(&b).unwrap(),
            "same as_of must give byte-identical JSON"
        );

        let c = demo_ledger("2026-02-20");
        let cj: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        let aj: serde_json::Value =
            serde_json::from_str(&serde_json::to_string(&a).unwrap()).unwrap();
        let entries_a = aj["entries"].as_array().unwrap();
        let entries_c = cj["entries"].as_array().unwrap();
        for (ea, ec) in entries_a.iter().zip(entries_c) {
            let mut ea = ea.clone();
            let mut ec = ec.clone();
            assert_ne!(ea["timestamp"], ec["timestamp"], "timestamps differ");
            ea["timestamp"] = serde_json::json!("x");
            ec["timestamp"] = serde_json::json!("x");
            assert_eq!(ea, ec, "nothing but the timestamp may differ");
        }
        assert_eq!(aj["reconciliation"], cj["reconciliation"]);
    }

    /// Serialisation keys: the acronym-heavy ones (`previousPV`, `plvaPnL`,
    /// `totalPLVA`) must come out exactly as the frontend expects, not as
    /// serde's camelCase would naively write them (`previousPv`, `plvaPnl`).
    #[test]
    fn acronym_keys_serialise_exactly_as_the_frontend_writes_them() {
        let v = demo_explain();
        let json = serde_json::to_value(&v).unwrap();
        assert!(json.get("previousPV").is_some(), "{json}");
        assert!(json.get("currentPV").is_some());
        assert!(json.get("plvaPnL").is_some());
        assert!(json["state"].get("marketExplainedPnL").is_some());
        assert!(json["state"].get("residualPnL").is_some());
        assert!(json["state"].get("totalPnL").is_some());
        assert!(
            json.get("previousPv").is_none() && json.get("plvaPnl").is_none(),
            "naive camelCase key leaked: {json}"
        );

        let ledger = demo_ledger("2026-01-15");
        let lj = serde_json::to_value(&ledger).unwrap();
        assert!(lj["reconciliation"].get("totalPLVA").is_some());
        assert!(lj["reconciliation"].get("actualPnL").is_some());
        assert!(lj["reconciliation"].get("totalPlva").is_none());
    }

    /// Round-trip: every type here must survive serde unchanged, since the
    /// adapters trust the wire shape.
    #[test]
    fn valuation_types_round_trip_through_json() {
        let v = demo_explain();
        let json = serde_json::to_string(&v).unwrap();
        assert_eq!(serde_json::from_str::<ValuationExplain>(&json).unwrap(), v);

        let ledger = demo_ledger("2026-01-15");
        let json = serde_json::to_string(&ledger).unwrap();
        assert_eq!(
            serde_json::from_str::<ExplainLedger>(&json).unwrap(),
            ledger
        );

        let (path, trade) = demo();
        let cf = build_cashflows(&path, &trade);
        let json = serde_json::to_string(&cf).unwrap();
        assert_eq!(serde_json::from_str::<Vec<Cashflow>>(&json).unwrap(), cf);
    }
}
