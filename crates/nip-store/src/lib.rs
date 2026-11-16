use std::fs;
use std::path::{Path, PathBuf};

use duckdb::{params, Connection};
use thiserror::Error;

const INITIAL_MIGRATION: &str = include_str!("../migrations/0001_core.sql");
const LATEST_SCHEMA_VERSION: u32 = 1;

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
}

/// One local DuckDB ledger. The connection remains owned by the store and is
/// intentionally not shared with UI or transport code.
pub struct Store {
    _connection: Connection,
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
            _connection: connection,
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

    #[cfg(test)]
    fn has_table(&self, table: &str) -> Result<bool, StoreError> {
        let count: i64 = self._connection.query_row(
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
    let current_version = u32::try_from(current_version).unwrap_or(u32::MAX);
    if current_version > LATEST_SCHEMA_VERSION {
        return Err(StoreError::FutureSchema {
            found: current_version,
            supported: LATEST_SCHEMA_VERSION,
        });
    }

    if current_version < 1 {
        let transaction = connection.transaction()?;
        transaction.execute_batch(INITIAL_MIGRATION)?;
        transaction.execute(
            "INSERT INTO nip_schema_migrations (version, name) VALUES (?, ?)",
            params![1_i32, "core"],
        )?;
        transaction.commit()?;
    }

    Ok(LATEST_SCHEMA_VERSION)
}

#[cfg(test)]
mod tests {
    use super::*;
    use duckdb::Connection;
    use tempfile::tempdir;

    #[test]
    fn fresh_database_migrates_and_reopen_is_idempotent() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("nip.duckdb");

        {
            let store = Store::open(&path).unwrap();
            assert_eq!(store.schema_version(), 1);
            assert!(store.has_table("nip_schema_migrations").unwrap());
            assert!(store.has_table("nip_sources").unwrap());
            assert!(store.has_table("nip_events").unwrap());
            assert!(store.has_table("nip_ingestion_runs").unwrap());
        }

        let reopened = Store::open(&path).unwrap();
        assert_eq!(reopened.schema_version(), 1);
        let migration_count: i64 = reopened
            ._connection
            .query_row("SELECT COUNT(*) FROM nip_schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(migration_count, 1);
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
                supported: 1
            }
        ));
    }
}
