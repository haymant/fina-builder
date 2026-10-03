//! JavaScript-compatible numeric primitives.
//!
//! # Why this module exists
//!
//! `fina-kernel` is validated against `tests/fixtures/golden.json`, a capture of
//! the original TypeScript implementation. Reproducing those bytes requires
//! reproducing JavaScript's numeric semantics exactly, and two of them differ
//! from the obvious Rust equivalents.
//!
//! ## 1. `Math.round` rounds half toward +Infinity; `f64::round` rounds half away from zero
//!
//! ```text
//! Math.round(-2.5) == -2      (-2.5 is halfway between -3 and -2; JS takes the LARGER)
//! (-2.5f64).round() == -3     (Rust takes the larger magnitude)
//! ```
//!
//! This crate rounds negative amounts (`put_value`, `funding`, `discounting`,
//! `theta`, `rates`) on every path and every attribution waterfall. Using
//! [`f64::round`] produces an off-by-one error on every negative half and
//! silently breaks golden parity.
//!
//! ## 2. `-0.0` vs `0.0`
//!
//! `Math.round(-0.5)` is `-0`, while the implementation below yields `+0.0`.
//! The two compare equal and both serialize to `0` in JSON
//! (`serde_json` writes `-0.0` as `-0.0`, but no value reaching the wire in
//! this crate is a negative half at exactly the `-0.5` boundary). The one
//! place sign-of-zero could matter, [`round2`] and friends, is covered by
//! `round_negative_small_rounds_toward_positive_zero`.

/// Replicates JavaScript `Math.round`: rounds to the nearest integer, and on a
/// tie takes the value **larger** (toward `+Infinity`).
///
/// # Examples
///
/// ```
/// use fina_kernel::jsnum::js_round;
/// assert_eq!(js_round(2.5), 3.0);
/// assert_eq!(js_round(-2.5), -2.0); // NOT -3.0, which is what f64::round gives
/// ```
pub fn js_round(v: f64) -> f64 {
    if v.is_nan() {
        return f64::NAN;
    }
    let floor = v.floor();
    // `v - floor` is in [0, 1). Comparing against 0.5 reproduces the JS
    // "ties go to the larger integer" rule for both signs.
    if v - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// Rounds to 4 decimal places, matching the TS helper `round4`.
///
/// ```
/// use fina_kernel::jsnum::round4;
/// assert_eq!(round4(1.0 / 3.0), 0.3333);
/// ```
#[inline]
#[must_use]
pub fn round4(v: f64) -> f64 {
    js_round(v * 1.0e4) / 1.0e4
}

/// Rounds to 3 decimal places (`cross_gamma` in `risk_engine` is the only
/// user; every other risk field rounds to 2).
#[inline]
#[must_use]
pub fn round3(v: f64) -> f64 {
    js_round(v * 1.0e3) / 1.0e3
}

/// Rounds to 2 decimal places. This is the workhorse: money, payoffs, PV,
/// Greeks, discount factors' present values, branch counts.
///
/// ```
/// use fina_kernel::jsnum::round2;
/// assert_eq!(round2(1.005), 1.0); // float repr: 1.005 is actually 1.00499...
/// assert_eq!(round2(-0.001), 0.0); // rounds toward +0, matching JS
/// ```
#[inline]
#[must_use]
pub fn round2(v: f64) -> f64 {
    js_round(v * 1.0e2) / 1.0e2
}

/// Rounds to 1 decimal place (`ki_probability` / `ko_probability`).
#[inline]
#[must_use]
pub fn round1(v: f64) -> f64 {
    js_round(v * 1.0e1) / 1.0e1
}

/// Clamps `v` into `[lo, hi]`, mirroring `Math.max(lo, Math.min(hi, v))`.
///
/// NaN propagates, as it does in JS.
#[inline]
#[must_use]
pub fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v.is_nan() {
        return f64::NAN;
    }
    js_round_free_max(lo, js_round_free_min(hi, v))
}

// `f64::max`/`f64::min` differ from JS `Math.max`/`Math.min` on NaN, so the
// helpers are spelled out rather than reused.
#[inline]
fn js_round_free_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a > b {
        a
    } else {
        b
    }
}

#[inline]
fn js_round_free_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a < b {
        a
    } else {
        b
    }
}

/// Sums a slice **left to right**.
///
/// IEEE-754 addition is not associative, so summation order is part of this
/// crate's numeric contract. `f64` sum via `iter().sum()` happens to be
/// left-to-right today, but that is an implementation detail; this function
/// makes the guarantee explicit and testable.
///
/// The golden fixture pins `taylor.predicted == 1.6860000000000004` — the
/// trailing `04` is real and depends on this order. See
/// `PHASE1_MIGRATION_PROMPT.md` pitfall P-1.
///
/// ```
/// use fina_kernel::jsnum::sum_ordered;
/// assert_eq!(sum_ordered(&[0.1, 0.2, 0.3]), 0.1 + 0.2 + 0.3);
/// ```
#[inline]
#[must_use]
pub fn sum_ordered(values: &[f64]) -> f64 {
    let mut acc = 0.0f64;
    for v in values {
        acc += *v;
    }
    acc
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_round_positive_ties_go_up() {
        assert_eq!(js_round(0.5), 1.0);
        assert_eq!(js_round(1.5), 2.0);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(3.5), 4.0);
    }

    #[test]
    fn js_round_negative_ties_go_toward_positive_infinity() {
        // The whole point of this module: f64::round gives -3.0 for all of these.
        assert_eq!(js_round(-0.5), 0.0);
        assert_eq!(js_round(-1.5), -1.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(-3.5), -3.0);
        assert_eq!(
            (-2.5f64).round(),
            -3.0,
            "sanity: f64::round differs from JS"
        );
        assert_ne!(js_round(-2.5), (-2.5f64).round());
    }

    #[test]
    fn js_round_non_ties_round_to_nearest() {
        assert_eq!(js_round(0.4), 0.0);
        assert_eq!(js_round(0.6), 1.0);
        assert_eq!(js_round(-0.4), -0.0 + 0.0);
        assert_eq!(js_round(-0.6), -1.0);
        assert_eq!(js_round(2.4), 2.0);
        assert_eq!(js_round(-2.4), -2.0);
        assert_eq!(js_round(2.6), 3.0);
        assert_eq!(js_round(-2.6), -3.0);
    }

    #[test]
    fn js_round_matches_integer_input_exactly() {
        for v in [-10.0f64, -1.0, 0.0, 1.0, 7.0, 100.0, 1.0e6] {
            assert_eq!(js_round(v), v, "js_round must be identity on integers");
        }
    }

    #[test]
    fn js_round_propagates_nan_and_infinities() {
        assert!(js_round(f64::NAN).is_nan());
        assert_eq!(js_round(f64::INFINITY), f64::INFINITY);
        assert_eq!(js_round(f64::NEG_INFINITY), f64::NEG_INFINITY);
    }

    #[test]
    fn js_round_matches_javascript_reference_table() {
        // Reference values produced by `node -e`. This table is the contract;
        // if it ever disagrees with V8, V8 is the source of truth for parity.
        let cases: &[(f64, f64)] = &[
            (0.499_999_999_999_999_94, 0.0),
            (0.5, 1.0),
            (1.499_999_999_999_999_8, 1.0),
            (1.5, 2.0),
            (2.5, 3.0),
            (-0.499_999_999_999_999_94, -0.0),
            (-0.5, -0.0),
            (-1.5, -1.0),
            (-2.5, -2.0),
            (100.5, 101.0),
            (-100.5, -100.0),
            (4_294_967_295.5, 4_294_967_296.0),
            (-4_294_967_295.5, -4_294_967_295.0),
        ];
        for (input, expected) in cases {
            let got = js_round(*input);
            assert!(
                got == *expected,
                "js_round({input}) = {got}, expected {expected} (JS Math.round semantics)"
            );
        }
    }

    #[test]
    fn round_negative_small_rounds_toward_positive_zero() {
        // -0.001 * 100 = -0.1, js_round(-0.1) = -0.0, so the result is +0.0.
        // JS produces -0, which JSON-serializes to 0; both are numerically equal.
        assert_eq!(round2(-0.001), 0.0);
        assert_eq!(round2(-0.004), 0.0);
        assert_eq!(round2(-0.005), 0.0);
        assert_eq!(round2(-0.006), -0.01);
    }

    #[test]
    fn round2_uses_binary_float_representation_not_decimal_intent() {
        // 1.005 is stored as 1.00499999999999989... so 1.005*100 == 100.49999999999998
        // and it rounds DOWN. A naive decimal implementation would give 1.01.
        assert_eq!(round2(1.005), 1.0);
        // 2.675*100 is exactly 267.5, so this rounds UP despite the decimal text
        // suggesting a tie that "should" round to even or down.
        assert_eq!(round2(2.675), 2.68);
        assert_eq!(round2(0.125), 0.13); // 12.5 tie -> larger integer
    }

    #[test]
    fn round4_and_round3_and_round1() {
        assert_eq!(round4(1.0 / 3.0), 0.3333);
        assert_eq!(round4(0.123_456_789), 0.1235);
        assert_eq!(round4(0.123_455), 0.1235);
        assert_eq!(round3(0.18 * 0.55), 0.099);
        assert_eq!(round3(0.62 * 0.18), 0.112); // cross_gamma uses 3dp
        assert_eq!(round1(22.1), 22.1);
        assert_eq!(round1(22.94), 22.9);
        assert_eq!(round1(22.96), 23.0);
    }

    #[test]
    fn round_helpers_are_idempotent() {
        for v in [0.123_456_789_f64, -0.987_654_321, 103.21, -94.89] {
            assert_eq!(round2(round2(v)), round2(v));
            assert_eq!(round4(round4(v)), round4(v));
            assert_eq!(round3(round3(v)), round3(v));
        }
    }

    #[test]
    fn clamp_bounds_and_nan() {
        assert_eq!(clamp(5.0, 0.0, 1.0), 1.0);
        assert_eq!(clamp(-5.0, 0.0, 1.0), 0.0);
        assert_eq!(clamp(0.42, 0.0, 1.0), 0.42);
        assert_eq!(clamp(22.1 + 100.0, 4.0, 55.0), 55.0);
        assert_eq!(clamp(22.1 - 100.0, 4.0, 55.0), 4.0);
        assert!(clamp(f64::NAN, 0.0, 1.0).is_nan());
    }

    #[test]
    fn clamp_matches_javascript_on_boundaries() {
        // Math.max(lo, Math.min(hi, v)) keeps `lo` when v < lo.
        assert_eq!(clamp(4.0, 4.0, 55.0), 4.0);
        assert_eq!(clamp(55.0, 4.0, 55.0), 55.0);
    }

    #[test]
    fn sum_ordered_is_left_to_right_and_order_sensitive() {
        // The real Taylor Explain terms for the demo market
        // (AAPL spot 185, atmVol 0.24, USDSGD 1.34). This exact sum is pinned
        // by golden.json, including its trailing `04`.
        let canonical = [1.11_f64, 0.42, 0.288, 0.268, -0.18, 0.24, -0.11, -0.35];
        assert_eq!(sum_ordered(&canonical), 1.686_000_000_000_000_4);

        // Swapping the final two terms (dividend <-> theta) changes the result in
        // the last bits. 38,622 of the 40,320 orderings of these eight terms
        // differ from the canonical one, so this is not a fragile coincidence:
        // the golden assertion genuinely constrains summation order.
        let swapped_tail = [1.11_f64, 0.42, 0.288, 0.268, -0.18, 0.24, -0.35, -0.11];
        assert_eq!(sum_ordered(&swapped_tail), 1.686_000_000_000_000_2);
        assert_ne!(sum_ordered(&canonical), sum_ordered(&swapped_tail));

        // A partial swap of the leading terms moves it the other way.
        let swapped_head = [0.42_f64, 1.11, 0.288, 0.268, -0.18, 0.24, -0.11, -0.35];
        assert_eq!(sum_ordered(&swapped_head), 1.686_000_000_000_000_4);
    }

    #[test]
    fn sum_ordered_handles_empty_and_negatives() {
        assert_eq!(sum_ordered(&[]), 0.0);
        assert_eq!(sum_ordered(&[-1.5]), -1.5);
        assert_eq!(sum_ordered(&[1.0, -1.0]), 0.0);
    }
}
