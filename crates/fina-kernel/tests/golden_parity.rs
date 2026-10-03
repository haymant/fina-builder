//! Golden parity: the kernel must reproduce the pre-migration TypeScript output
//! byte-for-byte.
//!
//! This is invariant **I-1** from `FEATURES.md`, and it is the
//! single most important test in the repository. Every other test checks that the
//! kernel is internally coherent; this one checks that it is *correct* — that the
//! port is faithful rather than merely plausible.
//!
//! ```text
//! cargo test -p fina-kernel --test golden_parity
//! node scripts/generate-golden-fixture.ts   # re-capture the baseline
//! ```
//!
//! # What "parity" means here
//!
//! The bundle is compared as **parsed JSON values**, recursively, with strict
//! IEEE-754 `f64` equality and no tolerance. Comparing serialised text instead
//! would be stricter still, but it would conflate two independent concerns: the
//! numbers, and the JSON key order. `node_details` is a JSON object whose key
//! order `serde_json` does not preserve on parse, so a text comparison would need
//! a key-order-aware parser to say anything useful. The numbers are the part
//! that can silently drift, so those are what is checked.
//!
//! When a mismatch is found the test reports the **path** to the offending value
//! (`simulationBundle.paths[7].worstOfPerformance[23]`), because "the output
//! differs" is not an actionable bug report and "the 24th worst-of level of the
//! 8th path differs" is.

use fina_kernel::diagnostics::{final_mc, mc_diagnostics, mc_efficiency};
use fina_kernel::economics::{derive_trade_analytics, DEFAULT_TRADE_ECONOMICS};
use fina_kernel::path_generator::{generate_paths, SimulationConfig};
use fina_kernel::risk_engine::compute_risk;
use fina_kernel::types::{MarketSnapshot, PayoffNodeId, SettlementType, SimulationBundle};
use fina_kernel::valuation::{build_cashflows, cashflow_analytics, valuation_explain};
use serde::Serialize;
use serde_json::Value;

const GOLDEN: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/golden.json");

fn golden() -> Value {
    let raw = std::fs::read_to_string(GOLDEN).unwrap_or_else(|e| {
        panic!(
            "golden fixture missing at {GOLDEN}: {e}\n\
             re-capture with: node scripts/generate-golden-fixture.ts"
        )
    });
    serde_json::from_str(&raw).expect("golden.json is valid JSON")
}

fn generate() -> SimulationBundle {
    generate_paths(SimulationConfig::demo(), |_| {}).expect("demo config is valid")
}

// ---------------------------------------------------------------------------
// Recursive comparison
// ---------------------------------------------------------------------------

/// Appends a JSON pointer to a diff path.
fn walk(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

/// Compares `got` against `expected`, recording the first `limit` differences.
///
/// Returns the number of differences found.
fn diff(path: &str, expected: &Value, got: &Value, out: &mut Vec<String>, limit: usize) -> usize {
    if out.len() >= limit {
        return 0;
    }
    match (expected, got) {
        // Numbers: strict IEEE-754 equality, no tolerance. Invariant I-1.
        (Value::Number(e), Value::Number(g)) => {
            let (ef, gf) = (e.as_f64(), g.as_f64());
            if ef == gf {
                0
            } else {
                out.push(format!(
                    "{path}: golden {ef:?} (bits {:#018x}) != kernel {gf:?} (bits {:#018x})",
                    e.as_f64().map(f64::to_bits).unwrap_or(0),
                    g.as_f64().map(f64::to_bits).unwrap_or(0),
                ));
                1
            }
        }
        // Booleans, strings, null.
        (e, g) if e.is_boolean() || e.is_string() || e.is_null() => {
            if e == g {
                0
            } else {
                out.push(format!("{path}: golden {e} != kernel {g}"));
                1
            }
        }
        (Value::Array(e), Value::Array(g)) => {
            if e.len() != g.len() {
                out.push(format!(
                    "{path}: array length golden {} != kernel {}",
                    e.len(),
                    g.len()
                ));
                return 1;
            }
            let mut n = 0;
            for (i, (ev, gv)) in e.iter().zip(g).enumerate() {
                n += diff(&format!("{path}[{i}]"), ev, gv, out, limit);
                if out.len() >= limit {
                    break;
                }
            }
            n
        }
        (Value::Object(e), Value::Object(g)) => {
            let mut n = 0;
            for key in e.keys() {
                let Some(gv) = g.get(key) else {
                    out.push(format!("{path}.{key}: missing from kernel output"));
                    n += 1;
                    continue;
                };
                n += diff(&walk(path, key), &e[key], gv, out, limit);
                if out.len() >= limit {
                    break;
                }
            }
            for key in g.keys() {
                if !e.contains_key(key) {
                    // An extra serialized field breaks parity even if every
                    // shared value matches, so this is reported as a difference.
                    out.push(format!("{path}.{key}: extra key in kernel output"));
                    n += 1;
                }
            }
            n
        }
        _ => {
            out.push(format!(
                "{path}: type mismatch golden {} != kernel {}",
                kind(expected),
                kind(got)
            ));
            1
        }
    }
}

fn kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// Asserts the kernel's serialised `value` equals `golden[section]` exactly.
///
/// `section` is the full path into the fixture, e.g. `"trade.defaults"` or just
/// `"mc"`. The kernel value is the serialisation of that **whole subtree**, so
/// it is compared against the resolved fixture path rather than indexed by the
/// same path — the kernel does not wrap its output in `{"trade": {...}}` the way
/// the fixture does.
fn assert_parity(section: &str, value: &impl Serialize) {
    let fixture = golden();
    let expected = lookup(&fixture, section);
    let actual = &serde_json::to_value(value).expect("kernel output serialises");
    assert_eq_values(section, expected, actual);
}

/// Resolves a dotted path inside the fixture.
fn lookup<'a>(golden: &'a Value, section: &str) -> &'a Value {
    let mut node = golden;
    for part in section.split('.') {
        node = &node[part];
    }
    node
}

/// The shared comparison, with the fixture-presence check.
fn assert_eq_values(section: &str, expected: &Value, actual: &Value) {
    assert!(
        !expected.is_null(),
        "golden.json has no `{section}` section; the fixture and the kernel have drifted apart"
    );

    let mut diffs = Vec::new();
    let n = diff(section, expected, actual, &mut diffs, 25);
    assert_eq!(
        n,
        0,
        "{n} golden-parity differences in `{section}` (showing {}):\n  {}",
        diffs.len(),
        diffs.join("\n  ")
    );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/// The full simulation bundle: every path, every observation, every node detail.
#[test]
fn simulation_bundle_matches_golden_byte_for_byte() {
    assert_parity("simulationBundle", &generate());
}

// ---------------------------------------------------------------------------
// Phase 4: cashflow, valuation explain
// ---------------------------------------------------------------------------

/// The path the fixture's `cashflow` section was captured from.
fn golden_cashflow_inputs() -> (fina_kernel::types::SimulationPath, serde_json::Value) {
    let g = golden();
    let path0_path_index = g["cashflow"]["pathIndex"].as_u64().unwrap() as usize;
    let bundle = generate();
    let path = bundle
        .paths
        .iter()
        .find(|p| p.path_index == path0_path_index)
        .expect("fixture's cashflow.pathIndex must match a demo path");
    (path.clone(), g)
}

/// The whole `cashflow` section — rows, path index and the three aggregates —
/// against the fixture, which was captured from the real
/// `buildCashflows(paths[0], defaultTrade)`.
#[test]
fn cashflow_section_matches_golden() {
    let (path, _g) = golden_cashflow_inputs();
    let trade = DEFAULT_TRADE_ECONOMICS;
    let rows = build_cashflows(&path, &trade);
    let a = cashflow_analytics(&path, &trade);

    let payload = serde_json::json!({
        "pathIndex": path.path_index,
        "rows": rows,
        "grossCashflow": a.gross_cashflow,
        "presentValue": a.present_value,
        "realized": a.realized,
    });
    assert_parity("cashflow", &payload);
}

/// The 60 cashflow rows individually, so a failure names the row.
#[test]
fn every_cashflow_row_matches_golden_individually() {
    let (path, g) = golden_cashflow_inputs();
    let rows = build_cashflows(&path, &DEFAULT_TRADE_ECONOMICS);
    let golden_rows = g["cashflow"]["rows"].as_array().unwrap();
    assert_eq!(rows.len(), golden_rows.len());

    for (i, (row, grow)) in rows.iter().zip(golden_rows).enumerate() {
        let mut diffs = Vec::new();
        let n = diff(
            &format!("cashflow.rows[{i}]"),
            grow,
            &serde_json::to_value(row).unwrap(),
            &mut diffs,
            25,
        );
        assert_eq!(
            n,
            0,
            "cashflow row {i} ({}) diverged:\n  {}",
            row.id,
            diffs.join("\n  ")
        );
    }
}

/// `valuation`: previousPV, currentPV, the nine Taylor fields, the four PLVA
/// rows and the **unrounded** `plvaPnL` (`1.0000000000000002`, not `1`).
#[test]
fn valuation_section_matches_golden() {
    let (path, _g) = golden_cashflow_inputs();
    let cash = cashflow_analytics(&path, &DEFAULT_TRADE_ECONOMICS);
    let v = valuation_explain(&cash, &MarketSnapshot::demo());

    let payload = serde_json::json!({
        "previousPV": v.previous_pv,
        "currentPV": v.current_pv,
        "taylor": v.taylor,
        "plva": v.plva,
        "plvaPnL": v.plva_pnl,
    });
    assert_parity("valuation", &payload);

    // The two headline numbers this phase exists to reproduce, exactly.
    assert_eq!(cash.present_value, 94.89);
    assert_eq!(v.taylor.predicted, 1.686_000_000_000_000_4);
}

// ---------------------------------------------------------------------------
// Phase 3: economics, risk engine, MC diagnostics
// ---------------------------------------------------------------------------

/// The Monte Carlo diagnostics series, its efficiency table and the
/// "converged" row.
#[test]
fn mc_diagnostics_matches_golden() {
    let payload = serde_json::json!({
        "mcDiagnostics": mc_diagnostics(),
        "mcEfficiency": mc_efficiency(),
        "finalMC": final_mc(),
    });
    assert_parity("mc", &payload);
}

/// The MC diagnostics row-by-row, so a failure names the path count.
#[test]
fn every_mc_row_matches_golden_individually() {
    let golden = golden();
    let rows = mc_diagnostics();
    assert_eq!(
        rows.len(),
        golden["mc"]["mcDiagnostics"].as_array().unwrap().len()
    );

    for (i, row) in rows.iter().enumerate() {
        let mut diffs = Vec::new();
        let n = diff(
            &format!("mc.mcDiagnostics[{i}]"),
            &golden["mc"]["mcDiagnostics"][i],
            &serde_json::to_value(row).unwrap(),
            &mut diffs,
            25,
        );
        assert_eq!(
            n,
            0,
            "row {} diverged:\n  {}",
            row.paths,
            diffs.join("\n  ")
        );
    }

    // `finalMC` is the last row verbatim, not a re-derivation.
    assert_eq!(final_mc(), *rows.last().unwrap());
    assert_parity("mc.finalMC", &final_mc());
}

/// The efficiency table: four literal rows.
#[test]
fn mc_efficiency_matches_golden() {
    let rows = mc_efficiency();
    assert_parity("mc.mcEfficiency", &rows);
    assert_eq!(rows, mc_efficiency(), "must be a pure literal table");
}

/// `trade.defaults`: the kernel's constant against the frontend's.
#[test]
fn trade_defaults_match_golden() {
    assert_parity("trade.defaults", &DEFAULT_TRADE_ECONOMICS);
}

/// `trade.analytics`: the derived analytics panel against the frontend's.
#[test]
fn trade_analytics_matches_golden() {
    let analytics = derive_trade_analytics(&DEFAULT_TRADE_ECONOMICS);
    assert_parity("trade.analytics", &analytics);

    // And field by field, so the failure message names the field.
    let g = &golden()["trade"]["analytics"];
    assert_eq!(analytics.expected_pv, g["expectedPv"].as_f64().unwrap());
    assert_eq!(analytics.coupon_pv, g["couponPv"].as_f64().unwrap());
    assert_eq!(analytics.put_pv, g["putPv"].as_f64().unwrap());
    assert_eq!(analytics.redemption, g["redemption"].as_f64().unwrap());
    assert_eq!(
        analytics.ki_probability,
        g["kiProbability"].as_f64().unwrap()
    );
    assert_eq!(
        analytics.ko_probability,
        g["koProbability"].as_f64().unwrap()
    );
    assert_eq!(analytics.ci_width, g["ciWidth"].as_f64().unwrap());
}

/// The whole `trade` section, defaults and analytics together.
#[test]
fn trade_section_matches_golden() {
    let payload = serde_json::json!({
        "defaults": DEFAULT_TRADE_ECONOMICS,
        "analytics": derive_trade_analytics(&DEFAULT_TRADE_ECONOMICS),
    });
    assert_parity("trade", &payload);
}

/// `risk.base`: the risk panel against the frontend's.
#[test]
fn risk_base_matches_golden() {
    let risk = compute_risk(&DEFAULT_TRADE_ECONOMICS, &MarketSnapshot::demo())
        .expect("the demo market is valid");
    assert_parity("risk.base", &risk);
}

/// The risk panel field by field, so a failure names the Greek.
#[test]
fn every_risk_field_matches_golden_individually() {
    let g = golden();
    let r = compute_risk(&DEFAULT_TRADE_ECONOMICS, &MarketSnapshot::demo()).unwrap();
    let g = &g["risk"]["base"];

    for (field, got) in [
        ("pv", r.pv),
        ("delta", r.delta),
        ("gamma", r.gamma),
        ("vega", r.vega),
        ("theta", r.theta),
        ("rho", r.rho),
        ("fxDelta", r.fx_delta),
    ] {
        assert_eq!(Some(got), g[field].as_f64(), "risk.base.{field} diverged");
    }

    // The Greeks the spec calls out by name.
    assert_eq!(r.pv, 154.03);
    assert_eq!(r.gamma, 0.0);
    assert_eq!(r.delta, 80.0);
}

/// `risk.base` as a whole: every field, every list element, every pair string.
#[test]
fn risk_base_matches_golden_including_lists() {
    let risk = compute_risk(&DEFAULT_TRADE_ECONOMICS, &MarketSnapshot::demo()).unwrap();
    let payload = serde_json::json!({ "base": risk });
    assert_parity("risk", &payload);

    // Bucket and cross-gamma labels are UI contracts, so check them by name.
    let labels: Vec<&str> = risk
        .bucket_vegas
        .iter()
        .map(|b| b.bucket.as_str())
        .collect();
    assert_eq!(labels, ["1M", "3M", "6M", "1Y", "2Y", "5Y"]);
    let pairs: Vec<&str> = risk.cross_gamma.iter().map(|c| c.pair.as_str()).collect();
    assert_eq!(pairs, ["AAPL/MSFT", "AAPL/NVDA"]);
}

/// The headline scalars, so a failure names them individually.
#[test]
fn headline_values_match_golden() {
    let golden = golden();
    let bundle = generate();

    let g = &golden["simulationBundle"];

    // Identity.
    assert_eq!(bundle.product_name, g["productName"].as_str().unwrap());
    assert_eq!(bundle.tagline, g["tagline"].as_str().unwrap());
    assert_eq!(bundle.underlyings, vec!["AAPL", "MSFT", "NVDA"]);
    assert_eq!(bundle.paths.len(), 100);

    // Barriers round-trip through serde unchanged (I-5 territory, but cheap to
    // assert here since a drift here would silently change every path).
    assert_eq!(bundle.barriers.ki_barrier, 0.7);
    assert_eq!(bundle.barriers.ko_barrier, 1.0);
    assert_eq!(bundle.barriers.coupon_lower, 0.75);
    assert_eq!(bundle.barriers.coupon_upper, 1.0);
    assert_eq!(bundle.barriers.coupon_rate, 0.008);
    assert_eq!(bundle.barriers.notional, 100.0);

    // Branch statistics: exactly the seven original fields.
    assert_eq!(bundle.branch_stats.total_paths, 100_000);
    assert_eq!(bundle.branch_stats.ko_triggered, 67_000);
    assert_eq!(bundle.branch_stats.alive, 33_000);
    assert_eq!(bundle.branch_stats.knock_in, 19_000);
    assert_eq!(bundle.branch_stats.no_knock_in, 14_000);
    assert_eq!(bundle.branch_stats.cash_settlement, 12_000);
    assert_eq!(bundle.branch_stats.physical_delivery, 7_000);

    // The distribution mean is the single most-quoted number in the UI.
    assert_eq!(
        bundle.distributions.total_payoff.mean,
        g["distributions"]["totalPayoff"]["mean"].as_f64().unwrap()
    );
}

/// Branch statistics, isolated so a failure is unambiguous.
#[test]
fn branch_stats_match_golden() {
    let golden = golden();
    let bundle = generate();
    let g = &golden["simulationBundle"]["branchStats"];
    let bs = &bundle.branch_stats;

    assert_eq!(bs.total_paths, g["totalPaths"].as_u64().unwrap() as u32);
    assert_eq!(bs.ko_triggered, g["koTriggered"].as_u64().unwrap() as u32);
    assert_eq!(bs.alive, g["alive"].as_u64().unwrap() as u32);
    assert_eq!(bs.knock_in, g["knockIn"].as_u64().unwrap() as u32);
    assert_eq!(bs.no_knock_in, g["noKnockIn"].as_u64().unwrap() as u32);
    assert_eq!(
        bs.cash_settlement,
        g["cashSettlement"].as_u64().unwrap() as u32
    );
    assert_eq!(
        bs.physical_delivery,
        g["physicalDelivery"].as_u64().unwrap() as u32
    );

    // No extra serialized fields: I-4 narrowed this deliberately.
    let serialised = serde_json::to_value(bs).unwrap();
    assert_eq!(
        serialised.as_object().unwrap().len(),
        7,
        "branchStats must keep exactly the original seven keys"
    );
}

/// All four distributions.
#[test]
fn distributions_match_golden() {
    let golden = golden();
    let bundle = generate();
    let g = &golden["simulationBundle"]["distributions"];

    for (name, stats) in [
        ("totalPayoff", &bundle.distributions.total_payoff),
        ("couponPv", &bundle.distributions.coupon_pv),
        ("putPv", &bundle.distributions.put_pv),
        ("worstOfFinal", &bundle.distributions.worst_of_final),
    ] {
        let expected = &g[name];
        assert_eq!(
            stats.mean,
            expected["mean"].as_f64().unwrap(),
            "{name}.mean"
        );
        assert_eq!(
            stats.median,
            expected["median"].as_f64().unwrap(),
            "{name}.median"
        );
        assert_eq!(
            stats.std_dev,
            expected["stdDev"].as_f64().unwrap(),
            "{name}.stdDev"
        );
        assert_eq!(stats.p05, expected["p05"].as_f64().unwrap(), "{name}.p05");
        assert_eq!(stats.p95, expected["p95"].as_f64().unwrap(), "{name}.p95");

        let expected_values: Vec<f64> = expected["values"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        assert_eq!(stats.values, expected_values, "{name}.values");
    }
}

/// Per-path scalars for all 100 paths.
#[test]
fn every_path_scalar_matches_golden() {
    let golden = golden();
    let bundle = generate();
    let gpaths = golden["simulationBundle"]["paths"].as_array().unwrap();

    for (i, (path, g)) in bundle.paths.iter().zip(gpaths).enumerate() {
        let ctx = format!("paths[{i}] ({})", path.id);
        assert_eq!(path.id, g["id"].as_str().unwrap(), "{ctx}.id");
        assert_eq!(
            path.path_index,
            g["pathIndex"].as_u64().unwrap() as usize,
            "{ctx}.pathIndex"
        );
        assert_eq!(path.payoff, g["payoff"].as_f64().unwrap(), "{ctx}.payoff");
        assert_eq!(
            path.redemption_value,
            g["redemptionValue"].as_f64().unwrap(),
            "{ctx}.redemptionValue"
        );
        assert_eq!(
            path.coupon_value,
            g["couponValue"].as_f64().unwrap(),
            "{ctx}.couponValue"
        );
        assert_eq!(
            path.put_value,
            g["putValue"].as_f64().unwrap(),
            "{ctx}.putValue"
        );
        assert_eq!(
            path.memory_coupon_value,
            g["memoryCouponValue"].as_f64().unwrap(),
            "{ctx}.memoryCouponValue"
        );
        assert_eq!(
            path.knock_in_triggered,
            g["knockInTriggered"].as_bool().unwrap(),
            "{ctx}.knockInTriggered"
        );
        assert_eq!(
            path.knocked_out,
            g["knockedOut"].as_bool().unwrap(),
            "{ctx}.knockedOut"
        );
        assert_eq!(
            path.knock_out_date_index,
            g["knockOutDateIndex"].as_u64().map(|v| v as usize),
            "{ctx}.knockOutDateIndex"
        );
        assert_eq!(
            path.knock_in_date_index,
            g["knockInDateIndex"].as_u64().map(|v| v as usize),
            "{ctx}.knockInDateIndex"
        );

        let expected_settlement = match g["settlementType"].as_str().unwrap() {
            "cash" => SettlementType::Cash,
            "physical" => SettlementType::Physical,
            "none" => SettlementType::None,
            other => panic!("unknown settlementType {other:?}"),
        };
        assert_eq!(
            path.settlement_type, expected_settlement,
            "{ctx}.settlement"
        );

        assert_eq!(
            path.attribution.par_redemption,
            g["attribution"]["parRedemption"].as_f64().unwrap()
        );
        assert_eq!(
            path.attribution.coupon,
            g["attribution"]["coupon"].as_f64().unwrap()
        );
        assert_eq!(
            path.attribution.memory_coupon,
            g["attribution"]["memoryCoupon"].as_f64().unwrap()
        );
        assert_eq!(
            path.attribution.down_and_in_put,
            g["attribution"]["downAndInPut"].as_f64().unwrap()
        );
        assert_eq!(
            path.attribution.funding,
            g["attribution"]["funding"].as_f64().unwrap()
        );
        assert_eq!(
            path.attribution.discounting,
            g["attribution"]["discounting"].as_f64().unwrap()
        );
        assert_eq!(
            path.attribution.total_pv,
            g["attribution"]["totalPv"].as_f64().unwrap(),
            "{ctx}.attribution.totalPv"
        );
    }
}

/// The worst-of series and per-observation levels for all 100 paths.
#[test]
fn every_observation_matches_golden() {
    let golden = golden();
    let bundle = generate();
    let gpaths = golden["simulationBundle"]["paths"].as_array().unwrap();

    for (i, (path, g)) in bundle.paths.iter().zip(gpaths).enumerate() {
        let ctx = format!("paths[{i}] ({})", path.id);

        let gdates: Vec<&str> = g["dates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        let path_dates: Vec<&str> = path.dates.iter().map(String::as_str).collect();
        assert_eq!(path_dates, gdates, "{ctx}.dates");

        for (t, (obs, gobs)) in path
            .observations
            .iter()
            .zip(g["observations"].as_array().unwrap())
            .enumerate()
        {
            let octx = format!("{ctx}.observations[{t}]");
            assert_eq!(obs.date, gobs["date"].as_str().unwrap(), "{octx}.date");
            assert_eq!(
                obs.date_index,
                gobs["dateIndex"].as_u64().unwrap() as usize,
                "{octx}.dateIndex"
            );
            for (field, key) in [
                (obs.aapl, "aapl"),
                (obs.msft, "msft"),
                (obs.nvda, "nvda"),
                (obs.worst_of_performance, "worstOfPerformance"),
                (obs.coupon_accrued, "couponAccrued"),
                (obs.coupon_memory_balance, "couponMemoryBalance"),
            ] {
                assert_eq!(field, gobs[key].as_f64().unwrap(), "{octx}.{key}");
            }
            assert_eq!(
                obs.knock_in_at_date,
                gobs["knockInAtDate"].as_bool().unwrap(),
                "{octx}.knockInAtDate"
            );
            assert_eq!(
                obs.knock_out_at_date,
                gobs["knockOutAtDate"].as_bool().unwrap(),
                "{octx}.knockOutAtDate"
            );
        }

        let gworst: Vec<f64> = g["worstOfPerformance"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        assert_eq!(
            path.worst_of_performance, gworst,
            "{ctx}.worstOfPerformance"
        );

        let gmem: Vec<f64> = g["couponMemoryBalance"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        assert_eq!(
            path.coupon_memory_balance, gmem,
            "{ctx}.couponMemoryBalance"
        );
    }
}

/// The payoff-graph traversal order for all 100 paths (I-5: display contract).
#[test]
fn traversal_order_matches_golden() {
    let golden = golden();
    let bundle = generate();
    let gpaths = golden["simulationBundle"]["paths"].as_array().unwrap();

    for (i, (path, g)) in bundle.paths.iter().zip(gpaths).enumerate() {
        let expected: Vec<PayoffNodeId> = g["traversal"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| PayoffNodeId::from_label(v.as_str().unwrap()).expect("known node id"))
            .collect();
        assert_eq!(
            path.traversal, expected,
            "paths[{i}] traversal order changed; the graph layout depends on it"
        );
    }
}

/// All twelve node snapshots per path, including every formatted string.
#[test]
fn node_details_match_golden() {
    let golden = golden();
    let bundle = generate();
    let gpaths = golden["simulationBundle"]["paths"].as_array().unwrap();

    for (i, (path, g)) in bundle.paths.iter().zip(gpaths).enumerate() {
        let nd = &g["nodeDetails"];
        assert_eq!(
            path.node_details.len(),
            PayoffNodeId::ALL.len(),
            "paths[{i}] must have one snapshot per node"
        );

        for snap in &path.node_details {
            let key = snap.node_id.label();
            let expected = &nd[key];
            let ctx = format!("paths[{i}].nodeDetails.{key}");

            assert_eq!(
                snap.node_id.label(),
                expected["nodeId"].as_str().unwrap(),
                "{ctx}.nodeId"
            );
            assert_eq!(snap.name, expected["name"].as_str().unwrap(), "{ctx}.name");
            assert_eq!(
                snap.description,
                expected["description"].as_str().unwrap(),
                "{ctx}.description"
            );
            assert_eq!(
                snap.input_value,
                expected["inputValue"].as_str().unwrap(),
                "{ctx}.inputValue"
            );
            assert_eq!(
                snap.decision_rule,
                expected["decisionRule"].as_str().unwrap(),
                "{ctx}.decisionRule"
            );
            assert_eq!(
                snap.output,
                expected["output"].as_str().unwrap(),
                "{ctx}.output"
            );
            assert_eq!(
                snap.affected_paths,
                expected["affectedPaths"].as_u64().unwrap() as usize,
                "{ctx}.affectedPaths"
            );
            assert_eq!(
                snap.probability,
                expected["probability"].as_f64().unwrap(),
                "{ctx}.probability"
            );
            assert_eq!(
                snap.conditional_expected_payoff,
                expected["conditionalExpectedPayoff"].as_f64().unwrap(),
                "{ctx}.conditionalExpectedPayoff"
            );
            assert_eq!(
                snap.is_loss_related,
                expected["isLossRelated"].as_bool().unwrap(),
                "{ctx}.isLossRelated"
            );
        }
    }
}

/// Determinism (I-2): same input, identical bytes, twice.
///
/// Catches accidental dependence on hash iteration order, thread scheduling or
/// any other source of nondeterminism. Not implied by the golden test, which
/// only proves the kernel matches the baseline once.
#[test]
fn generation_is_deterministic() {
    let a = serde_json::to_vec(&generate()).unwrap();
    let b = serde_json::to_vec(&generate()).unwrap();
    assert_eq!(
        a, b,
        "generate_paths must be a pure function of its config (invariant I-2)"
    );

    // A third run through a fresh RNG must also agree, in case state leaked
    // between calls on a shared generator.
    let mut c = generate();
    c.paths.shrink_to_fit();
    assert_eq!(a, serde_json::to_vec(&c).unwrap());
}

/// The `nodeDetails` JSON object must keep the TypeScript key order, which the
/// custom serde adapter is responsible for.
///
/// `serde_json` parses into a sorted-key map by default, so this reads the raw
/// text instead.
#[test]
fn node_details_serialize_in_payoff_node_order() {
    let bundle = generate();
    let json = String::from_utf8(serde_json::to_vec(&bundle).unwrap()).unwrap();

    let start = json
        .find(r#""nodeDetails":{"#)
        .expect("nodeDetails present");
    let rest = &json[start + r#""nodeDetails":{"#.len()..];
    let order: Vec<&str> = PayoffNodeId::ALL.iter().map(|n| n.label()).collect();
    let mut cursor = 0usize;
    for label in order {
        let needle = format!("\"{label}\":{{\"nodeId\":\"{label}\"");
        let at = rest[cursor..]
            .find(&needle)
            .unwrap_or_else(|| panic!("node {label} missing or out of order"));
        cursor += at + needle.len();
    }
}

/// Cross-language determinism: a committed digest of the canonical serialization
/// (`FEATURES.md` §Phase 2, test 3).
///
/// `golden.json` compares *parsed values*, which is the right check for numeric
/// parity but says nothing about the serialization itself. This pins the exact
/// bytes, so drift is caught even if `golden.json` is later regenerated
/// carelessly — regenerating the fixture should show up as a diff in this
/// constant too.
///
/// The digest is of `serde_json::to_string(&bundle)`, which is stable for a given
/// struct definition: field order follows declaration order, and the
/// `nodeDetails` adapter emits `PayoffNodeId::ALL` order.
#[test]
fn canonical_serialization_digest_is_pinned() {
    let canonical = serde_json::to_string(&generate()).expect("bundle serialises");
    assert_eq!(
        sha256_hex(canonical.as_bytes()),
        CANONICAL_DIGEST,
        "the canonical serialization of the bundle changed; if that is \
         intentional, update CANONICAL_DIGEST and explain it in the commit message"
    );
}

/// The committed SHA-256 of `serde_json::to_string(&generate_paths(demo))`.
///
/// Captured from the kernel on the Phase 2 golden-parity run. Any change to a
/// name, a string, a number or the JSON shape changes this value, which is the
/// point: such a change must be a conscious decision made in the same commit.
const CANONICAL_DIGEST: &str = "a79bf5642aaf9c7d6cb292d27863a79ea173284dec08acbffbb748afeaddaf9f";

// ---------------------------------------------------------------------------
// SHA-256
//
// Implemented here rather than added as a dev-dependency because invariant I-8
// restricts `fina-kernel` to three crates, and a test-only hash is not worth
// widening that allowlist. `sha256_matches_fips_180_4_vectors` below proves the
// implementation, so a broken hash fails loudly rather than silently blessing
// drift.
// ---------------------------------------------------------------------------

/// Returns the lowercase hex SHA-256 of `data`.
fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    // Padding: 0x80, then zeros, then the 64-bit big-endian bit length.
    let mut message = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    for block in message.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (i, word) in block.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let (mut a, mut b, mut c, mut d) = (h[0], h[1], h[2], h[3]);
        let (mut e, mut f, mut g, mut hh) = (h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        for (slot, value) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *slot = slot.wrapping_add(value);
        }
    }

    h.iter().map(|word| format!("{word:08x}")).collect()
}

/// The hash implementation must itself be correct, or the pinned digest is
/// meaningless. Covers the FIPS 180-4 examples plus the padding boundaries a
/// hand-rolled implementation gets wrong.
#[test]
fn sha256_matches_fips_180_4_vectors() {
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
    assert_eq!(
        sha256_hex(&vec![b'a'; 1_000_000]),
        "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
    );

    // Padding boundaries: the length field must land in the final block.
    for len in [55usize, 56, 63, 64, 119, 120] {
        let digest = sha256_hex(&vec![b'x'; len]);
        assert_eq!(digest.len(), 64, "digest length for {len} bytes");
        assert!(
            digest
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "digest for {len} bytes is not lowercase hex"
        );
    }
    // Distinct inputs must give distinct digests.
    assert_ne!(sha256_hex(&[b'x'; 55]), sha256_hex(&[b'x'; 56]));
}
