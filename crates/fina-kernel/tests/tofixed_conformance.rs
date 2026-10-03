//! Differential test: `js_to_fixed` against JavaScript `toFixed`.
//!
//! Run with:
//!
//! ```text
//! node scripts/generate-tofixed-cases.mjs
//! node scripts/extend-tofixed-cases.mjs
//! cargo test -p fina-kernel --test tofixed_conformance -- --ignored
//! ```
//!
//! The corpus is ~132,000 entries covering:
//!
//! - every distinct value the real kernel formats (from `golden.json`)
//! - an exhaustive sweep of 4-decimal values ending in `5` (every `toFixed`
//!   tie position), in both signs, plus the `pct()` `v * 100` form
//! - an exhaustive 3-decimal sweep at 1 and 2 decimal places
//! - 60,000 pseudo-random doubles across 8 orders of magnitude
//! - every value `economics`, `risk_engine` and `diagnostics` can format: the
//!   six presets' analytics, the risk engine's outputs, the demo market's
//!   synthetic history, and the MC series (added in Phase 3 by
//!   `extend-tofixed-cases.mjs`)
//!
//! A naive `Math.round(v * 10^p) / 10^p` implementation fails this corpus on
//! **2,256** entries, landing on a different *number*. That is the only evidence
//! that the exact-rational approach is right and that `js_to_fixed_f64` is
//! needed separately from `round2`. A further **4,457** entries differ only in
//! the sign of a zero result, which is a separate and documented divergence.
//!
//! Values are stored as **raw IEEE-754 bit patterns**, not decimals. Adjacent
//! doubles such as `0.45` and `0.44999999999999996` round-trip through decimal
//! JSON ambiguously, which previously produced corpus entries that appeared to
//! contradict each other. Storing bits makes it impossible for the corpus and
//! the implementation to disagree about which value is under test.
//!
//! The differential test is `#[ignore]`d by default because regenerating the
//! corpus needs Node. The structural tests below run always.
//! PHASE1_MIGRATION_PROMPT.md section 6 wires the ignored test into CI.

// `excessive_precision` fires on `9.134_999_999_999_999`, but not because the
// literal names a different double than `9.135` — it names the *same* one, since
// that is the shortest round-tripping form. It fires because the literal is
// written out in longhand on purpose: `toFixed` reads the value's exact decimal
// expansion (`9.1349999999999997868…`, strictly below the tie) rather than its
// shortest representation, and the whole point of the test below is to pin the
// two apart. Truncating the literal would erase the only thing it is there to
// say.
#![allow(clippy::excessive_precision)]

use fina_kernel::diagnostics::{final_mc, mc_diagnostics, mc_efficiency};
use fina_kernel::economics::{derive_trade_analytics, DEFAULT_TRADE_ECONOMICS};
use fina_kernel::jsnum::{js_to_fixed, js_to_fixed_f64, round2};
use fina_kernel::risk_engine::compute_risk;
use fina_kernel::types::MarketSnapshot;
use serde::Deserialize;

/// One `[valueBitsHex, places, jsResult]` triple.
#[derive(Debug, Deserialize)]
struct Case {
    /// Big-endian hex IEEE-754 bit pattern of the value under test.
    #[serde(rename = "0")]
    bits: String,
    /// `toFixed` precision.
    #[serde(rename = "1")]
    places: u32,
    /// What JavaScript produced.
    #[serde(rename = "2")]
    expected: String,
}

impl Case {
    /// Reconstructs the exact double from its bit pattern.
    fn value(&self) -> f64 {
        let n = u64::from_str_radix(&self.bits, 16)
            .unwrap_or_else(|e| panic!("bad bit pattern {:?}: {e}", self.bits));
        f64::from_bits(n)
    }
}

const CORPUS: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/tofixed-cases.json"
);

fn load() -> Vec<Case> {
    let raw = std::fs::read_to_string(CORPUS).unwrap_or_else(|e| {
        panic!("corpus missing at {CORPUS}: {e}\nrun: node scripts/generate-tofixed-cases.mjs")
    });
    serde_json::from_str(&raw).expect("corpus is valid JSON")
}

#[test]
#[ignore = "requires `node scripts/generate-tofixed-cases.mjs` (see module docs)"]
fn js_to_fixed_matches_javascript_across_the_differential_corpus() {
    let cases = load();
    assert!(cases.len() > 60_000, "corpus too small: {}", cases.len());

    let mut failures: Vec<String> = Vec::new();
    let mut checked = 0usize;
    for c in &cases {
        checked += 1;
        let value = c.value();
        let got = js_to_fixed(value, c.places);
        if got != c.expected {
            failures.push(format!(
                "js_to_fixed({:?} /* {} */, {}) = {:?}, JavaScript gives {:?}",
                value, c.bits, c.places, got, c.expected
            ));
            if failures.len() == 25 {
                break;
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {checked} cases diverged from JavaScript:\n  {}",
        failures.len(),
        failures.join("\n  ")
    );
}

/// The same corpus, run through [`js_to_fixed_f64`] — the primitive that the
/// `+x.toFixed(p)` sites in `economics`, `risk_engine` and `diagnostics` use.
///
/// This is the test that would have caught the Phase 3 defect. Running the
/// corpus through `round2` instead fails 2,256 entries, one of which is
/// `Defensive Phoenix`'s published `couponPv`.
#[test]
#[ignore = "requires `node scripts/generate-tofixed-cases.mjs` (see module docs)"]
fn js_to_fixed_f64_matches_javascript_across_the_differential_corpus() {
    let cases = load();
    assert!(cases.len() > 60_000, "corpus too small: {}", cases.len());

    let mut failures: Vec<String> = Vec::new();
    let mut checked = 0usize;
    for c in &cases {
        checked += 1;
        let value = c.value();
        // The corpus stores the *string* JavaScript produced, so recover the
        // number the `+` unary operator would have produced from it.
        let got = js_to_fixed_f64(value, c.places);
        let expected: f64 = c
            .expected
            .parse()
            .unwrap_or_else(|e| panic!("corpus entry {:?} is unparseable: {e}", c.expected));
        // Compare bit patterns: `-0.0` and `0.0` are equal as numbers but the
        // `+` operator preserves the sign, and the kernel's contract is exactness.
        if got.to_bits() != expected.to_bits() {
            failures.push(format!(
                "js_to_fixed_f64({:?} /* {} */, {}) = {:?}, JavaScript's `+x.toFixed({})` gives {:?}",
                value, c.bits, c.places, got, c.places, expected
            ));
            if failures.len() == 25 {
                break;
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {checked} cases diverged from JavaScript:\n  {}",
        failures.len(),
        failures.join("\n  ")
    );
}

/// `round2`/`round1`/`round3` are **not** substitutes for `js_to_fixed_f64`, and
/// the corpus quantifies by how much.
///
/// Two distinct divergences are counted, because they have different
/// consequences:
///
/// - **digits.** `Math.round(v * 10^p) / 10^p` lands on a different *number*.
///   This is the defect `js_to_fixed_f64` exists to prevent, and one of these
///   cases is `Defensive Phoenix`'s published `couponPv`.
/// - **sign of zero.** The two agree in magnitude but not in the sign of zero:
///   `+(-0.0001).toFixed(2)` is `-0`, `Math.round(-0.01) / 100` is `+0`. Equal
///   under `==`, distinguishable by `Object.is`, and collapsed to `0` by
///   `JSON.stringify`. See [`js_to_fixed_f64_renders_negative_zero_as_javascript_does`].
#[test]
fn the_corpus_discriminates_js_to_fixed_f64_from_the_round_family() {
    let cases = load();

    let mut digits = 0usize;
    let mut sign_of_zero = 0usize;
    let mut examples = Vec::new();
    for c in &cases {
        let value = c.value();
        let expected: f64 = c.expected.parse().expect("corpus entry parses");
        let naive = round_to_places(value, c.places);
        if naive.to_bits() == expected.to_bits() {
            continue;
        }
        if naive == 0.0 && expected == 0.0 {
            sign_of_zero += 1;
        } else {
            digits += 1;
            if examples.len() < 5 {
                examples.push(format!(
                    "{value:?} at {} places: Math.round(v * 10^p) gives {naive}, \
                     `+v.toFixed(p)` gives {expected}",
                    c.places
                ));
            }
        }
    }

    assert!(
        digits > 1_000,
        "the corpus no longer discriminates the two primitives ({digits} digit cases); \
         a sweep must have been dropped"
    );
    // Both exact counts are quoted in the module docs and in Appendix D. If
    // either fires, the corpus or the docs need updating — deliberately so.
    assert_eq!(
        digits,
        2_256,
        "digit-discriminating count changed; module docs and Appendix D quote it\n  {}",
        examples.join("\n  ")
    );
    assert_eq!(
        sign_of_zero, 4_457,
        "sign-of-zero count changed; module docs and Appendix D quote it"
    );
}

/// The sign-of-zero divergence, stated as a concrete reachable case.
///
/// `theta` is `-notional * 0.012`. Below a notional of `0.4167` that is a
/// negative value smaller than half a cent, so `+(x).toFixed(2)` is `"-0.00"`,
/// which parses back to `-0.0`. JavaScript's `JSON.stringify` writes that as
/// `0`; `serde_json` writes `-0.0`. The two are the same number under `==`, so
/// golden parity is unaffected, but the *text* on the wire differs.
///
/// This is documented rather than fixed, and the reason is worth stating: the
/// fix belongs at the serialisation boundary in Phase 5's adapters, not inside a
/// numeric primitive. `js_to_fixed_f64`'s job is to be the honest
/// `+x.toFixed(p)`, and in JavaScript that operation genuinely produces `-0`.
/// An adapter that needs JS-identical text should fold `-0.0` to `0.0` before
/// serialising.
#[test]
fn js_to_fixed_f64_renders_negative_zero_as_javascript_does() {
    // The value: a tiny notional makes theta a negative sub-cent amount.
    let notional = 0.01_f64;
    let theta_raw = -notional * 0.012;
    assert!(theta_raw < 0.0 && theta_raw > -0.005);

    assert_eq!(js_to_fixed(theta_raw, 2), "-0.00");
    let theta = js_to_fixed_f64(theta_raw, 2);
    assert_eq!(theta, 0.0, "a negative zero equals zero");
    assert!(
        theta.is_sign_negative(),
        "js_to_fixed_f64 is bit-exact with `+x.toFixed(p)`, which yields -0 here"
    );

    // The `round2` family yields the *opposite* sign, which is the other half of
    // the divergence. Both compare equal; only the text and `is_sign_negative`
    // tell them apart.
    assert!(!round2(theta_raw).is_sign_negative());

    // `cross_gamma` reaches it too, from a small negative correlation.
    let raw = -1.0e-4 * 0.18;
    assert!(js_to_fixed_f64(raw, 3).is_sign_negative());

    // And this is the whole extent of the problem: a notional of `0.4167` or
    // more makes theta a real negative number rather than a negative zero.
    for notional in [0.5, 1.0, 10.0, 100.0, 150.0, 1_000.0, 1_000_000.0] {
        let theta = js_to_fixed_f64(-notional * 0.012, 2);
        assert_ne!(theta, 0.0, "notional {notional} should give a real value");
    }
}

/// `Math.round(v * 10^p) / 10^p`, for any `p` — the shape of [`round2`] and
/// friends, generalised so one corpus can test all three precisions.
///
/// `js_to_fixed` rejects `places > 17`, since 10^17 is past `f64`'s exact-integer
/// range; the bound here keeps the two primitives from being compared on ground
/// where they are not comparable.
fn round_to_places(v: f64, places: u32) -> f64 {
    assert!(places <= 17, "beyond f64's exact-integer range");
    let scale = 10f64.powi(i32::try_from(places).unwrap());
    fina_kernel::jsnum::js_round(v * scale) / scale
}

/// The specific tie that separates the two primitives, reached through a
/// published preset.
///
/// `Defensive Phoenix`'s `couponPv` is `11.6 * (0.09 / 0.12) * 1.05`. That product
/// is the double whose shortest round-tripping form is `9.135` but whose
/// *exact* value is `9.1349999999999997868371792719699…` — strictly below the
/// `9.135` boundary. `toFixed` reads the exact value, so it rounds down to
/// `9.13`.
///
/// `Math.round(v * 100) / 100` never sees that exact value. The multiplication
/// `v * 100` rounds *up* in IEEE-754 to exactly `913.5`, and `Math.round` then
/// sends the tie away from zero to `914`, giving `9.14`. One cent apart, and the
/// information was destroyed by the scaling step, not by the rounding step.
#[test]
fn the_defensive_phoenix_tie_is_in_the_corpus() {
    let raw = 11.6 * (0.09_f64 / 0.12) * 1.05 * (5.0_f64 / 5.0);

    // The exact decimal expansion is below the tie. `toFixed(16)` is the widest
    // faithful window onto it that stays inside `toFixed`'s exact-decimal range.
    assert_eq!(js_to_fixed(raw, 16), "9.1349999999999998");
    assert_eq!(js_to_fixed(raw, 2), "9.13");

    // The scaling step is where the divergence is born: the product is exactly
    // the tie, even though the value is not.
    assert_eq!(raw * 100.0, 913.5);
    assert_eq!(raw * 1000.0, 9135.0);
    assert_eq!(round2(raw), 9.14);

    let cases = load();
    let entry = cases
        .iter()
        .find(|c| c.places == 2 && c.value().to_bits() == raw.to_bits())
        .expect("the Defensive Phoenix tie must be in the corpus");
    assert_eq!(entry.expected, "9.13");

    // And it must actually be discriminating, or the entry proves nothing.
    assert_ne!(round_to_places(raw, 2), 9.13);
}

/// The corpus must genuinely exercise the tie positions. If a future
/// regeneration silently dropped the exhaustive sweep, the differential test
/// would still pass while proving far less.
#[test]
fn corpus_contains_the_tofixed_tie_positions() {
    let cases = load();
    assert!(cases.len() > 60_000, "corpus too small: {}", cases.len());

    // `0.45` itself sits just *above* the 0.45 boundary and rounds UP; the
    // double produced by `0.0045 * 100` is its neighbour just *below* and rounds
    // DOWN. Both are ties, and they must disagree.
    let up = cases
        .iter()
        .find(|c| c.places == 1 && c.value() == 0.45)
        .expect("corpus must contain 0.45 at 1 place");
    let down = cases
        .iter()
        .find(|c| c.places == 1 && c.value() == 0.0045 * 100.0)
        .expect("corpus must contain 0.0045 * 100 at 1 place");

    assert_ne!(
        up.value(),
        down.value(),
        "these must be adjacent doubles, not the same value"
    );
    assert_eq!(up.expected, "0.5", "0.45 rounds up");
    assert_eq!(down.expected, "0.4", "0.44999999999999996 rounds down");

    // A naive implementation would return "0.5" for both, so this pair is the
    // load-bearing evidence that `js_to_fixed` is exact.
    assert_ne!(up.expected, down.expected);
}

/// Every value the kernel actually formats is in the corpus, so a regression in
/// the real domain data cannot hide behind a corpus that never tested it.
#[test]
fn corpus_covers_every_value_the_kernel_formats() {
    // Index the corpus by (bits, places) first. A linear scan per lookup would
    // make this O(values x corpus) and take minutes.
    let cases = load();
    let index: std::collections::HashSet<(u64, u32)> = cases
        .iter()
        .map(|c| {
            (
                u64::from_str_radix(&c.bits, 16).expect("valid hex bit pattern"),
                c.places,
            )
        })
        .collect();
    let present = |v: f64, p: u32| index.contains(&(v.to_bits(), p));

    let golden = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/golden.json"
    ))
    .expect("golden.json is committed");
    let g: serde_json::Value = serde_json::from_str(&golden).unwrap();
    let paths = g["simulationBundle"]["paths"].as_array().unwrap();

    let mut missing = Vec::new();
    for (i, path) in paths.iter().enumerate() {
        // 2dp: every money amount the kernel formats.
        let mut money = vec![
            path["payoff"].as_f64().unwrap(),
            path["couponValue"].as_f64().unwrap(),
            path["putValue"].as_f64().unwrap(),
            path["memoryCouponValue"].as_f64().unwrap(),
            path["redemptionValue"].as_f64().unwrap(),
        ];
        for key in [
            "parRedemption",
            "coupon",
            "memoryCoupon",
            "downAndInPut",
            "funding",
            "discounting",
            "totalPv",
        ] {
            money.push(path["attribution"][key].as_f64().unwrap());
        }
        for v in money {
            if !present(v, 2) {
                missing.push(format!("paths[{i}] {v:?} at 2 places"));
            }
        }

        // 1dp: the `pct()` input, i.e. worst-of level x 100.
        for w in path["worstOfPerformance"].as_array().unwrap() {
            let pct_input = w.as_f64().unwrap() * 100.0;
            if !present(pct_input, 1) {
                missing.push(format!("paths[{i}] pct input {pct_input:?} at 1 place"));
            }
        }
    }

    assert!(
        missing.is_empty(),
        "{} formatted values from golden.json are absent from the toFixed corpus:\n  {}",
        missing.len(),
        missing
            .iter()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n  ")
    );
}

/// The Phase 3 counterpart of the test above: every number `economics`,
/// `risk_engine` and `diagnostics` puts on the wire must be a value the corpus
/// has already been shown JavaScript agrees with.
///
/// The corpus holds *raw* pre-rounding values, so the check is inverted — it
/// asserts that each emitted number appears as some corpus entry's expected
/// string at the precision the module formats to. That proves the emitted value
/// came from a JavaScript-verified `toFixed`, not merely that it looks plausible.
#[test]
fn corpus_covers_every_value_phase_three_emits() {
    let cases = load();
    let covered: std::collections::HashSet<(u32, String)> = cases
        .iter()
        .map(|c| (c.places, c.expected.clone()))
        .collect();
    let is_covered = |v: f64, p: u32| covered.contains(&(p, js_to_fixed(v, p)));

    let mut missing = Vec::new();
    let mut check = |v: f64, p: u32, what: &str| {
        if !is_covered(v, p) {
            missing.push(format!("{what} = {v:?} at {p} places"));
        }
    };

    // economics: all seven fields, for all six presets.
    for (name, terms) in fina_kernel::economics::TRADE_PRESETS {
        let a = derive_trade_analytics(&terms);
        let label = name.label();
        check(a.expected_pv, 2, &format!("{label}.expectedPv"));
        check(a.coupon_pv, 2, &format!("{label}.couponPv"));
        check(a.put_pv, 2, &format!("{label}.putPv"));
        check(a.redemption, 2, &format!("{label}.redemption"));
        check(a.ki_probability, 1, &format!("{label}.kiProbability"));
        check(a.ko_probability, 1, &format!("{label}.koProbability"));
        check(a.ci_width, 2, &format!("{label}.ciWidth"));
    }

    // risk_engine: seven scalars, six buckets and two cross-gammas.
    let market = MarketSnapshot::demo();
    let risk = compute_risk(&DEFAULT_TRADE_ECONOMICS, &market).unwrap();
    for (label, v) in [
        ("pv", risk.pv),
        ("delta", risk.delta),
        ("gamma", risk.gamma),
        ("vega", risk.vega),
        ("theta", risk.theta),
        ("rho", risk.rho),
        ("fxDelta", risk.fx_delta),
    ] {
        check(v, 2, &format!("risk.{label}"));
    }
    for b in &risk.bucket_vegas {
        check(b.value, 2, &format!("risk.bucketVegas[{}]", b.bucket));
    }
    for c in &risk.cross_gamma {
        check(c.value, 3, &format!("risk.crossGamma[{}]", c.pair));
    }

    // diagnostics: ten rows plus the final row.
    for row in mc_diagnostics() {
        let p = row.paths;
        for (label, v, dp) in [
            ("pv", row.pv, 2),
            ("se", row.se, 3),
            ("lower", row.lower, 2),
            ("upper", row.upper, 2),
            ("p05", row.p05, 2),
            ("p50", row.p50, 2),
            ("p95", row.p95, 2),
        ] {
            check(v, dp, &format!("mc[{p}].{label}"));
        }
    }
    // `ki` and `ko` are literals, never formatted; assert they stay that way.
    for row in mc_diagnostics() {
        assert!(
            row.ki > 0.0 && row.ko > 0.0,
            "literals must not be reformatted"
        );
    }

    // The efficiency table is pure strings and integers — nothing to format.
    assert_eq!(mc_efficiency().len(), 4);
    assert_eq!(final_mc().paths, 1_000_000);

    assert!(
        missing.is_empty(),
        "{} Phase 3 values are absent from the toFixed corpus:\n  {}",
        missing.len(),
        missing
            .iter()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n  ")
    );
}

/// The demo market's synthetic history, which `types::MarketSnapshot::demo`
/// builds through `js_to_fixed_f64` exactly as the TypeScript store does.
///
/// Not part of the wire contract in Phase 1 — the Market & Risk tile reads its
/// own `localStorage` — but `demo()` is the canonical market the CLI and the
/// tests use, so its bars must be right.
#[test]
fn corpus_covers_the_demo_market_history() {
    let cases = load();
    let covered: std::collections::HashSet<(u32, String)> = cases
        .iter()
        .map(|c| (c.places, c.expected.clone()))
        .collect();

    let mut missing = Vec::new();
    let mut bars = 0usize;
    for u in &MarketSnapshot::demo().underlyings {
        assert_eq!(
            u.historical_prices.len(),
            36,
            "{} must have the store's 36 bars",
            u.symbol
        );
        for bar in &u.historical_prices {
            bars += 1;
            for (field, v) in [
                ("open", bar.open),
                ("high", bar.high),
                ("low", bar.low),
                ("close", bar.close),
            ] {
                if !covered.contains(&(2, js_to_fixed(v, 2))) {
                    missing.push(format!(
                        "{}.{}[{}].{field} = {v:?}",
                        u.symbol, bar.date, field
                    ));
                }
            }
        }
    }
    assert_eq!(bars, 108, "3 underlyings x 36 bars");

    assert!(
        missing.is_empty(),
        "{} demo-market prices are absent from the toFixed corpus:\n  {}",
        missing.len(),
        missing
            .iter()
            .take(20)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n  ")
    );
}

#[test]
fn js_to_fixed_rejects_out_of_range_precision() {
    let e = std::panic::catch_unwind(|| js_to_fixed(1.0, 18));
    assert!(
        e.is_err(),
        "places > 17 must panic, not silently mis-format"
    );
}

#[test]
fn js_to_fixed_handles_special_values() {
    assert_eq!(js_to_fixed(f64::NAN, 2), "NaN");
    assert_eq!(js_to_fixed(f64::INFINITY, 2), "Infinity");
    assert_eq!(js_to_fixed(f64::NEG_INFINITY, 2), "-Infinity");
}

#[test]
fn js_to_fixed_rejects_values_too_large_to_format_exactly() {
    // 1e30 still fits in 128 bits of integer part, so it is formatted positionally.
    // JavaScript takes its `x >= 1e21` branch and returns "1e+30" instead; that
    // divergence is documented on `js_to_fixed` and unreachable from this domain.
    assert_eq!(js_to_fixed(1e30, 2), "1000000000000000019884624838656.00");

    // 1e300 needs a ~1000-bit shift, so the guard must reject it rather than
    // silently truncate.
    let e = std::panic::catch_unwind(|| js_to_fixed(1e300, 2));
    assert!(
        e.is_err(),
        "very large magnitudes must panic rather than drift"
    );
}
