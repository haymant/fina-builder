use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use duckdb::{params, Connection, OptionalExt};
use nip_domain::{
    PodcastEpisode, PodcastEpisodeState, PodcastSubscription, PodcastSubscriptionState, SourceId,
};
use sha2::{Digest, Sha256};
use thiserror::Error;

const MIGRATION_1: &str = include_str!("../migrations/0001_core.sql");
const MIGRATION_2: &str = include_str!("../migrations/0002_podcast_feeds.sql");
const LATEST_SCHEMA_VERSION: u32 = 2;

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

    /// Persist an already user-approved feed. There is deliberately no default
    /// catalog or implicit approval path.
    pub fn add_approved_subscription(
        &mut self,
        subscription: &PodcastSubscription,
    ) -> Result<(), StoreError> {
        let transaction = self.connection.transaction()?;
        transaction.execute(
            "INSERT INTO nip_sources (source_id, source_type, display_name, locator, rights_status)
             VALUES (?, 'podcast', ?, ?, 'approved')",
            params![
                subscription.source_id.as_str(),
                subscription.show_name,
                subscription.feed_url
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
                continue;
            }
            let episode_id = stable_episode_id(episode.source_id.as_str(), &identity_key);
            transaction.execute(
                "INSERT INTO nip_podcast_episodes
                    (episode_id, source_id, identity_key, source_native_id, canonical_url, title,
                     enclosure_url, published_at, discovered_at, state)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                    episode_state_as_str(episode.state)
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
                    published_at, discovered_at, state
             FROM nip_podcast_episodes WHERE source_id = ? ORDER BY discovered_at, episode_id",
        )?;
        let rows = statement.query_map(params![source_id.as_str()], raw_episode_from_row)?;
        rows.map(|row| row?.try_into()).collect()
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

    if current_version < 1 {
        apply_migration(connection, 1, "core", MIGRATION_1)?;
        current_version = 1;
    }
    if current_version < 2 {
        apply_migration(connection, 2, "podcast_feeds", MIGRATION_2)?;
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
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use duckdb::Connection;
    use tempfile::tempdir;

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
        }
    }

    #[test]
    fn fresh_database_runs_two_migrations_and_reopen_is_idempotent() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("nip.duckdb");

        {
            let store = Store::open(&path).unwrap();
            assert_eq!(store.schema_version(), 2);
            assert!(store.has_table("nip_schema_migrations").unwrap());
            assert!(store.has_table("nip_sources").unwrap());
            assert!(store.has_table("nip_events").unwrap());
            assert!(store.has_table("nip_ingestion_runs").unwrap());
            assert!(store.has_table("nip_podcast_subscriptions").unwrap());
            assert!(store.has_table("nip_podcast_episodes").unwrap());
        }

        let reopened = Store::open(&path).unwrap();
        assert_eq!(reopened.schema_version(), 2);
        let migration_count: i64 = reopened
            .connection
            .query_row("SELECT COUNT(*) FROM nip_schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(migration_count, 2);
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
        assert_eq!(store.schema_version(), 2);
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
                supported: 2
            }
        ));
    }

    #[test]
    fn databases_in_distinct_test_directories_are_isolated() {
        let first_dir = tempdir().unwrap();
        let second_dir = tempdir().unwrap();
        let first_path = first_dir.path().join("nip.duckdb");
        let second_path = second_dir.path().join("nip.duckdb");
        let first = Store::open(&first_path).unwrap();
        let second = Store::open(&second_path).unwrap();
        assert_ne!(first.database_path(), second.database_path());
        assert_eq!(first.schema_version(), second.schema_version());
        assert!(first_path.exists());
        assert!(second_path.exists());
    }
}
