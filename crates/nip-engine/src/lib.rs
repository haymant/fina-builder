pub mod asr;
pub mod comfy;
pub mod config;
pub mod jobs;
pub mod media;
pub mod podcast;
pub mod provider;
pub mod semantic;

use chrono::{DateTime, Datelike, Duration, TimeZone, Utc};
use nip_domain::{
    CapabilitiesResponse, ClaimEvidence, ClaimRecord, EditorialCandidate, EditorialReviewAudit,
    EmbeddingIndexManifest, EtfMapping, EventRecord, EventSearchPage, EventSearchQuery,
    ExtractionStatus, FeatureCapabilities, HealthResponse, LocalEventImport, NarrativeCluster,
    NarrativeGraph, NarrativeGraphEdge, NarrativeGraphNode, NarrativeSignal,
    NarrativeSignalSnapshot, NarrativeSource, PodcastEpisode, PodcastEpisodePage,
    PodcastEpisodeState,
    PodcastRefreshReport, PodcastSubscription, PodcastSubscriptionState, PodcastTranscript,
    ProviderConsent, ProviderStatus, Readiness, ResourceStatus, SemanticSearchResult, SourceId,
    SourceKind, SourceState, SourceUpdate, API_VERSION, DOMAIN_SCHEMA_VERSION, SERVICE_NAME,
};
use nip_store::{SnapshotManifest, Store, StoreError, SubscriptionFetchStateUpdate};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    sync::atomic::{AtomicU64, Ordering},
};
use thiserror::Error;

use asr::{AsrError, AsrProvider, AsrRequest, AsrResult};
pub use config::{ConfigError, NipConfig};
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
            evidence: vec![ClaimEvidence {
                event_id: event.event_id.clone(),
                quote: Some(claim_text),
                start_offset: Some(0),
                end_offset: Some(text.len() as u32),
            }],
        }])
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
    #[error("the configured RIGA provider is unavailable")]
    ProviderUnavailable,
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
        let store = Store::open(config.database_path())?;
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
                claim_extraction: self.config.riga_bridge().is_some(),
                parquet_export: true,
                semantic_search: true,
            },
        }
    }

    pub fn config(&self) -> &NipConfig {
        &self.config
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
        let subscription = self
            .store
            .subscription(source_id)?
            .ok_or(NipError::SubscriptionNotFound)?;
        if subscription.state != PodcastSubscriptionState::Active {
            return Err(NipError::SubscriptionInactive);
        }
        if subscription.next_poll_at.is_some_and(|next| now < next) {
            return Err(NipError::RefreshNotDue);
        }

        let response = match client.fetch(&FeedRequest {
            url: subscription.feed_url.clone(),
            etag: subscription.etag.clone(),
            last_modified: subscription.last_modified.clone(),
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
                    && subscription.next_poll_at.is_none_or(|next| now >= next)
            })
            .map(|subscription| subscription.source_id)
            .collect::<Vec<_>>();
        Ok(due_source_ids
            .iter()
            .map(|source_id| self.refresh_podcast_feed(source_id, client, now))
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
        let display_name = draft.display_name.trim();
        if display_name.is_empty() || draft.rights_statement.trim().is_empty() {
            return Err(NipError::InvalidSourceDetails);
        }
        let locator = draft
            .locator
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if locator.is_none() && !matches!(draft.kind, SourceKind::LocalDocument | SourceKind::Other) {
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
            self.store
                .update_source(&draft.source_id, &defaults, now)?;
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
            }
        }

        let mut normalised = update.clone();
        normalised.poll_interval_minutes =
            update.poll_interval_minutes.map(|minutes| clamp_poll_interval(Some(minutes)));
        normalised.per_scan_limit =
            update.per_scan_limit.map(|limit| clamp_per_scan_limit(Some(limit)));
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
        self.source(source_id)?;
        if !self.store.set_source_state(source_id, state, now)? {
            // Already in the requested state is still a success.
            return self.source(source_id);
        }
        self.source(source_id)
    }

    pub fn delete_source(&mut self, source_id: &SourceId) -> Result<(), NipError> {
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
        let (episodes, total) = self.store.discovered_episodes_page(
            source_id,
            title_contains,
            sort,
            limit,
            offset,
        )?;
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
    /// bridge is reported explicitly; NIP never substitutes a different model or
    /// falls back to the deterministic fake provider.
    pub fn provider_status(&self) -> Result<ProviderStatus, NipError> {
        let Some(bridge) = self.bridge_provider() else {
            return Ok(ProviderStatus {
                configured: false,
                bridge_state: "not_configured".into(),
                provider_kind: None,
                provider_id: None,
                model: None,
                reasoning_effort: None,
                provider_api: None,
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

    /// Extract claims from a retained event through the configured provider.
    /// Remote extraction performs no provider request until consent exists for
    /// the exact provider/model binding.
    pub fn extract_claims_from_event(
        &mut self,
        event_id: &str,
    ) -> Result<Vec<ClaimRecord>, NipError> {
        let event = self.store.event(event_id)?.ok_or(NipError::EventNotFound)?;
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
        let claims = provider.extract_with_status(&event, &status)?;
        for claim in &claims {
            self.store.store_claim(claim)?;
        }
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
        let embedded = events
            .into_iter()
            .map(|event| {
                let vector = provider
                    .embed(event.content_text.as_deref().unwrap_or(""))
                    .map_err(|_| NipError::SemanticUnavailable)?;
                Ok((event, vector.dense))
            })
            .collect::<Result<Vec<_>, NipError>>()?;
        let clusters = cluster_events(&embedded, run_id);
        self.store.replace_clusters(&clusters)?;
        Ok(clusters)
    }

    pub fn clusters(&self) -> Result<Vec<NarrativeCluster>, NipError> {
        Ok(self.store.clusters()?)
    }

    pub fn rebuild_graph(&mut self, run_id: String) -> Result<NarrativeGraph, NipError> {
        let clusters = self.store.clusters()?;
        let claims = self.store.claims()?;
        let events = self.store.all_events()?;
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
                label: event
                    .source_native_id
                    .clone()
                    .or_else(|| event.canonical_url.clone())
                    .unwrap_or_else(|| event_id.clone()),
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
                        label: event_id.clone(),
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
        for claim in claims {
            let claim_node = format!("claim:{}", claim.claim_id);
            let evidence: Vec<String> = claim
                .evidence
                .iter()
                .map(|item| item.event_id.as_str().to_owned())
                .collect();
            nodes.push(NarrativeGraphNode {
                node_id: claim_node.clone(),
                node_type: "claim".into(),
                label: claim.claim_text,
                evidence_event_ids: evidence.clone(),
            });
            for (index, event_id) in evidence.iter().enumerate() {
                if event_nodes.insert(event_id.clone()) {
                    nodes.push(NarrativeGraphNode {
                        node_id: format!("event:{event_id}"),
                        node_type: "event".into(),
                        label: event_id.clone(),
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
        let graph = NarrativeGraph {
            graph_id: format!("graph-{run_id}"),
            derivation_run_id: run_id,
            algorithm_version: "nip-graph-v1".into(),
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
        let request = podcast_asr_request(episode, audio_client)?;
        self.transcribe_podcast_episode(episode, request, provider, now)
    }
}

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
                "NIP_DATA_DIR".to_owned(),
                root.join("data").to_string_lossy().into_owned(),
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
        assert_eq!(health.schema_version, 9);

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
        let data_dir = root.join(".nip-data");
        let tac_dir = root.join(".lake");
        let config = NipConfig::resolve(
            &BTreeMap::from([
                (
                    "NIP_DATA_DIR".to_owned(),
                    data_dir.to_string_lossy().into_owned(),
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
        assert_eq!(service.config().lake_dir(), tac_dir.join("nip"));
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
                "NIP_DATA_DIR".to_owned(),
                root.join("data").to_string_lossy().into_owned(),
            )]),
            root,
            None,
            true,
        )
        .unwrap();
        NipService::open(config).unwrap()
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
        for (native_id, published_at, text) in [
            ("prior", "2026-11-08T12:00:00Z", "prior mention"),
            ("current", "2026-11-12T12:00:00Z", "current mention"),
            ("undated", "", "undated observation"),
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
                        published_at: (!published_at.is_empty())
                            .then(|| published_at.parse().unwrap()),
                        source_updated_at: None,
                        rights_statement: "synthetic fixture".into(),
                        user_confirmed_rights: true,
                    },
                    "2026-11-17T00:00:00Z".parse().unwrap(),
                )
                .unwrap();
        }
        // The point-in-time cutoff must follow the event's real ingestion time
        // (`Utc::now()`), otherwise this test becomes time-of-day dependent.
        let snapshot = service
            .signal_snapshot("2026-11-18T12:00:00Z".parse().unwrap())
            .unwrap();
        assert_eq!(snapshot.coverage, "unknown");
        assert_eq!(
            snapshot.current_week_start.to_rfc3339(),
            "2026-11-09T00:00:00+00:00"
        );
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
                    "NIP_DATA_DIR".to_owned(),
                    root.join("data").to_string_lossy().into_owned(),
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
                },
                "2026-11-17T09:00:00Z".parse().unwrap(),
            )
            .unwrap()
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
}
