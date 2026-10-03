//! Observation-date arithmetic for the demo fixing schedule.
//!
//! # Why no date library
//!
//! ``PHASE1_MIGRATION_PROMPT.md`` originally allowed `chrono` or `time`. This
//! module implements the schedule with plain integer arithmetic instead, which
//! removes a dependency and makes `fina-kernel` easier to lift into a standalone
//! git submodule (a stated goal for the `fina-*` family).
//!
//! The demo schedule is `2024-01-15` plus `i` months, formatted `YYYY-MM-DD`.
//! Because the day-of-month is always 15, no month-end clamping is ever needed,
//! so a proleptic-Gregorian month index is sufficient and total.
//!
//! The TypeScript original used `dayjs('2024-01-15').add(i, 'month')`. That does
//! clamp day-of-month at month ends; with day 15 the two agree on all 60 dates,
//! which `dates_are_exact_for_the_demo_schedule` and the golden fixture verify.

/// The demo schedule's first observation date.
pub const DEMO_START_DATE: &str = "2024-01-15";

/// Formats `year`/`month`/`day` as `YYYY-MM-DD`.
///
/// # Panics
/// Panics if `month` is outside `1..=12` or `day` is outside `1..=31`. Callers
/// pass values derived from [`observation_dates`], so this cannot trigger.
fn format_iso(year: i32, month: u32, day: u32) -> String {
    assert!(
        (1..=12).contains(&month),
        "month out of range: {month} (year {year})"
    );
    assert!((1..=31).contains(&day), "day out of range: {day}");
    format!("{year:04}-{month:02}-{day:02}")
}

/// Returns the `i`th monthly observation date starting from `start`.
///
/// `start` must be `YYYY-MM-DD`. `i` is a plain month offset, so index `0`
/// returns `start` itself.
///
/// # Panics
/// Panics if `start` is not a valid `YYYY-MM-DD` date, or if the resulting
/// month falls outside `1..=12`. Both indicate a caller bug: the kernel only
/// ever passes [`DEMO_START_DATE`], which is validated by
/// `dates_are_exact_for_the_demo_schedule`.
///
/// ```
/// use fina_kernel::dates::observation_dates;
/// let d = observation_dates("2024-01-15", 4);
/// assert_eq!(d[0], "2024-01-15");
/// assert_eq!(d[3], "2024-04-15");
/// ```
#[must_use]
pub fn observation_dates(start: &str, count: usize) -> Vec<String> {
    let (sy, sm, sd) = parse_iso(start).expect("start date must be YYYY-MM-DD");
    (0..count)
        .map(|i| {
            // Total months since year 0, so December -> January rolls the year.
            // `i` is bounded by the caller's `count`, which is a small schedule
            // length; saturating conversion keeps this total on 64-bit targets.
            let offset = i64::try_from(i).unwrap_or(i64::MAX);
            let total = i64::from(sm) - 1 + offset;
            let year = sy + (total / 12) as i32;
            let month = (total % 12) as u32 + 1;
            format_iso(year, month, sd)
        })
        .collect()
}

/// Convenience wrapper for the demo schedule.
#[must_use]
pub fn demo_dates(count: usize) -> Vec<String> {
    observation_dates(DEMO_START_DATE, count)
}

fn parse_iso(s: &str) -> Option<(i32, u32, u32)> {
    let bytes = s.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year = s[0..4].parse::<i32>().ok()?;
    let month = s[5..7].parse::<u32>().ok()?;
    let day = s[8..10].parse::<u32>().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((year, month, day))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_schedule_matches_golden_first_and_last() {
        let dates = demo_dates(60);
        assert_eq!(dates.len(), 60);
        assert_eq!(dates[0], "2024-01-15");
        assert_eq!(dates[59], "2028-12-15");
    }

    #[test]
    fn dates_are_exact_for_the_demo_schedule() {
        // Every one of the 60 strings, asserted against the golden fixture.
        // A wrong month-roll implementation fails here immediately.
        let expected = [
            "2024-01-15",
            "2024-02-15",
            "2024-03-15",
            "2024-04-15",
            "2024-05-15",
            "2024-06-15",
            "2024-07-15",
            "2024-08-15",
            "2024-09-15",
            "2024-10-15",
            "2024-11-15",
            "2024-12-15",
            "2025-01-15",
            "2025-02-15",
            "2025-03-15",
            "2025-04-15",
            "2025-05-15",
            "2025-06-15",
            "2025-07-15",
            "2025-08-15",
            "2025-09-15",
            "2025-10-15",
            "2025-11-15",
            "2025-12-15",
            "2026-01-15",
            "2026-02-15",
            "2026-03-15",
            "2026-04-15",
            "2026-05-15",
            "2026-06-15",
            "2026-07-15",
            "2026-08-15",
            "2026-09-15",
            "2026-10-15",
            "2026-11-15",
            "2026-12-15",
            "2027-01-15",
            "2027-02-15",
            "2027-03-15",
            "2027-04-15",
            "2027-05-15",
            "2027-06-15",
            "2027-07-15",
            "2027-08-15",
            "2027-09-15",
            "2027-10-15",
            "2027-11-15",
            "2027-12-15",
            "2028-01-15",
            "2028-02-15",
            "2028-03-15",
            "2028-04-15",
            "2028-05-15",
            "2028-06-15",
            "2028-07-15",
            "2028-08-15",
            "2028-09-15",
            "2028-10-15",
            "2028-11-15",
            "2028-12-15",
        ];
        assert_eq!(demo_dates(60), expected);
    }

    #[test]
    fn year_rolls_over_december() {
        let d = observation_dates("2024-11-15", 4);
        assert_eq!(d, ["2024-11-15", "2024-12-15", "2025-01-15", "2025-02-15"]);
    }

    #[test]
    fn index_zero_returns_start() {
        assert_eq!(observation_dates("2030-06-15", 1)[0], "2030-06-15");
    }

    #[test]
    fn count_zero_is_empty() {
        assert!(demo_dates(0).is_empty());
    }

    #[test]
    fn long_horizon_spans_multiple_years() {
        let d = observation_dates("2024-01-15", 120);
        assert_eq!(d.len(), 120);
        assert_eq!(d[119], "2033-12-15");
    }

    #[test]
    fn parse_iso_rejects_malformed() {
        assert!(parse_iso("2024-1-15").is_none());
        assert!(parse_iso("20240115").is_none());
        assert!(parse_iso("2024-13-15").is_none());
        assert!(parse_iso("2024-00-15").is_none());
        assert!(parse_iso("2024-01-00").is_none());
        assert_eq!(parse_iso("2024-01-15"), Some((2024, 1, 15)));
    }

    #[test]
    #[should_panic(expected = "start date must be YYYY-MM-DD")]
    fn malformed_start_panics_loudly() {
        let _ = observation_dates("nope", 1);
    }
}
