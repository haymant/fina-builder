//! Risk engine: the port of `computeRisk` from
//! `src/features/pathcube/riskEngine.ts`.
//!
//! # What this actually is
//!
//! Six Greek-looking scalars produced by arithmetic on the trade terms and the
//! mean spot. It is **not** a Greeks engine — there is no revaluation, no
//! bumped-vol surface, no aggregation, no exposure. Three of the seven fields
//! (`delta`, `gamma`, `pv`) come from a single symmetric bump around one
//! number, and `vega` is `notional * maturity * 0.35`. `FEATURES.md Part I` lists
//! production Greeks as explicitly out of scope.
//!
//! # `gamma` is structurally zero
//!
//! ```text
//! pv_up   = base + ds * 0.08
//! pv_down = base - ds * 0.08
//! gamma   = (pv_up - 2 * base + pv_down) / ds^2 * 1000
//! ```
//!
//! `pv_up` and `pv_down` are symmetric **about `base` by construction**, so the
//! numerator cancels to zero for any input: gamma is an artifact of writing a
//! second-derivative formula around a linear base, not a measured sensitivity.
//! `FEATURES.md` §3 and `FEATURES.md Part I` both call this out, and
//! it is preserved verbatim rather than repaired.
//!
//! Strictly, "cancels to zero" is a statement about the algebra, not about
//! IEEE-754: `base + 0.08` and `base - 0.08` are separately rounded, so the
//! numerator can land one or two ULPs off zero — about `1.8e-12` in a sweep of
//! 200,000 random bases, 1 hit in 200,000. Rounded to the 2 decimal places this
//! module reports, that is always `0.00`, so `gamma` is `0` on the wire.
//! `gamma_is_zero_for_every_base` checks the residual directly.
//!
//! # Rounding traps
//!
//! Two of them, both load-bearing:
//!
//! - [`RiskState::bucket_vegas`] multiplies the **unrounded** `vega_raw`, while
//!   [`RiskState::vega`] is `vega_raw` rounded. Using the rounded value here
//!   shifts every bucket by up to half a cent. `bucket_vegas_use_unrounded_vega`
//!   is written so it fails if the two are conflated.
//! - [`RiskState::cross_gamma`] rounds to **3** decimals while every other field
//!   rounds to 2. This is not a typo and not a units difference — it is one
//!   `toFixed(3)` in the TypeScript, and the `correlation * 0.18` scaling is
//!   small enough that 2 decimals would collapse `0.099` and `0.0864` to
//!   `0.1` and `0.09`.
//!
//! # `f64::exp` vs `Math.exp`
//!
//! `bucket_vegas` uses the only transcendental in this phase. Rust's `exp` and
//! V8's `Math.exp` are both correctly rounded to within an ULP but are not
//! guaranteed bit-identical across platforms. Every published bucket value sits
//! at least 0.0018 from a 2-decimal rounding boundary, so a 1-ULP difference
//! cannot change any of them; `bucket_vegas_are_clear_of_rounding_boundaries`
//! keeps that quantified.

use crate::error::{FinaError, Result};
use crate::jsnum::{js_to_fixed_f64, sum_ordered};
use crate::types::{MarketSnapshot, TradeEconomics};
use serde::{Deserialize, Serialize};

/// The ten volatility buckets, in display order.
///
/// Exposed because the bucket labels are a UI contract: the Greeks waterfall
/// tile and the bucket-vega chart both match on these strings.
pub const BUCKETS: [&str; 6] = ["1M", "3M", "6M", "1Y", "2Y", "5Y"];

/// Spot bump applied to `base`, in PV units.
///
/// A PV bump of `0.08` labelled `ds = 1`: the derivative is taken with respect
/// to a unit of spot change that moves PV by 0.08, and the `* 1000` in delta
/// and gamma rescales to per-basis-point-of-spot. `ds` is never anything but `1`.
const DS: f64 = 1.0;

/// PV sensitivity of `base` to one unit of spot.
const SPOT_PV_SLOPE: f64 = 0.08;

/// Reference spot in the `base` formula. `(spot - 242.0) * 0.08`.
const REFERENCE_SPOT: f64 = 242.0;

/// Vega per unit of notional per year.
const VEGA_PER_NOTIONAL_YEAR: f64 = 0.35;

/// Cross-gamma scaling applied to the correlation coefficient.
const CROSS_GAMMA_SCALE: f64 = 0.18;

/// Vega decay exponent divisor: `exp(-i / 3)`.
const BUCKET_DECAY: f64 = 3.0;

/// One vega term, per volatility bucket.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketVega {
    /// Bucket label, one of [`BUCKETS`].
    pub bucket: String,
    /// Vega in that bucket, 2 decimals.
    pub value: f64,
}

/// One cross-gamma term, per non-reference underlying.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossGamma {
    /// `"<reference>/<other>"`, e.g. `"AAPL/MSFT"`.
    pub pair: String,
    /// Cross-gamma, **3** decimals.
    pub value: f64,
}

/// The risk tile's payload.
///
/// Field order here is the field order in `golden.json`'s `risk.base`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskState {
    /// Base present value, 2 decimals.
    pub pv: f64,
    /// Delta, 2 decimals. Always `80.0` — see the module docs.
    pub delta: f64,
    /// Gamma, 2 decimals. Structurally `0.0` — see the module docs.
    pub gamma: f64,
    /// Vega, 2 decimals.
    pub vega: f64,
    /// Theta, 2 decimals.
    pub theta: f64,
    /// Rho, 2 decimals.
    pub rho: f64,
    /// FX delta on the **first** FX pair only, 2 decimals.
    pub fx_delta: f64,
    /// Vega per bucket, from [`BUCKETS`].
    pub bucket_vegas: Vec<BucketVega>,
    /// Cross-gamma against `underlyings[0]`, one per remaining underlying.
    pub cross_gamma: Vec<CrossGamma>,
}

/// Computes the risk tile's payload from trade terms and a market snapshot.
///
/// Port of `computeRisk`. The TypeScript reads `fx_pairs[0]` and
/// `correlations[0]` with non-null assertions and would throw a `TypeError` on
/// a short matrix; this validates up front and returns
/// [`FinaError::InvalidMarket`] instead, which is what makes it servable over
/// a transport rather than a 500.
///
/// ```
/// use fina_kernel::risk_engine::compute_risk;
/// use fina_kernel::types::{MarketSnapshot, TradeEconomics};
///
/// let risk = compute_risk(&TradeEconomics::default(), &MarketSnapshot::demo()).unwrap();
/// assert_eq!(risk.pv, 154.03);
/// assert_eq!(risk.gamma, 0.0);
/// assert_eq!(risk.delta, 80.0);
/// ```
///
/// # Errors
///
/// [`FinaError::InvalidMarket`] if `underlyings` is empty, `fx_pairs` is empty,
/// or `correlations` is not a square matrix with one row and column per
/// underlying.
pub fn compute_risk(trade: &TradeEconomics, market: &MarketSnapshot) -> Result<RiskState> {
    validate_market(market)?;

    // `reduce((sum, u) => sum + u.spot, 0) / underlyings.length` — left to right,
    // so the sum order is contractual.
    let spots: Vec<f64> = market.underlyings.iter().map(|u| u.spot).collect();
    let spot = sum_ordered(&spots) / market.underlyings.len() as f64;

    let base = trade.notional * (1.0 + trade.coupon_rate * trade.maturity_years)
        - trade.notional * 0.06
        - (trade.knock_in_barrier - 0.6) * trade.notional * 0.3
        + (spot - REFERENCE_SPOT) * SPOT_PV_SLOPE;

    let pv_up = base + DS * SPOT_PV_SLOPE;
    let pv_down = base - DS * SPOT_PV_SLOPE;

    // Kept unrounded: `bucket_vegas` scales this, not `RiskState::vega`.
    let vega_raw = trade.notional * trade.maturity_years * VEGA_PER_NOTIONAL_YEAR;
    let fx = market.fx_pairs[0].spot;

    let reference_symbol = &market.underlyings[0].symbol;
    let first_row = &market.correlations[0];

    Ok(RiskState {
        pv: js_to_fixed_f64(base, 2),
        delta: js_to_fixed_f64((pv_up - pv_down) / (2.0 * DS) * 1000.0, 2),
        // Structurally zero; see the module docs before "fixing" this.
        gamma: js_to_fixed_f64((pv_up - 2.0 * base + pv_down) / (DS * DS) * 1000.0, 2),
        vega: js_to_fixed_f64(vega_raw, 2),
        theta: js_to_fixed_f64(-trade.notional * 0.012, 2),
        rho: js_to_fixed_f64(trade.notional * 0.004, 2),
        fx_delta: js_to_fixed_f64(fx * 12.0, 2),

        bucket_vegas: BUCKETS
            .iter()
            .enumerate()
            .map(|(i, bucket)| BucketVega {
                bucket: (*bucket).to_string(),
                value: js_to_fixed_f64(vega_raw * (-(i as f64) / BUCKET_DECAY).exp(), 2),
            })
            .collect(),

        cross_gamma: market
            .underlyings
            .iter()
            .skip(1)
            .enumerate()
            .map(|(i, u)| CrossGamma {
                pair: format!("{reference_symbol}/{}", u.symbol),
                // `correlations[0][i + 1]`: row 0, column 1 for the first
                // non-reference underlying. Rounded to 3, unlike everything else.
                value: js_to_fixed_f64(first_row[i + 1] * CROSS_GAMMA_SCALE, 3),
            })
            .collect(),
    })
}

/// Checks that the snapshot carries everything `compute_risk` indexes into.
///
/// The TypeScript asserts these non-null and throws a `TypeError` otherwise;
/// `undefined * 0.18` would also silently produce `NaN` if the row were merely
/// short. Both failure modes become one reportable error here.
fn validate_market(market: &MarketSnapshot) -> Result<()> {
    let n = market.underlyings.len();
    if n == 0 {
        return Err(FinaError::InvalidMarket(
            "underlyings is empty; risk needs at least one to derive spot".into(),
        ));
    }
    if market.fx_pairs.is_empty() {
        return Err(FinaError::InvalidMarket(
            "fx_pairs is empty; risk reads fx_pairs[0]".into(),
        ));
    }
    if market.correlations.len() != n {
        return Err(FinaError::InvalidMarket(format!(
            "correlations has {} rows but there are {} underlyings",
            market.correlations.len(),
            n
        )));
    }
    if let Some(bad) = market.correlations.iter().position(|row| row.len() != n) {
        return Err(FinaError::InvalidMarket(format!(
            "correlations row {bad} has {} entries but there are {} underlyings",
            market.correlations[bad].len(),
            n
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::economics::DEFAULT_TRADE_ECONOMICS;

    fn demo() -> RiskState {
        compute_risk(&DEFAULT_TRADE_ECONOMICS, &MarketSnapshot::demo())
            .expect("demo market is valid")
    }

    #[test]
    fn demo_market_matches_golden() {
        let r = demo();
        assert_eq!(r.pv, 154.03);
        assert_eq!(r.delta, 80.0);
        assert_eq!(r.gamma, 0.0);
        assert_eq!(r.vega, 175.0);
        assert_eq!(r.theta, -1.2);
        assert_eq!(r.rho, 0.4);
        assert_eq!(r.fx_delta, 16.08);
    }

    #[test]
    fn demo_bucket_vegas_match_golden() {
        let r = demo();
        let vegas: Vec<f64> = r.bucket_vegas.iter().map(|b| b.value).collect();
        assert_eq!(vegas, [175.0, 125.39, 89.85, 64.38, 46.13, 33.05]);
        let labels: Vec<&str> = r.bucket_vegas.iter().map(|b| b.bucket.as_str()).collect();
        assert_eq!(labels, BUCKETS);
    }

    #[test]
    fn demo_cross_gamma_matches_golden_and_keeps_three_decimals() {
        let g = demo().cross_gamma;
        assert_eq!(g.len(), 2);
        assert_eq!(
            g.iter().map(|c| c.pair.as_str()).collect::<Vec<_>>(),
            ["AAPL/MSFT", "AAPL/NVDA"]
        );
        assert_eq!(g[0].value, 0.099);
        assert_eq!(g[1].value, 0.086);
    }

    /// Cross-gamma at 2 decimals would collapse `0.099` to `0.1` and `0.0864`
    /// to `0.09`, losing the distinction the tile draws. Assert the precision
    /// survives serialisation, not just the value.
    #[test]
    fn cross_gamma_serialises_with_three_decimals() {
        let json = serde_json::to_string(&demo().cross_gamma).unwrap();
        assert!(
            json.contains("\"value\":0.099"),
            "3 decimals lost in serialisation: {json}"
        );
        assert!(
            json.contains("\"value\":0.086"),
            "3 decimals lost in serialisation: {json}"
        );
    }

    /// Spot enters `base` once, as `(spot - 242) * 0.08`, and nowhere else. So a
    /// mean spot of `x + 1` must move `pv` by `0.08`.
    ///
    /// Not *exactly* `0.08`: `pv` is reported at 2 decimals, and subtracting
    /// two doubles that are 0.08 apart does not give 0.08 — `154.11 - 154.03`
    /// is `0.0800000000000125`. The tolerance below is a hundred million times
    /// tighter than the rounding that produced the inputs, so it cannot mask a
    /// wrong slope.
    #[test]
    fn pv_responds_to_spot_with_slope_point_08() {
        let base_market = MarketSnapshot::demo();
        let mut shifted = base_market.clone();
        shifted.underlyings[0].spot += 3.0; // mean spot moves by 3/3 = +1
        let a = compute_risk(&DEFAULT_TRADE_ECONOMICS, &base_market).unwrap();
        let b = compute_risk(&DEFAULT_TRADE_ECONOMICS, &shifted).unwrap();
        assert_eq!(a.pv, 154.03);
        assert_eq!(b.pv, 154.11);
        assert!(
            (b.pv - a.pv - 0.08).abs() < 1e-9,
            "pv moved by {} rather than 0.08 per unit of mean spot",
            b.pv - a.pv
        );
    }

    /// The slope is `0.08`, not `0.8` or `0.008`: a 10-unit move in mean spot is
    /// worth 0.8 of PV. Checked over a wider step so a misplaced decimal cannot
    /// hide behind rounding.
    #[test]
    fn spot_slope_is_eight_hundredths() {
        let base_market = MarketSnapshot::demo();
        let mut shifted = base_market.clone();
        shifted.underlyings[2].spot += 30.0; // mean spot moves by 30/3 = +10
        let a = compute_risk(&DEFAULT_TRADE_ECONOMICS, &base_market).unwrap();
        let b = compute_risk(&DEFAULT_TRADE_ECONOMICS, &shifted).unwrap();
        assert!((b.pv - a.pv - 0.8).abs() < 1e-9, "moved by {}", b.pv - a.pv);
    }

    /// The inverse: every other field must be untouched by spot.
    #[test]
    fn spot_moves_pv_and_nothing_else() {
        let base_market = MarketSnapshot::demo();
        let mut shifted = base_market.clone();
        shifted.underlyings[0].spot += 17.0;
        let a = compute_risk(&DEFAULT_TRADE_ECONOMICS, &base_market).unwrap();
        let b = compute_risk(&DEFAULT_TRADE_ECONOMICS, &shifted).unwrap();
        assert_eq!(b.delta, a.delta);
        assert_eq!(b.gamma, a.gamma);
        assert_eq!(b.vega, a.vega);
        assert_eq!(b.theta, a.theta);
        assert_eq!(b.rho, a.rho);
        assert_eq!(b.fx_delta, a.fx_delta);
        assert_eq!(b.bucket_vegas, a.bucket_vegas);
        assert_eq!(b.cross_gamma, a.cross_gamma);
    }

    /// FX appears only in `fx_delta`. Even though the fixture would let it move
    /// nothing else, assert it explicitly so a future edit cannot leak it into
    /// `base`.
    #[test]
    fn fx_moves_only_fx_delta() {
        let base_market = MarketSnapshot::demo();
        let mut shifted = base_market.clone();
        shifted.fx_pairs[0].spot = 9.5;
        let a = compute_risk(&DEFAULT_TRADE_ECONOMICS, &base_market).unwrap();
        let b = compute_risk(&DEFAULT_TRADE_ECONOMICS, &shifted).unwrap();
        assert_eq!(b.fx_delta, 114.0);
        assert_eq!(b.pv, a.pv);
        assert_eq!(b.delta, a.delta);
        assert_eq!(b.gamma, a.gamma);
        assert_eq!(b.vega, a.vega);
        assert_eq!(b.theta, a.theta);
        assert_eq!(b.rho, a.rho);
        assert_eq!(b.bucket_vegas, a.bucket_vegas);
        assert_eq!(b.cross_gamma, a.cross_gamma);
    }

    /// Only `fx_pairs[0]` is read.
    #[test]
    fn only_the_first_fx_pair_is_read() {
        let base_market = MarketSnapshot::demo();
        let mut shifted = base_market.clone();
        shifted.fx_pairs[1].spot = 99.0;
        shifted.fx_pairs[2].spot = 0.5;
        let a = compute_risk(&DEFAULT_TRADE_ECONOMICS, &base_market).unwrap();
        let b = compute_risk(&DEFAULT_TRADE_ECONOMICS, &shifted).unwrap();
        assert_eq!(a, b);
    }

    /// Written to fail if someone swaps `vega_raw` for the rounded `vega`.
    ///
    /// Notional `150` at maturity `4.93` gives `vega_raw = 258.825`, which has
    /// sub-cent digits, so `round2(vega_raw) == 258.82`. Bucket 0 cannot tell
    /// the two apart (`exp(0) == 1`), but **five of the other five buckets
    /// differ by a cent**, so the assertion below is unambiguous.
    #[test]
    fn bucket_vegas_use_unrounded_vega() {
        let trade = TradeEconomics {
            notional: 150.0,
            maturity_years: 4.93,
            ..DEFAULT_TRADE_ECONOMICS
        };

        // The premise: the rounded and unrounded forms genuinely differ here.
        let vega_raw = 150.0 * 4.93 * 0.35;
        assert_eq!(vega_raw, 258.825);
        let rounded = js_to_fixed_f64(vega_raw, 2);
        assert_eq!(rounded, 258.82);
        assert_ne!(vega_raw, rounded);

        let r = compute_risk(&trade, &MarketSnapshot::demo()).unwrap();
        assert_eq!(r.vega, rounded);

        // What the implementation reports, from the unrounded vega.
        let from_raw: Vec<f64> = r.bucket_vegas.iter().map(|b| b.value).collect();
        assert_eq!(from_raw, [258.82, 185.46, 132.89, 95.22, 68.23, 48.89]);

        // What a rounded-vega implementation would report instead.
        let from_rounded: Vec<f64> = (0..BUCKETS.len())
            .map(|i| js_to_fixed_f64(rounded * (-(i as f64) / BUCKET_DECAY).exp(), 2))
            .collect();
        assert_eq!(from_rounded, [258.82, 185.45, 132.88, 95.21, 68.22, 48.88]);

        assert_ne!(from_raw, from_rounded, "the premise of this test vanished");
        assert_eq!(
            from_raw
                .iter()
                .zip(&from_rounded)
                .filter(|(a, b)| a != b)
                .count(),
            5,
            "all five scaled buckets should distinguish the two forms"
        );
    }

    /// The reported `vega` is the rounded form, and bucket 0 is that same value
    /// (because `exp(-0/3) == 1`). Stated so the relationship is not mistaken for
    /// an accident.
    #[test]
    fn first_bucket_is_the_rounded_vega() {
        let r = demo();
        assert_eq!(r.bucket_vegas[0].value, r.vega);
        assert_eq!(r.bucket_vegas[0].bucket, BUCKETS[0]);
    }

    #[test]
    fn bucket_vegas_decay_monotonically() {
        let vegas: Vec<f64> = demo().bucket_vegas.iter().map(|b| b.value).collect();
        assert!(
            vegas.windows(2).all(|w| w[1] < w[0]),
            "buckets must decay: {vegas:?}"
        );
    }

    /// Quantifies the libm caveat in the module docs.
    #[test]
    fn bucket_vegas_are_clear_of_rounding_boundaries() {
        let vega_raw = 100.0 * 5.0 * 0.35;
        for i in 0..BUCKETS.len() {
            let v = vega_raw * (-(i as f64) / BUCKET_DECAY).exp();
            // Distance from the nearest x.xx5 boundary. A 1-ULP wobble is
            // ~1e-14 relative, so anything above 1e-6 is safe by seven orders.
            let scaled = v * 100.0;
            let distance = (scaled - scaled.floor() - 0.5).abs();
            assert!(
                distance > 1e-6,
                "bucket {i} value {v} sits on a rounding boundary"
            );
        }
    }

    #[test]
    fn gamma_is_zero_for_every_base() {
        // Not just for the demo: sweep the base across a wide range and check
        // the *reported* gamma, which is what crosses the wire.
        for notional in [1.0, 7.0, 100.0, 333.0, 1000.0, 12_345.0] {
            for maturity in [1.0, 3.0, 5.0, 7.5, 20.0] {
                for rate in [0.01, 0.06, 0.12, 0.18, 0.4] {
                    for ki in [0.0, 0.3, 0.6, 0.7, 1.1, 2.0] {
                        let trade = TradeEconomics {
                            notional,
                            maturity_years: maturity,
                            coupon_rate: rate,
                            knock_in_barrier: ki,
                            ..DEFAULT_TRADE_ECONOMICS
                        };
                        let r = compute_risk(&trade, &MarketSnapshot::demo()).unwrap();
                        assert_eq!(
                            r.gamma, 0.0,
                            "gamma was {} for n={notional} T={maturity} c={rate} ki={ki}",
                            r.gamma
                        );
                    }
                }
            }
        }
    }

    /// The residual is not *identically* zero in IEEE-754, only after rounding.
    /// This pins the honest version of the claim.
    #[test]
    fn gamma_numerator_is_zero_or_one_ulp_from_it() {
        let mut worst = 0.0_f64;
        let mut hits = 0usize;
        let mut seen = 0u64;
        for _ in 0..20_000u64 {
            // A deterministic LCG so this test cannot flake.
            seen = seen.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            let base = (seen >> 11) as f64 / (1u64 << 53) as f64 * 200_000.0 - 100_000.0;
            let numerator = (base + DS * SPOT_PV_SLOPE) - 2.0 * base + (base - DS * SPOT_PV_SLOPE);
            if numerator != 0.0 {
                hits += 1;
                worst = worst.max(numerator.abs());
            }
        }
        assert!(
            hits > 0,
            "expected at least one non-zero residual in 20000 draws"
        );
        assert!(
            worst < 1e-9,
            "residual {worst} is far too large to be float cancellation"
        );
    }

    #[test]
    fn delta_is_the_pv_bump_over_the_step() {
        // (pv_up - pv_down) / (2 * ds) * 1000 == 2 * 0.08 / 2 * 1000 == 80, for
        // every input. Assert it is invariant across trades, since that is the
        // clearest statement that it is not a sensitivity.
        for notional in [1.0, 100.0, 999.0] {
            for ki in [0.3, 0.6, 1.0] {
                let trade = TradeEconomics {
                    notional,
                    knock_in_barrier: ki,
                    ..DEFAULT_TRADE_ECONOMICS
                };
                let r = compute_risk(&trade, &MarketSnapshot::demo()).unwrap();
                assert_eq!(r.delta, 80.0);
            }
        }
    }

    #[test]
    fn empty_fx_pairs_is_invalid_market() {
        let mut market = MarketSnapshot::demo();
        market.fx_pairs.clear();
        let err = compute_risk(&DEFAULT_TRADE_ECONOMICS, &market).unwrap_err();
        assert_eq!(err.code(), "INVALID_MARKET");
        assert!(err.to_string().contains("fx_pairs"), "{err}");
        assert_eq!(err.http_status(), 400);
    }

    #[test]
    fn empty_underlyings_is_invalid_market() {
        let mut market = MarketSnapshot::demo();
        market.underlyings.clear();
        market.correlations.clear();
        let err = compute_risk(&DEFAULT_TRADE_ECONOMICS, &market).unwrap_err();
        assert_eq!(err.code(), "INVALID_MARKET");
        assert!(err.to_string().contains("underlyings"), "{err}");
    }

    #[test]
    fn correlations_must_match_the_underlying_count() {
        let mut market = MarketSnapshot::demo();
        market.correlations.pop();
        let err = compute_risk(&DEFAULT_TRADE_ECONOMICS, &market).unwrap_err();
        assert!(err.to_string().contains("2 rows but there are 3"), "{err}");

        let mut market = MarketSnapshot::demo();
        market.correlations[0].pop();
        let err = compute_risk(&DEFAULT_TRADE_ECONOMICS, &market).unwrap_err();
        assert!(err.to_string().contains("row 0"), "{err}");
        assert_eq!(err.code(), "INVALID_MARKET");
    }

    /// A single underlying is legal: `cross_gamma` is then empty, not an error.
    #[test]
    fn a_single_underlying_yields_no_cross_gamma() {
        let mut market = MarketSnapshot::demo();
        market.underlyings.truncate(1);
        market.correlations.truncate(1);
        market.correlations[0].truncate(1);
        let r = compute_risk(&DEFAULT_TRADE_ECONOMICS, &market).unwrap();
        assert!(
            r.cross_gamma.is_empty(),
            "a single underlying has no cross gamma"
        );
        assert_eq!(r.bucket_vegas.len(), 6);
    }

    #[test]
    fn cross_gamma_pairs_the_reference_with_each_other_underlying() {
        let mut market = MarketSnapshot::demo();
        market.underlyings[0].symbol = "TSLA".into();
        let r = compute_risk(&DEFAULT_TRADE_ECONOMICS, &market).unwrap();
        assert_eq!(r.cross_gamma[0].pair, "TSLA/MSFT");
        assert_eq!(r.cross_gamma[1].pair, "TSLA/NVDA");
    }

    #[test]
    fn risk_state_serialises_in_golden_field_order() {
        let json = serde_json::to_string(&demo()).unwrap();
        let expected_prefix = concat!(
            r#"{"pv":154.03,"delta":80.0,"gamma":0.0,"vega":175.0,"#,
            r#""theta":-1.2,"rho":0.4,"fxDelta":16.08,"#
        );
        assert!(
            json.starts_with(expected_prefix),
            "field order drifted: {json}"
        );
    }

    #[test]
    fn risk_state_round_trips_through_json() {
        let r = demo();
        let json = serde_json::to_string(&r).unwrap();
        assert_eq!(serde_json::from_str::<RiskState>(&json).unwrap(), r);
    }

    /// `compute_risk` is a pure function of its two inputs.
    #[test]
    fn is_deterministic() {
        let a = serde_json::to_string(&demo()).unwrap();
        let b = serde_json::to_string(&demo()).unwrap();
        assert_eq!(a, b);
    }
}
