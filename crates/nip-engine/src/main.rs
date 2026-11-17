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
    SourceKind, SourceState, SourceUpdate,
};
use nip_engine::{
    asr::{AsrError, AsrProvider, ComfyUiAsrProvider, DeterministicFakeAsrProvider},
    podcast::{HttpAudioClient, HttpFeedClient},
    podcast_asr_request,
    semantic::{
        DeterministicEmbeddingProvider, HttpEmbeddingProvider, QdrantIndex, DEFAULT_DIMENSIONS,
        DEFAULT_MODEL_ID, DEFAULT_MODEL_REVISION,
    },
    DeterministicFakeClaimProvider, NipConfig, NipError, NipService, PodcastSubscriptionRequest,
    SourceDraft,
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

    #[tool(
        description = "Report the configured RIGA provider/model, local or remote boundary, NIP-specific remote-consent state, and whether claim extraction is currently available. Credentials and endpoints are never returned."
    )]
    fn nip_provider_status(&self) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.provider_status() {
                Ok(value) => structured_success(serde_json::to_value(value).unwrap()),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Grant NIP-specific consent to send transcript text and the claim-extraction prompt to the exact remote provider/model currently selected in RIGA. Revocation is a new audit event."
    )]
    fn nip_grant_remote_consent(
        &self,
        Parameters(params): Parameters<ConsentParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(mut service) => match service.grant_remote_consent(
                &params.actor,
                params.reason.as_deref(),
                Utc::now(),
            ) {
                Ok(consent) => structured_success(serde_json::to_value(consent).unwrap()),
                Err(error) => structured_error("consent_not_recorded", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Revoke NIP-specific remote transcript extraction consent for the currently selected remote provider/model. The transcript stays local and extraction becomes blocked."
    )]
    fn nip_revoke_remote_consent(
        &self,
        Parameters(params): Parameters<ConsentParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(mut service) => match service.revoke_remote_consent(
                &params.actor,
                params.reason.as_deref(),
                Utc::now(),
            ) {
                Ok(consent) => structured_success(serde_json::to_value(consent).unwrap()),
                Err(error) => structured_error("consent_not_recorded", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Extract evidence-linked claims from one retained event with the configured RIGA provider. Remote providers require active NIP-specific consent; no fallback provider is used."
    )]
    fn extract_claims_from_event(
        &self,
        Parameters(params): Parameters<EventIdParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(mut service) => match service.extract_claims_from_event(&params.event_id) {
                Ok(claims) => structured_success(serde_json::to_value(claims).unwrap()),
                Err(error) => structured_error("extraction_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "List the append-only editorial review audit for one candidate, including corrections after the latest review state."
    )]
    fn list_editorial_review_audit(
        &self,
        Parameters(params): Parameters<CandidateParams>,
    ) -> CallToolResult {
        match self
            .service
            .lock()
            .map_err(|_| "NIP service lock failed".to_owned())
            .and_then(|service| {
                service
                    .editorial_review_audit(&params.candidate_id)
                    .map_err(|error| error.to_string())
            }) {
            Ok(value) => structured_success(serde_json::to_value(value).unwrap()),
            Err(error) => structured_error("storage_unavailable", error),
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
        description = "List one stable page of discovered podcast episodes across sources, newest-first by default, with optional source and title filters."
    )]
    fn list_episode_page(
        &self,
        Parameters(params): Parameters<EpisodePageParams>,
    ) -> CallToolResult {
        let source_id = match params.source_id.map(SourceId::new).transpose() {
            Ok(value) => value,
            Err(error) => return structured_error("invalid_request", error.message),
        };
        match self
            .service
            .lock()
            .map_err(|_| "NIP service lock failed".to_owned())
            .and_then(|service| {
                service
                    .podcast_episode_page(
                        source_id.as_ref(),
                        params.title_contains.as_deref(),
                        params.sort.as_deref(),
                        params.limit,
                        params.offset,
                    )
                    .map_err(|error| error.to_string())
            }) {
            Ok(page) => structured_success(serde_json::to_value(page).unwrap()),
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
        description = "List every registered source (podcast, company meeting, filing, reddit, x, web, local document, other) with rights, topics, lifecycle state, scan caps and retained event count."
    )]
    fn list_sources(&self, Parameters(params): Parameters<ListSourcesParams>) -> CallToolResult {
        match self
            .service
            .lock()
            .map_err(|_| "NIP service lock failed".to_owned())
            .and_then(|service| {
                service
                    .sources(params.include_removed.unwrap_or(false))
                    .map_err(|error| error.to_string())
            }) {
            Ok(sources) => structured_success(serde_json::to_value(sources).unwrap()),
            Err(error) => structured_error("storage_unavailable", error),
        }
    }

    #[tool(
        description = "Register a source of any kind after explicit rights confirmation. A podcast additionally creates its RSS subscription and performs the initial sync."
    )]
    fn create_source(&self, Parameters(params): Parameters<CreateSourceParams>) -> CallToolResult {
        if params.user_confirmed_rights != Some(true) {
            return structured_error(
                "rights_confirmation_required",
                "pass user_confirmed_rights=true only after the access and retention rights are reviewed",
            );
        }
        let source_id = match SourceId::new(params.source_id) {
            Ok(source) => source,
            Err(error) => return structured_error("invalid_request", error.message),
        };
        let kind = match SourceKind::parse(&params.kind) {
            Some(kind) => kind,
            None => {
                return structured_error(
                    "invalid_request",
                    "kind must be one of podcast, company_meeting, filing, reddit, x, web, local_document, other",
                )
            }
        };
        let draft = SourceDraft {
            source_id,
            kind,
            display_name: params.display_name,
            locator: params.locator,
            rights_statement: params.rights_statement,
            topics: params.topics.unwrap_or_default(),
            poll_interval_minutes: params.poll_interval_minutes,
            per_scan_limit: params.per_scan_limit,
            notes: params.notes,
        };
        let client = HttpFeedClient::default();
        match self.service.lock() {
            Ok(mut service) => {
                match service.create_source(draft, &client, Utc::now()) {
                    Ok(source) => structured_success(serde_json::to_value(source).unwrap()),
                    Err(error) => structured_error("create_failed", error.to_string()),
                }
            }
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Correct or change a source: display name, locator or podcast feed URL, rights statement, topics and scan caps. A podcast URL correction resets ETag/backoff; pass sync=true to refresh immediately."
    )]
    fn update_source(&self, Parameters(params): Parameters<UpdateSourceParams>) -> CallToolResult {
        let source_id = match SourceId::new(params.source_id) {
            Ok(source) => source,
            Err(error) => return structured_error("invalid_request", error.message),
        };
        let update = SourceUpdate {
            display_name: params.display_name,
            locator: params.locator,
            rights_statement: params.rights_statement,
            topics: params.topics,
            poll_interval_minutes: params.poll_interval_minutes,
            per_scan_limit: params.per_scan_limit,
            notes: params.notes,
        };
        let client = HttpFeedClient::default();
        match self.service.lock() {
            Ok(mut service) => match service.update_source(
                &source_id,
                &update,
                &client,
                params.sync.unwrap_or(false),
                Utc::now(),
            ) {
                Ok(source) => structured_success(serde_json::to_value(source).unwrap()),
                Err(error) => structured_error("update_failed", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Activate, pause, resume or remove any source kind. Paused sources are skipped by refresh; removed sources are retained for audit."
    )]
    fn set_source_state(&self, Parameters(params): Parameters<SetStateParams>) -> CallToolResult {
        let source_id = match SourceId::new(params.source_id) {
            Ok(source) => source,
            Err(error) => return structured_error("invalid_request", error.message),
        };
        let state = match SourceState::parse(&params.state) {
            Some(state) => state,
            None => {
                return structured_error(
                    "invalid_request",
                    "state must be active, paused, or removed",
                )
            }
        };
        match self.service.lock() {
            Ok(mut service) => match service.set_source_state(&source_id, state, Utc::now()) {
                Ok(source) => structured_success(serde_json::to_value(source).unwrap()),
                Err(error) => structured_error("operation_failed", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Permanently delete a source that owns no retained events, including its podcast episode metadata. A source with events must be marked removed instead."
    )]
    fn delete_source(&self, Parameters(params): Parameters<DeleteSourceParams>) -> CallToolResult {
        if params.user_confirmed != Some(true) {
            return structured_error(
                "confirmation_required",
                "pass user_confirmed=true to delete a source",
            );
        }
        let source_id = match SourceId::new(params.source_id) {
            Ok(source) => source,
            Err(error) => return structured_error("invalid_request", error.message),
        };
        match self.service.lock() {
            Ok(mut service) => match service.delete_source(&source_id) {
                Ok(()) => structured_success(json!({"source_id": source_id, "deleted": true})),
                Err(error) => structured_error("delete_failed", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Download an approved episode enclosure and transcribe it with the configured local ASR provider (NIP_COMFYUI_URL), or the deterministic fixture in NIP_TEST_MODE. No remote ASR fallback."
    )]
    fn transcribe_podcast_episode(
        &self,
        Parameters(params): Parameters<EpisodeParams>,
    ) -> CallToolResult {
        let (episode, test_mode, comfyui_url, staging_root) = {
            let service = match self.service.lock() {
                Ok(service) => service,
                Err(_) => return structured_error("internal", "NIP service lock failed"),
            };
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
            let test_mode = service.config().test_mode();
            let comfyui_url = service
                .config()
                .comfyui_url()
                .map(|url| url.as_str().to_owned());
            let staging_root = service.config().asr_staging_root();
            (episode, test_mode, comfyui_url, staging_root)
        };

        if test_mode {
            let mut service = match self.service.lock() {
                Ok(service) => service,
                Err(_) => return structured_error("internal", "NIP service lock failed"),
            };
            let client = HttpAudioClient::for_test();
            let provider = match DeterministicFakeAsrProvider::new(
                "The fixture research team expects policy to remain restrictive until inflation cools.",
                Some("en".into()),
            ) {
                Ok(provider) => provider,
                Err(error) => return structured_error("internal", error.to_string()),
            };
            return match service.transcribe_podcast_episode_from_enclosure(
                &episode,
                &client,
                &provider,
                Utc::now(),
            ) {
                Ok(transcript) => structured_success(serde_json::to_value(transcript).unwrap()),
                Err(error) => transcription_error(error),
            };
        }

        let Some(comfyui_url) = comfyui_url else {
            return structured_error(
                "transcription_unavailable",
                "local ASR is not configured; set NIP_COMFYUI_URL to a loopback ComfyUI server running the Qwen3-ASR workflow",
            );
        };
        let request = match podcast_asr_request(&episode, &HttpAudioClient::default()) {
            Ok(request) => request,
            Err(error) => return transcription_error(error),
        };
        let provider = match ComfyUiAsrProvider::new(&comfyui_url, staging_root) {
            Ok(provider) => provider,
            Err(error) => return structured_error("transcription_unavailable", error.to_string()),
        };
        let result = match provider.transcribe(&request) {
            Ok(result) => result,
            Err(error) => {
                if let Ok(mut service) = self.service.lock() {
                    let _ = service.record_transcription_failure(&episode, error.clone());
                }
                return asr_error(error);
            }
        };
        let mut service = match self.service.lock() {
            Ok(service) => service,
            Err(_) => return structured_error("internal", "NIP service lock failed"),
        };
        match service.commit_podcast_transcript(&episode, result, Utc::now()) {
            Ok(transcript) => structured_success(serde_json::to_value(transcript).unwrap()),
            Err(error) => transcription_error(error),
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
struct ConsentParams {
    #[serde(default = "default_actor")]
    actor: String,
    reason: Option<String>,
}

fn default_actor() -> String {
    "local-user".into()
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct EventIdParams {
    event_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct CandidateParams {
    candidate_id: String,
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
struct ListSourcesParams {
    /// Include soft-removed sources. Defaults to false.
    include_removed: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct CreateSourceParams {
    source_id: String,
    /// podcast | company_meeting | filing | reddit | x | web | local_document | other
    kind: String,
    display_name: String,
    /// RSS feed URL, source URL or local reference. Required except for local_document/other.
    locator: Option<String>,
    rights_statement: String,
    user_confirmed_rights: Option<bool>,
    topics: Option<Vec<String>>,
    poll_interval_minutes: Option<u32>,
    per_scan_limit: Option<u32>,
    notes: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct UpdateSourceParams {
    source_id: String,
    display_name: Option<String>,
    locator: Option<String>,
    rights_statement: Option<String>,
    topics: Option<Vec<String>>,
    poll_interval_minutes: Option<u32>,
    per_scan_limit: Option<u32>,
    notes: Option<String>,
    /// Refresh a podcast immediately after the correction.
    sync: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct DeleteSourceParams {
    source_id: String,
    user_confirmed: Option<bool>,
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
struct EpisodePageParams {
    /// Restrict to one source. Omit for all podcast sources.
    source_id: Option<String>,
    /// Case-insensitive substring over the episode title.
    title_contains: Option<String>,
    /// published_desc (default) or title_asc.
    sort: Option<String>,
    /// Page size, clamped to 1–200. Defaults to 50.
    limit: Option<u32>,
    /// Zero-based row offset. Defaults to 0.
    offset: Option<u32>,
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

fn transcription_error(error: NipError) -> CallToolResult {
    match error {
        NipError::AudioUnavailable => structured_error(
            "audio_unavailable",
            "the podcast audio enclosure could not be downloaded",
        ),
        NipError::UnsupportedAudio => structured_error(
            "unsupported_audio",
            "the episode has no supported audio enclosure",
        ),
        NipError::TranscriptionUnavailable => structured_error(
            "transcription_unavailable",
            "the local ASR provider is unavailable or timed out; no remote fallback was attempted",
        ),
        NipError::TranscriptionFailed => structured_error(
            "transcription_failed",
            "the local ASR provider returned an empty or malformed transcript",
        ),
        NipError::SubscriptionNotFound => {
            structured_error("not_found", "podcast subscription was not found")
        }
        other => structured_error("transcription_failed", other.to_string()),
    }
}

fn asr_error(error: AsrError) -> CallToolResult {
    match error {
        AsrError::Unavailable | AsrError::Timeout | AsrError::Cancelled => structured_error(
            "transcription_unavailable",
            "the local ASR provider is unavailable or timed out; no remote fallback was attempted",
        ),
        AsrError::InvalidInput | AsrError::MalformedOutput => structured_error(
            "transcription_failed",
            "the local ASR provider rejected the audio or returned a malformed transcript",
        ),
    }
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
    let service = match NipService::open(config) {
        Ok(service) => service,
        Err(error) => {
            // Startup diagnostics stay on stderr: the MCP client receives only
            // the safe summary, while the desktop log names the real cause.
            eprintln!(
                "{}",
                json!({
                    "code": "startup_failed",
                    "message": "NIP service initialization failed",
                    "detail": match std::error::Error::source(&error) {
                        Some(source) => format!("{error}: {source}"),
                        None => error.to_string(),
                    },
                })
            );
            return Err("NIP service initialization failed".to_owned());
        }
    };
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
