pub mod acquisition;
pub mod asr;
pub mod comfy;
pub mod comfy_discovery;
pub mod config;
pub mod jobs;
pub mod local_model;
pub mod media;
pub mod podcast;
pub mod provider;
pub mod semantic;
pub mod tts;
pub mod video_edl;
pub mod video_export;
pub mod video_export_producer;
pub mod video_qa;
pub mod video_qa_adapter;

use chrono::{DateTime, Datelike, Duration, TimeZone, Utc};
use nip_domain::{
    AcquisitionBatch, AgentClaimAnnotation, AgentEntityCandidate, AgentNarrativeAnalysis,
    AgentNarrativeGraphDraft,
    BacktestDelta, BacktestEvidenceRecord, BacktestMetrics, BacktestVerdict, CapabilitiesResponse,
    ClaimEvidence, ClaimRecord, ClaimReviewStatus, EditorialCandidate, EditorialReviewAudit,
    EmbeddingIndexManifest, EtfMapping, EventRecord, EventSearchPage, EventSearchQuery,
    ExtractionStatus, ExtractionTier, FeatureCapabilities, HealthResponse, LocalEventImport,
    NarrativeCluster, NarrativeGraph, NarrativeGraphEdge, NarrativeGraphNode, NarrativeSignal,
    NarrativeSignalSnapshot, NarrativeSource, PodcastEpisode, PodcastEpisodePage,
    PodcastEpisodeState, PodcastRefreshReport, PodcastSubscription, PodcastSubscriptionState,
    PodcastTranscript, ProviderConsent, ProviderStatus, Readiness, ResourceStatus,
    SemanticSearchResult, SourceId, SourceKind, SourceState, SourceUpdate, ThesisBasis,
    ThesisDirection, ThesisRecord, ThesisStatus, TranscriptBeat, TranscriptEvidenceRef,
    TranscriptRecord, VideoAsset, VideoAssetLineage, VideoAudioCue, VideoEpisode, VideoEvidenceRef,
    VideoExportManifest, VideoJob, VideoNarrative, VideoProject, VideoQaReport, VideoScene,
    VideoShot, VideoStoryboard, VideoTimeline, VideoVisualSpec, VideoWorkflow, API_VERSION,
    DOMAIN_SCHEMA_VERSION, SERVICE_NAME,
};
use nip_store::{
    AcquisitionBinding, AcquisitionIngestResult, AcquisitionTranscriptRecord, SnapshotManifest,
    Store, StoreError, SubscriptionFetchStateUpdate, VideoProjectDeleteResult,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    sync::atomic::{AtomicU64, Ordering},
};
use thiserror::Error;

use asr::{AsrError, AsrProvider, AsrRequest, AsrResult};
use acquisition::{canonical_locator, resolve_source_bindings, AcquisitionSourceBinding};
use config::ClaimProviderMode;
pub use config::{ConfigError, NipConfig};
use local_model::{LocalModelError, LocalOpenAiClaimProvider};
use podcast::{
    parse_rss_feed, scheduled_next_poll, validate_feed_url, AudioClient, FeedClient, FeedRequest,
    FeedValidationError,
};
use provider::{RigaBridgeClaimProvider, RigaBridgeProviderStatus, REMOTE_EXTRACTION_SCOPE};
use semantic::{cluster_events, event_map, manifest, EmbeddingProvider, QdrantIndex};

/// Input for creating a source of any kind. A podcast additionally creates a
/// subscription row and performs its initial sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceDraft {
    pub source_id: SourceId,
    pub kind: SourceKind,
    pub display_name: String,
    pub locator: Option<String>,
    pub rights_statement: String,
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default)]
    pub poll_interval_minutes: Option<u32>,
    #[serde(default)]
    pub per_scan_limit: Option<u32>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PodcastSubscriptionRequest {
    pub source_id: SourceId,
    pub feed_url: String,
    pub show_name: String,
    pub rights_statement: String,
    pub user_confirmed_rights: bool,
}

pub trait ClaimExtractionProvider: Send + Sync {
    fn extract(&self, event: &EventRecord) -> Result<Vec<ClaimRecord>, NipError>;
}

pub struct DeterministicFakeClaimProvider;

impl ClaimExtractionProvider for DeterministicFakeClaimProvider {
    fn extract(&self, event: &EventRecord) -> Result<Vec<ClaimRecord>, NipError> {
        let text = event.content_text.as_deref().unwrap_or("").trim();
        if text.is_empty() {
            return Err(NipError::ExtractionFailed);
        }
        let claim_text = text.lines().next().unwrap_or(text).trim().to_owned();
        let identity = format!("{}\0{}", event.event_id.as_str(), claim_text);
        let claim_id = format!("claim-{}", &transcript_hash(&identity)[..24]);
        Ok(vec![ClaimRecord {
            claim_id,
            claim_text: claim_text.clone(),
            speaker_or_author: None,
            confidence_millis: 800,
            extraction_run_id: format!(
                "fake-run-{}",
                &transcript_hash(event.event_id.as_str())[..16]
            ),
            provider: "deterministic_fake".into(),
            model: "fixture-claims-v1".into(),
            prompt_version: "nip-claims-v1".into(),
            provider_kind: Some("local".into()),
            provider_profile_id: None,
            reasoning_effort: None,
            extracted_at: Utc::now(),
            extraction_tier: None,
            review_status: None,
            evidence: vec![ClaimEvidence {
                event_id: event.event_id.clone(),
                quote: Some(claim_text),
                start_offset: Some(0),
                end_offset: Some(text.len() as u32),
            }],
        }])
    }
}

/// Everything a claim extraction needs, resolved while the store is locked.
/// The provider call itself happens with the lock released.
pub struct PreparedExtraction {
    event: EventRecord,
    provider: PreparedClaimProvider,
}

enum PreparedClaimProvider {
    Riga {
        provider: RigaBridgeClaimProvider,
        status: RigaBridgeProviderStatus,
    },
    DirectLocal(LocalOpenAiClaimProvider),
}

impl PreparedExtraction {
    /// Run the provider request. Drops neither the consent binding nor the
    /// event: claims are validated against the same status snapshot.
    pub fn extract(&self) -> Result<Vec<ClaimRecord>, NipError> {
        match &self.provider {
            PreparedClaimProvider::Riga { provider, status } => {
                provider.extract_with_status(&self.event, status)
            }
            PreparedClaimProvider::DirectLocal(provider) => provider.extract(&self.event),
        }
    }
}

#[derive(Debug, Error)]
pub enum NipError {
    #[error("NIP configuration is invalid")]
    Configuration(#[from] ConfigError),
    #[error("NIP data directory could not be prepared")]
    PrepareDataDirectory(#[source] std::io::Error),
    #[error("NIP storage could not be initialized")]
    Storage(#[from] StoreError),
    #[error("podcast feed URL is invalid")]
    InvalidFeedUrl,
    #[error("explicit source access and retention confirmation is required")]
    RightsConfirmationRequired,
    #[error("podcast feed show name and rights statement must not be empty")]
    InvalidSubscriptionDetails,
    #[error("this RSS feed already has an active or paused subscription")]
    DuplicateSubscription,
    #[error("podcast subscription was not found")]
    SubscriptionNotFound,
    #[error("podcast subscription is paused or removed")]
    SubscriptionInactive,
    #[error("podcast feed is not yet due for refresh")]
    RefreshNotDue,
    #[error("podcast feed is owned by fina-scraper; NIP will not fetch the same feed twice")]
    ScraperOwnsPodcastFeed,
    #[error("source ID is owned by fina-scraper; NIP registry mutations are refused")]
    ScraperOwnsSource,
    #[error("podcast feed could not be fetched or parsed; retry is scheduled")]
    FeedUnavailable,
    #[error("local transcription is unavailable; retry is possible")]
    TranscriptionUnavailable,
    #[error("local transcription failed")]
    TranscriptionFailed,
    #[error("claim extraction failed")]
    ExtractionFailed,
    #[error("podcast audio enclosure is unavailable")]
    AudioUnavailable,
    #[error("podcast audio enclosure format is unsupported")]
    UnsupportedAudio,
    #[error("semantic search is unavailable; configure a local embedding provider and Qdrant")]
    SemanticUnavailable,
    #[error("event was not found in the local ledger")]
    EventNotFound,
    #[error("the selected claim-extraction provider is unavailable")]
    ProviderUnavailable,
    #[error("claim extraction failed: {0}")]
    ExtractionRejected(String),
    #[error("external-agent narrative graph payload was rejected: {0}")]
    AgentAnalysisRejected(String),
    #[error("Video EDL build request was rejected: {0}")]
    VideoEdlBuildRejected(String),
    #[error("remote transcript extraction requires NIP-specific consent for the selected provider/model")]
    RemoteConsentRequired,
    #[error("no remote provider is configured; remote consent does not apply")]
    RemoteProviderRequired,
    #[error("remote consent requires a non-empty acting user")]
    InvalidConsentRequest,
    #[error("source kind is not supported")]
    InvalidSourceKind,
    #[error("source needs a display name, rights statement and a locator for this kind")]
    InvalidSourceDetails,
    #[error("source was not found")]
    SourceNotFound,
    #[error("worker acquisition profile was not found")]
    AcquisitionProfileNotFound,
    #[error("an approved NIP source and explicit rights review are required before binding")]
    AcquisitionBindingRightsRequired,
    #[error("worker profile and NIP source do not match by canonical locator and kind")]
    AcquisitionBindingEvidenceMismatch,
    #[error("worker acquisition batch was rejected: {0}")]
    AcquisitionBatchRejected(String),
    #[error("acquisition binding review record was not found")]
    AcquisitionBindingNotFound,
    #[error("another active or paused source already uses this locator")]
    DuplicateSourceLocator,
    #[error("source still owns {count} retained event(s); mark it removed or purge through the retention path")]
    SourceHasEvents { count: u64 },
}

/// Owns startup configuration and the local canonical store. Business logic
/// and transport adapters can depend on this type without importing Tauri.
pub struct NipService {
    config: NipConfig,
    store: Store,
}

impl NipService {
    pub fn open(config: NipConfig) -> Result<Self, NipError> {
        fs::create_dir_all(config.data_dir()).map_err(NipError::PrepareDataDirectory)?;
        let mut store = Store::open(config.database_path())?;
        store.recover_video_jobs()?;
        let retention_days = std::env::var("NIP_VIDEO_JOB_RETENTION_DAYS")
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(30)
            .clamp(1, 3650);
        let _ = store.cleanup_video_jobs(Utc::now() - chrono::Duration::days(retention_days))?;
        Ok(Self { config, store })
    }

    pub fn health(&self) -> HealthResponse {
        HealthResponse {
            service: SERVICE_NAME.to_owned(),
            api_version: API_VERSION,
            readiness: Readiness::Ready,
            schema_version: self.store.schema_version(),
        }
    }

    pub fn capabilities(&self) -> CapabilitiesResponse {
        CapabilitiesResponse {
            service: SERVICE_NAME.to_owned(),
            service_version: env!("CARGO_PKG_VERSION").to_owned(),
            api_version: API_VERSION,
            schema_version: self.store.schema_version().max(DOMAIN_SCHEMA_VERSION),
            features: FeatureCapabilities {
                duckdb_store: true,
                podcast_rss_subscriptions: true,
                local_audio_transcription: self.config.local_asr_available(),
                claim_extraction: self.config.claim_extraction_configured(),
                parquet_export: true,
                semantic_search: true,
            },
        }
    }

    pub fn config(&self) -> &NipConfig {
        &self.config
    }

    /// Read-only owner preflight used by transport entry points before network
    /// work or job creation. Existing compatibility rows remain readable, but
    /// none of their NIP mutation paths may write while fina-scraper owns the feed.
    pub fn ensure_nip_owned_source(&self, source_id: &SourceId) -> Result<(), NipError> {
        if self.config.scraper_owns_site_id(source_id.as_str()) {
            return Err(NipError::ScraperOwnsSource);
        }
        let source = self
            .store
            .source(source_id)?
            .ok_or(NipError::SourceNotFound)?;
        let subscription = self.store.subscription(source_id)?;
        if source.kind == SourceKind::Podcast || subscription.is_some() {
            if source
                .locator
                .as_deref()
                .is_some_and(|feed| self.config.scraper_owns_podcast_feed(feed))
                || subscription
                    .as_ref()
                    .is_some_and(|record| self.config.scraper_owns_podcast_feed(&record.feed_url))
            {
                return Err(NipError::ScraperOwnsPodcastFeed);
            }
        }
        Ok(())
    }

    fn ensure_nip_owned_feed_url(&self, feed_url: &str) -> Result<(), NipError> {
        if self.config.scraper_owns_podcast_feed(feed_url) {
            return Err(NipError::ScraperOwnsPodcastFeed);
        }
        Ok(())
    }

    pub fn video_projects(&self) -> Result<Vec<VideoProject>, NipError> {
        Ok(self.store.video_projects()?)
    }

    pub fn video_project(&self, project_id: &str) -> Result<Option<VideoProject>, NipError> {
        Ok(self.store.video_project(project_id)?)
    }

    pub fn save_video_project(&mut self, project: &VideoProject) -> Result<(), NipError> {
        Ok(self.store.save_video_project(project)?)
    }

    pub fn delete_video_project(
        &mut self,
        project_id: &str,
        confirmation_name: &str,
    ) -> Result<VideoProjectDeleteResult, NipError> {
        Ok(self
            .store
            .delete_video_project(project_id, confirmation_name)?)
    }

    pub fn video_episode(&self, episode_id: &str) -> Result<Option<VideoEpisode>, NipError> {
        Ok(self.store.video_episode(episode_id)?)
    }

    pub fn video_scene(&self, scene_id: &str) -> Result<Option<VideoScene>, NipError> {
        Ok(self.store.video_scene(scene_id)?)
    }

    pub fn video_episodes(&self, project_id: &str) -> Result<Vec<VideoEpisode>, NipError> {
        Ok(self.store.video_episodes(project_id)?)
    }

    pub fn save_video_episode(&mut self, episode: &VideoEpisode) -> Result<(), NipError> {
        Ok(self.store.save_video_episode(episode)?)
    }

    pub fn video_narrative(&self, narrative_id: &str) -> Result<Option<VideoNarrative>, NipError> {
        Ok(self.store.video_narrative(narrative_id)?)
    }

    pub fn video_narratives(
        &self,
        episode_id: &str,
        limit: u32,
    ) -> Result<Vec<VideoNarrative>, NipError> {
        Ok(self.store.video_narratives(episode_id, limit)?)
    }

    pub fn save_video_narrative(&mut self, narrative: &VideoNarrative) -> Result<(), NipError> {
        Ok(self.store.save_video_narrative(narrative)?)
    }

    pub fn link_video_evidence(
        &mut self,
        episode_id: &str,
        episode_revision: u32,
        evidence: &VideoEvidenceRef,
    ) -> Result<(), NipError> {
        Ok(self
            .store
            .link_video_episode_evidence(episode_id, episode_revision, evidence)?)
    }

    pub fn video_evidence(
        &self,
        episode_id: &str,
        episode_revision: u32,
    ) -> Result<Vec<VideoEvidenceRef>, NipError> {
        Ok(self
            .store
            .video_episode_evidence(episode_id, episode_revision)?)
    }

    pub fn save_video_storyboard(&mut self, storyboard: &VideoStoryboard) -> Result<(), NipError> {
        Ok(self.store.save_video_storyboard(storyboard)?)
    }

    pub fn save_video_scene(&mut self, scene: &VideoScene) -> Result<(), NipError> {
        Ok(self.store.save_video_scene(scene)?)
    }

    pub fn save_video_shot(&mut self, shot: &VideoShot) -> Result<(), NipError> {
        Ok(self.store.save_video_shot(shot)?)
    }

    pub fn video_audio_cue(
        &self,
        cue_id: &str,
        revision: u32,
    ) -> Result<Option<VideoAudioCue>, NipError> {
        Ok(self.store.video_audio_cue(cue_id, revision)?)
    }
    pub fn video_audio_cues(
        &self,
        storyboard_id: &str,
        storyboard_revision: u32,
        limit: u32,
    ) -> Result<Vec<VideoAudioCue>, NipError> {
        Ok(self
            .store
            .video_audio_cues(storyboard_id, storyboard_revision, limit)?)
    }
    pub fn save_video_audio_cue(&mut self, cue: &VideoAudioCue) -> Result<(), NipError> {
        Ok(self.store.save_video_audio_cue(cue)?)
    }

    pub fn video_assets(&self, limit: u32) -> Result<Vec<VideoAsset>, NipError> {
        Ok(self.store.video_assets(limit)?)
    }

    pub fn video_project_assets(
        &self,
        project_id: &str,
        episode_id: Option<&str>,
        limit: u32,
    ) -> Result<Vec<VideoAsset>, NipError> {
        Ok(self
            .store
            .video_project_assets(project_id, episode_id, limit)?)
    }

    pub fn save_video_asset(&mut self, asset: &VideoAsset) -> Result<(), NipError> {
        Ok(self.store.save_video_asset(asset)?)
    }

    pub fn save_video_asset_with_lineage(
        &mut self,
        asset: &VideoAsset,
        lineage: &[VideoAssetLineage],
    ) -> Result<(), NipError> {
        Ok(self.store.save_video_asset_with_lineage(asset, lineage)?)
    }

    pub fn save_video_asset_lineage(
        &mut self,
        lineage: &VideoAssetLineage,
    ) -> Result<(), NipError> {
        Ok(self.store.save_video_asset_lineage(lineage)?)
    }

    pub fn video_asset_lineage(
        &self,
        asset_id: &str,
        asset_revision: u32,
    ) -> Result<Vec<VideoAssetLineage>, NipError> {
        Ok(self.store.video_asset_lineage(asset_id, asset_revision)?)
    }

    pub fn video_workflows(&self) -> Result<Vec<VideoWorkflow>, NipError> {
        Ok(self.store.video_workflows()?)
    }

    pub fn save_video_workflow(&mut self, workflow: &VideoWorkflow) -> Result<(), NipError> {
        Ok(self.store.save_video_workflow(workflow)?)
    }

    pub fn video_visual_spec(
        &self,
        spec_id: &str,
        revision: u32,
    ) -> Result<Option<VideoVisualSpec>, NipError> {
        Ok(self.store.video_visual_spec(spec_id, revision)?)
    }

    pub fn video_visual_specs(&self, limit: u32) -> Result<Vec<VideoVisualSpec>, NipError> {
        Ok(self.store.video_visual_specs(limit)?)
    }

    pub fn video_episode_visual_specs(
        &self,
        project_id: &str,
        episode_id: &str,
    ) -> Result<Vec<VideoVisualSpec>, NipError> {
        Ok(self
            .store
            .video_episode_visual_specs(project_id, episode_id)?)
    }

    pub fn save_video_visual_spec(&mut self, spec: &VideoVisualSpec) -> Result<(), NipError> {
        Ok(self.store.save_video_visual_spec(spec)?)
    }

    pub fn video_export_manifest(
        &self,
        manifest_id: &str,
    ) -> Result<Option<VideoExportManifest>, NipError> {
        Ok(self.store.video_export_manifest(manifest_id)?)
    }

    pub fn video_export_manifests(&self, limit: u32) -> Result<Vec<VideoExportManifest>, NipError> {
        Ok(self.store.video_export_manifests(limit)?)
    }

    pub fn save_video_export_manifest(
        &mut self,
        manifest: &VideoExportManifest,
    ) -> Result<(), NipError> {
        Ok(self.store.save_video_export_manifest(manifest)?)
    }

    pub fn video_qa_report(&self, report_id: &str) -> Result<Option<VideoQaReport>, NipError> {
        Ok(self.store.video_qa_report(report_id)?)
    }

    pub fn run_video_qa(
        &mut self,
        media_root: &std::path::Path,
        request: &video_qa_adapter::VideoQaRunRequest,
    ) -> Result<serde_json::Value, NipError> {
        video_qa_adapter::run(&mut self.store, media_root, request)
            .map_err(NipError::VideoEdlBuildRejected)
    }

    pub fn video_qa_stored_report(
        &self,
        report_id: &str,
    ) -> Result<Option<nip_store::VideoQaStoredReport>, NipError> {
        Ok(self.store.video_qa_stored_report(report_id)?)
    }

    pub fn video_qa_reports(
        &self,
        project_id: &str,
        limit: u32,
    ) -> Result<Vec<VideoQaReport>, NipError> {
        Ok(self.store.video_qa_reports(project_id, limit)?)
    }

    pub fn save_video_qa_report(&mut self, report: &VideoQaReport) -> Result<(), NipError> {
        Ok(self.store.save_video_qa_report(report)?)
    }

    pub fn video_timeline(
        &self,
        timeline_id: &str,
        revision: u32,
    ) -> Result<Option<VideoTimeline>, NipError> {
        Ok(self.store.video_timeline(timeline_id, revision)?)
    }

    pub fn video_timelines(
        &self,
        project_id: &str,
        limit: u32,
    ) -> Result<Vec<VideoTimeline>, NipError> {
        Ok(self.store.video_timelines(project_id, limit)?)
    }

    pub fn save_video_timeline(&mut self, timeline: &VideoTimeline) -> Result<(), NipError> {
        Ok(self.store.save_video_timeline(timeline)?)
    }

    pub fn build_video_timeline_edl(
        &mut self,
        request: &video_edl::VideoTimelineBuildRequest,
    ) -> Result<video_edl::VideoTimelineBuildResult, NipError> {
        video_edl::build_video_timeline(&mut self.store, request)
            .map_err(NipError::VideoEdlBuildRejected)
    }

    pub fn video_edl_timeline(
        &self,
        timeline_id: &str,
        revision: u32,
    ) -> Result<Option<nip_store::VideoEdlRevision>, NipError> {
        Ok(self.store.video_edl_timeline(timeline_id, revision)?)
    }

    pub fn video_edl_timelines(
        &self,
        project_id: &str,
        project_revision: u32,
        limit: u32,
    ) -> Result<Vec<nip_store::VideoEdlRevision>, NipError> {
        Ok(self
            .store
            .video_edl_timelines(project_id, project_revision, limit)?)
    }

    pub fn video_export_profiles(&self) -> serde_json::Value {
        video_export_producer::installed_profiles()
    }

    pub fn video_export_preflight(
        &self,
        media_root: &std::path::Path,
        request: &video_export_producer::ExportRequest,
    ) -> Result<serde_json::Value, String> {
        video_export_producer::preflight(&self.store, media_root, request)
    }

    pub fn start_video_export(
        &mut self,
        media_root: &std::path::Path,
        request: &video_export_producer::ExportStartRequest,
    ) -> Result<(serde_json::Value, bool), String> {
        video_export_producer::start(&mut self.store, media_root, request)
    }

    pub fn prepare_video_export_worker(
        &self,
        media_root: &std::path::Path,
        request: &video_export_producer::ExportStartRequest,
        job_id: &str,
    ) -> Result<video_export_producer::ExportPlan, String> {
        video_export_producer::prepare_worker(&self.store, media_root, request, job_id)
    }

    pub fn complete_video_export(
        &mut self,
        result: &video_export_producer::ExportResult,
        job_id: &str,
    ) -> Result<(), String> {
        let mut job = self
            .store
            .video_job(job_id)
            .map_err(|error| error.to_string())?
            .ok_or("not_found: export job disappeared")?;
        if job.cancellation_requested {
            return Err(
                "job_cancelled: cancellation requested before manifest registration".into(),
            );
        }
        job.status = "succeeded".into();
        job.progress_millis = 100_000;
        job.finished_at = Some(Utc::now());
        video_export_producer::finalize(&mut self.store, result, &job)
    }

    pub fn fail_video_export(
        &mut self,
        job_id: &str,
        error: &str,
        cancelled: bool,
    ) -> Result<(), String> {
        video_export_producer::fail_job(&mut self.store, job_id, error, cancelled)
    }

    pub fn update_video_export_job(&mut self, job: &VideoJob) -> Result<bool, String> {
        self.store
            .update_video_export_job_active(job)
            .map_err(|error| error.to_string())
    }

    pub fn video_export_manifest_v1(
        &self,
        manifest_id: &str,
    ) -> Result<Option<nip_domain::VideoExportManifestV1>, NipError> {
        Ok(self.store.video_export_manifest_v1(manifest_id)?)
    }

    pub fn video_export_manifests_v1(
        &self,
        project_id: &str,
        project_revision: u32,
        limit: u32,
    ) -> Result<Vec<nip_domain::VideoExportManifestV1>, NipError> {
        Ok(self
            .store
            .video_export_manifests_v1(project_id, project_revision, limit)?)
    }

    pub fn video_job(&self, job_id: &str) -> Result<Option<VideoJob>, NipError> {
        Ok(self.store.video_job(job_id)?)
    }

    pub fn video_jobs(&self, limit: u32) -> Result<Vec<VideoJob>, NipError> {
        Ok(self.store.video_jobs(limit)?)
    }

    pub fn save_video_job(&mut self, job: &VideoJob) -> Result<(), NipError> {
        Ok(self.store.save_video_job(job)?)
    }

    pub fn cleanup_video_jobs(&mut self, before: DateTime<Utc>) -> Result<u64, NipError> {
        Ok(self.store.cleanup_video_jobs(before)?)
    }

    pub fn export_parquet_snapshot(
        &self,
    ) -> Result<(std::path::PathBuf, SnapshotManifest), NipError> {
        Ok(self.store.export_parquet_snapshot(self.config.lake_dir())?)
    }

    /// Persist user approval first, then perform the initial feed fetch. A
    /// declined or incomplete confirmation never creates a source or makes a
    /// network request.
    pub fn subscribe_podcast_feed(
        &mut self,
        request: PodcastSubscriptionRequest,
        client: &dyn FeedClient,
        now: DateTime<Utc>,
    ) -> Result<PodcastRefreshReport, NipError> {
        if !request.user_confirmed_rights {
            return Err(NipError::RightsConfirmationRequired);
        }
        let feed_url = validate_feed_url(&request.feed_url).map_err(map_feed_url_error)?;
        if self.config.scraper_owns_podcast_feed(feed_url.as_str()) {
            return Err(NipError::ScraperOwnsPodcastFeed);
        }
        if request.show_name.trim().is_empty() || request.rights_statement.trim().is_empty() {
            return Err(NipError::InvalidSubscriptionDetails);
        }
        if self.store.subscriptions()?.iter().any(|existing| {
            existing.feed_url == feed_url.as_str()
                && existing.state != PodcastSubscriptionState::Removed
        }) {
            return Err(NipError::DuplicateSubscription);
        }
        let subscription = PodcastSubscription {
            source_id: request.source_id,
            feed_url: feed_url.to_string(),
            show_name: request.show_name.trim().to_owned(),
            rights_statement: request.rights_statement.trim().to_owned(),
            rights_confirmed_at: now,
            state: PodcastSubscriptionState::Active,
            etag: None,
            last_modified: None,
            last_checked_at: None,
            next_poll_at: None,
            last_error_code: None,
            consecutive_failures: 0,
        };
        self.store.add_approved_subscription(&subscription)?;
        self.refresh_podcast_feed(&subscription.source_id, client, now)
    }

    pub fn refresh_podcast_feed(
        &mut self,
        source_id: &SourceId,
        client: &dyn FeedClient,
        now: DateTime<Utc>,
    ) -> Result<PodcastRefreshReport, NipError> {
        self.refresh_podcast_feed_within(source_id, client, now, false)
    }

    /// Refresh a feed regardless of its six-hour window and regardless of the
    /// stored ETag/Last-Modified. A manual refresh exists to re-read a body the
    /// current parser had not understood yet, which a `304 Not Modified` would
    /// otherwise hide forever.
    pub fn refresh_podcast_feed_now(
        &mut self,
        source_id: &SourceId,
        client: &dyn FeedClient,
        now: DateTime<Utc>,
    ) -> Result<PodcastRefreshReport, NipError> {
        self.refresh_podcast_feed_within(source_id, client, now, true)
    }

    fn refresh_podcast_feed_within(
        &mut self,
        source_id: &SourceId,
        client: &dyn FeedClient,
        now: DateTime<Utc>,
        force: bool,
    ) -> Result<PodcastRefreshReport, NipError> {
        let subscription = self
            .store
            .subscription(source_id)?
            .ok_or(NipError::SubscriptionNotFound)?;
        if self
            .config
            .scraper_owns_podcast_feed(&subscription.feed_url)
        {
            return Err(NipError::ScraperOwnsPodcastFeed);
        }
        if subscription.state != PodcastSubscriptionState::Active {
            return Err(NipError::SubscriptionInactive);
        }
        if !force && subscription.next_poll_at.is_some_and(|next| now < next) {
            return Err(NipError::RefreshNotDue);
        }

        let response = match client.fetch(&FeedRequest {
            url: subscription.feed_url.clone(),
            etag: if force {
                None
            } else {
                subscription.etag.clone()
            },
            last_modified: if force {
                None
            } else {
                subscription.last_modified.clone()
            },
        }) {
            Ok(response) => response,
            Err(error) => {
                let code = match error {
                    podcast::FeedClientError::Request => "feed_fetch_failed",
                    podcast::FeedClientError::InvalidBody => "feed_body_invalid",
                };
                self.record_feed_failure(source_id, &subscription, now, None, code)?;
                return Err(NipError::FeedUnavailable);
            }
        };

        match response.status {
            304 => {
                let next = scheduled_next_poll(now, 0, response.retry_after.as_deref());
                self.store
                    .update_subscription_fetch_state(SubscriptionFetchStateUpdate {
                        source_id,
                        etag: response.etag.as_deref(),
                        last_modified: response.last_modified.as_deref(),
                        checked_at: now,
                        next_poll_at: next,
                        last_error_code: None,
                        consecutive_failures: 0,
                    })?;
                let total_episode_count = self.store.discovered_episodes(source_id)?.len() as u32;
                Ok(PodcastRefreshReport {
                    source_id: source_id.clone(),
                    not_modified: true,
                    discovered_count: 0,
                    total_episode_count,
                    next_poll_at: next,
                })
            }
            200 => {
                let feed_url =
                    validate_feed_url(&subscription.feed_url).map_err(map_feed_url_error)?;
                let parsed = match parse_rss_feed(&response.body, &feed_url, source_id, now) {
                    Ok(feed) => feed,
                    Err(_) => {
                        self.record_feed_failure(
                            source_id,
                            &subscription,
                            now,
                            response.retry_after.as_deref(),
                            "invalid_rss",
                        )?;
                        return Err(NipError::FeedUnavailable);
                    }
                };
                let mut episodes = parsed.episodes;
                for episode in &mut episodes {
                    episode.state = PodcastEpisodeState::AwaitingLocalTranscription;
                }
                let discovered_count = self.store.record_discovered_episodes(&episodes)?;
                let next = scheduled_next_poll(now, 0, response.retry_after.as_deref());
                self.store
                    .update_subscription_fetch_state(SubscriptionFetchStateUpdate {
                        source_id,
                        etag: response.etag.as_deref(),
                        last_modified: response.last_modified.as_deref(),
                        checked_at: now,
                        next_poll_at: next,
                        last_error_code: None,
                        consecutive_failures: 0,
                    })?;
                let total_episode_count = self.store.discovered_episodes(source_id)?.len() as u32;
                Ok(PodcastRefreshReport {
                    source_id: source_id.clone(),
                    not_modified: false,
                    discovered_count,
                    total_episode_count,
                    next_poll_at: next,
                })
            }
            status => {
                let code = if status == 429 {
                    "http_429"
                } else {
                    "feed_http_error"
                };
                self.record_feed_failure(
                    source_id,
                    &subscription,
                    now,
                    response.retry_after.as_deref(),
                    code,
                )?;
                Err(NipError::FeedUnavailable)
            }
        }
    }

    /// Refresh all active subscriptions that are due. The desktop/application
    /// host should call this at startup and then on its six-hour timer; this
    /// engine does not create an always-on background process.
    pub fn refresh_due_podcast_feeds(
        &mut self,
        client: &dyn FeedClient,
        now: DateTime<Utc>,
    ) -> Result<Vec<Result<PodcastRefreshReport, NipError>>, NipError> {
        let due_source_ids = self
            .store
            .subscriptions()?
            .into_iter()
            .filter(|subscription| {
                subscription.state == PodcastSubscriptionState::Active
                    && !self
                        .config
                        .scraper_owns_podcast_feed(&subscription.feed_url)
                    && subscription.next_poll_at.is_none_or(|next| now >= next)
            })
            .map(|subscription| subscription.source_id)
            .collect::<Vec<_>>();
        Ok(due_source_ids
            .iter()
            .map(|source_id| self.refresh_podcast_feed(source_id, client, now))
            .collect())
    }

    /// Refresh every active subscription now. The operator clicks this to make
    /// the stored ledger catch up with the current parser, so it ignores the
    /// poll window and the stored validators.
    pub fn refresh_active_podcast_feeds(
        &mut self,
        client: &dyn FeedClient,
        now: DateTime<Utc>,
    ) -> Result<Vec<Result<PodcastRefreshReport, NipError>>, NipError> {
        let active_source_ids = self
            .store
            .subscriptions()?
            .into_iter()
            .filter(|subscription| {
                subscription.state == PodcastSubscriptionState::Active
                    && !self
                        .config
                        .scraper_owns_podcast_feed(&subscription.feed_url)
            })
            .map(|subscription| subscription.source_id)
            .collect::<Vec<_>>();
        Ok(active_source_ids
            .iter()
            .map(|source_id| self.refresh_podcast_feed_now(source_id, client, now))
            .collect())
    }

    fn record_feed_failure(
        &mut self,
        source_id: &SourceId,
        subscription: &PodcastSubscription,
        now: DateTime<Utc>,
        retry_after: Option<&str>,
        error_code: &str,
    ) -> Result<(), NipError> {
        let failures = subscription.consecutive_failures.saturating_add(1);
        let next = scheduled_next_poll(now, failures, retry_after);
        self.store
            .update_subscription_fetch_state(SubscriptionFetchStateUpdate {
                source_id,
                etag: None,
                last_modified: None,
                checked_at: now,
                next_poll_at: next,
                last_error_code: Some(error_code),
                consecutive_failures: failures,
            })?;
        Ok(())
    }

    pub fn set_podcast_subscription_state(
        &mut self,
        source_id: &SourceId,
        state: PodcastSubscriptionState,
    ) -> Result<(), NipError> {
        self.ensure_nip_owned_source(source_id)?;
        let existing = self
            .store
            .subscription(source_id)?
            .ok_or(NipError::SubscriptionNotFound)?;
        // A removed subscription is terminal for the podcast adapter; the
        // registry-level `set_source_state` still allows restoring a registry
        // row that never had an adapter.
        if existing.state == PodcastSubscriptionState::Removed
            && state != PodcastSubscriptionState::Removed
        {
            return Err(NipError::SubscriptionNotFound);
        }
        let registry_state = match state {
            PodcastSubscriptionState::Active => SourceState::Active,
            PodcastSubscriptionState::Paused => SourceState::Paused,
            PodcastSubscriptionState::Removed => SourceState::Removed,
        };
        self.store
            .set_source_state(source_id, registry_state, Utc::now())?;
        Ok(())
    }

    pub fn sources(&self, include_removed: bool) -> Result<Vec<NarrativeSource>, NipError> {
        Ok(self.store.sources(include_removed)?)
    }

    /// Report explicit worker-to-NIP source matches. This is deliberately
    /// read-only: a worker profile never creates a NIP source or infers rights.
    pub fn acquisition_source_bindings(&self) -> Result<Vec<AcquisitionSourceBinding>, NipError> {
        let sources = self.store.sources(true)?;
        let mut bindings = resolve_source_bindings(self.config.acquisition_sites(), &sources);
        for record in self.store.acquisition_bindings()? {
            if let Some(binding) = bindings
                .iter_mut()
                .find(|binding| binding.worker_site_id == record.worker_site_id)
            {
                binding.explicit = true;
                binding.reviewed_by = Some(record.reviewed_by.clone());
                binding.review_note = record.review_note.clone();
                if record.state == "unbound" {
                    binding.source_id = None;
                    binding.state = "unbound".to_owned();
                    binding.match_basis = Some("explicit_review_unbound".to_owned());
                    binding.detail = "explicit NIP review left this worker profile unbound".to_owned();
                    continue;
                }
                let evidence_matches = sources.iter().find(|source| {
                    source.source_id.as_str() == record.source_id
                        && source.kind == SourceKind::Podcast
                        && source.rights_status == "approved"
                        && source.state != SourceState::Removed
                        && source
                            .locator
                            .as_deref()
                            .is_some_and(|locator| canonical_locator(locator) == record.worker_locator)
                        && record.worker_kind == "podcast"
                });
                if evidence_matches.is_some() {
                    binding.source_id = Some(record.source_id.clone());
                    binding.worker_locator = Some(record.worker_locator.clone());
                    binding.state = "bound".to_owned();
                    binding.match_basis = Some("explicit_review_exact_feed_url_source_kind_rights".to_owned());
                    binding.detail = "NIP explicitly reviewed and bound this worker profile".to_owned();
                } else {
                    binding.source_id = None;
                    binding.state = "unresolved".to_owned();
                    binding.match_basis = Some("explicit_review_stale_evidence".to_owned());
                    binding.detail = "explicit binding no longer matches current source, kind, locator, or rights evidence".to_owned();
                }
            } else {
                bindings.push(AcquisitionSourceBinding {
                    worker_site_id: record.worker_site_id,
                    worker_kind: record.worker_kind,
                    worker_locator: Some(record.worker_locator),
                    source_id: None,
                    state: "unresolved".to_owned(),
                    match_basis: Some("explicit_review_profile_missing".to_owned()),
                    detail: "explicit binding references a worker profile no longer in the configured inventory".to_owned(),
                    explicit: true,
                    reviewed_by: Some(record.reviewed_by),
                    review_note: record.review_note,
                });
            }
        }
        Ok(bindings)
    }

    pub fn ingest_acquisition_batch(
        &mut self,
        worker_site_id: &str,
        batch: &AcquisitionBatch,
    ) -> Result<AcquisitionIngestResult, NipError> {
        batch
            .validate()
            .map_err(NipError::AcquisitionBatchRejected)?;
        if batch.items.len() != 1 {
            return Err(NipError::AcquisitionBatchRejected(
                "Phase 4 accepts exactly one worker item".to_owned(),
            ));
        }
        let item = &batch.items[0];
        if item.worker_source_key != worker_site_id {
            return Err(NipError::AcquisitionBatchRejected(
                "worker source key does not match the reviewed worker profile".to_owned(),
            ));
        }
        let binding = self
            .acquisition_source_bindings()?
            .into_iter()
            .find(|binding| binding.worker_site_id == worker_site_id)
            .ok_or(NipError::AcquisitionProfileNotFound)?;
        if !binding.explicit || binding.state != "bound" {
            return Err(NipError::AcquisitionBindingEvidenceMismatch);
        }
        let source_id_text = binding
            .source_id
            .as_deref()
            .ok_or(NipError::AcquisitionBindingEvidenceMismatch)?;
        if item.source_id.as_str() != source_id_text {
            return Err(NipError::AcquisitionBindingEvidenceMismatch);
        }
        let source_id = SourceId::new(source_id_text.to_owned())
            .map_err(|_| NipError::AcquisitionBindingEvidenceMismatch)?;
        let source = self
            .store
            .source(&source_id)?
            .ok_or(NipError::SourceNotFound)?;
        if source.rights_status != "approved" {
            return Err(NipError::AcquisitionBindingRightsRequired);
        }
        if source.kind != SourceKind::Podcast || source.state == SourceState::Removed {
            return Err(NipError::AcquisitionBindingEvidenceMismatch);
        }
        let worker_locator = binding
            .worker_locator
            .as_deref()
            .ok_or(NipError::AcquisitionBindingEvidenceMismatch)?;
        let source_locator = source
            .locator
            .as_deref()
            .ok_or(NipError::AcquisitionBindingEvidenceMismatch)?;
        if binding.worker_kind != "podcast"
            || canonical_locator(worker_locator) != canonical_locator(source_locator)
        {
            return Err(NipError::AcquisitionBindingEvidenceMismatch);
        }

        Ok(self.store.ingest_acquisition_item(
            batch,
            worker_site_id,
            source_id.as_str(),
            &binding.worker_kind,
            worker_locator,
            source_locator,
            Utc::now(),
        )?)
    }

    pub fn acquisition_transcript(
        &self,
        event_id: &str,
    ) -> Result<Option<AcquisitionTranscriptRecord>, NipError> {
        Ok(self.store.acquisition_transcript(event_id)?)
    }

    pub fn bind_acquisition_source(
        &mut self,
        worker_site_id: &str,
        source_id: SourceId,
        reviewed_by: &str,
        review_note: Option<&str>,
        user_confirmed: bool,
    ) -> Result<AcquisitionBinding, NipError> {
        if !user_confirmed || reviewed_by.trim().is_empty() {
            return Err(NipError::RightsConfirmationRequired);
        }
        let site = self
            .config
            .acquisition_sites()
            .into_iter()
            .find(|site| site.site_id == worker_site_id)
            .ok_or(NipError::AcquisitionProfileNotFound)?;
        let locator = site
            .feed_url
            .as_deref()
            .map(canonical_locator)
            .filter(|value| !value.is_empty())
            .ok_or(NipError::AcquisitionBindingEvidenceMismatch)?;
        let source = self
            .store
            .source(&source_id)?
            .ok_or(NipError::SourceNotFound)?;
        if source.kind != SourceKind::Podcast
            || site.kind != "podcast"
            || source.rights_status != "approved"
            || source.state == SourceState::Removed
            || source
                .locator
                .as_deref()
                .map(canonical_locator)
                != Some(locator.clone())
        {
            return Err(if source.rights_status != "approved" {
                NipError::AcquisitionBindingRightsRequired
            } else {
                NipError::AcquisitionBindingEvidenceMismatch
            });
        }
        Ok(self.store.upsert_acquisition_binding(
            worker_site_id,
            source_id.as_str(),
            &site.kind,
            &locator,
            reviewed_by.trim(),
            review_note.map(str::trim).filter(|note| !note.is_empty()),
            Utc::now(),
        )?)
    }

    pub fn unbind_acquisition_source(
        &mut self,
        worker_site_id: &str,
        reviewed_by: &str,
        review_note: Option<&str>,
        user_confirmed: bool,
    ) -> Result<(), NipError> {
        if !user_confirmed || reviewed_by.trim().is_empty() {
            return Err(NipError::RightsConfirmationRequired);
        }
        if self.store.acquisition_binding(worker_site_id)?.is_none() {
            return Err(NipError::AcquisitionBindingNotFound);
        }
        if !self.store.unbind_acquisition_binding(
            worker_site_id,
            reviewed_by.trim(),
            review_note.map(str::trim).filter(|note| !note.is_empty()),
            Utc::now(),
        )? {
            return Err(NipError::AcquisitionBindingNotFound);
        }
        Ok(())
    }

    pub fn source(&self, source_id: &SourceId) -> Result<NarrativeSource, NipError> {
        self.store
            .source(source_id)?
            .ok_or(NipError::SourceNotFound)
    }

    pub fn create_source(
        &mut self,
        draft: SourceDraft,
        client: &dyn FeedClient,
        now: DateTime<Utc>,
    ) -> Result<NarrativeSource, NipError> {
        if self.config.scraper_owns_site_id(draft.source_id.as_str()) {
            return Err(NipError::ScraperOwnsSource);
        }
        let display_name = draft.display_name.trim();
        if display_name.is_empty() || draft.rights_statement.trim().is_empty() {
            return Err(NipError::InvalidSourceDetails);
        }
        let locator = draft
            .locator
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if locator.is_none() && !matches!(draft.kind, SourceKind::LocalDocument | SourceKind::Other)
        {
            return Err(NipError::InvalidSourceDetails);
        }
        if let Some(locator) = locator {
            self.reject_duplicate_locator(&draft.source_id, locator)?;
        }

        let defaults = SourceUpdate {
            topics: Some(draft.topics.clone()),
            poll_interval_minutes: draft.poll_interval_minutes,
            per_scan_limit: draft.per_scan_limit,
            notes: draft.notes.clone(),
            ..SourceUpdate::default()
        };

        if draft.kind == SourceKind::Podcast {
            let feed_url = locator.ok_or(NipError::InvalidSourceDetails)?;
            validate_feed_url(feed_url).map_err(map_feed_url_error)?;
            self.subscribe_podcast_feed(
                PodcastSubscriptionRequest {
                    source_id: draft.source_id.clone(),
                    feed_url: feed_url.to_owned(),
                    show_name: display_name.to_owned(),
                    rights_statement: draft.rights_statement.trim().to_owned(),
                    user_confirmed_rights: true,
                },
                client,
                now,
            )?;
            self.store.update_source(&draft.source_id, &defaults, now)?;
            return self.source(&draft.source_id);
        }

        let source = NarrativeSource {
            source_id: draft.source_id,
            kind: draft.kind,
            display_name: display_name.to_owned(),
            locator: locator.map(str::to_owned),
            rights_status: "approved".to_owned(),
            rights_statement: Some(draft.rights_statement.trim().to_owned()),
            topics: draft.topics,
            state: SourceState::Active,
            poll_interval_minutes: clamp_poll_interval(draft.poll_interval_minutes),
            per_scan_limit: clamp_per_scan_limit(draft.per_scan_limit),
            notes: draft.notes,
            created_at: now,
            updated_at: now,
            event_count: 0,
            episode_count: 0,
        };
        self.store.insert_source(&source)?;
        self.source(&source.source_id)
    }

    pub fn update_source(
        &mut self,
        source_id: &SourceId,
        update: &SourceUpdate,
        client: &dyn FeedClient,
        sync: bool,
        now: DateTime<Utc>,
    ) -> Result<NarrativeSource, NipError> {
        let existing = self.source(source_id)?;
        self.ensure_nip_owned_source(source_id)?;
        if existing.state == SourceState::Removed {
            return Err(NipError::SourceNotFound);
        }
        if let Some(name) = update.display_name.as_deref() {
            if name.trim().is_empty() {
                return Err(NipError::InvalidSourceDetails);
            }
        }
        if let Some(statement) = update.rights_statement.as_deref() {
            if statement.trim().is_empty() {
                return Err(NipError::InvalidSourceDetails);
            }
        }
        if let Some(locator) = update.locator.as_deref() {
            let locator = locator.trim();
            if locator.is_empty() {
                return Err(NipError::InvalidSourceDetails);
            }
            self.reject_duplicate_locator(source_id, locator)?;
            if existing.kind == SourceKind::Podcast {
                validate_feed_url(locator).map_err(map_feed_url_error)?;
                self.ensure_nip_owned_feed_url(locator)?;
            }
        }

        let mut normalised = update.clone();
        normalised.poll_interval_minutes = update
            .poll_interval_minutes
            .map(|minutes| clamp_poll_interval(Some(minutes)));
        normalised.per_scan_limit = update
            .per_scan_limit
            .map(|limit| clamp_per_scan_limit(Some(limit)));
        normalised.display_name = update
            .display_name
            .as_deref()
            .map(str::trim)
            .map(str::to_owned);
        normalised.locator = update.locator.as_deref().map(str::trim).map(str::to_owned);
        normalised.rights_statement = update
            .rights_statement
            .as_deref()
            .map(str::trim)
            .map(str::to_owned);

        let locator_changed = normalised
            .locator
            .as_deref()
            .is_some_and(|locator| Some(locator) != existing.locator.as_deref());
        let name_changed = normalised
            .display_name
            .as_deref()
            .is_some_and(|name| name != existing.display_name);

        let mut rest = normalised;
        if existing.kind == SourceKind::Podcast && (locator_changed || name_changed) {
            let feed_url = rest
                .locator
                .clone()
                .or_else(|| existing.locator.clone())
                .ok_or(NipError::InvalidSourceDetails)?;
            let show_name = rest
                .display_name
                .clone()
                .unwrap_or_else(|| existing.display_name.clone());
            self.store
                .update_podcast_locator(source_id, &feed_url, &show_name, now)?;
            // The adapter update above already wrote locator and display name.
            rest.locator = None;
            rest.display_name = None;
        }
        self.store.update_source(source_id, &rest, now)?;

        if existing.kind == SourceKind::Podcast && sync {
            match self.refresh_podcast_feed(source_id, client, now) {
                Ok(_) | Err(NipError::RefreshNotDue) => {}
                Err(error) => return Err(error),
            }
        }
        self.source(source_id)
    }

    pub fn set_source_state(
        &mut self,
        source_id: &SourceId,
        state: SourceState,
        now: DateTime<Utc>,
    ) -> Result<NarrativeSource, NipError> {
        self.ensure_nip_owned_source(source_id)?;
        self.source(source_id)?;
        if !self.store.set_source_state(source_id, state, now)? {
            // Already in the requested state is still a success.
            return self.source(source_id);
        }
        self.source(source_id)
    }

    pub fn delete_source(&mut self, source_id: &SourceId) -> Result<(), NipError> {
        self.ensure_nip_owned_source(source_id)?;
        self.source(source_id)?;
        let events = self.store.delete_source(source_id)?;
        if events > 0 {
            return Err(NipError::SourceHasEvents { count: events });
        }
        Ok(())
    }

    fn reject_duplicate_locator(
        &self,
        source_id: &SourceId,
        locator: &str,
    ) -> Result<(), NipError> {
        let locator = locator.trim();
        let duplicate = self.store.sources(false)?.iter().any(|candidate| {
            candidate.source_id.as_str() != source_id.as_str()
                && candidate.locator.as_deref() == Some(locator)
        });
        if duplicate {
            return Err(NipError::DuplicateSourceLocator);
        }
        Ok(())
    }

    pub fn podcast_subscriptions(&self) -> Result<Vec<PodcastSubscription>, NipError> {
        Ok(self.store.subscriptions()?)
    }

    pub fn podcast_episodes(&self, source_id: &SourceId) -> Result<Vec<PodcastEpisode>, NipError> {
        if self.store.subscription(source_id)?.is_none() {
            return Err(NipError::SubscriptionNotFound);
        }
        Ok(self.store.discovered_episodes(source_id)?)
    }

    /// One page of discovered RSS metadata for the episode browser. Filters and
    /// ordering are applied before `LIMIT`/`OFFSET`, so the UI can page through
    /// thousands of episodes without loading the whole ledger.
    pub fn podcast_episode_page(
        &self,
        source_id: Option<&SourceId>,
        title_contains: Option<&str>,
        sort: Option<&str>,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<PodcastEpisodePage, NipError> {
        if let Some(source_id) = source_id {
            if self.store.subscription(source_id)?.is_none() {
                return Err(NipError::SubscriptionNotFound);
            }
        }
        let sort = match sort.unwrap_or("published_desc") {
            "title_asc" => "title_asc",
            _ => "published_desc",
        };
        let limit = limit.unwrap_or(50).clamp(1, 200);
        let offset = offset.unwrap_or(0);
        let (episodes, total) =
            self.store
                .discovered_episodes_page(source_id, title_contains, sort, limit, offset)?;
        let consumed = u64::from(offset) + episodes.len() as u64;
        let next_offset = if consumed >= total {
            None
        } else {
            Some((consumed).min(u64::from(u32::MAX)) as u32)
        };
        Ok(PodcastEpisodePage {
            episodes,
            total,
            limit,
            offset,
            next_offset,
        })
    }

    pub fn import_local_event(
        &mut self,
        import: &LocalEventImport,
        captured_at: DateTime<Utc>,
    ) -> Result<EventRecord, NipError> {
        Ok(self.store.import_local_event(import, captured_at)?)
    }

    pub fn search_events(&self, query: &EventSearchQuery) -> Result<EventSearchPage, NipError> {
        Ok(self.store.search_events(query)?)
    }

    pub fn event(&self, event_id: &str) -> Result<Option<EventRecord>, NipError> {
        Ok(self.store.event(event_id)?)
    }

    pub fn extract_claims(
        &mut self,
        event: &EventRecord,
        provider: &dyn ClaimExtractionProvider,
    ) -> Result<Vec<ClaimRecord>, NipError> {
        let claims = provider.extract(event)?;
        for claim in &claims {
            self.store.store_claim(claim)?;
        }
        Ok(claims)
    }

    /// Safe provider/consent view for the workspace. A missing or unreachable
    /// provider is reported explicitly; NIP never substitutes a different model
    /// or falls back to the deterministic fake provider.
    pub fn provider_status(&self) -> Result<ProviderStatus, NipError> {
        if self.config.active_claim_provider() == ClaimProviderMode::DirectLocal {
            return Ok(self.direct_local_provider_status());
        }
        let Some(bridge) = self.bridge_provider() else {
            return Ok(ProviderStatus {
                configured: false,
                bridge_state: "not_configured".into(),
                provider_kind: None,
                provider_id: None,
                model: None,
                reasoning_effort: None,
                provider_api: None,
                provider_type: None,
                remote: false,
                consent: "not_required".into(),
                consent_recorded_at: None,
                disclosure: None,
                extraction_state: "unavailable".into(),
                warnings: vec!["riga_bridge_not_configured".into()],
            });
        };
        let status = match bridge.provider_status() {
            Ok(status) => status,
            Err(_) => {
                return Ok(ProviderStatus {
                    configured: false,
                    bridge_state: "unavailable".into(),
                    provider_kind: None,
                    provider_id: None,
                    model: None,
                    reasoning_effort: None,
                    provider_api: None,
                    provider_type: None,
                    remote: false,
                    consent: "not_required".into(),
                    consent_recorded_at: None,
                    disclosure: None,
                    extraction_state: "unavailable".into(),
                    warnings: vec!["riga_bridge_unavailable".into()],
                })
            }
        };
        self.status_from_bridge(status)
    }

    fn direct_local_provider_status(&self) -> ProviderStatus {
        let Some(config) = self.config.local_llm() else {
            return ProviderStatus {
                configured: false,
                bridge_state: "not_configured".into(),
                provider_kind: Some("local".into()),
                provider_id: Some("direct-local".into()),
                model: None,
                reasoning_effort: None,
                provider_api: Some("chat_completions".into()),
                provider_type: Some("open_ai_compatible_local".into()),
                remote: false,
                consent: "not_required".into(),
                consent_recorded_at: None,
                disclosure: None,
                extraction_state: "unavailable".into(),
                warnings: vec!["direct_local_model_not_configured".into()],
            };
        };
        let provider = LocalOpenAiClaimProvider::new(config);
        let (state, warnings) = match provider.check_model() {
            Ok(()) => ("available", Vec::new()),
            Err(LocalModelError::ModelNotFound) => {
                ("unavailable", vec!["direct_local_model_not_listed".into()])
            }
            Err(LocalModelError::Unavailable) => {
                ("unavailable", vec!["direct_local_model_unavailable".into()])
            }
        };
        ProviderStatus {
            configured: true,
            bridge_state: if state == "available" {
                "ready"
            } else {
                "unavailable"
            }
            .into(),
            provider_kind: Some("local".into()),
            provider_id: Some("direct-local".into()),
            model: Some(config.model().to_owned()),
            reasoning_effort: None,
            provider_api: Some("chat_completions".into()),
            provider_type: Some("open_ai_compatible_local".into()),
            remote: false,
            consent: "not_required".into(),
            consent_recorded_at: None,
            disclosure: None,
            extraction_state: state.into(),
            warnings,
        }
    }

    fn status_from_bridge(
        &self,
        status: RigaBridgeProviderStatus,
    ) -> Result<ProviderStatus, NipError> {
        let mut warnings = status.warnings.clone();
        let remote = status.remote();
        let (consent, consent_recorded_at, disclosure) = if !status.configured {
            warnings.push("provider_not_configured".into());
            ("not_required".to_owned(), None, None)
        } else if !remote {
            ("not_required".to_owned(), None, None)
        } else {
            let model = status.model.clone().unwrap_or_default();
            match self.store.latest_provider_consent(
                "remote",
                status.provider_id.as_deref(),
                &model,
                REMOTE_EXTRACTION_SCOPE,
            )? {
                Some(consent) if consent.action == "granted" => (
                    "granted".to_owned(),
                    Some(consent.recorded_at),
                    Some(consent.disclosure),
                ),
                Some(consent) => {
                    warnings.push("remote_consent_revoked".into());
                    (
                        "revoked".to_owned(),
                        Some(consent.recorded_at),
                        Some(consent.disclosure),
                    )
                }
                None => {
                    warnings.push("remote_consent_missing".into());
                    (
                        "missing".to_owned(),
                        None,
                        Some(status.consent_disclosure()),
                    )
                }
            }
        };
        let extraction_state = if !status.configured || status.model.is_none() {
            "unavailable"
        } else if remote && consent != "granted" {
            "consent_required"
        } else {
            "available"
        };
        Ok(ProviderStatus {
            configured: status.configured,
            bridge_state: "ready".into(),
            provider_kind: status.provider_kind,
            provider_id: status.provider_id,
            model: status.model,
            reasoning_effort: status.reasoning_effort,
            provider_api: status.provider_api,
            provider_type: status.provider_type,
            remote,
            consent,
            consent_recorded_at,
            disclosure,
            extraction_state: extraction_state.into(),
            warnings,
        })
    }

    /// Grant consent for the exact remote provider/model currently selected in
    /// RIGA. The audit row is append-only; switching profile or model requires
    /// a new grant because the binding no longer matches.
    pub fn grant_remote_consent(
        &mut self,
        actor: &str,
        reason: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<ProviderConsent, NipError> {
        if self.config.active_claim_provider() != ClaimProviderMode::Riga {
            return Err(NipError::RemoteProviderRequired);
        }
        let actor = actor.trim();
        if actor.is_empty() {
            return Err(NipError::InvalidConsentRequest);
        }
        let provider = self
            .bridge_provider()
            .ok_or(NipError::ProviderUnavailable)?;
        let status = provider
            .provider_status()
            .map_err(|_| NipError::ProviderUnavailable)?;
        if !status.configured || !status.remote() {
            return Err(NipError::RemoteProviderRequired);
        }
        let model = status
            .model
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or(NipError::RemoteProviderRequired)?;
        static CONSENT_COUNTER: AtomicU64 = AtomicU64::new(1);
        let sequence = CONSENT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let consent = ProviderConsent {
            consent_id: format!(
                "consent-{}-{}",
                now.timestamp_millis(),
                &transcript_hash(&format!(
                    "grant\0{}\0{}\0{}\0{sequence}",
                    status.provider_id.as_deref().unwrap_or("legacy"),
                    model,
                    actor
                ))[..12]
            ),
            action: "granted".into(),
            provider_kind: "remote".into(),
            provider_id: status.provider_id.clone(),
            model,
            scope: REMOTE_EXTRACTION_SCOPE.into(),
            disclosure: status.consent_disclosure(),
            actor: actor.to_owned(),
            reason: reason
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned),
            recorded_at: now,
        };
        self.store.record_provider_consent(&consent)?;
        Ok(consent)
    }

    pub fn revoke_remote_consent(
        &mut self,
        actor: &str,
        reason: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<ProviderConsent, NipError> {
        if self.config.active_claim_provider() != ClaimProviderMode::Riga {
            return Err(NipError::RemoteProviderRequired);
        }
        let actor = actor.trim();
        if actor.is_empty() {
            return Err(NipError::InvalidConsentRequest);
        }
        let provider = self
            .bridge_provider()
            .ok_or(NipError::ProviderUnavailable)?;
        let status = provider
            .provider_status()
            .map_err(|_| NipError::ProviderUnavailable)?;
        if !status.configured || !status.remote() {
            return Err(NipError::RemoteProviderRequired);
        }
        let model = status
            .model
            .clone()
            .filter(|value| !value.trim().is_empty())
            .ok_or(NipError::RemoteProviderRequired)?;
        static CONSENT_COUNTER: AtomicU64 = AtomicU64::new(1);
        let sequence = CONSENT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let consent = ProviderConsent {
            consent_id: format!(
                "consent-{}-{}",
                now.timestamp_millis(),
                &transcript_hash(&format!(
                    "revoke\0{}\0{}\0{}\0{sequence}",
                    status.provider_id.as_deref().unwrap_or("legacy"),
                    model,
                    actor
                ))[..12]
            ),
            action: "revoked".into(),
            provider_kind: "remote".into(),
            provider_id: status.provider_id.clone(),
            model,
            scope: REMOTE_EXTRACTION_SCOPE.into(),
            disclosure: status.consent_disclosure(),
            actor: actor.to_owned(),
            reason: reason
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_owned),
            recorded_at: now,
        };
        self.store.record_provider_consent(&consent)?;
        Ok(consent)
    }

    /// Resolve everything a claim extraction needs: the retained event, the
    /// bridge provider, and the consent binding. Kept separate from the call
    /// itself because a long transcript can keep the provider busy for minutes
    /// and must not hold the service lock while it runs.
    pub fn prepare_claim_extraction(
        &mut self,
        event_id: &str,
    ) -> Result<PreparedExtraction, NipError> {
        let event = self.store.event(event_id)?.ok_or(NipError::EventNotFound)?;
        if self.config.active_claim_provider() == ClaimProviderMode::DirectLocal {
            let config = self
                .config
                .local_llm()
                .ok_or(NipError::ProviderUnavailable)?;
            let provider = LocalOpenAiClaimProvider::new(config);
            provider
                .check_model()
                .map_err(|_| NipError::ProviderUnavailable)?;
            return Ok(PreparedExtraction {
                event,
                provider: PreparedClaimProvider::DirectLocal(provider),
            });
        }
        let provider = self
            .bridge_provider()
            .ok_or(NipError::ProviderUnavailable)?;
        let status = provider
            .provider_status()
            .map_err(|_| NipError::ProviderUnavailable)?;
        if !status.configured {
            return Err(NipError::ProviderUnavailable);
        }
        if status.remote() {
            let model = status.model.clone().unwrap_or_default();
            let consent = self.store.latest_provider_consent(
                "remote",
                status.provider_id.as_deref(),
                &model,
                REMOTE_EXTRACTION_SCOPE,
            )?;
            if consent.as_ref().map(|value| value.action.as_str()) != Some("granted") {
                return Err(NipError::RemoteConsentRequired);
            }
        }
        Ok(PreparedExtraction {
            event,
            provider: PreparedClaimProvider::Riga { provider, status },
        })
    }

    /// Commit claims produced by [`PreparedExtraction::extract`].
    pub fn commit_extracted_claims(&mut self, claims: &[ClaimRecord]) -> Result<(), NipError> {
        for claim in claims {
            self.store.store_claim(claim)?;
        }
        Ok(())
    }

    /// Extract claims from a retained event through the configured provider.
    /// Remote extraction performs no provider request until consent exists for
    /// the exact provider/model binding.
    pub fn extract_claims_from_event(
        &mut self,
        event_id: &str,
    ) -> Result<Vec<ClaimRecord>, NipError> {
        let prepared = self.prepare_claim_extraction(event_id)?;
        let claims = prepared.extract()?;
        self.commit_extracted_claims(&claims)?;
        Ok(claims)
    }

    fn bridge_provider(&self) -> Option<RigaBridgeClaimProvider> {
        self.config
            .riga_bridge()
            .and_then(|bridge| RigaBridgeClaimProvider::new(bridge.url(), bridge.token()).ok())
    }

    pub fn editorial_review_audit(
        &self,
        candidate_id: &str,
    ) -> Result<Vec<EditorialReviewAudit>, NipError> {
        Ok(self.store.editorial_review_audit(candidate_id)?)
    }

    pub fn claims(&self) -> Result<Vec<ClaimRecord>, NipError> {
        Ok(self.store.claims()?)
    }

    /// Record a thesis, or update the pipeline status of an existing one.
    /// The provisional gate is enforced by the store.
    pub fn save_thesis(&mut self, thesis: &ThesisRecord) -> Result<(), NipError> {
        Ok(self.store.save_thesis(thesis)?)
    }

    pub fn thesis(&self, thesis_id: &str) -> Result<Option<ThesisRecord>, NipError> {
        Ok(self.store.thesis(thesis_id)?)
    }

    /// All theses, newest decision `as_of` first.
    pub fn theses(&self) -> Result<Vec<ThesisRecord>, NipError> {
        Ok(self.store.theses()?)
    }

    /// Record a commentary transcript. Refused for provisional theses.
    pub fn save_transcript(&mut self, transcript: &TranscriptRecord) -> Result<(), NipError> {
        Ok(self.store.save_transcript(transcript)?)
    }

    pub fn transcript(&self, transcript_id: &str) -> Result<Option<TranscriptRecord>, NipError> {
        Ok(self.store.transcript(transcript_id)?)
    }

    pub fn transcripts_for_thesis(
        &self,
        thesis_id: &str,
    ) -> Result<Vec<TranscriptRecord>, NipError> {
        Ok(self.store.transcripts_for_thesis(thesis_id)?)
    }

    /// Record one ablation result (Run A vs Run B) for a thesis.
    pub fn save_backtest_evidence(
        &mut self,
        record: &BacktestEvidenceRecord,
    ) -> Result<(), NipError> {
        Ok(self.store.save_backtest_evidence(record)?)
    }

    pub fn backtest_evidence(
        &self,
        backtest_id: &str,
    ) -> Result<Option<BacktestEvidenceRecord>, NipError> {
        Ok(self.store.backtest_evidence(backtest_id)?)
    }

    pub fn backtest_evidence_for_thesis(
        &self,
        thesis_id: &str,
    ) -> Result<Vec<BacktestEvidenceRecord>, NipError> {
        Ok(self.store.backtest_evidence_for_thesis(thesis_id)?)
    }

    pub fn save_etf_mapping(&mut self, mapping: &EtfMapping) -> Result<(), NipError> {
        self.store.save_etf_mapping(mapping)?;
        Ok(())
    }

    pub fn etf_mappings(&self) -> Result<Vec<EtfMapping>, NipError> {
        Ok(self.store.etf_mappings()?)
    }

    pub fn replace_editorial_candidates(
        &mut self,
        candidates: &[EditorialCandidate],
    ) -> Result<(), NipError> {
        self.store.replace_editorial_candidates(candidates)?;
        Ok(())
    }

    pub fn editorial_candidates(&self) -> Result<Vec<EditorialCandidate>, NipError> {
        Ok(self.store.editorial_candidates()?)
    }

    pub fn review_editorial_candidate(
        &mut self,
        candidate_id: &str,
        status: &str,
        reason: &str,
        reviewer: &str,
        reviewed_at: DateTime<Utc>,
    ) -> Result<(), NipError> {
        self.store.review_editorial_candidate(
            candidate_id,
            status,
            reason,
            reviewer,
            reviewed_at,
        )?;
        Ok(())
    }

    pub fn embedding_manifests(&self) -> Result<Vec<EmbeddingIndexManifest>, NipError> {
        Ok(self.store.embedding_manifests()?)
    }

    pub fn rebuild_semantic_index(
        &mut self,
        provider: &dyn EmbeddingProvider,
        index: &QdrantIndex,
        index_id: String,
    ) -> Result<EmbeddingIndexManifest, NipError> {
        let events = self.store.all_events()?;
        let collection = index_id.replace(
            |character: char| {
                !character.is_ascii_alphanumeric() && character != '_' && character != '-'
            },
            "_",
        );
        index
            .ensure_collection()
            .map_err(|_| NipError::SemanticUnavailable)?;
        let mut ready = manifest(index_id, provider, collection, "building", 0);
        self.store.save_embedding_manifest(&ready)?;
        for event in &events {
            let text = event.content_text.as_deref().unwrap_or("");
            let vector = provider
                .embed(text)
                .map_err(|_| NipError::SemanticUnavailable)?;
            index
                .upsert(event, &vector, &ready.index_id)
                .map_err(|_| NipError::SemanticUnavailable)?;
        }
        ready.status = "ready".into();
        ready.event_count = events.len() as u32;
        ready.completed_at = Some(Utc::now());
        self.store.save_embedding_manifest(&ready)?;
        Ok(ready)
    }

    pub fn semantic_search(
        &self,
        text: &str,
        provider: &dyn EmbeddingProvider,
        index: &QdrantIndex,
        index_id: &str,
        limit: u32,
    ) -> Result<Vec<SemanticSearchResult>, NipError> {
        let vector = provider
            .embed(text)
            .map_err(|_| NipError::SemanticUnavailable)?;
        let events = event_map(&self.store.all_events()?);
        index
            .search(&vector, index_id, &events, limit.clamp(1, 50))
            .map_err(|_| NipError::SemanticUnavailable)
    }

    pub fn rebuild_clusters(
        &mut self,
        provider: &dyn EmbeddingProvider,
        run_id: String,
    ) -> Result<Vec<NarrativeCluster>, NipError> {
        let events = self.store.all_events()?;
        let labels = self.event_label_index(&events)?;
        let embedded = events
            .into_iter()
            .map(|event| {
                let vector = provider
                    .embed(event.content_text.as_deref().unwrap_or(""))
                    .map_err(|_| NipError::SemanticUnavailable)?;
                Ok((event, vector.dense))
            })
            .collect::<Result<Vec<_>, NipError>>()?;
        let clusters = cluster_events(&embedded, run_id, &labels);
        self.store.replace_clusters(&clusters)?;
        Ok(clusters)
    }

    /// Retained events carry no title, but the podcast episode row they came
    /// from does. Resolve a label per event so clusters and graph nodes read
    /// like an episode instead of a UUID, falling back to the opening text for
    /// imported documents and other event kinds.
    fn event_label_index(
        &self,
        events: &[EventRecord],
    ) -> Result<HashMap<String, String>, NipError> {
        let mut sources: Vec<SourceId> = Vec::new();
        for event in events {
            if !sources
                .iter()
                .any(|source| source.as_str() == event.source_id.as_str())
            {
                sources.push(event.source_id.clone());
            }
        }
        let mut titles: HashMap<(String, String), String> = HashMap::new();
        for source_id in sources {
            for episode in self.store.discovered_episodes(&source_id)? {
                if let (Some(native_id), Some(title)) = (episode.source_native_id, episode.title) {
                    titles.insert((source_id.as_str().to_owned(), native_id), title);
                }
            }
        }
        Ok(events
            .iter()
            .map(|event| {
                let title = event.source_native_id.as_ref().and_then(|native_id| {
                    titles
                        .get(&(event.source_id.as_str().to_owned(), native_id.clone()))
                        .cloned()
                });
                (
                    event.event_id.as_str().to_owned(),
                    title.unwrap_or_else(|| semantic::event_label(event)),
                )
            })
            .collect())
    }

    pub fn clusters(&self) -> Result<Vec<NarrativeCluster>, NipError> {
        Ok(self.store.clusters()?)
    }

    /// Validate and commit structured output from an already-run external
    /// agent. This method does not invoke an LLM or attest caller-supplied model
    /// metadata. All claims and entity candidates must point to unique exact
    /// quotes in the retained event transcript.
    pub fn build_agent_narrative_graph(
        &mut self,
        draft: AgentNarrativeGraphDraft,
    ) -> Result<(AgentNarrativeAnalysis, Vec<ClaimRecord>, NarrativeGraph), NipError> {
        if draft.event_id.trim().is_empty()
            || draft.producer.trim().is_empty()
            || draft.model.trim().is_empty()
            || draft.prompt_version.trim().is_empty()
            || draft.narrative_title.trim().is_empty()
            || draft.narrative_title.chars().count() > 160
            || draft.narrative_thesis.trim().is_empty()
            || draft.narrative_thesis.chars().count() > 600
            || draft.narrative_summary.chars().count() > 1600
            || draft.claims.is_empty()
            || draft.claims.len() > 30
            || draft.entities.is_empty()
            || draft.entities.len() > 40
        {
            return Err(NipError::AgentAnalysisRejected(
                "required metadata is missing or the analysis exceeds size limits".into(),
            ));
        }
        let event = self
            .store
            .event(&draft.event_id)?
            .ok_or(NipError::EventNotFound)?;
        let transcript = event
            .content_text
            .as_deref()
            .filter(|text| !text.trim().is_empty())
            .ok_or_else(|| {
                NipError::AgentAnalysisRejected("the retained event has no transcript text".into())
            })?;

        let draft_json = serde_json::to_vec(&draft).map_err(|_| {
            NipError::AgentAnalysisRejected("the request could not be fingerprinted".into())
        })?;
        let draft_hash = transcript_hash(std::str::from_utf8(&draft_json).map_err(|_| {
            NipError::AgentAnalysisRejected("the request fingerprint is not valid UTF-8".into())
        })?);
        let analysis_id = format!("agent-analysis-{}", &draft_hash[..24]);
        let extraction_run_id = format!("agent-run-{}", &draft_hash[..24]);

        let mut entity_by_key = BTreeMap::new();
        let mut entities = Vec::with_capacity(draft.entities.len());
        for (entity_index, entity) in draft.entities.iter().enumerate() {
            let name_key = normalize_agent_entity_name(&entity.canonical_name);
            if name_key.is_empty()
                || entity.canonical_name.chars().count() > 200
                || entity.surface_form.trim().is_empty()
                || entity.surface_form.chars().count() > 160
                || !matches!(
                    entity.entity_type.as_str(),
                    "person"
                        | "organization"
                        | "company"
                        | "product"
                        | "place"
                        | "country"
                        | "government_body"
                        | "concept"
                        | "other"
                )
                || entity_by_key.contains_key(&name_key)
            {
                return Err(NipError::AgentAnalysisRejected(
                    "entity candidates must have unique names, supported types and bounded labels"
                        .into(),
                ));
            }
            let (start, end) = unique_transcript_span(
                transcript,
                &entity.evidence_quote,
                &format!("entities[{entity_index}].evidence_quote"),
            )?;
            if !entity.evidence_quote.contains(&entity.surface_form) {
                return Err(NipError::AgentAnalysisRejected(format!(
                    "entity evidence does not contain its cited surface form: {}",
                    entity.canonical_name
                )));
            }
            let entity_id = format!(
                "candidate-{}",
                &transcript_hash(&format!("{analysis_id}:{}", name_key))[..24]
            );
            entity_by_key.insert(name_key, entity_id.clone());
            entities.push(AgentEntityCandidate {
                entity_id,
                canonical_name: entity.canonical_name.trim().to_owned(),
                entity_type: entity.entity_type.clone(),
                surface_form: entity.surface_form.trim().to_owned(),
                resolution_status: "unresolved_candidate".into(),
                evidence: ClaimEvidence {
                    event_id: event.event_id.clone(),
                    quote: Some(entity.evidence_quote.clone()),
                    start_offset: Some(start),
                    end_offset: Some(end),
                },
            });
        }

        let mut claims = Vec::with_capacity(draft.claims.len());
        let mut claim_annotations = Vec::with_capacity(draft.claims.len());
        for (index, claim) in draft.claims.iter().enumerate() {
            if claim.claim_text.trim().is_empty()
                || claim.claim_text.chars().count() > 1000
                || claim.confidence_millis > 1000
                || !matches!(
                    claim.claim_type.as_str(),
                    "fact"
                        | "measurement"
                        | "causal"
                        | "forecast"
                        | "guidance"
                        | "risk"
                        | "opinion"
                        | "other"
                )
                || claim.entity_names.is_empty()
                || claim.entity_names.len() > 12
                || claim.polarity.as_deref().is_some_and(|value| {
                    !matches!(
                        value,
                        "positive" | "negative" | "neutral" | "mixed" | "unknown"
                    )
                })
                || claim
                    .horizon
                    .as_deref()
                    .is_some_and(|value| value.chars().count() > 120)
            {
                return Err(NipError::AgentAnalysisRejected(format!(
                    "claim {} has invalid or incomplete fields",
                    index + 1
                )));
            }
            let (start, end) = unique_transcript_span(
                transcript,
                &claim.evidence_quote,
                &format!("claims[{index}].evidence_quote"),
            )?;
            let mut linked_entity_ids = Vec::new();
            let mut seen_links = BTreeSet::new();
            for entity_name in &claim.entity_names {
                let key = normalize_agent_entity_name(entity_name);
                let entity_id = entity_by_key.get(&key).ok_or_else(|| {
                    NipError::AgentAnalysisRejected(format!(
                        "claim {} refers to an entity candidate not declared in entities",
                        index + 1
                    ))
                })?;
                if seen_links.insert(entity_id.clone()) {
                    linked_entity_ids.push(entity_id.clone());
                }
            }
            let claim_id = format!(
                "claim-{}",
                &transcript_hash(&format!("{analysis_id}:{index}:{}", claim.claim_text))[..24]
            );
            claims.push(ClaimRecord {
                claim_id: claim_id.clone(),
                claim_text: claim.claim_text.trim().to_owned(),
                speaker_or_author: claim.speaker_or_author.clone(),
                confidence_millis: claim.confidence_millis,
                extraction_run_id: extraction_run_id.clone(),
                provider: "external_agent_payload".into(),
                model: draft.model.trim().to_owned(),
                prompt_version: draft.prompt_version.trim().to_owned(),
                provider_kind: Some("external_agent".into()),
                provider_profile_id: None,
                reasoning_effort: None,
                extracted_at: Utc::now(),
                extraction_tier: claim.extraction_tier,
                review_status: claim.review_status,
                evidence: vec![ClaimEvidence {
                    event_id: event.event_id.clone(),
                    quote: Some(claim.evidence_quote.clone()),
                    start_offset: Some(start),
                    end_offset: Some(end),
                }],
            });
            claim_annotations.push(AgentClaimAnnotation {
                claim_id,
                claim_type: claim.claim_type.clone(),
                entity_ids: linked_entity_ids,
                polarity: claim.polarity.clone(),
                horizon: claim.horizon.clone(),
            });
        }

        let analysis = AgentNarrativeAnalysis {
            analysis_id,
            event_id: event.event_id.as_str().to_owned(),
            source_content_hash: event.content_hash.clone(),
            narrative_title: draft.narrative_title.trim().to_owned(),
            narrative_thesis: draft.narrative_thesis.trim().to_owned(),
            narrative_summary: draft.narrative_summary.trim().to_owned(),
            extraction_run_id: extraction_run_id.clone(),
            producer: draft.producer.trim().to_owned(),
            model: draft.model.trim().to_owned(),
            prompt_version: draft.prompt_version.trim().to_owned(),
            provenance_status: "caller_declared_external_agent_unattested".into(),
            created_at: Utc::now(),
            entities,
            claim_annotations,
        };
        self.store
            .save_agent_narrative_analysis(&analysis, &claims)?;
        let graph = self.rebuild_graph(extraction_run_id)?;
        Ok((analysis, claims, graph))
    }

    pub fn rebuild_graph(&mut self, run_id: String) -> Result<NarrativeGraph, NipError> {
        let clusters = self.store.clusters()?;
        let claims = self.store.claims()?;
        let agent_analyses = self.store.agent_narrative_analyses()?;
        let events = self.store.all_events()?;
        let labels = self.event_label_index(&events)?;
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut event_nodes = BTreeSet::new();
        // Every retained event is an origin node, even before claims or
        // clusters exist. The graph then always shows where a derivation came
        // from instead of an empty projection.
        for event in &events {
            let event_id = event.event_id.as_str().to_owned();
            if !event_nodes.insert(event_id.clone()) {
                continue;
            }
            nodes.push(NarrativeGraphNode {
                node_id: format!("event:{event_id}"),
                node_type: "event".into(),
                label: labels
                    .get(&event_id)
                    .cloned()
                    .unwrap_or_else(|| semantic::event_label(event)),
                evidence_event_ids: vec![event_id],
            });
        }
        for cluster in &clusters {
            let evidence: Vec<String> = cluster
                .members
                .iter()
                .map(|member| member.event_id.as_str().to_owned())
                .collect();
            nodes.push(NarrativeGraphNode {
                node_id: format!("narrative:{}", cluster.cluster_id),
                node_type: "narrative".into(),
                label: cluster.label.clone(),
                evidence_event_ids: evidence.clone(),
            });
            for member in &cluster.members {
                let event_id = member.event_id.as_str().to_owned();
                if event_nodes.insert(event_id.clone()) {
                    nodes.push(NarrativeGraphNode {
                        node_id: format!("event:{event_id}"),
                        node_type: "event".into(),
                        label: labels
                            .get(event_id.as_str())
                            .cloned()
                            .unwrap_or_else(|| event_id.clone()),
                        evidence_event_ids: vec![event_id.clone()],
                    });
                }
                edges.push(NarrativeGraphEdge {
                    edge_id: format!("edge:narrative:{}:event:{event_id}", cluster.cluster_id),
                    from_node_id: format!("narrative:{}", cluster.cluster_id),
                    to_node_id: format!("event:{event_id}"),
                    edge_type: "narrative_membership".into(),
                    evidence_event_ids: vec![event_id],
                    confidence_millis: member.similarity_millis,
                    derivation_run_id: run_id.clone(),
                });
            }
        }
        let claim_confidence: HashMap<String, u16> = claims
            .iter()
            .map(|claim| (claim.claim_id.clone(), claim.confidence_millis))
            .collect();
        for claim in &claims {
            let claim_node = format!("claim:{}", claim.claim_id);
            let evidence: Vec<String> = claim
                .evidence
                .iter()
                .map(|item| item.event_id.as_str().to_owned())
                .collect();
            nodes.push(NarrativeGraphNode {
                node_id: claim_node.clone(),
                node_type: "claim".into(),
                label: claim.claim_text.clone(),
                evidence_event_ids: evidence.clone(),
            });
            for (index, event_id) in evidence.iter().enumerate() {
                if event_nodes.insert(event_id.clone()) {
                    nodes.push(NarrativeGraphNode {
                        node_id: format!("event:{event_id}"),
                        node_type: "event".into(),
                        label: labels
                            .get(event_id.as_str())
                            .cloned()
                            .unwrap_or_else(|| event_id.clone()),
                        evidence_event_ids: vec![event_id.clone()],
                    });
                }
                edges.push(NarrativeGraphEdge {
                    edge_id: format!("edge:claim:{}:{index}", claim.claim_id),
                    from_node_id: claim_node.clone(),
                    to_node_id: format!("event:{event_id}"),
                    edge_type: "claim_support".into(),
                    evidence_event_ids: vec![event_id.clone()],
                    confidence_millis: claim.confidence_millis,
                    derivation_run_id: run_id.clone(),
                });
            }
        }
        let mut entity_nodes = BTreeSet::new();
        for analysis in &agent_analyses {
            let event_id = analysis.event_id.clone();
            let narrative_node = format!("agent_narrative:{}", analysis.analysis_id);
            nodes.push(NarrativeGraphNode {
                node_id: narrative_node.clone(),
                node_type: "agent_narrative".into(),
                label: format!(
                    "{} — {}",
                    analysis.narrative_title, analysis.narrative_thesis
                ),
                evidence_event_ids: vec![event_id.clone()],
            });
            edges.push(NarrativeGraphEdge {
                edge_id: format!("edge:agent-narrative:{}:event", analysis.analysis_id),
                from_node_id: narrative_node.clone(),
                to_node_id: format!("event:{event_id}"),
                edge_type: "narrative_evidence".into(),
                evidence_event_ids: vec![event_id.clone()],
                confidence_millis: 1000,
                derivation_run_id: analysis.extraction_run_id.clone(),
            });
            for entity in &analysis.entities {
                if entity_nodes.insert(entity.entity_id.clone()) {
                    nodes.push(NarrativeGraphNode {
                        node_id: format!("entity_candidate:{}", entity.entity_id),
                        node_type: "entity_candidate".into(),
                        label: format!(
                            "{} ({}, unresolved candidate)",
                            entity.canonical_name, entity.entity_type
                        ),
                        evidence_event_ids: vec![event_id.clone()],
                    });
                }
                edges.push(NarrativeGraphEdge {
                    edge_id: format!("edge:entity-candidate:{}:event", entity.entity_id),
                    from_node_id: format!("entity_candidate:{}", entity.entity_id),
                    to_node_id: format!("event:{event_id}"),
                    edge_type: "entity_mention_evidence".into(),
                    evidence_event_ids: vec![event_id.clone()],
                    confidence_millis: 1000,
                    derivation_run_id: analysis.extraction_run_id.clone(),
                });
            }
            for annotation in &analysis.claim_annotations {
                let claim_node = format!("claim:{}", annotation.claim_id);
                edges.push(NarrativeGraphEdge {
                    edge_id: format!(
                        "edge:agent-narrative:{}:claim:{}",
                        analysis.analysis_id, annotation.claim_id
                    ),
                    from_node_id: narrative_node.clone(),
                    to_node_id: claim_node.clone(),
                    edge_type: "narrative_claim".into(),
                    evidence_event_ids: vec![event_id.clone()],
                    confidence_millis: *claim_confidence.get(&annotation.claim_id).unwrap_or(&0),
                    derivation_run_id: analysis.extraction_run_id.clone(),
                });
                for entity_id in &annotation.entity_ids {
                    edges.push(NarrativeGraphEdge {
                        edge_id: format!("edge:claim:{}:entity:{}", annotation.claim_id, entity_id),
                        from_node_id: claim_node.clone(),
                        to_node_id: format!("entity_candidate:{entity_id}"),
                        edge_type: "claim_about_entity_candidate".into(),
                        evidence_event_ids: vec![event_id.clone()],
                        confidence_millis: *claim_confidence
                            .get(&annotation.claim_id)
                            .unwrap_or(&0),
                        derivation_run_id: analysis.extraction_run_id.clone(),
                    });
                }
            }
        }
        let graph = NarrativeGraph {
            graph_id: format!("graph-{run_id}"),
            derivation_run_id: run_id,
            algorithm_version: "nip-graph-v2-agent-analysis".into(),
            created_at: Utc::now(),
            nodes,
            edges,
        };
        self.store.save_graph(&graph)?;
        Ok(graph)
    }

    /// The retained transcript event for a podcast episode, if it has been
    /// committed. This is the origin the UI links back to.
    pub fn event_for_episode(
        &self,
        episode: &PodcastEpisode,
    ) -> Result<Option<EventRecord>, NipError> {
        let Some(native_id) = episode.source_native_id.as_deref() else {
            return Ok(None);
        };
        Ok(self
            .store
            .event_for_source_native(&episode.source_id, native_id)?)
    }

    pub fn graph(&self) -> Result<Option<NarrativeGraph>, NipError> {
        Ok(self.store.latest_graph()?)
    }

    pub fn agent_narrative_analyses(&self) -> Result<Vec<AgentNarrativeAnalysis>, NipError> {
        Ok(self.store.agent_narrative_analyses()?)
    }

    pub fn extraction_status(&self) -> Result<ExtractionStatus, NipError> {
        let claims = self.store.claims()?;
        let mut runs = BTreeSet::new();
        let mut evidence_linked = 0u32;
        for claim in &claims {
            runs.insert(claim.extraction_run_id.clone());
            if !claim.evidence.is_empty() {
                evidence_linked += 1;
            }
        }
        let latest = claims.iter().max_by_key(|claim| claim.extracted_at);
        Ok(ExtractionStatus {
            observed_at: Utc::now(),
            state: if claims.is_empty() {
                "idle"
            } else {
                "succeeded"
            }
            .into(),
            claim_count: claims.len() as u32,
            extraction_run_count: runs.len() as u32,
            latest_run_id: latest.map(|claim| claim.extraction_run_id.clone()),
            latest_provider: latest.map(|claim| claim.provider.clone()),
            latest_model: latest.map(|claim| claim.model.clone()),
            latest_prompt_version: latest.map(|claim| claim.prompt_version.clone()),
            latest_extracted_at: latest.map(|claim| claim.extracted_at),
            evidence_linked_claim_count: evidence_linked,
            warnings: if claims.iter().any(|claim| claim.evidence.is_empty()) {
                vec!["claims_without_evidence".into()]
            } else {
                Vec::new()
            },
        })
    }

    pub fn resource_status(&self) -> Result<ResourceStatus, NipError> {
        let events = self.store.all_events()?;
        let claims = self.store.claims()?;
        let clusters = self.store.clusters()?;
        let graph = self.store.latest_graph()?;
        let manifests = self.store.embedding_manifests()?;
        let metadata_bytes = fs::metadata(self.store.database_path())
            .map(|meta| meta.len())
            .unwrap_or(0);
        let latest_manifest = manifests.first();
        let mut warnings = Vec::new();
        if latest_manifest.is_none() {
            warnings.push("semantic_index_not_built".into());
        } else if latest_manifest.is_some_and(|manifest| manifest.status != "ready") {
            warnings.push("semantic_index_not_ready".into());
        }
        if graph.is_none() {
            warnings.push("graph_projection_not_built".into());
        }
        Ok(ResourceStatus {
            observed_at: Utc::now(),
            database_path: self.store.database_path().display().to_string(),
            database_bytes: metadata_bytes,
            event_count: events.len() as u32,
            claim_count: claims.len() as u32,
            extraction_run_count: claims
                .iter()
                .map(|claim| claim.extraction_run_id.as_str())
                .collect::<BTreeSet<_>>()
                .len() as u32,
            cluster_count: clusters.len() as u32,
            graph_edge_count: graph.as_ref().map_or(0, |value| value.edges.len() as u32),
            scheduler_interval_seconds: 21_600,
            scheduler_state: "process_lifetime".into(),
            semantic_index_state: latest_manifest
                .map_or_else(|| "not_built".into(), |manifest| manifest.status.clone()),
            semantic_model: latest_manifest.map(|manifest| manifest.model_id.clone()),
            warnings,
        })
    }

    /// Build the first descriptive signal release from immutable DuckDB events.
    /// Coverage remains explicit and unknown until a completeness manifest is
    /// supplied by the host; no missing observation is treated as zero.
    pub fn signal_snapshot(
        &self,
        as_of: DateTime<Utc>,
    ) -> Result<NarrativeSignalSnapshot, NipError> {
        let current_end = monday_start(as_of);
        let current_start = current_end - Duration::days(7);
        let prior_start = current_start - Duration::days(7);
        let clusters = self.store.clusters()?;
        let mut event_narrative = HashMap::new();
        let mut labels = HashMap::new();
        for cluster in clusters {
            labels.insert(cluster.cluster_id.clone(), cluster.label);
            for member in cluster.members {
                event_narrative.insert(member.event_id, cluster.cluster_id.clone());
            }
        }
        let mut grouped: BTreeMap<String, Vec<(EventRecord, String)>> = BTreeMap::new();
        for (event, category) in self.store.events_with_source_categories(Some(as_of))? {
            let narrative_id = event_narrative
                .get(&event.event_id)
                .cloned()
                .unwrap_or_else(|| format!("event:{}", event.event_id.as_str()));
            grouped
                .entry(narrative_id)
                .or_default()
                .push((event, category));
        }
        let signals = grouped
            .into_iter()
            .map(|(narrative_id, events)| {
                let current = events
                    .iter()
                    .filter(|(event, _)| {
                        in_window(event.times.published_at, current_start, current_end)
                    })
                    .count() as u32;
                let prior = events
                    .iter()
                    .filter(|(event, _)| {
                        in_window(event.times.published_at, prior_start, current_start)
                    })
                    .count() as u32;
                let category_counts = events
                    .iter()
                    .filter(|(event, _)| {
                        in_window(event.times.published_at, current_start, current_end)
                    })
                    .fold(BTreeMap::new(), |mut counts, (_, category)| {
                        *counts.entry(category.clone()).or_insert(0) += 1;
                        counts
                    });
                let mut flags = vec!["coverage_manifest_missing".to_owned()];
                if prior == 0 {
                    flags.push("no_comparable_baseline".to_owned());
                }
                if events
                    .iter()
                    .any(|(event, _)| event.times.published_at.is_none())
                {
                    flags.push("undated_events_excluded".to_owned());
                }
                NarrativeSignal {
                    narrative_id: narrative_id.clone(),
                    label: labels
                        .get(&narrative_id)
                        .cloned()
                        .unwrap_or_else(|| "Unclustered observation".into()),
                    current_week_start: current_start,
                    current_week_end: current_end,
                    prior_week_start: prior_start,
                    prior_week_end: current_start,
                    current_count: current,
                    prior_count: prior,
                    mentions_per_day: current as f64 / 7.0,
                    prior_mentions_per_day: prior as f64 / 7.0,
                    delta_mentions_per_day: (current as f64 - prior as f64) / 7.0,
                    percent_change: (prior > 0)
                        .then(|| ((current as f64 - prior as f64) / prior as f64) * 100.0),
                    distinct_source_categories: category_counts.len() as u32,
                    category_counts,
                    persistence_complete_weeks: observed_persistence(&events, current_start),
                    first_published_at: events
                        .iter()
                        .filter_map(|(event, _)| event.times.published_at)
                        .min(),
                    first_ingested_at: events
                        .iter()
                        .map(|(event, _)| event.times.ingested_at)
                        .min(),
                    evidence_event_ids: events
                        .iter()
                        .map(|(event, _)| event.event_id.as_str().to_owned())
                        .collect(),
                    coverage: "unknown".into(),
                    data_quality_flags: flags,
                }
            })
            .filter(|signal| signal.current_count > 0 || signal.prior_count > 0)
            .collect();
        Ok(NarrativeSignalSnapshot {
            formula_version: "nip-signals-v1".into(),
            source_category_taxonomy_version: "nip-source-categories-v1".into(),
            derivation_run_id: format!("signal-run-{}", as_of.timestamp_millis()),
            as_of,
            current_week_start: current_start,
            current_week_end: current_end,
            coverage: "unknown".into(),
            signals,
        })
    }

    /// Transcribe already staged, approved audio through an injected local
    /// provider and commit only a validated transcript through the NIP store.
    /// Audio download and source policy remain outside the provider boundary.
    pub fn transcribe_podcast_episode(
        &mut self,
        episode: &PodcastEpisode,
        request: AsrRequest,
        provider: &dyn AsrProvider,
        now: DateTime<Utc>,
    ) -> Result<PodcastTranscript, NipError> {
        self.ensure_nip_owned_source(&episode.source_id)?;
        if self.store.subscription(&episode.source_id)?.is_none() {
            return Err(NipError::SubscriptionNotFound);
        }
        let result = match provider.transcribe(&request) {
            Ok(result) => result,
            Err(error) => {
                let state = match error {
                    AsrError::Unavailable | AsrError::Timeout | AsrError::Cancelled => {
                        PodcastEpisodeState::TranscriptionUnavailable
                    }
                    AsrError::InvalidInput
                    | AsrError::MalformedOutput
                    | AsrError::AudioPreparation
                    | AsrError::OutOfMemory
                    | AsrError::ProviderError(_) => PodcastEpisodeState::Failed,
                };
                self.store.set_episode_state(episode, state)?;
                return Err(match state {
                    PodcastEpisodeState::TranscriptionUnavailable => {
                        NipError::TranscriptionUnavailable
                    }
                    _ => NipError::TranscriptionFailed,
                });
            }
        };
        if result.text.trim().is_empty() {
            self.store
                .set_episode_state(episode, PodcastEpisodeState::Failed)?;
            return Err(NipError::TranscriptionFailed);
        }
        self.commit_podcast_transcript(episode, result, now)
    }

    /// Commit a provider result after the caller has finished the (potentially
    /// long) audio download and ASR call. Keeping the service lock out of that
    /// work lets health, scan and source calls continue while a local model runs.
    pub fn commit_podcast_transcript(
        &mut self,
        episode: &PodcastEpisode,
        result: AsrResult,
        now: DateTime<Utc>,
    ) -> Result<PodcastTranscript, NipError> {
        self.ensure_nip_owned_source(&episode.source_id)?;
        if self.store.subscription(&episode.source_id)?.is_none() {
            return Err(NipError::SubscriptionNotFound);
        }
        if result.text.trim().is_empty() {
            self.store
                .set_episode_state(episode, PodcastEpisodeState::Failed)?;
            return Err(NipError::TranscriptionFailed);
        }
        let transcript = PodcastTranscript {
            source_id: episode.source_id.clone(),
            source_native_id: episode.source_native_id.clone(),
            canonical_url: episode.canonical_url.clone(),
            content_hash: transcript_hash(&result.text),
            transcript_text: result.text,
            detected_language: result.language,
            provenance_json: serde_json::to_string(&result.provenance)
                .map_err(|_| NipError::TranscriptionFailed)?,
            transcribed_at: now,
        };
        self.store.store_transcript(episode, &transcript)?;
        Ok(transcript)
    }

    /// Persist the terminal episode state after a provider failure.
    pub fn record_transcription_failure(
        &mut self,
        episode: &PodcastEpisode,
        error: AsrError,
    ) -> Result<(), NipError> {
        self.ensure_nip_owned_source(&episode.source_id)?;
        let state = match error {
            AsrError::Unavailable | AsrError::Timeout | AsrError::Cancelled => {
                PodcastEpisodeState::TranscriptionUnavailable
            }
            AsrError::InvalidInput
            | AsrError::MalformedOutput
            | AsrError::AudioPreparation
            | AsrError::OutOfMemory
            | AsrError::ProviderError(_) => PodcastEpisodeState::Failed,
        };
        self.store.set_episode_state(episode, state)?;
        Ok(())
    }

    pub fn transcribe_podcast_episode_from_enclosure(
        &mut self,
        episode: &PodcastEpisode,
        audio_client: &dyn AudioClient,
        provider: &dyn AsrProvider,
        now: DateTime<Utc>,
    ) -> Result<PodcastTranscript, NipError> {
        self.ensure_nip_owned_source(&episode.source_id)?;
        if let Some(transcript) = self.publisher_transcript(episode, audio_client, now)? {
            return Ok(transcript);
        }
        let request = podcast_asr_request(episode, audio_client)?;
        self.transcribe_podcast_episode(episode, request, provider, now)
    }

    /// Prefer the transcript the publisher advertises in the feed. Publisher
    /// text is authored, complete and costs one request, so running a local
    /// model over the same audio is wasted work. Any failure falls through to
    /// ASR instead of failing the episode.
    pub fn publisher_transcript(
        &mut self,
        episode: &PodcastEpisode,
        audio_client: &dyn AudioClient,
        now: DateTime<Utc>,
    ) -> Result<Option<PodcastTranscript>, NipError> {
        self.ensure_nip_owned_source(&episode.source_id)?;
        let Some(url) = episode.transcript_url.as_deref() else {
            return Ok(None);
        };
        let Ok(response) = audio_client.fetch(url) else {
            return Ok(None);
        };
        if response.status != 200
            || response.body.is_empty()
            || response.body.len() > MAX_PUBLISHER_TRANSCRIPT_BYTES
        {
            return Ok(None);
        }
        let Ok(body) = String::from_utf8(response.body) else {
            return Ok(None);
        };
        let text = podcast::publisher_transcript_text(&body, episode.transcript_type.as_deref());
        if text.trim().len() < MIN_PUBLISHER_TRANSCRIPT_CHARS {
            return Ok(None);
        }
        let content_hash = transcript_hash(&text);
        let provenance = serde_json::json!({
            "source": "publisher_transcript",
            "url": url,
            "declared_type": episode.transcript_type,
        });
        let transcript = PodcastTranscript {
            source_id: episode.source_id.clone(),
            source_native_id: episode.source_native_id.clone(),
            canonical_url: episode.canonical_url.clone(),
            content_hash,
            transcript_text: text,
            detected_language: None,
            provenance_json: provenance.to_string(),
            transcribed_at: now,
        };
        self.store.store_transcript(episode, &transcript)?;
        Ok(Some(transcript))
    }
}

const MAX_PUBLISHER_TRANSCRIPT_BYTES: usize = 8 * 1024 * 1024;
const MIN_PUBLISHER_TRANSCRIPT_CHARS: usize = 200;

/// Download and validate a podcast enclosure into the narrow ASR request. This
/// performs no ASR and takes no NIP store lock.
pub fn podcast_asr_request(
    episode: &PodcastEpisode,
    audio_client: &dyn AudioClient,
) -> Result<AsrRequest, NipError> {
    let enclosure = episode
        .enclosure_url
        .as_deref()
        .ok_or(NipError::UnsupportedAudio)?;
    let response = audio_client
        .fetch(enclosure)
        .map_err(|_| NipError::AudioUnavailable)?;
    if response.status != 200 || response.body.is_empty() {
        return Err(NipError::AudioUnavailable);
    }
    let mime_type = response
        .content_type
        .as_deref()
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .filter(|value| value.starts_with("audio/"))
        .ok_or(NipError::UnsupportedAudio)?;
    let file_name = enclosure
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("episode.audio");
    Ok(AsrRequest {
        job_id: format!("episode-{}", stable_episode_job_id(episode)),
        audio: response.body,
        audio_path: None,
        file_name: file_name.to_owned(),
        mime_type: mime_type.to_owned(),
        language: None,
        return_timestamps: false,
    })
}

fn normalize_agent_entity_name(name: &str) -> String {
    name.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn unique_transcript_span(
    text: &str,
    quote: &str,
    field_path: &str,
) -> Result<(u32, u32), NipError> {
    if quote.trim().is_empty() || quote.chars().count() > 4000 {
        return Err(NipError::AgentAnalysisRejected(format!(
            "{field_path} is empty or exceeds the maximum length"
        )));
    }
    let text_chars: Vec<char> = text.chars().collect();
    let quote_chars: Vec<char> = quote.chars().collect();
    let matches: Vec<usize> = text_chars
        .windows(quote_chars.len())
        .enumerate()
        .filter_map(|(index, window)| (window == quote_chars.as_slice()).then_some(index))
        .collect();
    if matches.len() != 1 {
        return Err(NipError::AgentAnalysisRejected(format!(
            "{field_path} must occur exactly once in the retained transcript; found {} matches. Copy the quote verbatim, including spelling, punctuation, spacing and capitalization",
            matches.len(),
        )));
    }
    let start = u32::try_from(matches[0]).map_err(|_| {
        NipError::AgentAnalysisRejected("transcript evidence offset is out of range".into())
    })?;
    let end = u32::try_from(matches[0] + quote_chars.len()).map_err(|_| {
        NipError::AgentAnalysisRejected("transcript evidence offset is out of range".into())
    })?;
    Ok((start, end))
}

fn transcript_hash(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn stable_episode_job_id(episode: &PodcastEpisode) -> String {
    let identity = episode
        .source_native_id
        .as_deref()
        .or(episode.canonical_url.as_deref())
        .unwrap_or("unknown");
    let digest = Sha256::digest(identity.as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn clamp_per_scan_limit(limit: Option<u32>) -> u32 {
    limit.unwrap_or(3).clamp(1, 10)
}

fn clamp_poll_interval(minutes: Option<u32>) -> u32 {
    minutes.unwrap_or(360).clamp(15, 24 * 60)
}

fn map_feed_url_error(_: FeedValidationError) -> NipError {
    NipError::InvalidFeedUrl
}

fn monday_start(value: DateTime<Utc>) -> DateTime<Utc> {
    let days = value.weekday().num_days_from_monday() as i64;
    Utc.with_ymd_and_hms(value.year(), value.month(), value.day(), 0, 0, 0)
        .single()
        .unwrap()
        - Duration::days(days)
}

fn in_window(value: Option<DateTime<Utc>>, start: DateTime<Utc>, end: DateTime<Utc>) -> bool {
    value.is_some_and(|published| published >= start && published < end)
}

fn observed_persistence(events: &[(EventRecord, String)], current_start: DateTime<Utc>) -> u32 {
    let mut count = 0;
    let mut end = current_start;
    for _ in 0..104 {
        let start = end - Duration::days(7);
        if events
            .iter()
            .any(|(event, _)| in_window(event.times.published_at, start, end))
        {
            count += 1;
            end = start;
        } else {
            break;
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantic::DeterministicEmbeddingProvider;
    use nip_domain::{
        AcquisitionAvailability, AcquisitionContentKind, AcquisitionItem, AcquisitionProducer,
        AcquisitionTranscript,
    };
    use serde_json::{json, Value};
    use std::collections::BTreeMap;
    use std::thread;
    use tempfile::tempdir;

    #[test]
    fn health_and_capabilities_report_only_implemented_foundation() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        let config = NipConfig::resolve(
            &BTreeMap::from([(
                "NIP_LAKE_DIR".to_owned(),
                root.join("lake").to_string_lossy().into_owned(),
            )]),
            root,
            None,
            true,
        )
        .unwrap();
        let service = NipService::open(config).unwrap();

        let health = service.health();
        assert_eq!(health.service, "nip-engine");
        assert_eq!(health.readiness, Readiness::Ready);
        assert_eq!(health.schema_version, 22);

        let capabilities = service.capabilities();
        assert!(capabilities.features.duckdb_store);
        assert!(capabilities.features.podcast_rss_subscriptions);
        assert!(!capabilities.features.local_audio_transcription);
        assert!(!capabilities.features.claim_extraction);
        assert!(capabilities.features.parquet_export);
        assert!(capabilities.features.semantic_search);
    }

    #[test]
    fn service_initialization_creates_only_nip_database_directory() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        let lake_dir = root.join("narrative-lake");
        let data_dir = lake_dir.join("_nip");
        let tac_dir = root.join(".lake");
        let config = NipConfig::resolve(
            &BTreeMap::from([
                (
                    "NIP_LAKE_DIR".to_owned(),
                    lake_dir.to_string_lossy().into_owned(),
                ),
                (
                    "TAC_LAKE_DIR".to_owned(),
                    tac_dir.to_string_lossy().into_owned(),
                ),
            ]),
            root,
            None,
            true,
        )
        .unwrap();
        let service = NipService::open(config).unwrap();
        assert!(data_dir.join("nip.duckdb").is_file());
        assert!(!tac_dir.exists());
        assert_eq!(service.config().lake_dir(), lake_dir);
    }

    #[derive(Default)]
    struct FixtureFeedClient {
        responses: std::sync::Mutex<std::collections::VecDeque<podcast::FeedResponse>>,
        requests: std::sync::Mutex<Vec<FeedRequest>>,
    }

    impl FixtureFeedClient {
        fn with_responses(responses: Vec<podcast::FeedResponse>) -> Self {
            Self {
                responses: std::sync::Mutex::new(responses.into()),
                requests: std::sync::Mutex::new(Vec::new()),
            }
        }

        fn call_count(&self) -> usize {
            self.requests.lock().unwrap().len()
        }
    }

    impl FeedClient for FixtureFeedClient {
        fn fetch(
            &self,
            request: &FeedRequest,
        ) -> Result<podcast::FeedResponse, podcast::FeedClientError> {
            self.requests.lock().unwrap().push(request.clone());
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or(podcast::FeedClientError::Request)
        }
    }

    fn service_at(root: &std::path::Path) -> NipService {
        let config = NipConfig::resolve(
            &BTreeMap::from([(
                "NIP_LAKE_DIR".to_owned(),
                root.join("lake").to_string_lossy().into_owned(),
            )]),
            root,
            None,
            true,
        )
        .unwrap();
        NipService::open(config).unwrap()
    }

    fn service_with_scraper_ownership_at(
        root: &std::path::Path,
        feed_urls: &[&str],
        site_ids: &[&str],
    ) -> NipService {
        let mut config = NipConfig::resolve(
            &BTreeMap::from([(
                "NIP_LAKE_DIR".to_owned(),
                root.join("lake").to_string_lossy().into_owned(),
            )]),
            root,
            None,
            true,
        )
        .unwrap();
        let feed_urls = feed_urls
            .iter()
            .map(|feed| (*feed).to_owned())
            .collect::<Vec<_>>();
        let site_ids = site_ids
            .iter()
            .map(|site| (*site).to_owned())
            .collect::<Vec<_>>();
        config
            .set_acquisition_inventory(&feed_urls, &site_ids)
            .unwrap();
        NipService::open(config).unwrap()
    }

    #[test]
    fn explicit_acquisition_binding_is_confirmed_audited_and_stale_safe() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        let mut config = NipConfig::resolve(
            &BTreeMap::from([(
                "NIP_LAKE_DIR".to_owned(),
                root.join("lake").to_string_lossy().into_owned(),
            )]),
            root,
            None,
            true,
        )
        .unwrap();
        config
            .set_acquisition_site_profiles(vec![acquisition::AcquisitionSiteProfile {
                site_id: "fixture-site".into(),
                display_name: "Fixture podcast worker".into(),
                kind: "podcast".into(),
                enabled: true,
                poll_interval_min: 60,
                feed_url: Some("https://fixture.test/feed.xml/".into()),
                source_seed_status: "observed".into(),
                schedule_seed_status: "observed".into(),
                credential_status: "not_required".into(),
            }])
            .unwrap();
        let mut service = NipService::open(config).unwrap();
        let source_id = SourceId::new("fixture-source").unwrap();
        let now: DateTime<Utc> = "2026-11-28T00:00:00Z".parse().unwrap();
        service
            .store
            .insert_source(&NarrativeSource {
                source_id: source_id.clone(),
                kind: SourceKind::Podcast,
                display_name: "Fixture source".into(),
                locator: Some("https://fixture.test/feed.xml".into()),
                rights_status: "approved".into(),
                rights_statement: Some("fixture rights".into()),
                topics: Vec::new(),
                state: SourceState::Active,
                poll_interval_minutes: 60,
                per_scan_limit: 100,
                notes: None,
                created_at: now,
                updated_at: now,
                event_count: 0,
                episode_count: 0,
            })
            .unwrap();

        assert!(matches!(
            service.bind_acquisition_source(
                "fixture-site",
                source_id.clone(),
                "reviewer@example.test",
                Some("fixture review"),
                false,
            ),
            Err(NipError::RightsConfirmationRequired)
        ));
        assert!(matches!(
            service.bind_acquisition_source(
                "missing-site",
                source_id.clone(),
                "reviewer@example.test",
                None,
                true,
            ),
            Err(NipError::AcquisitionProfileNotFound)
        ));

        let binding = service
            .bind_acquisition_source(
                "fixture-site",
                source_id,
                "reviewer@example.test",
                Some("fixture review"),
                true,
            )
            .unwrap();
        assert_eq!(binding.state, "bound");
        assert!(service
            .acquisition_source_bindings()
            .unwrap()
            .iter()
            .any(|binding| binding.explicit && binding.state == "bound"));

        service
            .store
            .update_source(
                &SourceId::new("fixture-source").unwrap(),
                &SourceUpdate {
                    locator: Some("https://fixture.test/changed.xml".into()),
                    ..SourceUpdate::default()
                },
                now,
            )
            .unwrap();
        assert!(service
            .acquisition_source_bindings()
            .unwrap()
            .iter()
            .any(|binding| binding.state == "unresolved" && binding.explicit));

        service
            .unbind_acquisition_source(
                "fixture-site",
                "reviewer@example.test",
                Some("mapping withdrawn"),
                true,
            )
            .unwrap();
        let report = service.acquisition_source_bindings().unwrap();
        let binding = report
            .iter()
            .find(|binding| binding.worker_site_id == "fixture-site")
            .unwrap();
        assert_eq!(binding.state, "unbound");
        assert_eq!(binding.review_note.as_deref(), Some("mapping withdrawn"));
        assert_eq!(service.sources(true).unwrap().len(), 1);
    }

    #[test]
    fn typed_worker_ingest_requires_explicit_binding_and_rejects_changed_or_stale_items() {
        let temp = tempdir().unwrap();
        let root = temp.path();
        let mut config = NipConfig::resolve(
            &BTreeMap::from([(
                "NIP_LAKE_DIR".to_owned(),
                root.join("lake").to_string_lossy().into_owned(),
            )]),
            root,
            None,
            true,
        )
        .unwrap();
        config
            .set_acquisition_site_profiles(vec![acquisition::AcquisitionSiteProfile {
                site_id: "fixture-site".into(),
                display_name: "Fixture podcast worker".into(),
                kind: "podcast".into(),
                enabled: true,
                poll_interval_min: 60,
                feed_url: Some("https://fixture.test/feed.xml/".into()),
                source_seed_status: "observed".into(),
                schedule_seed_status: "observed".into(),
                credential_status: "not_required".into(),
            }])
            .unwrap();
        let mut service = NipService::open(config).unwrap();
        let source_id = SourceId::new("fixture-source").unwrap();
        let now = Utc::now();
        service
            .store
            .insert_source(&NarrativeSource {
                source_id: source_id.clone(),
                kind: SourceKind::Podcast,
                display_name: "Fixture source".into(),
                locator: Some("https://fixture.test/feed.xml".into()),
                rights_status: "approved".into(),
                rights_statement: Some("fixture rights".into()),
                topics: Vec::new(),
                state: SourceState::Active,
                poll_interval_minutes: 60,
                per_scan_limit: 100,
                notes: None,
                created_at: now,
                updated_at: now,
                event_count: 0,
                episode_count: 0,
            })
            .unwrap();

        let hash_text = |text: &str| -> String {
            Sha256::digest(text.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect()
        };
        let started_at = now - Duration::seconds(10);
        let completed_at = now - Duration::seconds(2);
        let body = "Fixture episode notes.";
        let transcript_text = "Fixture transcript text.";
        let mut batch = AcquisitionBatch {
            contract_version: 1,
            producer: AcquisitionProducer {
                name: "fina-scraper".into(),
                version: "fixture-0.1".into(),
            },
            run_id: "fixture-run".into(),
            started_at,
            completed_at,
            items: vec![AcquisitionItem {
                source_id: source_id.clone(),
                worker_source_key: "fixture-site".into(),
                worker_item_id: "episode-1".into(),
                source_url: "https://fixture.test/episode/1".into(),
                title: "Fixture episode".into(),
                content_kind: AcquisitionContentKind::Article,
                content_text: body.into(),
                content_hash: hash_text(body),
                published_at: Some(started_at),
                ingested_at: completed_at,
                valid_from: started_at,
                valid_to: None,
                availability: AcquisitionAvailability::Live,
                transcript: Some(AcquisitionTranscript {
                    transcript_text: transcript_text.into(),
                    content_hash: hash_text(transcript_text),
                    language: Some("en".into()),
                    method: "fixture_asr".into(),
                    model: Some("fixture-model".into()),
                    model_version: Some("v1".into()),
                    transcribed_at: completed_at,
                }),
                claims: Vec::new(),
                entities: Vec::new(),
                features: Vec::new(),
            }],
        };
        let mut multi_item_batch = batch.clone();
        let mut second_item = multi_item_batch.items[0].clone();
        second_item.worker_item_id = "episode-2".into();
        multi_item_batch.items.push(second_item);
        assert!(matches!(
            service.ingest_acquisition_batch("fixture-site", &multi_item_batch),
            Err(NipError::AcquisitionBatchRejected(_))
        ));
        assert!(service.store.all_events().unwrap().is_empty());
        assert!(matches!(
            service.ingest_acquisition_batch("fixture-site", &batch),
            Err(NipError::AcquisitionBindingEvidenceMismatch)
        ));
        service
            .bind_acquisition_source(
                "fixture-site",
                source_id.clone(),
                "reviewer@example.test",
                Some("fixture rights reviewed"),
                true,
            )
            .unwrap();

        let first = service
            .ingest_acquisition_batch("fixture-site", &batch)
            .unwrap();
        assert!(!first.replay);
        assert!(first.transcript_stored);
        assert_eq!(
            service
                .acquisition_transcript(&first.event_id)
                .unwrap()
                .unwrap()
                .transcript_text,
            transcript_text
        );
        let replay = service
            .ingest_acquisition_batch("fixture-site", &batch)
            .unwrap();
        assert!(replay.replay);
        assert_eq!(replay.event_id, first.event_id);

        batch.items[0].content_text = "Changed body for the same worker identity.".into();
        batch.items[0].content_hash = hash_text(&batch.items[0].content_text);
        assert!(matches!(
            service.ingest_acquisition_batch("fixture-site", &batch),
            Err(NipError::Storage(StoreError::AcquisitionIdentityConflict))
        ));

        service
            .store
            .update_source(
                &source_id,
                &SourceUpdate {
                    locator: Some("https://fixture.test/changed-feed.xml".into()),
                    ..SourceUpdate::default()
                },
                Utc::now(),
            )
            .unwrap();
        batch.items[0].worker_item_id = "episode-2".into();
        assert!(matches!(
            service.ingest_acquisition_batch("fixture-site", &batch),
            Err(NipError::AcquisitionBindingEvidenceMismatch)
        ));
        assert_eq!(service.store.all_events().unwrap().len(), 1);
    }

    #[test]
    fn scraper_owned_compatibility_podcast_stays_readable_but_cannot_be_mutated_or_refetched() {
        struct CountingAudioClient(std::sync::atomic::AtomicUsize);
        impl podcast::AudioClient for CountingAudioClient {
            fn fetch(
                &self,
                _url: &str,
            ) -> Result<podcast::AudioResponse, podcast::AudioClientError> {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Err(podcast::AudioClientError::Request)
            }
        }

        let temp = tempdir().unwrap();
        let feed_url = "https://example.com/owned/feed.xml?edition=main";
        let now = "2026-11-16T09:00:00Z".parse().unwrap();
        let mut service =
            service_with_scraper_ownership_at(temp.path(), &[feed_url], &["scraper-native-site"]);
        let source_id = SourceId::new("legacy-nip-show").unwrap();
        service
            .store
            .add_approved_subscription(&PodcastSubscription {
                source_id: source_id.clone(),
                feed_url: feed_url.to_owned(),
                show_name: "Legacy compatibility show".into(),
                rights_statement: "Synthetic fixture rights".into(),
                rights_confirmed_at: now,
                state: PodcastSubscriptionState::Active,
                etag: Some("\"preserved-etag\"".into()),
                last_modified: None,
                last_checked_at: Some(now),
                next_poll_at: Some(now + chrono::TimeDelta::hours(1)),
                last_error_code: None,
                consecutive_failures: 0,
            })
            .unwrap();
        let episode = PodcastEpisode {
            source_id: source_id.clone(),
            source_native_id: Some("legacy-episode-1".into()),
            canonical_url: Some("https://example.com/episode-1".into()),
            title: Some("Retained compatibility metadata".into()),
            enclosure_url: Some("https://example.com/episode-1.mp3".into()),
            published_at: Some(now),
            discovered_at: now,
            state: PodcastEpisodeState::AwaitingLocalTranscription,
            transcript_url: Some("https://example.com/episode-1.vtt".into()),
            transcript_type: Some("text/vtt".into()),
        };
        service
            .store
            .record_discovered_episodes(std::slice::from_ref(&episode))
            .unwrap();
        let source_before = service.source(&source_id).unwrap();
        let subscription_before = service.store.subscription(&source_id).unwrap().unwrap();
        let episodes_before = service.podcast_episodes(&source_id).unwrap();
        let feed_client = FixtureFeedClient::default();
        let audio_client = CountingAudioClient(std::sync::atomic::AtomicUsize::new(0));
        let provider =
            asr::DeterministicFakeAsrProvider::new("must not run", Some("en".into())).unwrap();

        assert!(matches!(
            service.refresh_podcast_feed(&source_id, &feed_client, now),
            Err(NipError::ScraperOwnsPodcastFeed)
        ));
        assert!(matches!(
            service.update_source(
                &source_id,
                &SourceUpdate {
                    display_name: Some("must not change".into()),
                    ..Default::default()
                },
                &feed_client,
                false,
                now,
            ),
            Err(NipError::ScraperOwnsPodcastFeed)
        ));
        assert!(matches!(
            service.set_source_state(&source_id, SourceState::Paused, now),
            Err(NipError::ScraperOwnsPodcastFeed)
        ));
        assert!(matches!(
            service.set_podcast_subscription_state(&source_id, PodcastSubscriptionState::Paused),
            Err(NipError::ScraperOwnsPodcastFeed)
        ));
        assert!(matches!(
            service.delete_source(&source_id),
            Err(NipError::ScraperOwnsPodcastFeed)
        ));
        assert!(matches!(
            service.transcribe_podcast_episode_from_enclosure(
                &episode,
                &audio_client,
                &provider,
                now,
            ),
            Err(NipError::ScraperOwnsPodcastFeed)
        ));

        assert_eq!(
            feed_client.call_count(),
            0,
            "scraper-owned feed must not be fetched by NIP"
        );
        assert_eq!(
            audio_client.0.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "no publisher transcript/audio request may run"
        );
        assert_eq!(service.source(&source_id).unwrap(), source_before);
        assert_eq!(
            service.store.subscription(&source_id).unwrap().unwrap(),
            subscription_before
        );
        assert_eq!(
            service.podcast_episodes(&source_id).unwrap(),
            episodes_before
        );
    }

    #[test]
    fn scraper_site_id_collision_is_rejected_before_nip_source_creation() {
        let temp = tempdir().unwrap();
        let mut service = service_with_scraper_ownership_at(temp.path(), &[], &["native-site-id"]);
        let source_id = SourceId::new("native-site-id").unwrap();
        let client = FixtureFeedClient::default();
        let result = service.create_source(
            SourceDraft {
                source_id: source_id.clone(),
                kind: SourceKind::Web,
                display_name: "Would collide".into(),
                locator: Some("https://example.test/source".into()),
                rights_statement: "Synthetic test rights".into(),
                topics: Vec::new(),
                poll_interval_minutes: None,
                per_scan_limit: None,
                notes: None,
            },
            &client,
            "2026-11-16T09:00:00Z".parse().unwrap(),
        );
        assert!(matches!(result, Err(NipError::ScraperOwnsSource)));
        assert_eq!(client.call_count(), 0);
        assert!(matches!(
            service.source(&source_id),
            Err(NipError::SourceNotFound)
        ));
    }

    fn feed_body() -> String {
        r#"<rss version="2.0"><channel><title>Fixture Show</title><item>
            <guid>episode-1</guid><title>First synthetic episode</title>
            <link>https://fixture.test/episode-1</link>
            <pubDate>Sun, 15 Nov 2026 12:00:00 +0000</pubDate>
            <enclosure url="https://fixture.test/episode-1.mp3" type="audio/mpeg"/>
        </item></channel></rss>"#
            .to_owned()
    }

    fn feed_response(
        status: u16,
        body: String,
        retry_after: Option<&str>,
    ) -> podcast::FeedResponse {
        podcast::FeedResponse {
            status,
            etag: Some("\"fixture-v1\"".into()),
            last_modified: None,
            retry_after: retry_after.map(str::to_owned),
            body,
        }
    }

    fn request(confirmed: bool) -> PodcastSubscriptionRequest {
        PodcastSubscriptionRequest {
            source_id: SourceId::new("fixture-show").unwrap(),
            feed_url: "http://127.0.0.1:8794/fixture/feed.xml".into(),
            show_name: "Fixture Show".into(),
            rights_statement: "Synthetic fixture approved for local testing".into(),
            user_confirmed_rights: confirmed,
        }
    }

    #[test]
    fn subscription_requires_explicit_rights_confirmation_before_fetch_or_storage() {
        let temp = tempdir().unwrap();
        let mut service = service_at(temp.path());
        let client = FixtureFeedClient::with_responses(vec![]);
        let error = service
            .subscribe_podcast_feed(
                request(false),
                &client,
                "2026-11-16T09:00:00Z".parse().unwrap(),
            )
            .unwrap_err();
        assert!(matches!(error, NipError::RightsConfirmationRequired));
        assert_eq!(client.call_count(), 0);
        assert!(service.podcast_subscriptions().unwrap().is_empty());
    }

    #[test]
    fn initial_sync_discovers_idempotent_episode_and_keeps_asr_unavailable_boundary() {
        let temp = tempdir().unwrap();
        let mut service = service_at(temp.path());
        let client = FixtureFeedClient::with_responses(vec![
            feed_response(200, feed_body(), None),
            feed_response(200, feed_body(), None),
            feed_response(304, String::new(), None),
        ]);
        let first_now = "2026-11-16T09:00:00Z".parse().unwrap();
        let first = service
            .subscribe_podcast_feed(request(true), &client, first_now)
            .unwrap();
        assert_eq!(first.discovered_count, 1);
        assert_eq!(first.total_episode_count, 1);
        assert!(!first.not_modified);
        assert_eq!(client.call_count(), 1);

        let episode = service
            .podcast_episodes(&SourceId::new("fixture-show").unwrap())
            .unwrap()
            .remove(0);
        assert_eq!(episode.source_native_id.as_deref(), Some("episode-1"));
        assert_eq!(episode.title.as_deref(), Some("First synthetic episode"));
        assert_eq!(
            episode.state,
            PodcastEpisodeState::AwaitingLocalTranscription
        );

        assert!(matches!(
            service.refresh_podcast_feed(
                &SourceId::new("fixture-show").unwrap(),
                &client,
                first_now + chrono::TimeDelta::hours(1),
            ),
            Err(NipError::RefreshNotDue)
        ));
        assert_eq!(client.call_count(), 1);

        let replay = service
            .refresh_podcast_feed(
                &SourceId::new("fixture-show").unwrap(),
                &client,
                first.next_poll_at,
            )
            .unwrap();
        assert_eq!(replay.discovered_count, 0);
        assert_eq!(replay.total_episode_count, 1);
        assert_eq!(client.call_count(), 2);

        service
            .set_podcast_subscription_state(
                &SourceId::new("fixture-show").unwrap(),
                PodcastSubscriptionState::Paused,
            )
            .unwrap();
        assert!(matches!(
            service.refresh_podcast_feed(
                &SourceId::new("fixture-show").unwrap(),
                &client,
                replay.next_poll_at + chrono::TimeDelta::hours(6),
            ),
            Err(NipError::SubscriptionInactive)
        ));
        assert_eq!(client.call_count(), 2);

        service
            .set_podcast_subscription_state(
                &SourceId::new("fixture-show").unwrap(),
                PodcastSubscriptionState::Active,
            )
            .unwrap();
        let due = service
            .refresh_due_podcast_feeds(&client, replay.next_poll_at + chrono::TimeDelta::hours(6))
            .unwrap();
        assert_eq!(due.len(), 1);
        assert!(matches!(&due[0], Ok(report) if report.not_modified));
        assert_eq!(client.call_count(), 3);

        service
            .set_podcast_subscription_state(
                &SourceId::new("fixture-show").unwrap(),
                PodcastSubscriptionState::Removed,
            )
            .unwrap();
        assert_eq!(
            service.podcast_subscriptions().unwrap()[0].state,
            PodcastSubscriptionState::Removed
        );
        assert!(service
            .refresh_due_podcast_feeds(&client, replay.next_poll_at + chrono::TimeDelta::days(2))
            .unwrap()
            .is_empty());
        assert_eq!(client.call_count(), 3);
        assert!(matches!(
            service.set_podcast_subscription_state(
                &SourceId::new("fixture-show").unwrap(),
                PodcastSubscriptionState::Active,
            ),
            Err(NipError::SubscriptionNotFound)
        ));
    }

    #[test]
    fn feed_http_error_persists_safe_status_and_honors_long_retry_after() {
        let temp = tempdir().unwrap();
        let mut service = service_at(temp.path());
        let client = FixtureFeedClient::with_responses(vec![feed_response(
            429,
            String::new(),
            Some("7200"),
        )]);
        let now = "2026-11-16T09:00:00Z".parse().unwrap();
        assert!(matches!(
            service.subscribe_podcast_feed(request(true), &client, now),
            Err(NipError::FeedUnavailable)
        ));
        let subscription = service.podcast_subscriptions().unwrap().remove(0);
        assert_eq!(subscription.last_error_code.as_deref(), Some("http_429"));
        assert_eq!(subscription.consecutive_failures, 1);
        assert_eq!(
            subscription.next_poll_at,
            Some(now + chrono::TimeDelta::hours(2))
        );
        assert_eq!(client.call_count(), 1);
        assert!(matches!(
            service.refresh_podcast_feed(
                &SourceId::new("fixture-show").unwrap(),
                &client,
                now + chrono::TimeDelta::hours(1),
            ),
            Err(NipError::RefreshNotDue)
        ));
        assert_eq!(client.call_count(), 1);
    }
    #[test]
    fn fake_asr_transcription_commits_validated_transcript() {
        let temp = tempdir().unwrap();
        let mut service = service_at(temp.path());
        let client = FixtureFeedClient::with_responses(vec![feed_response(200, feed_body(), None)]);
        let now = "2026-11-16T09:00:00Z".parse().unwrap();
        service
            .subscribe_podcast_feed(request(true), &client, now)
            .unwrap();
        let episode = service
            .podcast_episodes(&SourceId::new("fixture-show").unwrap())
            .unwrap()
            .remove(0);
        let provider = asr::DeterministicFakeAsrProvider::new(
            "reviewed synthetic transcript",
            Some("en".into()),
        )
        .unwrap();
        let transcript = service
            .transcribe_podcast_episode(
                &episode,
                asr::AsrRequest {
                    job_id: "fixture-job-1".into(),
                    audio: b"synthetic audio".to_vec(),
                    audio_path: None,
                    file_name: "episode.mp3".into(),
                    mime_type: "audio/mpeg".into(),
                    language: None,
                    return_timestamps: false,
                },
                &provider,
                now + chrono::TimeDelta::seconds(2),
            )
            .unwrap();
        assert_eq!(transcript.transcript_text, "reviewed synthetic transcript");
        assert_eq!(
            service
                .podcast_episodes(&SourceId::new("fixture-show").unwrap())
                .unwrap()[0]
                .state,
            PodcastEpisodeState::Transcribed
        );
        let origin = service.event_for_episode(&episode).unwrap().unwrap();
        assert_eq!(
            origin.source_native_id.as_deref(),
            Some("episode-1"),
            "the episode row must be able to open its retained origin"
        );
    }

    #[test]
    fn graph_projection_includes_retained_events_as_origin_nodes() {
        let temp = tempdir().unwrap();
        let mut service = service_at(temp.path());
        let import = LocalEventImport {
            source_id: SourceId::new("manual-fixture").unwrap(),
            source_display_name: "Synthetic fixture document".into(),
            source_native_id: Some("origin-1".into()),
            canonical_url: None,
            title: Some("Origin fixture".into()),
            content_text: "Rates remain restrictive until inflation cools.".into(),
            published_at: Some("2026-11-15T12:00:00Z".parse().unwrap()),
            source_updated_at: None,
            rights_statement: "User-owned synthetic fixture".into(),
            user_confirmed_rights: true,
            extraction_tier: None,
            review_status: None,
        };
        let event = service
            .import_local_event(&import, "2026-11-16T09:00:00Z".parse().unwrap())
            .unwrap();
        assert!(service.graph().unwrap().is_none());
        let graph = service.rebuild_graph("graph-fixture".into()).unwrap();
        assert!(graph
            .nodes
            .iter()
            .any(|node| node.node_id == format!("event:{}", event.event_id.as_str())));
        assert!(graph.edges.is_empty());
    }

    #[test]
    fn enclosure_path_validates_audio_before_fake_transcription() {
        struct FixtureAudioClient;
        impl podcast::AudioClient for FixtureAudioClient {
            fn fetch(
                &self,
                _url: &str,
            ) -> Result<podcast::AudioResponse, podcast::AudioClientError> {
                Ok(podcast::AudioResponse {
                    status: 200,
                    content_type: Some("audio/mpeg; charset=binary".into()),
                    body: b"synthetic enclosure".to_vec(),
                })
            }
        }

        let temp = tempdir().unwrap();
        let mut service = service_at(temp.path());
        let client = FixtureFeedClient::with_responses(vec![feed_response(200, feed_body(), None)]);
        let now = "2026-11-16T09:00:00Z".parse().unwrap();
        service
            .subscribe_podcast_feed(request(true), &client, now)
            .unwrap();
        let episode = service
            .podcast_episodes(&SourceId::new("fixture-show").unwrap())
            .unwrap()
            .remove(0);
        let provider =
            asr::DeterministicFakeAsrProvider::new("enclosure transcript", Some("en".into()))
                .unwrap();
        let transcript = service
            .transcribe_podcast_episode_from_enclosure(
                &episode,
                &FixtureAudioClient,
                &provider,
                now + chrono::TimeDelta::seconds(2),
            )
            .unwrap();
        assert_eq!(transcript.transcript_text, "enclosure transcript");
    }

    #[test]
    fn a_forced_refresh_ignores_the_poll_window_and_stored_validators() {
        let temp = tempdir().unwrap();
        let mut service = service_at(temp.path());
        let now = "2026-11-16T09:00:00Z".parse().unwrap();
        let mut first = feed_response(200, feed_body(), None);
        first.etag = Some("\"v1\"".into());
        let mut second = feed_response(
            200,
            feed_body()
                .replace(
                    "<rss version=\"2.0\">",
                    "<rss version=\"2.0\" xmlns:podcast=\"https://podcastindex.org/namespace/1.0\">",
                )
                .replace(
                    "<enclosure url=\"https://fixture.test/episode-1.mp3\" type=\"audio/mpeg\"/>",
                    concat!(
                        "<enclosure url=\"https://fixture.test/episode-1.mp3\" type=\"audio/mpeg\"/>",
                        "<podcast:transcript url=\"https://fixture.test/episode-1.vtt\" type=\"text/vtt\"/>"
                    ),
                ),
            None,
        );
        second.etag = Some("\"v2\"".into());
        let client = FixtureFeedClient::with_responses(vec![first, second]);
        service
            .subscribe_podcast_feed(request(true), &client, now)
            .unwrap();
        // Inside the six-hour window the scheduled path must refuse, which is
        // what left a newly advertised transcript unrecorded.
        assert!(matches!(
            service.refresh_podcast_feed(
                &SourceId::new("fixture-show").unwrap(),
                &client,
                now + chrono::TimeDelta::minutes(5)
            ),
            Err(NipError::RefreshNotDue)
        ));
        let reports = service
            .refresh_active_podcast_feeds(&client, now + chrono::TimeDelta::minutes(5))
            .unwrap();
        assert_eq!(reports.len(), 1);
        assert!(reports[0].is_ok());
        let requests = client.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(
            requests[1].etag.is_none(),
            "a forced refresh must not revalidate"
        );
        assert!(requests[1].last_modified.is_none());
        let episode = service
            .podcast_episodes(&SourceId::new("fixture-show").unwrap())
            .unwrap()
            .remove(0);
        assert_eq!(
            episode.transcript_url.as_deref(),
            Some("https://fixture.test/episode-1.vtt")
        );
    }

    #[test]
    fn publisher_transcript_is_preferred_over_local_asr() {
        const PUBLISHED: &str = "The publisher already wrote this transcript down, so running local automatic speech recognition over identical audio would be wasted work, and a feed-provided transcript is usually more accurate than any model because the show produced it themselves.";
        struct PublishedTranscriptClient;
        impl podcast::AudioClient for PublishedTranscriptClient {
            fn fetch(
                &self,
                url: &str,
            ) -> Result<podcast::AudioResponse, podcast::AudioClientError> {
                assert!(url.ends_with("/episode-1.vtt"), "unexpected fetch: {url}");
                Ok(podcast::AudioResponse {
                    status: 200,
                    content_type: Some("text/vtt".into()),
                    body: format!("WEBVTT\n\n00:00:00.000 --> 00:00:04.000\n{PUBLISHED}\n")
                        .into_bytes(),
                })
            }
        }
        struct PanickingAsr;
        impl asr::AsrProvider for PanickingAsr {
            fn transcribe(
                &self,
                _request: &asr::AsrRequest,
            ) -> Result<asr::AsrResult, asr::AsrError> {
                panic!("ASR must not run when a publisher transcript exists");
            }
        }

        let temp = tempdir().unwrap();
        let mut service = service_at(temp.path());
        let feed = feed_body()
            .replace(
                "<rss version=\"2.0\">",
                "<rss version=\"2.0\" xmlns:podcast=\"https://podcastindex.org/namespace/1.0\">",
            )
            .replace(
                "<enclosure url=\"https://fixture.test/episode-1.mp3\" type=\"audio/mpeg\"/>",
                concat!(
                    "<enclosure url=\"https://fixture.test/episode-1.mp3\" type=\"audio/mpeg\"/>",
                    "<podcast:transcript url=\"https://fixture.test/episode-1.vtt\" type=\"text/vtt\"/>"
                ),
            );
        let client = FixtureFeedClient::with_responses(vec![feed_response(200, feed, None)]);
        let now = "2026-11-16T09:00:00Z".parse().unwrap();
        service
            .subscribe_podcast_feed(request(true), &client, now)
            .unwrap();
        let episode = service
            .podcast_episodes(&SourceId::new("fixture-show").unwrap())
            .unwrap()
            .remove(0);
        assert_eq!(
            episode.transcript_url.as_deref(),
            Some("https://fixture.test/episode-1.vtt")
        );
        let transcript = service
            .transcribe_podcast_episode_from_enclosure(
                &episode,
                &PublishedTranscriptClient,
                &PanickingAsr,
                now + chrono::TimeDelta::seconds(2),
            )
            .unwrap();
        assert_eq!(transcript.transcript_text, PUBLISHED);
        assert!(transcript.provenance_json.contains("publisher_transcript"));

        // The episode title, not the event or cluster id, names the derived
        // projections: a graph of UUIDs is unreadable.
        let clusters = service
            .rebuild_clusters(
                &DeterministicEmbeddingProvider::new(64),
                "cluster-run-labels".into(),
            )
            .unwrap();
        assert_eq!(clusters.len(), 1);
        assert_eq!(clusters[0].label, "First synthetic episode");
        let graph = service.rebuild_graph("graph-run-labels".into()).unwrap();
        let narrative = graph
            .nodes
            .iter()
            .find(|node| node.node_type == "narrative")
            .unwrap();
        assert_eq!(narrative.label, "First synthetic episode");
        let origin = graph
            .nodes
            .iter()
            .find(|node| node.node_type == "event")
            .unwrap();
        assert_eq!(origin.label, "First synthetic episode");
    }

    #[test]
    fn local_import_search_and_claim_extraction_preserve_evidence() {
        let temp = tempdir().unwrap();
        let mut service = service_at(temp.path());
        let captured_at = "2026-11-16T09:00:00Z".parse().unwrap();
        let import = LocalEventImport {
            source_id: SourceId::new("manual-fixture").unwrap(),
            source_display_name: "Synthetic fixture document".into(),
            source_native_id: None,
            canonical_url: None,
            title: Some("Fixture claim".into()),
            content_text: "Rates remain restrictive until inflation cools.".into(),
            published_at: Some("2026-11-15T12:00:00Z".parse().unwrap()),
            source_updated_at: None,
            rights_statement: "User-owned synthetic fixture".into(),
            user_confirmed_rights: true,
            extraction_tier: None,
            review_status: None,
        };
        let first = service.import_local_event(&import, captured_at).unwrap();
        let second = service.import_local_event(&import, captured_at).unwrap();
        assert_eq!(first.event_id, second.event_id);
        let page = service
            .search_events(&EventSearchQuery {
                text: Some("restrictive".into()),
                source_id: Some(import.source_id.clone()),
                as_of: None,
                cursor: None,
                limit: 10,
            })
            .unwrap();
        assert_eq!(page.events.len(), 1);
        let claims = service
            .extract_claims(&page.events[0], &DeterministicFakeClaimProvider)
            .unwrap();
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].evidence[0].event_id, first.event_id);
        assert_eq!(service.claims().unwrap().len(), 1);
    }

    #[test]
    fn signal_snapshot_uses_completed_utc_weeks_and_transparent_quality_flags() {
        let temp = tempdir().unwrap();
        let mut service = service_at(temp.path());
        let source = SourceId::new("signal-fixture").unwrap();
        let as_of = Utc::now() + Duration::days(1);
        let week_floor = as_of.date_naive().and_hms_opt(0, 0, 0).unwrap().and_utc()
            - Duration::days(i64::from(as_of.weekday().num_days_from_monday()));
        let current_week_start = week_floor - Duration::days(7);
        let current_published_at = current_week_start + Duration::days(3) + Duration::hours(12);
        let prior_published_at = current_week_start - Duration::days(4) + Duration::hours(12);
        for (native_id, published_at, text) in [
            ("prior", Some(prior_published_at), "prior mention"),
            ("current", Some(current_published_at), "current mention"),
            ("undated", None, "undated observation"),
        ] {
            service
                .import_local_event(
                    &LocalEventImport {
                        source_id: source.clone(),
                        source_display_name: "Synthetic signal fixture".into(),
                        source_native_id: Some(native_id.into()),
                        canonical_url: None,
                        title: None,
                        content_text: text.into(),
                        published_at,
                        source_updated_at: None,
                        rights_statement: "synthetic fixture".into(),
                        user_confirmed_rights: true,
                        extraction_tier: None,
                        review_status: None,
                    },
                    "2026-11-17T00:00:00Z".parse().unwrap(),
                )
                .unwrap();
        }
        // The point-in-time cutoff must follow the event's real ingestion time
        // (`Utc::now()`), otherwise this test becomes time-of-day dependent.
        let snapshot = service.signal_snapshot(as_of).unwrap();
        assert_eq!(snapshot.coverage, "unknown");
        assert_eq!(snapshot.current_week_start, current_week_start);
        assert!(snapshot
            .signals
            .iter()
            .any(|signal| signal.current_count == 1
                && signal.prior_count == 0
                && signal.percent_change.is_none()
                && signal
                    .data_quality_flags
                    .contains(&"no_comparable_baseline".into())));
        assert!(snapshot.signals.iter().all(|signal| signal
            .data_quality_flags
            .contains(&"coverage_manifest_missing".into())));
    }

    #[derive(Clone)]
    struct BridgeFixture {
        token: String,
        status: std::sync::Arc<std::sync::Mutex<RigaBridgeProviderStatus>>,
        extraction_requests: std::sync::Arc<AtomicU64>,
        status_requests: std::sync::Arc<AtomicU64>,
    }

    fn remote_status(provider_id: &str, model: &str) -> RigaBridgeProviderStatus {
        RigaBridgeProviderStatus {
            configured: true,
            provider_kind: Some("remote".into()),
            provider_id: Some(provider_id.into()),
            model: Some(model.into()),
            reasoning_effort: Some("low".into()),
            provider_api: Some("chat".into()),
            provider_type: Some("open_ai_compatible".into()),
            warnings: Vec::new(),
        }
    }

    fn start_bridge_fixture(status: RigaBridgeProviderStatus) -> (BridgeFixture, String) {
        let fixture = BridgeFixture {
            token: "fixture-bearer-token".into(),
            status: std::sync::Arc::new(std::sync::Mutex::new(status)),
            extraction_requests: std::sync::Arc::new(AtomicU64::new(0)),
            status_requests: std::sync::Arc::new(AtomicU64::new(0)),
        };
        let server = fixture.clone();
        let (address_tx, address_rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                    .await
                    .unwrap();
                let port = listener.local_addr().unwrap().port();
                address_tx.send(port).unwrap();
                let router = axum::Router::new()
                    .route(
                        "/provider_status",
                        axum::routing::get(bridge_fixture_status),
                    )
                    .route(
                        "/claims/extract",
                        axum::routing::post(bridge_fixture_extract),
                    )
                    .with_state(server);
                let _ = axum::serve(listener, router).await;
            });
        });
        let port = address_rx.recv().unwrap();
        (fixture, format!("http://127.0.0.1:{port}"))
    }

    fn authorized(headers: &axum::http::HeaderMap, token: &str) -> bool {
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            == Some(&format!("Bearer {token}"))
    }

    async fn bridge_fixture_status(
        axum::extract::State(state): axum::extract::State<BridgeFixture>,
        headers: axum::http::HeaderMap,
    ) -> axum::response::Response {
        use axum::response::IntoResponse;
        if !authorized(&headers, &state.token) {
            return axum::http::StatusCode::UNAUTHORIZED.into_response();
        }
        state.status_requests.fetch_add(1, Ordering::Relaxed);
        axum::Json(state.status.lock().unwrap().clone()).into_response()
    }

    async fn bridge_fixture_extract(
        axum::extract::State(state): axum::extract::State<BridgeFixture>,
        headers: axum::http::HeaderMap,
        axum::Json(body): axum::Json<Value>,
    ) -> axum::response::Response {
        use axum::response::IntoResponse;
        if !authorized(&headers, &state.token) {
            return axum::http::StatusCode::UNAUTHORIZED.into_response();
        }
        state.extraction_requests.fetch_add(1, Ordering::Relaxed);
        let status = state.status.lock().unwrap().clone();
        let claim_text = body
            .get("content_text")
            .and_then(Value::as_str)
            .and_then(|text| text.lines().next())
            .unwrap_or("fixture claim")
            .to_owned();
        axum::Json(json!({
            "extraction_run_id": "bridge-run-1",
            "provider_kind": status.provider_kind,
            "provider_id": status.provider_id,
            "model": status.model,
            "reasoning_effort": status.reasoning_effort,
            "prompt_version": body.get("prompt_version"),
            "claims": [{
                "text": claim_text,
                "speaker_or_author": "Fixture analyst",
                "confidence_millis": 900,
                "quote": body.get("content_text"),
            }],
        }))
        .into_response()
    }

    fn service_with_bridge(root: &std::path::Path, bridge_url: &str, token: &str) -> NipService {
        let config = NipConfig::resolve(
            &BTreeMap::from([
                (
                    "NIP_LAKE_DIR".to_owned(),
                    root.join("lake").to_string_lossy().into_owned(),
                ),
                ("NIP_RIGA_BRIDGE_URL".to_owned(), bridge_url.to_owned()),
                ("NIP_RIGA_BRIDGE_TOKEN".to_owned(), token.to_owned()),
            ]),
            root,
            None,
            true,
        )
        .unwrap();
        NipService::open(config).unwrap()
    }

    fn import_bridge_event(service: &mut NipService) -> EventRecord {
        service
            .import_local_event(
                &LocalEventImport {
                    source_id: SourceId::new("bridge-fixture").unwrap(),
                    source_display_name: "Synthetic bridge fixture".into(),
                    source_native_id: Some("bridge-event-1".into()),
                    canonical_url: None,
                    title: None,
                    content_text: "Policy remains restrictive until inflation cools.".into(),
                    published_at: Some("2026-11-16T12:00:00Z".parse().unwrap()),
                    source_updated_at: None,
                    rights_statement: "Synthetic fixture approved for local testing".into(),
                    user_confirmed_rights: true,
                    extraction_tier: None,
                    review_status: None,
                },
                "2026-11-17T09:00:00Z".parse().unwrap(),
            )
            .unwrap()
    }

    #[test]
    fn direct_local_selection_never_falls_back_to_riga() {
        let temp = tempdir().unwrap();
        let (fixture, bridge_url) = start_bridge_fixture(remote_status("provider-a", "model-a"));
        let closed_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let local_port = closed_listener.local_addr().unwrap().port();
        drop(closed_listener);
        let config = NipConfig::resolve(
            &BTreeMap::from([
                (
                    "NIP_LAKE_DIR".to_owned(),
                    temp.path().join("lake").to_string_lossy().into_owned(),
                ),
                ("NIP_CLAIM_PROVIDER".into(), "direct_local".into()),
                (
                    "NIP_LOCAL_LLM_URL".into(),
                    format!("http://127.0.0.1:{local_port}/v1"),
                ),
                ("NIP_LOCAL_LLM_MODEL".into(), "local-model".into()),
                ("NIP_RIGA_BRIDGE_URL".into(), bridge_url),
                ("NIP_RIGA_BRIDGE_TOKEN".into(), fixture.token.clone()),
            ]),
            temp.path(),
            None,
            true,
        )
        .unwrap();
        let mut service = NipService::open(config).unwrap();
        let event = import_bridge_event(&mut service);

        let status = service.provider_status().unwrap();
        assert_eq!(status.provider_id.as_deref(), Some("direct-local"));
        assert_eq!(status.model.as_deref(), Some("local-model"));
        assert_eq!(status.extraction_state, "unavailable");
        assert!(status
            .warnings
            .contains(&"direct_local_model_unavailable".into()));
        assert_eq!(fixture.status_requests.load(Ordering::Relaxed), 0);
        assert!(matches!(
            service.grant_remote_consent("local-user", None, Utc::now()),
            Err(NipError::RemoteProviderRequired)
        ));
        assert!(matches!(
            service.extract_claims_from_event(event.event_id.as_str()),
            Err(NipError::ProviderUnavailable)
        ));
        assert_eq!(fixture.status_requests.load(Ordering::Relaxed), 0);
        assert_eq!(fixture.extraction_requests.load(Ordering::Relaxed), 0);
        assert!(service.claims().unwrap().is_empty());
    }

    #[test]
    fn remote_extraction_makes_no_bridge_request_before_consent() {
        let temp = tempdir().unwrap();
        let (fixture, url) = start_bridge_fixture(remote_status("provider-a", "model-a"));
        let mut service = service_with_bridge(temp.path(), &url, &fixture.token);
        let event = import_bridge_event(&mut service);

        let status = service.provider_status().unwrap();
        assert!(status.configured);
        assert_eq!(status.bridge_state, "ready");
        // The Narrative UI shows adapter instructions for the OpenCode type,
        // so the provider type has to survive the bridge boundary.
        assert_eq!(status.provider_type.as_deref(), Some("open_ai_compatible"));
        assert_eq!(status.consent, "missing");
        assert_eq!(status.extraction_state, "consent_required");
        assert!(status.warnings.contains(&"remote_consent_missing".into()));
        assert_eq!(fixture.extraction_requests.load(Ordering::Relaxed), 0);

        let error = service
            .extract_claims_from_event(event.event_id.as_str())
            .unwrap_err();
        assert!(matches!(error, NipError::RemoteConsentRequired));
        assert_eq!(fixture.extraction_requests.load(Ordering::Relaxed), 0);
        assert!(service.claims().unwrap().is_empty());

        let consent = service
            .grant_remote_consent(
                "local-user",
                Some("reviewed disclosure"),
                "2026-11-17T10:00:00Z".parse().unwrap(),
            )
            .unwrap();
        assert_eq!(consent.action, "granted");
        assert_eq!(consent.provider_id.as_deref(), Some("provider-a"));
        assert!(consent.disclosure.contains("model-a"));

        let claims = service
            .extract_claims_from_event(event.event_id.as_str())
            .unwrap();
        assert_eq!(fixture.extraction_requests.load(Ordering::Relaxed), 1);
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].provider, "riga_bridge");
        assert_eq!(claims[0].provider_kind.as_deref(), Some("remote"));
        assert_eq!(claims[0].provider_profile_id.as_deref(), Some("provider-a"));
        assert_eq!(claims[0].model, "model-a");
        assert_eq!(claims[0].reasoning_effort.as_deref(), Some("low"));
        assert_eq!(claims[0].prompt_version, provider::BRIDGE_PROMPT_VERSION);
        assert_eq!(claims[0].evidence[0].event_id, event.event_id);
        assert_eq!(claims[0].evidence[0].start_offset, Some(0));
        assert_eq!(
            claims[0].evidence[0].end_offset,
            Some(
                claims[0].evidence[0]
                    .quote
                    .as_deref()
                    .unwrap()
                    .chars()
                    .count() as u32
            )
        );
        assert_eq!(service.claims().unwrap().len(), 1);
    }

    #[test]
    fn revoked_consent_blocks_remote_extraction_without_a_request() {
        let temp = tempdir().unwrap();
        let (fixture, url) = start_bridge_fixture(remote_status("provider-a", "model-a"));
        let mut service = service_with_bridge(temp.path(), &url, &fixture.token);
        let event = import_bridge_event(&mut service);
        service
            .grant_remote_consent("local-user", None, "2026-11-17T10:00:00Z".parse().unwrap())
            .unwrap();
        service
            .revoke_remote_consent(
                "local-user",
                Some("user changed mind"),
                "2026-11-17T10:05:00Z".parse().unwrap(),
            )
            .unwrap();

        let status = service.provider_status().unwrap();
        assert_eq!(status.consent, "revoked");
        assert_eq!(status.extraction_state, "consent_required");
        assert!(matches!(
            service.extract_claims_from_event(event.event_id.as_str()),
            Err(NipError::RemoteConsentRequired)
        ));
        assert_eq!(fixture.extraction_requests.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn local_provider_needs_no_remote_consent_and_records_provenance() {
        let temp = tempdir().unwrap();
        let mut status = remote_status("local-model", "qwen-local");
        status.provider_kind = Some("local".into());
        status.provider_id = None;
        status.provider_api = None;
        status.provider_type = None;
        let (fixture, url) = start_bridge_fixture(status);
        let mut service = service_with_bridge(temp.path(), &url, &fixture.token);
        let event = import_bridge_event(&mut service);

        let view = service.provider_status().unwrap();
        assert!(view.configured);
        assert!(!view.remote);
        assert_eq!(view.consent, "not_required");
        assert_eq!(view.extraction_state, "available");
        assert!(matches!(
            service.grant_remote_consent(
                "local-user",
                None,
                "2026-11-17T10:00:00Z".parse().unwrap()
            ),
            Err(NipError::RemoteProviderRequired)
        ));

        let claims = service
            .extract_claims_from_event(event.event_id.as_str())
            .unwrap();
        assert_eq!(fixture.extraction_requests.load(Ordering::Relaxed), 1);
        assert_eq!(claims[0].provider_kind.as_deref(), Some("local"));
        assert!(claims[0].provider_profile_id.is_none());
    }

    #[test]
    fn changing_the_selected_model_rebinds_remote_consent() {
        let temp = tempdir().unwrap();
        let (fixture, url) = start_bridge_fixture(remote_status("provider-a", "model-a"));
        let mut service = service_with_bridge(temp.path(), &url, &fixture.token);
        let event = import_bridge_event(&mut service);
        service
            .grant_remote_consent("local-user", None, "2026-11-17T10:00:00Z".parse().unwrap())
            .unwrap();
        *fixture.status.lock().unwrap() = remote_status("provider-a", "model-b");

        let status = service.provider_status().unwrap();
        assert_eq!(status.model.as_deref(), Some("model-b"));
        assert_eq!(status.consent, "missing");
        assert_eq!(status.extraction_state, "consent_required");
        assert!(matches!(
            service.extract_claims_from_event(event.event_id.as_str()),
            Err(NipError::RemoteConsentRequired)
        ));
        assert_eq!(fixture.extraction_requests.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn missing_bridge_reports_explicit_unavailable_state_without_fallback() {
        let temp = tempdir().unwrap();
        let mut service = service_at(temp.path());
        let event = import_bridge_event(&mut service);

        let status = service.provider_status().unwrap();
        assert!(!status.configured);
        assert_eq!(status.bridge_state, "not_configured");
        assert_eq!(status.extraction_state, "unavailable");
        assert!(status
            .warnings
            .contains(&"riga_bridge_not_configured".into()));
        assert!(matches!(
            service.extract_claims_from_event(event.event_id.as_str()),
            Err(NipError::ProviderUnavailable)
        ));
    }

    #[test]
    fn external_evidence_quote_rejection_identifies_payload_field() {
        let error = unique_transcript_span(
            "The retained transcript contains the source wording.",
            "A paraphrase of the source wording.",
            "entities[0].evidence_quote",
        )
        .unwrap_err();
        assert!(matches!(
            error,
            NipError::AgentAnalysisRejected(message)
                if message.contains("entities[0].evidence_quote")
                    && message.contains("found 0 matches")
                    && message.contains("Copy the quote verbatim")
        ));
    }

    #[test]
    fn f2_migration_applies_on_fresh_temp_data_dir_and_thesis_round_trips_via_service() {
        let temp = tempdir().unwrap();
        let mut service = service_at(temp.path());
        assert_eq!(service.health().schema_version, 22);

        let now: DateTime<Utc> = "2026-11-24T16:00:00Z".parse().unwrap();
        let thesis = ThesisRecord {
            thesis_id: "thesis-f2".into(),
            title: "NVDA long 1-3 days on verified earnings strength".into(),
            entity_symbol: Some("NVDA".into()),
            direction: ThesisDirection::Long,
            horizon: Some("1-3 days".into()),
            as_of: now,
            thesis_basis: ThesisBasis::LlmVerifiedOnly,
            confidence_millis: Some(720),
            reason: Some("Three llm_verified claims agree.".into()),
            status: ThesisStatus::Draft,
            invalidation_condition: Some("NVDA closes below the pre-earnings low.".into()),
            what_would_change_mind: Some("A second source contradicting the beat.".into()),
            claim_ids: vec!["claim-1".into()],
            rejected_claims: vec![],
            created_at: now,
            updated_at: now,
        };
        service.save_thesis(&thesis).unwrap();
        assert_eq!(service.thesis("thesis-f2").unwrap().unwrap(), thesis);
        assert_eq!(service.theses().unwrap(), vec![thesis.clone()]);

        let mut advanced = thesis.clone();
        advanced.status = ThesisStatus::Backtested;
        service.save_thesis(&advanced).unwrap();
        assert_eq!(
            service.thesis("thesis-f2").unwrap().unwrap().status,
            ThesisStatus::Backtested
        );

        let backtest = BacktestEvidenceRecord {
            backtest_id: "backtest-f2".into(),
            thesis_id: "thesis-f2".into(),
            run_id_a: "run-a".into(),
            run_id_b: "run-b".into(),
            config_fingerprint: None,
            metrics_a: BacktestMetrics {
                sharpe: Some(0.9),
                ..Default::default()
            },
            metrics_b: BacktestMetrics {
                sharpe: Some(1.7),
                ..Default::default()
            },
            delta: BacktestDelta {
                sharpe: Some(0.8),
                ..Default::default()
            },
            verdict: BacktestVerdict::Supported,
            could_not_run_reason: None,
            recorded_at: now,
            source: "fina-builder:tac-qlib-rd".into(),
        };
        service.save_backtest_evidence(&backtest).unwrap();
        assert_eq!(
            service.backtest_evidence("backtest-f2").unwrap().unwrap(),
            backtest
        );
        assert_eq!(
            service.backtest_evidence_for_thesis("thesis-f2").unwrap(),
            vec![backtest]
        );

        let transcript = TranscriptRecord {
            transcript_id: "transcript-f2".into(),
            thesis_id: "thesis-f2".into(),
            transcript_hash: "hash-f2".into(),
            summary: Some("NVDA long, verified.".into()),
            beats: vec![TranscriptBeat {
                ordinal: 1,
                title: "Hook".into(),
                script: "NVDA beat expectations.".into(),
                evidence_refs: vec![TranscriptEvidenceRef {
                    kind: "claim".into(),
                    claim_id: Some("claim-1".into()),
                    item_id: None,
                    backtest_id: None,
                    run_id: None,
                    evidence_span: None,
                }],
            }],
            fina_import_path: None,
            created_at: now,
        };
        service.save_transcript(&transcript).unwrap();
        assert_eq!(
            service.transcript("transcript-f2").unwrap().unwrap(),
            transcript
        );
        assert_eq!(
            service.transcripts_for_thesis("thesis-f2").unwrap(),
            vec![transcript]
        );

        // Provisional theses are listed but can never advance.
        let mut provisional = thesis.clone();
        provisional.thesis_id = "thesis-f2-provisional".into();
        provisional.thesis_basis = ThesisBasis::ProvisionalFastGlance;
        provisional.status = ThesisStatus::Draft;
        service.save_thesis(&provisional).unwrap();
        let mut blocked = provisional.clone();
        blocked.status = ThesisStatus::Published;
        assert!(service.save_thesis(&blocked).is_err());
        let blocked_transcript = TranscriptRecord {
            transcript_id: "transcript-f2-provisional".into(),
            thesis_id: "thesis-f2-provisional".into(),
            transcript_hash: "hash-prov".into(),
            summary: None,
            beats: vec![],
            fina_import_path: None,
            created_at: now,
        };
        assert!(service.save_transcript(&blocked_transcript).is_err());
        assert!(service
            .transcript("transcript-f2-provisional")
            .unwrap()
            .is_none());
    }

    #[test]
    fn f2_import_local_event_stores_mirrored_tier_and_review_status() {
        let temp = tempdir().unwrap();
        let mut service = service_at(temp.path());
        let import = LocalEventImport {
            source_id: SourceId::new("fina-scraper").unwrap(),
            source_display_name: "Alpaca news".into(),
            source_native_id: Some("item-nvda-1".into()),
            canonical_url: Some("https://fixture.test/nvda-1".into()),
            title: Some("NVDA beats".into()),
            content_text: "NVIDIA reported revenue above expectations.".into(),
            published_at: None,
            source_updated_at: None,
            rights_statement: "User-owned synthetic fixture".into(),
            user_confirmed_rights: true,
            extraction_tier: Some(ExtractionTier::Tier2Llm),
            review_status: Some(ClaimReviewStatus::LlmVerified),
        };
        let event = service
            .import_local_event(&import, "2026-11-24T16:00:00Z".parse().unwrap())
            .unwrap();
        assert_eq!(event.extraction_tier, Some(ExtractionTier::Tier2Llm));
        assert_eq!(event.review_status, Some(ClaimReviewStatus::LlmVerified));
        let page = service
            .search_events(&EventSearchQuery {
                text: None,
                source_id: None,
                as_of: None,
                cursor: None,
                limit: 10,
            })
            .unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(
            page.events[0].extraction_tier,
            Some(ExtractionTier::Tier2Llm)
        );
    }

    #[test]
    fn f2_agent_graph_claims_keep_mirrored_tier_and_review_status() {
        let temp = tempdir().unwrap();
        let mut service = service_at(temp.path());
        let event = import_bridge_event(&mut service);
        let draft = AgentNarrativeGraphDraft {
            event_id: event.event_id.as_str().to_owned(),
            producer: "fina-scraper".into(),
            model: "llm:fixture".into(),
            prompt_version: "p1".into(),
            narrative_title: "Policy stays restrictive".into(),
            narrative_thesis: "Policy remains restrictive until inflation cools.".into(),
            narrative_summary: "A verified claim about restrictive policy.".into(),
            entities: vec![nip_domain::AgentEntityDraft {
                canonical_name: "Federal Reserve".into(),
                entity_type: "organization".into(),
                surface_form: "inflation".into(),
                evidence_quote: "until inflation cools".into(),
            }],
            claims: vec![nip_domain::AgentClaimDraft {
                claim_text: "Policy remains restrictive until inflation cools.".into(),
                claim_type: "fact".into(),
                speaker_or_author: None,
                confidence_millis: 900,
                evidence_quote: "Policy remains restrictive until inflation cools.".into(),
                entity_names: vec!["Federal Reserve".into()],
                polarity: Some("neutral".into()),
                horizon: None,
                extraction_tier: Some(ExtractionTier::Tier2Llm),
                review_status: Some(ClaimReviewStatus::LlmVerified),
            }],
        };
        let (_analysis, claims, _graph) = service.build_agent_narrative_graph(draft).unwrap();
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].extraction_tier, Some(ExtractionTier::Tier2Llm));
        assert_eq!(
            claims[0].review_status,
            Some(ClaimReviewStatus::LlmVerified)
        );
        let stored = service.claims().unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].extraction_tier, Some(ExtractionTier::Tier2Llm));
        assert_eq!(
            stored[0].review_status,
            Some(ClaimReviewStatus::LlmVerified)
        );
    }
}
