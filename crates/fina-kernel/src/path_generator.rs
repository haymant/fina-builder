//! Path generation: the port of `src/mock-data/generatePaths.ts`.
//!
//! # What this actually is
//!
//! Despite the name, this is **not** a Monte Carlo simulation. It is a
//! scenario-constrained path *synthesiser*: each path is first assigned one of
//! four labels (`ko`, `alive_ki_cash`, `alive_ki_physical`, `alive_no_ki`) from a
//! deterministic draw, then a random walk is generated and clamped so that the
//! assigned scenario actually happens. The walk is decorative; the label is the
//! cause.
//!
//! Several outputs are therefore structural artifacts rather than measured
//! quantities, and the module says so at each site:
//!
//! - `node_details`' `probability` is a label frequency, not an empirical
//!   probability.
//! - `conditional_expected_payoff` values are hard-coded display constants.
//! - `branch_stats::total_paths` is 1,000x the sample; see
//!   [`crate::types::BranchStats`].
//!
//! Preserved exactly, not repaired. See `FEATURE.ts.md` for the inventory and
//! `PHASE1_MIGRATION_PROMPT.md` §10 for the full trap list.
//!
//! # Draw-order contract
//!
//! [`generate_paths`] consumes PRNG draws in an order fixed by the TypeScript.
//! The sequence per path is:
//!
//! 1. three draws for the initial AAPL/MSFT/NVDA levels
//! 2. one draw for the KO event date — **only** when `scenario == ko`
//! 3. one draw for the KI event date — **only** when the scenario is an
//!    `alive_ki_*` variant
//! 4. per observation, up to four draws: three for the drift step, plus one or
//!    three more when an event fires at that step
//! 5. two draws at the end for funding and discounting
//!
//! Steps 2 and 3 are conditional, and step 4 skips its drift draws on a KO
//! event step. Inserting, removing or reordering a single draw shifts every
//! subsequent value for every path and breaks golden parity.
//!
//! ```
//! use fina_kernel::path_generator::{generate_paths, SimulationConfig};
//!
//! let bundle = generate_paths(SimulationConfig::demo(), |_| {}).unwrap();
//! assert_eq!(bundle.paths.len(), 100);
//! assert_eq!(bundle.branch_stats.total_paths, 100_000);
//! ```

// This module is a line-for-line port of `src/mock-data/generatePaths.ts`, and
// its binding names are chosen to match the TypeScript identifiers they replace:
// `a`/`m`/`n` for the three underlyings, `w` for worst-of, `t` for the
// observation index, `ko_event`/`ko_index`, `ki_event`/`ki_index`,
// `ki_input`/`ko_input`. Renaming them to satisfy the naming lints would break
// the 1:1 traceability that makes reviewing this file against the original
// practical — the whole point of reading a port side by side with its source.
#![allow(clippy::many_single_char_names, clippy::similar_names)]

use crate::dates::{demo_dates, DEMO_START_DATE};
use crate::error::{FinaError, Result};
use crate::jsnum::{
    clamp, js_floor_to_usize, js_max, js_max_slice, js_min, js_min3, js_min_slice, js_round,
    js_to_fixed, round2, round4, sum_ordered,
};
use crate::progress::ProgressEvent;
use crate::rng::Mulberry32;
use crate::types::{
    BranchStats, DistributionStats, NodeDetailSnapshot, PathAttribution, PathObservation,
    PayoffNodeId, ProductBarriers, SettlementType, SimulationBundle, SimulationDistributions,
    SimulationPath,
};
use serde::{Deserialize, Serialize};

/// Number of paths in the demo sample.
pub const PATH_COUNT: usize = 100;

/// Number of monthly observations per path.
pub const OBSERVATIONS: usize = 60;

/// The demo product name, shown in the UI.
pub const PRODUCT_NAME: &str = "Worst Of Phoenix Autocall";

/// The demo tagline, shown in the UI.
pub const TAGLINE: &str = "Debugging Monte Carlo Paths Like Source Code";

/// Underlying symbols, in the order used by the worst-of calculation.
pub const UNDERLYINGS: [&str; 3] = ["AAPL", "MSFT", "NVDA"];

/// Input to [`generate_paths`].
///
/// The demo uses [`Self::demo`]. The struct exists so the port can be exercised
/// with other shapes in tests; note that changing `path_count` or
/// `observations` changes **every** draw position and will not match
/// `golden.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationConfig {
    /// PRNG seed. The demo uses `42`.
    pub seed: u32,
    /// How many paths to generate.
    pub path_count: usize,
    /// Observations per path.
    pub observations: usize,
    /// First observation date, `YYYY-MM-DD`.
    pub start_date: String,
    /// Barriers and coupon terms.
    pub barriers: ProductBarriers,
}

impl Default for SimulationConfig {
    fn default() -> Self {
        Self::demo()
    }
}

impl SimulationConfig {
    /// The exact configuration behind `golden.json`: seed 42, 100 paths,
    /// 60 monthly observations from 2024-01-15.
    #[must_use]
    pub fn demo() -> Self {
        Self {
            seed: 42,
            path_count: PATH_COUNT,
            observations: OBSERVATIONS,
            start_date: DEMO_START_DATE.to_string(),
            barriers: ProductBarriers::default(),
        }
    }

    /// Rejects configurations the generator cannot honour.
    ///
    /// The TypeScript original silently produced degenerate output instead of
    /// failing. Since the kernel is the single source of truth for four
    /// transports, a loud error beats a bundle of empty paths that renders as a
    /// blank chart.
    ///
    /// # Errors
    /// - `path_count == 0`: every downstream statistic would divide by zero.
    /// - `observations == 0`: `build_observations` indexes `dates[0]`.
    /// - `notional <= 0`: a non-positive notional makes the payoff meaningless.
    /// - `ki_barrier <= 0`: every observation would breach the gate.
    /// - `ki_barrier >= ko_barrier`: the knock-in gate can never be crossed
    ///   without also crossing knock-out, so no coherent path exists.
    /// - non-finite barrier values, which propagate silently through `clamp`.
    pub fn validate(&self) -> Result<()> {
        let b = &self.barriers;
        let finite = [
            ("ki_barrier", b.ki_barrier),
            ("ko_barrier", b.ko_barrier),
            ("coupon_lower", b.coupon_lower),
            ("coupon_upper", b.coupon_upper),
            ("coupon_rate", b.coupon_rate),
            ("notional", b.notional),
        ];
        for (name, v) in finite {
            if !v.is_finite() {
                return Err(FinaError::InvalidBarriers(format!("{name} is not finite")));
            }
        }
        if self.path_count == 0 {
            return Err(FinaError::InvalidBarriers("path_count must be > 0".into()));
        }
        if self.observations == 0 {
            return Err(FinaError::InvalidBarriers(
                "observations must be > 0".into(),
            ));
        }
        if b.notional <= 0.0 {
            return Err(FinaError::InvalidBarriers(format!(
                "notional must be > 0, got {}",
                b.notional
            )));
        }
        if b.ki_barrier <= 0.0 {
            // A non-positive knock-in barrier makes the gate meaningless: every
            // observation is "at or below" it, so every path is knocked in and the
            // down-and-in put is charged on all of them.
            return Err(FinaError::InvalidBarriers(format!(
                "ki_barrier must be > 0, got {}",
                b.ki_barrier
            )));
        }
        if b.ki_barrier >= b.ko_barrier {
            return Err(FinaError::InvalidBarriers(format!(
                "ki_barrier ({}) must be < ko_barrier ({})",
                b.ki_barrier, b.ko_barrier
            )));
        }
        Ok(())
    }
}

/// Which branch a path is forced into. Assigned before the walk is generated,
/// which is what makes this a synthesiser rather than a simulation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PathScenario {
    /// Knocked out before maturity.
    Ko,
    /// Survives to maturity with a knock-in breach, settling in cash.
    AliveKiCash,
    /// Survives to maturity with a knock-in breach, settling physically.
    AliveKiPhysical,
    /// Survives to maturity without ever breaching knock-in.
    AliveNoKi,
}

impl PathScenario {
    /// Assigns scenarios from one PRNG draw per path.
    ///
    /// Port of `assignScenarios`. The thresholds encode a target mix of
    /// KO 65%, alive 35% (KI 20%, no-KI 15%), split roughly half cash / half
    /// physical inside the KI bucket. Those are *targets*, not guarantees: the
    /// realised mix is whatever 100 uniform draws produce, and it is this
    /// realised count that feeds `branch_stats` and the node `probability`
    /// values.
    ///
    /// Public so adapters and tests can report the assigned mix without
    /// re-deriving it from the paths. Re-seeding with the same `seed` and
    /// `path_count` must reproduce the same assignment, which is what makes the
    /// bundle deterministic (invariant I-2).
    #[must_use]
    pub fn assign(rng: &mut Mulberry32, path_count: usize) -> Vec<Self> {
        let mut out = Vec::with_capacity(path_count);
        for _ in 0..path_count {
            // Exactly one draw per path, before any other consumption.
            let u = rng.next_f64();
            out.push(if u < 0.65 {
                Self::Ko
            } else if u < 0.75 {
                Self::AliveKiCash
            } else if u < 0.85 {
                Self::AliveKiPhysical
            } else {
                Self::AliveNoKi
            });
        }
        out
    }

    /// Whether this scenario forces a knock-in breach at maturity.
    #[must_use]
    pub fn is_alive_with_ki(&self) -> bool {
        matches!(self, Self::AliveKiCash | Self::AliveKiPhysical)
    }
}

/// The worst-of walk for one path, plus where the barriers were crossed.
///
/// Mirrors the return type of `generatePerformanceSeries`.
#[derive(Debug, Clone, PartialEq)]
struct PerformanceSeries {
    /// AAPL levels, already `round4`-rounded.
    aapl: Vec<f64>,
    /// MSFT levels.
    msft: Vec<f64>,
    /// NVDA levels.
    nvda: Vec<f64>,
    /// `min(aapl, msft, nvda)` per step.
    worst_of: Vec<f64>,
    /// First observation at which worst-of reached the KO barrier.
    ko_index: Option<usize>,
    /// First observation at which worst-of reached the KI barrier.
    ki_index: Option<usize>,
}

/// Generates the complete simulation bundle.
///
/// Deterministic: identical `config` yields identical bytes forever
/// (`PHASE1_MIGRATION_PROMPT.md` invariant I-2). Verified by the golden parity
/// test.
///
/// # Errors
/// Returns [`FinaError::InvalidBarriers`] if `config.validate()` fails, and
/// [`FinaError::Generation`] if a path ends up inconsistent with its scenario
/// after the consistency-enforcement pass. The TypeScript original only logged
/// `console.warn` in the latter case; a silent inconsistency would reach four
/// transports and render as contradictory tiles.
///
/// # Progress
/// `on_progress` receives events whose `completed` count rises from 0 to
/// `path_count` and never decreases. Adapters bridge this to a Tauri channel,
/// SSE, or stderr lines.
/// Narrows a `usize` work count to the `u32` a [`ProgressEvent`] carries.
///
/// Saturating rather than panicking: a progress tick is a display artifact, and
/// refusing to generate a bundle because a count exceeded 4 billion would be a
/// worse failure than showing an approximate tick.
fn progress_count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Builds one path, consuming that path's entire share of `rng`.
///
/// Split out of [`generate_paths`] because the draw order is the load-bearing
/// part and it should be readable in one screen: series, then observations, then
/// attribution refinement. Nothing may draw from `rng` between the series and
/// [`refine_attribution`].
fn build_one_path(
    index: usize,
    scenario: PathScenario,
    rng: &mut Mulberry32,
    dates: &[String],
    barriers: &ProductBarriers,
    n: usize,
) -> SimulationPath {
    let series = generate_performance_series(scenario, rng, barriers, n);
    let built = build_observations(dates, &series, scenario, barriers, n);

    // Flags derive strictly from the series, which is the source of truth.
    let knocked_out = series.ko_index.is_some();
    let knock_in_triggered = match (series.ki_index, knocked_out) {
        (Some(_), false) => true,
        (Some(ki), true) => Some(ki) < series.ko_index,
        // A path with no KI crossing is still KI-triggered if its scenario says
        // so; the enforcement pass will have forced a crossing.
        (None, _) => scenario.is_alive_with_ki(),
    };

    // Re-align to the scenario for surviving paths. A KO path keeps the computed
    // value, since it may legitimately have breached KI on the way out — that is
    // exactly what distinguishes `ko` from `alive_ki_*`.
    let final_knock_in = match scenario {
        PathScenario::AliveKiCash | PathScenario::AliveKiPhysical => true,
        PathScenario::AliveNoKi => false,
        PathScenario::Ko => knock_in_triggered,
    };
    let final_knock_out = scenario == PathScenario::Ko;

    let payoff = compute_payoff(
        scenario,
        &series,
        built.coupon_value,
        built.memory_coupon_value,
        barriers,
        n,
    );
    // Draw order matters: `refine_attribution` is the last consumption of `rng`
    // for this path.
    let attribution = refine_attribution(payoff.attribution, rng);

    SimulationPath {
        id: format!("path-{:03}", index + 1),
        path_index: index + 1,
        dates: dates.to_vec(),
        coupon_memory_balance: built
            .observations
            .iter()
            .map(|o| o.coupon_memory_balance)
            .collect(),
        observations: built.observations,
        worst_of_performance: series.worst_of,
        knock_in_triggered: final_knock_in,
        knocked_out: final_knock_out,
        knock_out_date_index: series.ko_index,
        knock_in_date_index: series.ki_index,
        payoff: payoff.payoff,
        redemption_value: payoff.redemption_value,
        coupon_value: built.coupon_value,
        put_value: payoff.put_value,
        memory_coupon_value: built.memory_coupon_value,
        settlement_type: payoff.settlement_type,
        traversal: build_traversal(scenario),
        attribution,
        // Filled in a second pass, once the whole population is known.
        node_details: Vec::with_capacity(PayoffNodeId::ALL.len()),
    }
}

/// Generates the whole path cube.
///
/// Port of `generateSimulationBundle`. See the module docs for what this is
/// and is not.
///
/// # Errors
/// Returns [`FinaError::InvalidBarriers`] if `config.validate()` fails, and
/// [`FinaError::Generation`] if a path ends up inconsistent with its scenario
/// after the consistency-enforcement pass. The TypeScript original only logged
/// `console.warn` in the latter case; a silent inconsistency would reach four
/// transports and render as contradictory tiles.
///
/// # Progress
///
/// `on_progress` reports **paths fully generated**, on a single `0..=path_count`
/// axis: `completed` never decreases, never exceeds `total`, and the last event
/// reports `path_count`. `phase` names the stage, so a transport can label it.
///
/// The axis plateaus at `path_count` for the two phases that run after the paths
/// exist — `node_details` and `aggregate` annotate the sample rather than extend
/// it. That is deliberate: resetting `completed` to 0 for a new phase would make
/// a progress bar jump backwards, and per-phase totals would make the value
/// meaningless as an overall percentage.
// `config` is taken by value deliberately: it is small, and the public signature
// should not imply the caller must keep it alive across the call.
#[allow(clippy::needless_pass_by_value)]
pub fn generate_paths<F>(config: SimulationConfig, mut on_progress: F) -> Result<SimulationBundle>
where
    F: FnMut(ProgressEvent),
{
    config.validate()?;

    let n = config.observations;
    let barriers = &config.barriers;
    let path_count = config.path_count;
    let total = progress_count(path_count);
    let mut rng = Mulberry32::new(config.seed);
    let dates = demo_dates(n);
    let scenarios = PathScenario::assign(&mut rng, path_count);

    on_progress(ProgressEvent::new(
        "assign_scenarios",
        0,
        total,
        "assigning scenario labels",
    ));

    let mut paths: Vec<SimulationPath> = Vec::with_capacity(path_count);
    for (i, &scenario) in scenarios.iter().enumerate() {
        paths.push(build_one_path(i, scenario, &mut rng, &dates, barriers, n));

        // Every tenth path, plus the last, so the final tick lands on 100%.
        if (i + 1) % 10 == 0 || i + 1 == path_count {
            on_progress(ProgressEvent::new(
                "generate_series",
                progress_count(i + 1),
                total,
                format!("generated path-{:03}", i + 1),
            ));
        }
    }

    // Population counts feed the node `probability` and `affectedPaths` fields.
    // Derived from the finished paths, not the scenario labels, so a consistency
    // correction upstream is reflected here.
    let population = Population::from_paths(&paths);

    // `completed` is already `path_count` here: every path exists. The remaining
    // phases annotate those paths rather than adding to the sample, so the count
    // plateaus rather than resetting — a progress bar must never go backwards.
    on_progress(ProgressEvent::new(
        "node_details",
        total,
        total,
        "attaching node snapshots",
    ));
    for (path, &scenario) in paths.iter_mut().zip(&scenarios) {
        path.node_details = build_node_details(path, scenario, population, barriers, path_count, n);
    }

    verify_consistency(&paths, &scenarios, barriers, n)?;

    let branch_stats = build_branch_stats(&paths);
    let distributions = build_distributions(&paths, n);

    on_progress(ProgressEvent::new(
        "aggregate",
        total,
        total,
        "bundle complete",
    ));

    paths.shrink_to_fit();
    Ok(SimulationBundle {
        product_name: PRODUCT_NAME.to_string(),
        tagline: TAGLINE.to_string(),
        underlyings: UNDERLYINGS.iter().map(|s| (*s).to_string()).collect(),
        barriers: *barriers,
        paths,
        branch_stats,
        distributions,
    })
}

/// Generates one path's worst-of walk, enforcing the assigned scenario.
///
/// Port of `generatePerformanceSeries`. Two structural details are load-bearing
/// and easy to get wrong:
///
/// 1. **The drift step is skipped on a KO event step.** The TypeScript guard is
///    `if (!(scenario === 'ko' && koEvent === t))`. A KO event step consumes
///    three draws (the lift plus two jitter terms) and *no* drift draws, so it
///    takes four draws fewer than a normal step would if ported naively.
/// 2. **The KO and KI event draws are conditional on the scenario.** A
///    non-`ko` path never draws for `ko_event`, and an `alive_no_ki` path never
///    draws for `ki_event`. Any unconditional draw shifts the whole sequence.
///
/// The KO event window is `6 + floor(rng * 40)` while the KI event window is
/// `8 + floor(rng * 35)`. The asymmetry is a copy-paste artefact in the
/// original, preserved verbatim — see `PHASE1_MIGRATION_PROMPT.md` pitfall P-4.
fn generate_performance_series(
    scenario: PathScenario,
    rng: &mut Mulberry32,
    barriers: &ProductBarriers,
    n: usize,
) -> PerformanceSeries {
    let mut levels = Levels::new(n);

    // Draws 1-3. The `0.04` band puts each starting level within 2% of par.
    let mut a = 1.0 + (rng.next_f64() - 0.5) * 0.04;
    let mut m = 1.0 + (rng.next_f64() - 0.5) * 0.04;
    let mut nv = 1.0 + (rng.next_f64() - 0.5) * 0.04;

    let mut ko_index: Option<usize> = None;
    let mut ki_index: Option<usize> = None;

    // Draws 4 and 5. Both are scenario-conditional and must be drawn here,
    // before the first observation step, or the whole path shifts.
    let ScenarioEvents {
        ko: ko_event,
        ki: ki_event,
    } = ScenarioEvents::draw(scenario, rng);

    for t in 0..n {
        // Each branch returns its own drift and volatility. Written as a match
        // expression rather than mutable bindings because every branch assigns
        // both before use — the TypeScript's `let drift = 0; let vol = 0.035`
        // initialisers were already dead there too.
        let (drift, vol) = match scenario {
            PathScenario::Ko => {
                if ko_event == Some(t) {
                    // Lift the worst underlying through the KO barrier. Three
                    // draws, and the drift step below is skipped.
                    let lift = barriers.ko_barrier + 0.01 + rng.next_f64() * 0.08;
                    let target = lift;
                    let current_min = js_min3(a, m, nv);
                    let scale = target / js_max(current_min, 0.01);
                    a *= scale;
                    m *= scale * (0.98 + rng.next_f64() * 0.04);
                    nv *= scale * (0.98 + rng.next_f64() * 0.04);
                }
                (0.004, 0.03)
            }
            PathScenario::AliveNoKi => (0.001, 0.025),
            _ => {
                // Alive with knock-in: must cross KI, must not reach KO.
                if ki_event == Some(t) {
                    // One draw here; the drift step still runs on this step, so a
                    // KI event step consumes four draws, not one.
                    let plunge = barriers.ki_barrier - 0.02 - rng.next_f64() * 0.12;
                    // `indexOf` resolves ties to the first matching name, which
                    // `position` also does.
                    let mut names = [a, m, nv];
                    let worst = js_min_slice(&names);
                    let idx = names
                        .iter()
                        .position(|x| *x == worst)
                        .expect("worst-of is always a member of the three names");
                    names[idx] = plunge;
                    a = names[0];
                    m = names[1];
                    nv = names[2];
                }
                (-0.003, 0.04)
            }
        };

        // Drift and noise. `*=` keeps the TypeScript's left-to-right grouping:
        // `((1 + drift) + ((rng() - 0.5) * vol))`.
        if !(scenario == PathScenario::Ko && ko_event == Some(t)) {
            a *= 1.0 + drift + (rng.next_f64() - 0.5) * vol;
            m *= 1.0 + drift * 0.9 + (rng.next_f64() - 0.5) * vol;
            nv *= 1.0 + drift * 1.1 + (rng.next_f64() - 0.5) * vol * 1.2;
        }

        // Soft constraints that keep the scenario achievable.
        [a, m, nv] = hold_within_scenario(scenario, barriers, ki_event, ko_event, t, [a, m, nv]);

        // Universal hard bounds. Preserved verbatim; these can and do conflict
        // with the soft constraints above for extreme barrier configurations.
        a = clamp(a, 0.25, 1.45);
        m = clamp(m, 0.25, 1.45);
        nv = clamp(nv, 0.25, 1.45);

        let w = js_min3(a, m, nv);
        levels.record(a, m, nv, w);

        if ko_index.is_none() && w >= barriers.ko_barrier {
            ko_index = Some(t);
        }
        if ki_index.is_none() && w <= barriers.ki_barrier {
            ki_index = Some(t);
        }

        // A KO path freezes: every later observation repeats the KO level, so
        // the series stays full length even though the loop exits early. The
        // `== Some(t)` is really `is_some()`: reaching here with an earlier
        // `ko_index` is impossible, because that iteration would have broken.
        if scenario == PathScenario::Ko && ko_index == Some(t) {
            levels.freeze_from(t, n);
            break;
        }
    }

    // ---- Consistency enforcement -----------------------------------------
    // The clamping above biases the walk toward its scenario but does not
    // guarantee it.
    enforce_scenario(
        scenario,
        barriers,
        n,
        &mut levels,
        &mut ko_index,
        &mut ki_index,
    );

    PerformanceSeries {
        aapl: levels.aapl,
        msft: levels.msft,
        nvda: levels.nvda,
        worst_of: levels.worst_of,
        ko_index,
        ki_index,
    }
}

/// The four parallel price series for one path, all the same length.
struct Levels {
    aapl: Vec<f64>,
    msft: Vec<f64>,
    nvda: Vec<f64>,
    worst_of: Vec<f64>,
}

impl Levels {
    /// Four empty series, each with room for `n` observations.
    fn new(n: usize) -> Self {
        Self {
            aapl: Vec::with_capacity(n),
            msft: Vec::with_capacity(n),
            nvda: Vec::with_capacity(n),
            worst_of: Vec::with_capacity(n),
        }
    }

    /// Appends one observation.
    ///
    /// The `worst_of` level is stored alongside the three names so the series
    /// cannot drift out of agreement with them. Every level is rounded to 4dp
    /// here, once, at the point it enters the series — the unrounded values are
    /// used only for the barrier comparisons in the same iteration.
    fn record(&mut self, aapl: f64, msft: f64, nvda: f64, worst_of: f64) {
        self.aapl.push(round4(aapl));
        self.msft.push(round4(msft));
        self.nvda.push(round4(nvda));
        self.worst_of.push(round4(worst_of));
    }

    /// Repeats observation `t` across every later slot, out to `n`.
    ///
    /// An autocalled path stops evolving. The tail is **filled** rather than
    /// truncated so every path keeps exactly `n` observations, which is what
    /// lets the tiles index by observation without a length check.
    fn freeze_from(&mut self, t: usize, n: usize) {
        debug_assert!(t < self.worst_of.len(), "freeze_from called before record");
        let (a, m, nv, w) = (self.aapl[t], self.msft[t], self.nvda[t], self.worst_of[t]);
        for _ in (t + 1)..n {
            self.aapl.push(a);
            self.msft.push(m);
            self.nvda.push(nv);
            self.worst_of.push(w);
        }
    }
}

/// The observation indices at which the walk is forced through a barrier.
struct ScenarioEvents {
    ko: Option<usize>,
    ki: Option<usize>,
}

impl ScenarioEvents {
    /// Draws the KO and KI event indices.
    ///
    /// # Draw order is load-bearing
    ///
    /// `ko` is drawn before `ki`, and each is **skipped entirely** for the
    /// scenarios that do not use it. Drawing either unconditionally, or in the
    /// other order, shifts every subsequent draw and invalidates the whole
    /// bundle.
    ///
    /// The two windows deliberately differ: `ko` is `6 + floor(rng * 40)` and
    /// `ki` is `8 + floor(rng * 35)`. That asymmetry — different offset, different
    /// width — is a copy-paste artefact of the original, preserved verbatim
    /// (`PHASE1_MIGRATION_PROMPT.md` pitfall P-4).
    fn draw(scenario: PathScenario, rng: &mut Mulberry32) -> Self {
        let ko = if scenario == PathScenario::Ko {
            Some(6 + js_floor_to_usize(rng.next_f64() * 40.0))
        } else {
            None
        };
        let ki = if scenario.is_alive_with_ki() {
            Some(8 + js_floor_to_usize(rng.next_f64() * 35.0))
        } else {
            None
        };
        Self { ko, ki }
    }
}

/// Applies the per-observation soft constraints that keep a scenario achievable.
///
/// These are *biases*, not guarantees: they stop the walk from drifting somewhere
/// the scenario cannot recover from, but they do not force a barrier crossing.
/// [`enforce_scenario`] does the forcing afterwards. Each branch is deliberately
/// asymmetric — the gaps below KI, at KO and around the event windows are all
/// different — because they were different in the TypeScript and the exact
/// values are part of the numeric contract.
///
/// Takes and returns `(aapl, msft, nvda)` rather than mutating, so the caller
/// keeps the only authoritative copy of the three names.
fn hold_within_scenario(
    scenario: PathScenario,
    barriers: &ProductBarriers,
    ki_event: Option<usize>,
    ko_event: Option<usize>,
    t: usize,
    [mut a, mut m, mut nv]: [f64; 3],
) -> [f64; 3] {
    match scenario {
        PathScenario::AliveNoKi => {
            // Held in a narrow band above KI and below KO for the whole life.
            let lo = barriers.ki_barrier + 0.02;
            let hi = barriers.ko_barrier - 0.01;
            [clamp(a, lo, hi), clamp(m, lo, hi), clamp(nv, lo, hi)]
        }
        _ if scenario.is_alive_with_ki() => {
            // Cap below KO for the whole life.
            let cap = barriers.ko_barrier - 0.005;
            a = js_min(a, cap);
            m = js_min(m, cap);
            nv = js_min(nv, cap);
            if let Some(event) = ki_event {
                if t < event {
                    // Before the KI event, stay clearly above the barrier so the
                    // crossing is unambiguous.
                    let floor = barriers.ki_barrier + 0.01;
                    a = js_max(a, floor);
                    m = js_max(m, floor);
                    nv = js_max(nv, floor);
                }
            }
            [a, m, nv]
        }
        _ => {
            if let Some(event) = ko_event {
                if t < event {
                    // Before the KO event, stay below KO so the event is genuinely
                    // the first crossing.
                    let cap = barriers.ko_barrier - 0.01;
                    a = js_min(a, cap);
                    m = js_min(m, cap);
                    nv = js_min(nv, cap);
                }
            }
            [a, m, nv]
        }
    }
}

/// Patches a generated walk so it actually realises its assigned scenario.
///
/// The clamping in [`generate_performance_series`] biases the walk toward the
/// scenario but does not guarantee it: a KO lift can still land below the
/// barrier if the jitter term pulls it back, and an alive path's noise can push
/// it through KO. The TypeScript patches the series after the fact; so does this,
/// and every patched value is written back to **all four** series so the
/// per-name levels stay consistent with `worstOf`.
///
/// Two fallback indices are preserved verbatim and differ on purpose: a KO path
/// that failed to autocall is forced at observation `30`, a knock-in path that
/// failed to breach at observation `25`. That asymmetry is a copy-paste artefact
/// of the original (pitfall P-4).
///
/// Mutates `levels` and the two barrier indices in place.
fn enforce_scenario(
    scenario: PathScenario,
    barriers: &ProductBarriers,
    n: usize,
    levels: &mut Levels,
    ko_index: &mut Option<usize>,
    ki_index: &mut Option<usize>,
) {
    let Levels {
        aapl,
        msft,
        nvda,
        worst_of,
    } = levels;

    if scenario == PathScenario::Ko {
        if ko_index.is_none() {
            // The scenario demands an autocall but the walk never reached the
            // barrier. Lift the worst name through it at observation 30.
            let force_at = 30.min(n - 1);
            let lift = barriers.ko_barrier + 0.02;
            worst_of[force_at] = lift;
            aapl[force_at] = lift + 0.01;
            msft[force_at] = lift + 0.02;
            nvda[force_at] = lift;
            *ko_index = Some(force_at);
            for k in (force_at + 1)..n {
                aapl[k] = aapl[force_at];
                msft[k] = msft[force_at];
                nvda[k] = nvda[force_at];
                worst_of[k] = worst_of[force_at];
            }
        }
    } else {
        // Surviving paths must never have touched KO.
        for t in 0..n {
            if worst_of[t] >= barriers.ko_barrier {
                let capped = barriers.ko_barrier - 0.01;
                worst_of[t] = capped;
                aapl[t] = js_min(aapl[t], capped + 0.02);
                msft[t] = js_min(msft[t], capped + 0.02);
                nvda[t] = js_min(nvda[t], capped);
            }
        }
        *ko_index = None;
    }

    if scenario.is_alive_with_ki() {
        if ki_index.is_none() {
            // Note 25, not the 30 used for the KO fallback above.
            let force_at = 25.min(n - 1);
            let plunge = barriers.ki_barrier - 0.05;
            worst_of[force_at] = plunge;
            nvda[force_at] = plunge;
            aapl[force_at] = js_max(aapl[force_at], plunge + 0.08);
            msft[force_at] = js_max(msft[force_at], plunge + 0.1);
            *ki_index = Some(force_at);
        }
    } else if scenario == PathScenario::AliveNoKi {
        for t in 0..n {
            if worst_of[t] <= barriers.ki_barrier {
                let lift = barriers.ki_barrier + 0.03;
                worst_of[t] = lift;
                aapl[t] = js_max(aapl[t], lift);
                msft[t] = js_max(msft[t], lift);
                nvda[t] = js_max(nvda[t], lift);
            }
        }
        *ki_index = None;
    }
    // A KO path may or may not have breached KI; `ki_index` stands as computed.
}

/// Per-observation coupon accounting for one path.
#[derive(Debug, Clone, PartialEq)]
struct BuiltObservations {
    observations: Vec<PathObservation>,
    coupon_value: f64,
    memory_coupon_value: f64,
}

/// Walks the series and accrues coupons, paying memory on entry to the coupon
/// range and on knock-out.
///
/// Port of `buildObservations`. Two subtleties:
///
/// - The pad loop **inherits** `couponMemoryBalance` from the last real
///   observation while zeroing `couponAccrued`. Copying the whole observation
///   (`{...last}` in the TypeScript) and overriding only three fields is why
///   the frozen tail shows a non-zero memory balance with zero accrual.
/// - `couponValue` and `memoryCouponValue` accumulate *unrounded* and are
///   rounded once at the end. Rounding per observation would change both sums.
fn build_observations(
    dates: &[String],
    series: &PerformanceSeries,
    scenario: PathScenario,
    barriers: &ProductBarriers,
    n: usize,
) -> BuiltObservations {
    let mut observations: Vec<PathObservation> = Vec::with_capacity(n);
    let mut memory = 0.0;
    let mut coupon_paid = 0.0;
    let mut memory_paid = 0.0;
    let mut knocked_in = false;

    let end_index = if scenario == PathScenario::Ko {
        series.ko_index.unwrap_or(n - 1)
    } else {
        n - 1
    };

    // `dates` drives the loop so the index is only ever used to reach into the
    // four parallel `series` slices, which an iterator cannot zip together
    // without getting unreadable.
    for (t, date) in dates.iter().enumerate().take(end_index + 1) {
        let w = series.worst_of[t];
        let knock_in_at_date = !knocked_in && w <= barriers.ki_barrier;
        if knock_in_at_date {
            knocked_in = true;
        }
        let knock_out_at_date = w >= barriers.ko_barrier;

        let mut coupon_accrued = 0.0;
        if w >= barriers.coupon_lower && w <= barriers.coupon_upper {
            coupon_accrued = barriers.notional * barriers.coupon_rate;
            // In range: pay the current coupon plus everything carried.
            coupon_paid += coupon_accrued;
            memory_paid += memory;
            memory = 0.0;
        } else {
            memory += barriers.notional * barriers.coupon_rate;
        }

        if knock_out_at_date {
            // Phoenix autocall pays the accrued memory on redemption.
            memory_paid += memory;
            memory = 0.0;
        }

        observations.push(PathObservation {
            date: date.clone(),
            date_index: t,
            aapl: series.aapl[t],
            msft: series.msft[t],
            nvda: series.nvda[t],
            worst_of_performance: w,
            coupon_accrued: round2(coupon_accrued),
            coupon_memory_balance: round2(memory),
            knock_in_at_date,
            knock_out_at_date,
        });
    }

    // Pad the frozen tail of an early-exit KO path. Built separately so the
    // source observation can be copied once; when `end_index == n - 1` this
    // collects nothing and the loop never runs.
    let last = observations[end_index].clone();
    let padded: Vec<PathObservation> = ((end_index + 1)..n)
        .map(|t| PathObservation {
            date: dates[t].clone(),
            date_index: t,
            aapl: last.aapl,
            msft: last.msft,
            nvda: last.nvda,
            worst_of_performance: last.worst_of_performance,
            coupon_accrued: 0.0,
            coupon_memory_balance: last.coupon_memory_balance,
            knock_in_at_date: false,
            knock_out_at_date: false,
        })
        .collect();
    observations.extend(padded);

    BuiltObservations {
        observations,
        coupon_value: round2(coupon_paid),
        memory_coupon_value: round2(memory_paid),
    }
}

/// Redemption, put exposure and the initial attribution skeleton for one path.
#[derive(Debug, Clone, PartialEq)]
struct PayoffResult {
    redemption_value: f64,
    put_value: f64,
    payoff: f64,
    settlement_type: SettlementType,
    attribution: PathAttribution,
}

/// Computes a path's payoff components.
///
/// Port of `computePayoff`. Note that `payoff` deliberately **excludes** the put
/// value: it is `redemption + coupon + memoryCoupon`, and for a knock-in path
/// `redemption` has already had the put folded in as
/// `notional + putValue`. Adding `put_value` again would double-count the loss.
/// `payoff` and `attribution.downAndInPut` are therefore not additive, which
/// looks like a bug and is not.
fn compute_payoff(
    scenario: PathScenario,
    series: &PerformanceSeries,
    coupon_value: f64,
    memory_coupon_value: f64,
    barriers: &ProductBarriers,
    n: usize,
) -> PayoffResult {
    let (redemption_value, put_value, settlement_type) = match scenario {
        PathScenario::Ko | PathScenario::AliveNoKi => {
            (barriers.notional, 0.0, SettlementType::None)
        }
        _ => {
            // Knock-in held to maturity: down-and-in put loss.
            let final_w = series.worst_of[n - 1];
            let put_value = round2(-barriers.notional * js_max(0.0, 1.0 - final_w));
            let settlement_type = if scenario == PathScenario::AliveKiCash {
                SettlementType::Cash
            } else {
                SettlementType::Physical
            };
            (
                round2(barriers.notional + put_value),
                put_value,
                settlement_type,
            )
        }
    };

    // Funding and discounting are placeholders here, replaced by
    // `refine_attribution`. The total is still computed so the intermediate
    // object is self-consistent.
    let mut attribution = PathAttribution {
        par_redemption: barriers.notional,
        coupon: coupon_value,
        memory_coupon: memory_coupon_value,
        down_and_in_put: put_value,
        funding: -2.0,
        discounting: -1.5,
        total_pv: 0.0,
    };
    attribution.total_pv = attribution.compute_total();

    let payoff = round2(redemption_value + coupon_value + memory_coupon_value);

    PayoffResult {
        redemption_value,
        put_value,
        payoff,
        settlement_type,
        attribution,
    }
}

/// Replaces funding and discounting with per-path draws and recomputes the total.
///
/// Port of `refineAttribution`. This is the **last** PRNG consumption in the
/// whole generator: exactly two draws per path, after every series draw. Adding
/// a third here, or moving this call earlier, shifts the funding term for this
/// path and every observation of every path after it.
fn refine_attribution(mut attribution: PathAttribution, rng: &mut Mulberry32) -> PathAttribution {
    attribution.funding = round2(-1.5 - rng.next_f64() * 1.5);
    attribution.discounting = round2(-0.8 - rng.next_f64() * 1.2);
    attribution.total_pv = attribution.compute_total();
    attribution
}

/// The payoff-graph node order for a scenario.
///
/// Port of `buildTraversal`. The three scenarios take genuinely different node
/// sets: a KO path never reaches `RangeAccrual` or `DownAndInPut`, and an
/// `alive_no_ki` path never reaches `DownAndInPut` either. This ordering drives
/// the graph layout, so it is a display contract, not an incidental detail.
fn build_traversal(scenario: PathScenario) -> Vec<PayoffNodeId> {
    let base = [
        PayoffNodeId::PathCube,
        PayoffNodeId::FixingSchedule,
        PayoffNodeId::WorstOfPerformance,
    ];
    let tail = match scenario {
        // Autocall redeems par; neither accrual nor put exposure is reached.
        PathScenario::Ko => &[
            PayoffNodeId::GlobalKOGate,
            PayoffNodeId::CouponStrip,
            PayoffNodeId::MemoryCarry,
            PayoffNodeId::Redemption,
            PayoffNodeId::Discount,
            PayoffNodeId::AggregatePV,
        ][..],
        PathScenario::AliveNoKi => &[
            PayoffNodeId::KnockInGate,
            PayoffNodeId::GlobalKOGate,
            PayoffNodeId::RangeAccrual,
            PayoffNodeId::CouponStrip,
            PayoffNodeId::MemoryCarry,
            PayoffNodeId::Redemption,
            PayoffNodeId::Discount,
            PayoffNodeId::AggregatePV,
        ][..],
        _ => &[
            PayoffNodeId::KnockInGate,
            PayoffNodeId::GlobalKOGate,
            PayoffNodeId::RangeAccrual,
            PayoffNodeId::CouponStrip,
            PayoffNodeId::MemoryCarry,
            PayoffNodeId::DownAndInPut,
            PayoffNodeId::Redemption,
            PayoffNodeId::Discount,
            PayoffNodeId::AggregatePV,
        ][..],
    };
    base.iter().chain(tail.iter()).copied().collect()
}

/// Realised outcome counts across the finished sample.
///
/// Derived from the paths, not from the scenario labels, so any correction made
/// upstream is reflected. Feeds both the node `probability`/`affectedPaths`
/// fields and, independently, the branch statistics.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Population {
    ko: usize,
    ki: usize,
    #[allow(dead_code)] // kept for parity with the TypeScript shape
    no_ki: usize,
}

impl Population {
    fn from_paths(paths: &[SimulationPath]) -> Self {
        Self {
            ko: paths.iter().filter(|p| p.knocked_out).count(),
            ki: paths
                .iter()
                .filter(|p| !p.knocked_out && p.knock_in_triggered)
                .count(),
            no_ki: paths
                .iter()
                .filter(|p| !p.knocked_out && !p.knock_in_triggered)
                .count(),
        }
    }
}

/// Formats a performance level as a one-decimal percentage string.
///
/// Port of `pct`. Uses [`js_to_fixed`] because `(v * 100).toFixed(1)` rounds the
/// exact decimal expansion, which `js_round(v * 1000) / 1000` does not — see the
/// `js_to_fixed` docs for the concrete fixture values where the two disagree.
fn pct(v: f64) -> String {
    format!("{}%", js_to_fixed(v * 100.0, 1))
}

/// Formats a money amount at 2dp, matching JavaScript `Number.toFixed(2)`.
fn money(v: f64) -> String {
    js_to_fixed(v, 2)
}

/// Builds the twelve per-node explainability snapshots for one path.
///
/// Port of `buildNodeDetails`. Read the `probability` and
/// `conditionalExpectedPayoff` fields with the following in mind:
///
/// - `probability` is a **population frequency**, identical for every path
///   sharing a node. `KnockInGate` shows `0.19` on all 100 paths because 19 of
///   100 breached knock-in; it is not a per-path likelihood.
/// - `conditionalExpectedPayoff` is a **hard-coded display constant** on eleven
///   of the twelve nodes (`96`, `98.1`, `97.5`, …). Only `AggregatePV` carries
///   a real per-path number. Preserved verbatim: the Node Details tile shows
///   them, so changing them is a visible product change.
/// - `affectedPaths` counts the whole population for most nodes regardless of
///   whether this path touched them.
fn build_node_details(
    path: &SimulationPath,
    scenario: PathScenario,
    population: Population,
    barriers: &ProductBarriers,
    path_count: usize,
    observations: usize,
) -> Vec<NodeDetailSnapshot> {
    let inputs = NodeInputs::new(path, barriers, path_count, observations);

    let mut details = input_gate_details(path, &inputs, population);
    details.extend(cashflow_details(path, &inputs, population));

    // Soften the nodes a KO path never reached. The underlying `probability` and
    // `affectedPaths` are left as-is; only the narrative changes.
    if scenario == PathScenario::Ko {
        for detail in &mut details {
            match detail.node_id {
                PayoffNodeId::KnockInGate => {
                    detail.output = "SKIPPED".into();
                    detail.description =
                        "Skipped \u{2014} path knocked out before KI evaluation at maturity."
                            .into();
                }
                PayoffNodeId::DownAndInPut => {
                    detail.output = "SKIPPED".into();
                    detail.description =
                        "Skipped \u{2014} autocall redeems par before put exposure.".into();
                }
                PayoffNodeId::RangeAccrual => {
                    detail.output = "PARTIAL".into();
                    detail.description = "Accrual until KO date only.".into();
                }
                _ => {}
            }
        }
    }

    debug_assert_eq!(details.len(), PayoffNodeId::ALL.len());
    details
}

/// Values derived once from a path and shared by both halves of the node table.
///
/// [`build_node_details`] is a fixed twelve-row table copied from the TypeScript.
/// It is split into [`input_gate_details`] and [`cashflow_details`] purely to
/// keep each function a readable length; the split is at the payoff-graph seam,
/// so the first half describes how the path *looked* and the second what it *paid*.
struct NodeInputs<'a> {
    /// Worst-of level at the final observation.
    final_w: f64,
    /// Worst-of level at observation 30, clamped to the last available.
    selected_w: f64,
    /// The level quoted by `KnockInGate`: at the KI crossing, else the path minimum.
    ki_input: f64,
    /// The level quoted by `GlobalKOGate`: at the KO crossing, else the path maximum.
    ko_input: f64,
    barriers: &'a ProductBarriers,
    path_count: usize,
    observations: usize,
}

impl<'a> NodeInputs<'a> {
    fn new(
        path: &SimulationPath,
        barriers: &'a ProductBarriers,
        path_count: usize,
        observations: usize,
    ) -> Self {
        let worst_of = &path.worst_of_performance;
        Self {
            final_w: worst_of[worst_of.len() - 1],
            // `Math.min(observations.length - 1, 30)`, written so it cannot
            // underflow. `verify_consistency` guarantees a non-empty series.
            selected_w: path.observations[path.observations.len().min(31) - 1].worst_of_performance,
            ki_input: match path.knock_in_date_index {
                Some(i) => worst_of[i],
                None => js_min_slice(worst_of),
            },
            ko_input: match path.knock_out_date_index {
                Some(i) => worst_of[i],
                None => js_max_slice(worst_of),
            },
            barriers,
            path_count,
            observations,
        }
    }

    /// A node reached by `count` paths, as an `(affectedPaths, probability)` pair.
    ///
    /// The two always travel together, so deriving them in one place is what
    /// stops a future edit from updating the count but forgetting the frequency.
    fn affected(&self, count: usize) -> (usize, f64) {
        (count, ratio(count, self.path_count))
    }
}

/// The first five node snapshots: path identity and the two barrier gates.
fn input_gate_details(
    path: &SimulationPath,
    inputs: &NodeInputs<'_>,
    population: Population,
) -> Vec<NodeDetailSnapshot> {
    let (all, certain) = inputs.affected(inputs.path_count);
    let (ki_count, ki_probability) = inputs.affected(population.ki);
    let (ko_count, ko_probability) = inputs.affected(population.ko);
    let barriers = inputs.barriers;

    vec![
        NodeDetailSnapshot {
            node_id: PayoffNodeId::PathCube,
            name: "PathCube".into(),
            description: "Monte Carlo path cube sample for this simulation draw.".into(),
            input_value: path.id.clone(),
            decision_rule: "Uniform sample from path cube".into(),
            output: format!("Path #{}", path.path_index),
            affected_paths: all,
            probability: certain,
            conditional_expected_payoff: 96.0,
            is_loss_related: false,
        },
        NodeDetailSnapshot {
            node_id: PayoffNodeId::FixingSchedule,
            name: "FixingSchedule".into(),
            description: "Monthly observation schedule across three underlyings.".into(),
            input_value: format!("{} dates", inputs.observations),
            decision_rule: "Business-day monthly fixings".into(),
            output: format!(
                "{} \u{2192} {}",
                path.dates[0],
                path.dates[path.dates.len() - 1]
            ),
            affected_paths: all,
            probability: certain,
            conditional_expected_payoff: 96.0,
            is_loss_related: false,
        },
        NodeDetailSnapshot {
            node_id: PayoffNodeId::WorstOfPerformance,
            name: "WorstOfPerformance".into(),
            description: "min(AAPL, MSFT, NVDA) performance vs strike.".into(),
            input_value: format!("Wo = {}", pct(inputs.selected_w)),
            decision_rule: "worstOf = min(S_i / S_i0)".into(),
            output: pct(inputs.final_w),
            affected_paths: all,
            probability: certain,
            conditional_expected_payoff: 96.0,
            is_loss_related: inputs.final_w < barriers.ki_barrier,
        },
        NodeDetailSnapshot {
            node_id: PayoffNodeId::KnockInGate,
            name: "KnockInGate".into(),
            description: "European-style KI monitor on worst-of performance.".into(),
            input_value: pct(inputs.ki_input),
            decision_rule: format!("Wo \u{2264} {}", pct(barriers.ki_barrier)),
            output: flag(path.knock_in_triggered),
            affected_paths: ki_count,
            probability: ki_probability,
            conditional_expected_payoff: if path.knock_in_triggered { 89.5 } else { 104.2 },
            is_loss_related: path.knock_in_triggered,
        },
        NodeDetailSnapshot {
            node_id: PayoffNodeId::GlobalKOGate,
            name: "GlobalKOGate".into(),
            description: "Autocall / global knock-out on worst-of.".into(),
            input_value: pct(inputs.ko_input),
            decision_rule: format!("Wo \u{2265} {}", pct(barriers.ko_barrier)),
            output: flag(path.knocked_out),
            affected_paths: ko_count,
            probability: ko_probability,
            conditional_expected_payoff: if path.knocked_out { 108.4 } else { 91.2 },
            // Never loss-related: an autocall redeems at or above par.
            is_loss_related: false,
        },
    ]
}

/// The last seven node snapshots: accrual, cashflows, put, redemption and PV.
fn cashflow_details(
    path: &SimulationPath,
    inputs: &NodeInputs<'_>,
    population: Population,
) -> Vec<NodeDetailSnapshot> {
    let (all, certain) = inputs.affected(inputs.path_count);
    let (ki_count, ki_probability) = inputs.affected(population.ki);
    // Range accrual is skipped only by autocalled paths.
    let (accrued_count, accrued_probability) = inputs.affected(inputs.path_count - population.ko);
    let barriers = inputs.barriers;

    vec![
        NodeDetailSnapshot {
            node_id: PayoffNodeId::RangeAccrual,
            name: "RangeAccrual".into(),
            description: "Coupon accrues when Wo is inside the coupon range.".into(),
            // U+2013 EN DASH, not a hyphen.
            input_value: format!(
                "{} \u{2013} {}",
                pct(barriers.coupon_lower),
                pct(barriers.coupon_upper)
            ),
            decision_rule: "Accrue if couponLower \u{2264} Wo \u{2264} couponUpper".into(),
            output: format!("{} accrued", money(path.coupon_value)),
            affected_paths: accrued_count,
            probability: accrued_probability,
            conditional_expected_payoff: 98.1,
            is_loss_related: false,
        },
        NodeDetailSnapshot {
            node_id: PayoffNodeId::CouponStrip,
            name: "CouponStrip".into(),
            description: "Paid coupon cashflows along the path.".into(),
            input_value: money(path.coupon_value),
            decision_rule: "Pay coupon when in range".into(),
            output: money(path.coupon_value),
            affected_paths: all,
            probability: 0.82,
            conditional_expected_payoff: 97.5,
            is_loss_related: false,
        },
        NodeDetailSnapshot {
            node_id: PayoffNodeId::MemoryCarry,
            name: "MemoryCarry".into(),
            description: "Unpaid coupons carried forward until next in-range or KO.".into(),
            input_value: money(path.memory_coupon_value),
            decision_rule: "Memory += coupon if out of range".into(),
            output: money(path.memory_coupon_value),
            affected_paths: all,
            probability: 0.61,
            conditional_expected_payoff: 97.8,
            is_loss_related: false,
        },
        NodeDetailSnapshot {
            node_id: PayoffNodeId::DownAndInPut,
            name: "DownAndInPut".into(),
            description: "Capital loss if KI triggered and held to maturity.".into(),
            input_value: pct(inputs.final_w),
            decision_rule: "Put = \u{2212}N \u{d7} max(0, 1 \u{2212} Wo_T) if KI".into(),
            output: money(path.put_value),
            affected_paths: ki_count,
            probability: ki_probability,
            conditional_expected_payoff: 89.5,
            is_loss_related: true,
        },
        NodeDetailSnapshot {
            node_id: PayoffNodeId::Redemption,
            name: "Redemption".into(),
            description: "Final notional redemption after put adjustment.".into(),
            input_value: money(barriers.notional),
            decision_rule: "N + Put (if KI) else N".into(),
            output: money(path.redemption_value),
            affected_paths: all,
            probability: certain,
            conditional_expected_payoff: 96.0,
            is_loss_related: path.put_value < 0.0,
        },
        NodeDetailSnapshot {
            node_id: PayoffNodeId::Discount,
            name: "Discount".into(),
            description: "Funding and discounting from payoff date to PV.".into(),
            input_value: money(path.attribution.discounting),
            decision_rule: "DF(t) \u{d7} cashflows".into(),
            output: money(path.attribution.total_pv),
            affected_paths: all,
            probability: certain,
            conditional_expected_payoff: 96.0,
            is_loss_related: false,
        },
        NodeDetailSnapshot {
            node_id: PayoffNodeId::AggregatePV,
            name: "AggregatePV".into(),
            description: "Path present value after all payoff graph nodes.".into(),
            input_value: "\u{3a3} attribution".into(),
            decision_rule: "Par + Coupons + Put + Funding + DF".into(),
            output: money(path.attribution.total_pv),
            affected_paths: 1,
            probability: ratio(1, inputs.path_count),
            // The one node with a genuine per-path value.
            conditional_expected_payoff: path.attribution.total_pv,
            is_loss_related: path.attribution.total_pv < 100.0,
        },
    ]
}

/// Renders a barrier gate outcome the way the tile expects to read it.
fn flag(value: bool) -> String {
    if value { "TRUE" } else { "FALSE" }.to_string()
}

/// `numerator / denominator` as JavaScript would compute it.
fn ratio(numerator: usize, denominator: usize) -> f64 {
    numerator as f64 / denominator as f64
}

/// Confirms each finished path is internally consistent with its scenario.
///
/// The TypeScript original only `console.warn`s when a path comes out
/// inconsistent. A kernel serving four transports cannot afford a `warn`: an
/// inconsistent path renders contradictory tiles, and the warning would surface
/// in the adapter's log rather than at the call site.
///
/// The checks are deliberately the ones the generator *guarantees* by
/// construction, not the ones a stricter reading might want. In particular the
/// "no knock-in crossing" rule is only asserted for `alive_no_ki` paths: a KO
/// path legitimately records `knock_in_date_index`, and `round4` can nudge a
/// level onto the barrier from either side, so a blanket check would be wrong.
///
/// # Errors
/// Returns [`FinaError::Generation`] naming the path and the violated invariant.
fn verify_consistency(
    paths: &[SimulationPath],
    scenarios: &[PathScenario],
    barriers: &ProductBarriers,
    n: usize,
) -> Result<()> {
    for (path, &scenario) in paths.iter().zip(scenarios) {
        let bad = |what: &str| {
            Err(FinaError::Generation(format!(
                "{} (path-{:03}, scenario {scenario:?}): {what}",
                path.id, path.path_index
            )))
        };

        if path.dates.len() != n
            || path.observations.len() != n
            || path.worst_of_performance.len() != n
            || path.coupon_memory_balance.len() != n
        {
            return bad("series length does not match the configured observation count");
        }
        if path.knocked_out != (scenario == PathScenario::Ko) {
            return bad("knocked_out disagrees with the assigned scenario");
        }
        if path
            .knock_out_date_index
            .is_some_and(|i| i >= path.worst_of_performance.len())
            || path
                .knock_in_date_index
                .is_some_and(|i| i >= path.worst_of_performance.len())
        {
            return bad("barrier index is out of range");
        }
        if path.node_details.len() != PayoffNodeId::ALL.len() {
            return bad("node_details is not one snapshot per payoff node");
        }

        // The three checks the TypeScript warns about, in the same form: "some
        // observation crossed the barrier", not "the recorded index is exactly
        // the first crossing". `round4` can move a level onto a barrier from
        // either side, so demanding the first crossing would be too strict.
        if path.knocked_out
            && !path
                .worst_of_performance
                .iter()
                .any(|w| *w >= barriers.ko_barrier)
        {
            return bad("flagged knocked out but no observation reached KO");
        }
        if path.knock_in_triggered
            && !path
                .worst_of_performance
                .iter()
                .any(|w| *w <= barriers.ki_barrier)
        {
            return bad("flagged knock-in triggered but no observation reached KI");
        }
        if !path.knock_in_triggered && !path.knocked_out {
            // A surviving, un-breached path must stay strictly above KI. This
            // holds because the enforcement pass lifts any level at or below it.
            if path
                .worst_of_performance
                .iter()
                .any(|w| *w <= barriers.ki_barrier)
            {
                return bad("flagged no knock-in but an observation breached KI");
            }
            if path
                .worst_of_performance
                .iter()
                .any(|w| *w >= barriers.ko_barrier)
            {
                return bad("a surviving path reached the knock-out barrier");
            }
        }
        if scenario.is_alive_with_ki() != path.knock_in_triggered {
            return bad("knock_in_triggered disagrees with the assigned scenario");
        }
        let recomputed =
            round2(path.redemption_value + path.coupon_value + path.memory_coupon_value);
        if recomputed != path.payoff {
            return bad("payoff does not equal redemption + coupon + memory coupon");
        }
    }
    Ok(())
}

/// Counts branch outcomes and scales them to a fictional 100,000-path population.
///
/// Port of `buildBranchStats`.
///
/// # The 1,000x scale is a display fiction
///
/// Only [`Self::SCALE_FACTOR`] paths are simulated; each raw count is divided by
/// the sample size and multiplied by 100,000. The counts are therefore *fractions*
/// of 100,000 re-expressed as integers — `67` KO paths become `67000`. They are
/// not estimates from 100,000 draws and carry no sampling error, so a confidence
/// interval around them would be meaningless. Use
/// [`crate::types::SimulationBundle::sample_path_count`] for the real sample size.
fn build_branch_stats(paths: &[SimulationPath]) -> BranchStats {
    let n = paths.len();
    let count = |f: &dyn Fn(&SimulationPath) -> bool| paths.iter().filter(|p| f(p)).count();
    let ko = count(&|p| p.knocked_out);
    let alive = n - ko;
    let knock_in = count(&|p| !p.knocked_out && p.knock_in_triggered);
    let no_knock_in = count(&|p| !p.knocked_out && !p.knock_in_triggered);
    let cash = count(&|p| {
        !p.knocked_out && p.knock_in_triggered && p.settlement_type == SettlementType::Cash
    });
    let physical = count(&|p| {
        !p.knocked_out && p.knock_in_triggered && p.settlement_type == SettlementType::Physical
    });

    // `(count / n) * 100_000`, then round — the division happens first, so the
    // intermediate is not exactly `count * 1000`.
    let scaled = |c: usize| -> u32 { round_to_u32((c as f64 / n as f64) * 100_000.0) };

    BranchStats {
        total_paths: 100_000,
        ko_triggered: scaled(ko),
        alive: scaled(alive),
        knock_in: scaled(knock_in),
        no_knock_in: scaled(no_knock_in),
        cash_settlement: scaled(cash),
        physical_delivery: scaled(physical),
    }
}

/// `Math.round(v)` as a `u32`, for the non-negative branch counts.
fn round_to_u32(v: f64) -> u32 {
    let rounded = js_round(v);
    assert!(
        rounded >= 0.0 && rounded <= f64::from(u32::MAX),
        "branch count out of u32 range: {v} -> {rounded}"
    );
    #[allow(clippy::cast_possible_truncation)]
    let n = rounded as u32;
    n
}

/// Builds the four distribution summaries.
///
/// Port of the `distributions` block in `generateSimulationBundle`.
fn build_distributions(paths: &[SimulationPath], n: usize) -> SimulationDistributions {
    let total_payoff: Vec<f64> = paths.iter().map(|p| p.payoff).collect();
    let coupon_pv: Vec<f64> = paths
        .iter()
        .map(|p| round2(p.coupon_value + p.memory_coupon_value))
        .collect();
    let put_pv: Vec<f64> = paths.iter().map(|p| p.put_value).collect();
    // Sampled at the knock-out observation for KO paths, else at maturity.
    let worst_of_final: Vec<f64> = paths
        .iter()
        .map(|p| {
            let idx = p.knock_out_date_index.unwrap_or(n - 1);
            round2(p.worst_of_performance[idx] * 100.0)
        })
        .collect();

    SimulationDistributions {
        total_payoff: compute_distribution(&total_payoff),
        coupon_pv: compute_distribution(&coupon_pv),
        put_pv: compute_distribution(&put_pv),
        worst_of_final: compute_distribution(&worst_of_final),
    }
}

/// Port of `computeDistribution`.
///
/// # Order-sensitivity
///
/// `mean` and the variance accumulator both use a left-to-right `reduce`, not a
/// pairwise sum. With 100 values of mixed sign the two differ in the last bits,
/// and `stdDev` inherits that difference. Percentiles read from a *sorted* copy
/// while `mean` reads the original order, so reordering the input changes `mean`
/// but not the percentiles.
fn compute_distribution(values: &[f64]) -> DistributionStats {
    // `sort((a, b) => a - b)`. `total_cmp` orders NaN last, matching V8, and
    // never panics. For finite values it is identical to the numeric ordering.
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let n = sorted.len();
    assert!(n > 0, "compute_distribution needs at least one value");

    // `values.reduce((s, v) => s + v, 0) / n`
    let mean = sum_ordered(values) / n as f64;
    let median = if n % 2 == 0 {
        // Even sample: mean of the two central order statistics.
        (sorted[n / 2 - 1] + sorted[n / 2]) / 2.0
    } else {
        sorted[n / 2]
    };
    // `values.reduce((s, v) => s + (v - mean) ** 2, 0) / n`
    let variance = {
        let mut acc = 0.0;
        for v in values {
            let d = v - mean;
            acc += d * d;
        }
        acc / n as f64
    };
    let std_dev = variance.sqrt();

    // Nearest-rank on the sorted sample. Indexing, not interpolation: with
    // n = 100 this reads the 5th and 95th sorted values.
    let p05 = sorted[js_floor_to_usize(0.05 * (n as f64 - 1.0))];
    let p95 = sorted[js_floor_to_usize(0.95 * (n as f64 - 1.0))];

    DistributionStats {
        mean: round2(mean),
        median: round2(median),
        std_dev: round2(std_dev),
        p05: round2(p05),
        p95: round2(p95),
        values: values.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Handlers
    // -----------------------------------------------------------------------

    /// Collects the progress events emitted by a run.
    fn generate_with_log(config: SimulationConfig) -> (SimulationBundle, Vec<ProgressEvent>) {
        let mut events = Vec::new();
        let bundle = generate_paths(config, |e| events.push(e)).expect("valid config");
        (bundle, events)
    }

    // -----------------------------------------------------------------------
    // Configuration validation
    // -----------------------------------------------------------------------

    fn config_with(mutate: impl FnOnce(&mut SimulationConfig)) -> SimulationConfig {
        let mut config = SimulationConfig::demo();
        mutate(&mut config);
        config
    }

    #[test]
    fn demo_config_is_the_golden_configuration() {
        let config = SimulationConfig::demo();
        assert_eq!(config.seed, 42);
        assert_eq!(config.path_count, PATH_COUNT);
        assert_eq!(config.observations, OBSERVATIONS);
        assert_eq!(config.start_date, DEMO_START_DATE);
        assert_eq!(config.barriers.ki_barrier, 0.70);
        assert_eq!(config.barriers.ko_barrier, 1.00);
        assert_eq!(config.barriers.coupon_lower, 0.75);
        assert_eq!(config.barriers.coupon_upper, 1.00);
        assert_eq!(config.barriers.coupon_rate, 0.008);
        assert_eq!(config.barriers.notional, 100.0);
        config.validate().expect("the demo config must validate");
    }

    #[test]
    fn validate_rejects_every_degenerate_barrier_set() {
        let cases: [(&str, SimulationConfig); 9] = [
            ("path_count == 0", config_with(|c| c.path_count = 0)),
            ("observations == 0", config_with(|c| c.observations = 0)),
            ("notional == 0", config_with(|c| c.barriers.notional = 0.0)),
            ("notional < 0", config_with(|c| c.barriers.notional = -1.0)),
            (
                "ki_barrier == 0",
                config_with(|c| c.barriers.ki_barrier = 0.0),
            ),
            (
                "ki_barrier < 0",
                config_with(|c| c.barriers.ki_barrier = -0.1),
            ),
            (
                "ki_barrier == ko_barrier",
                config_with(|c| c.barriers.ki_barrier = c.barriers.ko_barrier),
            ),
            (
                "ki_barrier > ko_barrier",
                config_with(|c| c.barriers.ki_barrier = c.barriers.ko_barrier + 0.1),
            ),
            (
                "ki_barrier is NaN",
                config_with(|c| c.barriers.ki_barrier = f64::NAN),
            ),
        ];

        for (label, config) in cases {
            let result = config.validate();
            assert!(
                matches!(result, Err(FinaError::InvalidBarriers { .. })),
                "{label} should be rejected, got {result:?}"
            );
            // `generate_paths` must propagate it rather than panic.
            assert!(
                generate_paths(config, |_| {}).is_err(),
                "{label} must not generate"
            );
        }
    }

    #[test]
    fn validate_accepts_a_range_of_valid_barrier_sets() {
        for (ki, ko) in [(0.01, 2.0), (0.5, 0.51), (0.7, 1.0), (0.95, 1.45)] {
            let config = config_with(|c| {
                c.barriers.ki_barrier = ki;
                c.barriers.ko_barrier = ko;
            });
            config
                .validate()
                .unwrap_or_else(|e| panic!("ki={ki} ko={ko} should be valid: {e:?}"));
        }
    }

    // -----------------------------------------------------------------------
    // Scenario assignment
    // -----------------------------------------------------------------------

    #[test]
    fn assign_consumes_exactly_one_draw_per_path() {
        let mut rng = Mulberry32::new(42);
        let scenarios = PathScenario::assign(&mut rng, 100);
        assert_eq!(scenarios.len(), 100);
        let after = rng.next_f64();

        let mut reference = Mulberry32::new(42);
        for _ in 0..100 {
            reference.next_f64();
        }
        assert_eq!(
            after,
            reference.next_f64(),
            "assign must consume exactly one draw per path"
        );
    }

    #[test]
    fn assign_is_a_pure_function_of_the_seed() {
        let first = PathScenario::assign(&mut Mulberry32::new(42), 100);
        let second = PathScenario::assign(&mut Mulberry32::new(42), 100);
        assert_eq!(first, second);
        assert_ne!(first, PathScenario::assign(&mut Mulberry32::new(43), 100));
    }

    #[test]
    fn assign_lands_near_its_target_mix() {
        // Targets are 65/10/10/15, not guarantees. With 100 draws from the demo
        // seed the realised mix is asserted exactly by the golden test; here the
        // point is only that every branch is reachable and none dominates by
        // accident.
        let scenarios = PathScenario::assign(&mut Mulberry32::new(42), 100);
        let count = |s: PathScenario| scenarios.iter().filter(|x| **x == s).count();
        assert_eq!(scenarios.len(), 100);
        assert_eq!(
            count(PathScenario::Ko)
                + count(PathScenario::AliveKiCash)
                + count(PathScenario::AliveKiPhysical)
                + count(PathScenario::AliveNoKi),
            100
        );
        for scenario in [
            PathScenario::Ko,
            PathScenario::AliveKiCash,
            PathScenario::AliveKiPhysical,
            PathScenario::AliveNoKi,
        ] {
            assert!(count(scenario) > 0, "{scenario:?} never assigned");
        }
    }

    #[test]
    fn is_alive_with_ki_matches_exactly_two_scenarios() {
        assert!(PathScenario::AliveKiCash.is_alive_with_ki());
        assert!(PathScenario::AliveKiPhysical.is_alive_with_ki());
        assert!(!PathScenario::Ko.is_alive_with_ki());
        assert!(!PathScenario::AliveNoKi.is_alive_with_ki());
    }

    // -----------------------------------------------------------------------
    // Scenario events
    // -----------------------------------------------------------------------

    #[test]
    fn scenario_events_draw_one_value_only_for_scenarios_that_need_it() {
        // The KO event is drawn for `ko` alone, the KI event for the two
        // knock-in scenarios alone. A draw taken by a scenario that does not use
        // it would shift every later value in the bundle.
        let mut rng = Mulberry32::new(42);
        assert_eq!(ScenarioEvents::draw(PathScenario::Ko, &mut rng).ki, None);

        let mut rng = Mulberry32::new(42);
        assert_eq!(
            ScenarioEvents::draw(PathScenario::AliveNoKi, &mut rng).ki,
            None
        );

        let mut rng = Mulberry32::new(42);
        assert_eq!(
            ScenarioEvents::draw(PathScenario::AliveKiCash, &mut rng).ko,
            None
        );
    }

    #[test]
    fn scenario_event_windows_match_the_original() {
        // The windows deliberately differ: KO is `6 + floor(rng * 40)`, KI is
        // `8 + floor(rng * 35)`. Retyping these from memory is exactly the
        // mistake the migration warns about, so they are asserted directly.
        let mut ko_draws = 0usize;
        let mut min_ko = usize::MAX;
        let mut max_ko = 0usize;
        let mut min_ki = usize::MAX;
        let mut max_ki = 0usize;

        for seed in 0..2_000 {
            let events = ScenarioEvents::draw(PathScenario::Ko, &mut Mulberry32::new(seed));
            if let Some(k) = events.ko {
                assert!(
                    (6..46).contains(&k),
                    "seed {seed}: KO event {k} out of range"
                );
                min_ko = min_ko.min(k);
                max_ko = max_ko.max(k);
                ko_draws += 1;
            }
            let events =
                ScenarioEvents::draw(PathScenario::AliveKiCash, &mut Mulberry32::new(seed));
            if let Some(k) = events.ki {
                assert!(
                    (8..43).contains(&k),
                    "seed {seed}: KI event {k} out of range"
                );
                min_ki = min_ki.min(k);
                max_ki = max_ki.max(k);
            }
        }

        assert_eq!(ko_draws, 2_000, "the KO event is always drawn for `ko`");
        assert!(min_ko >= 6 && max_ko <= 45);
        assert!(min_ki >= 8 && max_ki <= 42);
        // Both windows are actually exercised, so the bounds are not vacuous.
        assert!(max_ko > 40, "KO window never reached its upper end");
        assert!(max_ki > 38, "KI window never reached its upper end");
    }

    #[test]
    fn scenario_events_do_not_disturb_each_others_rng_stream() {
        // Drawing the KI event after the KO event must give the same KI value
        // whether or not a KO event was taken first, given the same seed and a
        // scenario that draws both. Only `ko` draws both, so compare against a
        // generator advanced by exactly one draw.
        let a = ScenarioEvents::draw(PathScenario::Ko, &mut Mulberry32::new(99));
        let b = ScenarioEvents::draw(PathScenario::AliveKiCash, &mut Mulberry32::new(99));
        assert!(a.ko.is_some());
        assert_eq!(b.ko, None);
        assert_ne!(
            a.ki, b.ki,
            "the two scenarios draw different streams, which is the point"
        );
    }

    // -----------------------------------------------------------------------
    // Formatting
    // -----------------------------------------------------------------------

    #[test]
    fn pct_uses_tofixed_not_rounding() {
        assert_eq!(pct(1.0), "100.0%");
        assert_eq!(pct(0.7), "70.0%");
        assert_eq!(pct(0.0), "0.0%");
        // `0.45 * 100` is 45.000000000000006, which rounds to "45.0"; the
        // `(0.45).toFixed(1)` of 4.5 is the tie case and is covered by the
        // toFixed corpus.
        assert_eq!(pct(0.0045), "0.4%", "0.45 toFixed(1) is 0.4, not 0.5");
        assert_eq!(pct(0.75), "75.0%");
        assert_eq!(pct(0.6), "60.0%");
        assert_eq!(pct(1.2), "120.0%");
    }

    #[test]
    fn money_formats_two_decimal_places() {
        assert_eq!(money(0.0), "0.00");
        assert_eq!(money(100.0), "100.00");
        assert_eq!(money(115.62), "115.62");
        assert_eq!(money(-3.4), "-3.40");
        assert_eq!(money(0.8), "0.80");
        // `-0.0` prints as "0.00", not "-0.00".
        assert_eq!(money(-0.0), "0.00");
    }

    #[test]
    fn flag_renders_uppercase() {
        assert_eq!(flag(true), "TRUE");
        assert_eq!(flag(false), "FALSE");
    }

    // -----------------------------------------------------------------------
    // Traversal
    // -----------------------------------------------------------------------

    #[test]
    fn traversal_omits_unreached_nodes() {
        let ko = build_traversal(PathScenario::Ko);
        assert!(!ko.contains(&PayoffNodeId::KnockInGate));
        assert!(!ko.contains(&PayoffNodeId::RangeAccrual));
        assert!(!ko.contains(&PayoffNodeId::DownAndInPut));

        let no_ki = build_traversal(PathScenario::AliveNoKi);
        assert!(no_ki.contains(&PayoffNodeId::KnockInGate));
        assert!(no_ki.contains(&PayoffNodeId::RangeAccrual));
        assert!(!no_ki.contains(&PayoffNodeId::DownAndInPut));

        for scenario in [PathScenario::AliveKiCash, PathScenario::AliveKiPhysical] {
            let ki = build_traversal(scenario);
            assert!(ki.contains(&PayoffNodeId::KnockInGate));
            assert!(ki.contains(&PayoffNodeId::RangeAccrual));
            assert!(ki.contains(&PayoffNodeId::DownAndInPut));
            // Both knock-in scenarios traverse identically: the settlement
            // distinction is in the payoff, not the graph.
            assert_eq!(ki, build_traversal(PathScenario::AliveKiPhysical));
        }
    }

    #[test]
    fn traversal_starts_at_the_cube_and_ends_at_the_aggregate() {
        for scenario in [
            PathScenario::Ko,
            PathScenario::AliveKiCash,
            PathScenario::AliveKiPhysical,
            PathScenario::AliveNoKi,
        ] {
            let traversal = build_traversal(scenario);
            assert_eq!(
                traversal.first(),
                Some(&PayoffNodeId::PathCube),
                "{scenario:?}"
            );
            assert_eq!(
                traversal.last(),
                Some(&PayoffNodeId::AggregatePV),
                "{scenario:?}"
            );
            assert!(
                traversal.contains(&PayoffNodeId::FixingSchedule),
                "{scenario:?}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Distributions
    // -----------------------------------------------------------------------

    #[test]
    fn distribution_of_a_known_even_sample() {
        // 1..=10: mean 5.5, median (5 + 6) / 2 = 5.5.
        // Population variance = 82.5 / 10 = 8.25.
        let stats = compute_distribution(&(1..=10).map(f64::from).collect::<Vec<_>>());
        assert_eq!(stats.mean, 5.5);
        assert_eq!(stats.median, 5.5);
        assert_eq!(stats.std_dev, round2(8.25_f64.sqrt()));
        // Nearest rank on the sorted sample: floor(0.05 * 9) = 0, floor(0.95 * 9) = 8.
        assert_eq!(stats.p05, 1.0);
        assert_eq!(stats.p95, 9.0);
        assert_eq!(stats.values.len(), 10);
    }

    #[test]
    fn distribution_uses_population_not_sample_variance() {
        let values: Vec<f64> = (1..=10).map(f64::from).collect();
        let stats = compute_distribution(&values);
        // Sample stdDev would divide by n - 1 = 9 rather than n = 10.
        let sample = round2((82.5_f64 / 9.0).sqrt());
        assert_ne!(stats.std_dev, sample);
        assert_eq!(stats.std_dev, round2((82.5_f64 / 10.0).sqrt()));
    }

    #[test]
    fn distribution_of_an_odd_sample_takes_the_middle_value() {
        // 1..=9: the median is the 5th value, not an average of two.
        let stats = compute_distribution(&(1..=9).map(f64::from).collect::<Vec<_>>());
        assert_eq!(stats.mean, 5.0);
        assert_eq!(stats.median, 5.0, "odd sample, no averaging");
        assert_eq!(stats.std_dev, round2((60.0_f64 / 9.0).sqrt()));
        // floor(0.05 * 8) = 0 and floor(0.95 * 8) = 7 — not 0 and 8. This is the
        // rule doing something an interpolated quantile would not.
        assert_eq!(stats.p05, 1.0);
        assert_eq!(stats.p95, 8.0);
    }

    #[test]
    fn distribution_percentiles_are_nearest_rank_not_interpolated() {
        // Spell the index rule out for several sample sizes. `floor(q * (n - 1))`
        // on the sorted sample, never a linear interpolation between order
        // statistics, and `n` counts every value.
        for n in [2usize, 3, 5, 8, 9, 10, 20, 99, 100, 1_000] {
            let values: Vec<f64> = (0..n).map(|i| (i + 1) as f64).collect();
            let stats = compute_distribution(&values);
            let index05 = (0.05 * (n as f64 - 1.0)).floor() as usize;
            let index95 = (0.95 * (n as f64 - 1.0)).floor() as usize;
            assert_eq!(stats.p05, (index05 + 1) as f64, "p05 for n = {n}");
            assert_eq!(stats.p95, (index95 + 1) as f64, "p95 for n = {n}");
            // The rule never reads the last element for a 95th percentile
            // unless the sample is small enough that floor rounds onto it.
            assert!(index95 < n);
            assert!(index05 <= index95, "n = {n}");
            // They only separate once the sample has at least three values;
            // with n = 2 both indices are 0, which is a property of the rule
            // rather than a bug.
            if n >= 3 {
                assert!(index05 < index95, "n = {n}");
            }
        }
        // The concrete boundary: n = 20 gives index 18, i.e. the 19th of 20.
        let twenty = compute_distribution(&(1..=20).map(f64::from).collect::<Vec<_>>());
        assert_eq!(twenty.p05, 1.0, "floor(0.05 * 19) = 0");
        assert_eq!(twenty.p95, 19.0, "floor(0.95 * 19) = 18");
        // The demo sample: n = 100 gives indices 4 and 94.
        let hundred = compute_distribution(&(1..=100).map(f64::from).collect::<Vec<_>>());
        assert_eq!(hundred.p05, 5.0);
        assert_eq!(hundred.p95, 95.0);
    }

    #[test]
    fn distribution_of_a_single_value_is_that_value() {
        let stats = compute_distribution(&[7.25]);
        assert_eq!(stats.mean, 7.25);
        assert_eq!(stats.median, 7.25);
        assert_eq!(stats.std_dev, 0.0);
        // n = 1 means both percentile indices are 0.
        assert_eq!(stats.p05, 7.25);
        assert_eq!(stats.p95, 7.25);
    }

    #[test]
    fn distribution_handles_negative_values() {
        // `putPv` is 0 for 81 of the 100 paths and negative for the rest, so the
        // real distribution mixes signs. Check the machinery on a mixed sample.
        let stats = compute_distribution(&[-5.0, 0.0, 0.0, 0.0, 2.5]);
        assert_eq!(stats.mean, -0.5);
        assert_eq!(stats.median, 0.0);
        // floor(0.05 * 4) = 0 and floor(0.95 * 4) = 3 — the 4th value, which is
        // 0.0, not the 2.5 maximum.
        assert_eq!(stats.p05, -5.0);
        assert_eq!(stats.p95, 0.0);
        // Deviations from -0.5: -4.5, 0.5, 0.5, 0.5, 3.0 => 30 / 5 = 6.
        assert_eq!(stats.std_dev, round2(6.0_f64.sqrt()));
    }

    #[test]
    fn distribution_keeps_the_input_order_in_values() {
        let stats = compute_distribution(&[3.0, 1.0, 2.0]);
        assert_eq!(stats.values, vec![3.0, 1.0, 2.0]);
    }

    #[test]
    #[should_panic(expected = "at least one value")]
    fn distribution_rejects_an_empty_sample() {
        compute_distribution(&[]);
    }

    // -----------------------------------------------------------------------
    // Branch statistics
    // -----------------------------------------------------------------------

    #[test]
    fn branch_stats_scale_by_sample_fraction_not_by_multiplication() {
        // Four paths covering each branch exactly once.
        let paths: Vec<SimulationPath> = vec![
            fake_path(true, true, SettlementType::Cash),
            fake_path(false, true, SettlementType::Cash),
            fake_path(false, true, SettlementType::Physical),
            fake_path(false, false, SettlementType::None),
        ];
        let stats = build_branch_stats(&paths);

        // 1 of 4 => 0.25 * 100_000 = 25_000 exactly. 3 of 4 => 75_000. The
        // scaling is a fraction, so it is a no-op for any sample size; what is
        // *not* a no-op is the rounding, asserted in the next test.
        assert_eq!(stats.total_paths, 100_000, "a fixed display scale");
        assert_eq!(stats.ko_triggered, 25_000);
        assert_eq!(stats.alive, 75_000);
        assert_eq!(stats.knock_in, 50_000);
        assert_eq!(stats.no_knock_in, 25_000);
        assert_eq!(stats.cash_settlement, 25_000);
        assert_eq!(stats.physical_delivery, 25_000);

        // The four surviving counts plus the knocked-out count partition the
        // sample. If a refactor ever dropped the `!knocked_out` guard from one
        // predicate, a count would double up and this would fail.
        assert_eq!(
            stats.ko_triggered as usize + stats.alive as usize,
            stats.total_paths as usize
        );
        assert_eq!(
            stats.knock_in as usize + stats.no_knock_in as usize,
            stats.alive as usize
        );
        assert_eq!(
            stats.cash_settlement as usize + stats.physical_delivery as usize,
            stats.knock_in as usize
        );
    }

    #[test]
    fn branch_stats_round_three_thirds_up() {
        // 1 of 3 knocked out: 0.3333... * 100_000 = 33_333.33 -> 33_333.
        // The division happens before the rounding, so 1 * 1_000 would give a
        // different answer; the point is that both thirds round up.
        let paths = vec![
            fake_path(true, false, SettlementType::None),
            fake_path(false, true, SettlementType::Cash),
            fake_path(false, false, SettlementType::None),
        ];
        let stats = build_branch_stats(&paths);
        assert_eq!(stats.ko_triggered, 33_333);
        assert_eq!(stats.alive, 66_667, "2 of 3 rounds up");
        // The scaled counts need not sum to `total_paths` after rounding.
        assert_eq!(
            stats.ko_triggered + stats.alive,
            100_000,
            "here they happen to"
        );
    }

    #[test]
    fn branch_stats_ignore_settlement_on_a_knocked_out_path() {
        // A knocked-out path with a stale `knock_in_triggered` flag and a `cash`
        // settlement type must not be counted: an autocall redeems at par and
        // never settles a put. Dropping the `!knocked_out` guard would report
        // 2 of 4 (50_000) instead of 1 of 4.
        let paths = vec![
            fake_path(true, true, SettlementType::Cash),
            fake_path(false, true, SettlementType::Cash),
            fake_path(false, false, SettlementType::None),
            fake_path(false, false, SettlementType::None),
        ];
        let stats = build_branch_stats(&paths);
        assert_eq!(stats.cash_settlement, 25_000, "1 of 4, not 2");
        assert_eq!(stats.physical_delivery, 0);
        // The stale flag does not rescue the count either: `knock_in` shares the
        // same `!knocked_out` guard, so the KO path is outside every
        // knock-in-side statistic. Only `ko_triggered` and `alive` see it.
        assert_eq!(stats.knock_in, 25_000);
        assert_eq!(stats.ko_triggered, 25_000);
        assert_eq!(stats.alive, 75_000);
    }

    /// A path with only the fields `build_branch_stats` reads.
    fn fake_path(
        knocked_out: bool,
        knock_in_triggered: bool,
        settlement_type: SettlementType,
    ) -> SimulationPath {
        // Generated once and cloned, so the helper costs one 1-path run rather
        // than one per call.
        static TEMPLATE: std::sync::OnceLock<SimulationPath> = std::sync::OnceLock::new();
        let template = TEMPLATE.get_or_init(|| {
            generate_paths(
                SimulationConfig {
                    path_count: 1,
                    observations: 1,
                    ..SimulationConfig::demo()
                },
                |_| {},
            )
            .expect("valid config")
            .paths
            .into_iter()
            .next()
            .expect("one path")
        });
        let mut path = template.clone();
        path.knocked_out = knocked_out;
        path.knock_in_triggered = knock_in_triggered;
        path.settlement_type = settlement_type;
        path
    }

    // -----------------------------------------------------------------------
    // Progress
    // -----------------------------------------------------------------------

    #[test]
    fn progress_advances_on_a_single_monotonic_axis() {
        let (_, events) = generate_with_log(SimulationConfig::demo());
        assert!(!events.is_empty());

        let mut previous = 0;
        for event in &events {
            assert_eq!(event.total, 100, "total is the path count");
            assert!(
                event.completed >= previous,
                "completed went backwards: {previous} then {}",
                event.completed
            );
            assert!(event.completed <= event.total);
            previous = event.completed;
        }
        assert_eq!(previous, 100, "the stream must finish at 100%");
    }

    #[test]
    fn progress_names_every_stage() {
        let (_, events) = generate_with_log(SimulationConfig::demo());
        let phases: std::collections::BTreeSet<&str> =
            events.iter().map(|e| e.phase.as_str()).collect();
        assert_eq!(
            phases,
            std::collections::BTreeSet::from([
                "assign_scenarios",
                "generate_series",
                "node_details",
                "aggregate",
            ])
        );
    }

    #[test]
    fn progress_ticks_every_tenth_path() {
        let (_, events) = generate_with_log(SimulationConfig::demo());
        let ticks: Vec<u32> = events
            .iter()
            .filter(|e| e.phase == "generate_series")
            .map(|e| e.completed)
            .collect();
        // 100 paths: ten ticks plus the final one, which lands on 100 anyway.
        assert_eq!(ticks, vec![10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    }

    // -----------------------------------------------------------------------
    // The series builder, in isolation
    // -----------------------------------------------------------------------

    #[test]
    fn hold_within_scenario_keeps_an_alive_no_ki_path_in_its_band() {
        let barriers = ProductBarriers::default();
        let [a, m, n] = hold_within_scenario(
            PathScenario::AliveNoKi,
            &barriers,
            None,
            None,
            0,
            [0.01, 1.4, 0.8],
        );
        let lo = barriers.ki_barrier + 0.02;
        let hi = barriers.ko_barrier - 0.01;
        for level in [a, m, n] {
            assert!((lo..=hi).contains(&level), "{level} outside [{lo}, {hi}]");
        }
    }

    #[test]
    fn hold_within_scenario_caps_knock_in_paths_below_ko() {
        let barriers = ProductBarriers::default();
        let [a, m, n] = hold_within_scenario(
            PathScenario::AliveKiCash,
            &barriers,
            Some(20),
            None,
            0,
            [5.0, 5.0, 5.0],
        );
        let cap = barriers.ko_barrier - 0.005;
        let floor = barriers.ki_barrier + 0.01;
        for level in [a, m, n] {
            assert!(
                (floor..=cap).contains(&level),
                "{level} outside [{floor}, {cap}]"
            );
        }
        // The cap is inclusive: `js_min(5.0, cap)` lands exactly on it, and the
        // floor lift below cannot push it back up.
        assert_eq!(a, cap);
        assert!(a < barriers.ko_barrier, "and still strictly below KO");
    }

    #[test]
    fn hold_within_scenario_caps_ko_paths_before_the_event_only() {
        let barriers = ProductBarriers::default();
        let cap = barriers.ko_barrier - 0.01;

        // Before the event, capped below KO.
        let before = hold_within_scenario(
            PathScenario::Ko,
            &barriers,
            None,
            Some(20),
            5,
            [9.0, 9.0, 9.0],
        );
        for level in before {
            assert!(level <= cap, "{level} not capped before the KO event");
        }

        // On and after the event, uncapped: the path is redeeming.
        let after = hold_within_scenario(
            PathScenario::Ko,
            &barriers,
            None,
            Some(20),
            20,
            [9.0, 9.0, 9.0],
        );
        for level in after {
            assert_eq!(level, 9.0, "the KO event step must not be capped");
        }
    }

    #[test]
    fn hold_within_scenario_leaves_knock_in_paths_floored_after_the_event() {
        let barriers = ProductBarriers::default();
        // After the KI event the floor is lifted, so the path is free to sit
        // below the barrier.
        let after = hold_within_scenario(
            PathScenario::AliveKiCash,
            &barriers,
            Some(10),
            None,
            30,
            [0.4, 0.4, 0.4],
        );
        assert_eq!(after, [0.4; 3]);
    }

    #[test]
    fn enforce_scenario_forces_a_missing_ko_at_observation_30() {
        let barriers = ProductBarriers::default();
        let n = 60;
        let mut levels = Levels::new(n);
        for _ in 0..n {
            levels.record(0.8, 0.8, 0.8, 0.8);
        }
        let mut ko_index = None;
        let mut ki_index = None;
        enforce_scenario(
            PathScenario::Ko,
            &barriers,
            n,
            &mut levels,
            &mut ko_index,
            &mut ki_index,
        );

        assert_eq!(ko_index, Some(30), "the KO fallback index is 30");
        assert_eq!(levels.worst_of[30], barriers.ko_barrier + 0.02);
        // The tail repeats the forced level, and everything before it is untouched.
        assert!(levels.worst_of[31..]
            .iter()
            .all(|w| *w == levels.worst_of[30]));
        assert!(levels.worst_of[..30].iter().all(|w| *w == 0.8));
        // The three names stay consistent with `worst_of`.
        assert_eq!(levels.nvda[30], levels.worst_of[30]);
        assert_eq!(levels.msft[30], levels.worst_of[30] + 0.02);
        assert_eq!(levels.aapl[30], levels.worst_of[30] + 0.01);
    }

    #[test]
    fn enforce_scenario_forces_a_missing_knock_in_at_observation_25() {
        let barriers = ProductBarriers::default();
        let n = 60;
        let mut levels = Levels::new(n);
        for _ in 0..n {
            levels.record(0.8, 0.8, 0.8, 0.8);
        }
        let mut ko_index = None;
        let mut ki_index = None;
        enforce_scenario(
            PathScenario::AliveKiCash,
            &barriers,
            n,
            &mut levels,
            &mut ko_index,
            &mut ki_index,
        );

        // 25, not the 30 used for the KO fallback. That asymmetry is deliberate.
        assert_eq!(ki_index, Some(25));
        assert_eq!(ko_index, None, "an alive path never gets a KO index");
        assert_eq!(levels.worst_of[25], barriers.ki_barrier - 0.05);
        assert!(levels.worst_of[25] <= barriers.ki_barrier);
    }

    #[test]
    fn enforce_scenario_caps_an_alive_path_that_touched_ko() {
        let barriers = ProductBarriers::default();
        let n = 60;
        let mut levels = Levels::new(n);
        for _ in 0..n {
            levels.record(1.2, 1.2, 1.2, 1.2);
        }
        let mut ko_index = Some(7);
        let mut ki_index = None;
        enforce_scenario(
            PathScenario::AliveNoKi,
            &barriers,
            n,
            &mut levels,
            &mut ko_index,
            &mut ki_index,
        );

        assert_eq!(ko_index, None);
        assert!(levels.worst_of.iter().all(|w| *w < barriers.ko_barrier));
        // The whole series is also lifted above KI, since no crossing was asked for.
        assert!(levels.worst_of.iter().all(|w| *w > barriers.ki_barrier));
    }

    #[test]
    fn enforce_scenario_is_a_no_op_when_the_walk_already_matches() {
        let barriers = ProductBarriers::default();
        let n = 60;
        let mut levels = Levels::new(n);
        for _ in 0..n {
            levels.record(0.8, 0.8, 0.8, 0.8);
        }
        let original = levels.worst_of.clone();

        // An alive path that already sits above KI and below KO needs no patch.
        let mut ko_index = None;
        let mut ki_index = None;
        enforce_scenario(
            PathScenario::AliveNoKi,
            &barriers,
            n,
            &mut levels,
            &mut ko_index,
            &mut ki_index,
        );
        assert_eq!(levels.worst_of, original);
        assert_eq!(ko_index, None);
        assert_eq!(ki_index, None);
    }

    #[test]
    fn enforce_scenario_clamps_fallback_indices_to_short_series() {
        // `min(30, n - 1)` and `min(25, n - 1)`: a series shorter than the
        // fallback index must not index out of bounds.
        let barriers = ProductBarriers::default();
        for n in [1usize, 5, 26] {
            let mut levels = Levels::new(n);
            for _ in 0..n {
                levels.record(0.8, 0.8, 0.8, 0.8);
            }
            let mut ko_index = None;
            let mut ki_index = None;
            enforce_scenario(
                PathScenario::Ko,
                &barriers,
                n,
                &mut levels,
                &mut ko_index,
                &mut ki_index,
            );
            assert_eq!(ko_index, Some(n - 1), "n = {n}");
            assert_eq!(levels.worst_of.len(), n, "n = {n}");
        }
    }
}
