//! Progress reporting for long-running kernel operations.
//!
//! # Why callbacks, not channels
//!
//! The kernel exposes progress as a plain `impl FnMut(ProgressEvent)` callback
//! rather than a `tokio` channel or a `tauri::ipc::Channel`. That keeps the
//! crate free of any async runtime (see the dependency allowlist in
//! `Cargo.toml`) and makes progress observable in a synchronous `#[test]` with
//! no runtime at all.
//!
//! Each adapter bridges the callback to its own transport:
//!
//! - Tauri: `on_event.send(evt)` on a `tauri::ipc::Channel<ProgressEvent>`
//! - HTTP: one SSE `data:` frame per event
//! - CLI: one NDJSON line per event, on **stderr**
//!
//! # Contract
//!
//! An implementation must emit events whose `completed` count is monotonically
//! non-decreasing and whose final `completed` equals the operation's total.

use serde::{Deserialize, Serialize};

/// A single progress notification from a kernel operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    /// Coarse stage name, e.g. `"assign_scenarios"`, `"generate_series"`.
    pub phase: String,
    /// Units of work finished so far. Monotonically non-decreasing.
    pub completed: u32,
    /// Total units of work, when known.
    pub total: u32,
    /// Optional human-readable detail.
    pub message: String,
}

impl ProgressEvent {
    /// Builds an event.
    #[must_use]
    pub fn new(
        phase: impl Into<String>,
        completed: u32,
        total: u32,
        message: impl Into<String>,
    ) -> Self {
        Self {
            phase: phase.into(),
            completed,
            total,
            message: message.into(),
        }
    }

    /// Completion ratio in `0.0..=1.0`, or `0.0` when `total` is zero.
    #[must_use]
    pub fn ratio(&self) -> f64 {
        if self.total == 0 {
            0.0
        } else {
            f64::from(self.completed) / f64::from(self.total)
        }
    }
}

/// A reusable progress sink that records every event.
///
/// Useful in tests and for the CLI, which prints events as it receives them.
#[derive(Debug, Default, Clone)]
pub struct ProgressLog {
    events: Vec<ProgressEvent>,
}

impl ProgressLog {
    /// Creates an empty log.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Records an event. Use as a callback: `progress.log`.
    pub fn record(&mut self, event: ProgressEvent) {
        self.events.push(event);
    }

    /// Borrows all recorded events.
    #[must_use]
    pub fn events(&self) -> &[ProgressEvent] {
        &self.events
    }

    /// Takes ownership of the recorded events.
    #[must_use]
    pub fn into_events(self) -> Vec<ProgressEvent> {
        self.events
    }

    /// Number of events recorded.
    #[must_use]
    pub fn len(&self) -> usize {
        self.events.len()
    }

    /// Whether any event was recorded.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// Checks the monotonicity / completion contract described on [`ProgressEvent`].
    ///
    /// Returns `false` if `completed` ever decreases, or if the last event does
    /// not report full completion. An empty log is vacuously valid.
    #[must_use]
    pub fn is_well_formed(&self) -> bool {
        let mut prev = 0u32;
        for e in &self.events {
            if e.completed < prev {
                return false;
            }
            prev = e.completed;
        }
        match self.events.last() {
            None => true,
            Some(last) => last.total == 0 || last.completed == last.total,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_camel_case() {
        let e = ProgressEvent::new("generate_series", 3, 100, "working");
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains(r#""completed":3"#), "{json}");
        assert!(json.contains(r#""total":100"#), "{json}");
        assert!(!json.contains("completed_count"), "{json}");
    }

    #[test]
    fn deserializes_from_camel_case() {
        let e: ProgressEvent =
            serde_json::from_str(r#"{"phase":"p","completed":1,"total":2,"message":"m"}"#).unwrap();
        assert_eq!(e.completed, 1);
        assert_eq!(e.total, 2);
    }

    #[test]
    fn ratio_handles_zero_total() {
        assert_eq!(ProgressEvent::new("p", 0, 0, "").ratio(), 0.0);
        assert_eq!(ProgressEvent::new("p", 50, 100, "").ratio(), 0.5);
        assert_eq!(ProgressEvent::new("p", 100, 100, "").ratio(), 1.0);
    }

    #[test]
    fn log_records_and_reports_length() {
        let mut log = ProgressLog::new();
        assert!(log.is_empty());
        log.record(ProgressEvent::new("a", 1, 2, ""));
        log.record(ProgressEvent::new("a", 2, 2, ""));
        assert_eq!(log.len(), 2);
        assert!(!log.is_empty());
        assert_eq!(log.events()[0].completed, 1);
        assert!(log.is_well_formed());
    }

    #[test]
    fn well_formed_rejects_decreasing_counts() {
        let mut log = ProgressLog::new();
        log.record(ProgressEvent::new("a", 5, 10, ""));
        log.record(ProgressEvent::new("a", 3, 10, ""));
        assert!(!log.is_well_formed());
    }

    #[test]
    fn well_formed_rejects_incomplete_final_event() {
        let mut log = ProgressLog::new();
        log.record(ProgressEvent::new("a", 3, 10, ""));
        assert!(!log.is_well_formed());
    }

    #[test]
    fn empty_log_is_vacuously_well_formed() {
        assert!(ProgressLog::new().is_well_formed());
    }

    #[test]
    fn into_events_consumes() {
        let mut log = ProgressLog::new();
        log.record(ProgressEvent::new("a", 1, 1, "done"));
        assert_eq!(log.into_events().len(), 1);
    }
}
