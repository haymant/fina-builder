use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use duckdb::{params, Connection, OptionalExt};
use nip_domain::{
    ClaimRecord, EditorialCandidate, EditorialReviewAudit, EmbeddingIndexManifest, EtfMapping,
    EventRecord, EventSearchPage, EventSearchQuery, LocalEventImport, NarrativeCluster,
    NarrativeClusterMember, NarrativeGraph, NarrativeSource, PodcastEpisode, PodcastEpisodeState,
    PodcastSubscription, PodcastSubscriptionState, PodcastTranscript, ProviderConsent, SourceId,
    SourceKind, SourceState, SourceUpdate,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

const MIGRATION_1: &str = include_str!("../migrations/0001_core.sql");
const MIGRATION_2: &str = include_str!("../migrations/0002_podcast_feeds.sql");
const MIGRATION_3: &str = include_str!("../migrations/0003_podcast_transcripts.sql");
const MIGRATION_4: &str = include_str!("../migrations/0004_claims.sql");
const MIGRATION_5: &str = include_str!("../migrations/0005_semantic_indexes.sql");
const MIGRATION_6: &str = include_str!("../migrations/0006_phase3_research.sql");
const MIGRATION_7: &str = include_str!("../migrations/0007_phase2_graph.sql");
const MIGRATION_8: &str = include_str!("../migrations/0008_provider_consent_audit.sql");
const MIGRATION_9: &str = include_str!("../migrations/0009_source_registry.sql");
const MIGRATION_10: &str = include_str!("../migrations/0010_publisher_transcripts.sql");
const LATEST_SCHEMA_VERSION: u32 = 10;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("NIP database path is empty")]
    EmptyDatabasePath,
    #[error("NIP database directory could not be prepared")]
    PrepareDirectory(#[source] std::io::Error),
    #[error("NIP DuckDB operation failed")]
    Database(#[from] duckdb::Error),
    #[error("NIP database schema version {found} is newer than supported version {supported}")]
    FutureSchema { found: u32, supported: u32 },
    #[error("stored NIP data contains an unsupported podcast state")]
    InvalidStoredState,
    #[error("podcast episode has neither an RSS GUID nor an episode URL")]
    MissingEpisodeIdentity,
    #[error("podcast transcript is invalid")]
    InvalidTranscript,
    #[error("local import requires explicit rights confirmation")]
    RightsConfirmationRequired,
    #[error("local event content is invalid")]
    InvalidEvent,
    #[error("manual research record is invalid")]
    InvalidResearchRecord,
    #[error("snapshot path is invalid")]
    InvalidSnapshotPath,
    #[error("snapshot manifest is invalid")]
    InvalidSnapshotManifest,
    #[error("snapshot database already exists")]
    SnapshotDatabaseExists,
    #[error("snapshot file operation failed")]
    SnapshotIo(#[source] std::io::Error),
    #[error("snapshot manifest serialization failed")]
    SnapshotJson(#[from] serde_json::Error),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotManifest {
    pub format: String,
    pub schema_version: u32,
    pub exported_at: DateTime<Utc>,
    pub event_count: u64,
    pub file_count: u64,
    pub content_sha256: String,
}

#[derive(Debug, Clone)]
pub struct SubscriptionFetchStateUpdate<'a> {
    pub source_id: &'a SourceId,
    pub etag: Option<&'a str>,
    pub last_modified: Option<&'a str>,
    pub checked_at: DateTime<Utc>,
    pub next_poll_at: DateTime<Utc>,
    pub last_error_code: Option<&'a str>,
    pub consecutive_failures: u32,
}

/// One local DuckDB ledger. The connection remains owned by the store and is
/// intentionally not shared with UI or transport code.
pub struct Store {
    connection: Connection,
    schema_version: u32,
    database_path: PathBuf,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let database_path = path.as_ref();
        if database_path.as_os_str().is_empty() {
            return Err(StoreError::EmptyDatabasePath);
        }
        if let Some(parent) = database_path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent).map_err(StoreError::PrepareDirectory)?;
        }

        let mut connection = Connection::open(database_path)?;
        let schema_version = apply_migrations(&mut connection)?;
        Ok(Self {
            connection,
            schema_version,
            database_path: database_path.to_path_buf(),
        })
    }

    pub fn schema_version(&self) -> u32 {
        self.schema_version
    }

    pub fn database_path(&self) -> &Path {
        &self.database_path
    }

    /// Export the complete DuckDB ledger and projections as an atomic Parquet
    /// snapshot. The export directory is immutable after the manifest is
    /// written; DuckDB remains the canonical store.
    pub fn export_parquet_snapshot(
        &self,
        lake_dir: impl AsRef<Path>,
    ) -> Result<(PathBuf, SnapshotManifest), StoreError> {
        let lake_dir = lake_dir.as_ref();
        if lake_dir.as_os_str().is_empty() {
            return Err(StoreError::InvalidSnapshotPath);
        }
        fs::create_dir_all(lake_dir).map_err(StoreError::SnapshotIo)?;
        let stamp = Utc::now().timestamp_nanos_opt().unwrap_or_default();
        let staging = lake_dir.join(format!(".staging-{stamp}"));
        let final_dir = lake_dir.join(format!("snapshot-{stamp}"));
        fs::create_dir_all(&staging).map_err(StoreError::SnapshotIo)?;
        let result = (|| {
            let event_count: u64 =
                self.connection
                    .query_row("SELECT COUNT(*) FROM nip_events", [], |row| row.get(0))?;
            let export_path = sql_string_literal(&staging);
            self.connection.execute(
                &format!("EXPORT DATABASE '{export_path}' (FORMAT PARQUET)"),
                [],
            )?;
            let (file_count, content_sha256) = snapshot_digest(&staging)?;
            let manifest = SnapshotManifest {
                format: "nip-duckdb-export-parquet-v1".into(),
                schema_version: self.schema_version,
                exported_at: Utc::now(),
                event_count,
                file_count,
                content_sha256,
            };
            fs::write(
                staging.join("nip-snapshot-manifest.json"),
                serde_json::to_vec_pretty(&manifest)?,
            )
            .map_err(StoreError::SnapshotIo)?;
            fs::rename(&staging, &final_dir).map_err(StoreError::SnapshotIo)?;
            Ok((final_dir, manifest))
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&staging);
        }
        result
    }

    /// Restore an immutable snapshot into a new DuckDB path after verifying
    /// its manifest and file digest. Existing databases are never overwritten.
    pub fn restore_parquet_snapshot(
        snapshot_dir: impl AsRef<Path>,
        database_path: impl AsRef<Path>,
    ) -> Result<SnapshotManifest, StoreError> {
        let snapshot_dir = snapshot_dir.as_ref();
        let database_path = database_path.as_ref();
        let manifest_path = snapshot_dir.join("nip-snapshot-manifest.json");
        let manifest: SnapshotManifest =
            serde_json::from_slice(&fs::read(&manifest_path).map_err(StoreError::SnapshotIo)?)?;
        if manifest.format != "nip-duckdb-export-parquet-v1"
            || manifest.schema_version > LATEST_SCHEMA_VERSION
        {
            return Err(StoreError::InvalidSnapshotManifest);
        }
        let (file_count, content_sha256) = snapshot_digest(snapshot_dir)?;
        if file_count != manifest.file_count || content_sha256 != manifest.content_sha256 {
            return Err(StoreError::InvalidSnapshotManifest);
        }
        if database_path.exists() {
            return Err(StoreError::SnapshotDatabaseExists);
        }
        if let Some(parent) = database_path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent).map_err(StoreError::SnapshotIo)?;
        }
        let connection = Connection::open(database_path)?;
        let snapshot_path = sql_string_literal(snapshot_dir);
        connection.execute(&format!("IMPORT DATABASE '{snapshot_path}'"), [])?;
        drop(connection);
        let restored = Self::open(database_path)?;
        let restored_count: u64 =
            restored
                .connection
                .query_row("SELECT COUNT(*) FROM nip_events", [], |row| row.get(0))?;
        if restored_count != manifest.event_count {
            return Err(StoreError::InvalidSnapshotManifest);
        }
        Ok(manifest)
    }

    /// Persist an already user-approved feed. There is deliberately no default
    /// catalog or implicit approval path.
    pub fn add_approved_subscription(
        &mut self,
        subscription: &PodcastSubscription,
    ) -> Result<(), StoreError> {
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO nip_sources
                (source_id, source_type, source_kind, display_name, locator, rights_status,
                 rights_statement, state)
             VALUES (?, 'podcast', 'podcast', ?, ?, 'approved', ?, ?)",
            params![
                subscription.source_id.as_str(),
                subscription.show_name,
                subscription.feed_url,
                subscription.rights_statement,
                registry_state_as_str(match subscription.state {
                    PodcastSubscriptionState::Active => SourceState::Active,
                    PodcastSubscriptionState::Paused => SourceState::Paused,
                    PodcastSubscriptionState::Removed => SourceState::Removed,
                }),
            ],
        )?;
        transaction.execute(
            "INSERT INTO nip_podcast_subscriptions
                (source_id, feed_url, show_name, rights_statement, rights_confirmed_at, state)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                subscription.source_id.as_str(),
                subscription.feed_url,
                subscription.show_name,
                subscription.rights_statement,
                subscription.rights_confirmed_at,
                subscription_state_as_str(subscription.state)
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn subscription(
        &self,
        source_id: &SourceId,
    ) -> Result<Option<PodcastSubscription>, StoreError> {
        let raw = self
            .connection
            .query_row(
                "SELECT source_id, feed_url, show_name, rights_statement, rights_confirmed_at,
                        state, etag, last_modified, last_checked_at, next_poll_at, last_error_code,
                        consecutive_failures
                 FROM nip_podcast_subscriptions WHERE source_id = ?",
                params![source_id.as_str()],
                raw_subscription_from_row,
            )
            .optional()?;
        raw.map(TryInto::try_into).transpose()
    }

    pub fn subscriptions(&self) -> Result<Vec<PodcastSubscription>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT source_id, feed_url, show_name, rights_statement, rights_confirmed_at,
                    state, etag, last_modified, last_checked_at, next_poll_at, last_error_code,
                    consecutive_failures
             FROM nip_podcast_subscriptions ORDER BY rights_confirmed_at, source_id",
        )?;
        let rows = statement.query_map([], raw_subscription_from_row)?;
        rows.map(|row| row?.try_into()).collect()
    }

    pub fn set_subscription_state(
        &mut self,
        source_id: &SourceId,
        state: PodcastSubscriptionState,
    ) -> Result<bool, StoreError> {
        let changed = self.connection.execute(
            "UPDATE nip_podcast_subscriptions SET state = ? WHERE source_id = ? AND state <> 'removed'",
            params![subscription_state_as_str(state), source_id.as_str()],
        )?;
        Ok(changed == 1)
    }

    /// All registry rows. Removed sources are retained for audit and are only
    /// returned when explicitly requested.
    pub fn sources(&self, include_removed: bool) -> Result<Vec<NarrativeSource>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT s.source_id, s.source_kind, s.display_name, s.locator, s.rights_status,
                    s.rights_statement, s.topics_json, s.state, s.poll_interval_minutes,
                    s.per_scan_limit, s.notes, s.created_at, s.updated_at,
                    (SELECT COUNT(*) FROM nip_events e WHERE e.source_id = s.source_id),
                    (SELECT COUNT(*) FROM nip_podcast_episodes p WHERE p.source_id = s.source_id)
             FROM nip_sources s
             WHERE (? OR s.state <> 'removed')
             ORDER BY s.display_name, s.source_id",
        )?;
        let rows = statement.query_map(params![include_removed], raw_source_from_row)?;
        rows.map(|row| row?.try_into()).collect()
    }

    pub fn source(&self, source_id: &SourceId) -> Result<Option<NarrativeSource>, StoreError> {
        let raw = self
            .connection
            .query_row(
                "SELECT s.source_id, s.source_kind, s.display_name, s.locator, s.rights_status,
                        s.rights_statement, s.topics_json, s.state, s.poll_interval_minutes,
                        s.per_scan_limit, s.notes, s.created_at, s.updated_at,
                        (SELECT COUNT(*) FROM nip_events e WHERE e.source_id = s.source_id),
                        (SELECT COUNT(*) FROM nip_podcast_episodes p WHERE p.source_id = s.source_id)
                 FROM nip_sources s WHERE s.source_id = ?",
                params![source_id.as_str()],
                raw_source_from_row,
            )
            .optional()?;
        raw.map(TryInto::try_into).transpose()
    }

    /// Register a source that has no podcast adapter row (all non-podcast kinds).
    pub fn insert_source(&mut self, source: &NarrativeSource) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO nip_sources
                (source_id, source_type, source_kind, display_name, locator, rights_status,
                 rights_statement, topics_json, state, poll_interval_minutes, per_scan_limit,
                 notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                source.source_id.as_str(),
                source.kind.coarse_type(),
                source.kind.as_str(),
                source.display_name,
                source.locator,
                source.rights_status,
                source.rights_statement,
                serde_json::to_string(&source.topics)?,
                registry_state_as_str(source.state),
                source.poll_interval_minutes.min(i32::MAX as u32) as i32,
                source.per_scan_limit.min(i32::MAX as u32) as i32,
                source.notes,
                source.created_at,
                source.updated_at,
            ],
        )?;
        Ok(())
    }

    pub fn update_source(
        &mut self,
        source_id: &SourceId,
        update: &SourceUpdate,
        now: DateTime<Utc>,
    ) -> Result<bool, StoreError> {
        let topics = update
            .topics
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let changed = self.connection.execute(
            "UPDATE nip_sources
             SET display_name = COALESCE(?, display_name),
                 locator = COALESCE(?, locator),
                 rights_statement = COALESCE(?, rights_statement),
                 topics_json = COALESCE(?, topics_json),
                 poll_interval_minutes = COALESCE(?, poll_interval_minutes),
                 per_scan_limit = COALESCE(?, per_scan_limit),
                 notes = COALESCE(?, notes),
                 updated_at = ?
             WHERE source_id = ? AND state <> 'removed'",
            params![
                update.display_name,
                update.locator,
                update.rights_statement,
                topics,
                update
                    .poll_interval_minutes
                    .map(|minutes| minutes.min(i32::MAX as u32) as i32),
                update
                    .per_scan_limit
                    .map(|limit| limit.min(i32::MAX as u32) as i32),
                update.notes,
                now,
                source_id.as_str(),
            ],
        )?;
        Ok(changed == 1)
    }

    /// Change the registry state and mirror it into the podcast adapter so a
    /// paused or removed feed is never refreshed.
    pub fn set_source_state(
        &mut self,
        source_id: &SourceId,
        state: SourceState,
        now: DateTime<Utc>,
    ) -> Result<bool, StoreError> {
        let transaction = self.connection.transaction()?;
        let changed = transaction.execute(
            "UPDATE nip_sources SET state = ?, updated_at = ?
             WHERE source_id = ? AND state <> ?",
            params![
                registry_state_as_str(state),
                now,
                source_id.as_str(),
                registry_state_as_str(state)
            ],
        )?;
        if changed == 1 {
            transaction.execute(
                "UPDATE nip_podcast_subscriptions SET state = ? WHERE source_id = ?",
                params![
                    registry_state_as_str(state),
                    source_id.as_str()
                ],
            )?;
        }
        transaction.commit()?;
        Ok(changed == 1)
    }

    /// Correct a podcast locator and forget the conditional-fetch bookkeeping so
    /// the next refresh fetches the feed in full.
    pub fn update_podcast_locator(
        &mut self,
        source_id: &SourceId,
        feed_url: &str,
        show_name: &str,
        now: DateTime<Utc>,
    ) -> Result<bool, StoreError> {
        let transaction = self.connection.transaction()?;
        let subscription_changed = transaction.execute(
            "UPDATE nip_podcast_subscriptions
             SET feed_url = ?, show_name = ?, etag = NULL, last_modified = NULL,
                 next_poll_at = NULL, last_error_code = NULL, consecutive_failures = 0
             WHERE source_id = ?",
            params![feed_url, show_name, source_id.as_str()],
        )?;
        transaction.execute(
            "UPDATE nip_sources
             SET locator = ?, display_name = ?, updated_at = ?
             WHERE source_id = ?",
            params![feed_url, show_name, now, source_id.as_str()],
        )?;
        transaction.commit()?;
        Ok(subscription_changed == 1)
    }

    /// Hard delete is only permitted when the source owns no retained events.
    /// Returns the event count when deletion is refused.
    pub fn delete_source(&mut self, source_id: &SourceId) -> Result<u64, StoreError> {
        let events: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM nip_events WHERE source_id = ?",
            params![source_id.as_str()],
            |row| row.get(0),
        )?;
        if events > 0 {
            return Ok(events.max(0) as u64);
        }
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "DELETE FROM nip_podcast_transcripts
             WHERE episode_id IN (SELECT episode_id FROM nip_podcast_episodes WHERE source_id = ?)",
            params![source_id.as_str()],
        )?;
        transaction.execute(
            "DELETE FROM nip_podcast_episodes WHERE source_id = ?",
            params![source_id.as_str()],
        )?;
        transaction.execute(
            "DELETE FROM nip_podcast_subscriptions WHERE source_id = ?",
            params![source_id.as_str()],
        )?;
        transaction.execute(
            "DELETE FROM nip_sources WHERE source_id = ?",
            params![source_id.as_str()],
        )?;
        transaction.commit()?;
        Ok(0)
    }

    pub fn update_subscription_fetch_state(
        &mut self,
        update: SubscriptionFetchStateUpdate<'_>,
    ) -> Result<bool, StoreError> {
        let SubscriptionFetchStateUpdate {
            source_id,
            etag,
            last_modified,
            checked_at,
            next_poll_at,
            last_error_code,
            consecutive_failures,
        } = update;
        let changed = self.connection.execute(
            "UPDATE nip_podcast_subscriptions
             SET etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
                 last_checked_at = ?, next_poll_at = ?, last_error_code = ?, consecutive_failures = ?
             WHERE source_id = ? AND state = 'active'",
            params![
                etag,
                last_modified,
                checked_at,
                next_poll_at,
                last_error_code,
                consecutive_failures.min(i32::MAX as u32) as i32,
                source_id.as_str()
            ],
        )?;
        Ok(changed == 1)
    }

    /// Record feed metadata idempotently. A repeated `(source, GUID)` or, when
    /// GUID is absent, `(source, canonical URL)` is a no-op.
    pub fn record_discovered_episodes(
        &mut self,
        episodes: &[PodcastEpisode],
    ) -> Result<u32, StoreError> {
        let transaction = self.connection.transaction()?;
        let mut inserted = 0_u32;
        for episode in episodes {
            let identity_key = episode_identity(episode)?;
            let exists: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM nip_podcast_episodes WHERE source_id = ? AND identity_key = ?)",
                params![episode.source_id.as_str(), identity_key],
                |row| row.get(0),
            )?;
            if exists {
                // Publisher transcript references are backfilled when a feed
                // starts advertising one: rows recorded before this column
                // existed would otherwise never see it. Identity metadata
                // stays first-observation-wins.
                if episode.transcript_url.is_some() {
                    transaction.execute(
                        "UPDATE nip_podcast_episodes
                         SET transcript_url = COALESCE(transcript_url, ?),
                             transcript_type = COALESCE(transcript_type, ?)
                         WHERE source_id = ? AND identity_key = ?",
                        params![
                            episode.transcript_url,
                            episode.transcript_type,
                            episode.source_id.as_str(),
                            identity_key
                        ],
                    )?;
                }
                continue;
            }
            let episode_id = stable_episode_id(episode.source_id.as_str(), &identity_key);
            transaction.execute(
                "INSERT INTO nip_podcast_episodes
                    (episode_id, source_id, identity_key, source_native_id, canonical_url, title,
                     enclosure_url, published_at, discovered_at, state,
                     transcript_url, transcript_type)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    episode_id,
                    episode.source_id.as_str(),
                    identity_key,
                    episode.source_native_id,
                    episode.canonical_url,
                    episode.title,
                    episode.enclosure_url,
                    episode.published_at,
                    episode.discovered_at,
                    episode_state_as_str(episode.state),
                    episode.transcript_url,
                    episode.transcript_type
                ],
            )?;
            inserted += 1;
        }
        transaction.commit()?;
        Ok(inserted)
    }

    pub fn discovered_episodes(
        &self,
        source_id: &SourceId,
    ) -> Result<Vec<PodcastEpisode>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT source_id, source_native_id, canonical_url, title, enclosure_url,
                    published_at, discovered_at, state, transcript_url, transcript_type
             FROM nip_podcast_episodes WHERE source_id = ? ORDER BY discovered_at, episode_id",
        )?;
        let rows = statement.query_map(params![source_id.as_str()], raw_episode_from_row)?;
        rows.map(|row| row?.try_into()).collect()
    }

    /// Stable, filtered page over discovered RSS metadata. The page is ordered
    /// before `LIMIT`/`OFFSET` so infinite scrolling cannot skip or duplicate a
    /// row when new episodes are discovered between requests.
    pub fn discovered_episodes_page(
        &self,
        source_id: Option<&SourceId>,
        title_contains: Option<&str>,
        sort: &str,
        limit: u32,
        offset: u32,
    ) -> Result<(Vec<PodcastEpisode>, u64), StoreError> {
        let source_filter = source_id.map(SourceId::as_str);
        let title_filter = title_contains
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_lowercase);
        let title_filter = title_filter.as_deref();
        let filter = "WHERE (? IS NULL OR source_id = ?)
                        AND (? IS NULL OR title ILIKE '%' || ? || '%')";
        let total: i64 = self.connection.query_row(
            &format!("SELECT COUNT(*) FROM nip_podcast_episodes {filter}"),
            params![source_filter, source_filter, title_filter, title_filter],
            |row| row.get(0),
        )?;
        let order = if sort == "title_asc" {
            "lower(COALESCE(title, source_native_id, '')) ASC, episode_id ASC"
        } else {
            "published_at DESC NULLS LAST, episode_id DESC"
        };
        let sql = format!(
            "SELECT source_id, source_native_id, canonical_url, title, enclosure_url,
                    published_at, discovered_at, state, transcript_url, transcript_type
             FROM nip_podcast_episodes
             {filter}
             ORDER BY {order}
             LIMIT ? OFFSET ?"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(
            params![
                source_filter,
                source_filter,
                title_filter,
                title_filter,
                i64::from(limit),
                i64::from(offset)
            ],
            raw_episode_from_row,
        )?;
        let episodes = rows
            .map(|row| row?.try_into())
            .collect::<Result<Vec<PodcastEpisode>, StoreError>>()?;
        Ok((episodes, total.max(0) as u64))
    }

    pub fn store_transcript(
        &mut self,
        episode: &PodcastEpisode,
        transcript: &PodcastTranscript,
    ) -> Result<(), StoreError> {
        if episode.source_id != transcript.source_id
            || transcript.transcript_text.trim().is_empty()
            || transcript.content_hash.trim().is_empty()
            || transcript.provenance_json.trim().is_empty()
        {
            return Err(StoreError::InvalidTranscript);
        }
        let identity_key = episode_identity(episode)?;
        let transaction = self.connection.transaction()?;
        let episode_id: String = transaction.query_row(
            "SELECT episode_id FROM nip_podcast_episodes WHERE source_id = ? AND identity_key = ?",
            params![episode.source_id.as_str(), identity_key],
            |row| row.get(0),
        )?;
        let event_id = format!(
            "event-{}",
            &hex_digest(format!("{}\0{}", episode_id, transcript.content_hash).as_bytes())[..32]
        );
        transaction.execute(
            "INSERT INTO nip_events (event_id, source_id, source_native_id, canonical_url,
                content_hash, content_text, published_at, source_updated_at, captured_at,
                ingested_at, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
             ON CONFLICT (event_id) DO NOTHING",
            params![
                event_id,
                episode.source_id.as_str(),
                episode.source_native_id,
                episode.canonical_url,
                transcript.content_hash,
                transcript.transcript_text,
                episode.published_at,
                Option::<DateTime<Utc>>::None,
                episode.discovered_at,
                transcript.transcribed_at,
            ],
        )?;
        transaction.execute(
            "INSERT INTO nip_podcast_transcripts
                (episode_id, transcript_text, content_hash, detected_language, provenance_json, transcribed_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT (episode_id) DO UPDATE SET
                transcript_text = excluded.transcript_text,
                content_hash = excluded.content_hash,
                detected_language = excluded.detected_language,
                provenance_json = excluded.provenance_json,
                transcribed_at = excluded.transcribed_at",
            params![
                episode_id,
                transcript.transcript_text,
                transcript.content_hash,
                transcript.detected_language,
                transcript.provenance_json,
                transcript.transcribed_at,
            ],
        )?;
        transaction.execute(
            "UPDATE nip_podcast_episodes SET state = 'transcribed' WHERE episode_id = ?",
            params![episode_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn set_episode_state(
        &mut self,
        episode: &PodcastEpisode,
        state: PodcastEpisodeState,
    ) -> Result<bool, StoreError> {
        let identity_key = episode_identity(episode)?;
        let changed = self.connection.execute(
            "UPDATE nip_podcast_episodes SET state = ? WHERE source_id = ? AND identity_key = ?",
            params![
                episode_state_as_str(state),
                episode.source_id.as_str(),
                identity_key
            ],
        )?;
        Ok(changed == 1)
    }

    pub fn import_local_event(
        &mut self,
        import: &LocalEventImport,
        captured_at: DateTime<Utc>,
    ) -> Result<EventRecord, StoreError> {
        if !import.user_confirmed_rights {
            return Err(StoreError::RightsConfirmationRequired);
        }
        if import.content_text.trim().is_empty()
            || import.source_display_name.trim().is_empty()
            || import.rights_statement.trim().is_empty()
        {
            return Err(StoreError::InvalidEvent);
        }
        let content_hash = hex_digest(import.content_text.as_bytes());
        let identity = import
            .source_native_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("native:{value}"))
            .or_else(|| {
                import
                    .canonical_url
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| format!("url:{value}"))
            })
            .unwrap_or_else(|| format!("bytes:{content_hash}"));
        let event_id = format!(
            "event-{}",
            &hex_digest(format!("{}\0{}", import.source_id.as_str(), identity).as_bytes())[..32]
        );
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO nip_sources (source_id, source_type, source_kind, display_name, locator, rights_status, rights_statement)
             VALUES (?, 'local_document', 'local_document', ?, ?, 'approved', ?)
             ON CONFLICT (source_id) DO NOTHING",
            params![
                import.source_id.as_str(),
                import.source_display_name,
                import.canonical_url,
                import.rights_statement,
            ],
        )?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM nip_events WHERE event_id = ?)",
            params![event_id],
            |row| row.get(0),
        )?;
        if !exists {
            transaction.execute(
                "INSERT INTO nip_events (event_id, source_id, source_native_id, canonical_url,
                    content_hash, content_text, published_at, source_updated_at, captured_at,
                    ingested_at, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
                params![
                    event_id,
                    import.source_id.as_str(),
                    import.source_native_id,
                    import.canonical_url,
                    content_hash,
                    import.content_text,
                    import.published_at,
                    import.source_updated_at,
                    captured_at,
                    Utc::now(),
                ],
            )?;
        }
        transaction.commit()?;
        self.event(&event_id)?.ok_or(StoreError::InvalidEvent)
    }

    pub fn save_etf_mapping(&mut self, mapping: &EtfMapping) -> Result<(), StoreError> {
        if mapping.mapping_id.trim().is_empty()
            || mapping.narrative_id.trim().is_empty()
            || mapping.rationale.trim().is_empty()
            || mapping.author.trim().is_empty()
            || mapping.evidence_event_ids.is_empty()
            || !valid_ticker(&mapping.ticker)
            || mapping.version == 0
            || mapping
                .effective_to
                .is_some_and(|end| end <= mapping.effective_from)
        {
            return Err(StoreError::InvalidResearchRecord);
        }
        for event_id in &mapping.evidence_event_ids {
            let exists: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM nip_events WHERE event_id = ?)",
                params![event_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(StoreError::InvalidResearchRecord);
            }
        }
        if let Some(previous_id) = mapping.supersedes_mapping_id.as_deref() {
            let previous: Option<(String, String, i32)> = self
                .connection
                .query_row(
                    "SELECT narrative_id, ticker, version FROM nip_etf_mappings WHERE mapping_id = ?",
                    params![previous_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let Some((narrative_id, ticker, version)) = previous else {
                return Err(StoreError::InvalidResearchRecord);
            };
            if narrative_id != mapping.narrative_id
                || ticker != mapping.ticker
                || mapping.version != (version.max(0) as u32).saturating_add(1)
            {
                return Err(StoreError::InvalidResearchRecord);
            }
            let already_superseded: bool = self.connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM nip_etf_mappings WHERE supersedes_mapping_id = ?)",
                params![previous_id],
                |row| row.get(0),
            )?;
            if already_superseded {
                return Err(StoreError::InvalidResearchRecord);
            }
        }
        self.connection.execute("INSERT INTO nip_etf_mappings (mapping_id, narrative_id, ticker, rationale, evidence_event_ids, author, reviewer, version, effective_from, effective_to, known_at, review_status, ticker_status, market_data_coverage, mapping_validity, supersedes_mapping_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", params![mapping.mapping_id, mapping.narrative_id, mapping.ticker, mapping.rationale, serde_json::to_string(&mapping.evidence_event_ids)?, mapping.author, mapping.reviewer, mapping.version as i32, mapping.effective_from, mapping.effective_to, mapping.known_at, mapping.review_status, mapping.ticker_status, mapping.market_data_coverage, mapping.mapping_validity, mapping.supersedes_mapping_id, mapping.created_at])?;
        Ok(())
    }

    pub fn etf_mappings(&self) -> Result<Vec<EtfMapping>, StoreError> {
        let mut statement = self.connection.prepare("SELECT mapping_id, narrative_id, ticker, rationale, evidence_event_ids, author, reviewer, version, effective_from, effective_to, known_at, review_status, ticker_status, market_data_coverage, mapping_validity, supersedes_mapping_id, created_at FROM nip_etf_mappings ORDER BY narrative_id, ticker, version")?;
        let rows = statement.query_map([], |row| {
            let evidence: String = row.get(4)?;
            Ok(EtfMapping {
                mapping_id: row.get(0)?,
                narrative_id: row.get(1)?,
                ticker: row.get(2)?,
                rationale: row.get(3)?,
                evidence_event_ids: serde_json::from_str(&evidence)
                    .map_err(|error| duckdb::Error::ToSqlConversionFailure(Box::new(error)))?,
                author: row.get(5)?,
                reviewer: row.get(6)?,
                version: row.get::<_, i32>(7)? as u32,
                effective_from: row.get(8)?,
                effective_to: row.get(9)?,
                known_at: row.get(10)?,
                review_status: row.get(11)?,
                ticker_status: row.get(12)?,
                market_data_coverage: row.get(13)?,
                mapping_validity: row.get(14)?,
                supersedes_mapping_id: row.get(15)?,
                created_at: row.get(16)?,
            })
        })?;
        Ok(rows.collect::<duckdb::Result<Vec<_>>>()?)
    }

    pub fn replace_editorial_candidates(
        &mut self,
        candidates: &[EditorialCandidate],
    ) -> Result<(), StoreError> {
        let transaction = self.connection.transaction()?;
        if let Some(first) = candidates.first() {
            // A derivation run may be regenerated only before any human review
            // exists. Once reviewed, the prior run is immutable and the caller
            // must create a new derivation run instead of erasing the audit.
            let reviewed: bool = transaction.query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM nip_editorial_review_audit a
                     JOIN nip_editorial_candidates c ON c.candidate_id = a.candidate_id
                     WHERE c.derivation_run_id = ?
                 ) OR EXISTS(
                     SELECT 1 FROM nip_editorial_candidates
                     WHERE derivation_run_id = ? AND review_status <> 'unreviewed'
                 )",
                params![first.derivation_run_id, first.derivation_run_id],
                |row| row.get(0),
            )?;
            if reviewed {
                return Err(StoreError::InvalidResearchRecord);
            }
            transaction.execute(
                "DELETE FROM nip_editorial_candidates WHERE derivation_run_id = ?",
                params![first.derivation_run_id],
            )?;
        }
        for candidate in candidates {
            if candidate.title_angle.trim().is_empty() || candidate.evidence_event_ids.is_empty() {
                return Err(StoreError::InvalidResearchRecord);
            }
            for event_id in &candidate.evidence_event_ids {
                let exists: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM nip_events WHERE event_id = ?)",
                    params![event_id],
                    |row| row.get(0),
                )?;
                if !exists {
                    return Err(StoreError::InvalidResearchRecord);
                }
            }
            transaction.execute("INSERT INTO nip_editorial_candidates (candidate_id, title_angle, narrative_ids, claim_ids, evidence_event_ids, rank, component_values, derivation_run_id, review_status, review_reason, reviewer, reviewed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", params![candidate.candidate_id, candidate.title_angle, serde_json::to_string(&candidate.narrative_ids)?, serde_json::to_string(&candidate.claim_ids)?, serde_json::to_string(&candidate.evidence_event_ids)?, candidate.rank as i32, serde_json::to_string(&candidate.component_values)?, candidate.derivation_run_id, candidate.review_status, candidate.review_reason, candidate.reviewer, candidate.reviewed_at, candidate.created_at])?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn editorial_candidates(&self) -> Result<Vec<EditorialCandidate>, StoreError> {
        let mut statement = self.connection.prepare("SELECT candidate_id, title_angle, narrative_ids, claim_ids, evidence_event_ids, rank, component_values, derivation_run_id, review_status, review_reason, reviewer, reviewed_at, created_at FROM nip_editorial_candidates ORDER BY rank, candidate_id")?;
        let rows = statement.query_map([], |row| {
            let parse = |index| -> duckdb::Result<Value> {
                let text: String = row.get(index)?;
                serde_json::from_str(&text)
                    .map_err(|error| duckdb::Error::ToSqlConversionFailure(Box::new(error)))
            };
            Ok(EditorialCandidate {
                candidate_id: row.get(0)?,
                title_angle: row.get(1)?,
                narrative_ids: serde_json::from_value(parse(2)?)
                    .map_err(|error| duckdb::Error::ToSqlConversionFailure(Box::new(error)))?,
                claim_ids: serde_json::from_value(parse(3)?)
                    .map_err(|error| duckdb::Error::ToSqlConversionFailure(Box::new(error)))?,
                evidence_event_ids: serde_json::from_value(parse(4)?)
                    .map_err(|error| duckdb::Error::ToSqlConversionFailure(Box::new(error)))?,
                rank: row.get::<_, i32>(5)? as u32,
                component_values: serde_json::from_value(parse(6)?)
                    .map_err(|error| duckdb::Error::ToSqlConversionFailure(Box::new(error)))?,
                derivation_run_id: row.get(7)?,
                review_status: row.get(8)?,
                review_reason: row.get(9)?,
                reviewer: row.get(10)?,
                reviewed_at: row.get(11)?,
                created_at: row.get(12)?,
            })
        })?;
        Ok(rows.collect::<duckdb::Result<Vec<_>>>()?)
    }

    pub fn review_editorial_candidate(
        &mut self,
        candidate_id: &str,
        status: &str,
        reason: &str,
        reviewer: &str,
        reviewed_at: DateTime<Utc>,
    ) -> Result<(), StoreError> {
        if !matches!(status, "relevant" | "irrelevant" | "deferred")
            || reason.trim().is_empty()
            || reviewer.trim().is_empty()
        {
            return Err(StoreError::InvalidResearchRecord);
        }
        let transaction = self.connection.transaction()?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM nip_editorial_candidates WHERE candidate_id = ?)",
            params![candidate_id],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(StoreError::InvalidResearchRecord);
        }
        let recorded_at = Utc::now();
        let review_id = format!(
            "review-{}",
            &hex_digest(
                format!("{candidate_id}\0{status}\0{reviewed_at}\0{recorded_at}").as_bytes()
            )[..32]
        );
        transaction.execute(
            "INSERT INTO nip_editorial_review_audit
                (review_id, candidate_id, review_status, review_reason, reviewer, reviewed_at, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                review_id,
                candidate_id,
                status,
                reason,
                reviewer,
                reviewed_at,
                recorded_at
            ],
        )?;
        transaction.execute(
            "UPDATE nip_editorial_candidates SET review_status = ?, review_reason = ?, reviewer = ?, reviewed_at = ? WHERE candidate_id = ?",
            params![status, reason, reviewer, reviewed_at, candidate_id],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn editorial_review_audit(
        &self,
        candidate_id: &str,
    ) -> Result<Vec<EditorialReviewAudit>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT review_id, candidate_id, review_status, review_reason, reviewer,
                    reviewed_at, recorded_at
             FROM nip_editorial_review_audit WHERE candidate_id = ?
             ORDER BY recorded_at, review_id",
        )?;
        let rows = statement.query_map(params![candidate_id], |row| {
            Ok(EditorialReviewAudit {
                review_id: row.get(0)?,
                candidate_id: row.get(1)?,
                review_status: row.get(2)?,
                review_reason: row.get(3)?,
                reviewer: row.get(4)?,
                reviewed_at: row.get(5)?,
                recorded_at: row.get(6)?,
            })
        })?;
        rows.collect::<duckdb::Result<Vec<_>>>()
            .map_err(StoreError::from)
    }

    /// Append one consent audit event. `consent_id` is unique and the table is
    /// never updated in place, so granting and revoking preserve history.
    pub fn record_provider_consent(&mut self, consent: &ProviderConsent) -> Result<(), StoreError> {
        if consent.consent_id.trim().is_empty()
            || !matches!(consent.action.as_str(), "granted" | "revoked")
            || consent.provider_kind.trim().is_empty()
            || consent.model.trim().is_empty()
            || consent.scope.trim().is_empty()
            || consent.disclosure.trim().is_empty()
            || consent.actor.trim().is_empty()
        {
            return Err(StoreError::InvalidResearchRecord);
        }
        self.connection.execute(
            "INSERT INTO nip_provider_consents
                (consent_id, action, provider_kind, provider_id, model, scope, disclosure,
                 actor, reason, recorded_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                consent.consent_id,
                consent.action,
                consent.provider_kind,
                consent.provider_id,
                consent.model,
                consent.scope,
                consent.disclosure,
                consent.actor,
                consent.reason,
                consent.recorded_at,
            ],
        )?;
        Ok(())
    }

    /// Latest consent event for one provider/model/scope binding. `None` means
    /// no consent was ever recorded for that exact binding.
    pub fn latest_provider_consent(
        &self,
        provider_kind: &str,
        provider_id: Option<&str>,
        model: &str,
        scope: &str,
    ) -> Result<Option<ProviderConsent>, StoreError> {
        self.connection
            .query_row(
                "SELECT consent_id, action, provider_kind, provider_id, model, scope,
                        disclosure, actor, reason, recorded_at
                 FROM nip_provider_consents
                 WHERE provider_kind = ? AND provider_id IS NOT DISTINCT FROM ?
                   AND model = ? AND scope = ?
                 ORDER BY recorded_at DESC, consent_id DESC
                 LIMIT 1",
                params![provider_kind, provider_id, model, scope],
                |row| {
                    Ok(ProviderConsent {
                        consent_id: row.get(0)?,
                        action: row.get(1)?,
                        provider_kind: row.get(2)?,
                        provider_id: row.get(3)?,
                        model: row.get(4)?,
                        scope: row.get(5)?,
                        disclosure: row.get(6)?,
                        actor: row.get(7)?,
                        reason: row.get(8)?,
                        recorded_at: row.get(9)?,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// The canonical event committed for one podcast episode. Used by the UI
    /// to open the retained transcript directly from the episode row.
    pub fn event_for_source_native(
        &self,
        source_id: &SourceId,
        source_native_id: &str,
    ) -> Result<Option<EventRecord>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT event_id, source_id, source_native_id, canonical_url, content_hash,
                    content_text, published_at, source_updated_at, captured_at, ingested_at,
                    revision_of FROM nip_events
             WHERE source_id = ? AND source_native_id = ?
             ORDER BY ingested_at DESC LIMIT 1",
        )?;
        let mut rows = statement.query_map(
            params![source_id.as_str(), source_native_id],
            raw_event_from_row,
        )?;
        match rows.next() {
            Some(row) => Ok(Some(row?.try_into()?)),
            None => Ok(None),
        }
    }

    pub fn search_events(&self, query: &EventSearchQuery) -> Result<EventSearchPage, StoreError> {
        let limit = query.limit.clamp(1, 200) as i64;
        let cursor = query.cursor.as_deref().unwrap_or("");
        let mut statement = self.connection.prepare(
            "SELECT event_id, source_id, source_native_id, canonical_url, content_hash,
                    content_text, published_at, source_updated_at, captured_at, ingested_at,
                    revision_of FROM nip_events
             WHERE event_id > ?
               AND (? IS NULL OR source_id = ?)
               AND (? IS NULL OR content_text ILIKE '%' || ? || '%')
               AND (? IS NULL OR ingested_at <= ?)
             ORDER BY event_id LIMIT ?",
        )?;
        let text = query.text.as_deref();
        let source = query.source_id.as_ref().map(SourceId::as_str);
        let rows = statement.query_map(
            params![
                cursor,
                source,
                source,
                text,
                text,
                query.as_of,
                query.as_of,
                limit
            ],
            raw_event_from_row,
        )?;
        let events = rows.collect::<duckdb::Result<Vec<_>>>()?;
        let next_cursor = (events.len() == limit as usize)
            .then(|| {
                events
                    .last()
                    .map(|event| event.event_id.as_str().to_owned())
            })
            .flatten();
        Ok(EventSearchPage {
            events: events
                .into_iter()
                .map(|raw| raw.try_into())
                .collect::<Result<Vec<_>, _>>()?,
            next_cursor,
        })
    }

    /// Return canonical events with their version-1 diffusion category. This is
    /// deliberately a read-only projection; DuckDB remains the signal input.
    pub fn events_with_source_categories(
        &self,
        as_of: Option<DateTime<Utc>>,
    ) -> Result<Vec<(EventRecord, String)>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT e.event_id, e.source_id, e.source_native_id, e.canonical_url,
                    e.content_hash, e.content_text, e.published_at, e.source_updated_at,
                    e.captured_at, e.ingested_at, e.revision_of,
                    COALESCE(s.source_type, 'other')
             FROM nip_events e
             LEFT JOIN nip_sources s ON s.source_id = e.source_id
             WHERE (? IS NULL OR e.ingested_at <= ?)
             ORDER BY e.event_id",
        )?;
        let rows = statement.query_map(params![as_of, as_of], |row| {
            let raw = raw_event_from_row(row)?;
            let category: String = row.get(11)?;
            Ok((raw, source_category(category)))
        })?;
        rows.collect::<duckdb::Result<Vec<_>>>()?
            .into_iter()
            .map(|(raw, category)| raw.try_into().map(|event| (event, category)))
            .collect::<Result<Vec<_>, _>>()
    }

    pub fn store_claim(&mut self, claim: &ClaimRecord) -> Result<(), StoreError> {
        if claim.claim_text.trim().is_empty() || claim.extraction_run_id.trim().is_empty() {
            return Err(StoreError::InvalidEvent);
        }
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO nip_claims (claim_id, claim_text, speaker_or_author, confidence_millis,
                extraction_run_id, provider, model, prompt_version, provider_kind,
                provider_profile_id, reasoning_effort, extracted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (claim_id) DO UPDATE SET claim_text = excluded.claim_text,
                speaker_or_author = excluded.speaker_or_author,
                confidence_millis = excluded.confidence_millis,
                extraction_run_id = excluded.extraction_run_id,
                provider = excluded.provider, model = excluded.model,
                prompt_version = excluded.prompt_version,
                provider_kind = excluded.provider_kind,
                provider_profile_id = excluded.provider_profile_id,
                reasoning_effort = excluded.reasoning_effort,
                extracted_at = excluded.extracted_at",
            params![
                claim.claim_id,
                claim.claim_text,
                claim.speaker_or_author,
                claim.confidence_millis as i32,
                claim.extraction_run_id,
                claim.provider,
                claim.model,
                claim.prompt_version,
                claim.provider_kind,
                claim.provider_profile_id,
                claim.reasoning_effort,
                claim.extracted_at,
            ],
        )?;
        for evidence in &claim.evidence {
            transaction.execute(
                "INSERT INTO nip_claim_evidence (claim_id, event_id, quote, start_offset, end_offset)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (claim_id, event_id) DO UPDATE SET quote = excluded.quote,
                    start_offset = excluded.start_offset, end_offset = excluded.end_offset",
                params![
                    claim.claim_id,
                    evidence.event_id.as_str(),
                    evidence.quote,
                    evidence.start_offset.map(|value| value as i32),
                    evidence.end_offset.map(|value| value as i32),
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn claims(&self) -> Result<Vec<ClaimRecord>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT claim_id, claim_text, speaker_or_author, confidence_millis,
                    extraction_run_id, provider, model, prompt_version, extracted_at,
                    provider_kind, provider_profile_id, reasoning_effort
             FROM nip_claims ORDER BY extracted_at, claim_id",
        )?;
        let mut claims = Vec::new();
        for row in statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get(2)?,
                row.get::<_, i32>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<String>>(11)?,
            ))
        })? {
            let (
                claim_id,
                claim_text,
                speaker,
                confidence,
                run,
                provider,
                model,
                prompt,
                extracted_at,
                provider_kind,
                provider_profile_id,
                reasoning_effort,
            ) = row?;
            let mut evidence_statement = self.connection.prepare(
                "SELECT event_id, quote, start_offset, end_offset FROM nip_claim_evidence WHERE claim_id = ? ORDER BY event_id",
            )?;
            let evidence_rows = evidence_statement
                .query_map(params![claim_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<i32>>(2)?,
                        row.get::<_, Option<i32>>(3)?,
                    ))
                })?
                .collect::<duckdb::Result<Vec<_>>>()?;
            let evidence = evidence_rows
                .into_iter()
                .map(|(event_id, quote, start_offset, end_offset)| {
                    Ok(nip_domain::ClaimEvidence {
                        event_id: nip_domain::EventId::new(event_id)
                            .map_err(|_| StoreError::InvalidEvent)?,
                        quote,
                        start_offset: start_offset.map(|v| v as u32),
                        end_offset: end_offset.map(|v| v as u32),
                    })
                })
                .collect::<Result<Vec<_>, StoreError>>()?;
            claims.push(ClaimRecord {
                claim_id,
                claim_text,
                speaker_or_author: speaker,
                confidence_millis: confidence.clamp(0, 1000) as u16,
                extraction_run_id: run,
                provider,
                model,
                prompt_version: prompt,
                provider_kind,
                provider_profile_id,
                reasoning_effort,
                extracted_at,
                evidence,
            });
        }
        Ok(claims)
    }

    pub fn all_events(&self) -> Result<Vec<EventRecord>, StoreError> {
        let page = self.search_events(&EventSearchQuery {
            text: None,
            source_id: None,
            as_of: None,
            cursor: None,
            limit: 200,
        })?;
        Ok(page.events)
    }

    pub fn save_embedding_manifest(
        &mut self,
        manifest: &EmbeddingIndexManifest,
    ) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO nip_embedding_indexes
             (index_id, model_id, model_revision, dimensions, chunking_version, collection_name,
              status, event_count, created_at, completed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (index_id) DO UPDATE SET status = excluded.status,
                event_count = excluded.event_count, completed_at = excluded.completed_at",
            params![
                manifest.index_id,
                manifest.model_id,
                manifest.model_revision,
                manifest.dimensions as i32,
                manifest.chunking_version,
                manifest.collection_name,
                manifest.status,
                manifest.event_count as i32,
                manifest.created_at,
                manifest.completed_at
            ],
        )?;
        Ok(())
    }

    pub fn embedding_manifests(&self) -> Result<Vec<EmbeddingIndexManifest>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT index_id, model_id, model_revision, dimensions, chunking_version,
                    collection_name, status, event_count, created_at, completed_at
             FROM nip_embedding_indexes ORDER BY created_at DESC, index_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(EmbeddingIndexManifest {
                index_id: row.get(0)?,
                model_id: row.get(1)?,
                model_revision: row.get(2)?,
                dimensions: row.get::<_, i32>(3)?.max(0) as u32,
                chunking_version: row.get(4)?,
                collection_name: row.get(5)?,
                status: row.get(6)?,
                event_count: row.get::<_, i32>(7)?.max(0) as u32,
                created_at: row.get(8)?,
                completed_at: row.get(9)?,
            })
        })?;
        rows.collect::<duckdb::Result<Vec<_>>>()
            .map_err(StoreError::from)
    }

    pub fn replace_clusters(&mut self, clusters: &[NarrativeCluster]) -> Result<(), StoreError> {
        // DuckDB checks a parent delete against the rows that still reference
        // it and does not account for children removed earlier in the same
        // transaction, so clearing memberships and clusters together fails on
        // every rebuild after the first. Clear the memberships in their own
        // transaction first.
        {
            let transaction = self.connection.transaction()?;
            transaction.execute("DELETE FROM nip_cluster_memberships", [])?;
            transaction.commit()?;
        }
        let transaction = self.connection.transaction()?;
        transaction.execute("DELETE FROM nip_narrative_clusters", [])?;
        for cluster in clusters {
            transaction.execute(
                "INSERT INTO nip_narrative_clusters
                 (cluster_id, derivation_run_id, label, algorithm_version, member_count, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)",
                params![
                    cluster.cluster_id,
                    cluster.derivation_run_id,
                    cluster.label,
                    cluster.algorithm_version,
                    cluster.member_count as i32,
                    cluster.created_at
                ],
            )?;
            for member in &cluster.members {
                transaction.execute(
                    "INSERT INTO nip_cluster_memberships
                     (derivation_run_id, cluster_id, event_id, similarity_millis, rank)
                     VALUES (?, ?, ?, ?, ?)",
                    params![
                        cluster.derivation_run_id,
                        cluster.cluster_id,
                        member.event_id.as_str(),
                        member.similarity_millis as i32,
                        member.rank as i32
                    ],
                )?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn clusters(&self) -> Result<Vec<NarrativeCluster>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT cluster_id, derivation_run_id, label, algorithm_version, member_count, created_at
             FROM nip_narrative_clusters ORDER BY derivation_run_id, cluster_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i32>(4)?,
                row.get(5)?,
            ))
        })?;
        let mut clusters = Vec::new();
        for row in rows {
            let (cluster_id, run, label, algorithm, count, created_at) = row?;
            let mut members_statement = self.connection.prepare(
                "SELECT event_id, similarity_millis, rank FROM nip_cluster_memberships
                 WHERE derivation_run_id = ? AND cluster_id = ? ORDER BY rank, event_id",
            )?;
            let members = members_statement
                .query_map(params![run, cluster_id], |member| {
                    Ok(NarrativeClusterMember {
                        event_id: nip_domain::EventId::new(member.get::<_, String>(0)?).map_err(
                            |_| {
                                duckdb::Error::ToSqlConversionFailure(Box::new(
                                    std::io::Error::other("invalid event id"),
                                ))
                            },
                        )?,
                        similarity_millis: member.get::<_, i32>(1)?.clamp(0, 1000) as u16,
                        rank: member.get::<_, i32>(2)?.max(0) as u32,
                    })
                })?
                .collect::<duckdb::Result<Vec<_>>>()?;
            clusters.push(NarrativeCluster {
                cluster_id,
                derivation_run_id: run,
                label,
                algorithm_version: algorithm,
                member_count: count.max(0) as u32,
                created_at,
                members,
            });
        }
        Ok(clusters)
    }

    pub fn save_graph(&mut self, graph: &NarrativeGraph) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO nip_graph_projections (graph_id, derivation_run_id, algorithm_version, created_at, graph_json)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (graph_id) DO UPDATE SET derivation_run_id = excluded.derivation_run_id,
                algorithm_version = excluded.algorithm_version, created_at = excluded.created_at,
                graph_json = excluded.graph_json",
            params![
                graph.graph_id,
                graph.derivation_run_id,
                graph.algorithm_version,
                graph.created_at,
                serde_json::to_string(graph)?
            ],
        )?;
        Ok(())
    }

    pub fn latest_graph(&self) -> Result<Option<NarrativeGraph>, StoreError> {
        let value: Option<String> = self
            .connection
            .query_row(
                "SELECT graph_json FROM nip_graph_projections ORDER BY created_at DESC, graph_id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        value
            .map(|json| serde_json::from_str(&json).map_err(StoreError::SnapshotJson))
            .transpose()
    }

    pub fn event(&self, event_id: &str) -> Result<Option<EventRecord>, StoreError> {
        self.connection.query_row(
            "SELECT event_id, source_id, source_native_id, canonical_url, content_hash,
                    content_text, published_at, source_updated_at, captured_at, ingested_at, revision_of
             FROM nip_events WHERE event_id = ?",
            params![event_id], raw_event_from_row,
        ).optional()?.map(TryInto::try_into).transpose()
    }

    #[cfg(test)]
    fn has_table(&self, table: &str) -> Result<bool, StoreError> {
        let count: i64 = self.connection.query_row(
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'main' AND table_name = ?",
            params![table],
            |row| row.get(0),
        )?;
        Ok(count == 1)
    }
}

fn apply_migrations(connection: &mut Connection) -> Result<u32, StoreError> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS nip_schema_migrations (
             version INTEGER PRIMARY KEY,
             name VARCHAR NOT NULL,
             applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
         );",
    )?;

    let current_version: i64 = connection.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM nip_schema_migrations",
        [],
        |row| row.get(0),
    )?;
    let mut current_version = u32::try_from(current_version).unwrap_or(u32::MAX);
    if current_version > LATEST_SCHEMA_VERSION {
        return Err(StoreError::FutureSchema {
            found: current_version,
            supported: LATEST_SCHEMA_VERSION,
        });
    }

    let mut applied_any = false;
    if current_version < 1 {
        apply_migration(connection, 1, "core", MIGRATION_1)?;
        current_version = 1;
        applied_any = true;
    }
    if current_version < 2 {
        apply_migration(connection, 2, "podcast_feeds", MIGRATION_2)?;
        applied_any = true;
    }
    if current_version < 3 {
        apply_migration(connection, 3, "podcast_transcripts", MIGRATION_3)?;
        applied_any = true;
    }
    if current_version < 4 {
        apply_migration(connection, 4, "claims", MIGRATION_4)?;
        applied_any = true;
    }
    if current_version < 5 {
        apply_migration(connection, 5, "semantic_indexes", MIGRATION_5)?;
        current_version = 5;
        applied_any = true;
    }
    if current_version < 6 {
        apply_migration(connection, 6, "phase3_research", MIGRATION_6)?;
        applied_any = true;
    }
    if current_version < 7 {
        apply_migration(connection, 7, "phase2_graph", MIGRATION_7)?;
        applied_any = true;
    }
    if current_version < 8 {
        apply_migration(connection, 8, "provider_consent_audit", MIGRATION_8)?;
        applied_any = true;
    }
    if current_version < 9 {
        apply_migration(connection, 9, "source_registry", MIGRATION_9)?;
        current_version = 9;
        applied_any = true;
    }
    if current_version < 10 {
        apply_migration(connection, 10, "publisher_transcripts", MIGRATION_10)?;
        applied_any = true;
    }
    let _ = current_version;
    if applied_any {
        // Migration 0009 rebuilds tables (DROP/RENAME). DuckDB cannot replay
        // those catalog records from a WAL left behind by a crashed process, so
        // flush the migration into the database file immediately.
        connection.execute_batch("CHECKPOINT;")?;
    }
    Ok(LATEST_SCHEMA_VERSION)
}

fn apply_migration(
    connection: &mut Connection,
    version: i32,
    name: &str,
    sql: &str,
) -> Result<(), StoreError> {
    let transaction = connection.transaction()?;
    transaction.execute_batch(sql)?;
    transaction.execute(
        "INSERT INTO nip_schema_migrations (version, name) VALUES (?, ?)",
        params![version, name],
    )?;
    transaction.commit()?;
    Ok(())
}

fn sql_string_literal(path: &Path) -> String {
    path.to_string_lossy().replace('\'', "''")
}

fn snapshot_digest(root: &Path) -> Result<(u64, String), StoreError> {
    let mut files = Vec::new();
    collect_snapshot_files(root, root, &mut files)?;
    files.sort_by(|left, right| left.0.cmp(&right.0));
    let mut digest = Sha256::new();
    for (relative, path) in &files {
        digest.update(relative.as_bytes());
        digest.update([0]);
        digest.update(fs::read(path).map_err(StoreError::SnapshotIo)?);
    }
    Ok((files.len() as u64, format!("{:x}", digest.finalize())))
}

fn collect_snapshot_files(
    root: &Path,
    directory: &Path,
    files: &mut Vec<(String, PathBuf)>,
) -> Result<(), StoreError> {
    let mut entries = fs::read_dir(directory)
        .map_err(StoreError::SnapshotIo)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(StoreError::SnapshotIo)?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect_snapshot_files(root, &path, files)?;
        } else if path.file_name().and_then(|name| name.to_str())
            != Some("nip-snapshot-manifest.json")
        {
            let relative = path
                .strip_prefix(root)
                .map_err(|_| StoreError::InvalidSnapshotPath)?
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            files.push((relative, path));
        }
    }
    Ok(())
}

fn registry_state_as_str(state: SourceState) -> &'static str {
    state.as_str()
}

fn subscription_state_as_str(state: PodcastSubscriptionState) -> &'static str {
    match state {
        PodcastSubscriptionState::Active => "active",
        PodcastSubscriptionState::Paused => "paused",
        PodcastSubscriptionState::Removed => "removed",
    }
}

fn episode_state_as_str(state: PodcastEpisodeState) -> &'static str {
    match state {
        PodcastEpisodeState::AwaitingLocalTranscription => "awaiting_local_transcription",
        PodcastEpisodeState::TranscriptionUnavailable => "transcription_unavailable",
        PodcastEpisodeState::Transcribed => "transcribed",
        PodcastEpisodeState::Failed => "failed",
    }
}

fn episode_identity(episode: &PodcastEpisode) -> Result<String, StoreError> {
    if let Some(guid) = episode
        .source_native_id
        .as_deref()
        .map(str::trim)
        .filter(|guid| !guid.is_empty())
    {
        return Ok(format!("guid:{guid}"));
    }
    episode
        .canonical_url
        .as_deref()
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(|url| format!("url:{url}"))
        .ok_or(StoreError::MissingEpisodeIdentity)
}

fn stable_episode_id(source_id: &str, identity_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source_id.as_bytes());
    hasher.update([0]);
    hasher.update(identity_key.as_bytes());
    let digest = hasher.finalize();
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("episode-{}", &hex[..32])
}

fn hex_digest(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

struct RawEvent {
    event_id: String,
    source_id: String,
    source_native_id: Option<String>,
    canonical_url: Option<String>,
    content_hash: String,
    content_text: Option<String>,
    published_at: Option<DateTime<Utc>>,
    source_updated_at: Option<DateTime<Utc>>,
    captured_at: DateTime<Utc>,
    ingested_at: DateTime<Utc>,
    revision_of: Option<String>,
}

fn source_category(source_type: String) -> String {
    match source_type.as_str() {
        "podcast" => "podcast",
        "news" => "news",
        "corporate" => "corporate",
        "community" => "community",
        _ => "other",
    }
    .to_owned()
}

fn valid_ticker(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= 12
        && trimmed.chars().all(|character| {
            character.is_ascii_uppercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '-')
        })
}
fn raw_event_from_row(row: &duckdb::Row<'_>) -> duckdb::Result<RawEvent> {
    Ok(RawEvent {
        event_id: row.get(0)?,
        source_id: row.get(1)?,
        source_native_id: row.get(2)?,
        canonical_url: row.get(3)?,
        content_hash: row.get(4)?,
        content_text: row.get(5)?,
        published_at: row.get(6)?,
        source_updated_at: row.get(7)?,
        captured_at: row.get(8)?,
        ingested_at: row.get(9)?,
        revision_of: row.get(10)?,
    })
}

impl TryFrom<RawEvent> for EventRecord {
    type Error = StoreError;

    fn try_from(raw: RawEvent) -> Result<Self, Self::Error> {
        Ok(Self {
            schema_version: 1,
            event_id: nip_domain::EventId::new(raw.event_id)
                .map_err(|_| StoreError::InvalidEvent)?,
            source_id: SourceId::new(raw.source_id).map_err(|_| StoreError::InvalidEvent)?,
            source_native_id: raw.source_native_id,
            canonical_url: raw.canonical_url,
            content_hash: raw.content_hash,
            content_text: raw.content_text,
            times: nip_domain::EventTimes {
                published_at: raw.published_at,
                source_updated_at: raw.source_updated_at,
                captured_at: raw.captured_at,
                ingested_at: raw.ingested_at,
            },
            revision_of: raw
                .revision_of
                .and_then(|id| nip_domain::EventId::new(id).ok()),
        })
    }
}

struct RawSource {
    source_id: String,
    kind: String,
    display_name: String,
    locator: Option<String>,
    rights_status: String,
    rights_statement: Option<String>,
    topics_json: String,
    state: String,
    poll_interval_minutes: i32,
    per_scan_limit: i32,
    notes: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    event_count: i64,
    episode_count: i64,
}

fn raw_source_from_row(row: &duckdb::Row<'_>) -> duckdb::Result<RawSource> {
    Ok(RawSource {
        source_id: row.get(0)?,
        kind: row.get(1)?,
        display_name: row.get(2)?,
        locator: row.get(3)?,
        rights_status: row.get(4)?,
        rights_statement: row.get(5)?,
        topics_json: row.get(6)?,
        state: row.get(7)?,
        poll_interval_minutes: row.get(8)?,
        per_scan_limit: row.get(9)?,
        notes: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        event_count: row.get(13)?,
        episode_count: row.get(14)?,
    })
}

impl TryFrom<RawSource> for NarrativeSource {
    type Error = StoreError;

    fn try_from(raw: RawSource) -> Result<Self, Self::Error> {
        Ok(Self {
            source_id: SourceId::new(raw.source_id).map_err(|_| StoreError::InvalidStoredState)?,
            kind: SourceKind::parse(&raw.kind).ok_or(StoreError::InvalidStoredState)?,
            display_name: raw.display_name,
            locator: raw.locator,
            rights_status: raw.rights_status,
            rights_statement: raw.rights_statement,
            topics: serde_json::from_str(&raw.topics_json).unwrap_or_default(),
            state: SourceState::parse(&raw.state).ok_or(StoreError::InvalidStoredState)?,
            poll_interval_minutes: raw.poll_interval_minutes.max(0) as u32,
            per_scan_limit: raw.per_scan_limit.max(0) as u32,
            notes: raw.notes,
            created_at: raw.created_at,
            updated_at: raw.updated_at,
            event_count: raw.event_count.max(0) as u64,
            episode_count: raw.episode_count.max(0) as u64,
        })
    }
}

struct RawSubscription {
    source_id: String,
    feed_url: String,
    show_name: String,
    rights_statement: String,
    rights_confirmed_at: DateTime<Utc>,
    state: String,
    etag: Option<String>,
    last_modified: Option<String>,
    last_checked_at: Option<DateTime<Utc>>,
    next_poll_at: Option<DateTime<Utc>>,
    last_error_code: Option<String>,
    consecutive_failures: i32,
}

fn raw_subscription_from_row(row: &duckdb::Row<'_>) -> duckdb::Result<RawSubscription> {
    Ok(RawSubscription {
        source_id: row.get(0)?,
        feed_url: row.get(1)?,
        show_name: row.get(2)?,
        rights_statement: row.get(3)?,
        rights_confirmed_at: row.get(4)?,
        state: row.get(5)?,
        etag: row.get(6)?,
        last_modified: row.get(7)?,
        last_checked_at: row.get(8)?,
        next_poll_at: row.get(9)?,
        last_error_code: row.get(10)?,
        consecutive_failures: row.get(11)?,
    })
}

impl TryFrom<RawSubscription> for PodcastSubscription {
    type Error = StoreError;

    fn try_from(raw: RawSubscription) -> Result<Self, Self::Error> {
        let state = match raw.state.as_str() {
            "active" => PodcastSubscriptionState::Active,
            "paused" => PodcastSubscriptionState::Paused,
            "removed" => PodcastSubscriptionState::Removed,
            _ => return Err(StoreError::InvalidStoredState),
        };
        Ok(Self {
            source_id: SourceId::new(raw.source_id).map_err(|_| StoreError::InvalidStoredState)?,
            feed_url: raw.feed_url,
            show_name: raw.show_name,
            rights_statement: raw.rights_statement,
            rights_confirmed_at: raw.rights_confirmed_at,
            state,
            etag: raw.etag,
            last_modified: raw.last_modified,
            last_checked_at: raw.last_checked_at,
            next_poll_at: raw.next_poll_at,
            last_error_code: raw.last_error_code,
            consecutive_failures: raw.consecutive_failures.max(0) as u32,
        })
    }
}

struct RawEpisode {
    source_id: String,
    source_native_id: Option<String>,
    canonical_url: Option<String>,
    title: Option<String>,
    enclosure_url: Option<String>,
    published_at: Option<DateTime<Utc>>,
    discovered_at: DateTime<Utc>,
    state: String,
    transcript_url: Option<String>,
    transcript_type: Option<String>,
}

fn raw_episode_from_row(row: &duckdb::Row<'_>) -> duckdb::Result<RawEpisode> {
    Ok(RawEpisode {
        source_id: row.get(0)?,
        source_native_id: row.get(1)?,
        canonical_url: row.get(2)?,
        title: row.get(3)?,
        enclosure_url: row.get(4)?,
        published_at: row.get(5)?,
        discovered_at: row.get(6)?,
        state: row.get(7)?,
        transcript_url: row.get(8)?,
        transcript_type: row.get(9)?,
    })
}

impl TryFrom<RawEpisode> for PodcastEpisode {
    type Error = StoreError;

    fn try_from(raw: RawEpisode) -> Result<Self, Self::Error> {
        let state = match raw.state.as_str() {
            "awaiting_local_transcription" => PodcastEpisodeState::AwaitingLocalTranscription,
            "transcription_unavailable" => PodcastEpisodeState::TranscriptionUnavailable,
            "transcribed" => PodcastEpisodeState::Transcribed,
            "failed" => PodcastEpisodeState::Failed,
            _ => return Err(StoreError::InvalidStoredState),
        };
        Ok(Self {
            source_id: SourceId::new(raw.source_id).map_err(|_| StoreError::InvalidStoredState)?,
            source_native_id: raw.source_native_id,
            canonical_url: raw.canonical_url,
            title: raw.title,
            enclosure_url: raw.enclosure_url,
            published_at: raw.published_at,
            discovered_at: raw.discovered_at,
            state,
            transcript_url: raw.transcript_url,
            transcript_type: raw.transcript_type,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use duckdb::Connection;
    use std::collections::BTreeMap;
    use tempfile::tempdir;

    #[test]
    fn clusters_can_be_replaced_once_memberships_exist() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        let event_id = nip_domain::EventId::new("event-1").unwrap();
        let cluster = |run: &str, label: &str| NarrativeCluster {
            cluster_id: "cluster-1".into(),
            derivation_run_id: run.into(),
            label: label.into(),
            algorithm_version: "centroid-v1".into(),
            member_count: 1,
            created_at: "2026-11-18T01:00:00Z".parse().unwrap(),
            members: vec![NarrativeClusterMember {
                event_id: event_id.clone(),
                similarity_millis: 1000,
                rank: 1,
            }],
        };
        store
            .replace_clusters(std::slice::from_ref(&cluster("run-1", "first")))
            .unwrap();
        // A second rebuild deletes the old run's parent rows; DuckDB refuses
        // that while the old membership rows still exist in the same
        // transaction, which silently froze the clusters after the first run.
        store
            .replace_clusters(std::slice::from_ref(&cluster("run-2", "second")))
            .unwrap();
        let rows = store.clusters().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].derivation_run_id, "run-2");
        assert_eq!(rows[0].label, "second");
    }

    fn subscription(source_id: &str) -> PodcastSubscription {
        PodcastSubscription {
            source_id: SourceId::new(source_id).unwrap(),
            feed_url: "http://127.0.0.1:8765/feed.xml".into(),
            show_name: "Synthetic show".into(),
            rights_statement: "User confirmed rights to fetch and process this feed".into(),
            rights_confirmed_at: "2026-11-16T09:00:00Z".parse().unwrap(),
            state: PodcastSubscriptionState::Active,
            etag: None,
            last_modified: None,
            last_checked_at: None,
            next_poll_at: None,
            last_error_code: None,
            consecutive_failures: 0,
        }
    }

    fn episode(source_id: &str, guid: Option<&str>, url: Option<&str>) -> PodcastEpisode {
        PodcastEpisode {
            source_id: SourceId::new(source_id).unwrap(),
            source_native_id: guid.map(str::to_owned),
            canonical_url: url.map(str::to_owned),
            title: Some("Episode 1".into()),
            enclosure_url: Some("http://127.0.0.1:8765/episode.mp3".into()),
            published_at: Some("2026-11-15T12:00:00Z".parse().unwrap()),
            discovered_at: "2026-11-16T09:01:00Z".parse().unwrap(),
            state: PodcastEpisodeState::AwaitingLocalTranscription,
            transcript_url: None,
            transcript_type: None,
        }
    }

    #[test]
    fn fresh_database_runs_two_migrations_and_reopen_is_idempotent() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("nip.duckdb");

        {
            let store = Store::open(&path).unwrap();
            assert_eq!(store.schema_version(), 10);
            assert!(store.has_table("nip_schema_migrations").unwrap());
            assert!(store.has_table("nip_sources").unwrap());
            assert!(store.has_table("nip_events").unwrap());
            assert!(store.has_table("nip_ingestion_runs").unwrap());
            assert!(store.has_table("nip_podcast_subscriptions").unwrap());
            assert!(store.has_table("nip_podcast_episodes").unwrap());
        }

        let reopened = Store::open(&path).unwrap();
        assert_eq!(reopened.schema_version(), 10);
        let migration_count: i64 = reopened
            .connection
            .query_row("SELECT COUNT(*) FROM nip_schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(migration_count, 10);
    }

    #[test]
    fn upgrades_an_existing_version_one_database_without_losing_ledger_tables() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("v1.duckdb");
        let mut connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE nip_schema_migrations (
                     version INTEGER PRIMARY KEY,
                     name VARCHAR NOT NULL,
                     applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );",
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        transaction.execute_batch(MIGRATION_1).unwrap();
        transaction
            .execute(
                "INSERT INTO nip_schema_migrations (version, name) VALUES (1, 'core')",
                [],
            )
            .unwrap();
        transaction.commit().unwrap();
        drop(connection);

        let store = Store::open(&path).unwrap();
        assert_eq!(store.schema_version(), 10);
        assert!(store.has_table("nip_events").unwrap());
        assert!(store.has_table("nip_podcast_subscriptions").unwrap());
    }

    #[test]
    fn approved_feed_is_persisted_with_lifecycle_and_http_validators() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        let subscription = subscription("podcast-1");
        store.add_approved_subscription(&subscription).unwrap();
        let loaded = store
            .subscription(&subscription.source_id)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.rights_statement, subscription.rights_statement);
        assert_eq!(loaded.state, PodcastSubscriptionState::Active);
        assert!(store
            .update_subscription_fetch_state(SubscriptionFetchStateUpdate {
                source_id: &subscription.source_id,
                etag: Some("\"v1\""),
                last_modified: Some("Sun, 15 Nov 2026 12:00:00 GMT"),
                checked_at: "2026-11-16T09:05:00Z".parse().unwrap(),
                next_poll_at: "2026-11-16T15:05:00Z".parse().unwrap(),
                last_error_code: None,
                consecutive_failures: 0,
            })
            .unwrap());
        let loaded = store
            .subscription(&subscription.source_id)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.etag.as_deref(), Some("\"v1\""));
        assert_eq!(loaded.consecutive_failures, 0);
        assert!(store
            .set_subscription_state(&subscription.source_id, PodcastSubscriptionState::Paused)
            .unwrap());
        assert_eq!(
            store
                .subscription(&subscription.source_id)
                .unwrap()
                .unwrap()
                .state,
            PodcastSubscriptionState::Paused
        );
    }

    #[test]
    fn episode_metadata_is_idempotent_per_source_and_guid_or_url() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        store
            .add_approved_subscription(&subscription("feed-a"))
            .unwrap();
        store
            .add_approved_subscription(&subscription("feed-b"))
            .unwrap();

        let first = episode("feed-a", Some("guid-1"), Some("https://example.test/ep-1"));
        assert_eq!(
            store
                .record_discovered_episodes(std::slice::from_ref(&first))
                .unwrap(),
            1
        );
        let replay_with_changed_title = PodcastEpisode {
            title: Some("Changed metadata does not overwrite first observation".into()),
            ..first.clone()
        };
        assert_eq!(
            store
                .record_discovered_episodes(&[replay_with_changed_title])
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .record_discovered_episodes(&[episode("feed-b", Some("guid-1"), None)])
                .unwrap(),
            1
        );

        let no_guid = episode("feed-a", None, Some("https://example.test/ep-2"));
        assert_eq!(
            store
                .record_discovered_episodes(std::slice::from_ref(&no_guid))
                .unwrap(),
            1
        );
        assert_eq!(store.record_discovered_episodes(&[no_guid]).unwrap(), 0);
        let rows = store
            .discovered_episodes(&SourceId::new("feed-a").unwrap())
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0].state,
            PodcastEpisodeState::AwaitingLocalTranscription
        );
    }

    #[test]
    fn publisher_transcript_reference_is_backfilled_on_replay() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        store
            .add_approved_subscription(&subscription("feed-a"))
            .unwrap();
        let first = episode("feed-a", Some("guid-1"), Some("https://example.test/ep-1"));
        assert_eq!(
            store
                .record_discovered_episodes(std::slice::from_ref(&first))
                .unwrap(),
            1
        );
        let with_transcript = PodcastEpisode {
            title: Some("A later refresh does not replace the title".into()),
            transcript_url: Some("https://example.test/ep-1.vtt".into()),
            transcript_type: Some("text/vtt".into()),
            ..first.clone()
        };
        assert_eq!(
            store
                .record_discovered_episodes(&[with_transcript])
                .unwrap(),
            0,
            "a replay must not create a duplicate row"
        );
        let rows = store
            .discovered_episodes(&SourceId::new("feed-a").unwrap())
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].transcript_url.as_deref(),
            Some("https://example.test/ep-1.vtt")
        );
        assert_eq!(rows[0].transcript_type.as_deref(), Some("text/vtt"));
        assert_eq!(rows[0].title.as_deref(), Some("Episode 1"));

        // A stored reference is not replaced by a different one.
        let different = PodcastEpisode {
            transcript_url: Some("https://example.test/ep-1.srt".into()),
            transcript_type: Some("application/x-subrip".into()),
            ..first.clone()
        };
        store
            .record_discovered_episodes(std::slice::from_ref(&different))
            .unwrap();
        let rows = store
            .discovered_episodes(&SourceId::new("feed-a").unwrap())
            .unwrap();
        assert_eq!(
            rows[0].transcript_url.as_deref(),
            Some("https://example.test/ep-1.vtt")
        );
    }

    #[test]
    fn discovered_episode_pages_filter_sort_and_report_total() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        store
            .add_approved_subscription(&subscription("feed-a"))
            .unwrap();
        store
            .add_approved_subscription(&subscription("feed-b"))
            .unwrap();
        let alpha = PodcastEpisode {
            title: Some("Alpha episode".into()),
            published_at: Some("2026-11-10T12:00:00Z".parse().unwrap()),
            ..episode("feed-a", Some("guid-alpha"), None)
        };
        let beta = PodcastEpisode {
            title: Some("Beta episode".into()),
            published_at: Some("2026-11-12T12:00:00Z".parse().unwrap()),
            ..episode("feed-a", Some("guid-beta"), None)
        };
        let gamma = PodcastEpisode {
            title: Some("Gamma episode".into()),
            published_at: Some("2026-11-11T12:00:00Z".parse().unwrap()),
            ..episode("feed-b", Some("guid-gamma"), None)
        };
        store
            .record_discovered_episodes(&[alpha, beta, gamma])
            .unwrap();

        let (first_page, total) = store
            .discovered_episodes_page(None, None, "published_desc", 2, 0)
            .unwrap();
        assert_eq!(total, 3);
        assert_eq!(
            first_page
                .iter()
                .map(|row| row.title.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("Beta episode"), Some("Gamma episode")]
        );
        let (second_page, _) = store
            .discovered_episodes_page(None, None, "published_desc", 2, 2)
            .unwrap();
        assert_eq!(
            second_page
                .iter()
                .map(|row| row.title.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("Alpha episode")]
        );

        let (titles, total) = store
            .discovered_episodes_page(None, None, "title_asc", 10, 0)
            .unwrap();
        assert_eq!(total, 3);
        assert_eq!(
            titles
                .iter()
                .map(|row| row.title.as_deref())
                .collect::<Vec<_>>(),
            vec![
                Some("Alpha episode"),
                Some("Beta episode"),
                Some("Gamma episode")
            ]
        );

        let (beta_only, total) = store
            .discovered_episodes_page(None, Some("BETA"), "published_desc", 10, 0)
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(beta_only[0].title.as_deref(), Some("Beta episode"));

        let feed_b = SourceId::new("feed-b").unwrap();
        let (feed_b_rows, total) = store
            .discovered_episodes_page(Some(&feed_b), None, "published_desc", 10, 0)
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(feed_b_rows[0].source_id, feed_b);
    }

    #[test]
    fn transcript_commit_is_atomic_and_marks_episode_transcribed() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        let subscription = subscription("feed-transcript");
        store.add_approved_subscription(&subscription).unwrap();
        let episode = episode("feed-transcript", Some("guid-1"), None);
        assert_eq!(
            store
                .record_discovered_episodes(std::slice::from_ref(&episode))
                .unwrap(),
            1
        );
        let transcript = PodcastTranscript {
            source_id: episode.source_id.clone(),
            source_native_id: episode.source_native_id.clone(),
            canonical_url: episode.canonical_url.clone(),
            transcript_text: "reviewed transcript".into(),
            content_hash: "hash-1".into(),
            detected_language: Some("en".into()),
            provenance_json: "{\"provider\":\"fake\"}".into(),
            transcribed_at: "2026-11-16T09:02:00Z".parse().unwrap(),
        };
        store.store_transcript(&episode, &transcript).unwrap();
        store.store_transcript(&episode, &transcript).unwrap();
        assert_eq!(
            store.discovered_episodes(&episode.source_id).unwrap()[0].state,
            PodcastEpisodeState::Transcribed
        );
        let count: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM nip_podcast_transcripts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn parquet_snapshot_round_trip_preserves_events_and_manifest() {
        let temp = tempdir().unwrap();
        let source_path = temp.path().join("source.duckdb");
        let mut source = Store::open(&source_path).unwrap();
        let captured_at = "2026-11-16T09:00:00Z".parse().unwrap();
        source
            .import_local_event(
                &LocalEventImport {
                    source_id: SourceId::new("manual-source").unwrap(),
                    source_display_name: "Rights-cleared fixture".into(),
                    source_native_id: Some("fixture-1".into()),
                    canonical_url: Some("https://example.test/fixture-1".into()),
                    title: Some("Fixture event".into()),
                    content_text: "A retained event for snapshot testing.".into(),
                    published_at: Some("2026-11-15T12:00:00Z".parse().unwrap()),
                    source_updated_at: None,
                    rights_statement: "User confirmed rights for this fixture".into(),
                    user_confirmed_rights: true,
                },
                captured_at,
            )
            .unwrap();
        let (snapshot, manifest) = source
            .export_parquet_snapshot(temp.path().join("lake"))
            .unwrap();
        assert_eq!(manifest.event_count, 1);
        assert!(snapshot.join("nip-snapshot-manifest.json").exists());

        let restored_path = temp.path().join("restored.duckdb");
        let restored_manifest = Store::restore_parquet_snapshot(&snapshot, &restored_path).unwrap();
        assert_eq!(restored_manifest, manifest);
        let restored = Store::open(&restored_path).unwrap();
        let events = restored
            .search_events(&EventSearchQuery {
                text: Some("retained event".into()),
                source_id: None,
                as_of: None,
                cursor: None,
                limit: 10,
            })
            .unwrap()
            .events;
        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0].content_hash,
            hex_digest(b"A retained event for snapshot testing.")
        );
    }

    #[test]
    fn refuses_to_open_a_database_with_a_future_schema() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("future.duckdb");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE nip_schema_migrations (
                     version INTEGER PRIMARY KEY,
                     name VARCHAR NOT NULL,
                     applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
                 );
                 INSERT INTO nip_schema_migrations (version, name) VALUES (99, 'future');",
            )
            .unwrap();
        drop(connection);

        let error = match Store::open(path) {
            Ok(_) => panic!("future schema must be rejected"),
            Err(error) => error,
        };
        assert!(matches!(
            error,
            StoreError::FutureSchema {
                found: 99,
                supported: 10
            }
        ));
    }

    #[test]
    fn provider_consent_is_append_only_and_binding_specific() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        let grant = ProviderConsent {
            consent_id: "consent-1".into(),
            action: "granted".into(),
            provider_kind: "remote".into(),
            provider_id: Some("provider-a".into()),
            model: "model-a".into(),
            scope: "remote_transcript_extraction".into(),
            disclosure: "Transcript text and prompt leave the device.".into(),
            actor: "local-user".into(),
            reason: None,
            recorded_at: "2026-11-17T09:00:00Z".parse().unwrap(),
        };
        store.record_provider_consent(&grant).unwrap();
        let active = store
            .latest_provider_consent(
                "remote",
                Some("provider-a"),
                "model-a",
                "remote_transcript_extraction",
            )
            .unwrap()
            .unwrap();
        assert_eq!(active.action, "granted");
        assert!(store
            .latest_provider_consent(
                "remote",
                Some("provider-b"),
                "model-a",
                "remote_transcript_extraction"
            )
            .unwrap()
            .is_none());
        assert!(store
            .latest_provider_consent(
                "remote",
                Some("provider-a"),
                "model-b",
                "remote_transcript_extraction"
            )
            .unwrap()
            .is_none());

        let revoke = ProviderConsent {
            consent_id: "consent-2".into(),
            action: "revoked".into(),
            reason: Some("user revoked".into()),
            recorded_at: "2026-11-17T10:00:00Z".parse().unwrap(),
            ..grant
        };
        store.record_provider_consent(&revoke).unwrap();
        let active = store
            .latest_provider_consent(
                "remote",
                Some("provider-a"),
                "model-a",
                "remote_transcript_extraction",
            )
            .unwrap()
            .unwrap();
        assert_eq!(active.action, "revoked");
        let rows: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM nip_provider_consents", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rows, 2);
    }

    #[test]
    fn claim_provenance_and_editorial_review_audit_are_persisted() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        let event = store
            .import_local_event(
                &LocalEventImport {
                    source_id: SourceId::new("audit-source").unwrap(),
                    source_display_name: "Synthetic audit fixture".into(),
                    source_native_id: Some("audit-1".into()),
                    canonical_url: None,
                    title: None,
                    content_text: "Rates remain restrictive.".into(),
                    published_at: None,
                    source_updated_at: None,
                    rights_statement: "synthetic".into(),
                    user_confirmed_rights: true,
                },
                "2026-11-17T09:00:00Z".parse().unwrap(),
            )
            .unwrap();
        store
            .store_claim(&ClaimRecord {
                claim_id: "claim-audit-1".into(),
                claim_text: "Rates remain restrictive.".into(),
                speaker_or_author: None,
                confidence_millis: 800,
                extraction_run_id: "run-audit-1".into(),
                provider: "riga_bridge".into(),
                model: "model-a".into(),
                prompt_version: "nip-claims-v1".into(),
                provider_kind: Some("remote".into()),
                provider_profile_id: Some("provider-a".into()),
                reasoning_effort: Some("low".into()),
                extracted_at: "2026-11-17T09:01:00Z".parse().unwrap(),
                evidence: vec![nip_domain::ClaimEvidence {
                    event_id: event.event_id.clone(),
                    quote: Some("Rates remain restrictive.".into()),
                    start_offset: Some(0),
                    end_offset: Some(24),
                }],
            })
            .unwrap();
        let claim = store.claims().unwrap().remove(0);
        assert_eq!(claim.provider_kind.as_deref(), Some("remote"));
        assert_eq!(claim.provider_profile_id.as_deref(), Some("provider-a"));
        assert_eq!(claim.reasoning_effort.as_deref(), Some("low"));

        store
            .replace_editorial_candidates(&[EditorialCandidate {
                candidate_id: "candidate-audit-1".into(),
                title_angle: "A synthetic topic".into(),
                narrative_ids: vec!["narrative-1".into()],
                claim_ids: vec![claim.claim_id.clone()],
                evidence_event_ids: vec![event.event_id.as_str().to_owned()],
                rank: 1,
                component_values: BTreeMap::new(),
                derivation_run_id: "editorial-run-1".into(),
                review_status: "unreviewed".into(),
                review_reason: None,
                reviewer: None,
                reviewed_at: None,
                created_at: "2026-11-17T09:02:00Z".parse().unwrap(),
            }])
            .unwrap();
        store
            .review_editorial_candidate(
                "candidate-audit-1",
                "deferred",
                "Needs another source.",
                "editor-a",
                "2026-11-17T09:03:00Z".parse().unwrap(),
            )
            .unwrap();
        store
            .review_editorial_candidate(
                "candidate-audit-1",
                "relevant",
                "Correction after review.",
                "editor-b",
                "2026-11-17T09:04:00Z".parse().unwrap(),
            )
            .unwrap();
        let audit = store.editorial_review_audit("candidate-audit-1").unwrap();
        assert_eq!(audit.len(), 2);
        assert_eq!(audit[0].review_status, "deferred");
        assert_eq!(audit[1].review_status, "relevant");
        // A reviewed derivation run cannot be regenerated in place.
        assert!(matches!(
            store.replace_editorial_candidates(&[EditorialCandidate {
                candidate_id: "candidate-audit-1".into(),
                title_angle: "Overwrite attempt".into(),
                narrative_ids: vec![],
                claim_ids: vec![],
                evidence_event_ids: vec![event.event_id.as_str().to_owned()],
                rank: 1,
                component_values: BTreeMap::new(),
                derivation_run_id: "editorial-run-1".into(),
                review_status: "unreviewed".into(),
                review_reason: None,
                reviewer: None,
                reviewed_at: None,
                created_at: "2026-11-17T09:05:00Z".parse().unwrap(),
            }]),
            Err(StoreError::InvalidResearchRecord)
        ));
    }

    #[test]
    fn etf_revisions_require_a_valid_supersession_chain() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        let event = store
            .import_local_event(
                &LocalEventImport {
                    source_id: SourceId::new("etf-source").unwrap(),
                    source_display_name: "Synthetic ETF fixture".into(),
                    source_native_id: Some("etf-1".into()),
                    canonical_url: None,
                    title: None,
                    content_text: "A thematic observation.".into(),
                    published_at: None,
                    source_updated_at: None,
                    rights_statement: "synthetic".into(),
                    user_confirmed_rights: true,
                },
                "2026-11-17T09:00:00Z".parse().unwrap(),
            )
            .unwrap();
        let base = EtfMapping {
            mapping_id: "mapping-v1".into(),
            narrative_id: "narrative-1".into(),
            ticker: "TLT".into(),
            rationale: "First hypothesis".into(),
            evidence_event_ids: vec![event.event_id.as_str().to_owned()],
            author: "analyst".into(),
            reviewer: None,
            version: 1,
            effective_from: "2026-11-17T09:00:00Z".parse().unwrap(),
            effective_to: None,
            known_at: "2026-11-17T09:00:00Z".parse().unwrap(),
            review_status: "unreviewed".into(),
            ticker_status: "unknown".into(),
            market_data_coverage: "unavailable".into(),
            mapping_validity: "pending_review".into(),
            supersedes_mapping_id: None,
            created_at: "2026-11-17T09:00:00Z".parse().unwrap(),
        };
        store.save_etf_mapping(&base).unwrap();
        let mut revision = EtfMapping {
            mapping_id: "mapping-v2".into(),
            version: 2,
            supersedes_mapping_id: Some("mapping-v1".into()),
            rationale: "Revised hypothesis".into(),
            ..base.clone()
        };
        store.save_etf_mapping(&revision).unwrap();
        revision.mapping_id = "mapping-v3".into();
        revision.version = 3;
        revision.supersedes_mapping_id = Some("mapping-v1".into());
        // v1 is already superseded, so it cannot be the base of another revision.
        assert!(matches!(
            store.save_etf_mapping(&revision),
            Err(StoreError::InvalidResearchRecord)
        ));
        let mut bad_version = EtfMapping {
            mapping_id: "mapping-bad".into(),
            version: 5,
            supersedes_mapping_id: Some("mapping-v2".into()),
            ..base
        };
        bad_version.rationale = "Skipped a version".into();
        assert!(matches!(
            store.save_etf_mapping(&bad_version),
            Err(StoreError::InvalidResearchRecord)
        ));
    }

    fn narrative_source(source_id: &str, kind: SourceKind) -> NarrativeSource {
        NarrativeSource {
            source_id: SourceId::new(source_id).unwrap(),
            kind,
            display_name: "Q3 management call".into(),
            locator: Some("https://example.invalid/q3-call".into()),
            rights_status: "approved".into(),
            rights_statement: Some("Internal transcript cleared for local retention".into()),
            topics: vec!["company meeting".into(), "guidance".into()],
            state: SourceState::Active,
            poll_interval_minutes: 360,
            per_scan_limit: 3,
            notes: None,
            created_at: "2026-11-17T09:00:00Z".parse().unwrap(),
            updated_at: "2026-11-17T09:00:00Z".parse().unwrap(),
            event_count: 0,
            episode_count: 0,
        }
    }

    #[test]
    fn source_registry_crud_covers_non_podcast_kinds() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        let source = narrative_source("meeting-q3", SourceKind::CompanyMeeting);
        store.insert_source(&source).unwrap();

        let listed = store.sources(false).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].kind, SourceKind::CompanyMeeting);
        assert_eq!(listed[0].state, SourceState::Active);
        assert_eq!(listed[0].topics, vec!["company meeting", "guidance"]);

        let update = SourceUpdate {
            display_name: Some("Q3 earnings call".into()),
            locator: Some("https://example.invalid/q3-earnings".into()),
            per_scan_limit: Some(5),
            ..SourceUpdate::default()
        };
        assert!(store
            .update_source(
                &source.source_id,
                &update,
                "2026-11-17T10:00:00Z".parse().unwrap()
            )
            .unwrap());
        let updated = store.source(&source.source_id).unwrap().unwrap();
        assert_eq!(updated.display_name, "Q3 earnings call");
        assert_eq!(updated.locator.as_deref(), Some("https://example.invalid/q3-earnings"));
        assert_eq!(updated.per_scan_limit, 5);

        assert!(store
            .set_source_state(
                &source.source_id,
                SourceState::Paused,
                "2026-11-17T11:00:00Z".parse().unwrap()
            )
            .unwrap());
        assert!(store.sources(false).unwrap()[0].state == SourceState::Paused);
        assert!(store.sources(true).unwrap().len() == 1);

        assert!(store
            .set_source_state(
                &source.source_id,
                SourceState::Removed,
                "2026-11-17T12:00:00Z".parse().unwrap()
            )
            .unwrap());
        assert!(store.sources(false).unwrap().is_empty());
        assert_eq!(store.sources(true).unwrap()[0].state, SourceState::Removed);
    }

    #[test]
    fn podcast_locator_correction_clears_conditional_fetch_state() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        store
            .add_approved_subscription(&subscription("feed-a"))
            .unwrap();

        let registry = store.source(&SourceId::new("feed-a").unwrap()).unwrap().unwrap();
        assert_eq!(registry.kind, SourceKind::Podcast);
        assert_eq!(registry.state, SourceState::Active);

        maybe_set_fetch_state(&mut store);
        let corrected = store
            .update_podcast_locator(
                &SourceId::new("feed-a").unwrap(),
                "https://example.invalid/feed.xml",
                "Corrected show",
                "2026-11-17T10:00:00Z".parse().unwrap(),
            )
            .unwrap();
        assert!(corrected);
        let subscription = store
            .subscription(&SourceId::new("feed-a").unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(subscription.feed_url, "https://example.invalid/feed.xml");
        assert_eq!(subscription.show_name, "Corrected show");
        assert!(subscription.etag.is_none());
        assert!(subscription.next_poll_at.is_none());
        assert!(subscription.last_error_code.is_none());
        let registry = store.source(&SourceId::new("feed-a").unwrap()).unwrap().unwrap();
        assert_eq!(registry.locator.as_deref(), Some("https://example.invalid/feed.xml"));
        assert_eq!(registry.display_name, "Corrected show");
    }

    fn maybe_set_fetch_state(store: &mut Store) {
        let subscription = store
            .subscription(&SourceId::new("feed-a").unwrap())
            .unwrap()
            .unwrap();
        store
            .update_subscription_fetch_state(SubscriptionFetchStateUpdate {
                source_id: &subscription.source_id,
                etag: Some("\"etag-1\""),
                last_modified: Some("Thu, 13 Nov 2026 10:00:00 GMT"),
                checked_at: "2026-11-17T09:00:00Z".parse().unwrap(),
                next_poll_at: "2026-11-17T15:00:00Z".parse().unwrap(),
                last_error_code: Some("feed_unavailable"),
                consecutive_failures: 2,
            })
            .unwrap();
    }

    #[test]
    fn deleting_a_source_is_refused_while_events_reference_it() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        let source = narrative_source("filing-10k", SourceKind::Filing);
        store.insert_source(&source).unwrap();
        store
            .import_local_event(
                &LocalEventImport {
                    source_id: source.source_id.clone(),
                    source_display_name: source.display_name.clone(),
                    source_native_id: Some("10k-q3".into()),
                    canonical_url: source.locator.clone(),
                    title: Some("10-K Q3".into()),
                    content_text: "Risk factors unchanged.".into(),
                    published_at: None,
                    source_updated_at: None,
                    rights_statement: "Public filing".into(),
                    user_confirmed_rights: true,
                },
                "2026-11-17T09:30:00Z".parse().unwrap(),
            )
            .unwrap();

        assert_eq!(store.delete_source(&source.source_id).unwrap(), 1);
        assert!(store.source(&source.source_id).unwrap().is_some());

        let empty = narrative_source("filing-8k", SourceKind::Filing);
        store.insert_source(&empty).unwrap();
        assert_eq!(store.delete_source(&empty.source_id).unwrap(), 0);
        assert!(store.source(&empty.source_id).unwrap().is_none());
    }
}
