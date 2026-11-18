use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalEventImport {
    pub source_id: SourceId,
    pub source_display_name: String,
    pub source_native_id: Option<String>,
    pub canonical_url: Option<String>,
    pub title: Option<String>,
    pub content_text: String,
    pub published_at: Option<DateTime<Utc>>,
    pub source_updated_at: Option<DateTime<Utc>>,
    pub rights_statement: String,
    pub user_confirmed_rights: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventSearchQuery {
    pub text: Option<String>,
    pub source_id: Option<SourceId>,
    pub as_of: Option<DateTime<Utc>>,
    pub cursor: Option<String>,
    pub limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventSearchPage {
    pub events: Vec<EventRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NarrativeSignal {
    pub narrative_id: String,
    pub label: String,
    pub current_week_start: DateTime<Utc>,
    pub current_week_end: DateTime<Utc>,
    pub prior_week_start: DateTime<Utc>,
    pub prior_week_end: DateTime<Utc>,
    pub current_count: u32,
    pub prior_count: u32,
    pub mentions_per_day: f64,
    pub prior_mentions_per_day: f64,
    pub delta_mentions_per_day: f64,
    pub percent_change: Option<f64>,
    pub distinct_source_categories: u32,
    pub category_counts: BTreeMap<String, u32>,
    pub persistence_complete_weeks: u32,
    pub first_published_at: Option<DateTime<Utc>>,
    pub first_ingested_at: Option<DateTime<Utc>>,
    pub evidence_event_ids: Vec<String>,
    pub coverage: String,
    pub data_quality_flags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NarrativeSignalSnapshot {
    pub formula_version: String,
    pub source_category_taxonomy_version: String,
    pub derivation_run_id: String,
    pub as_of: DateTime<Utc>,
    pub current_week_start: DateTime<Utc>,
    pub current_week_end: DateTime<Utc>,
    pub coverage: String,
    pub signals: Vec<NarrativeSignal>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EtfMapping {
    pub mapping_id: String,
    pub narrative_id: String,
    pub ticker: String,
    pub rationale: String,
    pub evidence_event_ids: Vec<String>,
    pub author: String,
    pub reviewer: Option<String>,
    pub version: u32,
    pub effective_from: DateTime<Utc>,
    pub effective_to: Option<DateTime<Utc>>,
    pub known_at: DateTime<Utc>,
    pub review_status: String,
    pub ticker_status: String,
    pub market_data_coverage: String,
    pub mapping_validity: String,
    pub supersedes_mapping_id: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EditorialCandidate {
    pub candidate_id: String,
    pub title_angle: String,
    pub narrative_ids: Vec<String>,
    pub claim_ids: Vec<String>,
    pub evidence_event_ids: Vec<String>,
    pub rank: u32,
    pub component_values: BTreeMap<String, f64>,
    pub derivation_run_id: String,
    pub review_status: String,
    pub review_reason: Option<String>,
    pub reviewer: Option<String>,
    pub reviewed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaimEvidence {
    pub event_id: EventId,
    pub quote: Option<String>,
    pub start_offset: Option<u32>,
    pub end_offset: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaimRecord {
    pub claim_id: String,
    pub claim_text: String,
    pub speaker_or_author: Option<String>,
    pub confidence_millis: u16,
    pub extraction_run_id: String,
    pub provider: String,
    pub model: String,
    pub prompt_version: String,
    /// Local or remote RIGA provider boundary used for this derivation.
    #[serde(default)]
    pub provider_kind: Option<String>,
    /// Saved RIGA provider profile ID, omitted for a local model or a legacy
    /// one-off configuration.
    #[serde(default)]
    pub provider_profile_id: Option<String>,
    /// Reasoning setting resolved from the RIGA configuration at run time.
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    pub extracted_at: DateTime<Utc>,
    pub evidence: Vec<ClaimEvidence>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoProjectStatus {
    Draft,
    InReview,
    Ready,
    Rendering,
    Exported,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoReviewStatus {
    Draft,
    Candidate,
    InReview,
    Approved,
    Rejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoAnalysisMode {
    HumanAuthored,
    DeterministicCandidate,
    ModelAssisted,
    Mixed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoEpisodeStatus {
    Draft,
    InReview,
    Ready,
    Archived,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoShotStatus {
    Planned,
    Ready,
    Rendering,
    Blocked,
    Complete,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoProject {
    pub project_id: String,
    pub revision: u32,
    pub title: String,
    pub language: String,
    pub target_platform: String,
    pub target_duration_ms: Option<u64>,
    pub audience: Option<String>,
    pub style_profile: Option<String>,
    pub status: VideoProjectStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoEpisode {
    pub episode_id: String,
    pub project_id: String,
    pub revision: u32,
    pub title: Option<String>,
    pub as_of: Option<DateTime<Utc>>,
    pub disclosure: Option<String>,
    pub status: VideoEpisodeStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoEvidenceRef {
    pub evidence_kind: String,
    pub evidence_id: String,
    pub start_offset: Option<u32>,
    pub end_offset: Option<u32>,
    pub quote: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoNarrative {
    pub narrative_id: String,
    pub episode_id: String,
    pub revision: u32,
    pub summary: Option<String>,
    pub thesis: Option<String>,
    pub analysis_mode: VideoAnalysisMode,
    pub review_status: VideoReviewStatus,
    pub derivation_run_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoStoryboard {
    pub storyboard_id: String,
    pub narrative_id: String,
    pub revision: u32,
    pub schema_version: String,
    pub review_status: VideoReviewStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoScene {
    pub scene_id: String,
    pub storyboard_id: String,
    pub revision: u32,
    pub ordinal: u32,
    pub purpose: String,
    pub narration_text: Option<String>,
    pub visual_intent: Option<String>,
    pub duration_ms: Option<u64>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoShot {
    pub shot_id: String,
    pub scene_id: String,
    pub revision: u32,
    pub ordinal: u32,
    pub shot_type: String,
    pub duration_ms: u64,
    pub camera_motion: Option<String>,
    pub visual_prompt: Option<String>,
    pub status: VideoShotStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoAsset {
    pub asset_id: String,
    pub revision: u32,
    pub asset_kind: String,
    pub relative_path: Option<String>,
    pub mime_type: Option<String>,
    pub content_hash: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<u64>,
    pub provider: String,
    pub workflow_id: Option<String>,
    pub model: Option<String>,
    pub reproducibility: String,
    pub capability_state: String,
    pub license_state: String,
    pub job_id: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoWorkflow {
    pub workflow_id: String,
    pub revision: u32,
    pub capability: String,
    pub provider_adapter: String,
    pub schema_version: String,
    pub model_identity: Option<String>,
    pub parameters: serde_json::Value,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoJob {
    pub job_id: String,
    pub operation: String,
    pub status: String,
    pub input_revision: Option<u32>,
    pub progress_millis: u32,
    pub cancellation_requested: bool,
    pub resource_estimate: Option<serde_json::Value>,
    pub output_manifest: Option<serde_json::Value>,
    pub safe_error_message: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub finished_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoRenderManifest {
    pub renderer: String,
    pub renderer_revision: String,
    pub command: String,
    pub scene_id: String,
    pub scene_checksum: String,
    pub output_format: String,
    pub relative_path: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<u64>,
    pub fps: Option<u32>,
    pub deterministic: bool,
    pub capability_state: String,
    pub evidence_ids: Vec<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoVisualTemplate {
    EvidenceCard,
    QuoteCard,
    KineticText,
    ChartTransition,
    Caption,
    SceneTransition,
}

impl VideoVisualTemplate {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EvidenceCard => "evidence_card",
            Self::QuoteCard => "quote_card",
            Self::KineticText => "kinetic_text",
            Self::ChartTransition => "chart_transition",
            Self::Caption => "caption",
            Self::SceneTransition => "scene_transition",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "evidence_card" => Self::EvidenceCard,
            "quote_card" => Self::QuoteCard,
            "kinetic_text" => Self::KineticText,
            "chart_transition" => Self::ChartTransition,
            "caption" => Self::Caption,
            "scene_transition" => Self::SceneTransition,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoVisualSourceKind {
    Event,
    Claim,
    TranscriptSpan,
    SignalSnapshot,
}

impl VideoVisualSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::Claim => "claim",
            Self::TranscriptSpan => "transcript_span",
            Self::SignalSnapshot => "signal_snapshot",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "event" => Self::Event,
            "claim" => Self::Claim,
            "transcript_span" => Self::TranscriptSpan,
            "signal_snapshot" => Self::SignalSnapshot,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum VideoVisualPayload {
    EvidenceCard {
        title: String,
        body: String,
        disclosure: Option<String>,
    },
    QuoteCard {
        quote: String,
        speaker: Option<String>,
        source_label: Option<String>,
    },
    KineticText {
        text: String,
    },
    ChartTransition {
        title: String,
        x_axis_label: Option<String>,
        y_axis_label: Option<String>,
        points: Vec<VideoChartPoint>,
    },
    Caption {
        text: String,
    },
    SceneTransition {
        label: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VideoChartPoint {
    pub label: String,
    pub value_millis: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoVisualSource {
    pub source_kind: VideoVisualSourceKind,
    pub source_id: String,
    pub source_revision: Option<u32>,
    pub start_offset: Option<u32>,
    pub end_offset: Option<u32>,
    pub quote: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VideoVisualSpec {
    pub spec_id: String,
    pub revision: u32,
    pub schema_version: String,
    pub project_id: String,
    pub episode_id: String,
    pub scene_id: Option<String>,
    pub shot_id: Option<String>,
    pub template: VideoVisualTemplate,
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub payload: VideoVisualPayload,
    pub sources: Vec<VideoVisualSource>,
    pub deterministic: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoExportKind {
    Storyboard,
    ShotList,
    AssetRequirements,
    LinkZagScene,
    Timeline,
    MediaBundle,
}

impl VideoExportKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Storyboard => "storyboard",
            Self::ShotList => "shot_list",
            Self::AssetRequirements => "asset_requirements",
            Self::LinkZagScene => "linkzag_scene",
            Self::Timeline => "timeline",
            Self::MediaBundle => "media_bundle",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "storyboard" => Self::Storyboard,
            "shot_list" => Self::ShotList,
            "asset_requirements" => Self::AssetRequirements,
            "linkzag_scene" => Self::LinkZagScene,
            "timeline" => Self::Timeline,
            "media_bundle" => Self::MediaBundle,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoExportFile {
    pub relative_path: String,
    pub format: String,
    pub content_hash: Option<String>,
    pub byte_size: Option<u64>,
    pub mime_type: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VideoExportManifest {
    pub manifest_id: String,
    pub schema_version: String,
    pub project_id: String,
    pub project_revision: u32,
    pub episode_id: Option<String>,
    pub storyboard_id: Option<String>,
    pub export_kind: VideoExportKind,
    pub deterministic: bool,
    pub visual_spec_ids: Vec<String>,
    pub asset_ids: Vec<String>,
    pub files: Vec<VideoExportFile>,
    pub evidence: Vec<VideoEvidenceRef>,
    pub content_hash: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// Which side of the RIGA provider boundary produced a derivation. Remote
/// processing of transcript text requires NIP-specific consent; a local model
/// does not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Local,
    Remote,
}

/// Append-only consent event. The newest event for a provider binding decides
/// whether remote transcript extraction is currently allowed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderConsent {
    pub consent_id: String,
    pub action: String,
    pub provider_kind: String,
    pub provider_id: Option<String>,
    pub model: String,
    pub scope: String,
    pub disclosure: String,
    pub actor: String,
    pub reason: Option<String>,
    pub recorded_at: DateTime<Utc>,
}

/// Safe provider/consent view for the workspace. It never contains an endpoint
/// path, API key, or other credential material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderStatus {
    pub configured: bool,
    pub bridge_state: String,
    pub provider_kind: Option<String>,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub provider_api: Option<String>,
    /// `open_ai_compatible` or `opencode_open_ai_compatible`; the latter is
    /// served by the RIGA OpenCode adapter on loopback port 8791.
    pub provider_type: Option<String>,
    pub remote: bool,
    /// `granted`, `missing`, `revoked`, or `not_required`.
    pub consent: String,
    pub consent_recorded_at: Option<DateTime<Utc>>,
    pub disclosure: Option<String>,
    /// `available`, `consent_required`, or `unavailable`.
    pub extraction_state: String,
    pub warnings: Vec<String>,
}

/// Append-only editorial review audit row. The candidate row carries the latest
/// review state for convenience; corrections are retained here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditorialReviewAudit {
    pub review_id: String,
    pub candidate_id: String,
    pub review_status: String,
    pub review_reason: String,
    pub reviewer: String,
    pub reviewed_at: DateTime<Utc>,
    pub recorded_at: DateTime<Utc>,
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
pub enum PodcastSubscriptionState {
    Active,
    Paused,
    Removed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PodcastEpisodeState {
    AwaitingLocalTranscription,
    TranscriptionUnavailable,
    Transcribed,
    Failed,
}

/// A feed can only be persisted as an active subscription after the user has
/// explicitly confirmed the supplied rights/access statement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PodcastSubscription {
    pub source_id: SourceId,
    pub feed_url: String,
    pub show_name: String,
    pub rights_statement: String,
    pub rights_confirmed_at: DateTime<Utc>,
    pub state: PodcastSubscriptionState,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub last_checked_at: Option<DateTime<Utc>>,
    pub next_poll_at: Option<DateTime<Utc>>,
    pub last_error_code: Option<String>,
    pub consecutive_failures: u32,
}

/// RSS metadata only. This is not a transcript and does not imply that audio
/// was downloaded or transcribed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PodcastEpisode {
    pub source_id: SourceId,
    pub source_native_id: Option<String>,
    pub canonical_url: Option<String>,
    pub title: Option<String>,
    pub enclosure_url: Option<String>,
    pub published_at: Option<DateTime<Utc>>,
    pub discovered_at: DateTime<Utc>,
    pub state: PodcastEpisodeState,
    /// Publisher-provided transcript advertised by `<podcast:transcript>`.
    /// When present it is preferred over local ASR.
    #[serde(default)]
    pub transcript_url: Option<String>,
    #[serde(default)]
    pub transcript_type: Option<String>,
}

/// One stable page of discovered RSS metadata. `next_offset` is `None` when the
/// page reaches the end of the filtered result set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PodcastEpisodePage {
    pub episodes: Vec<PodcastEpisode>,
    pub total: u64,
    pub limit: u32,
    pub offset: u32,
    pub next_offset: Option<u32>,
}

/// A validated transcript is stored separately from RSS metadata and is only
/// created after an ASR provider returns a non-empty result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PodcastTranscript {
    pub source_id: SourceId,
    pub source_native_id: Option<String>,
    pub canonical_url: Option<String>,
    pub transcript_text: String,
    pub content_hash: String,
    pub detected_language: Option<String>,
    pub provenance_json: String,
    pub transcribed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PodcastRefreshReport {
    pub source_id: SourceId,
    pub not_modified: bool,
    pub discovered_count: u32,
    pub total_episode_count: u32,
    pub next_poll_at: DateTime<Utc>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EmbeddingIndexManifest {
    pub index_id: String,
    pub model_id: String,
    pub model_revision: String,
    pub dimensions: u32,
    pub chunking_version: String,
    pub collection_name: String,
    pub status: String,
    pub event_count: u32,
    pub created_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SemanticSearchResult {
    pub event: EventRecord,
    pub score: f32,
    pub index_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NarrativeClusterMember {
    pub event_id: EventId,
    pub similarity_millis: u16,
    pub rank: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NarrativeCluster {
    pub cluster_id: String,
    pub derivation_run_id: String,
    pub label: String,
    pub algorithm_version: String,
    pub member_count: u32,
    pub created_at: DateTime<Utc>,
    pub members: Vec<NarrativeClusterMember>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NarrativeGraphNode {
    pub node_id: String,
    pub node_type: String,
    pub label: String,
    pub evidence_event_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NarrativeGraphEdge {
    pub edge_id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    pub edge_type: String,
    pub evidence_event_ids: Vec<String>,
    pub confidence_millis: u16,
    pub derivation_run_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NarrativeGraph {
    pub graph_id: String,
    pub derivation_run_id: String,
    pub algorithm_version: String,
    pub created_at: DateTime<Utc>,
    pub nodes: Vec<NarrativeGraphNode>,
    pub edges: Vec<NarrativeGraphEdge>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResourceStatus {
    pub observed_at: DateTime<Utc>,
    pub database_path: String,
    pub database_bytes: u64,
    pub event_count: u32,
    pub claim_count: u32,
    pub extraction_run_count: u32,
    pub cluster_count: u32,
    pub graph_edge_count: u32,
    pub scheduler_interval_seconds: u64,
    pub scheduler_state: String,
    pub semantic_index_state: String,
    pub semantic_model: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractionStatus {
    pub observed_at: DateTime<Utc>,
    pub state: String,
    pub claim_count: u32,
    pub extraction_run_count: u32,
    pub latest_run_id: Option<String>,
    pub latest_provider: Option<String>,
    pub latest_model: Option<String>,
    pub latest_prompt_version: Option<String>,
    pub latest_extracted_at: Option<DateTime<Utc>>,
    pub evidence_linked_claim_count: u32,
    pub warnings: Vec<String>,
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

/// Registry kind for a source. This is deliberately independent of the fetch
/// adapter: a new adapter never needs a schema migration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    Podcast,
    CompanyMeeting,
    Filing,
    Reddit,
    X,
    Web,
    LocalDocument,
    Other,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Podcast => "podcast",
            Self::CompanyMeeting => "company_meeting",
            Self::Filing => "filing",
            Self::Reddit => "reddit",
            Self::X => "x",
            Self::Web => "web",
            Self::LocalDocument => "local_document",
            Self::Other => "other",
        }
    }

    /// Coarse class stored in `nip_sources.source_type` for event queries.
    pub fn coarse_type(self) -> &'static str {
        match self {
            Self::Podcast => "podcast",
            Self::LocalDocument => "local_document",
            _ => "other",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "podcast" => Self::Podcast,
            "company_meeting" => Self::CompanyMeeting,
            "filing" => Self::Filing,
            "reddit" => Self::Reddit,
            "x" => Self::X,
            "web" => Self::Web,
            "local_document" => Self::LocalDocument,
            "other" => Self::Other,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceState {
    Active,
    Paused,
    Removed,
}

impl SourceState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Removed => "removed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "active" | "resume" => Self::Active,
            "paused" | "pause" => Self::Paused,
            "removed" | "remove" => Self::Removed,
            _ => return None,
        })
    }
}

/// A source as the registry sees it, independent of whether an adapter exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NarrativeSource {
    pub source_id: SourceId,
    pub kind: SourceKind,
    pub display_name: String,
    pub locator: Option<String>,
    pub rights_status: String,
    pub rights_statement: Option<String>,
    pub topics: Vec<String>,
    pub state: SourceState,
    pub poll_interval_minutes: u32,
    pub per_scan_limit: u32,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub event_count: u64,
    pub episode_count: u64,
}

/// Explicit, partial update. `None` means "leave unchanged".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceUpdate {
    pub display_name: Option<String>,
    pub locator: Option<String>,
    pub rights_statement: Option<String>,
    pub topics: Option<Vec<String>>,
    pub poll_interval_minutes: Option<u32>,
    pub per_scan_limit: Option<u32>,
    pub notes: Option<String>,
}
