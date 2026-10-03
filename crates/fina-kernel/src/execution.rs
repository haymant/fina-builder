//! Execution events: the per-observation event stream behind the Schedule
//! Explorer / Observation Explorer tiles.
//!
//! Port of `executionEvents` from `src/features/payoff-graph/data/executionContexts.ts`.
//!
//! This file did not appear in the L1–L7 port table — the wire contract (§5.0)
//! adds it as a derived view over a path — but it is still domain logic (a pure
//! function of a `SimulationPath`), so it lives in the kernel like every other
//! value the frontend renders.

use crate::jsnum::js_to_fixed_f64;
use crate::types::SimulationPath;
use serde::{Deserialize, Serialize};

/// One observation event, exactly the TypeScript union.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionEvent {
    /// Observation index.
    pub index: usize,
    /// `path.dates[index]`.
    pub date: String,
    /// Event classification (see [`ExecutionEventType`]).
    #[serde(rename = "type")]
    pub kind: ExecutionEventType,
    /// `+(worst_of * 100).toFixed(1)` — a percentage with one decimal.
    pub worst_of: f64,
    /// `observations[index].coupon_accrued > 0`.
    pub coupon: bool,
    /// `observations[index].knock_in_at_date`.
    pub ki: bool,
    /// `observations[index].knock_out_at_date`.
    pub ko: bool,
}

/// The `ExecutionEvent['type']` union, serialised exactly as the TypeScript
/// writes it (`"Coupon Observation"` — case and space from the source, not
/// serde's `camelCase`).
///
/// `Settlement` is part of the TypeScript union but is never produced by
/// `executionEvents`; it is carried for type fidelity, like `cash_settlement`
/// and `funding` on `CashflowType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionEventType {
    /// A coupon was accrued at this observation.
    CouponObservation,
    /// The knock-out barrier was first breached here.
    KoObservation,
    /// A plain barrier check with no coupon (worst-of below the coupon range).
    BarrierObservation,
    /// The maturity observation.
    FinalFixing,
    /// Part of the union; never produced by `execution_events`.
    Settlement,
}

impl ExecutionEventType {
    /// The display string the tile renders, `"Coupon Observation"` etc. — this
    /// is the wire form, not a display-only label.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::CouponObservation => "Coupon Observation",
            Self::KoObservation => "KO Observation",
            Self::BarrierObservation => "Barrier Observation",
            Self::FinalFixing => "Final Fixing",
            Self::Settlement => "Settlement",
        }
    }

    /// Parses the wire form back into the variant.
    fn from_label(label: &str) -> Option<Self> {
        match label {
            "Coupon Observation" => Some(Self::CouponObservation),
            "KO Observation" => Some(Self::KoObservation),
            "Barrier Observation" => Some(Self::BarrierObservation),
            "Final Fixing" => Some(Self::FinalFixing),
            "Settlement" => Some(Self::Settlement),
            _ => None,
        }
    }
}

impl Serialize for ExecutionEventType {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.label())
    }
}

impl<'de> Deserialize<'de> for ExecutionEventType {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(d)?;
        Self::from_label(&raw).ok_or_else(|| {
            serde::de::Error::unknown_variant(
                &raw,
                &[
                    "Coupon Observation",
                    "KO Observation",
                    "Barrier Observation",
                    "Final Fixing",
                    "Settlement",
                ],
            )
        })
    }
}

/// `executionEvents(path)` from `executionContexts.ts`, verbatim.
///
/// Classification priority is **final → KO → coupon → barrier**, so a final
/// observation that also knocked out is `Final Fixing`, not `KO Observation`.
#[must_use]
pub fn execution_events(path: &SimulationPath) -> Vec<ExecutionEvent> {
    path.dates
        .iter()
        .enumerate()
        .map(|(index, date)| {
            let obs = &path.observations[index];
            let final_row = index == path.dates.len() - 1;
            let kind = if final_row {
                ExecutionEventType::FinalFixing
            } else if obs.knock_out_at_date {
                ExecutionEventType::KoObservation
            } else if obs.coupon_accrued > 0.0 {
                ExecutionEventType::CouponObservation
            } else {
                ExecutionEventType::BarrierObservation
            };
            ExecutionEvent {
                index,
                date: date.clone(),
                kind,
                worst_of: js_to_fixed_f64(path.worst_of_performance[index] * 100.0, 1),
                coupon: obs.coupon_accrued > 0.0,
                ki: obs.knock_in_at_date,
                ko: obs.knock_out_at_date,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::path_generator::{generate_paths, SimulationConfig};

    fn demo_path(index: usize) -> SimulationPath {
        let mut bundle = generate_paths(SimulationConfig::demo(), |_| {}).expect("demo valid");
        bundle.paths.remove(index)
    }

    /// Length equals `dates`, indices are sequential, and the demo path 0
    /// (a knocked-out path) produces the expected classification sequence: 13
    /// coupon observations, then KO, then barrier observations until the final
    /// fixing.
    #[test]
    fn demo_path_event_classes_match_the_typescript_source() {
        let path = demo_path(0);
        let events = execution_events(&path);
        assert_eq!(events.len(), path.dates.len());

        // The TypeScript classifies final-first, KO, coupon, barrier.
        for (i, e) in events.iter().enumerate() {
            let obs = &path.observations[i];
            let final_row = i == path.dates.len() - 1;
            let expected = if final_row {
                ExecutionEventType::FinalFixing
            } else if obs.knock_out_at_date {
                ExecutionEventType::KoObservation
            } else if obs.coupon_accrued > 0.0 {
                ExecutionEventType::CouponObservation
            } else {
                ExecutionEventType::BarrierObservation
            };
            assert_eq!(e.kind, expected, "row {i}");
            assert_eq!(e.index, i);
            assert_eq!(e.date, path.dates[i]);
            assert_eq!(e.coupon, obs.coupon_accrued > 0.0);
            assert_eq!(e.ki, obs.knock_in_at_date);
            assert_eq!(e.ko, obs.knock_out_at_date);
        }

        // The demo path 0 specifics: 13 accrued coupons, knocked out at index 13.
        assert_eq!(events[12].kind, ExecutionEventType::CouponObservation);
        assert_eq!(events[13].kind, ExecutionEventType::KoObservation);
        assert_eq!(events[14].kind, ExecutionEventType::BarrierObservation);
        assert_eq!(events[59].kind, ExecutionEventType::FinalFixing);
    }

    /// `worstOf` is `+(worst * 100).toFixed(1)` — a 1-decimal percentage that
    /// must agree with `js_to_fixed_f64` (the round-family would fail on ties).
    #[test]
    fn worst_of_is_the_to_fixed_percentage() {
        let path = demo_path(0);
        for (i, e) in execution_events(&path).iter().enumerate() {
            assert_eq!(
                e.worst_of,
                js_to_fixed_f64(path.worst_of_performance[i] * 100.0, 1),
                "row {i}"
            );
        }
    }

    /// `'Settlement'` exists in the union but `executionEvents` never emits it —
    /// pins that the label and serde spelling stay available on the type.
    #[test]
    fn settlement_label_is_available_but_never_emitted() {
        assert_eq!(ExecutionEventType::Settlement.label(), "Settlement");
        assert_eq!(
            serde_json::to_string(&ExecutionEventType::Settlement).unwrap(),
            "\"Settlement\""
        );
        for e in execution_events(&demo_path(0)) {
            assert_ne!(e.kind, ExecutionEventType::Settlement);
        }
    }

    /// Round-trips, so the adapters can trust the wire shape.
    #[test]
    fn execution_events_round_trip_through_json() {
        let events = execution_events(&demo_path(0));
        let json = serde_json::to_string(&events).unwrap();
        assert_eq!(
            serde_json::from_str::<Vec<ExecutionEvent>>(&json).unwrap(),
            events
        );
    }
}
