pub mod config;
pub mod podcast;

use chrono::{DateTime, Utc};
use nip_domain::{
    CapabilitiesResponse, FeatureCapabilities, HealthResponse, PodcastEpisode, PodcastEpisodeState,
    PodcastRefreshReport, PodcastSubscription, PodcastSubscriptionState, Readiness, SourceId,
    API_VERSION, DOMAIN_SCHEMA_VERSION, SERVICE_NAME,
};
use nip_store::{Store, StoreError, SubscriptionFetchStateUpdate};
use std::fs;
use thiserror::Error;

pub use config::{ConfigError, NipConfig};
use podcast::{
    parse_rss_feed, scheduled_next_poll, validate_feed_url, FeedClient, FeedRequest,
    FeedValidationError,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PodcastSubscriptionRequest {
    pub source_id: SourceId,
    pub feed_url: String,
    pub show_name: String,
    pub rights_statement: String,
    pub user_confirmed_rights: bool,
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
                local_audio_transcription: false,
                claim_extraction: false,
                parquet_export: false,
                semantic_search: false,
            },
        }
    }

    pub fn config(&self) -> &NipConfig {
        &self.config
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
        if !self.store.set_subscription_state(source_id, state)? {
            return Err(NipError::SubscriptionNotFound);
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
}

fn map_feed_url_error(_: FeedValidationError) -> NipError {
    NipError::InvalidFeedUrl
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
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
        assert_eq!(health.schema_version, 2);

        let capabilities = service.capabilities();
        assert!(capabilities.features.duckdb_store);
        assert!(capabilities.features.podcast_rss_subscriptions);
        assert!(!capabilities.features.local_audio_transcription);
        assert!(!capabilities.features.claim_extraction);
        assert!(!capabilities.features.parquet_export);
        assert!(!capabilities.features.semantic_search);
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
}
