//! Monte Carlo diagnostics: the port of `src/mock-data/mcDiagnostics.ts`.
//!
//! # These numbers are illustrative, and that is the point
//!
//! **No simulation produced this series.** `pv`, `ki` and `ko` are literal
//! arrays typed by hand; `se`, `lower`, `upper`, `p05` and `p95` are closed-form
//! functions of the path count and the index. Nothing here is measured, and the
//! path counts (`1000` … `1_000_000`) do not correspond to runs of the path
//! generator, which produces 100 paths.
//!
//! This is the single most misreadable surface in the application: the tile
//! renders a convergence chart with a "converged" badge, and every number on it
//! is fabricated. `FEATURE.ts.md` states it directly — *"labels such as 100,000
//! or 1,000,000 paths are illustrative diagnostic points, not a simulation
//! currently executed by the app"* — and that framing is preserved verbatim so
//! the migration cannot be read as having invented a Monte Carlo engine.
//!
//! It is called *diagnostics* for the same reason: the module supplies display
//! data for the Monte Carlo Diagnostics dashboard, not a convergence check.
//! Phase 1 does not wire it to anything that claims validation.
//!
//! # What is still exact
//!
//! The arithmetic is a faithful port, so the kernel reproduces the fixture
//! exactly:
//!
//! - `se` is rounded to 3 places **first**, and `lower`/`upper` are computed
//!   from the *rounded* `se`. Using the unrounded value moves `lower`/`upper`
//!   by up to half a cent.
//! - `p05` and `p95` are functions of the **index** `i`, not the path count, so
//!   the series is not monotone in any way the labels suggest.
//! - `p50` is `pv` rounded to 2 places, i.e. a no-op that exists to mirror the
//!   other quantiles.

use crate::jsnum::js_to_fixed_f64;
use serde::{Deserialize, Serialize};

/// The illustrative path counts, in ascending order.
pub const MC_PATH_COUNTS: [u32; 10] = [
    1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000,
];

/// Hand-entered present values, one per entry in [`MC_PATH_COUNTS`].
///
/// Not measured. See the module docs.
const PV: [f64; 10] = [
    97.5, 96.7, 96.2, 96.05, 95.91, 95.82, 95.78, 95.75, 95.74, 95.74,
];

/// Hand-entered knock-in probabilities, percent. Not measured.
const KI: [f64; 10] = [
    25.0, 23.8, 23.0, 22.5, 22.25, 22.18, 22.12, 22.1, 22.1, 22.1,
];

/// Hand-entered knock-out probabilities, percent. Not measured.
const KO: [f64; 10] = [60.5, 62.1, 63.4, 64.1, 64.7, 64.9, 65.0, 65.0, 65.0, 65.0];

/// Standard-error scale constant: `0.22 * sqrt(REFERENCE_PATHS / paths)`.
const SE_SCALE: f64 = 0.22;

/// Path count the `se` formula normalises against.
const REFERENCE_PATHS: f64 = 100_000.0;

/// Two-sided 95% normal quantile.
const Z_95: f64 = 1.96;

/// Lower-quantile anchor for `p05`.
const P05_BASE: f64 = 72.0;

/// `p05` decay numerator.
const P05_DECAY: f64 = 8.0;

/// Upper-quantile anchor for `p95`.
const P95_BASE: f64 = 116.0;

/// `p95` decay numerator.
const P95_DECAY: f64 = 5.0;

/// One row of the convergence series.
///
/// Field order here is the field order in `golden.json`'s `mc.mcDiagnostics`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McPoint {
    /// The illustrative path count this row is labelled with.
    pub paths: u32,
    /// Present value. A literal.
    pub pv: f64,
    /// Standard error, 3 decimals.
    pub se: f64,
    /// `pv - 1.96 * se`, 2 decimals. Computed from the **rounded** `se`.
    pub lower: f64,
    /// `pv + 1.96 * se`, 2 decimals. Computed from the **rounded** `se`.
    pub upper: f64,
    /// Knock-in probability, percent. A literal.
    pub ki: f64,
    /// Knock-out probability, percent. A literal.
    pub ko: f64,
    /// 5th percentile, 2 decimals. A function of the **row index**.
    pub p05: f64,
    /// Median: `pv` at 2 decimals.
    pub p50: f64,
    /// 95th percentile, 2 decimals. A function of the **row index**.
    pub p95: f64,
}

/// One row of the efficiency comparison table. Also a literal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McEfficiency {
    /// Sampler name.
    pub name: String,
    /// Paths the sampler is credited with.
    pub paths: u32,
}

/// The efficiency table, in display order.
///
/// Every row is a literal; there is no timing behind these numbers either. The
/// non-monotonic ordering (`Sobol` at 60,000 below `Control Variates` at 80,000)
/// is preserved.
pub const MC_EFFICIENCY: [(&str, u32); 4] = [
    ("Pseudo Random", 500_000),
    ("Antithetic", 250_000),
    ("Sobol", 60_000),
    ("Control Variates", 80_000),
];

/// `se = +(0.22 * sqrt(REFERENCE_PATHS / paths)).toFixed(3)`.
///
/// Rounded to 3 places here rather than at the call site, because
/// [`confidence_interval`] consumes the **rounded** value.
fn standard_error(paths: u32) -> f64 {
    js_to_fixed_f64(SE_SCALE * (REFERENCE_PATHS / paths as f64).sqrt(), 3)
}

/// `(pv - 1.96 * se, pv + 1.96 * se)`, both at 2 decimal places.
///
/// Takes `se` as given — the caller must pass [`standard_error`]'s output, not a
/// raw standard error, because the TypeScript rounds `se` into a local before
/// building the interval:
///
/// ```text
/// const se = +(0.22 * Math.sqrt(100000 / paths)).toFixed(3)
/// lower: +(estimate - 1.96 * se).toFixed(2)
/// ```
///
/// No row of the published series happens to distinguish the two, because at
/// every path count the 2-decimal `pv` lattice lands `1.96 * se` a fixed
/// distance from a rounding boundary that exceeds the rounding error of `se`.
/// `lower_and_upper_use_the_rounded_standard_error` pins the behaviour anyway.
fn confidence_interval(pv: f64, se: f64) -> (f64, f64) {
    (
        js_to_fixed_f64(pv - Z_95 * se, 2),
        js_to_fixed_f64(pv + Z_95 * se, 2),
    )
}

/// Builds the ten-row convergence series.
///
/// ```
/// use fina_kernel::diagnostics::mc_diagnostics;
///
/// let rows = mc_diagnostics();
/// assert_eq!(rows.len(), 10);
/// assert_eq!(rows[0].paths, 1000);
/// assert_eq!(rows[0].se, 2.2);
/// ```
#[must_use]
pub fn mc_diagnostics() -> Vec<McPoint> {
    MC_PATH_COUNTS
        .iter()
        .enumerate()
        .map(|(i, &paths)| row_at(i, paths))
        .collect()
}

/// Builds one row of the series from the literal columns and the closed forms.
///
/// `i` is the row's position, which the `p05`/`p95` columns are a function of —
/// *not* the path count. That is why those two series do not track `paths`, and
/// it is preserved rather than tidied into `paths`-keyed formulas.
fn row_at(i: usize, paths: u32) -> McPoint {
    let pv = PV[i];
    let se = standard_error(paths);
    let (lower, upper) = confidence_interval(pv, se);
    let t = (i as f64 + 1.0).sqrt();

    McPoint {
        paths,
        pv,
        se,
        lower,
        upper,
        ki: KI[i],
        ko: KO[i],
        p05: js_to_fixed_f64(P05_BASE - P05_DECAY / t, 2),
        p50: js_to_fixed_f64(pv, 2),
        p95: js_to_fixed_f64(P95_BASE - P95_DECAY / t, 2),
    }
}

/// The efficiency comparison table.
///
/// ```
/// use fina_kernel::diagnostics::mc_efficiency;
/// assert_eq!(mc_efficiency().len(), 4);
/// ```
#[must_use]
pub fn mc_efficiency() -> Vec<McEfficiency> {
    MC_EFFICIENCY
        .iter()
        .map(|&(name, paths)| McEfficiency {
            name: name.to_string(),
            paths,
        })
        .collect()
}

/// The last row of [`mc_diagnostics`] — the point the tile badges as converged.
///
/// Equivalent to `mc_diagnostics().last()`, but it shares the row builder
/// rather than re-deriving the arithmetic, and it states the intent honestly:
/// this row is a display constant, not a result.
///
/// ```
/// use fina_kernel::diagnostics::final_mc;
/// assert_eq!(final_mc().paths, 1_000_000);
/// ```
#[must_use]
pub fn final_mc() -> McPoint {
    let i = MC_PATH_COUNTS.len() - 1;
    row_at(i, MC_PATH_COUNTS[i])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn series_has_ten_rows_with_ascending_path_counts() {
        let rows = mc_diagnostics();
        assert_eq!(rows.len(), 10);
        assert_eq!(
            rows.iter().map(|r| r.paths).collect::<Vec<_>>(),
            MC_PATH_COUNTS.to_vec()
        );
        assert!(rows.windows(2).all(|w| w[0].paths < w[1].paths));
    }

    #[test]
    fn standard_error_decreases_strictly_with_path_count() {
        let rows = mc_diagnostics();
        assert!(
            rows.windows(2).all(|w| w[1].se < w[0].se),
            "se must strictly decrease: {:?}",
            rows.iter().map(|r| r.se).collect::<Vec<_>>()
        );
        // Half the paths is 1/sqrt(2) the standard error.
        assert_eq!(rows[6].se, 0.22);
        assert_eq!(rows[0].se, 2.2);
    }

    #[test]
    fn first_row_matches_golden() {
        let r = mc_diagnostics()[0];
        assert_eq!(r.paths, 1000);
        assert_eq!(r.pv, 97.5);
        assert_eq!(r.se, 2.2);
        assert_eq!(r.lower, 93.19);
        assert_eq!(r.upper, 101.81);
        assert_eq!(r.ki, 25.0);
        assert_eq!(r.ko, 60.5);
        assert_eq!(r.p05, 64.0);
        assert_eq!(r.p50, 97.5);
        assert_eq!(r.p95, 111.0);
    }

    #[test]
    fn last_row_matches_golden_and_is_the_final_mc() {
        let r = mc_diagnostics()[9];
        assert_eq!(r.paths, 1_000_000);
        assert_eq!(r.pv, 95.74);
        assert_eq!(r.se, 0.07);
        assert_eq!(r.lower, 95.6);
        assert_eq!(r.upper, 95.88);
        assert_eq!(r.p05, 69.47);
        assert_eq!(r.p95, 114.42);
        assert_eq!(r, final_mc());
    }

    /// The rounded-`se` trap. Latent rather than live: no published row
    /// distinguishes the two, because the `pv` column is 2-decimal and
    /// `1.96 * 1.391 == 2.72636` puts every lattice point a fixed `0.00136`
    /// from a rounding boundary — three times the rounding error of `se`. The
    /// property is pinned on a 3-decimal `pv` instead, where it does bite.
    #[test]
    fn lower_and_upper_use_the_rounded_standard_error() {
        let se_raw = SE_SCALE * (REFERENCE_PATHS / 2500.0).sqrt();
        let se = standard_error(2500);
        assert_ne!(se_raw, se, "the premise: se is not exact at 2500 paths");
        assert_eq!(se, 1.391);

        // Published row 1 recomputes from the rounded se.
        let row = mc_diagnostics()[1];
        assert_eq!(
            (row.lower, row.upper),
            confidence_interval(row.pv, se),
            "the series must build its interval from the rounded se"
        );

        // And here the two genuinely differ.
        let pv = 0.002_f64;
        assert_ne!(
            confidence_interval(pv, se),
            confidence_interval(pv, se_raw),
            "the premise of this test vanished"
        );
        assert_eq!(confidence_interval(pv, se), (-2.72, 2.73));
    }

    #[test]
    fn every_published_row_agrees_with_the_rounded_se() {
        // Recorded as a fact about the fixture, so that a future change to the
        // `pv` literals is caught here rather than as a silent parity shift.
        let rows = mc_diagnostics();
        for r in &rows {
            let se_raw = SE_SCALE * (REFERENCE_PATHS / f64::from(r.paths)).sqrt();
            assert_eq!(
                (r.lower, r.upper),
                confidence_interval(r.pv, standard_error(r.paths)),
                "row {}",
                r.paths
            );
            // And note that this row happens not to distinguish them.
            assert_eq!(
                (r.lower, r.upper),
                confidence_interval(r.pv, se_raw),
                "row {} now distinguishes rounded from unrounded se",
                r.paths
            );
        }
    }

    #[test]
    fn confidence_interval_brackets_the_pv_in_every_row() {
        for r in mc_diagnostics() {
            assert!(r.lower < r.pv, "row {}: {} !< {}", r.paths, r.lower, r.pv);
            assert!(r.pv < r.upper, "row {}: {} !< {}", r.paths, r.pv, r.upper);
            assert!(r.se > 0.0);
        }
    }

    /// `p05`/`p95` are functions of the row index, so they depend on the row's
    /// *position* in the table rather than its path count. Both series increase
    /// with the index, which is why `p95` is above `p05` everywhere and both
    /// creep up the table.
    #[test]
    fn p05_and_p95_are_index_driven_not_path_driven() {
        let rows = mc_diagnostics();
        assert!(rows.iter().all(|r| r.p05 < r.p95));
        assert!(rows.windows(2).all(|w| w[0].p05 < w[1].p05));
        assert!(rows.windows(2).all(|w| w[0].p95 < w[1].p95));

        // Row 0: 72 - 8/1 and 116 - 5/1.
        assert_eq!(rows[0].p05, 64.0);
        assert_eq!(rows[0].p95, 111.0);
        // Row 9: 72 - 8/sqrt(10) = 69.4697…, 116 - 5/sqrt(10) = 114.4188…
        assert_eq!(rows[9].p05, 69.47);
        assert_eq!(rows[9].p95, 114.42);
    }

    #[test]
    fn p50_is_pv_at_two_decimals() {
        for r in mc_diagnostics() {
            assert_eq!(r.p50, js_to_fixed_f64(r.pv, 2));
        }
    }

    #[test]
    fn knock_in_falls_and_knock_out_rises_as_the_series_converges() {
        let rows = mc_diagnostics();
        assert!(rows.windows(2).all(|w| w[1].ki <= w[0].ki));
        assert!(rows.windows(2).all(|w| w[1].ko >= w[0].ko));
        assert_eq!(rows[6].ki, 22.12);
        assert_eq!(rows[6].ko, 65.0);
    }

    #[test]
    fn efficiency_table_matches_golden_including_the_non_monotonic_order() {
        let rows = mc_efficiency();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].name, "Pseudo Random");
        assert_eq!(rows[0].paths, 500_000);
        assert_eq!(rows[1].name, "Antithetic");
        assert_eq!(rows[1].paths, 250_000);
        assert_eq!(rows[2].name, "Sobol");
        assert_eq!(rows[2].paths, 60_000);
        assert_eq!(rows[3].name, "Control Variates");
        assert_eq!(rows[3].paths, 80_000);
    }

    #[test]
    fn serialises_in_golden_field_order() {
        let json = serde_json::to_string(&mc_diagnostics()[0]).unwrap();
        assert_eq!(
            json,
            r#"{"paths":1000,"pv":97.5,"se":2.2,"lower":93.19,"upper":101.81,"ki":25.0,"ko":60.5,"p05":64.0,"p50":97.5,"p95":111.0}"#
        );
    }

    #[test]
    fn round_trips_through_json() {
        for r in mc_diagnostics() {
            let json = serde_json::to_string(&r).unwrap();
            assert_eq!(serde_json::from_str::<McPoint>(&json).unwrap(), r);
        }
        for r in mc_efficiency() {
            let json = serde_json::to_string(&r).unwrap();
            assert_eq!(serde_json::from_str::<McEfficiency>(&json).unwrap(), r);
        }
    }

    #[test]
    fn is_deterministic() {
        assert_eq!(
            serde_json::to_string(&mc_diagnostics()).unwrap(),
            serde_json::to_string(&mc_diagnostics()).unwrap()
        );
    }
}
