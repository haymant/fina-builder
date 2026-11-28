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
    /// Mirrored from the producer at import time (fina-scraper lake row);
    /// fina-builder never re-derives this. `None` for legacy imports that
    /// predate tier labelling.
    #[serde(default)]
    pub extraction_tier: Option<ExtractionTier>,
    /// Mirrored from the producer at import time; `None` for legacy imports.
    #[serde(default)]
    pub review_status: Option<ClaimReviewStatus>,
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
    /// Mirror of the producer's extraction tier for this event, when the
    /// caller supplies one (fina-scraper `export_narrative_for_fina` /
    /// lake item row). fina-builder stores it; it does not re-run NLP.
    #[serde(default)]
    pub extraction_tier: Option<ExtractionTier>,
    /// Mirror of the producer's review status for this event, when supplied.
    #[serde(default)]
    pub review_status: Option<ClaimReviewStatus>,
}

/// Versioned result envelope returned by the embedded acquisition worker.
/// This is a transport contract, not a second persisted catalog: NIP validates
/// the source binding and remains responsible for committing accepted records.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcquisitionBatch {
    pub contract_version: u32,
    pub producer: AcquisitionProducer,
    pub run_id: String,
    pub started_at: DateTime<Utc>,
    pub completed_at: DateTime<Utc>,
    pub items: Vec<AcquisitionItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcquisitionProducer {
    pub name: String,
    pub version: String,
}

/// A worker output item is bound to a NIP source ID by the NIP orchestrator;
/// `worker_source_key` is retained only as producer provenance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcquisitionItem {
    pub source_id: SourceId,
    pub worker_source_key: String,
    pub worker_item_id: String,
    pub source_url: String,
    pub title: String,
    pub content_kind: AcquisitionContentKind,
    pub content_text: String,
    pub content_hash: String,
    pub published_at: Option<DateTime<Utc>>,
    pub ingested_at: DateTime<Utc>,
    pub valid_from: DateTime<Utc>,
    pub valid_to: Option<DateTime<Utc>>,
    pub availability: AcquisitionAvailability,
    pub transcript: Option<AcquisitionTranscript>,
    pub claims: Vec<AcquisitionClaim>,
    pub entities: Vec<AcquisitionEntity>,
    /// Values refer to NIP-registered feature keys. The worker cannot register
    /// or redefine a feature through an ingestion result.
    pub features: Vec<AcquisitionFeatureValue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcquisitionContentKind {
    Article,
    Transcript,
    Filing,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcquisitionAvailability {
    Live,
    Reconstructed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcquisitionTranscript {
    pub transcript_text: String,
    pub content_hash: String,
    pub language: Option<String>,
    pub method: String,
    pub model: Option<String>,
    pub model_version: Option<String>,
    pub transcribed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcquisitionClaim {
    pub worker_claim_id: String,
    pub subject: String,
    pub predicate: String,
    pub object: String,
    pub confidence_millis: u16,
    pub review_status: ClaimReviewStatus,
    pub extraction: AcquisitionExtractionProvenance,
    pub evidence: AcquisitionEvidenceSpan,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcquisitionEntity {
    pub worker_entity_id: String,
    pub canonical_id: String,
    pub name: String,
    pub entity_type: String,
    pub ticker: Option<String>,
    pub extraction: AcquisitionExtractionProvenance,
    pub evidence: Vec<AcquisitionEvidenceSpan>,
}

/// Offsets count Unicode scalar values (the same convention used by NIP's
/// retained-transcript quote validator), not UTF-8 bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcquisitionEvidenceSpan {
    pub payload: AcquisitionEvidencePayload,
    pub quote: String,
    pub start_offset: u32,
    pub end_offset: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcquisitionEvidencePayload {
    ItemContent,
    Transcript,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcquisitionExtractionProvenance {
    pub tier: ExtractionTier,
    pub model: String,
    pub model_version: String,
    pub prompt_version: Option<String>,
    pub confidence_millis: Option<u16>,
    pub extracted_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AcquisitionFeatureValue {
    pub feature_key: String,
    pub value: serde_json::Value,
    pub as_of: DateTime<Utc>,
    pub valid_from: DateTime<Utc>,
    pub valid_to: Option<DateTime<Utc>>,
    pub availability: AcquisitionAvailability,
    pub extraction: AcquisitionExtractionProvenance,
}

impl AcquisitionBatch {
    /// Validate structure and exact evidence before NIP hands a batch to its
    /// persistence layer. Source existence, hashes, rights, and feature-key
    /// registration are store-level checks and must not be inferred here.
    pub fn validate(&self) -> Result<(), String> {
        if self.contract_version != 1 {
            return Err(format!(
                "unsupported acquisition contract version {}",
                self.contract_version
            ));
        }
        if self.producer.name.trim().is_empty() || self.producer.version.trim().is_empty() {
            return Err("producer name and version are required".into());
        }
        if self.run_id.trim().is_empty() {
            return Err("run_id is required".into());
        }
        if self.completed_at < self.started_at {
            return Err("completed_at must not precede started_at".into());
        }
        if self.items.is_empty() {
            return Err("an acquisition batch must contain at least one item".into());
        }

        let mut item_ids = std::collections::HashSet::new();
        for item in &self.items {
            if item.worker_source_key.trim().is_empty()
                || item.worker_item_id.trim().is_empty()
                || item.source_url.trim().is_empty()
                || item.title.trim().is_empty()
                || item.content_text.trim().is_empty()
                || item.content_hash.trim().is_empty()
            {
                return Err(
                    "item source key, worker item ID, URL, title, content, and hash are required"
                        .into(),
                );
            }
            if !item_ids.insert((
                item.source_id.as_str(),
                item.worker_source_key.as_str(),
                item.worker_item_id.as_str(),
            )) {
                return Err(format!(
                    "duplicate worker item {} for source {}",
                    item.worker_item_id,
                    item.source_id.as_str()
                ));
            }
            if item
                .valid_to
                .as_ref()
                .is_some_and(|end| end <= &item.valid_from)
            {
                return Err(format!(
                    "item {} has an invalid validity interval",
                    item.worker_item_id
                ));
            }
            if let Some(transcript) = &item.transcript {
                if transcript.transcript_text.trim().is_empty()
                    || transcript.content_hash.trim().is_empty()
                    || transcript.method.trim().is_empty()
                {
                    return Err(format!(
                        "item {} has an incomplete transcript record",
                        item.worker_item_id
                    ));
                }
            }

            let mut claim_ids = std::collections::HashSet::new();
            for claim in &item.claims {
                if claim.worker_claim_id.trim().is_empty()
                    || claim.subject.trim().is_empty()
                    || claim.predicate.trim().is_empty()
                    || claim.object.trim().is_empty()
                    || claim.confidence_millis > 1000
                {
                    return Err(format!("item {} has an invalid claim", item.worker_item_id));
                }
                if !claim_ids.insert(claim.worker_claim_id.as_str()) {
                    return Err(format!(
                        "item {} has duplicate claim ID {}",
                        item.worker_item_id, claim.worker_claim_id
                    ));
                }
                validate_acquisition_provenance(&claim.extraction)?;
                validate_acquisition_span(item, &claim.evidence)?;
            }

            let mut entity_ids = std::collections::HashSet::new();
            for entity in &item.entities {
                if entity.worker_entity_id.trim().is_empty()
                    || entity.canonical_id.trim().is_empty()
                    || entity.name.trim().is_empty()
                    || entity.entity_type.trim().is_empty()
                {
                    return Err(format!(
                        "item {} has an invalid entity",
                        item.worker_item_id
                    ));
                }
                if !entity_ids.insert(entity.worker_entity_id.as_str()) {
                    return Err(format!(
                        "item {} has duplicate entity ID {}",
                        item.worker_item_id, entity.worker_entity_id
                    ));
                }
                if entity.evidence.is_empty() {
                    return Err(format!(
                        "entity {} must include evidence",
                        entity.worker_entity_id
                    ));
                }
                validate_acquisition_provenance(&entity.extraction)?;
                for span in &entity.evidence {
                    validate_acquisition_span(item, span)?;
                }
            }

            let mut feature_keys = std::collections::HashSet::new();
            for feature in &item.features {
                if feature.feature_key.trim().is_empty() || feature.value.is_null() {
                    return Err(format!(
                        "item {} has an invalid feature value",
                        item.worker_item_id
                    ));
                }
                if !feature_keys.insert(feature.feature_key.as_str()) {
                    return Err(format!(
                        "item {} has duplicate feature key {}",
                        item.worker_item_id, feature.feature_key
                    ));
                }
                if feature
                    .valid_to
                    .as_ref()
                    .is_some_and(|end| end <= &feature.valid_from)
                {
                    return Err(format!(
                        "item {} feature {} has an invalid validity interval",
                        item.worker_item_id, feature.feature_key
                    ));
                }
                validate_acquisition_provenance(&feature.extraction)?;
            }
        }
        Ok(())
    }
}

fn validate_acquisition_provenance(
    provenance: &AcquisitionExtractionProvenance,
) -> Result<(), String> {
    if provenance.model.trim().is_empty()
        || provenance.model_version.trim().is_empty()
        || provenance
            .confidence_millis
            .is_some_and(|confidence| confidence > 1000)
    {
        return Err("extraction model/version and a valid optional confidence are required".into());
    }
    Ok(())
}

fn validate_acquisition_span(
    item: &AcquisitionItem,
    span: &AcquisitionEvidenceSpan,
) -> Result<(), String> {
    let content = match span.payload {
        AcquisitionEvidencePayload::ItemContent => item.content_text.as_str(),
        AcquisitionEvidencePayload::Transcript => item
            .transcript
            .as_ref()
            .map(|transcript| transcript.transcript_text.as_str())
            .ok_or_else(|| {
                format!(
                    "item {} evidence references a missing transcript",
                    item.worker_item_id
                )
            })?,
    };
    if span.quote.trim().is_empty() || span.start_offset >= span.end_offset {
        return Err(format!(
            "item {} has an empty or reversed evidence span",
            item.worker_item_id
        ));
    }
    let chars: Vec<char> = content.chars().collect();
    let (start, end) = (span.start_offset as usize, span.end_offset as usize);
    if end > chars.len() || chars[start..end].iter().collect::<String>() != span.quote {
        return Err(format!(
            "item {} evidence span does not exactly match its referenced payload",
            item.worker_item_id
        ));
    }
    Ok(())
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

/// What evidence a thesis stands on. A `provisional_fast_glance` thesis is
/// listed and badged but can never advance past `llm_reviewed` — the gate
/// lives in the store (`ThesisBasis::allows_status`), not just the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThesisBasis {
    LlmVerifiedOnly,
    ProvisionalFastGlance,
}

impl ThesisBasis {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LlmVerifiedOnly => "llm_verified_only",
            Self::ProvisionalFastGlance => "provisional_fast_glance",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "llm_verified_only" => Self::LlmVerifiedOnly,
            "provisional_fast_glance" => Self::ProvisionalFastGlance,
            _ => return None,
        })
    }

    /// Whether a thesis on this basis may enter `status`. Provisional
    /// theses may be drafted, LLM-reviewed, rejected, or invalidated — and
    /// nothing further. This is the data-level gate from revamp §c.5.
    pub fn allows_status(self, status: ThesisStatus) -> bool {
        match self {
            Self::LlmVerifiedOnly => true,
            Self::ProvisionalFastGlance => matches!(
                status,
                ThesisStatus::Draft
                    | ThesisStatus::LlmReviewed
                    | ThesisStatus::Rejected
                    | ThesisStatus::Invalidated
            ),
        }
    }
}

/// Proposed direction of a thesis. A proposal, never a trade instruction.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThesisDirection {
    Long,
    Short,
    Neutral,
}

impl ThesisDirection {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Long => "long",
            Self::Short => "short",
            Self::Neutral => "neutral",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "long" => Self::Long,
            "short" => Self::Short,
            "neutral" => Self::Neutral,
            _ => return None,
        })
    }
}

/// Thesis pipeline (revamp §c.5). Terminal states are `published`,
/// `rejected`, and `invalidated`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ThesisStatus {
    Draft,
    LlmReviewed,
    Backtested,
    TranscriptReady,
    VideoReady,
    Published,
    Rejected,
    Invalidated,
}

impl ThesisStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::LlmReviewed => "llm_reviewed",
            Self::Backtested => "backtested",
            Self::TranscriptReady => "transcript_ready",
            Self::VideoReady => "video_ready",
            Self::Published => "published",
            Self::Rejected => "rejected",
            Self::Invalidated => "invalidated",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "draft" => Self::Draft,
            "llm_reviewed" => Self::LlmReviewed,
            "backtested" => Self::Backtested,
            "transcript_ready" => Self::TranscriptReady,
            "video_ready" => Self::VideoReady,
            "published" => Self::Published,
            "rejected" => Self::Rejected,
            "invalidated" => Self::Invalidated,
            _ => return None,
        })
    }

    /// Stages at or beyond the backtest gate. A provisional thesis may
    /// never enter one of these.
    pub fn is_beyond_backtest_gate(self) -> bool {
        matches!(
            self,
            Self::Backtested | Self::TranscriptReady | Self::VideoReady | Self::Published
        )
    }
}

/// A claim the analyst considered and rejected, kept as an audit trail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RejectedClaimRef {
    pub claim_id: String,
    pub reason: String,
}

/// An evidence- and backtest-based investment thesis (revamp §c.5).
/// The falsifiable statement, its direction/horizon/invalidation, the
/// claims it cites, and where it sits in the pipeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThesisRecord {
    pub thesis_id: String,
    pub title: String,
    /// Entity canonical id or ticker the thesis is about, when known.
    pub entity_symbol: Option<String>,
    pub direction: ThesisDirection,
    /// e.g. "1-3 days".
    pub horizon: Option<String>,
    /// The decision time; every feature/backtest read is point-in-time
    /// at this `as_of`.
    pub as_of: DateTime<Utc>,
    pub thesis_basis: ThesisBasis,
    pub confidence_millis: Option<u16>,
    pub reason: Option<String>,
    pub status: ThesisStatus,
    pub invalidation_condition: Option<String>,
    pub what_would_change_mind: Option<String>,
    /// Cited claims (thesis-grade only when basis is `llm_verified_only`).
    #[serde(default)]
    pub claim_ids: Vec<String>,
    /// Considered and rejected claims, with reasons — never hidden.
    #[serde(default)]
    pub rejected_claims: Vec<RejectedClaimRef>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// One evidence footnote inside a transcript beat.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranscriptEvidenceRef {
    /// `claim` | `item` | `backtest` | `event`.
    pub kind: String,
    #[serde(default)]
    pub claim_id: Option<String>,
    #[serde(default)]
    pub item_id: Option<String>,
    #[serde(default)]
    pub backtest_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub evidence_span: Option<String>,
}

/// One spoken beat of a commentary transcript, with its evidence refs.
/// Narration is the transcript's spoken text, not regenerated from claims.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscriptBeat {
    pub ordinal: u32,
    pub title: String,
    pub script: String,
    #[serde(default)]
    pub evidence_refs: Vec<TranscriptEvidenceRef>,
}

/// The `write_commentary_transcript` output, mirrored into fina-builder
/// (revamp §c.5/§d.2). A transcript for a provisional thesis does not
/// exist — the store refuses to record one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranscriptRecord {
    pub transcript_id: String,
    pub thesis_id: String,
    pub transcript_hash: String,
    pub summary: Option<String>,
    #[serde(default)]
    pub beats: Vec<TranscriptBeat>,
    /// Path of the fina-scraper fina-import JSON this mirrors, when known.
    pub fina_import_path: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// Ablation metrics for one backtest run. Every field is optional: missing
/// is null and shown as "—", never 0.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BacktestMetrics {
    #[serde(default)]
    pub ic: Option<f64>,
    #[serde(default)]
    pub icir: Option<f64>,
    #[serde(default)]
    pub sharpe: Option<f64>,
    #[serde(default)]
    pub total_return: Option<f64>,
    #[serde(default)]
    pub max_drawdown: Option<f64>,
    #[serde(default)]
    pub feature_importances: BTreeMap<String, f64>,
}

/// Out-of-sample delta Run A → Run B. This delta is the evidence.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BacktestDelta {
    #[serde(default)]
    pub ic: Option<f64>,
    #[serde(default)]
    pub icir: Option<f64>,
    #[serde(default)]
    pub sharpe: Option<f64>,
    #[serde(default)]
    pub total_return: Option<f64>,
    #[serde(default)]
    pub max_drawdown: Option<f64>,
}

/// Plain-language verdict on the ablation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BacktestVerdict {
    Supported,
    NotSupported,
    CouldNotRun,
}

impl BacktestVerdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Supported => "supported",
            Self::NotSupported => "not_supported",
            Self::CouldNotRun => "could_not_run",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "supported" => Self::Supported,
            "not_supported" => Self::NotSupported,
            "could_not_run" => Self::CouldNotRun,
            _ => return None,
        })
    }
}

/// A recorded ablation result: Run A (TA+macro) vs Run B (TA+macro+`$narr_*`
/// tier2_llm), same seed/universe/dates (revamp §c.5/§d.2). This is the
/// mirror of fina-scraper's `record_backtest_evidence` row — fina-builder
/// stores its own copy at record time, so the video UI never has to trust
/// an unattested claim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BacktestEvidenceRecord {
    pub backtest_id: String,
    pub thesis_id: String,
    pub run_id_a: String,
    pub run_id_b: String,
    pub config_fingerprint: Option<String>,
    pub metrics_a: BacktestMetrics,
    pub metrics_b: BacktestMetrics,
    pub delta: BacktestDelta,
    pub verdict: BacktestVerdict,
    /// Why the ablation could not run, when `verdict` is `could_not_run`.
    pub could_not_run_reason: Option<String>,
    pub recorded_at: DateTime<Utc>,
    /// e.g. `fina-builder:tac-qlib-rd`.
    pub source: String,
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
    /// Mirrored from the producer at record time (fina-scraper claim row);
    /// fina-builder never re-derives this. `None` for legacy claims that
    /// predate tier labelling — the UI must render those as unlabelled,
    /// never as verified.
    #[serde(default)]
    pub extraction_tier: Option<ExtractionTier>,
    /// Mirrored from the producer at record time; `None` for legacy claims.
    #[serde(default)]
    pub review_status: Option<ClaimReviewStatus>,
    pub evidence: Vec<ClaimEvidence>,
}

/// Extraction tier labels (fina-scraper `docs/EXTRACTION_TIERS.md` v1.6,
/// normative). fina-builder mirrors these strings verbatim at import/record
/// time; it never assigns a tier itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtractionTier {
    Tier0Lexicon,
    Tier1Onnx,
    Tier2Llm,
}

impl ExtractionTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Tier0Lexicon => "tier0_lexicon",
            Self::Tier1Onnx => "tier1_onnx",
            Self::Tier2Llm => "tier2_llm",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "tier0_lexicon" => Self::Tier0Lexicon,
            "tier1_onnx" => Self::Tier1Onnx,
            "tier2_llm" => Self::Tier2Llm,
            _ => return None,
        })
    }
}

/// Claim review status (fina-scraper `docs/EXTRACTION_TIERS.md` §2).
/// Mirrored, never re-derived. Only `llm_verified` / `llm_corrected`
/// `tier2_llm` rows are thesis-grade.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimReviewStatus {
    FastGlance,
    LlmVerified,
    LlmCorrected,
    LlmRejected,
    LlmDisputed,
}

impl ClaimReviewStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FastGlance => "fast_glance",
            Self::LlmVerified => "llm_verified",
            Self::LlmCorrected => "llm_corrected",
            Self::LlmRejected => "llm_rejected",
            Self::LlmDisputed => "llm_disputed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "fast_glance" => Self::FastGlance,
            "llm_verified" => Self::LlmVerified,
            "llm_corrected" => Self::LlmCorrected,
            "llm_rejected" => Self::LlmRejected,
            "llm_disputed" => Self::LlmDisputed,
            _ => return None,
        })
    }

    /// Thesis-grade statuses: the only review states a thesis may cite.
    pub fn is_thesis_grade(self) -> bool {
        matches!(self, Self::LlmVerified | Self::LlmCorrected)
    }
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
    /// Thesis-led narrative whose evidence is a recorded ablation
    /// (revamp §d.2).
    ThesisBacktest,
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoEpisodeOrigin {
    /// Started from a retained event; an explainer, never a thesis video.
    #[default]
    Event,
    /// Started from a thesis + transcript (revamp §d.1 step 0).
    Thesis,
}

impl VideoEpisodeOrigin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::Thesis => "thesis",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "event" => Self::Event,
            "thesis" => Self::Thesis,
            _ => return None,
        })
    }
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
    /// Thesis this episode was started from, when `origin` is `thesis`.
    #[serde(default)]
    pub thesis_id: Option<String>,
    /// Transcript this episode was started from, when `origin` is `thesis`.
    #[serde(default)]
    pub transcript_id: Option<String>,
    #[serde(default)]
    pub transcript_hash: Option<String>,
    /// What the episode is: a thesis video or an event explainer. The UI
    /// gates publish by this origin (revamp §d.1 step 7).
    #[serde(default)]
    pub origin: VideoEpisodeOrigin,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Evidence kinds a `VideoEvidenceRef` may carry. `backtest` refs must
/// resolve to a recorded backtest; `thesis` refs to a recorded thesis.
/// Anything else is rejected at the store boundary.
pub fn valid_video_evidence_kind(kind: &str) -> bool {
    matches!(kind, "event" | "claim" | "backtest" | "thesis")
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
    /// The real thesis text (from the transcript), not a disclaimer.
    pub thesis: Option<String>,
    pub analysis_mode: VideoAnalysisMode,
    pub review_status: VideoReviewStatus,
    pub derivation_run_id: Option<String>,
    /// Thesis this narrative states, when thesis-led.
    #[serde(default)]
    pub thesis_id: Option<String>,
    /// `llm_verified_only` for thesis videos; provisional is never valid here.
    #[serde(default)]
    pub thesis_basis: Option<ThesisBasis>,
    /// Decision time the narrative is point-in-time at.
    #[serde(default)]
    pub as_of: Option<DateTime<Utc>>,
    /// Recorded backtests cited by this narrative.
    #[serde(default)]
    pub backtest_ids: Vec<String>,
    #[serde(default)]
    pub transcript_hash: Option<String>,
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
    /// Thesis the storyboard was built from, when thesis-led.
    #[serde(default)]
    pub thesis_id: Option<String>,
    /// Recorded backtests cited by backtest slides.
    #[serde(default)]
    pub backtest_refs: Vec<String>,
    #[serde(default)]
    pub source_transcript_hash: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Persisted narration/audio production cue pinned to the exact production graph
/// and registered source asset. `scene_id` is absent for a whole-storyboard cue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoAudioCue {
    pub cue_id: String,
    pub revision: u32,
    pub project_id: String,
    pub project_revision: u32,
    pub episode_id: String,
    pub episode_revision: u32,
    pub storyboard_id: String,
    pub storyboard_revision: u32,
    pub scene_id: Option<String>,
    pub scene_revision: Option<u32>,
    pub asset_id: String,
    pub asset_revision: u32,
    /// Exact narration script represented by this audio. Never treat its hash as
    /// provider attestation; it binds the retained script to this cue record.
    pub source_text: String,
    pub source_text_hash: String,
    pub voice_id: String,
    pub provider: String,
    pub production_metadata: serde_json::Value,
    pub duration_ms: u64,
    pub sample_count: u64,
    pub sample_rate: u32,
    pub channels: u16,
    pub evidence: Vec<VideoEvidenceRef>,
    pub created_at: DateTime<Utc>,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoAssetUpstreamKind {
    Event,
    Claim,
    VisualSpec,
    Asset,
    Scene,
    Shot,
}

impl VideoAssetUpstreamKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::Claim => "claim",
            Self::VisualSpec => "visual_spec",
            Self::Asset => "asset",
            Self::Scene => "scene",
            Self::Shot => "shot",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "event" => Self::Event,
            "claim" => Self::Claim,
            "visual_spec" => Self::VisualSpec,
            "asset" => Self::Asset,
            "scene" => Self::Scene,
            "shot" => Self::Shot,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoAssetLineage {
    pub asset_id: String,
    pub asset_revision: u32,
    pub upstream_kind: VideoAssetUpstreamKind,
    pub upstream_id: String,
    pub upstream_revision: Option<u32>,
    pub relationship: String,
    pub input_hash: Option<String>,
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
    /// A recorded backtest (revamp §d.2): the source is a backtest id.
    Backtest,
    /// The thesis itself (revamp §d.2): the source is a thesis id.
    Thesis,
}

impl VideoVisualSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::Claim => "claim",
            Self::TranscriptSpan => "transcript_span",
            Self::SignalSnapshot => "signal_snapshot",
            Self::Backtest => "backtest",
            Self::Thesis => "thesis",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "event" => Self::Event,
            "claim" => Self::Claim,
            "transcript_span" => Self::TranscriptSpan,
            "signal_snapshot" => Self::SignalSnapshot,
            "backtest" => Self::Backtest,
            "thesis" => Self::Thesis,
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

/// Verified manifest emitted only by the managed EDL export producer. This is
/// separate from the legacy caller-persisted VideoExportManifest so old v1
/// records and readers remain compatible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoExportManifestV1 {
    pub manifest_ref: VideoExportRef,
    pub state: String,
    pub project_ref: VideoExportRef,
    pub episode_ref: VideoExportRef,
    pub timeline_ref: VideoExportRef,
    pub timeline_hash: String,
    pub qa_report_ref: VideoExportRef,
    pub qa_input_fingerprint: String,
    pub export_profile_ref: VideoExportRef,
    pub input_fingerprint: String,
    pub output_asset_ref: VideoExportRef,
    pub output_sha256: String,
    pub probe: VideoExportProbeV1,
    pub files: Vec<VideoExportManifestFileV1>,
    pub toolchain: VideoExportToolchainV1,
    pub deterministic: bool,
    pub preview_only: bool,
    pub lineage_refs: Vec<VideoExportLineageRefV1>,
    pub created_at: DateTime<Utc>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoExportRef {
    pub id: String,
    pub revision: u32,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoExportProbeV1 {
    pub container: String,
    pub video_codec: String,
    pub audio_codec: Option<String>,
    pub width: u32,
    pub height: u32,
    pub frame_rate_num: u32,
    pub frame_rate_den: u32,
    pub duration_ms: u64,
    pub byte_size: u64,
    pub has_audio: bool,
    pub has_captions: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoExportManifestFileV1 {
    pub kind: String,
    pub asset_ref: VideoExportRef,
    pub sha256: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoExportToolchainV1 {
    pub ffmpeg_version: String,
    pub ffprobe_version: String,
    pub compiler_version: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoExportLineageRefV1 {
    pub kind: String,
    pub id: String,
    pub revision: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoQaStatus {
    Passed,
    Warning,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoQaSeverity {
    Advisory,
    Blocker,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoQaFinding {
    pub code: String,
    pub severity: VideoQaSeverity,
    pub message: String,
    pub subject_id: Option<String>,
    pub evidence: Vec<VideoEvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoQaReport {
    pub report_id: String,
    pub project_id: String,
    pub input_revision: u32,
    pub status: VideoQaStatus,
    pub findings: Vec<VideoQaFinding>,
    pub created_at: DateTime<Utc>,
}

/// One EDL row in a deterministic project timeline. Times are milliseconds on
/// a single zero-based track; asset and source IDs retain production lineage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoTimelineClip {
    pub shot_id: String,
    pub shot_revision: u32,
    pub asset_id: Option<String>,
    pub asset_revision: Option<u32>,
    pub start_ms: u64,
    pub duration_ms: u64,
    pub evidence: Vec<VideoEvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoTimeline {
    pub timeline_id: String,
    pub project_id: String,
    pub revision: u32,
    pub input_revision: u32,
    pub export_revision: u32,
    pub clips: Vec<VideoTimelineClip>,
    pub total_duration_ms: u64,
    pub deterministic: bool,
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

/// Safe active-provider/consent view for the workspace. It never contains an
/// endpoint path, API key, or other credential material.
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

/// An event-scoped entity candidate surfaced by an external agent. This is not
/// a globally resolved canonical entity; exact transcript evidence is retained
/// until a resolver or human review confirms identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentEntityCandidate {
    pub entity_id: String,
    pub canonical_name: String,
    pub entity_type: String,
    pub surface_form: String,
    pub resolution_status: String,
    pub evidence: ClaimEvidence,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentClaimAnnotation {
    pub claim_id: String,
    pub claim_type: String,
    pub entity_ids: Vec<String>,
    pub polarity: Option<String>,
    pub horizon: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentEntityDraft {
    pub canonical_name: String,
    pub entity_type: String,
    pub surface_form: String,
    pub evidence_quote: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentClaimDraft {
    pub claim_text: String,
    pub claim_type: String,
    pub speaker_or_author: Option<String>,
    pub confidence_millis: u16,
    pub evidence_quote: String,
    pub entity_names: Vec<String>,
    pub polarity: Option<String>,
    pub horizon: Option<String>,
    /// Mirror of the producer's extraction tier for this claim, when the
    /// agent passes the fina-scraper export through (`tier` in the
    /// fina-import JSON). Stored, never re-derived.
    #[serde(default)]
    pub extraction_tier: Option<ExtractionTier>,
    /// Mirror of the producer's review status for this claim, when passed.
    #[serde(default)]
    pub review_status: Option<ClaimReviewStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentNarrativeGraphDraft {
    pub event_id: String,
    pub producer: String,
    pub model: String,
    pub prompt_version: String,
    pub narrative_title: String,
    pub narrative_thesis: String,
    pub narrative_summary: String,
    pub entities: Vec<AgentEntityDraft>,
    pub claims: Vec<AgentClaimDraft>,
}

/// A persisted external-agent narrative synthesis. `producer` and `model` are
/// caller-declared metadata, not cryptographic provider attestation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentNarrativeAnalysis {
    pub analysis_id: String,
    pub event_id: String,
    pub source_content_hash: String,
    pub narrative_title: String,
    pub narrative_thesis: String,
    pub narrative_summary: String,
    pub extraction_run_id: String,
    pub producer: String,
    pub model: String,
    pub prompt_version: String,
    pub provenance_status: String,
    pub created_at: DateTime<Utc>,
    pub entities: Vec<AgentEntityCandidate>,
    pub claim_annotations: Vec<AgentClaimAnnotation>,
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

    #[test]
    fn extraction_tiers_and_review_statuses_round_trip_as_exact_strings() {
        assert_eq!(
            ExtractionTier::parse("tier2_llm"),
            Some(ExtractionTier::Tier2Llm)
        );
        assert_eq!(ExtractionTier::Tier0Lexicon.as_str(), "tier0_lexicon");
        assert_eq!(ExtractionTier::Tier1Onnx.as_str(), "tier1_onnx");
        assert_eq!(ExtractionTier::parse("tier3"), None);
        assert_eq!(
            serde_json::to_string(&ExtractionTier::Tier2Llm).unwrap(),
            "\"tier2_llm\""
        );
        assert_eq!(
            ClaimReviewStatus::parse("llm_disputed"),
            Some(ClaimReviewStatus::LlmDisputed)
        );
        assert_eq!(ClaimReviewStatus::parse("verified"), None,);
        assert!(ClaimReviewStatus::LlmVerified.is_thesis_grade());
        assert!(ClaimReviewStatus::LlmCorrected.is_thesis_grade());
        assert!(!ClaimReviewStatus::FastGlance.is_thesis_grade());
        assert!(!ClaimReviewStatus::LlmRejected.is_thesis_grade());
        assert_eq!(
            serde_json::to_string(&ClaimReviewStatus::LlmRejected).unwrap(),
            "\"llm_rejected\""
        );
    }

    #[test]
    fn provisional_theses_can_never_enter_backtested_or_beyond() {
        let provisional = ThesisBasis::ProvisionalFastGlance;
        assert!(provisional.allows_status(ThesisStatus::Draft));
        assert!(provisional.allows_status(ThesisStatus::LlmReviewed));
        assert!(provisional.allows_status(ThesisStatus::Rejected));
        assert!(provisional.allows_status(ThesisStatus::Invalidated));
        assert!(!provisional.allows_status(ThesisStatus::Backtested));
        assert!(!provisional.allows_status(ThesisStatus::TranscriptReady));
        assert!(!provisional.allows_status(ThesisStatus::VideoReady));
        assert!(!provisional.allows_status(ThesisStatus::Published));
        assert!(ThesisBasis::LlmVerifiedOnly.allows_status(ThesisStatus::Published));
        assert!(ThesisStatus::Backtested.is_beyond_backtest_gate());
        assert!(ThesisStatus::Published.is_beyond_backtest_gate());
        assert!(!ThesisStatus::LlmReviewed.is_beyond_backtest_gate());
        assert!(!ThesisStatus::Rejected.is_beyond_backtest_gate());
    }

    #[test]
    fn video_evidence_kinds_accept_backtest_and_thesis_only_beyond_event_claim() {
        assert!(valid_video_evidence_kind("event"));
        assert!(valid_video_evidence_kind("claim"));
        assert!(valid_video_evidence_kind("backtest"));
        assert!(valid_video_evidence_kind("thesis"));
        assert!(!valid_video_evidence_kind("signal"));
        assert!(!valid_video_evidence_kind(""));
        assert_eq!(
            VideoVisualSourceKind::parse("backtest"),
            Some(VideoVisualSourceKind::Backtest)
        );
        assert_eq!(
            VideoVisualSourceKind::parse("thesis"),
            Some(VideoVisualSourceKind::Thesis)
        );
        assert_eq!(VideoVisualSourceKind::Thesis.as_str(), "thesis");
        assert_eq!(VideoVisualSourceKind::parse("chart"), None);
    }

    #[test]
    fn thesis_backtest_verdicts_round_trip() {
        assert_eq!(
            BacktestVerdict::parse("could_not_run"),
            Some(BacktestVerdict::CouldNotRun)
        );
        assert_eq!(BacktestVerdict::NotSupported.as_str(), "not_supported");
        assert_eq!(BacktestVerdict::parse("pass"), None);
    }

    fn acquisition_test_batch() -> AcquisitionBatch {
        let at: DateTime<Utc> = "2026-11-28T00:00:00Z".parse().unwrap();
        let text = "Apex élan improves margins";
        let quote = "Apex élan";
        let quote_start = text.find(quote).unwrap();
        let start_chars = text[..quote_start].chars().count() as u32;
        let end_chars = start_chars + quote.chars().count() as u32;
        let provenance = AcquisitionExtractionProvenance {
            tier: ExtractionTier::Tier2Llm,
            model: "test-model".into(),
            model_version: "1".into(),
            prompt_version: Some("claims-v1".into()),
            confidence_millis: Some(900),
            extracted_at: at.clone(),
        };
        AcquisitionBatch {
            contract_version: 1,
            producer: AcquisitionProducer {
                name: "fina-scraper-worker".into(),
                version: "0.1.0".into(),
            },
            run_id: "run-1".into(),
            started_at: at.clone(),
            completed_at: at.clone(),
            items: vec![AcquisitionItem {
                source_id: SourceId::new("nip-source-1").unwrap(),
                worker_source_key: "podcast:123".into(),
                worker_item_id: "episode:456".into(),
                source_url: "https://example.test/episode/456".into(),
                title: "Episode 456".into(),
                content_kind: AcquisitionContentKind::Transcript,
                content_text: text.into(),
                content_hash: "sha256:test-item".into(),
                published_at: None,
                ingested_at: at.clone(),
                valid_from: at.clone(),
                valid_to: None,
                availability: AcquisitionAvailability::Live,
                transcript: None,
                claims: vec![AcquisitionClaim {
                    worker_claim_id: "claim-1".into(),
                    subject: "Apex".into(),
                    predicate: "improves".into(),
                    object: "margins".into(),
                    confidence_millis: 900,
                    review_status: ClaimReviewStatus::LlmVerified,
                    extraction: provenance.clone(),
                    evidence: AcquisitionEvidenceSpan {
                        payload: AcquisitionEvidencePayload::ItemContent,
                        quote: quote.into(),
                        start_offset: start_chars,
                        end_offset: end_chars,
                    },
                }],
                entities: vec![AcquisitionEntity {
                    worker_entity_id: "entity-1".into(),
                    canonical_id: "apex-inc".into(),
                    name: "Apex".into(),
                    entity_type: "company".into(),
                    ticker: None,
                    extraction: provenance.clone(),
                    evidence: vec![AcquisitionEvidenceSpan {
                        payload: AcquisitionEvidencePayload::ItemContent,
                        quote: "Apex".into(),
                        start_offset: 0,
                        end_offset: 4,
                    }],
                }],
                features: vec![AcquisitionFeatureValue {
                    feature_key: "narrative.sentiment".into(),
                    value: serde_json::json!({"score": 0.42}),
                    as_of: at.clone(),
                    valid_from: at,
                    valid_to: None,
                    availability: AcquisitionAvailability::Live,
                    extraction: provenance,
                }],
            }],
        }
    }

    #[test]
    fn acquisition_contract_accepts_unicode_character_offsets_and_keeps_provenance() {
        let batch = acquisition_test_batch();
        batch.validate().unwrap();
        let json = serde_json::to_value(batch).unwrap();
        assert_eq!(json["producer"]["name"], "fina-scraper-worker");
        assert_eq!(json["items"][0]["worker_source_key"], "podcast:123");
        assert_eq!(
            json["items"][0]["claims"][0]["extraction"]["tier"],
            "tier2_llm"
        );
        assert_eq!(
            json["items"][0]["claims"][0]["evidence"]["quote"],
            "Apex élan"
        );
        assert_eq!(
            json["items"][0]["features"][0]["feature_key"],
            "narrative.sentiment"
        );
    }

    #[test]
    fn acquisition_contract_rejects_inexact_spans_and_missing_transcript_refs() {
        let mut batch = acquisition_test_batch();
        batch.items[0].claims[0].evidence.quote = "Apex elan".into();
        assert!(batch
            .validate()
            .unwrap_err()
            .contains("does not exactly match"));

        let mut batch = acquisition_test_batch();
        batch.items[0].claims[0].evidence.payload = AcquisitionEvidencePayload::Transcript;
        assert!(batch.validate().unwrap_err().contains("missing transcript"));
    }

    #[test]
    fn acquisition_contract_rejects_unsupported_versions_duplicate_ids_and_unknown_fields() {
        let mut batch = acquisition_test_batch();
        batch.contract_version = 2;
        assert!(batch
            .validate()
            .unwrap_err()
            .contains("unsupported acquisition contract version"));

        let mut batch = acquisition_test_batch();
        batch.items.push(batch.items[0].clone());
        assert!(batch
            .validate()
            .unwrap_err()
            .contains("duplicate worker item"));

        let json = serde_json::to_value(acquisition_test_batch()).unwrap();
        let mut object = json.as_object().unwrap().clone();
        object.insert(
            "unrecognized_writer_override".into(),
            serde_json::json!(true),
        );
        assert!(
            serde_json::from_value::<AcquisitionBatch>(serde_json::Value::Object(object)).is_err()
        );
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
