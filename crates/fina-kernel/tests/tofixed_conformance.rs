//! Differential test: `js_to_fixed` against JavaScript `toFixed`.
//!
//! Run with:
//!
//! ```text
//! node scripts/generate-tofixed-cases.mjs
//! cargo test -p fina-kernel --test tofixed_conformance -- --ignored
//! ```
//!
//! The corpus is ~445,000 entries covering:
//!
//! - every distinct value the real kernel formats (from `golden.json`)
//! - an exhaustive sweep of 4-decimal values ending in `5` (every `toFixed`
//!   tie position), in both signs, plus the `pct()` `v * 100` form
//! - an exhaustive 3-decimal sweep at 1 and 2 decimal places
//! - 60,000 pseudo-random doubles across 8 orders of magnitude
//!
//! A naive `Math.round(v * 10^p) / 10^p` implementation fails this corpus, so
//! it is the only evidence that the exact-rational approach is right.
//!
//! Values are stored as **raw IEEE-754 bit patterns**, not decimals. Adjacent
//! doubles such as `0.45` and `0.44999999999999996` round-trip through decimal
//! JSON ambiguously, which previously produced corpus entries that appeared to
//! contradict each other. Storing bits makes it impossible for the corpus and
//! the implementation to disagree about which value is under test.
//!
//! The differential test is `#[ignore]`d by default because regenerating the
//! corpus needs Node. The structural test below runs always.
//! PHASE1_MIGRATION_PROMPT.md section 6 wires the ignored test into CI.

use fina_kernel::jsnum::js_to_fixed;
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
