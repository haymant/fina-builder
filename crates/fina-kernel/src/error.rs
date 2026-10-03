//! Error type shared by every transport adapter.
//!
//! # Stable codes are a public contract
//!
//! [`FinaError::code`] strings are consumed by the HTTP adapter (to pick a
//! status code) and, in Phase 2, by the MCP adapter (to pick a JSON-RPC error
//! code). The wire shape is `{ "code": "...", "message": "..." }` and is
//! identical across Tauri, HTTP and CLI.
//!
//! Renaming a code string is a **breaking change** for the frontend bridge and
//! for any external consumer of the HTTP API.

use serde::{Deserialize, Serialize};

/// Convenient result alias for kernel operations.
pub type Result<T> = std::result::Result<T, FinaError>;

/// Every failure mode the domain kernel can report.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FinaError {
    /// Barrier or schedule configuration is internally inconsistent.
    ///
    /// Raised by `generate_paths` before any work starts, e.g. a knock-in
    /// barrier at or above the knock-out barrier, a zero path count, or a
    /// non-positive notional.
    #[error("invalid barrier configuration: {0}")]
    InvalidBarriers(String),

    /// A market snapshot is missing data the computation requires.
    ///
    /// Raised by `compute_risk` when `fx_pairs` is empty, `underlyings` is
    /// empty, or `correlations` is not a square matrix matching `underlyings`.
    #[error("invalid market state: {0}")]
    InvalidMarket(String),

    /// A requested path index does not exist in the generated bundle.
    #[error("path index {index} out of range (bundle has {len})")]
    PathOutOfRange {
        /// The index that was asked for.
        index: usize,
        /// How many paths the bundle actually contains.
        len: usize,
    },

    /// A payoff-graph node id was not recognised.
    #[error("unknown node id: {0}")]
    UnknownNode(String),

    /// Path generation failed part-way through.
    ///
    /// Reserved for invariant violations detected after the per-path
    /// consistency checks. The TypeScript original only logged
    /// `console.warn` here; the kernel reports an error instead.
    #[error("path generation failed: {0}")]
    Generation(String),

    /// An adapter could not deserialise an incoming request.
    #[error("invalid request: {0}")]
    InvalidRequest(String),
}

impl FinaError {
    /// Returns the stable machine-readable code for this error.
    ///
    /// | code | HTTP status | JSON-RPC (Phase 2) |
    /// | --- | --- | --- |
    /// | `INVALID_BARRIERS` | 400 | -32602 |
    /// | `INVALID_MARKET` | 400 | -32602 |
    /// | `INVALID_REQUEST` | 400 | -32700 |
    /// | `PATH_OUT_OF_RANGE` | 404 | -32602 |
    /// | `UNKNOWN_NODE` | 400 | -32602 |
    /// | `GENERATION` | 500 | -32603 |
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidBarriers(_) => "INVALID_BARRIERS",
            Self::InvalidMarket(_) => "INVALID_MARKET",
            Self::InvalidRequest(_) => "INVALID_REQUEST",
            Self::PathOutOfRange { .. } => "PATH_OUT_OF_RANGE",
            Self::UnknownNode(_) => "UNKNOWN_NODE",
            Self::Generation(_) => "GENERATION",
        }
    }

    /// Returns the HTTP status code the adapter should use.
    ///
    /// The single source of truth for the mapping table above. The adapter
    /// tests assert each row.
    #[must_use]
    pub fn http_status(&self) -> u16 {
        match self {
            Self::InvalidBarriers(_)
            | Self::InvalidMarket(_)
            | Self::UnknownNode(_)
            | Self::InvalidRequest(_) => 400,
            Self::PathOutOfRange { .. } => 404,
            Self::Generation(_) => 500,
        }
    }
}

/// Wire representation of an error. Identical for every transport.
///
/// Serialized as `{"code":"PATH_OUT_OF_RANGE","message":"..."}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireError {
    /// Stable machine-readable code, see [`FinaError::code`].
    pub code: String,
    /// Human-readable message.
    pub message: String,
}

impl From<&FinaError> for WireError {
    fn from(e: &FinaError) -> Self {
        Self {
            code: e.code().to_string(),
            message: e.to_string(),
        }
    }
}

impl From<FinaError> for WireError {
    fn from(e: FinaError) -> Self {
        Self::from(&e)
    }
}

impl Serialize for FinaErrorWire {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        WireError::from(&self.0).serialize(s)
    }
}

/// Newtype used when a [`FinaError`] must be serialized directly.
///
/// Tauri's `#[tauri::command]` requires `Serialize` on the error type. Wrapping
/// avoids making the whole enum untagged and keeps the wire shape explicit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinaErrorWire(pub FinaError);

impl From<FinaError> for FinaErrorWire {
    fn from(e: FinaError) -> Self {
        Self(e)
    }
}

impl From<serde_json::Error> for FinaError {
    /// Request deserialisation failure, reported as `INVALID_REQUEST` so every
    /// transport maps it to the same 400-class status regardless of which
    /// library the adapter uses to read the body.
    fn from(e: serde_json::Error) -> Self {
        Self::InvalidRequest(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable() {
        assert_eq!(
            FinaError::InvalidBarriers("x".into()).code(),
            "INVALID_BARRIERS"
        );
        assert_eq!(
            FinaError::InvalidMarket("x".into()).code(),
            "INVALID_MARKET"
        );
        assert_eq!(
            FinaError::InvalidRequest("x".into()).code(),
            "INVALID_REQUEST"
        );
        assert_eq!(
            FinaError::PathOutOfRange { index: 5, len: 3 }.code(),
            "PATH_OUT_OF_RANGE"
        );
        assert_eq!(FinaError::UnknownNode("x".into()).code(), "UNKNOWN_NODE");
        assert_eq!(FinaError::Generation("x".into()).code(), "GENERATION");
    }

    #[test]
    fn http_status_mapping_matches_documented_table() {
        assert_eq!(FinaError::InvalidBarriers("x".into()).http_status(), 400);
        assert_eq!(FinaError::InvalidMarket("x".into()).http_status(), 400);
        assert_eq!(FinaError::UnknownNode("x".into()).http_status(), 400);
        assert_eq!(FinaError::InvalidRequest("x".into()).http_status(), 400);
        assert_eq!(
            FinaError::PathOutOfRange { index: 9, len: 3 }.http_status(),
            404
        );
        assert_eq!(FinaError::Generation("x".into()).http_status(), 500);
    }

    #[test]
    fn wire_error_serializes_as_camel_case_object() {
        let e = FinaError::PathOutOfRange {
            index: 500,
            len: 100,
        };
        let json = serde_json::to_string(&WireError::from(&e)).unwrap();
        assert_eq!(
            json,
            r#"{"code":"PATH_OUT_OF_RANGE","message":"path index 500 out of range (bundle has 100)"}"#
        );
    }

    #[test]
    fn wire_error_round_trips() {
        let e = FinaError::InvalidBarriers("ki >= ko".into());
        let w = WireError::from(&e);
        let back: WireError = serde_json::from_str(&serde_json::to_string(&w).unwrap()).unwrap();
        assert_eq!(back, w);
    }

    #[test]
    fn error_messages_are_descriptive() {
        let e = FinaError::PathOutOfRange {
            index: 500,
            len: 100,
        };
        assert!(e.to_string().contains("500"));
        assert!(e.to_string().contains("100"));
    }

    #[test]
    fn wire_newtype_serializes_to_the_same_shape() {
        let e = FinaError::UnknownNode("Nope".into());
        let direct = serde_json::to_string(&WireError::from(&e)).unwrap();
        let wrapped = serde_json::to_string(&FinaErrorWire(e)).unwrap();
        assert_eq!(direct, wrapped);
    }
}
