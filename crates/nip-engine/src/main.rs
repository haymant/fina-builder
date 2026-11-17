use std::{
    env,
    net::SocketAddr,
    path::PathBuf,
    process::ExitCode,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use chrono::{DateTime, Utc};
use nip_domain::{
    EtfMapping, EventRecord, EventSearchQuery, LocalEventImport, PodcastSubscriptionState, SourceId,
};
use nip_engine::{
    asr::DeterministicFakeAsrProvider,
    podcast::{HttpAudioClient, HttpFeedClient},
    semantic::{
        DeterministicEmbeddingProvider, HttpEmbeddingProvider, QdrantIndex, DEFAULT_DIMENSIONS,
        DEFAULT_MODEL_ID, DEFAULT_MODEL_REVISION,
    },
    DeterministicFakeClaimProvider, NipConfig, NipService, PodcastSubscriptionRequest,
};
use nip_store::Store;
use rmcp::{
    handler::server::wrapper::Parameters,
    model::{CallToolResult, Implementation, ServerCapabilities, ServerConfig},
    schemars, tool, tool_handler, tool_router,
    transport::stdio,
    ServerHandler, ServiceExt,
};
use serde::Deserialize;
use serde_json::{json, Value};

const DEFAULT_BIND: &str = "127.0.0.1:8794";
const IN_PROCESS_REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone)]
struct NipMcp {
    service: Arc<Mutex<NipService>>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SourceParams {
    source_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SignalParams {
    /// Point-in-time cutoff. Defaults to the current UTC instant.
    as_of: Option<String>,
}

#[tool_router]
impl NipMcp {
    #[tool(description = "Report NIP liveness, schema version, and readiness.")]
    fn health(&self) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => structured_success(serde_json::to_value(service.health()).unwrap()),
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Report NIP capabilities. Disabled capabilities are never advertised as enabled."
    )]
    fn capabilities(&self) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => {
                structured_success(serde_json::to_value(service.capabilities()).unwrap())
            }
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Report local NIP resource usage, derived-index readiness, scheduler ownership, and safe warnings for UI or agents."
    )]
    fn nip_resource_status(&self) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.resource_status() {
                Ok(value) => structured_success(serde_json::to_value(value).unwrap()),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Report claim-extraction state, provider/model provenance, run count, and evidence-linkage warnings."
    )]
    fn nip_extraction_status(&self) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.extraction_status() {
                Ok(value) => structured_success(serde_json::to_value(value).unwrap()),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "List user-approved podcast subscriptions and their polling state.")]
    fn list_podcast_subscriptions(&self) -> CallToolResult {
        match self
            .service
            .lock()
            .map_err(|_| "NIP service lock failed".to_owned())
            .and_then(|service| service.podcast_subscriptions().map_err(|e| e.to_string()))
        {
            Ok(value) => structured_success(serde_json::to_value(value).unwrap()),
            Err(error) => structured_error("storage_unavailable", error),
        }
    }

    #[tool(
        description = "Subscribe to a reviewed podcast RSS feed after explicit rights confirmation and perform its initial sync."
    )]
    fn subscribe_podcast_feed(
        &self,
        Parameters(params): Parameters<SubscribeParams>,
    ) -> CallToolResult {
        let source_id = match SourceId::new(params.source_id) {
            Ok(source) => source,
            Err(error) => return structured_error("invalid_request", error.message),
        };
        let request = PodcastSubscriptionRequest {
            source_id,
            feed_url: params.feed_url,
            show_name: params.show_name,
            rights_statement: params.rights_statement,
            user_confirmed_rights: params.user_confirmed_rights,
        };
        let client = HttpFeedClient::default();
        match self.service.lock() {
            Ok(mut service) => match service.subscribe_podcast_feed(request, &client, Utc::now()) {
                Ok(report) => structured_success(serde_json::to_value(report).unwrap()),
                Err(error) => structured_error("subscription_failed", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "Refresh all active podcast feeds whose six-hour poll is due.")]
    fn refresh_due_podcast_feeds(&self) -> CallToolResult {
        let client = HttpFeedClient::default();
        match self.service.lock() {
            Ok(mut service) => match service.refresh_due_podcast_feeds(&client, Utc::now()) {
                Ok(results) => structured_success(json!({
                    "results": results.into_iter().map(|result| match result {
                        Ok(report) => json!({"status": "ok", "report": report}),
                        Err(error) => json!({"status": "error", "message": error.to_string()}),
                    }).collect::<Vec<_>>()
                })),
                Err(error) => structured_error("refresh_failed", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "List RSS-discovered episodes for a user-approved podcast source.")]
    fn list_podcast_episodes(
        &self,
        Parameters(params): Parameters<SourceParams>,
    ) -> CallToolResult {
        let source = match SourceId::new(params.source_id) {
            Ok(source) => source,
            Err(error) => return structured_error("invalid_request", error.message),
        };
        match self
            .service
            .lock()
            .map_err(|_| "NIP service lock failed".to_owned())
            .and_then(|service| service.podcast_episodes(&source).map_err(|e| e.to_string()))
        {
            Ok(value) => structured_success(serde_json::to_value(value).unwrap()),
            Err(error) => structured_error("storage_unavailable", error),
        }
    }

    #[tool(
        description = "Pause, resume, or remove a podcast subscription after explicit user action."
    )]
    fn set_podcast_subscription_state(
        &self,
        Parameters(params): Parameters<SetStateParams>,
    ) -> CallToolResult {
        let source = match SourceId::new(params.source_id) {
            Ok(source) => source,
            Err(error) => return structured_error("invalid_request", error.message),
        };
        let state = match params.state.as_str() {
            "active" | "resume" => PodcastSubscriptionState::Active,
            "paused" | "pause" => PodcastSubscriptionState::Paused,
            "removed" | "remove" => PodcastSubscriptionState::Removed,
            _ => {
                return structured_error(
                    "invalid_request",
                    "state must be active, paused, or removed",
                )
            }
        };
        match self
            .service
            .lock()
            .map_err(|_| "NIP service lock failed".to_owned())
            .and_then(|mut service| {
                service
                    .set_podcast_subscription_state(&source, state)
                    .map_err(|e| e.to_string())
            }) {
            Ok(()) => structured_success(json!({"source_id": source, "state": state})),
            Err(error) => structured_error("operation_failed", error),
        }
    }

    #[tool(
        description = "In NIP_TEST_MODE only, fetch a loopback fixture enclosure and transcribe it with the deterministic local provider."
    )]
    fn transcribe_podcast_episode(
        &self,
        Parameters(params): Parameters<EpisodeParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(mut service) => {
                if !service.config().test_mode() {
                    return structured_error(
                        "unsupported",
                        "fixture transcription is available only in NIP_TEST_MODE",
                    );
                }
                let source_id = match SourceId::new(params.source_id) {
                    Ok(source) => source,
                    Err(error) => return structured_error("invalid_request", error.message),
                };
                let episodes = match service.podcast_episodes(&source_id) {
                    Ok(episodes) => episodes,
                    Err(error) => {
                        return structured_error("storage_unavailable", error.to_string())
                    }
                };
                let episode = episodes.into_iter().find(|episode| {
                    params
                        .source_native_id
                        .as_deref()
                        .is_none_or(|id| episode.source_native_id.as_deref() == Some(id))
                        && params
                            .canonical_url
                            .as_deref()
                            .is_none_or(|url| episode.canonical_url.as_deref() == Some(url))
                });
                let Some(episode) = episode else {
                    return structured_error("not_found", "podcast episode was not found");
                };
                let client = HttpAudioClient::for_test();
                let provider = match DeterministicFakeAsrProvider::new(
                    "The fixture research team expects policy to remain restrictive until inflation cools.",
                    Some("en".into()),
                ) {
                    Ok(provider) => provider,
                    Err(error) => return structured_error("internal", error.to_string()),
                };
                match service.transcribe_podcast_episode_from_enclosure(
                    &episode,
                    &client,
                    &provider,
                    Utc::now(),
                ) {
                    Ok(transcript) => structured_success(serde_json::to_value(transcript).unwrap()),
                    Err(error) => structured_error("transcription_failed", error.to_string()),
                }
            }
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Import a user-owned local transcript/document after explicit rights confirmation. Repeated imports are source-scoped and idempotent."
    )]
    fn import_local_event(&self, Parameters(params): Parameters<ImportParams>) -> CallToolResult {
        let import: LocalEventImport = match serde_json::from_value(params.import) {
            Ok(import) => import,
            Err(_) => {
                return structured_error(
                    "invalid_request",
                    "import does not match the local event schema",
                )
            }
        };
        match self.service.lock() {
            Ok(mut service) => match service.import_local_event(&import, Utc::now()) {
                Ok(event) => structured_success(serde_json::to_value(event).unwrap()),
                Err(error) => structured_error("invalid_request", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Search retained events by text, source, point-in-time cutoff, and stable cursor pagination."
    )]
    fn search_events(&self, Parameters(params): Parameters<SearchParams>) -> CallToolResult {
        let source_id = match params.source_id.map(SourceId::new).transpose() {
            Ok(value) => value,
            Err(error) => return structured_error("invalid_request", error.message),
        };
        let as_of = match params.as_of.map(|value| value.parse()).transpose() {
            Ok(value) => value,
            Err(_) => {
                return structured_error("invalid_request", "as_of must be an ISO-8601 instant")
            }
        };
        let query = EventSearchQuery {
            text: params.text,
            source_id,
            as_of,
            cursor: params.cursor,
            limit: params.limit,
        };
        match self
            .service
            .lock()
            .map_err(|_| "NIP service lock failed".to_owned())
            .and_then(|service| {
                service
                    .search_events(&query)
                    .map_err(|error| error.to_string())
            }) {
            Ok(page) => structured_success(serde_json::to_value(page).unwrap()),
            Err(error) => structured_error("storage_unavailable", error),
        }
    }

    #[tool(description = "List persisted source-linked claims and their evidence references.")]
    fn list_claims(&self) -> CallToolResult {
        match self
            .service
            .lock()
            .map_err(|_| "NIP service lock failed".to_owned())
            .and_then(|service| service.claims().map_err(|error| error.to_string()))
        {
            Ok(claims) => structured_success(serde_json::to_value(claims).unwrap()),
            Err(error) => structured_error("storage_unavailable", error),
        }
    }

    #[tool(
        description = "List versioned manual narrative-to-ETF research mappings. Ticker validity and market-data coverage are reported separately; no performance claim is produced."
    )]
    fn list_etf_mappings(&self) -> CallToolResult {
        match self
            .service
            .lock()
            .map_err(|_| "NIP service lock failed".to_owned())
            .and_then(|service| service.etf_mappings().map_err(|error| error.to_string()))
        {
            Ok(value) => structured_success(serde_json::to_value(value).unwrap()),
            Err(error) => structured_error("storage_unavailable", error),
        }
    }

    #[tool(
        description = "Create an immutable, evidence-linked manual ETF mapping revision. The ticker is syntax-checked only; existence and market-data coverage remain explicit statuses."
    )]
    fn save_etf_mapping(&self, Parameters(params): Parameters<EtfMappingParams>) -> CallToolResult {
        match self.service.lock() {
            Ok(mut service) => {
                let mapping: EtfMapping = match serde_json::from_value(params.mapping) {
                    Ok(value) => value,
                    Err(_) => {
                        return structured_error(
                            "invalid_request",
                            "mapping does not match the ETF mapping schema",
                        )
                    }
                };
                match service.save_etf_mapping(&mapping) {
                    Ok(()) => structured_success(serde_json::to_value(mapping).unwrap()),
                    Err(error) => structured_error("mapping_invalid", error.to_string()),
                }
            }
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Replace one versioned deterministic editorial candidate run. Candidates must retain narrative, claim, and source-event evidence; this creates research topics only."
    )]
    fn replace_editorial_candidates(
        &self,
        Parameters(params): Parameters<EditorialCandidatesParams>,
    ) -> CallToolResult {
        let candidates: Vec<nip_domain::EditorialCandidate> =
            match serde_json::from_value(params.candidates) {
                Ok(value) => value,
                Err(_) => {
                    return structured_error(
                        "invalid_request",
                        "candidates do not match the editorial candidate schema",
                    )
                }
            };
        match self.service.lock() {
            Ok(mut service) => match service.replace_editorial_candidates(&candidates) {
                Ok(()) => structured_success(serde_json::to_value(candidates).unwrap()),
                Err(error) => structured_error("editorial_invalid", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "List ranked evidence-linked editorial topic candidates. This is a human-review queue, not finished content or a CTR prediction."
    )]
    fn list_editorial_candidates(&self) -> CallToolResult {
        match self
            .service
            .lock()
            .map_err(|_| "NIP service lock failed".to_owned())
            .and_then(|service| {
                service
                    .editorial_candidates()
                    .map_err(|error| error.to_string())
            }) {
            Ok(value) => structured_success(serde_json::to_value(value).unwrap()),
            Err(error) => structured_error("storage_unavailable", error),
        }
    }

    #[tool(
        description = "Record a human editorial candidate decision as relevant, irrelevant, or deferred with a required reason."
    )]
    fn review_editorial_candidate(
        &self,
        Parameters(params): Parameters<EditorialReviewParams>,
    ) -> CallToolResult {
        let reviewed_at = match params.reviewed_at.parse::<DateTime<Utc>>() {
            Ok(value) => value,
            Err(_) => {
                return structured_error(
                    "invalid_request",
                    "reviewed_at must be an ISO-8601 instant",
                )
            }
        };
        match self.service.lock() {
            Ok(mut service) => match service.review_editorial_candidate(
                &params.candidate_id,
                &params.status,
                &params.reason,
                &params.reviewer,
                reviewed_at,
            ) {
                Ok(()) => structured_success(
                    json!({"candidate_id": params.candidate_id, "review_status": params.status, "reviewer": params.reviewer, "reviewed_at": reviewed_at}),
                ),
                Err(error) => structured_error("review_invalid", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Export the canonical DuckDB ledger and projections to an immutable Parquet snapshot with a verified manifest."
    )]
    fn export_parquet_snapshot(&self) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.export_parquet_snapshot() {
                Ok((path, manifest)) => structured_success(json!({
                    "snapshot_path": path,
                    "manifest": manifest,
                })),
                Err(error) => structured_error("snapshot_failed", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Search retained events with optional Qdrant hybrid dense plus lexical retrieval. Requires explicitly configured local embedding and vector services."
    )]
    fn semantic_search(
        &self,
        Parameters(params): Parameters<SemanticSearchParams>,
    ) -> CallToolResult {
        let runtime = match semantic_runtime() {
            Ok(runtime) => runtime,
            Err(error) => return structured_error("provider_unavailable", error),
        };
        match self.service.lock() {
            Ok(service) => match service.semantic_search(
                &params.text,
                &runtime.provider,
                &runtime.index,
                &runtime.index_id,
                params.limit,
            ) {
                Ok(results) => structured_success(serde_json::to_value(results).unwrap()),
                Err(error) => structured_error("semantic_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "Build or rebuild a versioned Qdrant index from canonical DuckDB events.")]
    fn rebuild_semantic_index(&self) -> CallToolResult {
        let runtime = match semantic_runtime() {
            Ok(runtime) => runtime,
            Err(error) => return structured_error("provider_unavailable", error),
        };
        match self.service.lock() {
            Ok(mut service) => match service.rebuild_semantic_index(
                &runtime.provider,
                &runtime.index,
                runtime.index_id,
            ) {
                Ok(manifest) => structured_success(serde_json::to_value(manifest).unwrap()),
                Err(error) => structured_error("semantic_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Rebuild the deterministic versioned narrative cluster projection from canonical events."
    )]
    fn rebuild_narrative_clusters(&self) -> CallToolResult {
        let provider = DeterministicEmbeddingProvider::new(DEFAULT_DIMENSIONS);
        match self.service.lock() {
            Ok(mut service) => match service.rebuild_clusters(
                &provider,
                format!("cluster-run-{}", Utc::now().timestamp_millis()),
            ) {
                Ok(clusters) => structured_success(serde_json::to_value(clusters).unwrap()),
                Err(error) => structured_error("semantic_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Build an evidence-linked versioned narrative graph from persisted clusters and claims."
    )]
    fn rebuild_narrative_graph(&self) -> CallToolResult {
        match self.service.lock() {
            Ok(mut service) => match service
                .rebuild_graph(format!("graph-run-{}", Utc::now().timestamp_millis()))
            {
                Ok(graph) => structured_success(serde_json::to_value(graph).unwrap()),
                Err(error) => structured_error("graph_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "List the last successfully persisted narrative graph projection and its evidence-linked edges."
    )]
    fn list_narrative_graph(&self) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.graph() {
                Ok(value) => structured_success(serde_json::to_value(value).unwrap()),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Compute versioned descriptive narrative signals for the completed UTC week before as_of. Coverage is explicit and remains unknown without a source-completeness manifest."
    )]
    fn narrative_signal_snapshot(
        &self,
        Parameters(params): Parameters<SignalParams>,
    ) -> CallToolResult {
        let as_of = match params.as_of.map(|value| value.parse()).transpose() {
            Ok(Some(value)) => value,
            Ok(None) => Utc::now(),
            Err(_) => {
                return structured_error("invalid_request", "as_of must be an ISO-8601 instant")
            }
        };
        match self.service.lock() {
            Ok(service) => match service.signal_snapshot(as_of) {
                Ok(snapshot) => structured_success(serde_json::to_value(snapshot).unwrap()),
                Err(error) => structured_error("signal_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "List the last successful deterministic narrative cluster projection.")]
    fn list_narrative_clusters(&self) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.clusters() {
                Ok(clusters) => structured_success(serde_json::to_value(clusters).unwrap()),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "Run the deterministic local claim extractor against one retained event.")]
    fn extract_claims(&self, Parameters(params): Parameters<ExtractParams>) -> CallToolResult {
        let event: EventRecord = match serde_json::from_value(params.event) {
            Ok(event) => event,
            Err(_) => {
                return structured_error(
                    "invalid_request",
                    "event does not match the NIP event schema",
                )
            }
        };
        match self.service.lock() {
            Ok(mut service) => {
                match service.extract_claims(&event, &DeterministicFakeClaimProvider) {
                    Ok(claims) => structured_success(serde_json::to_value(claims).unwrap()),
                    Err(error) => structured_error("extraction_failed", error.to_string()),
                }
            }
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct EtfMappingParams {
    mapping: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct EditorialCandidatesParams {
    candidates: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct EditorialReviewParams {
    candidate_id: String,
    status: String,
    reason: String,
    reviewer: String,
    reviewed_at: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SetStateParams {
    source_id: String,
    state: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SubscribeParams {
    source_id: String,
    feed_url: String,
    show_name: String,
    rights_statement: String,
    user_confirmed_rights: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct EpisodeParams {
    source_id: String,
    source_native_id: Option<String>,
    canonical_url: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct ImportParams {
    import: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct ExtractParams {
    event: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SearchParams {
    text: Option<String>,
    source_id: Option<String>,
    as_of: Option<String>,
    cursor: Option<String>,
    #[serde(default = "default_page_limit")]
    limit: u32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SemanticSearchParams {
    text: String,
    #[serde(default = "default_page_limit")]
    limit: u32,
}

struct SemanticRuntime {
    provider: HttpEmbeddingProvider,
    index: QdrantIndex,
    index_id: String,
}

fn semantic_runtime() -> Result<SemanticRuntime, String> {
    let embedding_url = env::var("NIP_EMBEDDING_URL")
        .map_err(|_| "NIP_EMBEDDING_URL is not configured".to_owned())?;
    let qdrant_url = env::var("NIP_VECTOR_DB_URL")
        .map_err(|_| "NIP_VECTOR_DB_URL is not configured".to_owned())?;
    let model = env::var("NIP_EMBEDDING_MODEL").unwrap_or_else(|_| DEFAULT_MODEL_ID.into());
    let revision =
        env::var("NIP_EMBEDDING_REVISION").unwrap_or_else(|_| DEFAULT_MODEL_REVISION.into());
    let dimensions = env::var("NIP_EMBEDDING_DIMENSIONS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_DIMENSIONS);
    let suffix = model
        .replace(|character: char| !character.is_ascii_alphanumeric(), "-")
        .to_ascii_lowercase();
    let index_id = format!(
        "bge-{}-{}",
        suffix,
        revision.replace(|character: char| !character.is_ascii_alphanumeric(), "-")
    );
    Ok(SemanticRuntime {
        provider: HttpEmbeddingProvider::new(embedding_url, model, revision, dimensions),
        index: QdrantIndex::new(qdrant_url, format!("nip_semantic_{}", suffix), dimensions),
        index_id,
    })
}

fn default_page_limit() -> u32 {
    50
}

#[tool_handler]
impl ServerHandler for NipMcp {
    fn get_info(&self) -> ServerConfig {
        let mut info = ServerConfig::default();
        info.capabilities = ServerCapabilities::builder().enable_tools().build();
        let mut server = Implementation::default();
        server.name = "nip-engine".to_owned();
        server.version = env!("CARGO_PKG_VERSION").to_owned();
        info.server_info = server;
        info
    }
}

fn structured_success(value: Value) -> CallToolResult {
    CallToolResult::structured(value)
}
fn structured_error(code: impl Into<String>, message: impl Into<String>) -> CallToolResult {
    CallToolResult::structured_error(json!({"code": code.into(), "message": message.into()}))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Transport {
    Stdio,
    Http,
}

#[derive(Debug)]
struct Cli {
    transport: Transport,
    bind: SocketAddr,
    allowed_hosts: Vec<String>,
    restore_snapshot: Option<PathBuf>,
}

fn parse_cli() -> Result<Cli, String> {
    let mut transport = Transport::Stdio;
    let mut bind: SocketAddr = DEFAULT_BIND.parse().unwrap();
    let mut allowed_hosts = Vec::new();
    let mut restore_snapshot = None;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--transport" => {
                transport = match args.next().as_deref() {
                    Some("stdio") => Transport::Stdio,
                    Some("http") => Transport::Http,
                    _ => return Err("--transport requires stdio or http".into()),
                }
            }
            "--bind" => {
                bind = args
                    .next()
                    .ok_or("--bind requires HOST:PORT")?
                    .parse()
                    .map_err(|_| "--bind must be a valid HOST:PORT")?
            }
            "--allowed-host" => allowed_hosts.push(
                args.next()
                    .ok_or("--allowed-host requires a Host header value")?,
            ),
            "--restore-snapshot" => {
                restore_snapshot = Some(PathBuf::from(
                    args.next()
                        .ok_or("--restore-snapshot requires a directory path")?,
                ));
            }
            "--help" | "-h" => return Err(usage().into()),
            other => return Err(format!("unknown argument: {other}\n\n{}", usage())),
        }
    }
    if allowed_hosts.is_empty() {
        allowed_hosts = vec!["localhost".into(), "127.0.0.1".into(), "::1".into()];
    }
    Ok(Cli {
        transport,
        bind,
        allowed_hosts,
        restore_snapshot,
    })
}

fn usage() -> &'static str {
    "Usage: nip-engine [--transport stdio|http] [--bind HOST:PORT] [--allowed-host HOST]... [--restore-snapshot PATH]\nDefaults: stdio; HTTP bind 127.0.0.1:8794; HTTP endpoint /mcp. Restore imports a verified snapshot only into a new configured database."
}

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) if error == usage() => {
            println!("{error}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{}", json!({"code":"startup_failed","message":error}));
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), String> {
    let cli = parse_cli()?;
    let config = NipConfig::from_env().map_err(|_| "NIP configuration is invalid".to_owned())?;
    if let Some(snapshot) = cli.restore_snapshot {
        Store::restore_parquet_snapshot(&snapshot, config.database_path())
            .map_err(|error| format!("NIP snapshot restore failed: {error}"))?;
    }
    let service =
        NipService::open(config).map_err(|_| "NIP service initialization failed".to_owned())?;
    let server = NipMcp {
        service: Arc::new(Mutex::new(service)),
    };
    start_in_process_refresh_scheduler(server.service.clone());
    match cli.transport {
        Transport::Stdio => {
            let running = server.serve(stdio()).await.map_err(|e| e.to_string())?;
            running
                .waiting()
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        Transport::Http => serve_http(server, cli.bind, cli.allowed_hosts).await,
    }
}

/// Owns the desktop-first refresh cadence for the lifetime of this process.
/// The first cycle runs as soon as the service starts; subsequent cycles run
/// every six hours while the app/service remains alive. No detached process,
/// host scheduler, or remote automation is created.
fn start_in_process_refresh_scheduler(service: Arc<Mutex<NipService>>) {
    let result = thread::Builder::new()
        .name("nip-refresh-scheduler".into())
        .spawn(move || loop {
            run_in_process_refresh_cycle(&service);
            thread::sleep(IN_PROCESS_REFRESH_INTERVAL);
        });
    if let Err(error) = result {
        eprintln!(
            "{}",
            json!({
                "code": "scheduler_unavailable",
                "message": format!("NIP in-process refresh scheduler could not start: {error}")
            })
        );
    }
}

fn run_in_process_refresh_cycle(service: &Arc<Mutex<NipService>>) {
    let client = HttpFeedClient::default();
    let result = service
        .lock()
        .map_err(|_| "service_lock_failed".to_owned())
        .and_then(|mut service| {
            service
                .refresh_due_podcast_feeds(&client, Utc::now())
                .map_err(|error| error.to_string())
        });
    match result {
        Ok(results) => {
            let failed = results.iter().filter(|result| result.is_err()).count();
            eprintln!(
                "{}",
                json!({
                    "event": "nip_refresh_cycle_completed",
                    "subscriptions_considered": results.len(),
                    "failed": failed,
                    "next_cycle_in_seconds": IN_PROCESS_REFRESH_INTERVAL.as_secs()
                })
            );
        }
        Err(error) => eprintln!(
            "{}",
            json!({
                "event": "nip_refresh_cycle_failed",
                "message": error,
                "next_cycle_in_seconds": IN_PROCESS_REFRESH_INTERVAL.as_secs()
            })
        ),
    }
}

async fn serve_http(
    server: NipMcp,
    bind: SocketAddr,
    allowed_hosts: Vec<String>,
) -> Result<(), String> {
    use rmcp::transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    };
    let config = StreamableHttpServerConfig::default()
        .with_allowed_hosts(allowed_hosts)
        .with_legacy_session_mode(false)
        .with_json_response(true);
    let service_server = server.clone();
    let service = StreamableHttpService::new(
        move || Ok(service_server.clone()),
        LocalSessionManager::default().into(),
        config,
    );
    let health_server = server.clone();
    let router = axum::Router::new()
        .route(
            "/health",
            axum::routing::get(move || async move {
                let body = health_server
                    .service
                    .lock()
                    .map(|service| serde_json::to_value(service.health()).unwrap())
                    .unwrap_or_else(|_| json!({"service":"nip-engine","readiness":"not_ready"}));
                axum::Json(body)
            }),
        )
        .nest_service("/mcp", service);
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|e| format!("failed to bind {bind}: {e}"))?;
    eprintln!("nip-engine Streamable HTTP listening on http://{bind}/mcp");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|e| e.to_string())
}
