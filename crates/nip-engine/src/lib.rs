pub mod config;

use std::fs;

use nip_domain::{
    CapabilitiesResponse, FeatureCapabilities, HealthResponse, Readiness, API_VERSION,
    DOMAIN_SCHEMA_VERSION, SERVICE_NAME,
};
use nip_store::{Store, StoreError};
use thiserror::Error;

pub use config::{ConfigError, NipConfig};

#[derive(Debug, Error)]
pub enum NipError {
    #[error("NIP configuration is invalid")]
    Configuration(#[from] ConfigError),
    #[error("NIP data directory could not be prepared")]
    PrepareDataDirectory(#[source] std::io::Error),
    #[error("NIP storage could not be initialized")]
    Storage(#[from] StoreError),
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
                podcast_rss_subscriptions: false,
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
        assert_eq!(health.schema_version, 1);

        let capabilities = service.capabilities();
        assert!(capabilities.features.duckdb_store);
        assert!(!capabilities.features.podcast_rss_subscriptions);
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
}
