//! Trade economics: the port of `deriveTradeAnalytics` and the preset table from
//! `src/store/tradeEconomicsStore.ts`.
//!
//! # What this is
//!
//! A compact **heuristic**, not a valuation. Every output is a linear
//! extrapolation in the trade's barriers and coupon, calibrated to return
//! roughly `103` on the default terms. It is not discounted, not risk-adjusted,
//! and not calibrated against any data. `FEATURES.md Part I` says so explicitly, and
//! that framing is carried over verbatim.
//!
//! Three properties of the original are preserved rather than repaired, because
//! they are what the UI displays today:
//!
//! 1. **`coupon_lower_barrier` and `coupon_upper_barrier` are ignored.** No
//!    formula in this module reads them. The `RangeAccrual` node in
//!    `path_generator` uses its *own* barriers ([`crate::types::ProductBarriers`]),
//!    not these. Changing the coupon range in the Trade Design panel therefore
//!    moves nothing in this panel.
//! 2. **`ci_width` is the constant `0.43`.** The formula is
//!    `0.43 * Math.sqrt(100000 / 100000)` — a convergence half-width whose path
//!    count was pinned to the numerator, so the ratio is exactly `1` and the
//!    whole expression collapses to `0.43`. Written out rather than replaced by
//!    the literal so that the vestigial shape stays visible.
//! 3. **`put_pv` goes negative** below a knock-in barrier of about `0.385`.
//!    `Capital Protected` sits at `0.3` and reports `putPv: -3`. A negative put
//!    value is not meaningful; the linear term just runs past zero. Preserved.
//!
//! # The `ki_probability` rounding question
//!
//! `expected_pv` consumes the **clamped but unrounded** `ki_probability`, not
//! the 1-decimal value that appears in the output object:
//!
//! ```text
//! const kiProbability = Math.max(4, Math.min(55, ...))   // clamped, unrounded
//! const expectedPv    = ... - kiProbability * .08         // uses the local above
//! return { ..., kiProbability: +kiProbability.toFixed(1) } // rounds only here
//! ```
//!
//! This is not observable by inspection — the difference is at most `0.004` —
//! but it changes `expected_pv` for 19 of 181 barrier values sampled between
//! `0.2` and `1.5`. `expected_pv_uses_unrounded_ki_probability` pins it with a
//! case (`ki = 0.37`) where the two disagree.

// `ki_probability` and `ko_probability` are the TypeScript's own names, and
// `similar_names` objects to them differing only in two characters. Renaming one
// would make this harder to read against `tradeEconomicsStore.ts`, which is the
// main way a port gets reviewed.
#![allow(clippy::similar_names)]

use crate::jsnum::{clamp, js_to_fixed_f64};
use crate::types::TradeEconomics;
use serde::{Deserialize, Serialize};

/// The exact `DEFAULT_TRADE_ECONOMICS` constant.
///
/// Re-exported from [`crate::types`] (where it sits beside the struct) so a
/// caller looking for trade defaults finds them here rather than having to know
/// which module declares them.
pub use crate::types::DEFAULT_TRADE_ECONOMICS;

/// Derived, rounded analytics for a set of trade terms.
///
/// Field order here is the field order in `golden.json`'s `trade.analytics`.
/// Derived, rounded analytics for a set of trade terms.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeAnalytics {
    /// Headline expected present value.
    pub expected_pv: f64,
    /// Present value of the coupon leg.
    pub coupon_pv: f64,
    /// Present value charged for the down-and-in put.
    pub put_pv: f64,
    /// Redemption value, `98.5%` of notional under cash settlement.
    pub redemption: f64,
    /// Knock-in probability, percent, clamped to `4.0 ..= 55.0`.
    pub ki_probability: f64,
    /// Knock-out probability, percent, clamped to `25.0 ..= 85.0`.
    pub ko_probability: f64,
    /// Convergence half-width. Always `0.43`; see the module docs.
    pub ci_width: f64,
}

/// Derives the trade analytics panel from a set of terms.
///
/// Port of `deriveTradeAnalytics`. Every return value goes through
/// [`js_to_fixed_f64`] because the TypeScript writes `+(x).toFixed(p)` at each
/// site — see that function's docs for why [`crate::jsnum::round2`] would give
/// the wrong answer on at least one published preset.
///
/// ```
/// use fina_kernel::economics::{derive_trade_analytics, DEFAULT_TRADE_ECONOMICS};
///
/// let a = derive_trade_analytics(&DEFAULT_TRADE_ECONOMICS);
/// assert_eq!(a.expected_pv, 103.21);
/// assert_eq!(a.ki_probability, 22.1);
/// ```
#[must_use]
pub fn derive_trade_analytics(e: &TradeEconomics) -> TradeAnalytics {
    // Clamped, then used unrounded in `expected_pv` below. See module docs.
    let ki_probability = clamp(
        22.1 + (e.knock_in_barrier - 0.6) * 62.0 + (e.strike - 1.0) * 12.0,
        4.0,
        55.0,
    );
    let ko_probability = clamp(
        65.0 - (e.knock_out_barrier - 1.0) * 42.0 - (e.knock_in_barrier - 0.6) * 8.0,
        25.0,
        85.0,
    );

    let memory_factor = if e.memory_coupon_enabled { 1.05 } else { 0.9 };
    let coupon_pv = 11.6 * (e.coupon_rate / 0.12) * memory_factor * (e.maturity_years / 5.0);
    let put_pv = 7.2 + (e.knock_in_barrier - 0.6) * 34.0 + (e.strike - 1.0) * 18.0;
    let settlement_factor = if e.physical_settlement_enabled {
        1.0
    } else {
        0.985
    };
    let redemption = e.notional * settlement_factor;

    // Left-to-right, and with the *unrounded* `ki_probability`. Both matter.
    let expected_pv = redemption + coupon_pv
        - put_pv
        - (e.knock_out_barrier - 1.0) * 12.0
        - ki_probability * 0.08;

    // A convergence half-width that lost its path count: the ratio is pinned to
    // `REFERENCE / REFERENCE`, so it is exactly `1.0` and this collapses to
    // `0.43` for every input. The division is kept rather than folded to the
    // literal so the vestigial shape stays visible — `clippy::eq_op` is
    // therefore expected here and allowed for this expression alone.
    #[allow(
        clippy::eq_op,
        reason = "the self-division is the artifact being preserved"
    )]
    let ci_ratio = 100_000.0_f64 / 100_000.0;
    let ci_width = 0.43 * ci_ratio.sqrt();

    TradeAnalytics {
        expected_pv: js_to_fixed_f64(expected_pv, 2),
        coupon_pv: js_to_fixed_f64(coupon_pv, 2),
        put_pv: js_to_fixed_f64(put_pv, 2),
        redemption: js_to_fixed_f64(redemption, 2),
        ki_probability: js_to_fixed_f64(ki_probability, 1),
        ko_probability: js_to_fixed_f64(ko_probability, 1),
        ci_width: js_to_fixed_f64(ci_width, 2),
    }
}

/// The six named trade configurations, in `TRADE_PRESETS` order.
///
/// Serializes to the exact display strings the Trade Design panel renders.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PresetName {
    /// `DEFAULT_TRADE_ECONOMICS`, unmodified.
    #[serde(rename = "Base Case")]
    BaseCase,
    /// Tighter barriers, lower coupon.
    #[serde(rename = "Defensive Phoenix")]
    DefensivePhoenix,
    /// Wider barriers, higher coupon.
    #[serde(rename = "Aggressive Yield")]
    AggressiveYield,
    /// Deep knock-in, long knock-out, low coupon.
    #[serde(rename = "Deep Barrier")]
    DeepBarrier,
    /// 18% coupon with a raised coupon floor.
    #[serde(rename = "High Coupon")]
    HighCoupon,
    /// Deep knock-in, low coupon, cash-settled.
    #[serde(rename = "Capital Protected")]
    CapitalProtected,
}

impl PresetName {
    /// All presets, in declaration order.
    pub const ALL: [Self; 6] = [
        Self::BaseCase,
        Self::DefensivePhoenix,
        Self::AggressiveYield,
        Self::DeepBarrier,
        Self::HighCoupon,
        Self::CapitalProtected,
    ];

    /// The display label, e.g. `"Base Case"`.
    ///
    /// This string is what the frontend shows and what it persists; it is a UI
    /// contract, not a derived value.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::BaseCase => "Base Case",
            Self::DefensivePhoenix => "Defensive Phoenix",
            Self::AggressiveYield => "Aggressive Yield",
            Self::DeepBarrier => "Deep Barrier",
            Self::HighCoupon => "High Coupon",
            Self::CapitalProtected => "Capital Protected",
        }
    }

    /// Parses a display label back into a preset.
    #[must_use]
    pub fn from_label(label: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|p| p.label() == label)
    }
}

/// The preset table, in declaration order.
///
/// Each entry is `DEFAULT_TRADE_ECONOMICS` with the preset's overrides spread
/// over it, exactly as the TypeScript object literal does. The frontend keeps
/// its own copy for form defaults and `localStorage`; the two are asserted
/// equal against `golden.json`'s `trade.defaults` in `tests/analytics_parity.rs`,
/// so the duplication cannot drift unnoticed.
pub const TRADE_PRESETS: [(PresetName, TradeEconomics); 6] = [
    (PresetName::BaseCase, DEFAULT_TRADE_ECONOMICS),
    (
        PresetName::DefensivePhoenix,
        TradeEconomics {
            knock_in_barrier: 0.5,
            knock_out_barrier: 0.95,
            coupon_rate: 0.09,
            ..DEFAULT_TRADE_ECONOMICS
        },
    ),
    (
        PresetName::AggressiveYield,
        TradeEconomics {
            knock_in_barrier: 0.7,
            knock_out_barrier: 1.1,
            coupon_rate: 0.18,
            ..DEFAULT_TRADE_ECONOMICS
        },
    ),
    (
        PresetName::DeepBarrier,
        TradeEconomics {
            knock_in_barrier: 0.4,
            knock_out_barrier: 1.15,
            coupon_rate: 0.08,
            ..DEFAULT_TRADE_ECONOMICS
        },
    ),
    (
        PresetName::HighCoupon,
        TradeEconomics {
            coupon_rate: 0.18,
            coupon_lower_barrier: 0.8,
            knock_in_barrier: 0.65,
            ..DEFAULT_TRADE_ECONOMICS
        },
    ),
    (
        PresetName::CapitalProtected,
        TradeEconomics {
            knock_in_barrier: 0.3,
            coupon_rate: 0.06,
            physical_settlement_enabled: false,
            ..DEFAULT_TRADE_ECONOMICS
        },
    ),
];

/// Looks up one preset by name.
#[must_use]
pub fn preset(name: PresetName) -> TradeEconomics {
    TRADE_PRESETS.iter().find(|(n, _)| *n == name).map_or_else(
        || unreachable!("every PresetName has a TRADE_PRESETS entry"),
        |(_, t)| *t,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_terms_are_the_typescript_constant() {
        assert_eq!(DEFAULT_TRADE_ECONOMICS, TradeEconomics::default());
        assert_eq!(preset(PresetName::BaseCase), DEFAULT_TRADE_ECONOMICS);
    }

    #[test]
    fn default_terms_match_golden() {
        // Compared as text, because `serde_json::json!` would write `1` where
        // this serialises `1.0` and the two are distinct `Value`s even though
        // they are the same number. The golden fixture is checked against the
        // real file in `tests/analytics_parity.rs`.
        assert_eq!(
            serde_json::to_string(&DEFAULT_TRADE_ECONOMICS).unwrap(),
            concat!(
                r#"{"strike":1.0,"knockInBarrier":0.6,"knockOutBarrier":1.0,"#,
                r#""couponLowerBarrier":0.7,"couponUpperBarrier":1.2,"#,
                r#""couponRate":0.12,"memoryCouponEnabled":true,"#,
                r#""physicalSettlementEnabled":true,"maturityYears":5.0,"notional":100.0}"#
            )
        );
    }

    #[test]
    fn default_analytics_match_golden() {
        let a = derive_trade_analytics(&DEFAULT_TRADE_ECONOMICS);
        assert_eq!(a.expected_pv, 103.21);
        assert_eq!(a.coupon_pv, 12.18);
        assert_eq!(a.put_pv, 7.2);
        assert_eq!(a.redemption, 100.0);
        assert_eq!(a.ki_probability, 22.1);
        assert_eq!(a.ko_probability, 65.0);
        assert_eq!(a.ci_width, 0.43);
    }

    /// Each preset's full analytics row, transcribed from the TS source's
    /// arithmetic rather than read off the frontend.
    #[test]
    fn every_preset_matches_its_transcribed_analytics() {
        let expected: [(PresetName, [f64; 6]); 6] = [
            (
                PresetName::BaseCase,
                [103.21, 12.18, 7.2, 100.0, 22.1, 65.0],
            ),
            (
                PresetName::DefensivePhoenix,
                [104.66, 9.13, 3.8, 100.0, 15.9, 67.9],
            ),
            (
                PresetName::AggressiveYield,
                [104.21, 18.27, 10.6, 100.0, 28.3, 60.0],
            ),
            (
                PresetName::DeepBarrier,
                [105.14, 8.12, 0.4, 100.0, 9.7, 60.3],
            ),
            (
                PresetName::HighCoupon,
                [107.35, 18.27, 8.9, 100.0, 25.2, 64.6],
            ),
            (
                PresetName::CapitalProtected,
                [107.27, 6.09, -3.0, 98.5, 4.0, 67.4],
            ),
        ];
        for (name, [expected_pv, coupon_pv, put_pv, redemption, ki, ko]) in expected {
            let a = derive_trade_analytics(&preset(name));
            assert_eq!(
                (
                    a.expected_pv,
                    a.coupon_pv,
                    a.put_pv,
                    a.redemption,
                    a.ki_probability,
                    a.ko_probability
                ),
                (expected_pv, coupon_pv, put_pv, redemption, ki, ko),
                "preset {} diverged",
                name.label()
            );
            // ci_width is the same collapsed expression for every input.
            assert_eq!(a.ci_width, 0.43, "preset {}", name.label());
        }
    }

    /// The tie that separates `js_to_fixed_f64` from `round2`, reached through a
    /// real preset. If `derive_trade_analytics` ever switches to `round2`, this
    /// is the test that notices.
    #[test]
    fn defensive_phoenix_coupon_pv_is_a_tofixed_tie() {
        let raw = 11.6 * (0.09_f64 / 0.12) * 1.05 * (5.0 / 5.0);
        assert_eq!(js_to_fixed_f64(raw, 2), 9.13);
        assert_eq!(
            crate::jsnum::round2(raw),
            9.14,
            "the two primitives disagree here; that disagreement is the \
             reason this module uses js_to_fixed_f64"
        );
        assert_eq!(
            derive_trade_analytics(&preset(PresetName::DefensivePhoenix)).coupon_pv,
            9.13
        );
    }

    #[test]
    fn expected_pv_uses_unrounded_ki_probability() {
        // At ki = 0.37 the clamped probability is 7.84. Using the 1-decimal
        // value (7.8) instead moves expected_pv from 112.17 to 112.18.
        let terms = TradeEconomics {
            knock_in_barrier: 0.37,
            ..DEFAULT_TRADE_ECONOMICS
        };
        assert_eq!(derive_trade_analytics(&terms).expected_pv, 112.17);

        // Demonstrate the alternative really is different, so the test above
        // cannot silently become a no-op if the formula is rewritten.
        let coupon_pv = 12.18;
        let put_pv = 7.2 + (0.37_f64 - 0.6) * 34.0;
        let redemption = 100.0;
        let rounded = js_to_fixed_f64(
            redemption + coupon_pv - put_pv - 0.0 - js_to_fixed_f64(7.84_f64, 1) * 0.08,
            2,
        );
        assert_eq!(rounded, 112.18);
    }

    #[test]
    fn ki_probability_clamps_at_both_ends() {
        let at = |ki: f64| {
            derive_trade_analytics(&TradeEconomics {
                knock_in_barrier: ki,
                ..DEFAULT_TRADE_ECONOMICS
            })
            .ki_probability
        };
        // Below the floor: 22.1 + (0.0 - 0.6) * 62 = -10.1, clamped to 4.
        assert_eq!(at(0.0), 4.0);
        assert_eq!(at(0.2), 4.0);
        // Above the ceiling: 22.1 + (2.0 - 0.6) * 62 = 98.9, clamped to 55.
        assert_eq!(at(2.0), 55.0);
        assert_eq!(at(3.0), 55.0);
        // And the clamp is symmetric around it.
        assert_eq!(at(1.5), 55.0);
        assert_eq!(at(0.4), 9.7);
        assert_eq!(at(1.0), 46.9);
    }

    #[test]
    fn ko_probability_clamps_at_both_ends() {
        let at = |ko: f64| {
            derive_trade_analytics(&TradeEconomics {
                knock_out_barrier: ko,
                ..DEFAULT_TRADE_ECONOMICS
            })
            .ko_probability
        };
        assert_eq!(at(0.0), 85.0);
        assert_eq!(at(10.0), 25.0);
        assert_eq!(at(1.5), 44.0);
        assert_eq!(at(2.0), 25.0);
    }

    #[test]
    fn physical_settlement_knocks_a_cent_and_a_half_off_redemption() {
        let cash = derive_trade_analytics(&TradeEconomics {
            physical_settlement_enabled: false,
            ..DEFAULT_TRADE_ECONOMICS
        });
        assert_eq!(cash.redemption, 98.5);
        assert_eq!(cash.expected_pv, 101.71);
    }

    #[test]
    fn memory_coupon_discounts_the_coupon_leg() {
        let off = derive_trade_analytics(&TradeEconomics {
            memory_coupon_enabled: false,
            ..DEFAULT_TRADE_ECONOMICS
        });
        // 11.6 * 0.9 instead of 11.6 * 1.05
        assert_eq!(off.coupon_pv, 10.44);
    }

    /// Documented non-behaviour: no formula reads the coupon range.
    #[test]
    fn coupon_range_barriers_are_ignored() {
        let base = derive_trade_analytics(&DEFAULT_TRADE_ECONOMICS);
        let moved = derive_trade_analytics(&TradeEconomics {
            coupon_lower_barrier: 0.01,
            coupon_upper_barrier: 5.0,
            ..DEFAULT_TRADE_ECONOMICS
        });
        assert_eq!(base, moved);
    }

    #[test]
    fn ci_width_is_the_collapsed_constant() {
        // `100000 / 100000` is exactly 1.0, so `sqrt` is exactly 1.0 and the
        // product is exactly the literal. Verified bit-exactly rather than with
        // a tolerance, because that is the claim.
        #[allow(clippy::eq_op, reason = "the self-division is the artifact under test")]
        let ratio = 100_000.0_f64 / 100_000.0;
        assert_eq!(ratio, 1.0);
        assert_eq!(1.0_f64.sqrt(), 1.0);
        assert_eq!(0.43 * ratio.sqrt(), 0.43);
    }

    #[test]
    fn preset_names_round_trip_through_their_labels() {
        for name in PresetName::ALL {
            assert_eq!(PresetName::from_label(name.label()), Some(name));
            assert_eq!(
                serde_json::to_string(&name).unwrap(),
                format!("\"{}\"", name.label())
            );
        }
        assert_eq!(PresetName::from_label("base case"), None);
        assert_eq!(PresetName::from_label("Nope"), None);
    }

    #[test]
    fn preset_table_is_complete_and_ordered() {
        assert_eq!(TRADE_PRESETS.len(), PresetName::ALL.len());
        for (i, (name, _)) in TRADE_PRESETS.iter().enumerate() {
            assert_eq!(*name, PresetName::ALL[i]);
        }
    }

    #[test]
    fn every_preset_inherits_the_unchanged_fields_from_the_default() {
        for (name, terms) in TRADE_PRESETS {
            if name == PresetName::BaseCase {
                continue;
            }
            assert_eq!(terms.strike, DEFAULT_TRADE_ECONOMICS.strike, "{name:?}");
            assert_eq!(terms.notional, DEFAULT_TRADE_ECONOMICS.notional, "{name:?}");
            assert_eq!(
                terms.maturity_years, DEFAULT_TRADE_ECONOMICS.maturity_years,
                "{name:?}"
            );
            assert_eq!(
                terms.memory_coupon_enabled, DEFAULT_TRADE_ECONOMICS.memory_coupon_enabled,
                "{name:?}"
            );
            assert_eq!(
                terms.coupon_upper_barrier, DEFAULT_TRADE_ECONOMICS.coupon_upper_barrier,
                "{name:?}"
            );
        }
    }

    #[test]
    fn analytics_serialize_in_golden_field_order() {
        assert_eq!(
            serde_json::to_string(&derive_trade_analytics(&DEFAULT_TRADE_ECONOMICS)).unwrap(),
            concat!(
                r#"{"expectedPv":103.21,"couponPv":12.18,"putPv":7.2,"redemption":100.0,"#,
                r#""kiProbability":22.1,"koProbability":65.0,"ciWidth":0.43}"#
            )
        );
    }

    #[test]
    fn trade_economics_round_trips_through_json() {
        for (_, terms) in TRADE_PRESETS {
            let json = serde_json::to_string(&terms).unwrap();
            let back: TradeEconomics = serde_json::from_str(&json).unwrap();
            assert_eq!(back, terms);
        }
    }

    #[test]
    fn put_pv_goes_negative_where_the_linear_term_passes_zero() {
        let a = derive_trade_analytics(&TradeEconomics {
            knock_in_barrier: 0.3,
            ..DEFAULT_TRADE_ECONOMICS
        });
        assert_eq!(
            a.put_pv, -3.0,
            "documented artifact: preserved, not repaired"
        );
    }
}
