use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const API_VERSION: u16 = 1;
pub const DOMAIN_SCHEMA_VERSION: u32 = 1;
pub const SERVICE_NAME: &str = "nip-engine";

/// Closed error codes returned across future NIP transports. Messages are safe
/// summaries; implementation details belong in local diagnostics, not API data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidRequest,
    InvalidConfiguration,
    StorageUnavailable,
    ProviderUnavailable,
    UnsupportedOperation,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiError {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorEnvelope {
    pub error: ApiError,
}

/// Time concepts are intentionally distinct: source publication and update
/// dates are optional source claims; capture and commit times are system facts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventTimes {
    pub published_at: Option<DateTime<Utc>>,
    pub source_updated_at: Option<DateTime<Utc>>,
    pub captured_at: DateTime<Utc>,
    pub ingested_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct SourceId(String);

impl SourceId {
    pub fn new(value: impl Into<String>) -> Result<Self, ApiError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(ApiError {
                code: ErrorCode::InvalidRequest,
                message: "source_id must not be empty".into(),
            });
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for SourceId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(|error| serde::de::Error::custom(error.message))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct EventId(String);

impl EventId {
    pub fn new(value: impl Into<String>) -> Result<Self, ApiError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(ApiError {
                code: ErrorCode::InvalidRequest,
                message: "event_id must not be empty".into(),
            });
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for EventId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(|error| serde::de::Error::custom(error.message))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceType {
    Podcast,
    LocalDocument,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RightsStatus {
    Unreviewed,
    Approved,
    Blocked,
    PurgeRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRecord {
    pub schema_version: u32,
    pub source_id: SourceId,
    pub source_type: SourceType,
    pub display_name: String,
    pub locator: Option<String>,
    pub rights_status: RightsStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventRecord {
    pub schema_version: u32,
    pub event_id: EventId,
    pub source_id: SourceId,
    pub source_native_id: Option<String>,
    pub canonical_url: Option<String>,
    pub content_hash: String,
    pub content_text: Option<String>,
    pub times: EventTimes,
    pub revision_of: Option<EventId>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IngestionRunStatus {
    Queued,
    Running,
    Succeeded,
    Partial,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IngestionRunRecord {
    pub run_id: String,
    pub source_id: Option<SourceId>,
    pub status: IngestionRunStatus,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub error_code: Option<String>,
    pub safe_error_message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Readiness {
    Ready,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthResponse {
    pub service: String,
    pub api_version: u16,
    pub readiness: Readiness,
    pub schema_version: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeatureCapabilities {
    pub duckdb_store: bool,
    pub podcast_rss_subscriptions: bool,
    pub local_audio_transcription: bool,
    pub claim_extraction: bool,
    pub parquet_export: bool,
    pub semantic_search: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilitiesResponse {
    pub service: String,
    pub service_version: String,
    pub api_version: u16,
    pub schema_version: u32,
    pub features: FeatureCapabilities,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_serialize_as_stable_snake_case_strings() {
        let envelope = ErrorEnvelope {
            error: ApiError {
                code: ErrorCode::StorageUnavailable,
                message: "NIP storage is unavailable".into(),
            },
        };
        let value = serde_json::to_value(envelope).unwrap();
        assert_eq!(value["error"]["code"], "storage_unavailable");
        assert_eq!(value["error"]["message"], "NIP storage is unavailable");
    }

    #[test]
    fn event_times_keep_publication_optional_and_distinct_from_ingestion() {
        let times = EventTimes {
            published_at: None,
            source_updated_at: None,
            captured_at: "2026-11-16T09:00:00Z".parse().unwrap(),
            ingested_at: "2026-11-16T09:00:02Z".parse().unwrap(),
        };
        let value = serde_json::to_value(&times).unwrap();
        assert!(value["published_at"].is_null());
        assert_eq!(value["captured_at"], "2026-11-16T09:00:00Z");
        assert_eq!(value["ingested_at"], "2026-11-16T09:00:02Z");
    }

    #[test]
    fn stable_ids_reject_empty_values_and_serialize_as_strings() {
        assert_eq!(
            SourceId::new("  ").unwrap_err().code,
            ErrorCode::InvalidRequest
        );
        assert!(serde_json::from_str::<EventId>("\" \"").is_err());
        let event_id = EventId::new("evt-1").unwrap();
        assert_eq!(serde_json::to_string(&event_id).unwrap(), "\"evt-1\"");
        assert_eq!(event_id.as_str(), "evt-1");
    }
}
