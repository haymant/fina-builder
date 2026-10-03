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

/// Rounds to 3 decimal places.
///
/// There is no longer a caller for this in `risk_engine`: the TypeScript writes
/// cross-gamma as `+(x).toFixed(3)`, which is [`js_to_fixed_f64`] with three
/// places, not this function. Kept because it is the natural companion to
/// [`round2`] and [`round4`] and is exercised directly by the conformance tests.
#[inline]
#[must_use]
pub fn round3(v: f64) -> f64 {
    js_round(v * 1.0e3) / 1.0e3
}

/// Rounds to 2 decimal places. The workhorse: money, payoffs, PV, discount
/// factors' present values, branch counts.
///
/// # Not a substitute for [`js_to_fixed_f64`]
///
/// Use this only where the TypeScript says `Math.round(x * 100) / 100`. Where
/// it says `+x.toFixed(2)` — which is everywhere in `economics`,
/// `risk_engine` and `diagnostics` — use [`js_to_fixed_f64`]; the two disagree
/// on ties and a published preset value is one of the casualties.
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

/// Replicates JavaScript `Number.prototype.toFixed`.
///
/// # Why this is not [`js_round`]
///
/// `toFixed` does **not** round the binary value; it rounds the number's
/// **exact decimal expansion**. The two disagree on real fixture data:
///
/// ```text
/// (0.1235).toFixed(1) === "12.3"   // after the *100, i.e. 12.349999999999999645
/// Math.round(12.35 * 10) / 10     === 12.4   <-- WRONG
/// ```
///
/// 35 of the 6,000 `worstOf` values in `golden.json` land on such a tie, so a
/// naive implementation silently corrupts the Node Details tiles.
///
/// # Semantics
///
/// Per ECMA-262: find the integer `n` for which `n / 10^places - |v|` is closest
/// to zero, **picking the larger `n` on a tie**. So ties round away from zero in
/// magnitude (`-0.25 -> "-0.3"`), and the sign is taken from `v < 0` — which
/// means `-0.0` formats as `"0.0"` while `-0.0001` formats as `"-0.00"`.
///
/// # Panics
/// Panics if `places > 17`, or if `|v|` is large enough that the result needs
/// more than 128 bits of integer part. Every call site in this crate formats a
/// percentage or a 2dp money amount, so neither can occur.
///
/// # Known divergence: magnitudes at or above 1e21
///
/// ECMA-262 has a special branch: when `x >= 10^21`, `toFixed` returns the
/// `Number::toString` form instead of positional digits. So JavaScript gives
/// `(1e30).toFixed(2) === "1e+30"`, while this function returns
/// `"1000000000000000019884624838656.00"`.
///
/// Reproducing the exponential form would require a shortest-round-trip
/// decimal formatter for the whole `f64` range — a large amount of machinery
/// for a case this crate cannot reach. Every value the kernel formats is a
/// percentage in `0..145` or a money amount under `1100`. The bound is asserted
/// in `tests/tofixed_conformance.rs` so the divergence stays visible rather than
/// being discovered later.
///
/// ```
/// use fina_kernel::jsnum::js_to_fixed;
/// assert_eq!(js_to_fixed(12.349_999_999_999_999, 1), "12.3");
/// assert_eq!(js_to_fixed(0.25, 1), "0.3");
/// assert_eq!(js_to_fixed(-0.25, 1), "-0.3");
/// assert_eq!(js_to_fixed(-0.0, 1), "0.0");
/// assert_eq!(js_to_fixed(-0.0001, 2), "-0.00");
/// assert_eq!(js_to_fixed(100.0, 2), "100.00");
/// ```
///
/// To get the **number** rather than the string — which is what `+x.toFixed(p)`
/// evaluates to — use [`js_to_fixed_f64`].
#[must_use]
pub fn js_to_fixed(v: f64, places: u32) -> String {
    assert!(
        places <= 17,
        "js_to_fixed supports up to 17 decimal places, got {places}"
    );

    if v.is_nan() {
        return "NaN".to_string();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }

    // Spec: the sign is derived from `v < 0`, so `-0.0` produces no sign.
    let neg = v < 0.0;
    let a = v.abs();

    // Exact decomposition: `a == mantissa * 2^exp` with no rounding.
    let (mantissa, exp) = decompose_f64(a);

    // The scaled integer `n == round(a * 10^places)`, computed exactly:
    // `a * 10^places == (mantissa * 10^places) * 2^exp`.
    let num = i128::from(mantissa) * 10i128.pow(places);
    let n: i128 = if exp >= 0 {
        let shift = u32::try_from(exp).expect("exp fits in u32");
        assert!(
            shift <= 60,
            "js_to_fixed: |{v}| is too large to format exactly (exp {exp})"
        );
        num << shift
    } else {
        // k = -exp. Beyond ~120 bits the quotient is always 0, since
        // `mantissa * 10^places < 2^60`.
        let k = i64::from(-exp);
        if k > 120 {
            0
        } else {
            let k = u32::try_from(k).expect("k fits in u32");
            let half = 1i128 << (k - 1);
            let divisor = 1i128 << k;
            // Ties round to the larger integer, matching "pick the larger n".
            (num + half) / divisor
        }
    };

    let digits = n.unsigned_abs().to_string();
    let places = places as usize;
    let text = if places == 0 {
        digits
    } else if digits.len() > places {
        let split = digits.len() - places;
        format!("{}.{}", &digits[..split], &digits[split..])
    } else {
        format!("0.{}{}", "0".repeat(places - digits.len()), digits)
    };

    // `neg` is already `v < 0.0`, which is false for `-0.0`, so `-0.0` formats
    // as `"0.0"` while `-0.0001` formats as `"-0.00"`. Exactly the spec.
    if neg {
        format!("-{text}")
    } else {
        text
    }
}

/// Splits a finite non-negative `f64` into `mantissa * 2^exp`, exactly.
fn decompose_f64(a: f64) -> (u64, i32) {
    let bits = a.to_bits();
    let raw_exp = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & ((1u64 << 52) - 1);
    if raw_exp == 0 {
        // Subnormal (or zero): no implicit leading bit.
        (frac, -1074)
    } else {
        (frac | (1u64 << 52), raw_exp - 1075)
    }
}

/// The numeric value of the JavaScript idiom `+(x).toFixed(places)`.
///
/// # This is not [`round2`], [`round3`] or [`round4`]
///
/// `+x.toFixed(p)` rounds the **exact decimal expansion** of the double and
/// then parses the result back, so its tie behaviour follows ECMA-262. The
/// `roundN` family instead scales by a power of ten in floating point, where
/// the scaling itself rounds. The two disagree whenever `x * 10^p` lands
/// exactly on a half — and the TypeScript in `economics`, `risk_engine` and
/// `diagnostics` uses the `toFixed` idiom at **every** output site.
///
/// The disagreement is not theoretical. `Defensive Phoenix`'s `couponPv`:
///
/// ```text
/// 11.6 * (0.09 / 0.12) * 1.05 * (5 / 5) == 9.1349999999999997868
/// round2(that)                          == 9.14   <-- WRONG
/// +(that).toFixed(2)                    == 9.13
/// ```
///
/// The exact value is below the tie, but `x * 100` rounds *up* to exactly
/// `913.5`, which `Math.round` then sends away from zero. Getting this wrong
/// changes a published preset's displayed coupon PV by a cent.
///
/// # Examples
///
/// ```
/// use fina_kernel::jsnum::js_to_fixed_f64;
/// assert_eq!(js_to_fixed_f64(9.134_999_999_999_999, 2), 9.13);
/// assert_eq!(js_to_fixed_f64(-0.25, 1), -0.3);
/// assert_eq!(js_to_fixed_f64(-0.0, 2), 0.0); // "+(-0.0)" is +0 in JS too
/// ```
///
/// # Known divergence: the sign of a zero result
///
/// When the rounded result is zero, this returns whatever sign `Number` would
/// give in JavaScript — which is **negative** if `v` is negative:
///
/// ```text
/// +(-0.0001).toFixed(2)  ==  -0     (the string is "-0.00")
/// ```
///
/// `serde_json` then writes `-0.0` where JavaScript's `JSON.stringify` writes
/// `0`. The two are the same number under `==`, so golden parity is unaffected;
/// only the serialised *text* differs. 5,961 of the 215,775 entries in the
/// differential corpus are in this position, and every Phase 3 module can reach
/// one through a negative sub-cent result — `theta = -notional * 0.012` for a
/// notional below `0.4167`, or `cross_gamma` from a small negative correlation.
///
/// **This is deliberately not normalised here.** The primitive's contract is to
/// be the honest `+x.toFixed(p)`, and in JavaScript that operation really does
/// produce `-0`. An adapter that needs byte-identical *text* with the frontend
/// should fold `-0.0` to `0.0` before serialising; that is a transport concern,
/// and it belongs in Phase 5's adapters rather than in a numeric primitive.
/// `tests/tofixed_conformance.rs` pins both halves of the claim.
///
/// # Panics
///
/// Panics under the same conditions as [`js_to_fixed`].
#[must_use]
pub fn js_to_fixed_f64(v: f64, places: u32) -> f64 {
    js_to_fixed(v, places)
        .parse::<f64>()
        .expect("js_to_fixed only ever emits a parseable decimal")
}

/// JavaScript `Math.min` over a slice. NaN propagates, unlike `f64::min`.
#[must_use]
pub fn js_min_slice(values: &[f64]) -> f64 {
    let mut iter = values.iter();
    let Some(mut acc) = iter.next().copied() else {
        return f64::NAN;
    };
    for v in iter {
        if v.is_nan() {
            return f64::NAN;
        }
        if *v < acc {
            acc = *v;
        }
    }
    acc
}

/// JavaScript `Math.max` over a slice. NaN propagates, unlike `f64::max`.
#[must_use]
pub fn js_max_slice(values: &[f64]) -> f64 {
    let mut iter = values.iter();
    let Some(mut acc) = iter.next().copied() else {
        return f64::NAN;
    };
    for v in iter {
        if v.is_nan() {
            return f64::NAN;
        }
        if *v > acc {
            acc = *v;
        }
    }
    acc
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
    js_max(lo, js_min(hi, v))
}

// `f64::max`/`f64::min` differ from JS `Math.max`/`Math.min` on NaN — Rust returns
// the non-NaN operand, JavaScript returns NaN — so the helpers are spelled out
// rather than reusing the stdlib methods. Argument order also matters for
// `-0.0`, which `Math.min(-0, 0)` resolves to `+0` while `f64::min` does not;
// the kernel's levels are all positive, so that case does not arise.

/// JavaScript `Math.max` for two arguments. NaN propagates.
#[inline]
#[must_use]
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a > b {
        a
    } else {
        b
    }
}

/// JavaScript `Math.min` for two arguments. NaN propagates.
#[inline]
#[must_use]
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a < b {
        a
    } else {
        b
    }
}

/// JavaScript `Math.min` for three arguments, i.e. `Math.min(a, b, c)`.
#[inline]
#[must_use]
pub fn js_min3(a: f64, b: f64, c: f64) -> f64 {
    js_min(a, js_min(b, c))
}

/// JavaScript `Math.floor(v)` as a `usize`, for the non-negative values the
/// generator produces (`rng() * 40` lands in `0..40`).
///
/// # Panics
/// Panics if `v` is negative, non-finite, or at or above `2^53` (past which an
/// `f64` can no longer represent consecutive integers, so truncation would not
/// equal flooring). The generator's inputs are `rng() * 40` and `rng() * 35`,
/// both in `[0, 40)`.
#[must_use]
pub fn js_floor_to_usize(v: f64) -> usize {
    assert!(
        (0.0..9_007_199_254_740_992.0).contains(&v),
        "js_floor_to_usize out of range: {v}"
    );
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let n = v.floor() as usize;
    n
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

    /// `Math.round(v * 10^p) / 10^p` for arbitrary `p`, so one table can cover
    /// `round1`, `round2` and `round3`.
    ///
    /// The bound is not a convenience: `js_to_fixed` rejects `places > 17`
    /// because 10^17 is already past `f64`'s exact-integer range, and
    /// `powi`/`js_to_fixed` would silently disagree out there.
    fn round_to(v: f64, places: u32) -> f64 {
        assert!(places <= 17, "beyond f64's exact-integer range");
        let scale = 10f64.powi(i32::try_from(places).unwrap());
        js_round(v * scale) / scale
    }

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

    // -----------------------------------------------------------------------
    // `js_to_fixed_f64`
    // -----------------------------------------------------------------------

    /// `js_to_fixed_f64` is defined as `Number(js_to_fixed(v, p))`, so the only
    /// thing worth asserting is that it really is that, for every shape the
    /// conformance corpus does not need a Node process to reach.
    #[test]
    fn js_to_fixed_f64_is_the_number_form_of_js_to_fixed() {
        let values = [
            0.0,
            -0.0,
            1.0,
            -1.0,
            0.005,
            0.015,
            0.025,
            0.045,
            0.055,
            0.065,
            0.085,
            0.095,
            -0.005,
            -0.015,
            -0.025,
            -0.045,
            0.1,
            0.2,
            1.0 / 3.0,
            2.0 / 3.0,
            9.134_999_999_999_999,
            12.349_999_999_999_999,
            100.0,
            -100.0,
            1.0e15,
            1.0e-7,
            -1.0e-7,
            f64::MIN_POSITIVE,
        ];
        for places in 0..=6 {
            for v in values {
                let want = js_to_fixed(v, places).parse::<f64>().unwrap();
                assert_eq!(
                    js_to_fixed_f64(v, places).to_bits(),
                    want.to_bits(),
                    "js_to_fixed_f64({v:?}, {places})"
                );
            }
        }
    }

    /// The tie that motivated the primitive, stated as a fact about the
    /// implementation rather than about a preset.
    ///
    /// The product's *exact* value sits below `9.135`; `v * 100` rounds up to
    /// exactly the tie; `Math.round` sends it away from zero. `js_to_fixed` never
    /// multiplies, so it never loses the information.
    #[test]
    fn js_to_fixed_f64_reads_the_exact_value_where_round2_reads_a_rounded_one() {
        let v = 11.6 * (0.09_f64 / 0.12) * 1.05;
        assert_eq!(js_to_fixed(v, 16), "9.1349999999999998");
        assert_eq!(v * 100.0, 913.5);
        assert_eq!(js_to_fixed_f64(v, 2), 9.13);
        assert_eq!(round2(v), 9.14);
    }

    /// The places where the two primitives disagree on *magnitude*, for a
    /// sample of the shapes Phase 3 produces. A small version of the corpus
    /// sweep, kept here so the primitive's contract is stated in the module that
    /// implements it. `tests/tofixed_conformance.rs` runs the full 215,775-case
    /// version and pins the count.
    #[test]
    fn round_family_disagrees_with_js_to_fixed_f64_on_ties() {
        // Positive ties. The double for `n.n5` is almost always *below* the tie,
        // so `toFixed` rounds down; `Math.round(v * 10^p)` has already rounded
        // the scaled product to exactly the tie and sends it up.
        for (v, tf, rn) in [
            (0.015_f64, 0.01, 0.02),
            (0.045, 0.04, 0.05),
            (0.075, 0.07, 0.08),
            (0.105, 0.1, 0.11),
            (1.045, 1.04, 1.05),
            (9.135, 9.13, 9.14),
        ] {
            assert_eq!(js_to_fixed_f64(v, 2), tf, "toFixed({v}, 2)");
            assert_eq!(round2(v), rn, "round2({v})");
        }

        // Not every tie diverges: `0.005` and `0.025` are the cases where the
        // double happens to land above the tie. Pin the agreement so a future
        // change to either primitive is caught here rather than in production.
        for v in [0.005_f64, 0.025, 0.035, 0.055, 0.065, 0.085, 0.095] {
            assert_eq!(
                js_to_fixed_f64(v, 2),
                round2(v),
                "toFixed({v}, 2) vs round2"
            );
        }

        // Negative ties diverge *more* dramatically, because `Math.round` sends
        // the tie toward positive infinity while `toFixed` reads the exact
        // expansion, which is below the tie's magnitude.
        for (v, tf, rn) in [(-0.25_f64, -0.3, -0.2), (-0.75, -0.8, -0.7)] {
            assert_eq!(js_to_fixed_f64(v, 1), tf, "toFixed({v}, 1)");
            assert_eq!(round1(v), rn, "round1({v})");
        }
        for (v, tf, rn) in [
            (-0.005_f64, -0.01, 0.0),
            (-0.025, -0.03, -0.02),
            (-0.055, -0.06, -0.05),
            (-0.125, -0.13, -0.12),
        ] {
            assert_eq!(js_to_fixed_f64(v, 2), tf, "toFixed({v}, 2)");
            assert_eq!(round2(v), rn, "round2({v})");
        }

        // Endless expansions: at these precisions the two agree, because neither
        // runs into a tie. Worth pinning, since a change that made `toFixed`
        // scale-and-round would *also* agree here — but would fail above.
        for v in [1.0 / 3.0, 2.0 / 3.0, 1.0 / 7.0] {
            for places in 1..=3 {
                assert_eq!(
                    js_to_fixed_f64(v, places),
                    round_to(v, places),
                    "{v} @{places}"
                );
            }
        }
    }

    /// Trailing zeros are structural in the *string* form and vanish in the
    /// numeric form, which is exactly why Phase 3 needed a numeric primitive.
    #[test]
    fn js_to_fixed_f64_discards_the_trailing_zeros_that_money_needs() {
        assert_eq!(js_to_fixed(100.0, 2), "100.00");
        assert_eq!(js_to_fixed_f64(100.0, 2), 100.0);
        assert_eq!(js_to_fixed(1.5, 2), "1.50");
        assert_eq!(js_to_fixed_f64(1.5, 2), 1.5);
        // So a Phase 3 module that wants `9.13` must ask for 2 places, not 2
        // places' worth of significant digits.
        assert_eq!(js_to_fixed_f64(9.134_999_999_999_999, 2), 9.13);
        assert_eq!(js_to_fixed(9.134_999_999_999_999, 3), "9.135");
    }
}
