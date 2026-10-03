//! Behavioural tests for [`fina_kernel::path_generator`].
//!
//! `golden_parity.rs` proves the port is *faithful*. This file proves it is
//! *sane*: that the invariants the generator claims to uphold actually hold, that
//! the validation rejects bad input instead of panicking, and that the progress
//! callback an adapter will bridge to SSE or a Tauri channel behaves.
//!
//! Tests 4–13 of `FEATURES.md` §Phase 2 live here. Tests 1–3 are
//! in `golden_parity.rs`, because they are golden comparisons.
//!
//! Where a test restates a golden value it says so. Where it asserts something
//! the TypeScript never checked, it says that too — the point of the exercise is
//! to have promoted a `console.warn` into an invariant.

use fina_kernel::error::FinaError;
use fina_kernel::path_generator::{generate_paths, PathScenario, SimulationConfig};
use fina_kernel::progress::{ProgressEvent, ProgressLog};
use fina_kernel::types::{PayoffNodeId, SettlementType, SimulationBundle};

fn demo() -> SimulationBundle {
    generate_paths(SimulationConfig::demo(), |_| {}).expect("the demo config is valid")
}

fn golden() -> serde_json::Value {
    let raw = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/golden.json"
    ))
    .expect("golden fixture present");
    serde_json::from_str(&raw).expect("golden.json is valid JSON")
}

// ---------------------------------------------------------------------------
// Scenario assignment (spec test 5)
// ---------------------------------------------------------------------------

/// The scenario mix over the demo sample matches the golden branch counts
/// exactly, and the raw counts sum to the sample size.
///
/// The four scenario labels partition the sample, so these four must add up. If
/// a refactor ever made a scenario unreachable — a dead `match` arm, a renamed
/// variant — this is where it would show.
#[test]
fn scenario_counts_partition_the_sample() {
    let bundle = demo();
    let ko = bundle.paths.iter().filter(|p| p.knocked_out).count();
    let ki = bundle
        .paths
        .iter()
        .filter(|p| !p.knocked_out && p.knock_in_triggered)
        .count();
    let no_ki = bundle
        .paths
        .iter()
        .filter(|p| !p.knocked_out && !p.knock_in_triggered)
        .count();

    assert_eq!(ko + ki + no_ki, bundle.paths.len());
    assert_eq!(bundle.sample_path_count(), 100);

    // Golden branch counts, each the sample fraction scaled by 100,000.
    assert_eq!(ko, 67, "knocked-out count drives koTriggered = 67000");
    assert_eq!(ki, 19, "knock-in count drives knockIn = 19000");
    assert_eq!(no_ki, 14, "no-knock-in count drives noKnockIn = 14000");

    // The cash/physical split covers exactly the knock-in paths. A KO or a
    // no-knock-in path settles as `none`.
    let cash = bundle
        .paths
        .iter()
        .filter(|p| p.settlement_type == SettlementType::Cash)
        .count();
    let physical = bundle
        .paths
        .iter()
        .filter(|p| p.settlement_type == SettlementType::Physical)
        .count();
    assert_eq!(cash, 12, "cashSettlement = 12000");
    assert_eq!(physical, 7, "physicalDelivery = 7000");
    assert_eq!(cash + physical, ki);
}

#[test]
fn branch_stats_match_golden_counts() {
    let bundle = demo();
    let g = &golden()["simulationBundle"]["branchStats"];
    let bs = &bundle.branch_stats;

    assert_eq!(bs.total_paths, 100_000);
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

    // I-4, narrowed: `samplePathCount` and `scaled` are accessors, not
    // serialized fields, because the golden object has exactly seven keys.
    assert_eq!(bundle.sample_path_count(), 100);
    assert!(bs.is_scaled());
    assert_eq!(bs.count_fields(), 6);
}

// ---------------------------------------------------------------------------
// Traversal shape per scenario (spec test 6)
// ---------------------------------------------------------------------------

/// The three scenarios traverse genuinely different payoff-graph node sets.
///
/// This is a display contract: the graph layout reads `traversal`, so a node
/// silently added to one scenario's list changes the rendered graph. The three
/// assertions below are the sharp edges of the original:
///
/// - a KO path never reaches `KnockInGate` or `DownAndInPut`;
/// - an alive knock-in path always reaches `DownAndInPut`;
/// - an alive no-knock-in path reaches `KnockInGate` but never `DownAndInPut`.
#[test]
fn traversal_node_sets_match_the_scenario() {
    let bundle = demo();
    let mut seen = (0usize, 0usize, 0usize);

    for path in &bundle.paths {
        let has = |node: PayoffNodeId| path.traversal.contains(&node);
        match (path.knocked_out, path.knock_in_triggered) {
            // KO.
            (true, _) => {
                seen.0 += 1;
                assert!(!has(PayoffNodeId::KnockInGate), "{} KO", path.id);
                assert!(!has(PayoffNodeId::DownAndInPut), "{} KO", path.id);
                assert!(!has(PayoffNodeId::RangeAccrual), "{} KO", path.id);
            }
            // Alive, knock-in.
            (false, true) => {
                seen.1 += 1;
                assert!(has(PayoffNodeId::KnockInGate), "{}", path.id);
                assert!(has(PayoffNodeId::DownAndInPut), "{}", path.id);
                assert!(has(PayoffNodeId::RangeAccrual), "{}", path.id);
            }
            // Alive, no knock-in.
            (false, false) => {
                seen.2 += 1;
                assert!(has(PayoffNodeId::KnockInGate), "{}", path.id);
                assert!(!has(PayoffNodeId::DownAndInPut), "{}", path.id);
                assert!(has(PayoffNodeId::RangeAccrual), "{}", path.id);
            }
        }

        // Every scenario starts at the cube and ends at the aggregate.
        assert_eq!(path.traversal.first(), Some(&PayoffNodeId::PathCube));
        assert_eq!(path.traversal.last(), Some(&PayoffNodeId::AggregatePV));
        // No repeats: the graph is a path, not a set. `index()` is the node's
        // canonical position, so a duplicate is visible without needing `Ord`.
        let mut seen = std::collections::BTreeSet::new();
        for node in &path.traversal {
            assert!(seen.insert(node.index()), "{} repeats {node:?}", path.id);
        }
    }

    assert_eq!(seen, (67, 19, 14));
}

#[test]
fn scenario_labels_are_assigned_before_any_series_draw() {
    // `assign` consumes exactly one draw per path. If it consumed a different
    // number, every series in the bundle would differ — which `golden_parity`
    // already catches. What this pins is the *count*, so a future
    // "cheap optimisation" that skips the draw is caught by name.
    let mut rng = fina_kernel::rng::Mulberry32::new(42);
    let scenarios = PathScenario::assign(&mut rng, 100);
    assert_eq!(scenarios.len(), 100);

    // 100 draws consumed, so the next value is the 101st of the demo sequence.
    let after = rng.next_f64();
    let mut fresh = fina_kernel::rng::Mulberry32::new(42);
    for _ in 0..100 {
        fresh.next_f64();
    }
    assert_eq!(after, fresh.next_f64());
}

// ---------------------------------------------------------------------------
// Dates (spec test 7)
// ---------------------------------------------------------------------------

/// The 60 fixing dates are exactly the golden strings, endpoints included.
#[test]
fn dates_match_golden_including_endpoints() {
    let golden = golden();
    let bundle = demo();
    let expected: Vec<&str> = golden["simulationBundle"]["paths"][0]["dates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();

    assert_eq!(bundle.paths[0].dates.len(), 60);
    assert_eq!(bundle.paths[0].dates[0], "2024-01-15");
    assert_eq!(bundle.paths[0].dates[59], "2028-12-15");

    let actual: Vec<&str> = bundle.paths[0].dates.iter().map(String::as_str).collect();
    assert_eq!(actual, expected);

    // Every path shares one schedule, so every path must agree.
    for path in &bundle.paths {
        assert_eq!(path.dates, bundle.paths[0].dates, "{}", path.id);
    }
}

// ---------------------------------------------------------------------------
// Series and observation lengths (spec test 8)
// ---------------------------------------------------------------------------

/// Every parallel series on a path has exactly `observations` entries.
///
/// This is the invariant that lets the tiles index by observation without a
/// length check, and it holds *even for early-exit KO paths* because the
/// generator fills the frozen tail rather than truncating.
#[test]
fn every_series_has_the_configured_observation_count() {
    let bundle = demo();
    let n = SimulationConfig::demo().observations;

    for path in &bundle.paths {
        assert_eq!(path.dates.len(), n, "{}", path.id);
        assert_eq!(path.observations.len(), n, "{} observations", path.id);
        assert_eq!(path.worst_of_performance.len(), n, "{}", path.id);
        assert_eq!(path.coupon_memory_balance.len(), n, "{}", path.id);
        assert_eq!(
            path.node_details.len(),
            PayoffNodeId::ALL.len(),
            "{}",
            path.id
        );

        // `date_index` is a dense 0..n, so a tile can zip against it directly.
        for (i, obs) in path.observations.iter().enumerate() {
            assert_eq!(obs.date_index, i, "{} obs {i}", path.id);
            assert_eq!(obs.date, path.dates[i], "{} obs {i}", path.id);
        }
    }
}

// ---------------------------------------------------------------------------
// The KO frozen tail (spec test 9)
// ---------------------------------------------------------------------------

/// After a KO index, observations are frozen copies with no accrual and no
/// barrier flags.
///
/// This is the padding rule from `buildObservations`: the last real observation
/// is spread forward with `coupon_accrued`, `knockInAtDate` and `knockOutAtDate`
/// zeroed but **`couponMemoryBalance` inherited**. Inheriting the balance is the
/// non-obvious half — a KO path's final memory balance shows up on every frozen
/// observation, not just the one where it was struck.
#[test]
fn ko_paths_freeze_after_the_ko_index() {
    let bundle = demo();
    let mut checked = 0usize;

    for path in &bundle.paths {
        let Some(ko_index) = path.knock_out_date_index else {
            continue;
        };
        checked += 1;

        // The KO observation itself is the last *live* one.
        let ko_obs = &path.observations[ko_index];
        assert!(ko_obs.knock_out_at_date, "{} KO obs not flagged", path.id);
        assert!(
            ko_obs.worst_of_performance >= bundle.barriers.ko_barrier,
            "{} KO obs below the barrier",
            path.id
        );

        // Every observation after it is frozen.
        for obs in &path.observations[ko_index + 1..] {
            assert_eq!(obs.coupon_accrued, 0.0, "{} padded accrual", path.id);
            assert!(!obs.knock_in_at_date, "{} padded KI flag", path.id);
            assert!(!obs.knock_out_at_date, "{} padded KO flag", path.id);
            assert_eq!(
                obs.worst_of_performance, ko_obs.worst_of_performance,
                "{} padded level moved",
                path.id
            );
            // The memory balance carries the value from the KO observation.
            assert_eq!(
                obs.coupon_memory_balance, ko_obs.coupon_memory_balance,
                "{} padded memory balance",
                path.id
            );
        }

        // The underlying series freezes too.
        assert!(
            path.worst_of_performance[ko_index + 1..]
                .iter()
                .all(|w| *w == path.worst_of_performance[ko_index]),
            "{} worst-of kept moving after KO",
            path.id
        );
    }

    assert_eq!(checked, 67, "every KO path has a knock-out index");
}

/// An alive path has **no** knock-out index and never marks an observation as
/// knocked out. The mirror image of the freeze rule.
#[test]
fn alive_paths_have_no_ko_index_and_no_ko_flag() {
    let bundle = demo();

    for path in &bundle.paths {
        if path.knocked_out {
            continue;
        }
        assert_eq!(
            path.knock_out_date_index, None,
            "{} survived but recorded a KO index",
            path.id
        );
        assert!(
            path.observations.iter().all(|o| !o.knock_out_at_date),
            "{} survived but flagged a KO observation",
            path.id
        );
        assert!(
            path.worst_of_performance
                .iter()
                .all(|w| *w < bundle.barriers.ko_barrier),
            "{} survived but touched KO",
            path.id
        );
        // Surviving paths run the full schedule.
        assert_eq!(
            path.knock_in_triggered,
            path.settlement_type != SettlementType::None
        );
    }
}

// ---------------------------------------------------------------------------
// The barrier invariants, restated independently (spec test 4)
// ---------------------------------------------------------------------------

/// The three barrier rules the TypeScript only `console.warn`ed about.
///
/// `generate_paths` enforces these itself and returns `Err` on violation, so this
/// test cannot fail for the demo config. It is here as an independent restatement
/// of what "enforced" means, and it is the assertion to copy when a new barrier
/// configuration is added.
#[test]
fn barrier_invariants_hold_for_every_path() {
    let bundle = demo();
    let b = &bundle.barriers;

    for path in &bundle.paths {
        let worst = &path.worst_of_performance;

        // knockedOut => some observation reached KO.
        if path.knocked_out {
            assert!(
                worst.iter().any(|w| *w >= b.ko_barrier),
                "{} claims KO but never reached it",
                path.id
            );
        }

        // knock_in_triggered => some observation reached KI.
        if path.knock_in_triggered {
            assert!(
                worst.iter().any(|w| *w <= b.ki_barrier),
                "{} claims KI but never reached it",
                path.id
            );
        }

        // Neither flag => never touched either barrier.
        if !path.knock_in_triggered && !path.knocked_out {
            assert!(
                worst.iter().all(|w| *w > b.ki_barrier),
                "{} claims no KI but breached it",
                path.id
            );
            assert!(
                worst.iter().all(|w| *w < b.ko_barrier),
                "{} claims no KO but reached it",
                path.id
            );
        }

        // A recorded barrier index names an observation that actually crossed.
        if let Some(i) = path.knock_in_date_index {
            assert!(worst[i] <= b.ki_barrier, "{} KI index", path.id);
        }
        if let Some(i) = path.knock_out_date_index {
            assert!(worst[i] >= b.ko_barrier, "{} KO index", path.id);
        }
    }
}

/// A knock-in path that also knocked out must have breached KI *first*.
///
/// This is the distinction between the `ko` and `alive_ki_*` scenarios: a KO path
/// is allowed to have breached KI on the way out, but only before redemption.
#[test]
fn a_ko_path_with_knock_in_did_so_before_redemption() {
    let bundle = demo();

    for path in &bundle.paths {
        let (Some(ki), Some(ko)) = (path.knock_in_date_index, path.knock_out_date_index) else {
            continue;
        };
        if path.knock_in_triggered {
            assert!(
                ki < ko,
                "{} reports KI at {ki} but redeemed at {ko}",
                path.id,
                ki = ki,
                ko = ko
            );
        }
    }
}

/// `payoff` excludes the put, because `redemption_value` already contains it.
///
/// `payoff = redemption + coupon + memoryCoupon`, and for a knock-in path
/// `redemption = notional + putValue`. Adding `put_value` to the payoff would
/// double-count the loss. This looks like a bug and is not — see
/// [`fina_kernel::path_generator::compute_payoff`].
#[test]
fn payoff_is_redemption_plus_cashflows_and_does_not_double_count_the_put() {
    let bundle = demo();
    let b = &bundle.barriers;

    let mut ki_paths = 0usize;
    for path in &bundle.paths {
        let expected = fina_kernel::jsnum::round2(
            path.redemption_value + path.coupon_value + path.memory_coupon_value,
        );
        assert_eq!(path.payoff, expected, "{}", path.id);

        if path.put_value < 0.0 {
            ki_paths += 1;
            // The put is folded into redemption, and exactly once.
            assert_eq!(
                path.redemption_value,
                fina_kernel::jsnum::round2(b.notional + path.put_value),
                "{} redemption",
                path.id
            );
            assert!(
                path.payoff > path.redemption_value,
                "{} put not reflected in the payoff",
                path.id
            );
        } else {
            // No put exposure: redemption is par and settlement is `none`.
            assert_eq!(path.redemption_value, b.notional, "{}", path.id);
            assert_eq!(path.put_value, 0.0, "{}", path.id);
            assert_eq!(path.settlement_type, SettlementType::None, "{}", path.id);
        }
    }

    assert_eq!(ki_paths, 19, "every knock-in path has put exposure");
}

// ---------------------------------------------------------------------------
// Distributions (spec test 10)
// ---------------------------------------------------------------------------

// `compute_distribution` itself is private, so its hand-computed cases live in
// `path_generator`'s own unit tests, where they can call it directly. What
// follows checks the rule against the real 100-path sample, which is the part an
// integration test can see.

/// The percentile indices the generator uses, spelled out on the real sample.
///
/// `p05 = sorted[floor(0.05 * 99)] = sorted[4]` and `p95 = sorted[94]`. Both are
/// then rounded to 2dp. This asserts the *index* the rule picks, which is the
/// part that would silently change if the quantile were switched to
/// interpolation.
#[test]
fn percentiles_use_nearest_rank_on_the_sorted_sample() {
    let bundle = demo();

    for (name, stats) in [
        ("totalPayoff", &bundle.distributions.total_payoff),
        ("couponPv", &bundle.distributions.coupon_pv),
        ("putPv", &bundle.distributions.put_pv),
        ("worstOfFinal", &bundle.distributions.worst_of_final),
    ] {
        let mut sorted = stats.values.clone();
        sorted.sort_by(f64::total_cmp);
        let n = sorted.len();
        assert_eq!(n, 100, "{name}");

        let idx05 = (0.05 * (n as f64 - 1.0)).floor() as usize;
        let idx95 = (0.95 * (n as f64 - 1.0)).floor() as usize;
        assert_eq!((idx05, idx95), (4, 94), "{name} percentile indices");

        assert_eq!(
            stats.p05,
            fina_kernel::jsnum::round2(sorted[4]),
            "{name}.p05"
        );
        assert_eq!(
            stats.p95,
            fina_kernel::jsnum::round2(sorted[94]),
            "{name}.p95"
        );

        // Even sample size: the median is the mean of the two central values.
        assert_eq!(
            stats.median,
            fina_kernel::jsnum::round2((sorted[49] + sorted[50]) / 2.0),
            "{name}.median"
        );

        // Mean and stdDev read the *original* order, not the sorted copy.
        let mean = fina_kernel::jsnum::sum_ordered(&stats.values) / n as f64;
        assert_eq!(stats.mean, fina_kernel::jsnum::round2(mean), "{name}.mean");

        let variance = stats
            .values
            .iter()
            .map(|v| {
                let d = v - mean;
                d * d
            })
            .sum::<f64>()
            / n as f64;
        assert_eq!(
            stats.std_dev,
            fina_kernel::jsnum::round2(variance.sqrt()),
            "{name}.stdDev"
        );

        // `values` is the raw sample in generation order, not sorted.
        assert_ne!(stats.values, sorted, "{name}.values must be unsorted");
    }
}

// ---------------------------------------------------------------------------
// Validation (spec test 12)
// ---------------------------------------------------------------------------

/// Invalid configurations return `Err`, never panic.
///
/// The kernel is called from four transports, three of which surface a panic as
/// a dropped connection. Every rejected input must be a typed error.
#[test]
fn invalid_configuration_returns_an_error() {
    let base = SimulationConfig::demo();

    /// A labelled mutation of the demo config.
    type Case = (&'static str, Box<dyn Fn(&mut SimulationConfig)>);

    let cases: Vec<Case> = vec![
        (
            "ki >= ko",
            Box::new(|c: &mut SimulationConfig| {
                c.barriers.ki_barrier = c.barriers.ko_barrier;
            }),
        ),
        (
            "ki > ko",
            Box::new(|c: &mut SimulationConfig| {
                c.barriers.ki_barrier = c.barriers.ko_barrier + 0.1;
            }),
        ),
        (
            "ki == 0",
            Box::new(|c: &mut SimulationConfig| {
                c.barriers.ki_barrier = 0.0;
            }),
        ),
        (
            "ki < 0",
            Box::new(|c: &mut SimulationConfig| {
                c.barriers.ki_barrier = -0.1;
            }),
        ),
        (
            "notional == 0",
            Box::new(|c: &mut SimulationConfig| {
                c.barriers.notional = 0.0;
            }),
        ),
        (
            "notional < 0",
            Box::new(|c: &mut SimulationConfig| {
                c.barriers.notional = -100.0;
            }),
        ),
        (
            "observations == 0",
            Box::new(|c: &mut SimulationConfig| {
                c.observations = 0;
            }),
        ),
        (
            "path_count == 0",
            Box::new(|c: &mut SimulationConfig| {
                c.path_count = 0;
            }),
        ),
    ];

    for (label, mutate) in cases {
        let mut config = base.clone();
        mutate(&mut config);
        match generate_paths(config, |_| {}) {
            Ok(_) => panic!("{label} should have been rejected"),
            Err(e) => assert!(
                matches!(e, FinaError::InvalidBarriers { .. }),
                "{label} produced {e:?}, expected InvalidBarriers"
            ),
        }
    }
}

/// A minimal valid configuration still generates, and a single path is enough to
/// exercise every code path in the series builder.
///
/// Not a golden comparison — a different `observations` value cannot match
/// `golden.json`. The point is that the generator does not assume 60.
#[test]
fn a_small_valid_configuration_generates() {
    let config = SimulationConfig {
        seed: 7,
        path_count: 4,
        observations: 3,
        start_date: "2024-01-15".to_string(),
        barriers: SimulationConfig::demo().barriers,
    };
    let bundle = generate_paths(config, |_| {}).expect("valid config");

    assert_eq!(bundle.paths.len(), 4);
    for path in &bundle.paths {
        assert_eq!(path.observations.len(), 3, "{}", path.id);
        assert_eq!(path.worst_of_performance.len(), 3, "{}", path.id);
        assert_eq!(path.dates.len(), 3, "{}", path.id);
        // The node table still has all twelve rows whatever the path count.
        assert_eq!(
            path.node_details.len(),
            PayoffNodeId::ALL.len(),
            "{}",
            path.id
        );
    }

    // Node `probability` still reads as a share of the actual population.
    let aggregate = &bundle.paths[0].node_details[PayoffNodeId::ALL
        .iter()
        .position(|n| *n == PayoffNodeId::AggregatePV)
        .expect("AggregatePV exists")];
    assert_eq!(aggregate.affected_paths, 1);
    assert_eq!(aggregate.probability, 0.25, "1 of 4 paths");

    // With 4 paths the scaled counts are quarters of 100,000, rounded.
    assert_eq!(bundle.branch_stats.total_paths, 100_000);
    assert_eq!(bundle.sample_path_count(), 4);
}

// ---------------------------------------------------------------------------
// Progress (spec test 13)
// ---------------------------------------------------------------------------

/// The progress callback fires, rises monotonically and finishes at
/// `path_count`.
///
/// This is the contract an adapter bridges to SSE or a Tauri channel, so a
/// non-monotonic or short stream is a visible bug: a progress bar that jumps
/// backwards, or a job that reports done at 90%.
#[test]
fn progress_is_monotonic_and_completes() {
    let mut log = ProgressLog::new();
    generate_paths(SimulationConfig::demo(), |event| log.record(event)).expect("valid config");

    let events = log.events();
    assert!(!events.is_empty(), "no progress events were emitted");

    for event in events {
        assert!(event.total > 0, "phase {} has no total", event.phase);
        assert!(
            event.completed <= event.total,
            "phase {} overshot: {} of {}",
            event.phase,
            event.completed,
            event.total
        );
        assert!(!event.phase.is_empty(), "an event had no phase name");
    }

    // Monotonic across the whole stream, phase changes included.
    for pair in events.windows(2) {
        assert!(
            pair[1].completed >= pair[0].completed,
            "progress went backwards: {} then {}",
            pair[0].completed,
            pair[1].completed
        );
    }

    // Ends at 100%.
    let last = events.last().expect("at least one event");
    assert_eq!(last.completed, 100);
    assert_eq!(last.ratio(), 1.0);
    assert!(log.is_well_formed());

    // Every generation phase is announced, so a UI can label its stages.
    let phases: std::collections::BTreeSet<&str> =
        events.iter().map(|e| e.phase.as_str()).collect();
    assert!(
        phases.contains("assign_scenarios"),
        "missing phase, got {phases:?}"
    );
    assert!(
        phases.contains("generate_series"),
        "missing phase, got {phases:?}"
    );
    assert!(
        phases.contains("node_details"),
        "missing phase, got {phases:?}"
    );
    assert!(
        phases.contains("aggregate"),
        "missing phase, got {phases:?}"
    );
}

/// A path count that is not a multiple of ten still reports 100% at the end.
///
/// The generator ticks every tenth path, so a count like 7 would end on the
/// explicit final tick rather than a multiple-of-ten one. Cheap insurance against
/// the off-by-one that would leave the last path unreported.
#[test]
fn progress_completes_for_any_path_count() {
    for path_count in [1usize, 7, 10, 13] {
        let config = SimulationConfig {
            path_count,
            ..SimulationConfig::demo()
        };
        let mut log = ProgressLog::new();
        generate_paths(config, |event| log.record(event)).expect("valid config");

        let last = log.events().last().expect("at least one event");
        assert_eq!(
            last.completed,
            u32::try_from(path_count).unwrap(),
            "{path_count} paths should end at 100%"
        );
        assert_eq!(last.ratio(), 1.0, "{path_count} paths");
        assert!(log.is_well_formed(), "{path_count} paths");
    }
}

/// A caller that ignores progress gets the same bundle.
#[test]
fn progress_callbacks_do_not_affect_the_result() {
    let silent = generate_paths(SimulationConfig::demo(), |_| {}).expect("valid config");
    let noisy = generate_paths(SimulationConfig::demo(), |_: ProgressEvent| {
        std::hint::black_box(1);
    })
    .expect("valid config");

    assert_eq!(
        serde_json::to_string(&silent).unwrap(),
        serde_json::to_string(&noisy).unwrap(),
        "progress reporting must not perturb generation"
    );
}
