use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use duckdb::{params, Connection, OptionalExt};
use nip_domain::{
    AgentNarrativeAnalysis, ClaimEvidence, ClaimRecord, EditorialCandidate, EditorialReviewAudit,
    EmbeddingIndexManifest, EtfMapping, EventRecord, EventSearchPage, EventSearchQuery,
    LocalEventImport, NarrativeCluster, NarrativeClusterMember, NarrativeGraph, NarrativeSource,
    PodcastEpisode, PodcastEpisodeState, PodcastSubscription, PodcastSubscriptionState,
    PodcastTranscript, ProviderConsent, SourceId, SourceKind, SourceState, SourceUpdate,
    VideoAnalysisMode, VideoAsset, VideoAssetLineage, VideoAssetUpstreamKind, VideoAudioCue,
    VideoEpisode, VideoEpisodeStatus, VideoEvidenceRef, VideoExportFile, VideoExportManifest,
    VideoExportManifestV1, VideoJob, VideoNarrative, VideoProject, VideoProjectStatus,
    VideoQaFinding, VideoQaReport, VideoQaSeverity, VideoQaStatus, VideoReviewStatus, VideoScene,
    VideoShot, VideoShotStatus, VideoStoryboard, VideoTimeline, VideoVisualSource,
    VideoVisualSourceKind, VideoVisualSpec, VideoWorkflow,
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
const MIGRATION_11: &str = include_str!("../migrations/0011_video_workspace.sql");
const MIGRATION_12: &str = include_str!("../migrations/0012_video_visual_specs_and_exports.sql");
const MIGRATION_13: &str = include_str!("../migrations/0013_agent_narrative_graph.sql");
const MIGRATION_14: &str = include_str!("../migrations/0014_video_edl.sql");
const MIGRATION_15: &str = include_str!("../migrations/0015_video_qa_reports.sql");
const MIGRATION_16: &str = include_str!("../migrations/0016_video_audio_cues.sql");
const MIGRATION_17: &str = include_str!("../migrations/0017_video_export_producer.sql");
const LATEST_SCHEMA_VERSION: u32 = 18;

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
    #[error("external-agent narrative analysis is invalid")]
    InvalidAgentAnalysis,
    #[error("video record is invalid")]
    InvalidVideoRecord,
    #[error("video evidence reference is invalid")]
    InvalidVideoEvidence,
    #[error("Video project was not found")]
    VideoProjectNotFound,
    #[error("confirmation name does not exactly match the current Video project title")]
    VideoProjectConfirmationMismatch,
    #[error("Video project deletion is blocked while queued or running Video jobs exist")]
    ActiveVideoJobs,
    #[error("EDL project, episode, or storyboard revision ownership is invalid")]
    InvalidEdlOwnership,
    #[error("EDL build request ID was reused with a different payload")]
    EdlIdempotencyConflict,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoEdlRef {
    pub id: String,
    pub revision: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoProjectDeleteResult {
    pub project_id: String,
    pub deleted: bool,
    pub retained_global_media_and_job_history: bool,
    pub retention_note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoEdlAssetFact {
    pub asset: VideoEdlRef,
    pub content_hash: Option<String>,
    pub relative_path: Option<String>,
    pub mime_type: Option<String>,
    pub capability_state: String,
    pub license_state: String,
    pub asset_kind: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<u64>,
    pub related_shots: Vec<VideoEdlRef>,
    pub visual_spec: Option<VideoEdlRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoEdlShotFact {
    pub shot: VideoEdlRef,
    pub claiming: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoEdlCueFact {
    pub cue: VideoEdlRef,
    pub project: VideoEdlRef,
    pub episode: VideoEdlRef,
    pub storyboard: VideoEdlRef,
    pub scene: Option<VideoEdlRef>,
    pub asset: VideoEdlRef,
    pub duration_ms: u64,
    pub sample_count: u64,
    pub sample_rate: u32,
    pub channels: u16,
    pub evidence: Vec<VideoEvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoEdlInventory {
    pub storyboard_shots: Vec<VideoEdlShotFact>,
    pub selected_shots: Vec<VideoEdlShotFact>,
    pub assets: Vec<VideoEdlAssetFact>,
    pub cues: Vec<VideoEdlCueFact>,
    pub evidence: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoEdlRevision {
    pub timeline_id: String,
    pub revision: u32,
    pub project_id: String,
    pub project_revision: u32,
    pub episode_id: String,
    pub episode_revision: u32,
    pub storyboard_id: String,
    pub storyboard_revision: u32,
    pub profile_id: String,
    pub profile_revision: u32,
    pub schema_version: String,
    pub build_version: String,
    pub build_status: String,
    pub timeline_hash: String,
    pub input_fingerprint: String,
    pub manifest_json: String,
    pub findings_json: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoQaStoredReport {
    pub report_id: String,
    pub timeline_id: String,
    pub timeline_revision: u32,
    pub project_id: String,
    pub input_fingerprint: String,
    pub evaluator_version: String,
    pub profile_id: String,
    pub profile_revision: u32,
    pub report_json: String,
    pub created_at: DateTime<Utc>,
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
                params![registry_state_as_str(state), source_id.as_str()],
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

    pub fn save_agent_narrative_analysis(
        &mut self,
        analysis: &AgentNarrativeAnalysis,
        claims: &[ClaimRecord],
    ) -> Result<(), StoreError> {
        if analysis.analysis_id.trim().is_empty()
            || analysis.extraction_run_id.trim().is_empty()
            || analysis.narrative_title.trim().is_empty()
            || analysis.narrative_thesis.trim().is_empty()
            || analysis.producer.trim().is_empty()
            || analysis.model.trim().is_empty()
            || analysis.prompt_version.trim().is_empty()
            || analysis.provenance_status != "caller_declared_external_agent_unattested"
            || claims.is_empty()
            || claims.len() != analysis.claim_annotations.len()
            || analysis.entities.is_empty()
        {
            return Err(StoreError::InvalidAgentAnalysis);
        }

        let event = self
            .event(&analysis.event_id)?
            .ok_or(StoreError::InvalidAgentAnalysis)?;
        let transcript = event.content_text.as_deref().unwrap_or_default();
        if event.content_hash != analysis.source_content_hash || transcript.trim().is_empty() {
            return Err(StoreError::InvalidAgentAnalysis);
        }

        let entity_ids: HashSet<&str> = analysis
            .entities
            .iter()
            .map(|entity| entity.entity_id.as_str())
            .collect();
        if entity_ids.len() != analysis.entities.len()
            || analysis.entities.iter().any(|entity| {
                entity.canonical_name.trim().is_empty()
                    || entity.surface_form.trim().is_empty()
                    || entity.resolution_status != "unresolved_candidate"
                    || !agent_evidence_matches(transcript, &entity.evidence)
                    || !entity
                        .evidence
                        .quote
                        .as_deref()
                        .is_some_and(|quote| quote.contains(&entity.surface_form))
                    || entity.evidence.event_id.as_str() != analysis.event_id
            })
        {
            return Err(StoreError::InvalidAgentAnalysis);
        }

        let claim_ids: HashSet<&str> = claims.iter().map(|claim| claim.claim_id.as_str()).collect();
        let annotation_ids: HashSet<&str> = analysis
            .claim_annotations
            .iter()
            .map(|annotation| annotation.claim_id.as_str())
            .collect();
        if claim_ids.len() != claims.len()
            || annotation_ids.len() != analysis.claim_annotations.len()
            || claim_ids != annotation_ids
            || claims.iter().any(|claim| {
                claim.claim_text.trim().is_empty()
                    || claim.confidence_millis > 1000
                    || claim.evidence.len() != 1
                    || claim.evidence[0].event_id.as_str() != analysis.event_id
                    || !agent_evidence_matches(transcript, &claim.evidence[0])
            })
            || analysis.claim_annotations.iter().any(|annotation| {
                annotation.claim_type.trim().is_empty()
                    || annotation.entity_ids.is_empty()
                    || annotation
                        .entity_ids
                        .iter()
                        .any(|entity_id| !entity_ids.contains(entity_id.as_str()))
            })
        {
            return Err(StoreError::InvalidAgentAnalysis);
        }

        let transaction = self.connection.transaction()?;
        let analysis_json = serde_json::to_string(analysis)?;
        transaction.execute(
            "INSERT INTO nip_agent_narrative_analyses
                (analysis_id, event_id, source_content_hash, extraction_run_id, producer, model,
                 prompt_version, narrative_title, narrative_thesis, narrative_summary,
                 provenance_status, created_at, analysis_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (analysis_id) DO NOTHING",
            params![
                analysis.analysis_id,
                analysis.event_id,
                analysis.source_content_hash,
                analysis.extraction_run_id,
                analysis.producer,
                analysis.model,
                analysis.prompt_version,
                analysis.narrative_title,
                analysis.narrative_thesis,
                analysis.narrative_summary,
                analysis.provenance_status,
                analysis.created_at,
                analysis_json,
            ],
        )?;

        for claim in claims {
            transaction.execute(
                "INSERT INTO nip_claims (claim_id, claim_text, speaker_or_author, confidence_millis,
                    extraction_run_id, provider, model, prompt_version, provider_kind,
                    provider_profile_id, reasoning_effort, extracted_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (claim_id) DO NOTHING",
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
                     ON CONFLICT (claim_id, event_id) DO NOTHING",
                    params![
                        claim.claim_id,
                        evidence.event_id.as_str(),
                        evidence.quote,
                        evidence.start_offset.map(|value| value as i32),
                        evidence.end_offset.map(|value| value as i32),
                    ],
                )?;
            }
        }

        for entity in &analysis.entities {
            let evidence = &entity.evidence;
            transaction.execute(
                "INSERT INTO nip_agent_entity_candidates
                    (entity_id, analysis_id, event_id, canonical_name, entity_type, surface_form,
                     resolution_status, quote, start_offset, end_offset)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (entity_id) DO NOTHING",
                params![
                    entity.entity_id,
                    analysis.analysis_id,
                    analysis.event_id,
                    entity.canonical_name,
                    entity.entity_type,
                    entity.surface_form,
                    entity.resolution_status,
                    evidence.quote,
                    evidence.start_offset.map(|value| value as i32),
                    evidence.end_offset.map(|value| value as i32),
                ],
            )?;
        }

        for annotation in &analysis.claim_annotations {
            transaction.execute(
                "INSERT INTO nip_agent_claim_annotations
                    (claim_id, analysis_id, claim_type, polarity, horizon)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT (claim_id) DO NOTHING",
                params![
                    annotation.claim_id,
                    analysis.analysis_id,
                    annotation.claim_type,
                    annotation.polarity,
                    annotation.horizon,
                ],
            )?;
            for entity_id in &annotation.entity_ids {
                transaction.execute(
                    "INSERT INTO nip_agent_claim_entity_candidates (claim_id, entity_id)
                     VALUES (?, ?)
                     ON CONFLICT (claim_id, entity_id) DO NOTHING",
                    params![annotation.claim_id, entity_id],
                )?;
            }
        }

        transaction.commit()?;
        Ok(())
    }

    pub fn agent_narrative_analyses(&self) -> Result<Vec<AgentNarrativeAnalysis>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT analysis_json FROM nip_agent_narrative_analyses
             ORDER BY created_at, analysis_id",
        )?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .map(|row| {
                let json = row?;
                serde_json::from_str(&json).map_err(StoreError::SnapshotJson)
            })
            .collect()
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

    /// Validate all retained evidence spans for an exact canonical claim against
    /// the source event's UTF-8 text. Event refs alone do not carry an exact span.
    pub fn video_evidence_span_valid(&self, kind: &str, id: &str) -> Result<bool, StoreError> {
        if kind != "claim" {
            return Ok(false);
        }
        let mut statement = self.connection.prepare(
            "SELECT e.content_text, ce.quote, ce.start_offset, ce.end_offset
             FROM nip_claim_evidence ce
             JOIN nip_events e ON e.event_id = ce.event_id
             WHERE ce.claim_id = ? ORDER BY ce.event_id",
        )?;
        let rows = statement.query_map(params![id], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<i32>>(2)?,
                row.get::<_, Option<i32>>(3)?,
            ))
        })?;
        let mut found = false;
        for row in rows {
            let (source, quote, start, end) = row?;
            found = true;
            let (Some(source), Some(quote), Some(start), Some(end)) = (source, quote, start, end)
            else {
                return Ok(false);
            };
            let (Ok(start), Ok(end)) = (usize::try_from(start), usize::try_from(end)) else {
                return Ok(false);
            };
            if !Self::unicode_character_span_matches(&source, &quote, start, end) {
                return Ok(false);
            }
        }
        Ok(found)
    }

    fn unicode_character_span_matches(source: &str, quote: &str, start: usize, end: usize) -> bool {
        let character_count = source.chars().count();
        if start >= end || end > character_count {
            return false;
        }
        let start_byte = source.char_indices().nth(start).map(|(byte, _)| byte);
        let end_byte = if end == character_count {
            Some(source.len())
        } else {
            source.char_indices().nth(end).map(|(byte, _)| byte)
        };
        match (start_byte, end_byte) {
            (Some(start_byte), Some(end_byte)) => source.get(start_byte..end_byte) == Some(quote),
            _ => false,
        }
    }

    pub fn save_video_project(&mut self, project: &VideoProject) -> Result<(), StoreError> {
        if project.project_id.trim().is_empty()
            || project.title.trim().is_empty()
            || project.language.trim().is_empty()
            || project.target_platform.trim().is_empty()
            || project.revision == 0
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let transaction = self.connection.transaction()?;
        let expected = project.revision.saturating_sub(1);
        let current: Option<i32> = transaction
            .query_row(
                "SELECT revision FROM video_project_heads WHERE project_id = ?",
                params![project.project_id],
                |row| row.get(0),
            )
            .optional()?;
        if current.unwrap_or(0) != expected as i32 {
            return Err(StoreError::InvalidVideoRecord);
        }
        transaction.execute(
            "INSERT INTO video_projects
                (project_id, revision, title, language, target_platform, target_duration_ms,
                 audience, style_profile, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                project.project_id,
                project.revision as i32,
                project.title,
                project.language,
                project.target_platform,
                project.target_duration_ms.map(|value| value as i64),
                project.audience,
                project.style_profile,
                video_project_status_as_str(project.status),
                project.created_at,
                project.updated_at,
            ],
        )?;
        transaction.execute(
            "INSERT INTO video_project_heads (project_id, revision, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT (project_id) DO UPDATE SET revision = excluded.revision,
                 updated_at = excluded.updated_at",
            params![
                project.project_id,
                project.revision as i32,
                project.updated_at
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn video_project(&self, project_id: &str) -> Result<Option<VideoProject>, StoreError> {
        self.connection
            .query_row(
                "SELECT p.project_id, p.revision, p.title, p.language, p.target_platform,
                        p.target_duration_ms, p.audience, p.style_profile, p.status,
                        p.created_at, p.updated_at
                 FROM video_projects p
                 JOIN video_project_heads h ON h.project_id = p.project_id AND h.revision = p.revision
                 WHERE p.project_id = ?",
                params![project_id],
                raw_video_project_from_row,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn video_projects(&self) -> Result<Vec<VideoProject>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT p.project_id, p.revision, p.title, p.language, p.target_platform,
                    p.target_duration_ms, p.audience, p.style_profile, p.status,
                    p.created_at, p.updated_at
             FROM video_projects p
             JOIN video_project_heads h ON h.project_id = p.project_id AND h.revision = p.revision
             ORDER BY p.updated_at DESC, p.project_id",
        )?;
        Ok(statement
            .query_map([], raw_video_project_from_row)?
            .collect::<duckdb::Result<Vec<_>>>()?)
    }

    /// Delete a Video project and its dependent production metadata atomically.
    /// Canonical NIP records and global/ownership-ambiguous media and job rows
    /// are deliberately retained.
    pub fn delete_video_project(
        &mut self,
        project_id: &str,
        confirmation_name: &str,
    ) -> Result<VideoProjectDeleteResult, StoreError> {
        let tx = self.connection.transaction()?;
        let title: Option<String> = tx
            .query_row(
                "SELECT p.title FROM video_projects p
                 JOIN video_project_heads h
                   ON h.project_id = p.project_id AND h.revision = p.revision
                 WHERE p.project_id = ?",
                params![project_id],
                |row| row.get(0),
            )
            .optional()?;
        let title = title.ok_or(StoreError::VideoProjectNotFound)?;
        if title != confirmation_name {
            return Err(StoreError::VideoProjectConfirmationMismatch);
        }

        // Jobs have no reliable project ownership column. Refuse deletion if
        // any are active rather than risking removal of inputs they may use.
        let has_active_jobs: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM video_jobs WHERE status IN ('queued', 'running'))",
            [],
            |row| row.get(0),
        )?;
        if has_active_jobs {
            return Err(StoreError::ActiveVideoJobs);
        }

        // Remove project request mappings only where their owning QA report is
        // unambiguously associated with this project. Other request/job history
        // remains because it carries no reliable project key.
        tx.execute(
            "DELETE FROM video_qa_run_requests
             WHERE report_id IN (SELECT report_id FROM video_qa_reports_v2 WHERE project_id = ?)",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_qa_reports_v2 WHERE project_id = ?",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_qa_reports WHERE project_id = ?",
            params![project_id],
        )?;

        // Project export files/evidence are children of the matching manifest.
        tx.execute(
            "DELETE FROM video_export_manifest_files
             WHERE manifest_id IN (SELECT manifest_id FROM video_export_manifests WHERE project_id = ?)",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_export_manifest_evidence
             WHERE manifest_id IN (SELECT manifest_id FROM video_export_manifests WHERE project_id = ?)",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_export_manifests WHERE project_id = ?",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_export_manifests_v1 WHERE project_id = ?",
            params![project_id],
        )?;

        // Remove associations/lineage rows only when the upstream artifact is
        // an exact project-owned visual spec, scene, or shot revision. Asset
        // records and their binary files remain global and untouched.
        tx.execute(
            "DELETE FROM video_shot_assets WHERE EXISTS (
                SELECT 1 FROM video_shots sh
                JOIN video_scenes sc ON sc.scene_id = sh.scene_id
                JOIN video_storyboards sb ON sb.storyboard_id = sc.storyboard_id
                JOIN video_narratives n ON n.narrative_id = sb.narrative_id
                JOIN video_episodes e ON e.episode_id = n.episode_id
                WHERE e.project_id = ? AND sh.shot_id = video_shot_assets.shot_id
                  AND sh.revision = video_shot_assets.shot_revision
             )",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_asset_lineage l WHERE
                (l.upstream_kind = 'visual_spec' AND EXISTS (
                    SELECT 1 FROM video_visual_specs v WHERE v.project_id = ?
                      AND v.spec_id = l.upstream_id AND v.revision = l.upstream_revision
                )) OR
                (l.upstream_kind = 'scene' AND EXISTS (
                    SELECT 1 FROM video_scenes sc
                    JOIN video_storyboards sb ON sb.storyboard_id = sc.storyboard_id
                    JOIN video_narratives n ON n.narrative_id = sb.narrative_id
                    JOIN video_episodes e ON e.episode_id = n.episode_id
                    WHERE e.project_id = ? AND sc.scene_id = l.upstream_id
                      AND sc.revision = l.upstream_revision
                )) OR
                (l.upstream_kind = 'shot' AND EXISTS (
                    SELECT 1 FROM video_shots sh
                    JOIN video_scenes sc ON sc.scene_id = sh.scene_id
                    JOIN video_storyboards sb ON sb.storyboard_id = sc.storyboard_id
                    JOIN video_narratives n ON n.narrative_id = sb.narrative_id
                    JOIN video_episodes e ON e.episode_id = n.episode_id
                    WHERE e.project_id = ? AND sh.shot_id = l.upstream_id
                      AND sh.revision = l.upstream_revision
                ))",
            params![project_id, project_id, project_id],
        )?;
        tx.execute(
            "DELETE FROM video_export_asset_lineage_v1 l WHERE
                (l.upstream_kind = 'visual_spec' AND EXISTS (
                    SELECT 1 FROM video_visual_specs v WHERE v.project_id = ?
                      AND v.spec_id = l.upstream_id AND v.revision = l.upstream_revision
                )) OR
                (l.upstream_kind = 'scene' AND EXISTS (
                    SELECT 1 FROM video_scenes sc
                    JOIN video_storyboards sb ON sb.storyboard_id = sc.storyboard_id
                    JOIN video_narratives n ON n.narrative_id = sb.narrative_id
                    JOIN video_episodes e ON e.episode_id = n.episode_id
                    WHERE e.project_id = ? AND sc.scene_id = l.upstream_id
                      AND sc.revision = l.upstream_revision
                )) OR
                (l.upstream_kind = 'shot' AND EXISTS (
                    SELECT 1 FROM video_shots sh
                    JOIN video_scenes sc ON sc.scene_id = sh.scene_id
                    JOIN video_storyboards sb ON sb.storyboard_id = sc.storyboard_id
                    JOIN video_narratives n ON n.narrative_id = sb.narrative_id
                    JOIN video_episodes e ON e.episode_id = n.episode_id
                    WHERE e.project_id = ? AND sh.shot_id = l.upstream_id
                      AND sh.revision = l.upstream_revision
                ))",
            params![project_id, project_id, project_id],
        )?;

        // The audio cue is project-keyed even though the referenced asset is
        // global. Its project-specific cue row is safe to remove.
        tx.execute(
            "DELETE FROM video_audio_cues WHERE project_id = ?",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_timelines WHERE project_id = ?",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_edl_timelines WHERE project_id = ?",
            params![project_id],
        )?;

        // Project-owned graph metadata and evidence are deleted from leaf to
        // root. Evidence IDs here are only keys to Video evidence-reference
        // rows; no NIP event or claim table is ever a delete target.
        tx.execute(
            "DELETE FROM video_shot_evidence WHERE EXISTS (
                SELECT 1 FROM video_shots sh
                JOIN video_scenes sc ON sc.scene_id = sh.scene_id
                JOIN video_storyboards sb ON sb.storyboard_id = sc.storyboard_id
                JOIN video_narratives n ON n.narrative_id = sb.narrative_id
                JOIN video_episodes e ON e.episode_id = n.episode_id
                WHERE e.project_id = ? AND sh.shot_id = video_shot_evidence.shot_id
                  AND sh.revision = video_shot_evidence.shot_revision
             )",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_scene_evidence WHERE EXISTS (
                SELECT 1 FROM video_scenes sc
                JOIN video_storyboards sb ON sb.storyboard_id = sc.storyboard_id
                JOIN video_narratives n ON n.narrative_id = sb.narrative_id
                JOIN video_episodes e ON e.episode_id = n.episode_id
                WHERE e.project_id = ? AND sc.scene_id = video_scene_evidence.scene_id
                  AND sc.revision = video_scene_evidence.scene_revision
             )",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_narrative_evidence WHERE EXISTS (
                SELECT 1 FROM video_narratives n
                JOIN video_episodes e ON e.episode_id = n.episode_id
                WHERE e.project_id = ? AND n.narrative_id = video_narrative_evidence.narrative_id
                  AND n.revision = video_narrative_evidence.narrative_revision
             )",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_episode_evidence WHERE EXISTS (
                SELECT 1 FROM video_episodes e WHERE e.project_id = ?
                  AND e.episode_id = video_episode_evidence.episode_id
                  AND e.revision = video_episode_evidence.episode_revision
             )",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_shots WHERE EXISTS (
                SELECT 1 FROM video_scenes sc
                JOIN video_storyboards sb ON sb.storyboard_id = sc.storyboard_id
                JOIN video_narratives n ON n.narrative_id = sb.narrative_id
                JOIN video_episodes e ON e.episode_id = n.episode_id
                WHERE e.project_id = ? AND sc.scene_id = video_shots.scene_id
             )",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_scenes WHERE EXISTS (
                SELECT 1 FROM video_storyboards sb
                JOIN video_narratives n ON n.narrative_id = sb.narrative_id
                JOIN video_episodes e ON e.episode_id = n.episode_id
                WHERE e.project_id = ? AND sb.storyboard_id = video_scenes.storyboard_id
             )",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_storyboards WHERE EXISTS (
                SELECT 1 FROM video_narratives n
                JOIN video_episodes e ON e.episode_id = n.episode_id
                WHERE e.project_id = ? AND n.narrative_id = video_storyboards.narrative_id
             )",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_narratives WHERE EXISTS (
                SELECT 1 FROM video_episodes e WHERE e.project_id = ?
                  AND e.episode_id = video_narratives.episode_id
             )",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_visual_spec_sources WHERE EXISTS (
                SELECT 1 FROM video_visual_specs v WHERE v.project_id = ?
                  AND v.spec_id = video_visual_spec_sources.spec_id
                  AND v.revision = video_visual_spec_sources.spec_revision
             )",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_visual_specs WHERE project_id = ?",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_episode_heads WHERE episode_id IN (
                SELECT episode_id FROM video_episodes WHERE project_id = ?
             )",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_episodes WHERE project_id = ?",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_project_heads WHERE project_id = ?",
            params![project_id],
        )?;
        tx.execute(
            "DELETE FROM video_projects WHERE project_id = ?",
            params![project_id],
        )?;
        tx.commit()?;

        Ok(VideoProjectDeleteResult {
            project_id: project_id.to_owned(),
            deleted: true,
            retained_global_media_and_job_history: true,
            retention_note: "Project-owned Video metadata and references were removed. Global video_assets, binary media files, video_jobs, and video_workflows were retained; global media/job history may remain.".to_owned(),
        })
    }

    pub fn save_video_asset(&mut self, asset: &VideoAsset) -> Result<(), StoreError> {
        self.save_video_asset_with_lineage(asset, &[])
    }

    pub fn save_video_asset_with_lineage(
        &mut self,
        asset: &VideoAsset,
        lineage: &[VideoAssetLineage],
    ) -> Result<(), StoreError> {
        if asset.asset_id.trim().is_empty()
            || asset.revision == 0
            || asset.asset_kind.trim().is_empty()
            || asset.provider.trim().is_empty()
            || asset.license_state.trim().is_empty()
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        if lineage
            .iter()
            .any(|link| link.asset_id != asset.asset_id || link.asset_revision != asset.revision)
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let transaction = self.connection.transaction()?;
        let current: Option<i32> = transaction.query_row(
            "SELECT MAX(revision) FROM video_assets WHERE asset_id = ?",
            params![asset.asset_id],
            |row| row.get(0),
        )?;
        if current.is_some_and(|revision| asset.revision as i32 <= revision) {
            return Err(StoreError::InvalidVideoRecord);
        }
        transaction.execute(
            "INSERT INTO video_assets
                (asset_id, revision, asset_kind, relative_path, mime_type, content_hash, width, height, duration_ms,
                 provider, workflow_id, model, reproducibility, capability_state, license_state, job_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                asset.asset_id,
                asset.revision as i32,
                asset.asset_kind,
                asset.relative_path,
                asset.mime_type,
                asset.content_hash,
                asset.width.map(|value| value as i32),
                asset.height.map(|value| value as i32),
                asset.duration_ms.map(|value| value as i64),
                asset.provider,
                asset.workflow_id,
                asset.model,
                asset.reproducibility,
                asset.capability_state,
                asset.license_state,
                asset.job_id,
                asset.created_at,
            ],
        )?;
        for link in lineage {
            Self::save_video_asset_lineage_on(&transaction, link)?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn video_assets(&self, limit: u32) -> Result<Vec<VideoAsset>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT a.asset_id, a.revision, a.asset_kind, a.relative_path, a.mime_type, a.content_hash,
                    a.width, a.height, a.duration_ms, a.provider, a.workflow_id, a.model,
                    a.reproducibility, a.capability_state, a.license_state, a.job_id, a.created_at
             FROM video_assets a
             JOIN (SELECT asset_id, MAX(revision) revision FROM video_assets GROUP BY asset_id) h
               ON h.asset_id = a.asset_id AND h.revision = a.revision
             ORDER BY a.created_at DESC LIMIT ?",
        )?;
        Ok(statement
            .query_map(
                params![limit.clamp(1, 500) as i32],
                raw_video_asset_from_row,
            )?
            .collect::<duckdb::Result<Vec<_>>>()?)
    }

    /// Assets whose lineage reaches a VisualSpec owned by the project (and
    /// optionally the episode). Assets have no project column of their own, so
    /// the saved spec lineage is the authoritative scoping path.
    pub fn video_project_assets(
        &self,
        project_id: &str,
        episode_id: Option<&str>,
        limit: u32,
    ) -> Result<Vec<VideoAsset>, StoreError> {
        let episode_filter = if episode_id.is_some() {
            " AND s.episode_id = ?"
        } else {
            ""
        };
        let sql = format!(
            "SELECT DISTINCT a.asset_id, a.revision, a.asset_kind, a.relative_path, a.mime_type, a.content_hash,
                    a.width, a.height, a.duration_ms, a.provider, a.workflow_id, a.model,
                    a.reproducibility, a.capability_state, a.license_state, a.job_id, a.created_at
             FROM video_assets a
             JOIN (SELECT asset_id, MAX(revision) revision FROM video_assets GROUP BY asset_id) h
               ON h.asset_id = a.asset_id AND h.revision = a.revision
             JOIN video_asset_lineage l
               ON l.asset_id = a.asset_id AND l.asset_revision = a.revision
             JOIN video_visual_specs s
               ON s.spec_id = l.upstream_id AND s.revision = l.upstream_revision
             WHERE l.upstream_kind = 'visual_spec' AND s.project_id = ?{episode_filter}
             ORDER BY a.created_at DESC LIMIT ?"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let limit = limit.clamp(1, 500) as i32;
        let rows = match episode_id {
            Some(episode_id) => statement.query_map(
                params![project_id, episode_id, limit],
                raw_video_asset_from_row,
            )?,
            None => statement.query_map(params![project_id, limit], raw_video_asset_from_row)?,
        };
        Ok(rows.collect::<duckdb::Result<Vec<_>>>()?)
    }

    pub fn save_video_asset_lineage(
        &mut self,
        lineage: &VideoAssetLineage,
    ) -> Result<(), StoreError> {
        Self::save_video_asset_lineage_on(&self.connection, lineage)
    }

    fn save_video_asset_lineage_on(
        connection: &Connection,
        lineage: &VideoAssetLineage,
    ) -> Result<(), StoreError> {
        if lineage.asset_id.trim().is_empty()
            || lineage.asset_revision == 0
            || lineage.upstream_id.trim().is_empty()
            || lineage.relationship.trim().is_empty()
            || lineage.relationship.len() > 128
            || lineage
                .input_hash
                .as_ref()
                .is_some_and(|hash| hash.trim().is_empty())
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let asset_exists: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM video_assets WHERE asset_id = ? AND revision = ?)",
            params![lineage.asset_id, lineage.asset_revision as i32],
            |row| row.get(0),
        )?;
        if !asset_exists {
            return Err(StoreError::InvalidVideoRecord);
        }

        match lineage.upstream_kind {
            VideoAssetUpstreamKind::Event | VideoAssetUpstreamKind::Claim => {
                if lineage.upstream_revision.is_some() {
                    return Err(StoreError::InvalidVideoRecord);
                }
                validate_video_evidence(
                    connection,
                    lineage.upstream_kind.as_str(),
                    1,
                    &VideoEvidenceRef {
                        evidence_kind: lineage.upstream_kind.as_str().into(),
                        evidence_id: lineage.upstream_id.clone(),
                        start_offset: None,
                        end_offset: None,
                        quote: None,
                    },
                )?;
            }
            VideoAssetUpstreamKind::VisualSpec
            | VideoAssetUpstreamKind::Asset
            | VideoAssetUpstreamKind::Scene
            | VideoAssetUpstreamKind::Shot => {
                let revision = lineage
                    .upstream_revision
                    .filter(|revision| *revision > 0)
                    .ok_or(StoreError::InvalidVideoRecord)?;
                let (table, id_column): (&str, &str) = match lineage.upstream_kind {
                    VideoAssetUpstreamKind::VisualSpec => ("video_visual_specs", "spec_id"),
                    VideoAssetUpstreamKind::Asset => ("video_assets", "asset_id"),
                    VideoAssetUpstreamKind::Scene => ("video_scenes", "scene_id"),
                    VideoAssetUpstreamKind::Shot => ("video_shots", "shot_id"),
                    _ => unreachable!(),
                };
                let sql = format!(
                    "SELECT EXISTS(SELECT 1 FROM {table} WHERE {id_column} = ? AND revision = ?)"
                );
                let upstream_exists: bool = connection.query_row(
                    &sql,
                    params![lineage.upstream_id, revision as i32],
                    |row| row.get(0),
                )?;
                if !upstream_exists {
                    return Err(StoreError::InvalidVideoRecord);
                }
                if lineage.upstream_kind == VideoAssetUpstreamKind::Asset {
                    let mut pending = vec![(lineage.upstream_id.clone(), revision)];
                    let mut visited = HashSet::new();
                    while let Some((asset_id, asset_revision)) = pending.pop() {
                        if asset_id == lineage.asset_id && asset_revision == lineage.asset_revision
                        {
                            return Err(StoreError::InvalidVideoRecord);
                        }
                        if !visited.insert((asset_id.clone(), asset_revision)) {
                            continue;
                        }
                        let mut statement = connection.prepare(
                            "SELECT upstream_id, upstream_revision FROM video_asset_lineage
                             WHERE asset_id = ? AND asset_revision = ? AND upstream_kind = 'asset'
                               AND upstream_revision IS NOT NULL",
                        )?;
                        let parents = statement
                            .query_map(params![asset_id, asset_revision as i32], |row| {
                                Ok((
                                    row.get::<_, String>(0)?,
                                    row.get::<_, i32>(1)?.max(0) as u32,
                                ))
                            })?
                            .collect::<duckdb::Result<Vec<_>>>()?;
                        pending.extend(parents);
                    }
                }
            }
        }

        connection.execute(
            "INSERT INTO video_asset_lineage
                (asset_id, asset_revision, upstream_kind, upstream_id, upstream_revision, relationship, input_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (asset_id, asset_revision, upstream_kind, upstream_id, relationship) DO NOTHING",
            params![
                lineage.asset_id,
                lineage.asset_revision as i32,
                lineage.upstream_kind.as_str(),
                lineage.upstream_id,
                lineage.upstream_revision.map(|value| value as i32),
                lineage.relationship,
                lineage.input_hash,
                lineage.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn video_asset_lineage(
        &self,
        asset_id: &str,
        asset_revision: u32,
    ) -> Result<Vec<VideoAssetLineage>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT asset_id, asset_revision, upstream_kind, upstream_id, upstream_revision,
                    relationship, input_hash, created_at
             FROM video_asset_lineage WHERE asset_id = ? AND asset_revision = ?
             ORDER BY upstream_kind, upstream_id, relationship",
        )?;
        Ok(statement
            .query_map(params![asset_id, asset_revision as i32], |row| {
                let kind: String = row.get(2)?;
                let upstream_kind = VideoAssetUpstreamKind::parse(&kind).ok_or_else(|| {
                    duckdb::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                        "invalid Video asset-lineage kind",
                    )))
                })?;
                Ok(VideoAssetLineage {
                    asset_id: row.get(0)?,
                    asset_revision: row.get::<_, i32>(1)?.max(0) as u32,
                    upstream_kind,
                    upstream_id: row.get(3)?,
                    upstream_revision: row
                        .get::<_, Option<i32>>(4)?
                        .map(|value| value.max(0) as u32),
                    relationship: row.get(5)?,
                    input_hash: row.get(6)?,
                    created_at: row.get(7)?,
                })
            })?
            .collect::<duckdb::Result<Vec<_>>>()?)
    }

    pub fn save_video_workflow(&mut self, workflow: &VideoWorkflow) -> Result<(), StoreError> {
        if workflow.workflow_id.trim().is_empty()
            || workflow.revision == 0
            || workflow.capability.trim().is_empty()
            || workflow.provider_adapter.trim().is_empty()
            || workflow.schema_version.trim().is_empty()
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let current: Option<i32> = self.connection.query_row(
            "SELECT MAX(revision) FROM video_workflows WHERE workflow_id = ?",
            params![workflow.workflow_id],
            |row| row.get(0),
        )?;
        if current.is_some_and(|revision| workflow.revision as i32 <= revision) {
            return Err(StoreError::InvalidVideoRecord);
        }
        self.connection.execute(
            "INSERT INTO video_workflows
                (workflow_id, revision, capability, provider_adapter, schema_version, model_identity, parameters_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                workflow.workflow_id,
                workflow.revision as i32,
                workflow.capability,
                workflow.provider_adapter,
                workflow.schema_version,
                workflow.model_identity,
                serde_json::to_string(&workflow.parameters)?,
                workflow.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn video_workflows(&self) -> Result<Vec<VideoWorkflow>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT workflow_id, revision, capability, provider_adapter, schema_version, model_identity, parameters_json, created_at
             FROM video_workflows ORDER BY capability, workflow_id, revision DESC",
        )?;
        Ok(statement
            .query_map([], raw_video_workflow_from_row)?
            .collect::<duckdb::Result<Vec<_>>>()?)
    }

    pub fn save_video_visual_spec(&mut self, spec: &VideoVisualSpec) -> Result<(), StoreError> {
        if spec.spec_id.trim().is_empty()
            || spec.revision == 0
            || spec.schema_version.trim().is_empty()
            || spec.project_id.trim().is_empty()
            || spec.episode_id.trim().is_empty()
            || spec.duration_ms == 0
            || spec.width == 0
            || spec.height == 0
            || spec.fps == 0
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let current: Option<i32> = self.connection.query_row(
            "SELECT MAX(revision) FROM video_visual_specs WHERE spec_id = ?",
            params![spec.spec_id],
            |row| row.get(0),
        )?;
        if current.is_some_and(|revision| spec.revision as i32 <= revision) {
            return Err(StoreError::InvalidVideoRecord);
        }
        for source in &spec.sources {
            if source.source_id.trim().is_empty()
                || matches!((source.start_offset, source.end_offset), (Some(start), Some(end)) if start > end)
            {
                return Err(StoreError::InvalidVideoEvidence);
            }
            if matches!(
                source.source_kind,
                VideoVisualSourceKind::Event | VideoVisualSourceKind::Claim
            ) {
                validate_video_evidence(
                    &self.connection,
                    "visual-spec",
                    1,
                    &VideoEvidenceRef {
                        evidence_kind: source.source_kind.as_str().into(),
                        evidence_id: source.source_id.clone(),
                        start_offset: source.start_offset,
                        end_offset: source.end_offset,
                        quote: source.quote.clone(),
                    },
                )?;
            }
        }
        let spec_json = serde_json::to_string(spec)?;
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO video_visual_specs
                (spec_id, revision, schema_version, project_id, episode_id, scene_id, shot_id,
                 template, spec_json, deterministic, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                spec.spec_id,
                spec.revision as i32,
                spec.schema_version,
                spec.project_id,
                spec.episode_id,
                spec.scene_id,
                spec.shot_id,
                spec.template.as_str(),
                spec_json,
                spec.deterministic,
                spec.created_at,
            ],
        )?;
        for source in &spec.sources {
            transaction.execute(
                "INSERT INTO video_visual_spec_sources
                    (spec_id, spec_revision, source_kind, source_id, source_revision, start_offset, end_offset, quote)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    spec.spec_id,
                    spec.revision as i32,
                    source.source_kind.as_str(),
                    source.source_id,
                    source.source_revision.map(|value| value as i32).unwrap_or(-1),
                    source.start_offset.map(|value| value as i32).unwrap_or(-1),
                    source.end_offset.map(|value| value as i32).unwrap_or(-1),
                    source.quote,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn video_visual_spec(
        &self,
        spec_id: &str,
        revision: u32,
    ) -> Result<Option<VideoVisualSpec>, StoreError> {
        let mut spec: Option<VideoVisualSpec> = self
            .connection
            .query_row(
                "SELECT spec_json FROM video_visual_specs WHERE spec_id = ? AND revision = ?",
                params![spec_id, revision as i32],
                |row| {
                    let text: String = row.get(0)?;
                    serde_json::from_str(&text).map_err(|error| {
                        duckdb::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                            error.to_string(),
                        )))
                    })
                },
            )
            .optional()?;
        if let Some(value) = spec.as_mut() {
            let mut statement = self.connection.prepare(
                "SELECT source_kind, source_id, source_revision, start_offset, end_offset, quote
                 FROM video_visual_spec_sources WHERE spec_id = ? AND spec_revision = ?
                 ORDER BY source_kind, source_id",
            )?;
            value.sources = statement
                .query_map(params![spec_id, revision as i32], |row| {
                    Ok(VideoVisualSource {
                        source_kind: VideoVisualSourceKind::parse(&row.get::<_, String>(0)?)
                            .ok_or_else(|| {
                                duckdb::Error::ToSqlConversionFailure(Box::new(
                                    std::io::Error::other("invalid visual source kind"),
                                ))
                            })?,
                        source_id: row.get(1)?,
                        source_revision: row.get::<_, i32>(2)?.try_into().ok(),
                        start_offset: row.get::<_, i32>(3)?.try_into().ok(),
                        end_offset: row.get::<_, i32>(4)?.try_into().ok(),
                        quote: row.get(5)?,
                    })
                })?
                .collect::<duckdb::Result<Vec<_>>>()?;
        }
        Ok(spec)
    }

    pub fn video_visual_specs(&self, limit: u32) -> Result<Vec<VideoVisualSpec>, StoreError> {
        let ids = {
            let mut statement = self.connection.prepare(
                "SELECT spec_id, revision FROM video_visual_specs
                 ORDER BY created_at DESC LIMIT ?",
            )?;
            statement
                .query_map(params![limit.clamp(1, 500) as i32], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)? as u32))
                })?
                .collect::<duckdb::Result<Vec<_>>>()?
        };
        ids.into_iter()
            .map(|(spec_id, revision)| {
                self.video_visual_spec(&spec_id, revision)?
                    .ok_or(StoreError::InvalidVideoRecord)
            })
            .collect()
    }

    /// Latest VisualSpec revision per scene for the episode's most recent
    /// storyboard, in scene order. Used to rebuild the render list after the
    /// workspace is reopened instead of relying on in-memory state. Scoping to
    /// the newest storyboard avoids replaying slides from superseded builds.
    pub fn video_episode_visual_specs(
        &self,
        project_id: &str,
        episode_id: &str,
    ) -> Result<Vec<VideoVisualSpec>, StoreError> {
        let ids = {
            let mut statement = self.connection.prepare(
                "WITH latest_narrative AS (
                     SELECT narrative_id FROM video_narratives
                     WHERE episode_id = ?
                     ORDER BY updated_at DESC, created_at DESC LIMIT 1
                 ), latest_storyboard AS (
                     SELECT sb.storyboard_id FROM video_storyboards sb
                     JOIN latest_narrative n ON n.narrative_id = sb.narrative_id
                     ORDER BY sb.updated_at DESC, sb.created_at DESC LIMIT 1
                 ), latest_scenes AS (
                     SELECT sc.scene_id, sc.ordinal
                     FROM video_scenes sc
                     JOIN latest_storyboard ls ON ls.storyboard_id = sc.storyboard_id
                     JOIN (SELECT scene_id, MAX(revision) revision FROM video_scenes GROUP BY scene_id) h
                       ON h.scene_id = sc.scene_id AND h.revision = sc.revision
                 )
                 SELECT s.spec_id, s.revision
                 FROM video_visual_specs s
                 JOIN latest_scenes lsc ON lsc.scene_id = s.scene_id
                 JOIN (SELECT spec_id, MAX(revision) revision FROM video_visual_specs GROUP BY spec_id) h
                   ON h.spec_id = s.spec_id AND h.revision = s.revision
                 WHERE s.project_id = ? AND s.episode_id = ?
                 ORDER BY lsc.ordinal, s.created_at, s.spec_id",
            )?;
            statement
                .query_map(params![episode_id, project_id, episode_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)? as u32))
                })?
                .collect::<duckdb::Result<Vec<_>>>()?
        };
        ids.into_iter()
            .map(|(spec_id, revision)| {
                self.video_visual_spec(&spec_id, revision)?
                    .ok_or(StoreError::InvalidVideoRecord)
            })
            .collect()
    }

    pub fn save_video_export_manifest(
        &mut self,
        manifest: &VideoExportManifest,
    ) -> Result<(), StoreError> {
        if manifest.manifest_id.trim().is_empty()
            || manifest.schema_version.trim().is_empty()
            || manifest.project_id.trim().is_empty()
            || manifest.project_revision == 0
            || manifest.files.is_empty()
            || manifest
                .files
                .iter()
                .any(|file| file.relative_path.trim().is_empty() || file.format.trim().is_empty())
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        for evidence in &manifest.evidence {
            validate_video_evidence(&self.connection, "export-manifest", 1, evidence)?;
        }
        let manifest_json = serde_json::to_string(manifest)?;
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO video_export_manifests
                (manifest_id, schema_version, project_id, project_revision, episode_id, storyboard_id,
                 export_kind, deterministic, manifest_json, content_hash, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                manifest.manifest_id,
                manifest.schema_version,
                manifest.project_id,
                manifest.project_revision as i32,
                manifest.episode_id,
                manifest.storyboard_id,
                manifest.export_kind.as_str(),
                manifest.deterministic,
                manifest_json,
                manifest.content_hash,
                manifest.created_at,
            ],
        )?;
        for file in &manifest.files {
            transaction.execute(
                "INSERT INTO video_export_manifest_files
                    (manifest_id, relative_path, format, content_hash, byte_size, mime_type, width, height, duration_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                params![
                    manifest.manifest_id,
                    file.relative_path,
                    file.format,
                    file.content_hash,
                    file.byte_size.map(|value| value as i64),
                    file.mime_type,
                    file.width.map(|value| value as i32),
                    file.height.map(|value| value as i32),
                    file.duration_ms.map(|value| value as i64),
                ],
            )?;
        }
        for evidence in &manifest.evidence {
            transaction.execute(
                "INSERT INTO video_export_manifest_evidence
                    (manifest_id, evidence_kind, evidence_id, start_offset, end_offset)
                 VALUES (?, ?, ?, ?, ?)",
                params![
                    manifest.manifest_id,
                    evidence.evidence_kind,
                    evidence.evidence_id,
                    evidence
                        .start_offset
                        .map(|value| value as i32)
                        .unwrap_or(-1),
                    evidence.end_offset.map(|value| value as i32).unwrap_or(-1),
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn video_export_manifest(
        &self,
        manifest_id: &str,
    ) -> Result<Option<VideoExportManifest>, StoreError> {
        let mut manifest: Option<VideoExportManifest> = self
            .connection
            .query_row(
                "SELECT manifest_json FROM video_export_manifests WHERE manifest_id = ?",
                params![manifest_id],
                |row| {
                    let text: String = row.get(0)?;
                    serde_json::from_str(&text).map_err(|error| {
                        duckdb::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                            error.to_string(),
                        )))
                    })
                },
            )
            .optional()?;
        if let Some(value) = manifest.as_mut() {
            let mut files = self.connection.prepare(
                "SELECT relative_path, format, content_hash, byte_size, mime_type, width, height, duration_ms
                 FROM video_export_manifest_files WHERE manifest_id = ? ORDER BY relative_path",
            )?;
            value.files = files
                .query_map(params![manifest_id], |row| {
                    Ok(VideoExportFile {
                        relative_path: row.get(0)?,
                        format: row.get(1)?,
                        content_hash: row.get(2)?,
                        byte_size: row
                            .get::<_, Option<i64>>(3)?
                            .map(|value| value.max(0) as u64),
                        mime_type: row.get(4)?,
                        width: row
                            .get::<_, Option<i32>>(5)?
                            .map(|value| value.max(0) as u32),
                        height: row
                            .get::<_, Option<i32>>(6)?
                            .map(|value| value.max(0) as u32),
                        duration_ms: row
                            .get::<_, Option<i64>>(7)?
                            .map(|value| value.max(0) as u64),
                    })
                })?
                .collect::<duckdb::Result<Vec<_>>>()?;
            let mut evidence = self.connection.prepare(
                "SELECT evidence_kind, evidence_id, start_offset, end_offset
                 FROM video_export_manifest_evidence WHERE manifest_id = ?
                 ORDER BY evidence_kind, evidence_id",
            )?;
            value.evidence = evidence
                .query_map(params![manifest_id], |row| {
                    Ok(VideoEvidenceRef {
                        evidence_kind: row.get(0)?,
                        evidence_id: row.get(1)?,
                        start_offset: row.get::<_, i32>(2)?.try_into().ok(),
                        end_offset: row.get::<_, i32>(3)?.try_into().ok(),
                        quote: None,
                    })
                })?
                .collect::<duckdb::Result<Vec<_>>>()?;
        }
        Ok(manifest)
    }

    pub fn video_export_manifests(
        &self,
        limit: u32,
    ) -> Result<Vec<VideoExportManifest>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT manifest_id FROM video_export_manifests ORDER BY created_at DESC LIMIT ?",
        )?;
        let ids = statement
            .query_map(params![limit.clamp(1, 500) as i32], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<duckdb::Result<Vec<_>>>()?;
        ids.into_iter()
            .map(|id| {
                self.video_export_manifest(&id)?
                    .ok_or(StoreError::InvalidVideoRecord)
            })
            .collect()
    }

    pub fn video_export_run_request(
        &self,
        request_id: &str,
    ) -> Result<Option<(String, String)>, StoreError> {
        self.connection
            .query_row(
                "SELECT payload_hash,job_id FROM video_export_run_requests WHERE request_id=?",
                params![request_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn create_video_export_job(
        &mut self,
        request_id: &str,
        payload_hash: &str,
        job: &VideoJob,
    ) -> Result<(), StoreError> {
        if request_id.trim().is_empty()
            || payload_hash.trim().is_empty()
            || job.operation != "video.export.ffmpeg"
            || !matches!(job.status.as_str(), "queued" | "running")
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO video_jobs
                (job_id,operation,status,input_revision,progress_millis,cancellation_requested,
                 resource_estimate_json,output_manifest_json,safe_error_message,started_at,finished_at,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                job.job_id, job.operation, job.status, job.input_revision.map(|v| v as i32),
                job.progress_millis as i32, job.cancellation_requested,
                job.resource_estimate.as_ref().map(serde_json::to_string).transpose()?,
                job.output_manifest.as_ref().map(serde_json::to_string).transpose()?,
                job.safe_error_message, job.started_at, job.finished_at, job.created_at,
            ],
        )?;
        transaction.execute(
            "INSERT INTO video_export_run_requests VALUES (?,?,?,?)",
            params![request_id, payload_hash, job.job_id, job.created_at],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// The final file must already have been probed, decoded and hashed. Asset,
    /// lineage, immutable manifest and terminal job become visible together.
    pub fn commit_video_export(
        &mut self,
        manifest: &VideoExportManifestV1,
        asset: &VideoAsset,
        job: &VideoJob,
    ) -> Result<(), StoreError> {
        if manifest.state != "succeeded"
            || manifest.output_asset_ref.id != asset.asset_id
            || manifest.output_asset_ref.revision != asset.revision
            || asset.capability_state != "ready"
            || asset.license_state != "internal_review_only"
            || job.operation != "video.export.ffmpeg"
            || job.status != "succeeded"
            || job.progress_millis != 100_000
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let json = serde_json::to_string(manifest)?;
        let tx = self.connection.transaction()?;
        tx.execute(
            "INSERT INTO video_assets
                (asset_id,revision,asset_kind,relative_path,mime_type,content_hash,width,height,duration_ms,
                 provider,workflow_id,model,reproducibility,capability_state,license_state,job_id,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                asset.asset_id, asset.revision as i32, asset.asset_kind, asset.relative_path,
                asset.mime_type, asset.content_hash, asset.width.map(|v| v as i32),
                asset.height.map(|v| v as i32), asset.duration_ms.map(|v| v as i64),
                asset.provider, asset.workflow_id, asset.model, asset.reproducibility,
                asset.capability_state, asset.license_state, asset.job_id, asset.created_at,
            ],
        )?;
        for item in &manifest.lineage_refs {
            tx.execute(
                "INSERT INTO video_export_asset_lineage_v1
                    (asset_id,asset_revision,upstream_kind,upstream_id,upstream_revision,relationship,input_hash,created_at)
                 VALUES (?,?,?,?,?,?,?,?)",
                params![
                    asset.asset_id, asset.revision as i32, item.kind, item.id,
                    item.revision.map(|v| v as i32), "produced_from_edl_export",
                    manifest.input_fingerprint, manifest.created_at,
                ],
            )?;
            // Preserve every ref in the export-specific table above, and also
            // project typed kinds into the shared lineage API used by agents.
            if let Some(upstream_kind) = VideoAssetUpstreamKind::parse(&item.kind) {
                Self::save_video_asset_lineage_on(
                    &tx,
                    &VideoAssetLineage {
                        asset_id: asset.asset_id.clone(),
                        asset_revision: asset.revision,
                        upstream_kind,
                        upstream_id: item.id.clone(),
                        upstream_revision: item.revision,
                        relationship: "produced_from_edl_export".into(),
                        // The manifest fingerprint is not a per-source hash.
                        input_hash: None,
                        created_at: manifest.created_at,
                    },
                )?;
            }
        }
        tx.execute(
            "INSERT INTO video_export_manifests_v1 VALUES (?,?,?,?,?)",
            params![
                manifest.manifest_ref.id,
                manifest.project_ref.id,
                manifest.project_ref.revision as i32,
                json,
                manifest.created_at,
            ],
        )?;
        let changed = tx.execute(
            "UPDATE video_jobs SET status='succeeded',progress_millis=100000,
                 output_manifest_json=?,safe_error_message=NULL,finished_at=?,
                 cancellation_requested=FALSE WHERE job_id=? AND operation='video.export.ffmpeg' AND cancellation_requested=FALSE AND status IN ('queued','running')",
            params![
                serde_json::to_string(&serde_json::json!({
                    "export_manifest_ref": manifest.manifest_ref,
                    "output_asset_ref": manifest.output_asset_ref,
                    "output_sha256": manifest.output_sha256,
                }))?,
                job.finished_at,
                job.job_id,
            ],
        )?;
        if changed != 1 {
            return Err(StoreError::InvalidVideoRecord);
        }
        tx.commit()?;
        Ok(())
    }

    pub fn video_export_manifest_v1(
        &self,
        manifest_id: &str,
    ) -> Result<Option<VideoExportManifestV1>, StoreError> {
        self.connection
            .query_row(
                "SELECT manifest_json FROM video_export_manifests_v1 WHERE manifest_id=?",
                params![manifest_id],
                |row| {
                    let text: String = row.get(0)?;
                    serde_json::from_str(&text).map_err(|error| {
                        duckdb::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                            error.to_string(),
                        )))
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn video_export_manifests_v1(
        &self,
        project_id: &str,
        project_revision: u32,
        limit: u32,
    ) -> Result<Vec<VideoExportManifestV1>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT manifest_id FROM video_export_manifests_v1
             WHERE project_id=? AND project_revision=? ORDER BY created_at DESC LIMIT ?",
        )?;
        let ids = statement
            .query_map(
                params![
                    project_id,
                    project_revision as i32,
                    limit.clamp(1, 500) as i32
                ],
                |row| row.get::<_, String>(0),
            )?
            .collect::<duckdb::Result<Vec<_>>>()?;
        ids.into_iter()
            .map(|id| {
                self.video_export_manifest_v1(&id)?
                    .ok_or(StoreError::InvalidVideoRecord)
            })
            .collect()
    }

    pub fn save_video_qa_report(&mut self, report: &VideoQaReport) -> Result<(), StoreError> {
        if report.report_id.trim().is_empty()
            || report.project_id.trim().is_empty()
            || report.input_revision == 0
            || report
                .findings
                .iter()
                .any(|finding| finding.code.trim().is_empty() || finding.message.trim().is_empty())
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let project_revision_exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM video_projects WHERE project_id = ? AND revision = ?)",
            params![report.project_id, report.input_revision as i32],
            |row| row.get(0),
        )?;
        if !project_revision_exists {
            return Err(StoreError::InvalidVideoRecord);
        }
        let has_blocker = report
            .findings
            .iter()
            .any(|finding| finding.severity == VideoQaSeverity::Blocker);
        let status_matches_findings = match report.status {
            VideoQaStatus::Passed => report.findings.is_empty(),
            VideoQaStatus::Warning => !report.findings.is_empty() && !has_blocker,
            VideoQaStatus::Blocked => has_blocker,
        };
        if !status_matches_findings {
            return Err(StoreError::InvalidVideoRecord);
        }
        for finding in &report.findings {
            for evidence in &finding.evidence {
                validate_video_evidence(&self.connection, "qa-report", 1, evidence)?;
            }
        }
        let findings_json = serde_json::to_string(&report.findings)?;
        self.connection.execute(
            "INSERT INTO video_qa_reports (report_id, project_id, input_revision, status, findings_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                report.report_id,
                report.project_id,
                report.input_revision as i32,
                match report.status {
                    VideoQaStatus::Passed => "passed",
                    VideoQaStatus::Warning => "warning",
                    VideoQaStatus::Blocked => "blocked",
                },
                findings_json,
                report.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn video_qa_report(&self, report_id: &str) -> Result<Option<VideoQaReport>, StoreError> {
        self.connection
            .query_row(
                "SELECT report_id, project_id, input_revision, status, findings_json, created_at
                 FROM video_qa_reports WHERE report_id = ?",
                params![report_id],
                |row| {
                    let status: String = row.get(3)?;
                    let status = match status.as_str() {
                        "passed" => VideoQaStatus::Passed,
                        "warning" => VideoQaStatus::Warning,
                        "blocked" => VideoQaStatus::Blocked,
                        _ => {
                            return Err(duckdb::Error::ToSqlConversionFailure(Box::new(
                                std::io::Error::other("invalid Video QA status"),
                            )))
                        }
                    };
                    let findings_json: String = row.get(4)?;
                    let findings: Vec<VideoQaFinding> = serde_json::from_str(&findings_json)
                        .map_err(|error| {
                            duckdb::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                                error.to_string(),
                            )))
                        })?;
                    Ok(VideoQaReport {
                        report_id: row.get(0)?,
                        project_id: row.get(1)?,
                        input_revision: row.get::<_, i32>(2)?.max(0) as u32,
                        status,
                        findings,
                        created_at: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn video_qa_reports(
        &self,
        project_id: &str,
        limit: u32,
    ) -> Result<Vec<VideoQaReport>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT report_id FROM video_qa_reports WHERE project_id = ? ORDER BY created_at DESC, report_id LIMIT ?",
        )?;
        let ids = statement
            .query_map(params![project_id, limit.clamp(1, 500) as i32], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<duckdb::Result<Vec<_>>>()?;
        ids.into_iter()
            .map(|id| {
                self.video_qa_report(&id)?
                    .ok_or(StoreError::InvalidVideoRecord)
            })
            .collect()
    }

    /// Persist an immutable audio cue after checking its exact production and registered audio refs.
    pub fn save_video_audio_cue(&mut self, cue: &VideoAudioCue) -> Result<(), StoreError> {
        if cue.cue_id.trim().is_empty()
            || cue.revision == 0
            || cue.project_id.trim().is_empty()
            || cue.project_revision == 0
            || cue.episode_id.trim().is_empty()
            || cue.episode_revision == 0
            || cue.storyboard_id.trim().is_empty()
            || cue.storyboard_revision == 0
            || cue.asset_id.trim().is_empty()
            || cue.asset_revision == 0
            || cue.source_text.trim().is_empty()
            || cue.voice_id.trim().is_empty()
            || cue.provider.trim().is_empty()
            || cue.duration_ms == 0
            || cue.sample_count == 0
            || cue.sample_rate == 0
            || cue.channels == 0
            || !audio_sample_duration_matches(cue.sample_count, cue.sample_rate, cue.duration_ms)
            || !valid_content_sha256(&cue.source_text_hash)
            || cue.source_text_hash != format!("sha256:{}", hex_digest(cue.source_text.as_bytes()))
            || cue.production_metadata.is_null()
            || matches!(
                (cue.scene_id.as_deref(), cue.scene_revision),
                (None, Some(_)) | (Some(_), None)
            )
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let existing: Option<String> = self
            .connection
            .query_row(
                "SELECT cue_json FROM video_audio_cues WHERE cue_id=? AND revision=?",
                params![cue.cue_id, cue.revision as i32],
                |r| r.get(0),
            )
            .optional()?;
        let cue_json = serde_json::to_string(cue)?;
        if let Some(existing) = existing {
            return if existing == cue_json {
                Ok(())
            } else {
                Err(StoreError::InvalidVideoRecord)
            };
        }
        let current: Option<i32> = self.connection.query_row(
            "SELECT MAX(revision) FROM video_audio_cues WHERE cue_id=?",
            params![cue.cue_id],
            |r| r.get(0),
        )?;
        if current.is_some_and(|rev| cue.revision as i32 != rev + 1) {
            return Err(StoreError::InvalidVideoRecord);
        }
        let project_exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM video_projects WHERE project_id=? AND revision=?)",
            params![cue.project_id, cue.project_revision as i32],
            |r| r.get(0),
        )?;
        let episode_project: Option<String> = self
            .connection
            .query_row(
                "SELECT project_id FROM video_episodes WHERE episode_id=? AND revision=?",
                params![cue.episode_id, cue.episode_revision as i32],
                |r| r.get(0),
            )
            .optional()?;
        let storyboard_episode: Option<String> = self.connection.query_row(
            "SELECT n.episode_id FROM video_storyboards s JOIN video_narratives n ON n.narrative_id=s.narrative_id WHERE s.storyboard_id=? AND s.revision=?",
            params![cue.storyboard_id, cue.storyboard_revision as i32], |r| r.get(0)).optional()?;
        if !project_exists
            || episode_project.as_deref() != Some(cue.project_id.as_str())
            || storyboard_episode.as_deref() != Some(cue.episode_id.as_str())
        {
            return Err(StoreError::InvalidEdlOwnership);
        }
        if let (Some(scene_id), Some(scene_revision)) =
            (cue.scene_id.as_deref(), cue.scene_revision)
        {
            let scene_storyboard: Option<String> = self
                .connection
                .query_row(
                    "SELECT storyboard_id FROM video_scenes WHERE scene_id=? AND revision=?",
                    params![scene_id, scene_revision as i32],
                    |r| r.get(0),
                )
                .optional()?;
            if scene_storyboard.as_deref() != Some(cue.storyboard_id.as_str()) {
                return Err(StoreError::InvalidEdlOwnership);
            }
        }
        let asset: Option<(String, Option<String>, Option<String>, Option<String>)> = self.connection.query_row(
            "SELECT asset_kind,relative_path,mime_type,content_hash FROM video_assets WHERE asset_id=? AND revision=? AND capability_state='ready'",
            params![cue.asset_id, cue.asset_revision as i32], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let Some((kind, path, mime, hash)) = asset else {
            return Err(StoreError::InvalidVideoRecord);
        };
        if kind != "audio"
            || !mime.as_deref().is_some_and(|v| v.starts_with("audio/"))
            || !path.as_deref().is_some_and(valid_media_relative_path)
            || !hash.as_deref().is_some_and(valid_content_sha256)
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        for evidence in &cue.evidence {
            validate_video_evidence(&self.connection, "audio-cue", cue.revision, evidence)?;
        }
        let tx = self.connection.transaction()?;
        tx.execute(
            "INSERT INTO video_audio_cues VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            params![
                cue.cue_id,
                cue.revision as i32,
                cue.project_id,
                cue.project_revision as i32,
                cue.episode_id,
                cue.episode_revision as i32,
                cue.storyboard_id,
                cue.storyboard_revision as i32,
                cue.scene_id,
                cue.scene_revision.map(|v| v as i32),
                cue.asset_id,
                cue.asset_revision as i32,
                cue_json,
                cue.created_at
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn video_audio_cue(
        &self,
        cue_id: &str,
        revision: u32,
    ) -> Result<Option<VideoAudioCue>, StoreError> {
        let json: Option<String> = self
            .connection
            .query_row(
                "SELECT cue_json FROM video_audio_cues WHERE cue_id=? AND revision=?",
                params![cue_id, revision as i32],
                |r| r.get(0),
            )
            .optional()?;
        json.map(|v| serde_json::from_str(&v).map_err(StoreError::SnapshotJson))
            .transpose()
    }
    pub fn video_audio_cues(
        &self,
        storyboard_id: &str,
        storyboard_revision: u32,
        limit: u32,
    ) -> Result<Vec<VideoAudioCue>, StoreError> {
        let mut st=self.connection.prepare("SELECT cue_id,revision FROM video_audio_cues WHERE storyboard_id=? AND storyboard_revision=? ORDER BY cue_id,revision DESC LIMIT ?")?;
        let refs = st
            .query_map(
                params![
                    storyboard_id,
                    storyboard_revision as i32,
                    limit.clamp(1, 500) as i32
                ],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i32>(1)?.max(0) as u32)),
            )?
            .collect::<duckdb::Result<Vec<_>>>()?;
        refs.into_iter()
            .map(|(id, rev)| {
                self.video_audio_cue(&id, rev)?
                    .ok_or(StoreError::InvalidVideoRecord)
            })
            .collect()
    }

    /// Resolve exact EDL parent ownership and selected input inventory from canonical DB rows.
    pub fn video_edl_inventory(
        &self,
        project: &VideoEdlRef,
        episode: &VideoEdlRef,
        storyboard: &VideoEdlRef,
        selected_shots: &[VideoEdlRef],
        selected_assets: &[VideoEdlRef],
        selected_cues: &[VideoEdlRef],
        selected_evidence: &[(String, String)],
    ) -> Result<VideoEdlInventory, StoreError> {
        let project_exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM video_projects WHERE project_id=? AND revision=?)",
            params![project.id, project.revision as i32],
            |r| r.get(0),
        )?;
        let episode_project: Option<String> = self
            .connection
            .query_row(
                "SELECT project_id FROM video_episodes WHERE episode_id=? AND revision=?",
                params![episode.id, episode.revision as i32],
                |r| r.get(0),
            )
            .optional()?;
        let storyboard_episode: Option<String> = self.connection.query_row("SELECT n.episode_id FROM video_storyboards s JOIN video_narratives n ON n.narrative_id=s.narrative_id WHERE s.storyboard_id=? AND s.revision=?", params![storyboard.id,storyboard.revision as i32], |r| r.get(0)).optional()?;
        if !project_exists
            || episode_project.as_deref() != Some(project.id.as_str())
            || storyboard_episode.as_deref() != Some(episode.id.as_str())
        {
            return Err(StoreError::InvalidEdlOwnership);
        }
        let mut storyboard_shots = Vec::new();
        {
            let mut st=self.connection.prepare("SELECT shot.shot_id, MAX(shot.revision), FALSE FROM video_scenes scene JOIN video_shots shot ON shot.scene_id=scene.scene_id WHERE scene.storyboard_id=? GROUP BY shot.shot_id ORDER BY shot.shot_id")?;
            for row in st.query_map(params![storyboard.id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i32>(1)?,
                    r.get::<_, bool>(2)?,
                ))
            })? {
                let (id, revision, claim) = row?;
                storyboard_shots.push(VideoEdlShotFact {
                    shot: VideoEdlRef {
                        id,
                        revision: revision.max(0) as u32,
                    },
                    claiming: claim,
                });
            }
        }
        let mut selected_shot_facts = Vec::new();
        for shot in selected_shots {
            let row:Option<(String,bool)>=self.connection.query_row("SELECT scene.storyboard_id, EXISTS(SELECT 1 FROM video_shot_evidence e WHERE e.shot_id=shot.shot_id AND e.shot_revision=shot.revision) FROM video_shots shot JOIN video_scenes scene ON scene.scene_id=shot.scene_id WHERE shot.shot_id=? AND shot.revision=?",params![shot.id,shot.revision as i32],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
            if let Some((sid, claim)) = row {
                if sid == storyboard.id {
                    selected_shot_facts.push(VideoEdlShotFact {
                        shot: shot.clone(),
                        claiming: claim,
                    });
                }
            }
        }
        let mut assets = Vec::new();
        for asset in selected_assets {
            let row:Option<(Option<String>,Option<String>,Option<String>,String,String,String,Option<i32>,Option<i32>,Option<i64>)>=self.connection.query_row("SELECT content_hash,relative_path,mime_type,capability_state,license_state,asset_kind,width,height,duration_ms FROM video_assets WHERE asset_id=? AND revision=?",params![asset.id,asset.revision as i32],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?))).optional()?;
            if let Some((
                content_hash,
                relative_path,
                mime_type,
                capability_state,
                license_state,
                asset_kind,
                width,
                height,
                duration_ms,
            )) = row
            {
                let mut related_shots = Vec::new();
                {
                    let mut st=self.connection.prepare("SELECT shot_id,shot_revision FROM video_shot_assets WHERE asset_id=? AND asset_revision=? AND role IN ('selected','produced') UNION SELECT upstream_id,upstream_revision FROM video_asset_lineage WHERE asset_id=? AND asset_revision=? AND upstream_kind='shot' AND upstream_revision IS NOT NULL")?;
                    for rr in st.query_map(
                        params![
                            asset.id,
                            asset.revision as i32,
                            asset.id,
                            asset.revision as i32
                        ],
                        |r| {
                            Ok(VideoEdlRef {
                                id: r.get(0)?,
                                revision: r.get::<_, i32>(1)?.max(0) as u32,
                            })
                        },
                    )? {
                        related_shots.push(rr?);
                    }
                }
                {
                    let mut st=self.connection.prepare("SELECT DISTINCT sh.shot_id,sh.revision FROM video_asset_lineage l JOIN video_visual_specs v ON v.spec_id=l.upstream_id AND v.revision=l.upstream_revision JOIN video_shots sh ON sh.shot_id=v.shot_id AND sh.revision=(SELECT MAX(sh2.revision) FROM video_shots sh2 WHERE sh2.shot_id=sh.shot_id) WHERE l.asset_id=? AND l.asset_revision=? AND l.upstream_kind='visual_spec' AND v.shot_id IS NOT NULL")?;
                    for rr in st.query_map(params![asset.id, asset.revision as i32], |r| {
                        Ok(VideoEdlRef {
                            id: r.get(0)?,
                            revision: r.get::<_, i32>(1)?.max(0) as u32,
                        })
                    })? {
                        related_shots.push(rr?);
                    }
                }
                related_shots.sort_by(|a, b| a.id.cmp(&b.id).then(a.revision.cmp(&b.revision)));
                related_shots.dedup();
                let visual_spec=self.connection.query_row("SELECT upstream_id,upstream_revision FROM video_asset_lineage WHERE asset_id=? AND asset_revision=? AND upstream_kind='visual_spec' AND upstream_revision IS NOT NULL ORDER BY upstream_id LIMIT 1",params![asset.id,asset.revision as i32],|r|Ok(VideoEdlRef{id:r.get(0)?,revision:r.get::<_,i32>(1)?.max(0) as u32})).optional()?;
                assets.push(VideoEdlAssetFact {
                    asset: asset.clone(),
                    content_hash,
                    relative_path,
                    mime_type,
                    capability_state,
                    license_state,
                    asset_kind,
                    width: width.map(|v| v.max(0) as u32),
                    height: height.map(|v| v.max(0) as u32),
                    duration_ms: duration_ms.map(|v| v.max(0) as u64),
                    related_shots,
                    visual_spec,
                });
            }
        }
        let mut cues = Vec::new();
        for requested in selected_cues {
            if let Some(cue) = self.video_audio_cue(&requested.id, requested.revision)? {
                cues.push(VideoEdlCueFact {
                    cue: requested.clone(),
                    project: VideoEdlRef {
                        id: cue.project_id,
                        revision: cue.project_revision,
                    },
                    episode: VideoEdlRef {
                        id: cue.episode_id,
                        revision: cue.episode_revision,
                    },
                    storyboard: VideoEdlRef {
                        id: cue.storyboard_id,
                        revision: cue.storyboard_revision,
                    },
                    scene: cue.scene_id.map(|id| VideoEdlRef {
                        id,
                        revision: cue.scene_revision.unwrap_or(0),
                    }),
                    asset: VideoEdlRef {
                        id: cue.asset_id,
                        revision: cue.asset_revision,
                    },
                    duration_ms: cue.duration_ms,
                    sample_count: cue.sample_count,
                    sample_rate: cue.sample_rate,
                    channels: cue.channels,
                    evidence: cue.evidence,
                });
            }
        }
        let mut evidence = Vec::new();
        for (kind, id) in selected_evidence {
            if kind != "claim" {
                continue;
            }
            let check = VideoEvidenceRef {
                evidence_kind: kind.clone(),
                evidence_id: id.clone(),
                start_offset: None,
                end_offset: None,
                quote: None,
            };
            if validate_video_evidence(&self.connection, "edl", 1, &check).is_ok() {
                evidence.push((kind.clone(), id.clone()));
            }
        }
        for cue in &cues {
            for ev in &cue.evidence {
                if ev.evidence_kind == "event" && !video_evidence_has_complete_span(ev) {
                    continue;
                }
                let check = VideoEvidenceRef {
                    evidence_kind: ev.evidence_kind.clone(),
                    evidence_id: ev.evidence_id.clone(),
                    start_offset: ev.start_offset,
                    end_offset: ev.end_offset,
                    quote: ev.quote.clone(),
                };
                if validate_video_evidence(&self.connection, "edl", 1, &check).is_ok() {
                    evidence.push((ev.evidence_kind.clone(), ev.evidence_id.clone()));
                }
            }
        }
        for fact in selected_shot_facts
            .iter_mut()
            .chain(storyboard_shots.iter_mut())
        {
            let mut st=self.connection.prepare("SELECT evidence_kind,evidence_id FROM video_shot_evidence WHERE shot_id=? AND shot_revision=?")?;
            for row in st.query_map(params![fact.shot.id, fact.shot.revision as i32], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })? {
                let (kind, id) = row?;
                if kind != "claim" {
                    continue;
                }
                let check = VideoEvidenceRef {
                    evidence_kind: kind.clone(),
                    evidence_id: id.clone(),
                    start_offset: None,
                    end_offset: None,
                    quote: None,
                };
                if validate_video_evidence(&self.connection, "edl", 1, &check).is_ok() {
                    fact.claiming = true;
                    evidence.push((kind, id));
                }
            }
        }
        evidence.sort();
        evidence.dedup();
        Ok(VideoEdlInventory {
            storyboard_shots,
            selected_shots: selected_shot_facts,
            assets,
            cues,
            evidence,
        })
    }

    pub fn video_edl_request_result(
        &self,
        request_id: &str,
        payload_hash: &str,
    ) -> Result<Option<String>, StoreError> {
        let old: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT payload_hash,result_json FROM video_edl_build_requests WHERE request_id=?",
                params![request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        match old {
            Some((hash, result)) if hash == payload_hash => Ok(Some(result)),
            Some(_) => Err(StoreError::EdlIdempotencyConflict),
            None => Ok(None),
        }
    }
    pub fn save_video_edl_build(
        &mut self,
        record: &VideoEdlRevision,
        request_id: &str,
        payload_hash: &str,
        result_json: &str,
    ) -> Result<Option<String>, StoreError> {
        let tx = self.connection.transaction()?;
        let old: Option<(String, String)> = tx
            .query_row(
                "SELECT payload_hash,result_json FROM video_edl_build_requests WHERE request_id=?",
                params![request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((h, v)) = old {
            if h != payload_hash {
                return Err(StoreError::EdlIdempotencyConflict);
            }
            tx.commit()?;
            return Ok(Some(v));
        }
        if record.build_status != "ready" || record.revision == 0 {
            return Err(StoreError::InvalidVideoRecord);
        }
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM video_edl_timelines WHERE input_fingerprint=?)",
            params![record.input_fingerprint],
            |r| r.get(0),
        )?;
        if !exists {
            tx.execute(
                "INSERT INTO video_edl_timelines VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    record.timeline_id,
                    record.revision as i32,
                    record.project_id,
                    record.project_revision as i32,
                    record.episode_id,
                    record.episode_revision as i32,
                    record.storyboard_id,
                    record.storyboard_revision as i32,
                    record.profile_id,
                    record.profile_revision as i32,
                    record.schema_version,
                    record.build_version,
                    record.build_status,
                    record.timeline_hash,
                    record.input_fingerprint,
                    record.manifest_json,
                    record.findings_json,
                    record.created_at
                ],
            )?;
        }
        tx.execute(
            "INSERT INTO video_edl_build_requests VALUES (?,?,?,?)",
            params![request_id, payload_hash, result_json, record.created_at],
        )?;
        tx.execute("DELETE FROM video_edl_build_requests WHERE request_id NOT IN (SELECT request_id FROM video_edl_build_requests ORDER BY created_at DESC,request_id DESC LIMIT 1000)",[])?;
        tx.commit()?;
        Ok(None)
    }
    pub fn save_video_edl_blocked_request(
        &mut self,
        request_id: &str,
        payload_hash: &str,
        result_json: &str,
        created_at: DateTime<Utc>,
    ) -> Result<Option<String>, StoreError> {
        let tx = self.connection.transaction()?;
        let old: Option<(String, String)> = tx
            .query_row(
                "SELECT payload_hash,result_json FROM video_edl_build_requests WHERE request_id=?",
                params![request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((h, v)) = old {
            if h != payload_hash {
                return Err(StoreError::EdlIdempotencyConflict);
            }
            tx.commit()?;
            return Ok(Some(v));
        }
        tx.execute(
            "INSERT INTO video_edl_build_requests VALUES (?,?,?,?)",
            params![request_id, payload_hash, result_json, created_at],
        )?;
        tx.execute("DELETE FROM video_edl_build_requests WHERE request_id NOT IN (SELECT request_id FROM video_edl_build_requests ORDER BY created_at DESC,request_id DESC LIMIT 1000)",[])?;
        tx.commit()?;
        Ok(None)
    }
    pub fn video_edl_timeline(
        &self,
        timeline_id: &str,
        revision: u32,
    ) -> Result<Option<VideoEdlRevision>, StoreError> {
        self.connection.query_row("SELECT timeline_id,revision,project_id,project_revision,episode_id,episode_revision,storyboard_id,storyboard_revision,profile_id,profile_revision,schema_version,build_version,build_status,timeline_hash,input_fingerprint,manifest_json,findings_json,created_at FROM video_edl_timelines WHERE timeline_id=? AND revision=?",params![timeline_id,revision as i32],raw_video_edl_revision_from_row).optional().map_err(StoreError::from)
    }
    pub fn video_edl_timelines(
        &self,
        project_id: &str,
        project_revision: u32,
        limit: u32,
    ) -> Result<Vec<VideoEdlRevision>, StoreError> {
        let mut st=self.connection.prepare("SELECT timeline_id,revision,project_id,project_revision,episode_id,episode_revision,storyboard_id,storyboard_revision,profile_id,profile_revision,schema_version,build_version,build_status,timeline_hash,input_fingerprint,manifest_json,findings_json,created_at FROM video_edl_timelines WHERE project_id=? AND project_revision=? ORDER BY created_at DESC,timeline_id,revision DESC LIMIT ?")?;
        Ok(st
            .query_map(
                params![
                    project_id,
                    project_revision as i32,
                    limit.clamp(1, 500) as i32
                ],
                raw_video_edl_revision_from_row,
            )?
            .collect::<duckdb::Result<Vec<_>>>()?)
    }

    pub fn video_qa_request(
        &self,
        request_id: &str,
    ) -> Result<Option<(String, String, String)>, StoreError> {
        self.connection.query_row(
            "SELECT payload_hash,job_id,report_id FROM video_qa_run_requests WHERE request_id=?",
            params![request_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
        ).optional().map_err(StoreError::from)
    }

    pub fn save_video_qa_run(
        &mut self,
        request_id: &str,
        payload_hash: &str,
        job: &VideoJob,
        report: &VideoQaStoredReport,
    ) -> Result<(), StoreError> {
        if request_id.trim().is_empty()
            || payload_hash.trim().is_empty()
            || report.report_id.trim().is_empty()
            || report.input_fingerprint.trim().is_empty()
            || report.evaluator_version.trim().is_empty()
            || job.operation != "video.qa.deterministic"
            || job.status != "succeeded"
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let tx = self.connection.transaction()?;
        tx.execute(
            "INSERT INTO video_qa_reports_v2 VALUES (?,?,?,?,?,?,?,?,?,?)",
            params![
                report.report_id,
                report.timeline_id,
                report.timeline_revision as i32,
                report.project_id,
                report.input_fingerprint,
                report.evaluator_version,
                report.profile_id,
                report.profile_revision as i32,
                report.report_json,
                report.created_at
            ],
        )?;
        tx.execute("INSERT INTO video_jobs (job_id,operation,status,input_revision,progress_millis,cancellation_requested,resource_estimate_json,output_manifest_json,safe_error_message,started_at,finished_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", params![job.job_id,job.operation,job.status,job.input_revision.map(|v|v as i32),job.progress_millis as i32,job.cancellation_requested,job.resource_estimate.as_ref().map(serde_json::to_string).transpose()?,job.output_manifest.as_ref().map(serde_json::to_string).transpose()?,job.safe_error_message,job.started_at,job.finished_at,job.created_at])?;
        tx.execute(
            "INSERT INTO video_qa_run_requests VALUES (?,?,?,?,?)",
            params![
                request_id,
                payload_hash,
                job.job_id,
                report.report_id,
                report.created_at
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn video_qa_stored_report(
        &self,
        report_id: &str,
    ) -> Result<Option<VideoQaStoredReport>, StoreError> {
        self.connection.query_row("SELECT report_id,timeline_id,timeline_revision,project_id,input_fingerprint,evaluator_version,profile_id,profile_revision,report_json,created_at FROM video_qa_reports_v2 WHERE report_id=?",params![report_id],|r|Ok(VideoQaStoredReport{report_id:r.get(0)?,timeline_id:r.get(1)?,timeline_revision:r.get::<_,i32>(2)?.max(0) as u32,project_id:r.get(3)?,input_fingerprint:r.get(4)?,evaluator_version:r.get(5)?,profile_id:r.get(6)?,profile_revision:r.get::<_,i32>(7)?.max(0) as u32,report_json:r.get(8)?,created_at:r.get(9)?})).optional().map_err(StoreError::from)
    }

    pub fn save_video_timeline(&mut self, timeline: &VideoTimeline) -> Result<(), StoreError> {
        if timeline.timeline_id.trim().is_empty()
            || timeline.project_id.trim().is_empty()
            || timeline.revision == 0
            || timeline.input_revision == 0
            || timeline.export_revision == 0
            || timeline.clips.is_empty()
            || timeline.total_duration_ms == 0
            || !timeline.deterministic
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let project_revision_exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM video_projects WHERE project_id = ? AND revision = ?)",
            params![timeline.project_id, timeline.input_revision as i32],
            |row| row.get(0),
        )?;
        if !project_revision_exists {
            return Err(StoreError::InvalidVideoRecord);
        }
        let current: Option<i32> = self.connection.query_row(
            "SELECT MAX(revision) FROM video_timelines WHERE timeline_id = ?",
            params![timeline.timeline_id],
            |row| row.get(0),
        )?;
        if current.is_some_and(|revision| timeline.revision as i32 <= revision) {
            return Err(StoreError::InvalidVideoRecord);
        }
        let mut prior_end = 0_u64;
        let mut max_end = 0_u64;
        for (index, clip) in timeline.clips.iter().enumerate() {
            let end = clip
                .start_ms
                .checked_add(clip.duration_ms)
                .ok_or(StoreError::InvalidVideoRecord)?;
            if clip.shot_id.trim().is_empty()
                || clip.shot_revision == 0
                || clip.duration_ms == 0
                || (index > 0 && clip.start_ms < prior_end)
            {
                return Err(StoreError::InvalidVideoRecord);
            }
            let shot_belongs_to_project: bool = self.connection.query_row(
                "SELECT EXISTS(
                    SELECT 1
                    FROM video_shots shot
                    JOIN video_scenes scene ON scene.scene_id = shot.scene_id
                    JOIN video_storyboards storyboard ON storyboard.storyboard_id = scene.storyboard_id
                    JOIN video_narratives narrative ON narrative.narrative_id = storyboard.narrative_id
                    JOIN video_episodes episode ON episode.episode_id = narrative.episode_id
                    WHERE shot.shot_id = ? AND shot.revision = ? AND episode.project_id = ?
                )",
                params![clip.shot_id, clip.shot_revision as i32, timeline.project_id],
                |row| row.get(0),
            )?;
            if !shot_belongs_to_project {
                return Err(StoreError::InvalidVideoRecord);
            }
            match (&clip.asset_id, clip.asset_revision) {
                (Some(asset_id), Some(asset_revision))
                    if !asset_id.trim().is_empty() && asset_revision > 0 =>
                {
                    let asset_exists: bool = self.connection.query_row(
                        "SELECT EXISTS(SELECT 1 FROM video_assets WHERE asset_id = ? AND revision = ?)",
                        params![asset_id, asset_revision as i32],
                        |row| row.get(0),
                    )?;
                    if !asset_exists {
                        return Err(StoreError::InvalidVideoRecord);
                    }
                }
                (None, None) => {}
                _ => return Err(StoreError::InvalidVideoRecord),
            }
            for evidence in &clip.evidence {
                validate_video_evidence(&self.connection, "timeline", timeline.revision, evidence)?;
            }
            prior_end = end;
            max_end = max_end.max(end);
        }
        if timeline.total_duration_ms != max_end {
            return Err(StoreError::InvalidVideoRecord);
        }
        let timeline_json = serde_json::to_string(timeline)?;
        self.connection.execute(
            "INSERT INTO video_timelines (timeline_id, project_id, revision, timeline_json, export_revision, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                timeline.timeline_id,
                timeline.project_id,
                timeline.revision as i32,
                timeline_json,
                timeline.export_revision as i32,
                timeline.created_at,
            ],
        )?;
        Ok(())
    }

    pub fn video_timeline(
        &self,
        timeline_id: &str,
        revision: u32,
    ) -> Result<Option<VideoTimeline>, StoreError> {
        self.connection
            .query_row(
                "SELECT timeline_json FROM video_timelines WHERE timeline_id = ? AND revision = ?",
                params![timeline_id, revision as i32],
                |row| {
                    let timeline_json: String = row.get(0)?;
                    serde_json::from_str(&timeline_json).map_err(|error| {
                        duckdb::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                            error.to_string(),
                        )))
                    })
                },
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn video_timelines(
        &self,
        project_id: &str,
        limit: u32,
    ) -> Result<Vec<VideoTimeline>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT timeline_id, revision FROM video_timelines WHERE project_id = ? ORDER BY created_at DESC, timeline_id, revision DESC LIMIT ?",
        )?;
        let ids = statement
            .query_map(params![project_id, limit.clamp(1, 500) as i32], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)? as u32))
            })?
            .collect::<duckdb::Result<Vec<_>>>()?;
        ids.into_iter()
            .map(|(id, revision)| {
                self.video_timeline(&id, revision)?
                    .ok_or(StoreError::InvalidVideoRecord)
            })
            .collect()
    }

    pub fn save_video_job(&mut self, job: &VideoJob) -> Result<(), StoreError> {
        if job.job_id.trim().is_empty()
            || job.operation.trim().is_empty()
            || !matches!(
                job.status.as_str(),
                "queued" | "running" | "succeeded" | "failed" | "cancelled"
            )
            || job.progress_millis > 100_000
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        self.connection.execute(
            "INSERT INTO video_jobs
                (job_id, operation, status, input_revision, progress_millis, cancellation_requested,
                 resource_estimate_json, output_manifest_json, safe_error_message, started_at, finished_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (job_id) DO UPDATE SET
                operation = excluded.operation, status = excluded.status, input_revision = excluded.input_revision,
                progress_millis = excluded.progress_millis, cancellation_requested = excluded.cancellation_requested,
                resource_estimate_json = excluded.resource_estimate_json, output_manifest_json = excluded.output_manifest_json,
                safe_error_message = excluded.safe_error_message, started_at = excluded.started_at,
                finished_at = excluded.finished_at, created_at = excluded.created_at",
            params![
                job.job_id, job.operation, job.status, job.input_revision.map(|value| value as i32),
                job.progress_millis as i32, job.cancellation_requested,
                job.resource_estimate.as_ref().map(serde_json::to_string).transpose()?,
                job.output_manifest.as_ref().map(serde_json::to_string).transpose()?,
                job.safe_error_message, job.started_at, job.finished_at, job.created_at,
            ],
        )?;
        Ok(())
    }

    /// Conditional non-success export transition. Succeeded is only committed
    /// atomically with the asset/manifest through `commit_video_export`.
    pub fn update_video_export_job_active(&mut self, job: &VideoJob) -> Result<bool, StoreError> {
        if job.job_id.trim().is_empty()
            || job.operation != "video.export.ffmpeg"
            || !matches!(job.status.as_str(), "running" | "failed" | "cancelled")
            || job.progress_millis > 100_000
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let changed = self.connection.execute(
            "UPDATE video_jobs SET status=?,progress_millis=?,cancellation_requested=?,
                 resource_estimate_json=?,safe_error_message=?,started_at=?,finished_at=?
             WHERE job_id=? AND operation='video.export.ffmpeg' AND status IN ('queued','running') AND (? <> 'running' OR cancellation_requested=FALSE)",
            params![
                job.status, job.progress_millis as i32, job.cancellation_requested,
                job.resource_estimate.as_ref().map(serde_json::to_string).transpose()?,
                job.safe_error_message, job.started_at, job.finished_at, job.job_id, job.status,
            ],
        )?;
        Ok(changed == 1)
    }

    pub fn video_job(&self, job_id: &str) -> Result<Option<VideoJob>, StoreError> {
        self.connection.query_row(
            "SELECT job_id, operation, status, input_revision, progress_millis, cancellation_requested,
                    resource_estimate_json, output_manifest_json, safe_error_message, started_at, finished_at, created_at
             FROM video_jobs WHERE job_id = ?",
            params![job_id], raw_video_job_from_row,
        ).optional().map_err(StoreError::from)
    }

    pub fn video_jobs(&self, limit: u32) -> Result<Vec<VideoJob>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT job_id, operation, status, input_revision, progress_millis, cancellation_requested,
                    resource_estimate_json, output_manifest_json, safe_error_message, started_at, finished_at, created_at
             FROM video_jobs ORDER BY created_at DESC LIMIT ?",
        )?;
        Ok(statement
            .query_map(params![limit.clamp(1, 500) as i32], raw_video_job_from_row)?
            .collect::<duckdb::Result<Vec<_>>>()?)
    }

    pub fn recover_video_jobs(&mut self) -> Result<Vec<VideoJob>, StoreError> {
        self.connection.execute(
            "UPDATE video_jobs SET status = 'failed', safe_error_message = 'job interrupted by service restart', finished_at = CURRENT_TIMESTAMP
             WHERE status IN ('queued', 'running')",
            [],
        )?;
        self.video_jobs(500)
    }

    pub fn cleanup_video_jobs(&mut self, before: DateTime<Utc>) -> Result<u64, StoreError> {
        let deleted = self.connection.execute(
            "DELETE FROM video_jobs
             WHERE finished_at IS NOT NULL AND finished_at < ?
               AND status IN ('succeeded', 'failed', 'cancelled')",
            params![before],
        )?;
        Ok(deleted as u64)
    }

    pub fn save_video_episode(&mut self, episode: &VideoEpisode) -> Result<(), StoreError> {
        if episode.episode_id.trim().is_empty()
            || episode.project_id.trim().is_empty()
            || episode.revision == 0
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let project_exists: bool = self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM video_project_heads WHERE project_id = ?)",
            params![episode.project_id],
            |row| row.get(0),
        )?;
        if !project_exists {
            return Err(StoreError::InvalidVideoRecord);
        }
        let transaction = self.connection.transaction()?;
        let expected = episode.revision.saturating_sub(1);
        let existing_project: Option<String> = transaction
            .query_row(
                "SELECT project_id FROM video_episodes WHERE episode_id = ? ORDER BY revision LIMIT 1",
                params![episode.episode_id],
                |row| row.get(0),
            )
            .optional()?;
        if existing_project
            .as_deref()
            .is_some_and(|project_id| project_id != episode.project_id)
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let current: Option<i32> = transaction
            .query_row(
                "SELECT revision FROM video_episode_heads WHERE episode_id = ?",
                params![episode.episode_id],
                |row| row.get(0),
            )
            .optional()?;
        if current.unwrap_or(0) != expected as i32 {
            return Err(StoreError::InvalidVideoRecord);
        }
        transaction.execute(
            "INSERT INTO video_episodes
                (episode_id, project_id, revision, title, as_of, disclosure, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                episode.episode_id,
                episode.project_id,
                episode.revision as i32,
                episode.title,
                episode.as_of,
                episode.disclosure,
                video_episode_status_as_str(episode.status),
                episode.created_at,
                episode.updated_at,
            ],
        )?;
        transaction.execute(
            "INSERT INTO video_episode_heads (episode_id, revision, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT (episode_id) DO UPDATE SET revision = excluded.revision,
                 updated_at = excluded.updated_at",
            params![
                episode.episode_id,
                episode.revision as i32,
                episode.updated_at
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn link_video_episode_evidence(
        &mut self,
        episode_id: &str,
        episode_revision: u32,
        evidence: &VideoEvidenceRef,
    ) -> Result<(), StoreError> {
        validate_video_evidence(&self.connection, episode_id, episode_revision, evidence)?;
        self.connection.execute(
            "INSERT INTO video_episode_evidence
                (episode_id, episode_revision, evidence_kind, evidence_id, start_offset, end_offset, quote)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT DO NOTHING",
            params![
                episode_id,
                episode_revision as i32,
                evidence.evidence_kind,
                evidence.evidence_id,
                evidence.start_offset.map_or(-1, |value| value as i32),
                evidence.end_offset.map_or(-1, |value| value as i32),
                evidence.quote,
            ],
        )?;
        Ok(())
    }

    pub fn video_episode(&self, episode_id: &str) -> Result<Option<VideoEpisode>, StoreError> {
        self.connection
            .query_row(
                "SELECT episode_id, project_id, revision, title, as_of, disclosure, status, created_at, updated_at
                 FROM video_episodes
                 WHERE episode_id = ?
                 ORDER BY revision DESC
                 LIMIT 1",
                params![episode_id],
                raw_video_episode_from_row,
            )
            .optional()
            .map_err(StoreError::from)
    }

    /// Current revision of every episode in a project, newest activity first.
    pub fn video_episodes(&self, project_id: &str) -> Result<Vec<VideoEpisode>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT e.episode_id, e.project_id, e.revision, e.title, e.as_of, e.disclosure, e.status, e.created_at, e.updated_at
             FROM video_episodes e
             JOIN video_episode_heads h
               ON h.episode_id = e.episode_id AND h.revision = e.revision
             WHERE e.project_id = ?
             ORDER BY e.updated_at DESC, e.episode_id",
        )?;
        Ok(statement
            .query_map(params![project_id], raw_video_episode_from_row)?
            .collect::<duckdb::Result<Vec<_>>>()?)
    }

    pub fn video_episode_evidence(
        &self,
        episode_id: &str,
        episode_revision: u32,
    ) -> Result<Vec<VideoEvidenceRef>, StoreError> {
        let mut statement = self.connection.prepare(
            "SELECT evidence_kind, evidence_id, start_offset, end_offset, quote
             FROM video_episode_evidence
             WHERE episode_id = ? AND episode_revision = ?
             ORDER BY created_at, evidence_kind, evidence_id",
        )?;
        Ok(statement
            .query_map(params![episode_id, episode_revision as i32], |row| {
                let start: i32 = row.get(2)?;
                let end: i32 = row.get(3)?;
                Ok(VideoEvidenceRef {
                    evidence_kind: row.get(0)?,
                    evidence_id: row.get(1)?,
                    start_offset: (start >= 0).then_some(start as u32),
                    end_offset: (end >= 0).then_some(end as u32),
                    quote: row.get(4)?,
                })
            })?
            .collect::<duckdb::Result<Vec<_>>>()?)
    }

    pub fn save_video_narrative(&mut self, narrative: &VideoNarrative) -> Result<(), StoreError> {
        if narrative.narrative_id.trim().is_empty()
            || narrative.episode_id.trim().is_empty()
            || narrative.revision == 0
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let transaction = self.connection.transaction()?;
        let episode_exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM video_episodes WHERE episode_id = ?)",
            params![narrative.episode_id],
            |row| row.get(0),
        )?;
        if !episode_exists {
            return Err(StoreError::InvalidVideoRecord);
        }
        let existing_episode: Option<String> = transaction
            .query_row(
                "SELECT episode_id FROM video_narratives WHERE narrative_id = ? LIMIT 1",
                params![narrative.narrative_id],
                |row| row.get(0),
            )
            .optional()?;
        if existing_episode
            .as_deref()
            .is_some_and(|episode_id| episode_id != narrative.episode_id)
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let current_revision: Option<i32> = transaction.query_row(
            "SELECT MAX(revision) FROM video_narratives WHERE narrative_id = ?",
            params![narrative.narrative_id],
            |row| row.get(0),
        )?;
        if current_revision.unwrap_or(0) != narrative.revision.saturating_sub(1) as i32 {
            return Err(StoreError::InvalidVideoRecord);
        }
        transaction.execute(
            "INSERT INTO video_narratives
                (narrative_id, episode_id, revision, summary, thesis, analysis_mode, review_status,
                 derivation_run_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                narrative.narrative_id,
                narrative.episode_id,
                narrative.revision as i32,
                narrative.summary,
                narrative.thesis,
                video_analysis_mode_as_str(narrative.analysis_mode),
                video_review_status_as_str(narrative.review_status),
                narrative.derivation_run_id,
                narrative.created_at,
                narrative.updated_at,
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn video_narrative(
        &self,
        narrative_id: &str,
    ) -> Result<Option<VideoNarrative>, StoreError> {
        self.connection
            .query_row(
                "SELECT narrative_id, episode_id, revision, summary, thesis, analysis_mode,
                        review_status, derivation_run_id, created_at, updated_at
                 FROM video_narratives WHERE narrative_id = ? ORDER BY revision DESC LIMIT 1",
                params![narrative_id],
                raw_video_narrative_from_row,
            )
            .optional()
            .map_err(StoreError::from)
    }

    pub fn video_narratives(
        &self,
        episode_id: &str,
        limit: u32,
    ) -> Result<Vec<VideoNarrative>, StoreError> {
        let ids = {
            let mut statement = self.connection.prepare(
                "SELECT narrative_id FROM video_narratives WHERE episode_id = ?
                 GROUP BY narrative_id ORDER BY MAX(revision) DESC, narrative_id LIMIT ?",
            )?;
            statement
                .query_map(params![episode_id, limit.clamp(1, 500) as i32], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<duckdb::Result<Vec<_>>>()?
        };
        ids.into_iter()
            .map(|narrative_id| {
                self.video_narrative(&narrative_id)?
                    .ok_or(StoreError::InvalidVideoRecord)
            })
            .collect()
    }

    pub fn save_video_storyboard(
        &mut self,
        storyboard: &VideoStoryboard,
    ) -> Result<(), StoreError> {
        if storyboard.storyboard_id.trim().is_empty()
            || storyboard.narrative_id.trim().is_empty()
            || storyboard.revision == 0
            || storyboard.schema_version.trim().is_empty()
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let transaction = self.connection.transaction()?;
        let narrative_exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM video_narratives WHERE narrative_id = ?)",
            params![storyboard.narrative_id],
            |row| row.get(0),
        )?;
        let existing_narrative: Option<String> = transaction
            .query_row(
                "SELECT narrative_id FROM video_storyboards WHERE storyboard_id = ? LIMIT 1",
                params![storyboard.storyboard_id],
                |row| row.get(0),
            )
            .optional()?;
        let current_revision: Option<i32> = transaction.query_row(
            "SELECT MAX(revision) FROM video_storyboards WHERE storyboard_id = ?",
            params![storyboard.storyboard_id],
            |row| row.get(0),
        )?;
        if !narrative_exists
            || existing_narrative
                .as_deref()
                .is_some_and(|narrative_id| narrative_id != storyboard.narrative_id)
            || current_revision.unwrap_or(0) != storyboard.revision.saturating_sub(1) as i32
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        transaction.execute(
            "INSERT INTO video_storyboards
                (storyboard_id, narrative_id, revision, schema_version, review_status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                storyboard.storyboard_id,
                storyboard.narrative_id,
                storyboard.revision as i32,
                storyboard.schema_version,
                video_review_status_as_str(storyboard.review_status),
                storyboard.created_at,
                storyboard.updated_at,
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn save_video_scene(&mut self, scene: &VideoScene) -> Result<(), StoreError> {
        if scene.scene_id.trim().is_empty()
            || scene.storyboard_id.trim().is_empty()
            || scene.purpose.trim().is_empty()
            || scene.revision == 0
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let transaction = self.connection.transaction()?;
        let storyboard_exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM video_storyboards WHERE storyboard_id = ?)",
            params![scene.storyboard_id],
            |row| row.get(0),
        )?;
        let existing_storyboard: Option<String> = transaction
            .query_row(
                "SELECT storyboard_id FROM video_scenes WHERE scene_id = ? LIMIT 1",
                params![scene.scene_id],
                |row| row.get(0),
            )
            .optional()?;
        let current_revision: Option<i32> = transaction.query_row(
            "SELECT MAX(revision) FROM video_scenes WHERE scene_id = ?",
            params![scene.scene_id],
            |row| row.get(0),
        )?;
        if !storyboard_exists
            || existing_storyboard
                .as_deref()
                .is_some_and(|storyboard_id| storyboard_id != scene.storyboard_id)
            || current_revision.unwrap_or(0) != scene.revision.saturating_sub(1) as i32
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        transaction.execute(
            "INSERT INTO video_scenes
                (scene_id, storyboard_id, revision, ordinal, purpose, narration_text,
                 visual_intent, duration_ms, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                scene.scene_id,
                scene.storyboard_id,
                scene.revision as i32,
                scene.ordinal as i32,
                scene.purpose,
                scene.narration_text,
                scene.visual_intent,
                scene.duration_ms.map(|value| value as i64),
                scene.created_at,
                scene.updated_at,
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    pub fn save_video_shot(&mut self, shot: &VideoShot) -> Result<(), StoreError> {
        if shot.shot_id.trim().is_empty()
            || shot.scene_id.trim().is_empty()
            || shot.shot_type.trim().is_empty()
            || shot.revision == 0
            || shot.duration_ms == 0
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        let transaction = self.connection.transaction()?;
        let scene_exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM video_scenes WHERE scene_id = ?)",
            params![shot.scene_id],
            |row| row.get(0),
        )?;
        let existing_scene: Option<String> = transaction
            .query_row(
                "SELECT scene_id FROM video_shots WHERE shot_id = ? LIMIT 1",
                params![shot.shot_id],
                |row| row.get(0),
            )
            .optional()?;
        let current_revision: Option<i32> = transaction.query_row(
            "SELECT MAX(revision) FROM video_shots WHERE shot_id = ?",
            params![shot.shot_id],
            |row| row.get(0),
        )?;
        if !scene_exists
            || existing_scene
                .as_deref()
                .is_some_and(|scene_id| scene_id != shot.scene_id)
            || current_revision.unwrap_or(0) != shot.revision.saturating_sub(1) as i32
        {
            return Err(StoreError::InvalidVideoRecord);
        }
        transaction.execute(
            "INSERT INTO video_shots
                (shot_id, scene_id, revision, ordinal, shot_type, duration_ms,
                 camera_motion, visual_prompt, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                shot.shot_id,
                shot.scene_id,
                shot.revision as i32,
                shot.ordinal as i32,
                shot.shot_type,
                shot.duration_ms as i64,
                shot.camera_motion,
                shot.visual_prompt,
                video_shot_status_as_str(shot.status),
                shot.created_at,
                shot.updated_at,
            ],
        )?;
        transaction.commit()?;
        Ok(())
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

fn raw_video_edl_revision_from_row(row: &duckdb::Row<'_>) -> duckdb::Result<VideoEdlRevision> {
    Ok(VideoEdlRevision {
        timeline_id: row.get(0)?,
        revision: row.get::<_, i32>(1)?.max(0) as u32,
        project_id: row.get(2)?,
        project_revision: row.get::<_, i32>(3)?.max(0) as u32,
        episode_id: row.get(4)?,
        episode_revision: row.get::<_, i32>(5)?.max(0) as u32,
        storyboard_id: row.get(6)?,
        storyboard_revision: row.get::<_, i32>(7)?.max(0) as u32,
        profile_id: row.get(8)?,
        profile_revision: row.get::<_, i32>(9)?.max(0) as u32,
        schema_version: row.get(10)?,
        build_version: row.get(11)?,
        build_status: row.get(12)?,
        timeline_hash: row.get(13)?,
        input_fingerprint: row.get(14)?,
        manifest_json: row.get(15)?,
        findings_json: row.get(16)?,
        created_at: row.get(17)?,
    })
}

fn video_project_status_as_str(status: VideoProjectStatus) -> &'static str {
    match status {
        VideoProjectStatus::Draft => "draft",
        VideoProjectStatus::InReview => "in_review",
        VideoProjectStatus::Ready => "ready",
        VideoProjectStatus::Rendering => "rendering",
        VideoProjectStatus::Exported => "exported",
        VideoProjectStatus::Archived => "archived",
    }
}

fn video_episode_status_as_str(status: VideoEpisodeStatus) -> &'static str {
    match status {
        VideoEpisodeStatus::Draft => "draft",
        VideoEpisodeStatus::InReview => "in_review",
        VideoEpisodeStatus::Ready => "ready",
        VideoEpisodeStatus::Archived => "archived",
    }
}

fn video_review_status_as_str(status: VideoReviewStatus) -> &'static str {
    match status {
        VideoReviewStatus::Draft => "draft",
        VideoReviewStatus::Candidate => "candidate",
        VideoReviewStatus::InReview => "in_review",
        VideoReviewStatus::Approved => "approved",
        VideoReviewStatus::Rejected => "rejected",
    }
}

fn video_analysis_mode_as_str(mode: VideoAnalysisMode) -> &'static str {
    match mode {
        VideoAnalysisMode::HumanAuthored => "human_authored",
        VideoAnalysisMode::DeterministicCandidate => "deterministic_candidate",
        VideoAnalysisMode::ModelAssisted => "model_assisted",
        VideoAnalysisMode::Mixed => "mixed",
    }
}

fn parse_video_analysis_mode(value: String) -> duckdb::Result<VideoAnalysisMode> {
    match value.as_str() {
        "human_authored" => Ok(VideoAnalysisMode::HumanAuthored),
        "deterministic_candidate" => Ok(VideoAnalysisMode::DeterministicCandidate),
        "model_assisted" => Ok(VideoAnalysisMode::ModelAssisted),
        "mixed" => Ok(VideoAnalysisMode::Mixed),
        _ => Err(duckdb::Error::ToSqlConversionFailure(Box::new(
            std::io::Error::other("invalid Video narrative analysis mode"),
        ))),
    }
}

fn parse_video_review_status(value: String) -> duckdb::Result<VideoReviewStatus> {
    match value.as_str() {
        "draft" => Ok(VideoReviewStatus::Draft),
        "candidate" => Ok(VideoReviewStatus::Candidate),
        "in_review" => Ok(VideoReviewStatus::InReview),
        "approved" => Ok(VideoReviewStatus::Approved),
        "rejected" => Ok(VideoReviewStatus::Rejected),
        _ => Err(duckdb::Error::ToSqlConversionFailure(Box::new(
            std::io::Error::other("invalid Video review status"),
        ))),
    }
}

fn video_shot_status_as_str(status: VideoShotStatus) -> &'static str {
    match status {
        VideoShotStatus::Planned => "planned",
        VideoShotStatus::Ready => "ready",
        VideoShotStatus::Rendering => "rendering",
        VideoShotStatus::Blocked => "blocked",
        VideoShotStatus::Complete => "complete",
    }
}

fn parse_video_project_status(value: String) -> duckdb::Result<VideoProjectStatus> {
    match value.as_str() {
        "draft" => Ok(VideoProjectStatus::Draft),
        "in_review" => Ok(VideoProjectStatus::InReview),
        "ready" => Ok(VideoProjectStatus::Ready),
        "rendering" => Ok(VideoProjectStatus::Rendering),
        "exported" => Ok(VideoProjectStatus::Exported),
        "archived" => Ok(VideoProjectStatus::Archived),
        _ => Err(duckdb::Error::ToSqlConversionFailure(Box::new(
            std::io::Error::other("invalid video project status"),
        ))),
    }
}

fn raw_video_project_from_row(row: &duckdb::Row<'_>) -> duckdb::Result<VideoProject> {
    Ok(VideoProject {
        project_id: row.get(0)?,
        revision: row.get::<_, i32>(1)?.max(0) as u32,
        title: row.get(2)?,
        language: row.get(3)?,
        target_platform: row.get(4)?,
        target_duration_ms: row
            .get::<_, Option<i64>>(5)?
            .map(|value| value.max(0) as u64),
        audience: row.get(6)?,
        style_profile: row.get(7)?,
        status: parse_video_project_status(row.get(8)?)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn raw_video_asset_from_row(row: &duckdb::Row<'_>) -> duckdb::Result<VideoAsset> {
    Ok(VideoAsset {
        asset_id: row.get(0)?,
        revision: row.get::<_, i32>(1)?.max(0) as u32,
        asset_kind: row.get(2)?,
        relative_path: row.get(3)?,
        mime_type: row.get(4)?,
        content_hash: row.get(5)?,
        width: row
            .get::<_, Option<i32>>(6)?
            .map(|value| value.max(0) as u32),
        height: row
            .get::<_, Option<i32>>(7)?
            .map(|value| value.max(0) as u32),
        duration_ms: row
            .get::<_, Option<i64>>(8)?
            .map(|value| value.max(0) as u64),
        provider: row.get(9)?,
        workflow_id: row.get(10)?,
        model: row.get(11)?,
        reproducibility: row.get(12)?,
        capability_state: row.get(13)?,
        license_state: row.get(14)?,
        job_id: row.get(15)?,
        created_at: row.get(16)?,
    })
}

fn raw_video_workflow_from_row(row: &duckdb::Row<'_>) -> duckdb::Result<VideoWorkflow> {
    let parameters_json: String = row.get(6)?;
    let parameters = serde_json::from_str(&parameters_json).map_err(|error| {
        duckdb::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(error.to_string())))
    })?;
    Ok(VideoWorkflow {
        workflow_id: row.get(0)?,
        revision: row.get::<_, i32>(1)?.max(0) as u32,
        capability: row.get(2)?,
        provider_adapter: row.get(3)?,
        schema_version: row.get(4)?,
        model_identity: row.get(5)?,
        parameters,
        created_at: row.get(7)?,
    })
}

fn raw_video_job_from_row(row: &duckdb::Row<'_>) -> duckdb::Result<VideoJob> {
    let parse_json = |value: Option<String>| -> duckdb::Result<Option<Value>> {
        value
            .map(|text| {
                serde_json::from_str(&text).map_err(|error| {
                    duckdb::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                        error.to_string(),
                    )))
                })
            })
            .transpose()
    };
    Ok(VideoJob {
        job_id: row.get(0)?,
        operation: row.get(1)?,
        status: row.get(2)?,
        input_revision: row
            .get::<_, Option<i32>>(3)?
            .map(|value| value.max(0) as u32),
        progress_millis: row.get::<_, i32>(4)?.max(0) as u32,
        cancellation_requested: row.get(5)?,
        resource_estimate: parse_json(row.get(6)?)?,
        output_manifest: parse_json(row.get(7)?)?,
        safe_error_message: row.get(8)?,
        started_at: row.get(9)?,
        finished_at: row.get(10)?,
        created_at: row.get(11)?,
    })
}

fn parse_video_episode_status(value: String) -> duckdb::Result<VideoEpisodeStatus> {
    match value.as_str() {
        "draft" => Ok(VideoEpisodeStatus::Draft),
        "in_review" => Ok(VideoEpisodeStatus::InReview),
        "ready" => Ok(VideoEpisodeStatus::Ready),
        "archived" => Ok(VideoEpisodeStatus::Archived),
        _ => Err(duckdb::Error::ToSqlConversionFailure(Box::new(
            std::io::Error::other("invalid video episode status"),
        ))),
    }
}

fn raw_video_episode_from_row(row: &duckdb::Row<'_>) -> duckdb::Result<VideoEpisode> {
    Ok(VideoEpisode {
        episode_id: row.get(0)?,
        project_id: row.get(1)?,
        revision: row.get::<_, i32>(2)?.max(0) as u32,
        title: row.get(3)?,
        as_of: row.get(4)?,
        disclosure: row.get(5)?,
        status: parse_video_episode_status(row.get(6)?)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn raw_video_narrative_from_row(row: &duckdb::Row<'_>) -> duckdb::Result<VideoNarrative> {
    Ok(VideoNarrative {
        narrative_id: row.get(0)?,
        episode_id: row.get(1)?,
        revision: row.get::<_, i32>(2)?.max(0) as u32,
        summary: row.get(3)?,
        thesis: row.get(4)?,
        analysis_mode: parse_video_analysis_mode(row.get(5)?)?,
        review_status: parse_video_review_status(row.get(6)?)?,
        derivation_run_id: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn video_evidence_has_complete_span(evidence: &VideoEvidenceRef) -> bool {
    matches!(
        (
            evidence.start_offset,
            evidence.end_offset,
            evidence.quote.as_deref()
        ),
        (Some(start), Some(end), Some(quote)) if start < end && !quote.trim().is_empty()
    )
}

fn validate_video_evidence(
    connection: &Connection,
    parent_id: &str,
    parent_revision: u32,
    evidence: &VideoEvidenceRef,
) -> Result<(), StoreError> {
    if parent_id.trim().is_empty()
        || parent_revision == 0
        || evidence.evidence_id.trim().is_empty()
        || !matches!(evidence.evidence_kind.as_str(), "event" | "claim")
        || (parent_id == "audio-cue"
            && evidence.evidence_kind == "event"
            && !video_evidence_has_complete_span(evidence))
        || matches!((evidence.start_offset, evidence.end_offset), (Some(start), Some(end)) if start > end)
    {
        return Err(StoreError::InvalidVideoEvidence);
    }
    let exists: bool = match evidence.evidence_kind.as_str() {
        "event" => connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM nip_events WHERE event_id = ?)",
            params![evidence.evidence_id],
            |row| row.get(0),
        )?,
        "claim" => connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM nip_claims WHERE claim_id = ?)",
            params![evidence.evidence_id],
            |row| row.get(0),
        )?,
        _ => false,
    };
    if !exists {
        return Err(StoreError::InvalidVideoEvidence);
    }
    let has_span = evidence.start_offset.is_some()
        || evidence.end_offset.is_some()
        || evidence.quote.is_some();
    if has_span {
        let (Some(start), Some(end), Some(quote)) = (
            evidence.start_offset,
            evidence.end_offset,
            evidence.quote.as_deref(),
        ) else {
            return Err(StoreError::InvalidVideoEvidence);
        };
        let (Ok(start_usize), Ok(end_usize)) = (usize::try_from(start), usize::try_from(end))
        else {
            return Err(StoreError::InvalidVideoEvidence);
        };
        let matches_retained_span = match evidence.evidence_kind.as_str() {
            "event" => {
                let source: Option<String> = connection
                    .query_row(
                        "SELECT content_text FROM nip_events WHERE event_id = ?",
                        params![evidence.evidence_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                source.is_some_and(|source| {
                    Store::unicode_character_span_matches(&source, quote, start_usize, end_usize)
                })
            }
            "claim" => {
                let mut statement = connection.prepare(
                    "SELECT e.content_text, ce.quote, ce.start_offset, ce.end_offset
                     FROM nip_claim_evidence ce
                     JOIN nip_events e ON e.event_id = ce.event_id
                     WHERE ce.claim_id = ? ORDER BY ce.event_id",
                )?;
                let rows = statement.query_map(params![evidence.evidence_id], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<i32>>(2)?,
                        row.get::<_, Option<i32>>(3)?,
                    ))
                })?;
                let mut matched = false;
                for row in rows {
                    let (source, stored_quote, stored_start, stored_end) = row?;
                    let (Some(source), Some(stored_quote), Some(stored_start), Some(stored_end)) =
                        (source, stored_quote, stored_start, stored_end)
                    else {
                        continue;
                    };
                    if stored_quote == quote
                        && usize::try_from(stored_start).ok() == Some(start_usize)
                        && usize::try_from(stored_end).ok() == Some(end_usize)
                        && Store::unicode_character_span_matches(
                            &source,
                            quote,
                            start_usize,
                            end_usize,
                        )
                    {
                        matched = true;
                        break;
                    }
                }
                matched
            }
            _ => false,
        };
        if !matches_retained_span {
            return Err(StoreError::InvalidVideoEvidence);
        }
    }
    Ok(())
}

fn agent_evidence_matches(content: &str, evidence: &ClaimEvidence) -> bool {
    let (Some(quote), Some(start), Some(end)) = (
        evidence.quote.as_deref(),
        evidence.start_offset,
        evidence.end_offset,
    ) else {
        return false;
    };
    if quote.trim().is_empty() || start >= end {
        return false;
    }
    let chars: Vec<char> = content.chars().collect();
    let (start, end) = (start as usize, end as usize);
    if end > chars.len() {
        return false;
    }
    chars[start..end].iter().collect::<String>() == quote
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
    if current_version < 11 {
        apply_migration(connection, 11, "video_workspace", MIGRATION_11)?;
        applied_any = true;
    }
    if current_version < 12 {
        apply_migration(
            connection,
            12,
            "video_visual_specs_and_exports",
            MIGRATION_12,
        )?;
        applied_any = true;
    }
    if current_version < 13 {
        apply_migration(connection, 13, "agent_narrative_graph", MIGRATION_13)?;
        applied_any = true;
    }
    if current_version < 14 {
        apply_migration(connection, 14, "video_edl", MIGRATION_14)?;
        applied_any = true;
    }
    if current_version < 15 {
        apply_migration(connection, 15, "video_qa_reports", MIGRATION_15)?;
        applied_any = true;
    }
    if current_version < 16 {
        apply_migration(connection, 16, "video_audio_cues", MIGRATION_16)?;
        applied_any = true;
    }
    if current_version < 17 {
        apply_migration(connection, 17, "video_export_producer", MIGRATION_17)?;
        applied_any = true;
    }
    if current_version < 18 {
        apply_claim_evidence_span_repair(connection)?;
        applied_any = true;
    }
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

/// Legacy bridge extractions stored quotes with no offsets (and occasionally a
/// quote whose capitalization differed from the transcript). Restore the
/// invariant that every stored quote is exactly selected by its stored span.
/// Rows whose quote cannot be located are left untouched rather than guessed.
fn apply_claim_evidence_span_repair(connection: &mut Connection) -> Result<(), StoreError> {
    let transaction = connection.transaction()?;
    let rows = {
        let mut statement = transaction.prepare(
            "SELECT ce.claim_id, ce.event_id, ce.quote, ce.start_offset, ce.end_offset, e.content_text
             FROM nip_claim_evidence ce
             JOIN nip_events e ON e.event_id = ce.event_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<i32>>(3)?,
                row.get::<_, Option<i32>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    {
        let mut update = transaction.prepare(
            "UPDATE nip_claim_evidence
             SET quote = ?, start_offset = ?, end_offset = ?
             WHERE claim_id = ? AND event_id = ?",
        )?;
        for (claim_id, event_id, quote, start, end, text) in rows {
            let (Some(quote), Some(text)) = (quote, text) else {
                continue;
            };
            if quote.trim().is_empty() {
                continue;
            }
            let Some((start_offset, end_offset, exact_quote)) =
                resolve_claim_evidence_span(&text, &quote, start, end)
            else {
                continue;
            };
            if Some(start_offset as i32) == start
                && Some(end_offset as i32) == end
                && exact_quote == quote
            {
                continue;
            }
            update.execute(params![
                exact_quote,
                start_offset as i32,
                end_offset as i32,
                claim_id,
                event_id
            ])?;
        }
    }

    transaction.execute(
        "INSERT INTO nip_schema_migrations (version, name) VALUES (?, ?)",
        params![18, "claim_evidence_spans"],
    )?;
    transaction.commit()?;
    Ok(())
}

fn resolve_claim_evidence_span(
    text: &str,
    quote: &str,
    hinted_start: Option<i32>,
    hinted_end: Option<i32>,
) -> Option<(u32, u32, String)> {
    let characters: Vec<char> = text.chars().collect();
    let quote_characters: Vec<char> = quote.chars().collect();
    if quote_characters.is_empty() || quote_characters.len() > characters.len() {
        return None;
    }

    let hinted_start = hinted_start.and_then(|value| u32::try_from(value).ok());
    let hinted_end = hinted_end.and_then(|value| u32::try_from(value).ok());
    if let (Some(start), Some(end)) = (hinted_start, hinted_end) {
        if let (Ok(start), Ok(end)) = (usize::try_from(start), usize::try_from(end)) {
            if start < end
                && end <= characters.len()
                && characters[start..end] == quote_characters[..]
            {
                return Some((start as u32, end as u32, quote.to_owned()));
            }
        }
    }

    let mut exact = characters
        .windows(quote_characters.len())
        .enumerate()
        .filter_map(|(index, window)| (window == quote_characters.as_slice()).then_some(index));
    if let Some(index) = exact.next() {
        if exact.next().is_none() {
            let end = index + quote_characters.len();
            return Some((index as u32, end as u32, quote.to_owned()));
        }
    }

    let (normalized_text, origins) = normalized_characters_with_origins(text);
    let (normalized_quote, _) = normalized_characters_with_origins(quote);
    if normalized_quote.is_empty() || normalized_quote.len() > normalized_text.len() {
        return None;
    }
    let mut fallback = normalized_text
        .windows(normalized_quote.len())
        .enumerate()
        .filter_map(|(index, window)| (window == normalized_quote.as_slice()).then_some(index));
    if let Some(index) = fallback.next() {
        if fallback.next().is_none() {
            return span_from_normalized(&characters, &origins, index, normalized_quote.len());
        }
    }

    // The provider occasionally trims or reorders a word at one end of an
    // otherwise verbatim excerpt. Accept only a long common substring so a
    // repair cannot silently attach an unrelated passage.
    let (start, _, length) = longest_common_substring(&normalized_text, &normalized_quote)?;
    if length < 30 || length * 2 < normalized_quote.len() {
        return None;
    }
    span_from_normalized(&characters, &origins, start, length)
}

fn span_from_normalized(
    characters: &[char],
    origins: &[usize],
    start: usize,
    length: usize,
) -> Option<(u32, u32, String)> {
    let last_normalized = start.checked_add(length)?.checked_sub(1)?;
    let original_start = *origins.get(start)?;
    let original_end = *origins.get(last_normalized)? + 1;
    let exact_quote = characters
        .get(original_start..original_end)?
        .iter()
        .collect::<String>();
    Some((original_start as u32, original_end as u32, exact_quote))
}

fn normalized_characters_with_origins(text: &str) -> (Vec<char>, Vec<usize>) {
    let mut normalized = Vec::new();
    let mut origins = Vec::new();
    let mut previous_whitespace = false;
    for (index, character) in text.chars().enumerate() {
        if character.is_whitespace() {
            if previous_whitespace {
                continue;
            }
            normalized.push(' ');
            origins.push(index);
            previous_whitespace = true;
        } else {
            for lowercase in character.to_lowercase() {
                normalized.push(lowercase);
                origins.push(index);
            }
            previous_whitespace = false;
        }
    }
    (normalized, origins)
}

/// Longest common substring over normalized characters. Returns the start in
/// the haystack, the start in the needle, and the length.
fn longest_common_substring(haystack: &[char], needle: &[char]) -> Option<(usize, usize, usize)> {
    if haystack.is_empty() || needle.is_empty() {
        return None;
    }
    let mut previous = vec![0_usize; needle.len() + 1];
    let mut best = (0_usize, 0_usize, 0_usize);
    for (row, character) in haystack.iter().enumerate() {
        let mut current = vec![0_usize; needle.len() + 1];
        for (column, needle_character) in needle.iter().enumerate() {
            if character == needle_character {
                let length = previous[column] + 1;
                current[column + 1] = length;
                if length > best.2 {
                    best = (row + 1 - length, column + 1 - length, length);
                }
            }
        }
        previous = current;
    }
    (best.2 > 0).then_some(best)
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

fn audio_sample_duration_matches(samples: u64, rate: u32, duration_ms: u64) -> bool {
    let denominator = u128::from(rate);
    let numerator = u128::from(samples) * 1_000;
    let measured = (numerator + denominator / 2) / denominator;
    measured.abs_diff(u128::from(duration_ms)) <= 1
}

fn valid_content_sha256(value: &str) -> bool {
    let value = value.strip_prefix("sha256:").unwrap_or(value);
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
fn valid_media_relative_path(value: &str) -> bool {
    let path = Path::new(value);
    !value.trim().is_empty()
        && !value.contains(['\\', ':', '\0'])
        && !path.is_absolute()
        && path
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
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
    fn evidence_spans_use_unicode_character_offsets() {
        let source = "Préface 🚀 — Evidence: NVIDIA’s growth.";
        let quote = "NVIDIA’s growth";
        let start = source
            .chars()
            .position(|character| character == 'N')
            .unwrap();
        let end = start + quote.chars().count();

        assert_ne!(source.find(quote).unwrap(), start);
        assert!(Store::unicode_character_span_matches(
            source, quote, start, end
        ));
        assert!(!Store::unicode_character_span_matches(
            source,
            "NVIDIA growth",
            start,
            end
        ));
        assert!(!Store::unicode_character_span_matches(
            source,
            quote,
            start,
            end + 1
        ));
    }

    #[test]
    fn legacy_claim_quotes_are_repaired_to_exact_transcript_spans() {
        let text = "He was intensely involved   in the company. The China hawks are not going to get the scenario they wanted.";
        let quote = "He was intensely involved in the company.";
        let (start, end, repaired) = resolve_claim_evidence_span(text, quote, None, None).unwrap();
        assert_eq!(repaired, "He was intensely involved   in the company.");
        assert_eq!(
            text.chars()
                .skip(start as usize)
                .take((end - start) as usize)
                .collect::<String>(),
            repaired
        );

        // A paraphrased ending still resolves to the long shared excerpt rather
        // than being left with no usable span.
        let paraphrased = "The China hawks are probably not going to get the scenario they wanted.";
        let (start, end, repaired) =
            resolve_claim_evidence_span(text, paraphrased, None, None).unwrap();
        assert!(text.contains(&repaired));
        assert!(repaired.chars().count() >= 30);
        assert_eq!(
            text.chars()
                .skip(start as usize)
                .take((end - start) as usize)
                .collect::<String>(),
            repaired
        );

        assert_eq!(
            resolve_claim_evidence_span(text, "not in this transcript", None, None),
            None
        );
    }

    #[test]
    fn persisted_event_evidence_requires_an_exact_unicode_span_when_supplied() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE nip_events (event_id VARCHAR, content_text VARCHAR);
                 INSERT INTO nip_events VALUES ('event-1', 'Préface 🚀 — NVIDIA’s outlook includes an extra week.');",
            )
            .unwrap();
        let source = "Préface 🚀 — NVIDIA’s outlook includes an extra week.";
        let quote = "NVIDIA’s outlook includes an extra week";
        let start = source
            .chars()
            .position(|character| character == 'N')
            .unwrap() as u32;
        let exact = VideoEvidenceRef {
            evidence_kind: "event".into(),
            evidence_id: "event-1".into(),
            start_offset: Some(start),
            end_offset: Some(start + quote.chars().count() as u32),
            quote: Some(quote.into()),
        };
        assert!(validate_video_evidence(&connection, "audio-cue", 1, &exact).is_ok());

        let mut altered = exact.clone();
        altered.quote = Some("NVIDIA outlook includes an extra week".into());
        assert!(validate_video_evidence(&connection, "audio-cue", 1, &altered).is_err());

        let mut partial = exact.clone();
        partial.quote = None;
        assert!(validate_video_evidence(&connection, "audio-cue", 1, &partial).is_err());

        let lineage_only = VideoEvidenceRef {
            evidence_kind: "event".into(),
            evidence_id: "event-1".into(),
            start_offset: None,
            end_offset: None,
            quote: None,
        };
        assert!(validate_video_evidence(&connection, "audio-cue", 1, &lineage_only).is_err());
        assert!(validate_video_evidence(&connection, "visual-spec", 1, &lineage_only).is_ok());
    }

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
    fn fresh_database_runs_all_migrations_and_reopen_is_idempotent() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("nip.duckdb");

        {
            let store = Store::open(&path).unwrap();
            assert_eq!(store.schema_version(), LATEST_SCHEMA_VERSION);
            assert!(store.has_table("nip_schema_migrations").unwrap());
            assert!(store.has_table("nip_sources").unwrap());
            assert!(store.has_table("nip_events").unwrap());
            assert!(store.has_table("nip_ingestion_runs").unwrap());
            assert!(store.has_table("nip_podcast_subscriptions").unwrap());
            assert!(store.has_table("nip_podcast_episodes").unwrap());
            assert!(store.has_table("video_projects").unwrap());
            assert!(store.has_table("video_episode_evidence").unwrap());
            assert!(store.has_table("video_asset_lineage").unwrap());
            assert!(store.has_table("nip_agent_narrative_analyses").unwrap());
            assert!(store.has_table("nip_agent_entity_candidates").unwrap());
        }

        let reopened = Store::open(&path).unwrap();
        assert_eq!(reopened.schema_version(), LATEST_SCHEMA_VERSION);
        let migration_count: i64 = reopened
            .connection
            .query_row("SELECT COUNT(*) FROM nip_schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(migration_count, i64::from(LATEST_SCHEMA_VERSION));
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
        assert_eq!(store.schema_version(), LATEST_SCHEMA_VERSION);
        assert!(store.has_table("nip_events").unwrap());
        assert!(store.has_table("nip_podcast_subscriptions").unwrap());
    }

    #[test]
    fn video_project_episode_and_evidence_round_trip_with_revision_guard() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        let event = store
            .import_local_event(
                &LocalEventImport {
                    source_id: SourceId::new("video-fixture").unwrap(),
                    source_display_name: "Video fixture".into(),
                    source_native_id: Some("transcript-1".into()),
                    canonical_url: None,
                    title: Some("Fixture transcript".into()),
                    content_text: "The retained transcript supports this visual.".into(),
                    published_at: None,
                    source_updated_at: None,
                    rights_statement: "User-owned synthetic fixture".into(),
                    user_confirmed_rights: true,
                },
                "2026-11-18T09:00:00Z".parse().unwrap(),
            )
            .unwrap();
        let now = "2026-11-18T09:01:00Z".parse().unwrap();
        let project = VideoProject {
            project_id: "project-1".into(),
            revision: 1,
            title: "Fixture commentary".into(),
            language: "en".into(),
            target_platform: "youtube".into(),
            target_duration_ms: Some(90_000),
            audience: Some("research analyst".into()),
            style_profile: Some("evidence_first".into()),
            status: VideoProjectStatus::Draft,
            created_at: now,
            updated_at: now,
        };
        store.save_video_project(&project).unwrap();
        assert_eq!(
            store.video_project("project-1").unwrap(),
            Some(project.clone())
        );

        let episode = VideoEpisode {
            episode_id: "episode-1".into(),
            project_id: project.project_id.clone(),
            revision: 1,
            title: Some("Fixture episode".into()),
            as_of: None,
            disclosure: Some("Synthetic fixture".into()),
            status: VideoEpisodeStatus::Draft,
            created_at: now,
            updated_at: now,
        };
        store.save_video_episode(&episode).unwrap();
        store
            .link_video_episode_evidence(
                &episode.episode_id,
                episode.revision,
                &VideoEvidenceRef {
                    evidence_kind: "event".into(),
                    evidence_id: event.event_id.as_str().into(),
                    start_offset: Some(0),
                    end_offset: Some(12),
                    quote: Some("The retained".into()),
                },
            )
            .unwrap();

        let mut revision = project;
        revision.revision = 2;
        revision.title = "Fixture commentary revised".into();
        revision.updated_at = "2026-11-18T09:02:00Z".parse().unwrap();
        store.save_video_project(&revision).unwrap();
        assert_eq!(store.video_project("project-1").unwrap(), Some(revision));

        let stale = VideoProject {
            project_id: "project-1".into(),
            revision: 2,
            title: "stale".into(),
            language: "en".into(),
            target_platform: "youtube".into(),
            target_duration_ms: None,
            audience: None,
            style_profile: None,
            status: VideoProjectStatus::Draft,
            created_at: now,
            updated_at: now,
        };
        assert!(matches!(
            store.save_video_project(&stale),
            Err(StoreError::InvalidVideoRecord)
        ));
    }

    fn deletion_fixture_project(project_id: &str, title: &str) -> VideoProject {
        let now = "2026-11-18T09:00:00Z".parse().unwrap();
        VideoProject {
            project_id: project_id.into(),
            revision: 1,
            title: title.into(),
            language: "en".into(),
            target_platform: "youtube".into(),
            target_duration_ms: Some(60_000),
            audience: None,
            style_profile: None,
            status: VideoProjectStatus::Draft,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn video_project_delete_name_mismatch_is_exact_and_non_destructive() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        let project = deletion_fixture_project("delete-mismatch", "Exact Title");
        store.save_video_project(&project).unwrap();
        let episode = VideoEpisode {
            episode_id: "delete-mismatch-episode".into(),
            project_id: project.project_id.clone(),
            revision: 1,
            title: Some("Keep this episode".into()),
            as_of: None,
            disclosure: None,
            status: VideoEpisodeStatus::Draft,
            created_at: project.created_at,
            updated_at: project.updated_at,
        };
        store.save_video_episode(&episode).unwrap();

        assert!(matches!(
            store.delete_video_project(&project.project_id, "exact title"),
            Err(StoreError::VideoProjectConfirmationMismatch)
        ));
        assert_eq!(
            store.video_project(&project.project_id).unwrap(),
            Some(project)
        );
        let episode_count: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM video_episodes WHERE project_id = ?",
                params![episode.project_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(episode_count, 1);
    }

    #[test]
    fn video_project_delete_removes_project_owned_rows_and_keeps_nip_evidence() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        let event = store
            .import_local_event(
                &LocalEventImport {
                    source_id: SourceId::new("delete-test-source").unwrap(),
                    source_display_name: "Delete test source".into(),
                    source_native_id: Some("delete-test-event".into()),
                    canonical_url: None,
                    title: Some("Canonical event".into()),
                    content_text: "Canonical event evidence remains.".into(),
                    published_at: None,
                    source_updated_at: None,
                    rights_statement: "Synthetic test fixture".into(),
                    user_confirmed_rights: true,
                },
                "2026-11-18T09:00:00Z".parse().unwrap(),
            )
            .unwrap();
        let claim_id = "delete-test-claim";
        store
            .store_claim(&ClaimRecord {
                claim_id: claim_id.into(),
                claim_text: "Canonical event evidence remains.".into(),
                speaker_or_author: None,
                confidence_millis: 900,
                extraction_run_id: "delete-test-run".into(),
                provider: "test".into(),
                model: "test-model".into(),
                prompt_version: "test-v1".into(),
                provider_kind: None,
                provider_profile_id: None,
                reasoning_effort: None,
                extracted_at: "2026-11-18T09:01:00Z".parse().unwrap(),
                evidence: vec![nip_domain::ClaimEvidence {
                    event_id: event.event_id.clone(),
                    quote: Some("Canonical event evidence remains.".into()),
                    start_offset: Some(0),
                    end_offset: Some(33),
                }],
            })
            .unwrap();

        let project = deletion_fixture_project("delete-success", "Delete me");
        store.save_video_project(&project).unwrap();
        let episode = VideoEpisode {
            episode_id: "delete-success-episode".into(),
            project_id: project.project_id.clone(),
            revision: 1,
            title: Some("Owned episode".into()),
            as_of: None,
            disclosure: None,
            status: VideoEpisodeStatus::Draft,
            created_at: project.created_at,
            updated_at: project.updated_at,
        };
        store.save_video_episode(&episode).unwrap();
        for (kind, id) in [("event", event.event_id.as_str()), ("claim", claim_id)] {
            store
                .link_video_episode_evidence(
                    &episode.episode_id,
                    episode.revision,
                    &VideoEvidenceRef {
                        evidence_kind: kind.into(),
                        evidence_id: id.into(),
                        start_offset: None,
                        end_offset: None,
                        quote: None,
                    },
                )
                .unwrap();
        }
        store
            .connection
            .execute_batch(
                "INSERT INTO video_narratives VALUES ('delete-success-narrative','delete-success-episode',1,'Summary','Thesis','human_authored','approved',NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
                 INSERT INTO video_storyboards VALUES ('delete-success-storyboard','delete-success-narrative',1,'v1','approved',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
                 INSERT INTO video_scenes VALUES ('delete-success-scene','delete-success-storyboard',1,0,'purpose','narration','visual',1000,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
                 INSERT INTO video_shots VALUES ('delete-success-shot','delete-success-scene',1,0,'broll',1000,NULL,NULL,'ready',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
                 INSERT INTO video_narrative_evidence VALUES ('delete-success-narrative',1,'claim','delete-test-claim',-1,-1,NULL,CURRENT_TIMESTAMP);
                 INSERT INTO video_scene_evidence VALUES ('delete-success-scene',1,'event','delete-test-event',-1,-1,NULL,CURRENT_TIMESTAMP);
                 INSERT INTO video_shot_evidence VALUES ('delete-success-shot',1,'claim','delete-test-claim',-1,-1,NULL,CURRENT_TIMESTAMP);
                 INSERT INTO video_visual_specs VALUES ('delete-success-spec',1,'v1','delete-success','delete-success-episode','delete-success-scene','delete-success-shot','evidence_card','{}',TRUE,CURRENT_TIMESTAMP);
                 INSERT INTO video_visual_spec_sources VALUES ('delete-success-spec',1,'claim','delete-test-claim',-1,-1,-1,NULL);
                 INSERT INTO video_export_manifests VALUES ('delete-success-manifest','v1','delete-success',1,'delete-success-episode','delete-success-storyboard','storyboard',TRUE,'{}',NULL,CURRENT_TIMESTAMP);
                 INSERT INTO video_export_manifest_files VALUES ('delete-success-manifest','export.json','json',NULL,2,'application/json',NULL,NULL,NULL);
                 INSERT INTO video_export_manifest_evidence VALUES ('delete-success-manifest','event','delete-test-event',-1,-1);
                 INSERT INTO video_qa_reports VALUES ('delete-success-qa','delete-success',1,'passed','[]',CURRENT_TIMESTAMP);
                 INSERT INTO video_timelines VALUES ('delete-success-timeline','delete-success',1,'{}',1,CURRENT_TIMESTAMP);
                 INSERT INTO video_audio_cues VALUES ('delete-success-cue',1,'delete-success',1,'delete-success-episode',1,'delete-success-storyboard',1,'delete-success-scene',1,'delete-global-asset',1,'{}',CURRENT_TIMESTAMP);
                 INSERT INTO video_assets VALUES ('delete-global-asset',1,'audio',NULL,NULL,NULL,NULL,NULL,NULL,'test',NULL,NULL,'fixture','ready','test',NULL,CURRENT_TIMESTAMP);
                 INSERT INTO video_asset_lineage VALUES ('delete-global-asset',1,'event','delete-test-event',NULL,'evidence',NULL,CURRENT_TIMESTAMP);
                 INSERT INTO video_asset_lineage VALUES ('delete-global-asset',1,'shot','delete-success-shot',1,'derived',NULL,CURRENT_TIMESTAMP);
                 INSERT INTO video_shot_assets VALUES ('delete-success-shot',1,'delete-global-asset',1,'selected',CURRENT_TIMESTAMP);",
            )
            .unwrap();

        let result = store
            .delete_video_project(&project.project_id, "Delete me")
            .unwrap();
        assert!(result.deleted);
        assert!(result.retained_global_media_and_job_history);
        assert!(result.retention_note.contains("video_assets"));
        assert_eq!(store.video_project(&project.project_id).unwrap(), None);
        for table in [
            "video_projects",
            "video_project_heads",
            "video_episodes",
            "video_episode_heads",
            "video_episode_evidence",
            "video_narratives",
            "video_narrative_evidence",
            "video_storyboards",
            "video_scenes",
            "video_scene_evidence",
            "video_shots",
            "video_shot_evidence",
            "video_shot_assets",
            "video_visual_specs",
            "video_visual_spec_sources",
            "video_export_manifests",
            "video_export_manifest_files",
            "video_export_manifest_evidence",
            "video_qa_reports",
            "video_timelines",
            "video_audio_cues",
        ] {
            let count: i64 = store
                .connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "expected {table} to be empty after deletion");
        }
        let canonical_counts: (i64, i64, i64) = store
            .connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM nip_events),
                        (SELECT COUNT(*) FROM nip_claims),
                        (SELECT COUNT(*) FROM nip_claim_evidence)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(canonical_counts, (1, 1, 1));
        let retained_asset: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM video_assets WHERE asset_id='delete-global-asset'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained_asset, 1);
        let retained_event_lineage: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM video_asset_lineage WHERE asset_id='delete-global-asset' AND upstream_kind='event'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained_event_lineage, 1);
        let removed_project_lineage: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM video_asset_lineage WHERE asset_id='delete-global-asset' AND upstream_kind='shot'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(removed_project_lineage, 0);
        assert!(store.event(event.event_id.as_str()).unwrap().is_some());
        assert_eq!(store.claims().unwrap().len(), 1);
    }

    #[test]
    fn video_evidence_rejects_unknown_canonical_records() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        let now = "2026-11-18T09:00:00Z".parse().unwrap();
        let project = VideoProject {
            project_id: "project-unknown".into(),
            revision: 1,
            title: "Unknown evidence".into(),
            language: "en".into(),
            target_platform: "local".into(),
            target_duration_ms: None,
            audience: None,
            style_profile: None,
            status: VideoProjectStatus::Draft,
            created_at: now,
            updated_at: now,
        };
        store.save_video_project(&project).unwrap();
        let episode = VideoEpisode {
            episode_id: "episode-unknown".into(),
            project_id: project.project_id,
            revision: 1,
            title: None,
            as_of: None,
            disclosure: None,
            status: VideoEpisodeStatus::Draft,
            created_at: now,
            updated_at: now,
        };
        store.save_video_episode(&episode).unwrap();
        let error = store
            .link_video_episode_evidence(
                &episode.episode_id,
                1,
                &VideoEvidenceRef {
                    evidence_kind: "event".into(),
                    evidence_id: "event-does-not-exist".into(),
                    start_offset: None,
                    end_offset: None,
                    quote: None,
                },
            )
            .unwrap_err();
        assert!(matches!(error, StoreError::InvalidVideoEvidence));
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
                supported: LATEST_SCHEMA_VERSION
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
        assert_eq!(
            updated.locator.as_deref(),
            Some("https://example.invalid/q3-earnings")
        );
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

        let registry = store
            .source(&SourceId::new("feed-a").unwrap())
            .unwrap()
            .unwrap();
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
        let registry = store
            .source(&SourceId::new("feed-a").unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(
            registry.locator.as_deref(),
            Some("https://example.invalid/feed.xml")
        );
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

    #[test]
    fn video_jobs_persist_progress_cancel_retry_payload_and_restart_recovery() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        let now = "2026-11-18T09:00:00Z".parse().unwrap();
        let spec = serde_json::json!({"scene_id": "fixture-scene", "visual_kind": "evidence_card"});
        let mut job = VideoJob {
            job_id: "video-job-1".into(),
            operation: "linkzag.segment".into(),
            status: "queued".into(),
            input_revision: Some(1),
            progress_millis: 0,
            cancellation_requested: false,
            resource_estimate: Some(spec.clone()),
            output_manifest: None,
            safe_error_message: None,
            started_at: None,
            finished_at: None,
            created_at: now,
        };
        store.save_video_job(&job).unwrap();
        job.status = "running".into();
        job.progress_millis = 42_000;
        job.cancellation_requested = true;
        job.started_at = Some(now);
        store.save_video_job(&job).unwrap();
        let loaded = store.video_job("video-job-1").unwrap().unwrap();
        assert_eq!(loaded.progress_millis, 42_000);
        assert!(loaded.cancellation_requested);
        assert_eq!(loaded.resource_estimate, Some(spec.clone()));

        let recovered = store.recover_video_jobs().unwrap();
        let loaded = recovered
            .into_iter()
            .find(|item| item.job_id == "video-job-1")
            .unwrap();
        assert_eq!(loaded.status, "failed");
        assert_eq!(
            loaded.safe_error_message.as_deref(),
            Some("job interrupted by service restart")
        );

        let retry = VideoJob {
            job_id: "video-job-1-retry-1".into(),
            operation: loaded.operation,
            status: "queued".into(),
            input_revision: loaded.input_revision,
            progress_millis: 0,
            cancellation_requested: false,
            resource_estimate: loaded.resource_estimate,
            output_manifest: None,
            safe_error_message: None,
            started_at: None,
            finished_at: None,
            created_at: now,
        };
        store.save_video_job(&retry).unwrap();
        assert_eq!(
            store
                .video_job("video-job-1-retry-1")
                .unwrap()
                .unwrap()
                .resource_estimate,
            Some(spec)
        );
        let mut old = retry;
        old.job_id = "video-job-old".into();
        old.status = "failed".into();
        old.finished_at = Some("2020-01-01T00:00:00Z".parse().unwrap());
        store.save_video_job(&old).unwrap();
        assert_eq!(
            store
                .cleanup_video_jobs("2021-01-01T00:00:00Z".parse().unwrap())
                .unwrap(),
            1
        );
        assert!(store.video_job("video-job-old").unwrap().is_none());
        assert!(store.video_job("video-job-1-retry-1").unwrap().is_some());
    }

    #[test]
    fn active_video_render_is_recovered_after_simulated_service_restart() {
        let temp = tempdir().unwrap();
        let database = temp.path().join("nip.duckdb");
        {
            let mut store = Store::open(&database).unwrap();
            store
                .save_video_job(&VideoJob {
                    job_id: "video-restart-active".into(),
                    operation: "linkzag.segment".into(),
                    status: "running".into(),
                    input_revision: Some(7),
                    progress_millis: 58_000,
                    cancellation_requested: false,
                    resource_estimate: Some(serde_json::json!({"scene_id": "restart-scene"})),
                    output_manifest: None,
                    safe_error_message: None,
                    started_at: Some("2026-11-18T09:00:01Z".parse().unwrap()),
                    finished_at: None,
                    created_at: "2026-11-18T09:00:00Z".parse().unwrap(),
                })
                .unwrap();
        }
        let mut reopened = Store::open(&database).unwrap();
        let recovered = reopened.recover_video_jobs().unwrap();
        let job = recovered
            .into_iter()
            .find(|item| item.job_id == "video-restart-active")
            .unwrap();
        assert_eq!(job.status, "failed");
        assert_eq!(job.progress_millis, 58_000);
        assert_eq!(job.input_revision, Some(7));
        assert_eq!(
            job.safe_error_message.as_deref(),
            Some("job interrupted by service restart")
        );
    }
    #[test]
    fn visual_specs_and_export_manifests_round_trip_with_lineage() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        let event = store
            .import_local_event(
                &LocalEventImport {
                    source_id: SourceId::new("visual-spec-source").unwrap(),
                    source_display_name: "Visual spec fixture".into(),
                    source_native_id: Some("visual-spec-event".into()),
                    canonical_url: None,
                    title: Some("Policy outlook".into()),
                    content_text: "Rates remain restrictive.".into(),
                    published_at: None,
                    source_updated_at: None,
                    rights_statement: "synthetic".into(),
                    user_confirmed_rights: true,
                },
                "2026-11-18T09:00:00Z".parse().unwrap(),
            )
            .unwrap();
        let now = "2026-11-18T09:01:00Z".parse().unwrap();
        let spec = VideoVisualSpec {
            spec_id: "visual-spec-1".into(),
            revision: 1,
            schema_version: "video-visual-spec-v1".into(),
            project_id: "project-1".into(),
            episode_id: "episode-1".into(),
            scene_id: Some("scene-1".into()),
            shot_id: Some("shot-1".into()),
            template: nip_domain::VideoVisualTemplate::EvidenceCard,
            duration_ms: 12_000,
            width: 1280,
            height: 720,
            fps: 30,
            payload: nip_domain::VideoVisualPayload::EvidenceCard {
                title: "Policy outlook".into(),
                body: "Rates remain restrictive.".into(),
                disclosure: Some("Synthetic fixture".into()),
            },
            sources: vec![VideoVisualSource {
                source_kind: VideoVisualSourceKind::Event,
                source_id: event.event_id.as_str().into(),
                source_revision: None,
                start_offset: Some(0),
                end_offset: Some(25),
                quote: Some("Rates remain restrictive.".into()),
            }],
            deterministic: true,
            created_at: now,
        };
        store.save_video_visual_spec(&spec).unwrap();
        let loaded = store
            .video_visual_spec("visual-spec-1", 1)
            .unwrap()
            .unwrap();
        assert_eq!(loaded, spec);
        assert!(matches!(
            store.save_video_visual_spec(&spec),
            Err(StoreError::InvalidVideoRecord)
        ));
        let manifest = VideoExportManifest {
            manifest_id: "manifest-1".into(),
            schema_version: "video-export-manifest-v1".into(),
            project_id: "project-1".into(),
            project_revision: 1,
            episode_id: Some("episode-1".into()),
            storyboard_id: Some("storyboard-1".into()),
            export_kind: nip_domain::VideoExportKind::LinkZagScene,
            deterministic: true,
            visual_spec_ids: vec!["visual-spec-1".into()],
            asset_ids: vec!["asset-1".into()],
            files: vec![VideoExportFile {
                relative_path: "segments/scene-1/segment.json".into(),
                format: "json".into(),
                content_hash: Some("sha256:fixture".into()),
                byte_size: Some(512),
                mime_type: Some("application/json".into()),
                width: None,
                height: None,
                duration_ms: None,
            }],
            evidence: vec![VideoEvidenceRef {
                evidence_kind: "event".into(),
                evidence_id: event.event_id.as_str().into(),
                start_offset: None,
                end_offset: None,
                quote: None,
            }],
            content_hash: Some("sha256:manifest".into()),
            created_at: now,
        };
        store.save_video_export_manifest(&manifest).unwrap();
        let loaded_manifest = store.video_export_manifest("manifest-1").unwrap().unwrap();
        assert_eq!(loaded_manifest, manifest);
        assert_eq!(store.video_visual_specs(10).unwrap().len(), 1);
        assert_eq!(store.video_export_manifests(10).unwrap().len(), 1);
    }

    #[test]
    fn video_qa_reports_and_timeline_edl_round_trip_with_revision_guards() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        let now = "2026-11-18T09:01:00Z".parse().unwrap();
        let project = VideoProject {
            project_id: "qa-project".into(),
            revision: 1,
            title: "Synthetic QA fixture".into(),
            language: "en".into(),
            target_platform: "internal_review".into(),
            target_duration_ms: Some(30_000),
            audience: Some("test".into()),
            style_profile: Some("evidence_first".into()),
            status: VideoProjectStatus::Draft,
            created_at: now,
            updated_at: now,
        };
        store.save_video_project(&project).unwrap();
        let episode = VideoEpisode {
            episode_id: "qa-episode".into(),
            project_id: project.project_id.clone(),
            revision: 1,
            title: Some("Synthetic QA fixture episode".into()),
            as_of: None,
            disclosure: Some("Fixture only".into()),
            status: VideoEpisodeStatus::Draft,
            created_at: now,
            updated_at: now,
        };
        store.save_video_episode(&episode).unwrap();
        let narrative = VideoNarrative {
            narrative_id: "qa-narrative".into(),
            episode_id: episode.episode_id.clone(),
            revision: 1,
            summary: Some("Evidence-first test narrative".into()),
            thesis: None,
            analysis_mode: VideoAnalysisMode::DeterministicCandidate,
            review_status: VideoReviewStatus::Candidate,
            derivation_run_id: None,
            created_at: now,
            updated_at: now,
        };
        store.save_video_narrative(&narrative).unwrap();
        assert_eq!(
            store.video_narrative("qa-narrative").unwrap(),
            Some(narrative.clone())
        );
        assert_eq!(
            store.video_narratives("qa-episode", 10).unwrap(),
            vec![narrative.clone()]
        );
        store
            .save_video_storyboard(&VideoStoryboard {
                storyboard_id: "qa-storyboard".into(),
                narrative_id: "qa-narrative".into(),
                revision: 1,
                schema_version: "video-storyboard-v1".into(),
                review_status: VideoReviewStatus::Draft,
                created_at: now,
                updated_at: now,
            })
            .unwrap();
        store
            .save_video_scene(&VideoScene {
                scene_id: "qa-scene".into(),
                storyboard_id: "qa-storyboard".into(),
                revision: 1,
                ordinal: 0,
                purpose: "Fixture scene".into(),
                narration_text: None,
                visual_intent: Some("evidence_card".into()),
                duration_ms: Some(10_000),
                created_at: now,
                updated_at: now,
            })
            .unwrap();
        store
            .save_video_shot(&VideoShot {
                shot_id: "qa-shot".into(),
                scene_id: "qa-scene".into(),
                revision: 1,
                ordinal: 0,
                shot_type: "evidence_card".into(),
                duration_ms: 10_000,
                camera_motion: Some("static".into()),
                visual_prompt: None,
                status: VideoShotStatus::Ready,
                created_at: now,
                updated_at: now,
            })
            .unwrap();

        let report = VideoQaReport {
            report_id: "qa-report-1".into(),
            project_id: project.project_id.clone(),
            input_revision: 1,
            status: VideoQaStatus::Warning,
            findings: vec![VideoQaFinding {
                code: "missing_media".into(),
                severity: VideoQaSeverity::Advisory,
                message: "A fixture asset has not been selected yet.".into(),
                subject_id: Some("qa-shot".into()),
                evidence: vec![],
            }],
            created_at: now,
        };
        store.save_video_qa_report(&report).unwrap();
        assert_eq!(
            store.video_qa_report("qa-report-1").unwrap(),
            Some(report.clone())
        );
        assert_eq!(
            store.video_qa_reports("qa-project", 10).unwrap(),
            vec![report.clone()]
        );

        let invalid_report = VideoQaReport {
            report_id: "qa-report-invalid".into(),
            status: VideoQaStatus::Passed,
            ..report.clone()
        };
        assert!(matches!(
            store.save_video_qa_report(&invalid_report),
            Err(StoreError::InvalidVideoRecord)
        ));

        let timeline = VideoTimeline {
            timeline_id: "timeline-1".into(),
            project_id: project.project_id.clone(),
            revision: 1,
            input_revision: 1,
            export_revision: 1,
            clips: vec![nip_domain::VideoTimelineClip {
                shot_id: "qa-shot".into(),
                shot_revision: 1,
                asset_id: None,
                asset_revision: None,
                start_ms: 0,
                duration_ms: 10_000,
                evidence: vec![],
            }],
            total_duration_ms: 10_000,
            deterministic: true,
            created_at: now,
        };
        store.save_video_timeline(&timeline).unwrap();
        assert_eq!(
            store.video_timeline("timeline-1", 1).unwrap(),
            Some(timeline.clone())
        );
        assert_eq!(
            store.video_timelines("qa-project", 10).unwrap(),
            vec![timeline.clone()]
        );

        let other_project = VideoProject {
            project_id: "other-project".into(),
            ..project.clone()
        };
        store.save_video_project(&other_project).unwrap();
        let other_episode = VideoEpisode {
            episode_id: "other-episode".into(),
            project_id: other_project.project_id.clone(),
            created_at: now,
            updated_at: now,
            ..episode.clone()
        };
        store.save_video_episode(&other_episode).unwrap();
        let repointed_episode = VideoEpisode {
            revision: 2,
            project_id: other_project.project_id.clone(),
            ..episode.clone()
        };
        assert!(matches!(
            store.save_video_episode(&repointed_episode),
            Err(StoreError::InvalidVideoRecord)
        ));
        let repointed_narrative = VideoNarrative {
            revision: 2,
            episode_id: other_episode.episode_id.clone(),
            ..narrative.clone()
        };
        assert!(matches!(
            store.save_video_narrative(&repointed_narrative),
            Err(StoreError::InvalidVideoRecord)
        ));
        let other_narrative = VideoNarrative {
            narrative_id: "other-narrative".into(),
            episode_id: other_episode.episode_id.clone(),
            created_at: now,
            updated_at: now,
            ..narrative.clone()
        };
        store.save_video_narrative(&other_narrative).unwrap();
        store
            .save_video_storyboard(&VideoStoryboard {
                storyboard_id: "other-storyboard".into(),
                narrative_id: other_narrative.narrative_id,
                revision: 1,
                schema_version: "video-storyboard-v1".into(),
                review_status: VideoReviewStatus::Draft,
                created_at: now,
                updated_at: now,
            })
            .unwrap();
        store
            .save_video_scene(&VideoScene {
                scene_id: "other-scene".into(),
                storyboard_id: "other-storyboard".into(),
                revision: 1,
                ordinal: 0,
                purpose: "Other project scene".into(),
                narration_text: None,
                visual_intent: None,
                duration_ms: Some(10_000),
                created_at: now,
                updated_at: now,
            })
            .unwrap();
        store
            .save_video_shot(&VideoShot {
                shot_id: "other-shot".into(),
                scene_id: "other-scene".into(),
                revision: 1,
                ordinal: 0,
                shot_type: "evidence_card".into(),
                duration_ms: 10_000,
                camera_motion: None,
                visual_prompt: None,
                status: VideoShotStatus::Ready,
                created_at: now,
                updated_at: now,
            })
            .unwrap();
        let cross_project_timeline = VideoTimeline {
            timeline_id: "cross-project-timeline".into(),
            clips: vec![nip_domain::VideoTimelineClip {
                shot_id: "other-shot".into(),
                shot_revision: 1,
                asset_id: None,
                asset_revision: None,
                start_ms: 0,
                duration_ms: 10_000,
                evidence: vec![],
            }],
            ..timeline.clone()
        };
        assert!(matches!(
            store.save_video_timeline(&cross_project_timeline),
            Err(StoreError::InvalidVideoRecord)
        ));
        assert!(matches!(
            store.save_video_timeline(&timeline),
            Err(StoreError::InvalidVideoRecord)
        ));
        let invalid_timeline = VideoTimeline {
            revision: 2,
            total_duration_ms: 9_999,
            ..timeline
        };
        assert!(matches!(
            store.save_video_timeline(&invalid_timeline),
            Err(StoreError::InvalidVideoRecord)
        ));
    }

    #[test]
    fn video_asset_lineage_round_trips_idempotently_and_rejects_cycles() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        let now = "2026-11-18T09:01:00Z".parse().unwrap();
        let event = store
            .import_local_event(
                &LocalEventImport {
                    source_id: SourceId::new("lineage-source").unwrap(),
                    source_display_name: "Lineage fixture".into(),
                    source_native_id: Some("retained-event".into()),
                    canonical_url: None,
                    title: Some("Retained fixture".into()),
                    content_text: "Synthetic retained source for asset lineage.".into(),
                    published_at: None,
                    source_updated_at: None,
                    rights_statement: "User-owned synthetic fixture".into(),
                    user_confirmed_rights: true,
                },
                now,
            )
            .unwrap();
        let asset = |asset_id: &str| VideoAsset {
            asset_id: asset_id.into(),
            revision: 1,
            asset_kind: "fixture".into(),
            relative_path: None,
            mime_type: Some("video/mp4".into()),
            content_hash: Some("sha256:fixture".into()),
            width: Some(1280),
            height: Some(720),
            duration_ms: Some(1_000),
            provider: "test".into(),
            workflow_id: None,
            model: None,
            reproducibility: "fixture".into(),
            capability_state: "ready".into(),
            license_state: "fixture_only".into(),
            job_id: None,
            created_at: now,
        };
        store.save_video_asset(&asset("source-asset")).unwrap();
        store.save_video_asset(&asset("derived-asset")).unwrap();
        let lineage = VideoAssetLineage {
            asset_id: "derived-asset".into(),
            asset_revision: 1,
            upstream_kind: VideoAssetUpstreamKind::Asset,
            upstream_id: "source-asset".into(),
            upstream_revision: Some(1),
            relationship: "derived_from".into(),
            input_hash: Some("sha256:source-fixture".into()),
            created_at: now,
        };
        store.save_video_asset_lineage(&lineage).unwrap();
        store.save_video_asset_lineage(&lineage).unwrap();
        assert_eq!(
            store.video_asset_lineage("derived-asset", 1).unwrap(),
            vec![lineage.clone()]
        );
        assert!(store
            .video_asset_lineage("derived-asset", 2)
            .unwrap()
            .is_empty());

        let event_lineage = VideoAssetLineage {
            upstream_kind: VideoAssetUpstreamKind::Event,
            upstream_id: event.event_id.as_str().into(),
            upstream_revision: None,
            relationship: "source_evidence".into(),
            input_hash: None,
            ..lineage.clone()
        };
        store.save_video_asset_lineage(&event_lineage).unwrap();
        assert_eq!(
            store.video_asset_lineage("derived-asset", 1).unwrap(),
            vec![lineage.clone(), event_lineage.clone()]
        );
        let missing_event = VideoAssetLineage {
            upstream_id: "event-not-in-nip".into(),
            relationship: "unverified_source".into(),
            ..event_lineage
        };
        assert!(matches!(
            store.save_video_asset_lineage(&missing_event),
            Err(StoreError::InvalidVideoEvidence)
        ));

        let missing_source = VideoAssetLineage {
            upstream_id: "missing-asset".into(),
            relationship: "derived_from_missing".into(),
            ..lineage.clone()
        };
        assert!(matches!(
            store.save_video_asset_lineage(&missing_source),
            Err(StoreError::InvalidVideoRecord)
        ));

        let cycle = VideoAssetLineage {
            asset_id: "source-asset".into(),
            upstream_id: "derived-asset".into(),
            relationship: "cycle".into(),
            ..lineage
        };
        assert!(matches!(
            store.save_video_asset_lineage(&cycle),
            Err(StoreError::InvalidVideoRecord)
        ));

        let atomic_asset = asset("atomic-asset");
        let atomic_lineage = VideoAssetLineage {
            asset_id: atomic_asset.asset_id.clone(),
            asset_revision: atomic_asset.revision,
            upstream_kind: VideoAssetUpstreamKind::Asset,
            upstream_id: "source-asset".into(),
            upstream_revision: Some(1),
            relationship: "derived_from".into(),
            input_hash: None,
            created_at: now,
        };
        store
            .save_video_asset_with_lineage(&atomic_asset, std::slice::from_ref(&atomic_lineage))
            .unwrap();
        assert_eq!(
            store.video_asset_lineage("atomic-asset", 1).unwrap(),
            vec![atomic_lineage.clone()]
        );

        let rejected_asset = asset("rejected-atomic-asset");
        let invalid_lineage = VideoAssetLineage {
            asset_id: rejected_asset.asset_id.clone(),
            upstream_id: "missing-asset".into(),
            ..atomic_lineage
        };
        assert!(matches!(
            store.save_video_asset_with_lineage(&rejected_asset, &[invalid_lineage]),
            Err(StoreError::InvalidVideoRecord)
        ));
        assert!(!store
            .video_assets(50)
            .unwrap()
            .iter()
            .any(|item| item.asset_id == "rejected-atomic-asset"));
    }

    #[test]
    fn export_commit_materializes_typed_lineage_and_rolls_back_invalid_refs() {
        let temp = tempdir().unwrap();
        let mut store = Store::open(temp.path().join("nip.duckdb")).unwrap();
        let now = "2026-11-18T09:01:00Z".parse().unwrap();
        let npr_event = store
            .import_local_event(
                &LocalEventImport {
                    source_id: SourceId::new("export-npr-source").unwrap(),
                    source_display_name: "NPR export-lineage fixture".into(),
                    source_native_id: Some("npr-export-1".into()),
                    canonical_url: None,
                    title: Some("NPR source".into()),
                    content_text: "The board accepted the resignation.".into(),
                    published_at: None,
                    source_updated_at: None,
                    rights_statement: "Synthetic test fixture".into(),
                    user_confirmed_rights: true,
                },
                now,
            )
            .unwrap();
        let nvidia_event = store
            .import_local_event(
                &LocalEventImport {
                    source_id: SourceId::new("export-nvidia-source").unwrap(),
                    source_display_name: "NVIDIA export-lineage fixture".into(),
                    source_native_id: Some("nvidia-export-1".into()),
                    canonical_url: None,
                    title: Some("NVIDIA source".into()),
                    content_text: "Quarter revenue rose.".into(),
                    published_at: None,
                    source_updated_at: None,
                    rights_statement: "Synthetic test fixture".into(),
                    user_confirmed_rights: true,
                },
                now,
            )
            .unwrap();
        let quote = "Quarter revenue rose.";
        store
            .store_claim(&nip_domain::ClaimRecord {
                claim_id: "claim-export-lineage".into(),
                claim_text: quote.into(),
                speaker_or_author: None,
                confidence_millis: 900,
                extraction_run_id: "run-export-lineage".into(),
                provider: "test".into(),
                model: "test".into(),
                prompt_version: "test".into(),
                provider_kind: None,
                provider_profile_id: None,
                reasoning_effort: None,
                extracted_at: now,
                evidence: vec![nip_domain::ClaimEvidence {
                    event_id: nvidia_event.event_id.clone(),
                    quote: Some(quote.into()),
                    start_offset: Some(0),
                    end_offset: Some(quote.chars().count() as u32),
                }],
            })
            .unwrap();

        let make_asset = |asset_id: &str,
                          content_hash: &str,
                          license_state: &str,
                          job_id: Option<&str>| VideoAsset {
            asset_id: asset_id.into(),
            revision: 1,
            asset_kind: "commentary_video".into(),
            relative_path: Some(format!("video/{asset_id}.mp4")),
            mime_type: Some("video/mp4".into()),
            content_hash: Some(content_hash.into()),
            width: Some(1280),
            height: Some(720),
            duration_ms: Some(52_600),
            provider: "fina-export-test".into(),
            workflow_id: Some("fina-export-test-v1".into()),
            model: None,
            reproducibility: "deterministic".into(),
            capability_state: "ready".into(),
            license_state: license_state.into(),
            job_id: job_id.map(str::to_owned),
            created_at: now,
        };
        let source_asset = make_asset("source-visual-asset", "sha256:source", "fixture_only", None);
        store.save_video_asset(&source_asset).unwrap();

        let make_manifest =
            |manifest_id: &str,
             output_id: &str,
             output_hash: &str,
             lineage_refs: Vec<nip_domain::VideoExportLineageRefV1>| {
                nip_domain::VideoExportManifestV1 {
                    manifest_ref: nip_domain::VideoExportRef {
                        id: manifest_id.into(),
                        revision: 1,
                    },
                    state: "succeeded".into(),
                    project_ref: nip_domain::VideoExportRef {
                        id: "project-export-test".into(),
                        revision: 1,
                    },
                    episode_ref: nip_domain::VideoExportRef {
                        id: "episode-export-test".into(),
                        revision: 1,
                    },
                    timeline_ref: nip_domain::VideoExportRef {
                        id: "timeline-export-test".into(),
                        revision: 1,
                    },
                    timeline_hash: "sha256:timeline".into(),
                    qa_report_ref: nip_domain::VideoExportRef {
                        id: "qa-export-test".into(),
                        revision: 1,
                    },
                    qa_input_fingerprint: "sha256:qa-input".into(),
                    export_profile_ref: nip_domain::VideoExportRef {
                        id: "mp4-h264-720p30-preview-v1".into(),
                        revision: 1,
                    },
                    input_fingerprint: "sha256:export-input".into(),
                    output_asset_ref: nip_domain::VideoExportRef {
                        id: output_id.into(),
                        revision: 1,
                    },
                    output_sha256: output_hash.into(),
                    probe: nip_domain::VideoExportProbeV1 {
                        container: "mp4".into(),
                        video_codec: "h264".into(),
                        audio_codec: Some("aac".into()),
                        width: 1280,
                        height: 720,
                        frame_rate_num: 30,
                        frame_rate_den: 1,
                        duration_ms: 52_600,
                        byte_size: 128,
                        has_audio: true,
                        has_captions: false,
                    },
                    files: vec![nip_domain::VideoExportManifestFileV1 {
                        kind: "master".into(),
                        asset_ref: nip_domain::VideoExportRef {
                            id: output_id.into(),
                            revision: 1,
                        },
                        sha256: output_hash.into(),
                    }],
                    toolchain: nip_domain::VideoExportToolchainV1 {
                        ffmpeg_version: "ffmpeg-test".into(),
                        ffprobe_version: "ffprobe-test".into(),
                        compiler_version: "fina-video-export-producer-test".into(),
                    },
                    deterministic: true,
                    preview_only: true,
                    lineage_refs,
                    created_at: now,
                }
            };
        let make_job = |job_id: &str, status: &str, progress_millis: u32| VideoJob {
            job_id: job_id.into(),
            operation: "video.export.ffmpeg".into(),
            status: status.into(),
            input_revision: Some(1),
            progress_millis,
            cancellation_requested: false,
            resource_estimate: None,
            output_manifest: None,
            safe_error_message: None,
            started_at: None,
            finished_at: None,
            created_at: now,
        };

        let refs = vec![
            nip_domain::VideoExportLineageRefV1 {
                kind: "asset".into(),
                id: source_asset.asset_id.clone(),
                revision: Some(1),
            },
            nip_domain::VideoExportLineageRefV1 {
                kind: "event".into(),
                id: npr_event.event_id.as_str().into(),
                revision: None,
            },
            nip_domain::VideoExportLineageRefV1 {
                kind: "event".into(),
                id: nvidia_event.event_id.as_str().into(),
                revision: None,
            },
            nip_domain::VideoExportLineageRefV1 {
                kind: "claim".into(),
                id: "claim-export-lineage".into(),
                revision: None,
            },
            nip_domain::VideoExportLineageRefV1 {
                kind: "audio_cue".into(),
                id: "cue-export-test".into(),
                revision: Some(1),
            },
            nip_domain::VideoExportLineageRefV1 {
                kind: "timeline".into(),
                id: "timeline-export-test".into(),
                revision: Some(1),
            },
        ];
        let queued_job = make_job("job-export-valid", "queued", 0);
        store
            .create_video_export_job("request-export-valid", "sha256:request-valid", &queued_job)
            .unwrap();
        let finished_job = VideoJob {
            status: "succeeded".into(),
            progress_millis: 100_000,
            started_at: Some(now),
            finished_at: Some(now),
            ..queued_job.clone()
        };
        let output_asset = make_asset(
            "export-output-valid",
            "sha256:output-valid",
            "internal_review_only",
            Some("job-export-valid"),
        );
        let manifest = make_manifest(
            "manifest-export-valid",
            &output_asset.asset_id,
            "sha256:output-valid",
            refs.clone(),
        );
        store
            .commit_video_export(&manifest, &output_asset, &finished_job)
            .unwrap();

        let lineage = store
            .video_asset_lineage(&output_asset.asset_id, output_asset.revision)
            .unwrap();
        assert_eq!(lineage.len(), 4);
        for event_id in [npr_event.event_id.as_str(), nvidia_event.event_id.as_str()] {
            assert!(lineage.iter().any(|edge| {
                edge.upstream_kind == VideoAssetUpstreamKind::Event
                    && edge.upstream_id == event_id
                    && edge.upstream_revision.is_none()
                    && edge.relationship == "produced_from_edl_export"
                    && edge.input_hash.is_none()
            }));
        }
        assert!(lineage.iter().any(|edge| {
            edge.upstream_kind == VideoAssetUpstreamKind::Claim
                && edge.upstream_id == "claim-export-lineage"
        }));
        assert!(lineage.iter().any(|edge| {
            edge.upstream_kind == VideoAssetUpstreamKind::Asset
                && edge.upstream_id == source_asset.asset_id
                && edge.upstream_revision == Some(1)
        }));
        let persisted_manifest = store
            .video_export_manifest_v1("manifest-export-valid")
            .unwrap()
            .unwrap();
        assert_eq!(persisted_manifest.lineage_refs, refs);
        assert_eq!(
            store.video_job("job-export-valid").unwrap().unwrap().status,
            "succeeded"
        );

        let invalid_queued_job = make_job("job-export-invalid", "queued", 0);
        store
            .create_video_export_job(
                "request-export-invalid",
                "sha256:request-invalid",
                &invalid_queued_job,
            )
            .unwrap();
        let invalid_finished_job = VideoJob {
            status: "succeeded".into(),
            progress_millis: 100_000,
            started_at: Some(now),
            finished_at: Some(now),
            ..invalid_queued_job.clone()
        };
        let invalid_output_asset = make_asset(
            "export-output-invalid",
            "sha256:output-invalid",
            "internal_review_only",
            Some("job-export-invalid"),
        );
        let invalid_manifest = make_manifest(
            "manifest-export-invalid",
            &invalid_output_asset.asset_id,
            "sha256:output-invalid",
            vec![
                nip_domain::VideoExportLineageRefV1 {
                    kind: "asset".into(),
                    id: source_asset.asset_id,
                    revision: Some(1),
                },
                nip_domain::VideoExportLineageRefV1 {
                    kind: "event".into(),
                    id: "event-not-in-nip".into(),
                    revision: None,
                },
            ],
        );
        assert!(matches!(
            store.commit_video_export(
                &invalid_manifest,
                &invalid_output_asset,
                &invalid_finished_job
            ),
            Err(StoreError::InvalidVideoEvidence)
        ));
        assert!(!store
            .video_assets(500)
            .unwrap()
            .iter()
            .any(|asset| asset.asset_id == "export-output-invalid"));
        assert!(store
            .video_asset_lineage("export-output-invalid", 1)
            .unwrap()
            .is_empty());
        assert!(store
            .video_export_manifest_v1("manifest-export-invalid")
            .unwrap()
            .is_none());
        assert_eq!(
            store
                .video_job("job-export-invalid")
                .unwrap()
                .unwrap()
                .status,
            "queued"
        );
    }
}
