use std::{
    collections::HashMap,
    env, fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::ExitCode,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use chrono::{DateTime, Utc};
use nip_domain::{
    AgentClaimDraft, AgentEntityDraft, AgentNarrativeGraphDraft, EtfMapping, EventSearchQuery,
    LocalEventImport, PodcastEpisode, PodcastSubscriptionState, SourceId, SourceKind, SourceState,
    SourceUpdate, VideoAsset, VideoAssetLineage, VideoAssetUpstreamKind, VideoAudioCue, VideoJob,
    VideoNarrative, VideoTimeline, VideoVisualSourceKind, VideoVisualSpec, VideoWorkflow,
};
use nip_engine::{
    asr::{AsrError, AsrProvider, ComfyUiAsrProvider, DeterministicFakeAsrProvider},
    comfy::{self, ComfyAsrStatus, ComfyWorkspaceReport},
    jobs::{cleanup_working_audio, JobRegistry, TranscriptionJob},
    media,
    podcast::{HttpAudioClient, HttpFeedClient},
    podcast_asr_request,
    semantic::{
        DeterministicEmbeddingProvider, HttpEmbeddingProvider, QdrantIndex, DEFAULT_DIMENSIONS,
        DEFAULT_MODEL_ID, DEFAULT_MODEL_REVISION,
    },
    NipConfig, NipError, NipService, PodcastSubscriptionRequest, SourceDraft,
};
use nip_store::Store;
use rmcp::{
    handler::server::wrapper::Parameters,
    model::{CallToolResult, Implementation, ServerCapabilities, ServerConfig},
    schemars, tool, tool_handler, tool_router,
    transport::stdio,
    ServerHandler, ServiceExt,
};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

mod linkzag;

const DEFAULT_BIND: &str = "127.0.0.1:8794";
const IN_PROCESS_REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const DEFAULT_TEST_ASR_TRANSCRIPT: &str =
    "The fixture research team expects policy to remain restrictive until inflation cools.";

fn test_asr_transcript() -> String {
    env::var("NIP_TEST_TRANSCRIPT")
        .ok()
        .filter(|transcript| !transcript.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_TEST_ASR_TRANSCRIPT.to_owned())
}

#[derive(Clone)]
struct NipMcp {
    service: Arc<Mutex<NipService>>,
    jobs: JobRegistry,
    video_cancel: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// One long GPU job at a time: SDXL covers and the ASR model share an 8 GB
    /// card, so concurrent transcriptions would fight for the same VRAM.
    gate: Arc<Mutex<()>>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SourceParams {
    source_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct StartTranscriptionParams {
    source_id: String,
    source_native_id: Option<String>,
    canonical_url: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct FindEpisodeEventParams {
    source_id: String,
    source_native_id: Option<String>,
    canonical_url: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct TranscriptionJobParams {
    job_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct ListTranscriptionJobsParams {
    source_id: Option<String>,
    limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct RemoveTranscriptionJobParams {
    job_id: String,
    #[serde(default)]
    delete_artifacts: bool,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct ListMediaParams {
    limit: Option<u32>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct DeleteMediaParams {
    job_id: String,
    name: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct SignalParams {
    /// Point-in-time cutoff. Defaults to the current UTC instant.
    as_of: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoProjectParams {
    project: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoProjectIdParams {
    project_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoEpisodeParams {
    episode: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoEvidenceParams {
    episode_id: String,
    episode_revision: u32,
    evidence: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoEvidenceListParams {
    episode_id: String,
    episode_revision: u32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoNarrativeParams {
    narrative: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoNarrativeIdParams {
    narrative_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoNarrativeListParams {
    episode_id: String,
    #[serde(default = "default_page_limit")]
    limit: u32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoStoryboardParams {
    storyboard: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoSceneParams {
    scene: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoShotParams {
    shot: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoAudioCueParams {
    cue: Value,
}
#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoAudioCueRefParams {
    cue_ref: VideoEdlRefParams,
}
#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoAudioCueListParams {
    storyboard_ref: VideoEdlRefParams,
    #[serde(default = "default_page_limit")]
    limit: u32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoAssetParams {
    asset: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoAssetLineageParams {
    lineage: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoAssetLineageListParams {
    asset_id: String,
    asset_revision: u32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoWorkflowParams {
    workflow: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoVisualSpecParams {
    spec: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoVisualSpecIdParams {
    spec_id: String,
    revision: u32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoExportManifestParams {
    manifest: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoExportManifestIdParams {
    manifest_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoQaReportParams {
    report: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoQaReportIdParams {
    report_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoProjectLimitParams {
    project_id: String,
    #[serde(default = "default_page_limit")]
    limit: u32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoTimelineParams {
    timeline: Value,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoTimelineBuildParams {
    project_ref: Value,
    episode_ref: Value,
    storyboard_ref: Value,
    output_profile_id: String,
    video_tracks: Vec<Value>,
    #[serde(default)]
    audio_tracks: Vec<Value>,
    #[serde(default)]
    caption_tracks: Vec<Value>,
    gap_policy: String,
    request_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoEdlRefParams {
    id: String,
    revision: u32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoEdlGetParams {
    timeline_ref: VideoEdlRefParams,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoEdlListParams {
    project_ref: VideoEdlRefParams,
    #[serde(default = "default_page_limit")]
    limit: u32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoQaRunParams {
    timeline_ref: VideoEdlRefParams,
    qa_profile_id: String,
    request_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoQaGetParams {
    report_ref: VideoEdlRefParams,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoExportProfilesParams {
    purpose: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoExportPreflightParams {
    timeline_ref: VideoEdlRefParams,
    qa_report_ref: VideoEdlRefParams,
    export_profile_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoExportStartParams {
    timeline_ref: VideoEdlRefParams,
    qa_report_ref: VideoEdlRefParams,
    export_profile_id: String,
    request_id: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoExportManifestGetParams {
    manifest_ref: VideoEdlRefParams,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoExportManifestListParams {
    project_ref: VideoEdlRefParams,
    #[serde(default = "default_page_limit")]
    limit: u32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoTimelineIdParams {
    timeline_id: String,
    revision: u32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoLimitParams {
    #[serde(default = "default_page_limit")]
    limit: u32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct LinkZagRenderParams {
    visual_spec_id: Option<String>,
    visual_spec_revision: Option<u32>,
    visual_specs: Option<Vec<VideoVisualSpecRefParams>>,
    #[serde(default)]
    capture_mode: LinkZagCaptureMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
enum LinkZagCaptureMode {
    Flash,
    Full,
}

impl Default for LinkZagCaptureMode {
    fn default() -> Self {
        Self::Flash
    }
}

impl LinkZagCaptureMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Flash => "flash",
            Self::Full => "full",
        }
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoVisualSpecRefParams {
    spec_id: String,
    revision: u32,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct VideoJobIdParams {
    job_id: String,
}

fn parse_video_value<T: DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|error| format!("invalid Video record: {error}"))
}

#[tool_router]
impl NipMcp {
    #[tool(
        description = "Report Video Workspace capability states. Deterministic planning is available without model providers."
    )]
    fn video_capabilities(&self) -> CallToolResult {
        structured_success(json!({
            "planning": "ready",
            "evidence_linkage": "ready",
            "deterministic_renderer": "linkzag_adapter",
            "mock_assets": "candidate_only",
            "generative_video": "not_configured",
            "tts": "not_configured",
            "asr": "not_configured",
            "disclosure": "Evidence and planning are available; no model-generated video is executed by this surface."
        }))
    }

    #[tool(
        description = "List current reusable Video assets with provider, hash, capability, license, and lineage-ready metadata."
    )]
    fn list_video_assets(
        &self,
        Parameters(params): Parameters<VideoLimitParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_assets(params.limit) {
                Ok(assets) => structured_success(serde_json::to_value(assets).unwrap()),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Register a reusable Video asset. The path must be managed metadata, not an arbitrary provider path."
    )]
    fn register_video_asset(
        &self,
        Parameters(params): Parameters<VideoAssetParams>,
    ) -> CallToolResult {
        let asset = match parse_video_value::<VideoAsset>(params.asset) {
            Ok(value) => value,
            Err(error) => return structured_error("invalid_request", error),
        };
        match self.service.lock() {
            Ok(mut service) => match service.save_video_asset(&asset) {
                Ok(()) => structured_success(serde_json::to_value(asset).unwrap()),
                Err(error) => structured_error("video_asset_rejected", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Register an immutable revisioned VideoAudioCue bound to exact project/episode/storyboard, optional scene, and registered audio asset revisions. This tool cannot approve rights; actual byte/probe verification remains a QA gate."
    )]
    fn register_video_audio_cue(
        &self,
        Parameters(params): Parameters<VideoAudioCueParams>,
    ) -> CallToolResult {
        let cue = match parse_video_value::<VideoAudioCue>(params.cue) {
            Ok(v) => v,
            Err(e) => return structured_error("invalid_request", e),
        };
        match self.service.lock() {
            Ok(mut service) => match service.save_video_audio_cue(&cue) {
                Ok(()) => structured_success(serde_json::to_value(cue).unwrap()),
                Err(e) => structured_error("video_audio_cue_rejected", e.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }
    #[tool(description = "Read one exact immutable VideoAudioCue revision.")]
    fn get_video_audio_cue(
        &self,
        Parameters(params): Parameters<VideoAudioCueRefParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => {
                match service.video_audio_cue(&params.cue_ref.id, params.cue_ref.revision) {
                    Ok(Some(cue)) => structured_success(serde_json::to_value(cue).unwrap()),
                    Ok(None) => structured_error("not_found", "VideoAudioCue was not found"),
                    Err(e) => structured_error("storage_unavailable", e.to_string()),
                }
            }
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }
    #[tool(
        description = "List immutable VideoAudioCue revisions for one exact storyboard revision."
    )]
    fn list_video_audio_cues(
        &self,
        Parameters(params): Parameters<VideoAudioCueListParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_audio_cues(
                &params.storyboard_ref.id,
                params.storyboard_ref.revision,
                params.limit,
            ) {
                Ok(cues) => structured_success(serde_json::to_value(cues).unwrap()),
                Err(e) => structured_error("storage_unavailable", e.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Link a registered Video asset revision to a validated event, claim, visual spec, asset, scene, or shot source."
    )]
    fn link_video_asset_lineage(
        &self,
        Parameters(params): Parameters<VideoAssetLineageParams>,
    ) -> CallToolResult {
        let lineage = match parse_video_value::<VideoAssetLineage>(params.lineage) {
            Ok(value) => value,
            Err(error) => return structured_error("invalid_request", error),
        };
        match self.service.lock() {
            Ok(mut service) => match service.save_video_asset_lineage(&lineage) {
                Ok(()) => structured_success(serde_json::to_value(lineage).unwrap()),
                Err(error) => structured_error("video_asset_lineage_rejected", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "List the validated upstream lineage for one exact Video asset revision.")]
    fn list_video_asset_lineage(
        &self,
        Parameters(params): Parameters<VideoAssetLineageListParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => {
                match service.video_asset_lineage(&params.asset_id, params.asset_revision) {
                    Ok(lineage) => structured_success(serde_json::to_value(lineage).unwrap()),
                    Err(error) => structured_error("storage_unavailable", error.to_string()),
                }
            }
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "List versioned Video workflow registry records.")]
    fn list_video_workflows(&self) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_workflows() {
                Ok(workflows) => structured_success(serde_json::to_value(workflows).unwrap()),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "Register a versioned Video workflow adapter record.")]
    fn register_video_workflow(
        &self,
        Parameters(params): Parameters<VideoWorkflowParams>,
    ) -> CallToolResult {
        let workflow = match parse_video_value::<VideoWorkflow>(params.workflow) {
            Ok(value) => value,
            Err(error) => return structured_error("invalid_request", error),
        };
        match self.service.lock() {
            Ok(mut service) => match service.save_video_workflow(&workflow) {
                Ok(()) => structured_success(serde_json::to_value(workflow).unwrap()),
                Err(error) => structured_error("video_workflow_rejected", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Save a bounded, versioned VideoVisualSpec with typed payload and source lineage. Arbitrary LinkZag scene JSON is not canonical here."
    )]
    fn save_video_visual_spec(
        &self,
        Parameters(params): Parameters<VideoVisualSpecParams>,
    ) -> CallToolResult {
        let spec = match parse_video_value::<VideoVisualSpec>(params.spec) {
            Ok(value) => value,
            Err(error) => return structured_error("invalid_request", error),
        };
        match self.service.lock() {
            Ok(mut service) => match service.save_video_visual_spec(&spec) {
                Ok(()) => structured_success(serde_json::to_value(spec).unwrap()),
                Err(error) => structured_error("video_visual_spec_rejected", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "Read one versioned VideoVisualSpec with its typed source lineage.")]
    fn get_video_visual_spec(
        &self,
        Parameters(params): Parameters<VideoVisualSpecIdParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_visual_spec(&params.spec_id, params.revision) {
                Ok(Some(spec)) => structured_success(serde_json::to_value(spec).unwrap()),
                Ok(None) => structured_error("not_found", "VideoVisualSpec was not found"),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "List recent versioned VideoVisualSpec records.")]
    fn list_video_visual_specs(
        &self,
        Parameters(params): Parameters<VideoLimitParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_visual_specs(params.limit) {
                Ok(specs) => structured_success(serde_json::to_value(specs).unwrap()),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Disabled: export success manifests can only be created by the verified export producer. Legacy manifests remain readable."
    )]
    fn save_video_export_manifest(
        &self,
        Parameters(_params): Parameters<VideoExportManifestParams>,
    ) -> CallToolResult {
        structured_error(
            "unsupported_operation",
            "only a validated producer run can create an export success manifest",
        )
    }

    #[tool(
        description = "Read one typed Video export manifest with file and evidence lineage details."
    )]
    fn get_video_export_manifest(
        &self,
        Parameters(params): Parameters<VideoExportManifestIdParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_export_manifest(&params.manifest_id) {
                Ok(Some(manifest)) => structured_success(serde_json::to_value(manifest).unwrap()),
                Ok(None) => structured_error("not_found", "Video export manifest was not found"),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "List recent typed Video export manifests.")]
    fn list_video_export_manifests(
        &self,
        Parameters(params): Parameters<VideoLimitParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_export_manifests(params.limit) {
                Ok(manifests) => structured_success(serde_json::to_value(manifests).unwrap()),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Disabled: caller-authored QA decisions are not accepted; use fina_video_qa_run. Legacy reports remain readable."
    )]
    fn save_video_qa_report(
        &self,
        Parameters(_params): Parameters<VideoQaReportParams>,
    ) -> CallToolResult {
        structured_error(
            "unsupported_operation",
            "QA reports can only be produced by the deterministic evaluator",
        )
    }

    #[tool(description = "Read a persisted Video QA report by ID.")]
    fn get_video_qa_report(
        &self,
        Parameters(params): Parameters<VideoQaReportIdParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_qa_report(&params.report_id) {
                Ok(Some(report)) => structured_success(serde_json::to_value(report).unwrap()),
                Ok(None) => structured_error("not_found", "Video QA report was not found"),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "List persisted legacy Video QA reports for a project.")]
    fn list_video_qa_reports(
        &self,
        Parameters(params): Parameters<VideoProjectLimitParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_qa_reports(&params.project_id, params.limit) {
                Ok(reports) => structured_success(serde_json::to_value(reports).unwrap()),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Run deterministic QA against one exact ready EDL revision using its installed profile; poll video_job_status for the durable result."
    )]
    fn fina_video_qa_run(
        &self,
        Parameters(params): Parameters<VideoQaRunParams>,
    ) -> CallToolResult {
        if params.timeline_ref.id.trim().is_empty()
            || params.timeline_ref.revision == 0
            || params.request_id.trim().is_empty()
        {
            return structured_error(
                "invalid_argument",
                "timeline_ref must be exact and request_id non-empty",
            );
        }
        let mut service = match self.service.lock() {
            Ok(s) => s,
            Err(_) => return structured_error("internal", "NIP service lock failed"),
        };
        let root = env::var_os("NIP_MEDIA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| service.config().data_dir().join("media"));
        let request = nip_engine::video_qa_adapter::VideoQaRunRequest {
            timeline_ref: nip_engine::video_edl::Ref {
                id: params.timeline_ref.id,
                revision: params.timeline_ref.revision,
            },
            qa_profile_id: params.qa_profile_id,
            request_id: params.request_id,
        };
        match service.run_video_qa(&root, &request) {
            Ok(v) => structured_success(v),
            Err(e) => structured_error("video_qa_run_failed", e.to_string()),
        }
    }

    #[tool(
        description = "Read one immutable evaluator-produced QA report by exact report reference."
    )]
    fn fina_video_qa_get(
        &self,
        Parameters(params): Parameters<VideoQaGetParams>,
    ) -> CallToolResult {
        if params.report_ref.revision != 1 {
            return structured_error("not_found", "QA report revision was not found");
        }
        match self.service.lock() {
            Ok(service) => match service.video_qa_stored_report(&params.report_ref.id) {
                Ok(Some(stored)) => match serde_json::from_str::<Value>(&stored.report_json) {
                    Ok(v) => structured_success(v),
                    Err(_) => {
                        structured_error("storage_unavailable", "stored QA report is invalid")
                    }
                },
                Ok(None) => structured_error("not_found", "QA report was not found"),
                Err(e) => structured_error("storage_unavailable", e.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Build a deterministic, revision-pinned fina.edl.v1 timeline from exact project/episode/storyboard, shot, asset and evidence refs using an installed output profile. Caller paths, dimensions and FFmpeg options are not accepted; blocked builds return stable findings and are never persisted as ready."
    )]
    fn fina_video_export_profiles_list(
        &self,
        Parameters(params): Parameters<VideoExportProfilesParams>,
    ) -> CallToolResult {
        if params
            .purpose
            .as_deref()
            .is_some_and(|purpose| purpose != "preview")
        {
            return structured_success(json!({"profiles": []}));
        }
        match self.service.lock() {
            Ok(service) => structured_success(json!({"profiles": service.video_export_profiles()})),
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Read-only preflight for one exact EDL revision, evaluator-produced QA report and installed export profile. No job or output is created."
    )]
    fn fina_video_export_preflight(
        &self,
        Parameters(params): Parameters<VideoExportPreflightParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => {
                let root = env::var_os("NIP_MEDIA_DIR")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| service.config().data_dir().join("media"));
                let request = nip_engine::video_export_producer::ExportRequest {
                    timeline_ref: nip_engine::video_edl::Ref {
                        id: params.timeline_ref.id,
                        revision: params.timeline_ref.revision,
                    },
                    qa_report_ref: nip_engine::video_edl::Ref {
                        id: params.qa_report_ref.id,
                        revision: params.qa_report_ref.revision,
                    },
                    export_profile_id: params.export_profile_id,
                };
                match service.video_export_preflight(&root, &request) {
                    Ok(value) => structured_success(value),
                    Err(error) => structured_error(export_error_code(&error), error),
                }
            }
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Start a profile-gated local FFmpeg export as a durable video job. Caller paths and FFmpeg options are not accepted; poll video_job_status for completion."
    )]
    fn fina_video_export_start(
        &self,
        Parameters(params): Parameters<VideoExportStartParams>,
    ) -> CallToolResult {
        if params.timeline_ref.id.trim().is_empty()
            || params.timeline_ref.revision == 0
            || params.qa_report_ref.id.trim().is_empty()
            || params.qa_report_ref.revision != 1
            || params.request_id.trim().is_empty()
        {
            return structured_error(
                "invalid_argument",
                "exact timeline/QA refs and request_id are required",
            );
        }
        let mut service = match self.service.lock() {
            Ok(service) => service,
            Err(_) => return structured_error("internal", "NIP service lock failed"),
        };
        let root = env::var_os("NIP_MEDIA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| service.config().data_dir().join("media"));
        let request = nip_engine::video_export_producer::ExportStartRequest {
            timeline_ref: nip_engine::video_edl::Ref {
                id: params.timeline_ref.id,
                revision: params.timeline_ref.revision,
            },
            qa_report_ref: nip_engine::video_edl::Ref {
                id: params.qa_report_ref.id,
                revision: params.qa_report_ref.revision,
            },
            export_profile_id: params.export_profile_id,
            request_id: params.request_id,
        };
        let (result, created) = match service.start_video_export(&root, &request) {
            Ok(result) => result,
            Err(error) => return structured_error(export_error_code(&error), error),
        };
        let Some(job_id) = result["job"]["job_id"].as_str().map(str::to_owned) else {
            return structured_error("internal", "durable export job handle was not returned");
        };
        if !created {
            return structured_success(result);
        }
        let cancel = Arc::new(AtomicBool::new(false));
        if let Ok(mut flags) = self.video_cancel.lock() {
            flags.insert(job_id.clone(), cancel.clone());
        }
        drop(service);
        spawn_video_export_job(
            self.service.clone(),
            self.video_cancel.clone(),
            root,
            request,
            job_id,
            cancel,
        );
        structured_success(result)
    }

    #[tool(
        description = "Read one exact immutable export manifest produced by the verified export worker."
    )]
    fn fina_video_export_get(
        &self,
        Parameters(params): Parameters<VideoExportManifestGetParams>,
    ) -> CallToolResult {
        if params.manifest_ref.revision != 1 {
            return structured_error("not_found", "export manifest revision was not found");
        }
        match self.service.lock() {
            Ok(service) => match service.video_export_manifest_v1(&params.manifest_ref.id) {
                Ok(Some(manifest)) => structured_success(serde_json::to_value(manifest).unwrap()),
                Ok(None) => structured_error("not_found", "producer export manifest was not found"),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "List producer-created immutable export manifests for one exact project revision."
    )]
    fn fina_video_export_list(
        &self,
        Parameters(params): Parameters<VideoExportManifestListParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_export_manifests_v1(
                &params.project_ref.id,
                params.project_ref.revision,
                params.limit,
            ) {
                Ok(manifests) => structured_success(json!({"manifests": manifests})),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Build a deterministic, revision-pinned fina.edl.v1 timeline from exact project/episode/storyboard, shot, asset and evidence refs using an installed output profile. Caller paths, dimensions and FFmpeg options are not accepted; blocked builds return stable findings and are never persisted as ready."
    )]
    fn fina_video_timeline_build(
        &self,
        Parameters(params): Parameters<VideoTimelineBuildParams>,
    ) -> CallToolResult {
        let value = json!({"project_ref":params.project_ref,"episode_ref":params.episode_ref,"storyboard_ref":params.storyboard_ref,"output_profile_id":params.output_profile_id,"video_tracks":params.video_tracks,"audio_tracks":params.audio_tracks,"caption_tracks":params.caption_tracks,"gap_policy":params.gap_policy,"request_id":params.request_id});
        let request =
            match parse_video_value::<nip_engine::video_edl::VideoTimelineBuildRequest>(value) {
                Ok(v) => v,
                Err(e) => return structured_error("invalid_request", e),
            };
        match self.service.lock() {
            Ok(mut service) => match service.build_video_timeline_edl(&request) {
                Ok(result) => structured_success(serde_json::to_value(result).unwrap()),
                Err(error) => {
                    let text = error.to_string();
                    let code = if text.contains("ownership")
                        || text.contains("idempotency")
                        || text.contains("profile")
                        || text.contains("gap_policy")
                        || text.contains("request_id")
                    {
                        "invalid_request"
                    } else {
                        "video_edl_build_failed"
                    };
                    structured_error(code, text)
                }
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "Read back one exact immutable ready native EDL revision.")]
    fn fina_video_timeline_get(
        &self,
        Parameters(params): Parameters<VideoEdlGetParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service
                .video_edl_timeline(&params.timeline_ref.id, params.timeline_ref.revision)
            {
                Ok(Some(record)) => {
                    let manifest: Value =
                        serde_json::from_str(&record.manifest_json).unwrap_or(Value::Null);
                    let findings: Value =
                        serde_json::from_str(&record.findings_json).unwrap_or(json!([]));
                    structured_success(
                        json!({"timeline_id":record.timeline_id,"revision":record.revision,"created_at":record.created_at,"build_version":record.build_version,"build_status":record.build_status,"build_findings":findings,"timeline_hash":record.timeline_hash,"input_fingerprint":record.input_fingerprint,"edl":manifest}),
                    )
                }
                Ok(None) => {
                    structured_error("not_found", "Native EDL timeline revision was not found")
                }
                Err(e) => structured_error("storage_unavailable", e.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "List immutable native EDL revision summaries for one exact project revision."
    )]
    fn fina_video_timeline_list(
        &self,
        Parameters(params): Parameters<VideoEdlListParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_edl_timelines(
                &params.project_ref.id,
                params.project_ref.revision,
                params.limit,
            ) {
                Ok(records) => structured_success(
                    json!({"timelines":records.into_iter().map(|r|json!({"timeline_ref":{"id":r.timeline_id,"revision":r.revision},"project_ref":{"id":r.project_id,"revision":r.project_revision},"episode_ref":{"id":r.episode_id,"revision":r.episode_revision},"storyboard_ref":{"id":r.storyboard_id,"revision":r.storyboard_revision},"output_profile_ref":{"id":r.profile_id,"revision":r.profile_revision},"build_status":r.build_status,"timeline_hash":r.timeline_hash,"input_fingerprint":r.input_fingerprint,"created_at":r.created_at})).collect::<Vec<_>>()}),
                ),
                Err(e) => structured_error("storage_unavailable", e.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Persist a typed deterministic Video timeline/EDL plan. Clips must reference project shots and any selected asset revisions."
    )]
    fn save_video_timeline(
        &self,
        Parameters(params): Parameters<VideoTimelineParams>,
    ) -> CallToolResult {
        let timeline = match parse_video_value::<VideoTimeline>(params.timeline) {
            Ok(value) => value,
            Err(error) => return structured_error("invalid_request", error),
        };
        match self.service.lock() {
            Ok(mut service) => match service.save_video_timeline(&timeline) {
                Ok(()) => structured_success(serde_json::to_value(timeline).unwrap()),
                Err(error) => structured_error("video_timeline_rejected", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "Read one persisted Video timeline/EDL plan revision.")]
    fn get_video_timeline(
        &self,
        Parameters(params): Parameters<VideoTimelineIdParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_timeline(&params.timeline_id, params.revision) {
                Ok(Some(timeline)) => structured_success(serde_json::to_value(timeline).unwrap()),
                Ok(None) => structured_error("not_found", "Video timeline was not found"),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "List persisted Video timeline/EDL plans for a project.")]
    fn list_video_timelines(
        &self,
        Parameters(params): Parameters<VideoProjectLimitParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_timelines(&params.project_id, params.limit) {
                Ok(timelines) => structured_success(serde_json::to_value(timelines).unwrap()),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Queue a bounded LinkZag MP4 for an ordered set of exact saved VideoVisualSpec revisions (or one legacy spec). All slides must belong to one project and episode; produced assets inherit validated lineage. capture_mode defaults to flash (real-time recordVideo, may drop frames); choose full for deterministic timestamped screenshots. Poll video_job_status."
    )]
    fn render_video_linkzag(
        &self,
        Parameters(params): Parameters<LinkZagRenderParams>,
    ) -> CallToolResult {
        let capture_mode = params.capture_mode;
        let references = if let Some(references) = params.visual_specs {
            if params.visual_spec_id.is_some() || params.visual_spec_revision.is_some() {
                return structured_error(
                    "invalid_request",
                    "provide visual_specs or one legacy visual_spec_id/revision pair, not both",
                );
            }
            references
        } else {
            match (params.visual_spec_id, params.visual_spec_revision) {
                (Some(spec_id), Some(revision)) => vec![VideoVisualSpecRefParams { spec_id, revision }],
                _ => return structured_error("invalid_request", "provide an ordered visual_specs list or both visual_spec_id and visual_spec_revision"),
            }
        };
        if references.is_empty() || references.len() > 24 {
            return structured_error(
                "invalid_request",
                "a storyboard render requires between 1 and 24 VisualSpec revisions",
            );
        }
        if references
            .iter()
            .any(|reference| reference.spec_id.trim().is_empty() || reference.revision == 0)
        {
            return structured_error(
                "invalid_request",
                "each VisualSpec reference requires a non-empty ID and positive revision",
            );
        }
        if references.iter().enumerate().any(|(index, reference)| {
            references[..index].iter().any(|prior| {
                prior.spec_id.trim() == reference.spec_id.trim()
                    && prior.revision == reference.revision
            })
        }) {
            return structured_error(
                "invalid_request",
                "duplicate VisualSpec revisions are not allowed in a storyboard render",
            );
        }
        let job_id = format!(
            "video-linkzag-{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let now = Utc::now();
        let job = VideoJob {
            job_id: job_id.clone(),
            operation: "linkzag.storyboard".into(),
            status: "queued".into(),
            input_revision: references.iter().map(|reference| reference.revision).max(),
            progress_millis: 0,
            cancellation_requested: false,
            resource_estimate: None,
            output_manifest: None,
            safe_error_message: None,
            started_at: None,
            finished_at: None,
            created_at: now,
        };
        let mut service = match self.service.lock() {
            Ok(service) => service,
            Err(_) => return structured_error("internal", "NIP service lock failed"),
        };
        let mut typed_specs = Vec::with_capacity(references.len());
        for reference in &references {
            let spec = match service.video_visual_spec(reference.spec_id.trim(), reference.revision)
            {
                Ok(Some(spec)) => spec,
                Ok(None) => {
                    return structured_error(
                        "invalid_request",
                        "a requested VideoVisualSpec revision was not found",
                    )
                }
                Err(error) => return structured_error("storage_unavailable", error.to_string()),
            };
            if references.len() > 1 && spec.scene_id.as_deref().is_none_or(str::is_empty) {
                return structured_error(
                    "invalid_request",
                    "each storyboard VisualSpec must reference a persisted scene",
                );
            }
            if let Some(first) = typed_specs.first() {
                let first: &VideoVisualSpec = first;
                if spec.project_id != first.project_id || spec.episode_id != first.episode_id {
                    return structured_error(
                        "invalid_request",
                        "all storyboard VisualSpecs must belong to the same project and episode",
                    );
                }
                if spec.width != first.width || spec.height != first.height || spec.fps != first.fps
                {
                    return structured_error(
                        "invalid_request",
                        "all storyboard VisualSpecs must use the same frame dimensions and rate",
                    );
                }
            }
            typed_specs.push(spec);
        }
        let visual_specs = match serde_json::to_value(&typed_specs) {
            Ok(value) => value,
            Err(error) => return structured_error("internal", error.to_string()),
        };
        let mut job = job;
        job.resource_estimate = Some(json!({
            "visual_specs": visual_specs,
            "capture_mode": capture_mode.as_str()
        }));
        if let Err(error) = service.save_video_job(&job) {
            return structured_error("video_job_rejected", error.to_string());
        }
        drop(service);
        let cancel = Arc::new(AtomicBool::new(false));
        self.video_cancel
            .lock()
            .ok()
            .map(|mut flags| flags.insert(job_id.clone(), cancel.clone()));
        spawn_video_linkzag_job(
            self.service.clone(),
            self.video_cancel.clone(),
            job_id.clone(),
            job.resource_estimate.clone().unwrap_or(Value::Null),
            cancel,
        );
        structured_success(
            json!({ "job_id": job_id, "status": "queued", "poll_tool": "video_job_status" }),
        )
    }

    #[tool(
        description = "Read one asynchronous Video job, including progress, cancellation state, output manifest, and safe error."
    )]
    fn video_job_status(&self, Parameters(params): Parameters<VideoJobIdParams>) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_job(&params.job_id) {
                Ok(Some(job)) => structured_success(serde_json::to_value(job).unwrap()),
                Ok(None) => structured_error("not_found", "Video job was not found"),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "List recent asynchronous Video jobs.")]
    fn list_video_jobs(&self, Parameters(params): Parameters<VideoLimitParams>) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_jobs(params.limit) {
                Ok(jobs) => structured_success(serde_json::to_value(jobs).unwrap()),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "Request cooperative cancellation of an active Video job.")]
    fn cancel_video_job(&self, Parameters(params): Parameters<VideoJobIdParams>) -> CallToolResult {
        if let Ok(flags) = self.video_cancel.lock() {
            if let Some(flag) = flags.get(&params.job_id) {
                flag.store(true, Ordering::SeqCst);
            }
        }
        match self.service.lock() {
            Ok(mut service) => match service.video_job(&params.job_id) {
                Ok(Some(mut job))
                    if !matches!(job.status.as_str(), "succeeded" | "failed" | "cancelled") =>
                {
                    job.cancellation_requested = true;
                    let _ = service.save_video_job(&job);
                    structured_success(
                        json!({ "job_id": job.job_id, "status": job.status, "cancellation_requested": true }),
                    )
                }
                Ok(Some(job)) => structured_success(
                    json!({ "job_id": job.job_id, "status": job.status, "cancellation_requested": false }),
                ),
                Ok(None) => structured_error("not_found", "Video job was not found"),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Retry a failed or cancelled Video job as a new durable attempt using its persisted visual specification."
    )]
    fn retry_video_job(&self, Parameters(params): Parameters<VideoJobIdParams>) -> CallToolResult {
        let previous = match self.service.lock() {
            Ok(service) => match service.video_job(&params.job_id) {
                Ok(Some(job)) => job,
                Ok(None) => return structured_error("not_found", "Video job was not found"),
                Err(error) => return structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => return structured_error("internal", "NIP service lock failed"),
        };
        if !matches!(previous.status.as_str(), "failed" | "cancelled") {
            return structured_error(
                "invalid_request",
                "only failed or cancelled Video jobs can be retried",
            );
        }
        let visual_spec = previous
            .resource_estimate
            .clone()
            .unwrap_or_else(|| json!({}));
        let retry_id = format!(
            "{}-retry-{}",
            previous.job_id,
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        );
        let job = VideoJob {
            job_id: retry_id.clone(),
            operation: previous.operation,
            status: "queued".into(),
            input_revision: previous.input_revision,
            progress_millis: 0,
            cancellation_requested: false,
            resource_estimate: Some(visual_spec.clone()),
            output_manifest: None,
            safe_error_message: None,
            started_at: None,
            finished_at: None,
            created_at: Utc::now(),
        };
        if let Ok(mut service) = self.service.lock() {
            if let Err(error) = service.save_video_job(&job) {
                return structured_error("video_job_rejected", error.to_string());
            }
        } else {
            return structured_error("internal", "NIP service lock failed");
        }
        let cancel = Arc::new(AtomicBool::new(false));
        self.video_cancel
            .lock()
            .ok()
            .map(|mut flags| flags.insert(retry_id.clone(), cancel.clone()));
        spawn_video_linkzag_job(
            self.service.clone(),
            self.video_cancel.clone(),
            retry_id.clone(),
            visual_spec,
            cancel,
        );
        structured_success(
            json!({ "job_id": retry_id, "retry_of": previous.job_id, "status": "queued" }),
        )
    }

    #[tool(description = "List the current revision of every Video Workspace project.")]
    fn list_video_projects(&self) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_projects() {
                Ok(projects) => structured_success(serde_json::to_value(projects).unwrap()),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Create the first revision or append the next immutable revision of a Video project."
    )]
    fn create_video_project(
        &self,
        Parameters(params): Parameters<VideoProjectParams>,
    ) -> CallToolResult {
        let project = match parse_video_value(params.project) {
            Ok(value) => value,
            Err(error) => return structured_error("invalid_request", error),
        };
        match self.service.lock() {
            Ok(mut service) => match service.save_video_project(&project) {
                Ok(()) => structured_success(serde_json::to_value(project).unwrap()),
                Err(error) => structured_error("video_project_rejected", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "Get the current immutable revision of a Video project.")]
    fn get_video_project(
        &self,
        Parameters(params): Parameters<VideoProjectIdParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_project(&params.project_id) {
                Ok(Some(project)) => structured_success(serde_json::to_value(project).unwrap()),
                Ok(None) => structured_error("not_found", "Video project was not found"),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Create the first revision or append the next immutable revision of a Video episode."
    )]
    fn create_video_episode(
        &self,
        Parameters(params): Parameters<VideoEpisodeParams>,
    ) -> CallToolResult {
        let episode = match parse_video_value(params.episode) {
            Ok(value) => value,
            Err(error) => return structured_error("invalid_request", error),
        };
        match self.service.lock() {
            Ok(mut service) => match service.save_video_episode(&episode) {
                Ok(()) => structured_success(serde_json::to_value(episode).unwrap()),
                Err(error) => structured_error("video_episode_rejected", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "Link an episode revision to an existing canonical NIP event or claim.")]
    fn link_video_evidence(
        &self,
        Parameters(params): Parameters<VideoEvidenceParams>,
    ) -> CallToolResult {
        let evidence = match parse_video_value(params.evidence) {
            Ok(value) => value,
            Err(error) => return structured_error("invalid_request", error),
        };
        match self.service.lock() {
            Ok(mut service) => match service.link_video_evidence(
                &params.episode_id,
                params.episode_revision,
                &evidence,
            ) {
                Ok(()) => structured_success(
                    json!({ "episode_id": params.episode_id, "episode_revision": params.episode_revision, "evidence": evidence }),
                ),
                Err(error) => structured_error("video_evidence_rejected", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "List evidence links for an episode revision.")]
    fn list_video_evidence(
        &self,
        Parameters(params): Parameters<VideoEvidenceListParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => {
                match service.video_evidence(&params.episode_id, params.episode_revision) {
                    Ok(evidence) => structured_success(serde_json::to_value(evidence).unwrap()),
                    Err(error) => structured_error("storage_unavailable", error.to_string()),
                }
            }
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Save a versioned Video narrative attached to a persisted episode; the episode preserves its owning project identity."
    )]
    fn save_video_narrative(
        &self,
        Parameters(params): Parameters<VideoNarrativeParams>,
    ) -> CallToolResult {
        let narrative = match parse_video_value::<VideoNarrative>(params.narrative) {
            Ok(value) => value,
            Err(error) => return structured_error("invalid_request", error),
        };
        match self.service.lock() {
            Ok(mut service) => match service.save_video_narrative(&narrative) {
                Ok(()) => structured_success(serde_json::to_value(narrative).unwrap()),
                Err(error) => structured_error("video_narrative_rejected", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "Read the latest persisted revision of one Video narrative.")]
    fn get_video_narrative(
        &self,
        Parameters(params): Parameters<VideoNarrativeIdParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_narrative(&params.narrative_id) {
                Ok(Some(narrative)) => structured_success(serde_json::to_value(narrative).unwrap()),
                Ok(None) => structured_error("not_found", "Video narrative was not found"),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "List the latest Video narrative revisions for one persisted episode.")]
    fn list_video_narratives(
        &self,
        Parameters(params): Parameters<VideoNarrativeListParams>,
    ) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.video_narratives(&params.episode_id, params.limit) {
                Ok(narratives) => structured_success(serde_json::to_value(narratives).unwrap()),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "Save a versioned Video storyboard record.")]
    fn save_video_storyboard(
        &self,
        Parameters(params): Parameters<VideoStoryboardParams>,
    ) -> CallToolResult {
        let storyboard = match parse_video_value(params.storyboard) {
            Ok(value) => value,
            Err(error) => return structured_error("invalid_request", error),
        };
        match self.service.lock() {
            Ok(mut service) => match service.save_video_storyboard(&storyboard) {
                Ok(()) => structured_success(serde_json::to_value(storyboard).unwrap()),
                Err(error) => structured_error("video_storyboard_rejected", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "Save a versioned Video scene record.")]
    fn save_video_scene(&self, Parameters(params): Parameters<VideoSceneParams>) -> CallToolResult {
        let scene = match parse_video_value(params.scene) {
            Ok(value) => value,
            Err(error) => return structured_error("invalid_request", error),
        };
        match self.service.lock() {
            Ok(mut service) => match service.save_video_scene(&scene) {
                Ok(()) => structured_success(serde_json::to_value(scene).unwrap()),
                Err(error) => structured_error("video_scene_rejected", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(description = "Save a versioned Video shot record.")]
    fn save_video_shot(&self, Parameters(params): Parameters<VideoShotParams>) -> CallToolResult {
        let shot = match parse_video_value(params.shot) {
            Ok(value) => value,
            Err(error) => return structured_error("invalid_request", error),
        };
        match self.service.lock() {
            Ok(mut service) => match service.save_video_shot(&shot) {
                Ok(()) => structured_success(serde_json::to_value(shot).unwrap()),
                Err(error) => structured_error("video_shot_rejected", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

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
        let prepared = match self.service.lock() {
            Ok(mut service) => service.prepare_claim_extraction(&params.event_id),
            Err(_) => return structured_error("internal", "NIP service lock failed"),
        };
        let prepared = match prepared {
            Ok(prepared) => prepared,
            Err(error) => return structured_error("extraction_unavailable", error.to_string()),
        };
        // A long transcript can keep the provider busy for minutes. Holding the
        // service lock here froze health, events and every other projection in
        // the Narrative workspace for the whole run.
        let claims = match prepared.extract() {
            Ok(claims) => claims,
            Err(error) => return structured_error("extraction_unavailable", error_chain(&error)),
        };
        match self.service.lock() {
            Ok(mut service) => match service.commit_extracted_claims(&claims) {
                Ok(()) => structured_success(serde_json::to_value(&claims).unwrap()),
                Err(error) => structured_error("storage_unavailable", error_chain(&error)),
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

    #[tool(
        description = "Refresh every active podcast feed now, ignoring the six-hour poll window so newly parsed metadata is recorded."
    )]
    fn refresh_podcast_feeds(&self) -> CallToolResult {
        let client = HttpFeedClient::default();
        match self.service.lock() {
            Ok(mut service) => match service.refresh_active_podcast_feeds(&client, Utc::now()) {
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
            Ok(mut service) => match service.create_source(draft, &client, Utc::now()) {
                Ok(source) => structured_success(serde_json::to_value(source).unwrap()),
                Err(error) => structured_error("create_failed", error.to_string()),
            },
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
        description = "Transcribe an approved episode: a publisher-provided transcript (Podcasting 2.0 <podcast:transcript>) is used when the feed advertises one, otherwise the enclosure is downloaded and transcribed with the configured local ASR provider (NIP_COMFYUI_URL, or the running ComfyUI Desktop discovered on loopback), or the deterministic fixture in NIP_TEST_MODE. No remote ASR fallback."
    )]
    fn transcribe_podcast_episode(
        &self,
        Parameters(params): Parameters<EpisodeParams>,
    ) -> CallToolResult {
        let (episode, test_mode, comfyui_url, staging_root, render_script, chunk_seconds) = {
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
                Err(error) => return structured_error("storage_unavailable", error.to_string()),
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
                .resolve_comfyui_url()
                .map(|url| url.as_str().to_owned());
            let staging_root = service.config().asr_staging_root();
            let render_script = service.config().comfy().render_script().to_path_buf();
            let chunk_seconds = service.config().comfy().chunk_seconds();
            (
                episode,
                test_mode,
                comfyui_url,
                staging_root,
                render_script,
                chunk_seconds,
            )
        };

        if test_mode {
            let mut service = match self.service.lock() {
                Ok(service) => service,
                Err(_) => return structured_error("internal", "NIP service lock failed"),
            };
            let client = HttpAudioClient::for_test();
            let provider =
                match DeterministicFakeAsrProvider::new(test_asr_transcript(), Some("en".into())) {
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

        // Publisher transcripts are authored text, cost one request and need no
        // GPU, so they are tried before an ASR endpoint is required at all.
        {
            let mut service = match self.service.lock() {
                Ok(service) => service,
                Err(_) => return structured_error("internal", "NIP service lock failed"),
            };
            let client = HttpAudioClient::default();
            match service.publisher_transcript(&episode, &client, Utc::now()) {
                Ok(Some(transcript)) => {
                    return structured_success(serde_json::to_value(transcript).unwrap())
                }
                Ok(None) => {}
                Err(error) => return transcription_error(error),
            }
        }

        let Some(comfyui_url) = comfyui_url else {
            return structured_error(
                "transcription_unavailable",
                "local ASR is unavailable; start ComfyUI Desktop or set NIP_COMFYUI_URL to a loopback server running the Qwen3-ASR workflow",
            );
        };
        let request = match podcast_asr_request(&episode, &HttpAudioClient::default()) {
            Ok(request) => request,
            Err(error) => return transcription_error(error),
        };
        let provider = match ComfyUiAsrProvider::with_render_script(
            &comfyui_url,
            staging_root,
            render_script,
            chunk_seconds,
        ) {
            Ok(provider) => provider,
            Err(error) => return structured_error("transcription_unavailable", error.to_string()),
        };
        // Serialize with background jobs: one GPU, one ASR run.
        let _gate = match self.gate.lock() {
            Ok(gate) => gate,
            Err(_) => return structured_error("internal", "the local ASR slot lock failed"),
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
        description = "Report whether local ASR is ready: the external comfy pack CLI, its workspace/commit, Python, ffmpeg, the loopback ComfyUI server and the Qwen3-ASR nodes. Returns exact blockers and next actions instead of a dead button."
    )]
    fn nip_asr_status(&self) -> CallToolResult {
        let status = match self.service.lock() {
            Ok(service) => ComfyAsrStatus::collect(service.config()),
            Err(_) => return structured_error("internal", "NIP service lock failed"),
        };
        structured_success(serde_json::to_value(status).unwrap())
    }

    #[tool(
        description = "Clone the configured comfy workflow pack (NIP_COMFY_REPO) into NIP_COMFY_DIR when the CLI is missing. Never overwrites a non-empty directory."
    )]
    fn ensure_comfy_workspace(&self) -> CallToolResult {
        let report: Result<ComfyWorkspaceReport, String> = match self.service.lock() {
            Ok(service) => comfy::ensure_workspace(service.config()),
            Err(_) => return structured_error("internal", "NIP service lock failed"),
        };
        match report {
            Ok(report) => structured_success(serde_json::to_value(report).unwrap()),
            Err(message) => structured_error("comfy_workspace_unavailable", message),
        }
    }

    #[tool(
        description = "Start a long-running local transcription job and return immediately. Poll podcast_transcription_status for the current step (download, split, chunk progress, commit), cached audio, transcript preview, warnings and the exact failing step."
    )]
    fn start_podcast_transcription(
        &self,
        Parameters(params): Parameters<StartTranscriptionParams>,
    ) -> CallToolResult {
        let (episode, context) = {
            let service = match self.service.lock() {
                Ok(service) => service,
                Err(_) => return structured_error("internal", "NIP service lock failed"),
            };
            let source_id = match SourceId::new(params.source_id.clone()) {
                Ok(source) => source,
                Err(error) => return structured_error("invalid_request", error.message),
            };
            let episodes = match service.podcast_episodes(&source_id) {
                Ok(episodes) => episodes,
                Err(error) => return structured_error("storage_unavailable", error.to_string()),
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
            let config = service.config();
            if !config.test_mode() && episode.transcript_url.is_none() {
                if config.resolve_comfyui_url().is_none() {
                    return structured_error(
                        "transcription_unavailable",
                        "no loopback ComfyUI endpoint was resolved; start ComfyUI Desktop or set NIP_COMFYUI_URL, then call nip_asr_status for the exact blockers",
                    );
                }
                if !config.comfy().ready() {
                    return structured_error(
                        "transcription_unavailable",
                        format!(
                            "the comfy pack CLI is missing at {}; call nip_asr_status or ensure_comfy_workspace",
                            config.comfy().render_script().display()
                        ),
                    );
                }
            }
            (
                episode.clone(),
                JobContext {
                    test_mode: config.test_mode(),
                    comfyui_url: config
                        .resolve_comfyui_url()
                        .map(|url| url.as_str().to_owned()),
                    render_script: config.comfy().render_script().to_path_buf(),
                    staging_root: config.asr_staging_root(),
                    chunk_seconds: config.comfy().chunk_seconds(),
                },
            )
        };

        if let Some(active) = self.jobs.active_for(
            episode.source_id.as_str(),
            episode.source_native_id.as_deref(),
        ) {
            return structured_success(serde_json::to_value(active).unwrap());
        }

        let job_id = format!("job-{}", Utc::now().timestamp_millis());
        let now = Utc::now();
        let job = TranscriptionJob {
            job_id: job_id.clone(),
            source_id: episode.source_id.as_str().to_owned(),
            source_native_id: episode.source_native_id.clone(),
            canonical_url: episode.canonical_url.clone(),
            title: episode.title.clone(),
            state: "queued".into(),
            step: "queued".into(),
            detail: Some("waiting for the local ASR slot".into()),
            error_code: None,
            error_message: None,
            audio_bytes: None,
            audio_content_type: None,
            audio_path: None,
            audio_url_path: None,
            audio_duration_seconds: None,
            chunks_total: None,
            chunks_completed: 0,
            transcript_characters: None,
            transcript_preview: None,
            transcript_path: None,
            event_id: None,
            warnings: Vec::new(),
            started_at: now,
            updated_at: now,
            finished_at: None,
            events: Vec::new(),
        };
        let job = self.jobs.create(job);
        spawn_transcription_job(
            self.service.clone(),
            self.jobs.clone(),
            self.gate.clone(),
            episode,
            job_id,
            context,
        );
        structured_success(serde_json::to_value(job).unwrap())
    }

    #[tool(
        description = "Read one transcription job: current step, chunk progress, cached audio path/size/duration, transcript preview and every warning/error event."
    )]
    fn podcast_transcription_status(
        &self,
        Parameters(params): Parameters<TranscriptionJobParams>,
    ) -> CallToolResult {
        match self.jobs.get(&params.job_id) {
            Some(job) => structured_success(serde_json::to_value(job).unwrap()),
            None => structured_error("not_found", "transcription job was not found"),
        }
    }

    #[tool(
        description = "List recent transcription jobs (newest first) with their stage, cached audio, transcript preview and errors, so an operator can review what was downloaded and transcribed."
    )]
    fn list_podcast_transcription_jobs(
        &self,
        Parameters(params): Parameters<ListTranscriptionJobsParams>,
    ) -> CallToolResult {
        let jobs = self.jobs.list(
            params.source_id.as_deref(),
            params.limit.unwrap_or(20) as usize,
        );
        structured_success(serde_json::to_value(jobs).unwrap())
    }

    #[tool(
        description = "Request cancellation of a running transcription job. The pack CLI is terminated; the episode stays awaiting a retry."
    )]
    fn cancel_podcast_transcription(
        &self,
        Parameters(params): Parameters<TranscriptionJobParams>,
    ) -> CallToolResult {
        match self.jobs.cancel(&params.job_id) {
            Some(mut job) => {
                if !job.is_terminal() {
                    self.jobs.update(&params.job_id, |job| {
                        job.record(
                            "warn",
                            "cancelled",
                            "cancellation requested; stopping the local ASR CLI",
                        );
                    });
                    job = self.jobs.get(&params.job_id).unwrap_or(job);
                }
                structured_success(serde_json::to_value(job).unwrap())
            }
            None => structured_error("not_found", "transcription job was not found"),
        }
    }

    #[tool(
        description = "Return the retained transcript event committed for a podcast episode, so the UI can open the origin instead of only saying a transcript exists."
    )]
    fn find_podcast_episode_event(
        &self,
        Parameters(params): Parameters<FindEpisodeEventParams>,
    ) -> CallToolResult {
        let service = match self.service.lock() {
            Ok(service) => service,
            Err(_) => return structured_error("internal", "NIP service lock failed"),
        };
        let source_id = match SourceId::new(params.source_id.clone()) {
            Ok(source) => source,
            Err(error) => return structured_error("invalid_request", error.message),
        };
        let episodes = match service.podcast_episodes(&source_id) {
            Ok(episodes) => episodes,
            Err(error) => return structured_error("storage_unavailable", error.to_string()),
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
            return structured_success(json!({"event": null}));
        };
        match service.event_for_episode(&episode) {
            Ok(event) => structured_success(json!({"event": event})),
            Err(error) => structured_error("storage_unavailable", error.to_string()),
        }
    }

    #[tool(
        description = "Remove a transcription job report. With delete_artifacts=true the cached audio/transcript files are deleted too."
    )]
    fn delete_podcast_transcription_job(
        &self,
        Parameters(params): Parameters<RemoveTranscriptionJobParams>,
    ) -> CallToolResult {
        let removed = self.jobs.remove(&params.job_id, params.delete_artifacts);
        structured_success(json!({"removed": removed, "job_id": params.job_id}))
    }

    #[tool(
        description = "List cached audio/video artifacts (downloaded episode audio and any files the comfy pack produced) with a safe playback URL path, size, MIME type and job linkage."
    )]
    fn list_media_artifacts(
        &self,
        Parameters(params): Parameters<ListMediaParams>,
    ) -> CallToolResult {
        let root = match self.service.lock() {
            Ok(service) => service.config().asr_staging_root(),
            Err(_) => return structured_error("internal", "NIP service lock failed"),
        };
        let artifacts = media::list_artifacts(&root, params.limit.unwrap_or(50) as usize);
        structured_success(serde_json::to_value(artifacts).unwrap())
    }

    #[tool(
        description = "Delete one cached media artifact. Only files inside the NIP media cache with an audio/video extension can be removed."
    )]
    fn delete_media_artifact(
        &self,
        Parameters(params): Parameters<DeleteMediaParams>,
    ) -> CallToolResult {
        let root = match self.service.lock() {
            Ok(service) => service.config().asr_staging_root(),
            Err(_) => return structured_error("internal", "NIP service lock failed"),
        };
        match media::resolve_artifact(&root, &params.job_id, &params.name) {
            Ok(artifact) => match fs::remove_file(&artifact.path) {
                Ok(()) => structured_success(json!({"removed": true, "name": params.name})),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(message) => structured_error("not_found", message),
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

    #[tool(
        description = "Read one retained canonical event, including transcript text when available, by its immutable ID."
    )]
    fn get_event(&self, Parameters(params): Parameters<EventIdParams>) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.event(&params.event_id) {
                Ok(Some(event)) => structured_success(serde_json::to_value(event).unwrap()),
                Ok(None) => structured_error("not_found", "Retained event was not found"),
                Err(error) => structured_error("storage_unavailable", error.to_string()),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
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
                Err(error) => structured_error("derivation_failed", error_chain(&error)),
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
                Err(error) => structured_error("graph_unavailable", error_chain(&error)),
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
        description = "List persisted external-agent narratives, evidence-bound claim annotations and unresolved entity candidates with caller-declared, unattested model provenance."
    )]
    fn list_agent_narrative_analyses(&self) -> CallToolResult {
        match self.service.lock() {
            Ok(service) => match service.agent_narrative_analyses() {
                Ok(analyses) => structured_success(serde_json::to_value(analyses).unwrap()),
                Err(error) => structured_error("storage_unavailable", error_chain(&error)),
            },
            Err(_) => structured_error("internal", "NIP service lock failed"),
        }
    }

    #[tool(
        description = "Persist structured narrative, claims and entity candidates already generated by an external agent, then rebuild the evidence graph. This tool does not call an LLM or attest the caller-declared model. It rejects quotes that do not uniquely match the retained event transcript; entity identities remain unresolved candidates."
    )]
    fn build_agent_narrative_graph(
        &self,
        Parameters(params): Parameters<AgentNarrativeGraphParams>,
    ) -> CallToolResult {
        let draft = AgentNarrativeGraphDraft {
            event_id: params.event_id,
            producer: params.producer,
            model: params.model,
            prompt_version: params.prompt_version,
            narrative_title: params.narrative_title,
            narrative_thesis: params.narrative_thesis,
            narrative_summary: params.narrative_summary,
            entities: params
                .entities
                .into_iter()
                .map(|entity| AgentEntityDraft {
                    canonical_name: entity.canonical_name,
                    entity_type: entity.entity_type,
                    surface_form: entity.surface_form,
                    evidence_quote: entity.evidence_quote,
                })
                .collect(),
            claims: params
                .claims
                .into_iter()
                .map(|claim| AgentClaimDraft {
                    claim_text: claim.claim_text,
                    claim_type: claim.claim_type,
                    speaker_or_author: claim.speaker_or_author,
                    confidence_millis: claim.confidence_millis,
                    evidence_quote: claim.evidence_quote,
                    entity_names: claim.entity_names,
                    polarity: claim.polarity,
                    horizon: claim.horizon,
                })
                .collect(),
        };
        match self.service.lock() {
            Ok(mut service) => match service.build_agent_narrative_graph(draft) {
                Ok((analysis, claims, graph)) => structured_success(json!({
                    "analysis": analysis,
                    "claims": claims,
                    "graph": graph,
                })),
                Err(error) => structured_error("agent_graph_rejected", error_chain(&error)),
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
struct AgentNarrativeGraphParams {
    event_id: String,
    producer: String,
    model: String,
    prompt_version: String,
    narrative_title: String,
    narrative_thesis: String,
    narrative_summary: String,
    entities: Vec<AgentEntityGraphParams>,
    claims: Vec<AgentClaimGraphParams>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct AgentEntityGraphParams {
    canonical_name: String,
    entity_type: String,
    surface_form: String,
    evidence_quote: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct AgentClaimGraphParams {
    claim_text: String,
    claim_type: String,
    speaker_or_author: Option<String>,
    confidence_millis: u16,
    evidence_quote: String,
    entity_names: Vec<String>,
    polarity: Option<String>,
    horizon: Option<String>,
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

fn video_visual_spec_ref(value: &Value) -> Option<(&str, u32)> {
    let spec_id = value
        .get("visual_spec_id")
        .or_else(|| value.get("spec_id"))?
        .as_str()?
        .trim();
    let revision = value
        .get("visual_spec_revision")
        .or_else(|| value.get("revision"))?
        .as_u64()?
        .try_into()
        .ok()?;
    (!spec_id.is_empty() && revision > 0).then_some((spec_id, revision))
}

fn linkzag_asset_lineage(asset: &VideoAsset, specs: &[VideoVisualSpec]) -> Vec<VideoAssetLineage> {
    let mut lineage = Vec::new();
    for spec in specs {
        lineage.push(VideoAssetLineage {
            asset_id: asset.asset_id.clone(),
            asset_revision: asset.revision,
            upstream_kind: VideoAssetUpstreamKind::VisualSpec,
            upstream_id: spec.spec_id.clone(),
            upstream_revision: Some(spec.revision),
            relationship: "rendered_from".into(),
            input_hash: None,
            created_at: asset.created_at,
        });
        for source in &spec.sources {
            let upstream_kind = match source.source_kind {
                VideoVisualSourceKind::Event => VideoAssetUpstreamKind::Event,
                VideoVisualSourceKind::Claim => VideoAssetUpstreamKind::Claim,
                VideoVisualSourceKind::TranscriptSpan | VideoVisualSourceKind::SignalSnapshot => {
                    continue
                }
            };
            if lineage.iter().any(|record| {
                record.upstream_kind == upstream_kind
                    && record.upstream_id == source.source_id
                    && record.relationship == "source_evidence"
            }) {
                continue;
            }
            lineage.push(VideoAssetLineage {
                asset_id: asset.asset_id.clone(),
                asset_revision: asset.revision,
                upstream_kind,
                upstream_id: source.source_id.clone(),
                upstream_revision: None,
                relationship: "source_evidence".into(),
                input_hash: None,
                created_at: asset.created_at,
            });
        }
    }
    lineage
}

fn video_visual_spec_values(value: &Value) -> Vec<Value> {
    value
        .get("visual_specs")
        .and_then(Value::as_array)
        .filter(|specs| !specs.is_empty())
        .cloned()
        .unwrap_or_else(|| vec![value.clone()])
}

fn export_error_code(error: &str) -> &'static str {
    match error.split(':').next().unwrap_or("") {
        "invalid_argument" => "invalid_argument",
        "not_found" => "not_found",
        "revision_conflict" => "revision_conflict",
        "cross_project_reference" => "cross_project_reference",
        "profile_unavailable" => "profile_unavailable",
        "unsupported_profile" => "unsupported_profile",
        "timeline_invalid" => "timeline_invalid",
        "input_changed" => "input_changed",
        "stale_qa_report" => "stale_qa_report",
        "blocked_by_qa" => "blocked_by_qa",
        "rights_blocked" => "rights_blocked",
        "path_rejected" => "path_rejected",
        "media_integrity_failed" => "media_integrity_failed",
        "capability_unavailable" => "capability_unavailable",
        "resource_limit" => "resource_limit",
        "job_cancelled" => "job_cancelled",
        "export_failed" => "export_failed",
        "storage_unavailable" => "storage_unavailable",
        _ => "export_failed",
    }
}

fn spawn_video_export_job(
    service: Arc<Mutex<NipService>>,
    cancel_map: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    media_root: PathBuf,
    request: nip_engine::video_export_producer::ExportStartRequest,
    job_id: String,
    cancel: Arc<AtomicBool>,
) {
    let service_on_spawn_failure = service.clone();
    let cancel_map_on_worker = cancel_map.clone();
    let spawn_id = job_id.clone();
    let spawned = thread::Builder::new()
        .name(format!("video-export-{job_id}"))
        .spawn(move || {
            let mut plan = match service.lock() {
                Ok(service) => service.prepare_video_export_worker(&media_root, &request, &job_id),
                Err(_) => Err("storage_unavailable: NIP service lock failed".into()),
            };
            if let Ok(mut service) = service.lock() {
                if let Ok(Some(mut job)) = service.video_job(&job_id) {
                    job.status = "running".into();
                    job.started_at = Some(Utc::now());
                    job.progress_millis = 2_000;
                    if service.update_video_export_job(&job) != Ok(true) {
                        plan = Err("job_cancelled: export job is no longer active".into());
                    }
                }
            }
            if cancel.load(Ordering::SeqCst) {
                plan = Err("job_cancelled: export cancelled before execution".into());
            }
            let outcome = match plan {
                Ok(plan) => {
                    let progress_saved = match service.lock() {
                        Ok(mut service) => match service.video_job(&job_id) {
                            Ok(Some(mut job)) => {
                                job.progress_millis = 10_000;
                                service.update_video_export_job(&job) == Ok(true)
                            }
                            _ => false,
                        },
                        Err(_) => false,
                    };
                    if !progress_saved {
                        Err("job_cancelled: export job is no longer active".into())
                    } else {
                        nip_engine::video_export_producer::execute(&plan, &media_root, &cancel)
                            .map(|result| (plan, result))
                    }
                }
                Err(error) => Err(error),
            };
            match outcome {
                Ok((_plan, result)) => {
                    if let Ok(mut service) = service.lock() {
                        if let Ok(Some(mut job)) = service.video_job(&job_id) {
                            job.progress_millis = 90_000;
                            let _ = service.update_video_export_job(&job);
                        }
                        if let Err(error) = service.complete_video_export(&result, &job_id) {
                            let _ = fs::remove_file(&result.output_path);
                            let cancelled = error.starts_with("job_cancelled:");
                            let _ = service.fail_video_export(&job_id, &error, cancelled);
                        }
                    } else {
                        let _ = fs::remove_file(&result.output_path);
                    }
                }
                Err(error) => {
                    let cancelled =
                        error.starts_with("job_cancelled:") || cancel.load(Ordering::SeqCst);
                    if let Ok(mut service) = service.lock() {
                        let _ = service.fail_video_export(&job_id, &error, cancelled);
                    }
                }
            }
            if let Ok(mut flags) = cancel_map_on_worker.lock() {
                flags.remove(&job_id);
            }
        });
    if let Err(error) = spawned {
        if let Ok(mut service) = service_on_spawn_failure.lock() {
            let _ = service.fail_video_export(
                &spawn_id,
                &format!("capability_unavailable: export worker could not start: {error}"),
                false,
            );
        }
        if let Ok(mut flags) = cancel_map.lock() {
            flags.remove(&spawn_id);
        }
    }
}

fn spawn_video_linkzag_job(
    service: Arc<Mutex<NipService>>,
    cancel_map: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    job_id: String,
    render_request: Value,
    cancel: Arc<AtomicBool>,
) {
    let _ = thread::Builder::new().name(format!("video-{job_id}")).spawn(move || {
        let update = |mutate: &dyn Fn(&mut VideoJob)| {
            if let Ok(mut service) = service.lock() {
                if let Ok(Some(mut job)) = service.video_job(&job_id) {
                    mutate(&mut job);
                    let _ = service.save_video_job(&job);
                }
            }
        };
        update(&|job| { job.status = "running".into(); job.started_at = Some(Utc::now()); job.progress_millis = 1_000; });
        let (media_root, workspace) = match service.lock() {
            Ok(service) => (
                std::env::var_os("NIP_MEDIA_DIR").map(PathBuf::from).unwrap_or_else(|| service.config().data_dir().join("media")),
                std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            ),
            Err(_) => { update(&|job| { job.status = "failed".into(); job.safe_error_message = Some("NIP service lock failed".into()); job.finished_at = Some(Utc::now()); }); return; }
        };
        let cleanup_cancel = || {
            cancel_map.lock().ok().map(|mut flags| flags.remove(&job_id));
        };
        let capture_mode = render_request
            .get("capture_mode")
            .and_then(Value::as_str)
            .unwrap_or("flash")
            .to_owned();
        if !matches!(capture_mode.as_str(), "flash" | "full") {
            update(&|job| { job.status = "failed".into(); job.safe_error_message = Some("persisted LinkZag capture mode is invalid".into()); job.finished_at = Some(Utc::now()); job.progress_millis = 100_000; });
            cleanup_cancel();
            return;
        }
        let specs = video_visual_spec_values(&render_request);
        if specs.is_empty() || specs.len() > 24 {
            update(&|job| { job.status = "failed".into(); job.safe_error_message = Some("persisted storyboard must contain between 1 and 24 slide specs".into()); job.finished_at = Some(Utc::now()); job.progress_millis = 100_000; });
            cleanup_cancel();
            return;
        }
        let mut segments = Vec::with_capacity(specs.len());
        for (index, spec) in specs.iter().enumerate() {
            update(&|job| job.progress_millis = 5_000 + ((index as u32 * 70_000) / specs.len() as u32));
            let render_id = format!("{job_id}-slide-{:02}", index + 1);
            match linkzag::render(spec, &workspace, &media_root, &render_id, &capture_mode, &cancel) {
                Ok(outcome) if outcome.state == "ready" => segments.push(outcome),
                Ok(outcome) if outcome.state == "cancelled" => {
                    update(&|job| { job.status = "cancelled".into(); job.cancellation_requested = true; job.safe_error_message = Some(outcome.message.clone()); job.finished_at = Some(Utc::now()); });
                    cleanup_cancel();
                    return;
                }
                Ok(outcome) => {
                    update(&|job| { job.status = "failed".into(); job.safe_error_message = Some(outcome.message.clone()); job.output_manifest = outcome.manifest.clone(); job.finished_at = Some(Utc::now()); job.progress_millis = 100_000; });
                    cleanup_cancel();
                    return;
                }
                Err(error) => {
                    update(&|job| { job.status = "failed".into(); job.safe_error_message = Some(error.clone()); job.finished_at = Some(Utc::now()); job.progress_millis = 100_000; });
                    cleanup_cancel();
                    return;
                }
            }
        }
        update(&|job| job.progress_millis = 80_000);
        let assembly = match linkzag::assemble(&segments, &media_root, &job_id) {
            Ok(assembly) => assembly,
            Err(error) => {
                update(&|job| { job.status = "failed".into(); job.safe_error_message = Some(error.clone()); job.finished_at = Some(Utc::now()); job.progress_millis = 100_000; });
                cleanup_cancel();
                return;
            }
        };
        let relative_path = media_root.canonicalize().ok().and_then(|root| {
            assembly.media_path.strip_prefix(root).ok().map(|path| path.to_string_lossy().replace('\\', "/"))
        });
        let Some(relative_path) = relative_path else {
            update(&|job| { job.status = "failed".into(); job.safe_error_message = Some("assembled MP4 was outside the managed media directory".into()); job.finished_at = Some(Utc::now()); job.progress_millis = 100_000; });
            cleanup_cancel();
            return;
        };
        let width = assembly.media_file.get("width").and_then(Value::as_u64).map(|value| value as u32);
        let height = assembly.media_file.get("height").and_then(Value::as_u64).map(|value| value as u32);
        let duration_ms = assembly.media_file.get("duration").and_then(Value::as_f64).map(|value| (value * 1000.0) as u64);
        let content_hash = assembly.media_hash.clone();
        let asset_id = format!(
            "linkzag-storyboard-{job_id}-{}",
            &content_hash[..12.min(content_hash.len())]
        );
        let asset = VideoAsset {
            asset_id,
            revision: 1,
            asset_kind: "commentary_video".into(),
            relative_path: Some(relative_path),
            mime_type: Some("video/mp4".into()),
            content_hash: Some(content_hash),
            width,
            height,
            duration_ms,
            provider: "linkzag".into(),
            workflow_id: Some("linkzag.commentary.v1".into()),
            model: None,
            reproducibility: if capture_mode == "full" {
                "deterministic".into()
            } else {
                "nondeterministic".into()
            },
            capability_state: "ready".into(),
            license_state: "internal_review_only".into(),
            job_id: Some(job_id.clone()),
            created_at: Utc::now(),
        };
        if let Ok(mut service) = service.lock() {
            let source_specs = video_visual_spec_values(&render_request)
                .into_iter()
                .map(|value| {
                    video_visual_spec_ref(&value).and_then(|(spec_id, revision)| {
                        service.video_visual_spec(spec_id, revision).ok().flatten()
                    })
                })
                .collect::<Option<Vec<_>>>();
            let lineage = source_specs
                .as_ref()
                .map(|specs| linkzag_asset_lineage(&asset, specs));
            let registration = lineage
                .as_ref()
                .ok_or_else(|| "rendered visual-spec lineage is unavailable".to_owned())
                .and_then(|lineage| {
                    service
                        .save_video_asset_with_lineage(&asset, lineage)
                        .map_err(|error| error.to_string())
                });
            if let Ok(Some(mut job)) = service.video_job(&job_id) {
                match registration {
                    Ok(()) => {
                        job.status = "succeeded".into();
                        job.progress_millis = 100_000;
                        job.output_manifest = Some(json!({
                            "asset": asset,
                            "lineage": lineage.unwrap_or_default(),
                            "renderer": "linkzag",
                            "capture_mode": capture_mode,
                            "chart_renderer": if capture_mode == "flash" { "canvas" } else { "svg" },
                            "deterministic": capture_mode == "full",
                            "renderer_revision": segments.first().map(|segment| segment.renderer_revision.clone()),
                            "scene_checksums": segments.iter().map(|segment| segment.scene_checksum.clone()).collect::<Vec<_>>(),
                            "segment_manifests": segments.iter().map(|segment| segment.manifest.clone()).collect::<Vec<_>>(),
                            "assembly": assembly.manifest
                        }));
                        job.finished_at = Some(Utc::now());
                    }
                    Err(error) => {
                        eprintln!("LinkZag asset/lineage registration failed for job {job_id}: {error}");
                        job.status = "failed".into();
                        job.safe_error_message = Some(if source_specs.is_some() {
                            "render completed but atomic asset/lineage registration failed".into()
                        } else {
                            "render completed but one or more pinned VideoVisualSpec revisions were unavailable; no asset was registered".into()
                        });
                        job.finished_at = Some(Utc::now());
                        job.progress_millis = 100_000;
                    }
                }
                let _ = service.save_video_job(&job);
            }
        }
        cleanup_cancel();
    });
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

/// Everything a background job needs after it leaves the service lock.
#[derive(Debug, Clone)]
struct JobContext {
    test_mode: bool,
    comfyui_url: Option<String>,
    render_script: PathBuf,
    staging_root: PathBuf,
    chunk_seconds: u32,
}

fn spawn_transcription_job(
    service: Arc<Mutex<NipService>>,
    registry: JobRegistry,
    gate: Arc<Mutex<()>>,
    episode: PodcastEpisode,
    job_id: String,
    context: JobContext,
) {
    let spawned = thread::Builder::new()
        .name(format!("nip-transcribe-{job_id}"))
        .spawn(move || run_transcription_job(service, registry, gate, episode, job_id, context));
    if let Err(error) = spawned {
        eprintln!(
            "{}",
            json!({
                "event": "nip_transcription_job_spawn_failed",
                "detail": error.to_string()
            })
        );
    }
}

/// Prefer the transcript the publisher advertises in the feed. The job finishes
/// without downloading audio or starting a local model when it is usable, so
/// the return value means "handled": either transcribed or failed for good.
fn use_publisher_transcript(
    service: &Arc<Mutex<NipService>>,
    registry: &JobRegistry,
    job_id: &str,
    episode: &PodcastEpisode,
    client: &HttpAudioClient,
) -> bool {
    if episode.transcript_url.is_none() {
        return false;
    }
    registry.update(job_id, |job| {
        job.record(
            "info",
            "publisher_transcript",
            "checking the transcript reference advertised by the feed",
        )
    });
    let mut service = match service.lock() {
        Ok(service) => service,
        Err(_) => {
            registry.update(job_id, |job| {
                job.fail("internal", "internal", "NIP service lock failed")
            });
            return true;
        }
    };
    let transcript = match service.publisher_transcript(episode, client, Utc::now()) {
        Ok(Some(transcript)) => transcript,
        Ok(None) => {
            registry.update(job_id, |job| {
                job.record(
                    "info",
                    "publisher_transcript",
                    "no usable publisher transcript; falling back to local ASR",
                )
            });
            return false;
        }
        Err(error) => {
            registry.update(job_id, |job| {
                job.fail("commit", "storage_unavailable", error.to_string())
            });
            return true;
        }
    };
    let characters = transcript.transcript_text.chars().count();
    let preview = preview_text(&transcript.transcript_text);
    let directory = registry.job_dir(job_id);
    let path = directory.join("transcript.txt");
    if let Err(error) =
        fs::create_dir_all(&directory).and_then(|_| fs::write(&path, &transcript.transcript_text))
    {
        registry.update(job_id, |job| {
            job.fail(
                "commit",
                "storage_unavailable",
                format!("the transcript artifact could not be written: {error}"),
            )
        });
        return true;
    }
    let event_id = service
        .event_for_episode(episode)
        .ok()
        .flatten()
        .map(|event| event.event_id.as_str().to_owned());
    registry.update(job_id, |job| {
        job.event_id = event_id;
        job.transcript_characters = Some(characters as u64);
        job.transcript_preview = Some(preview);
        job.transcript_path = Some(path.display().to_string());
        job.record(
            "info",
            "transcribed",
            format!(
                "used the publisher transcript · committed {characters} characters to the local ledger"
            ),
        );
        job.state = "transcribed".into();
        job.finished_at = Some(Utc::now());
    });
    true
}

fn run_transcription_job(
    service: Arc<Mutex<NipService>>,
    registry: JobRegistry,
    gate: Arc<Mutex<()>>,
    episode: PodcastEpisode,
    job_id: String,
    context: JobContext,
) {
    let cancel = registry.cancel_flag(&job_id);
    if cancel.load(Ordering::SeqCst) {
        finish_cancelled(&registry, &job_id);
        return;
    }

    let client = if context.test_mode {
        HttpAudioClient::for_test()
    } else {
        HttpAudioClient::default()
    };
    // Publisher text is authored and needs no GPU, so it runs before the ASR
    // slot lock: a feed transcript must never wait behind a local model.
    if use_publisher_transcript(&service, &registry, &job_id, &episode, &client) {
        return;
    }

    let guard = gate.lock();
    let guard = match guard {
        Ok(guard) => guard,
        Err(_) => {
            registry.update(&job_id, |job| {
                job.fail("internal", "internal", "the local ASR slot lock failed")
            });
            return;
        }
    };
    if cancel.load(Ordering::SeqCst) {
        finish_cancelled(&registry, &job_id);
        drop(guard);
        return;
    }
    registry.update(&job_id, |job| {
        job.record("info", "download", "downloading the episode enclosure")
    });

    let mut request = match podcast_asr_request(&episode, &client) {
        Ok(request) => request,
        Err(error) => {
            let (code, message) = transcription_failure(&error);
            registry.update(&job_id, |job| job.fail("download", code, message));
            drop(guard);
            return;
        }
    };
    request.job_id = job_id.clone();

    // Persist the downloaded audio before ASR: the review panel can replay
    // exactly what was sent to the model, and a failed run keeps its input.
    let directory = registry.job_dir(&job_id);
    let audio_name = saved_audio_name(&request.file_name, &request.mime_type);
    let audio_path = directory.join(&audio_name);
    if let Err(error) =
        fs::create_dir_all(&directory).and_then(|_| fs::write(&audio_path, &request.audio))
    {
        registry.update(&job_id, |job| {
            job.fail(
                "download",
                "storage_unavailable",
                format!("the downloaded audio could not be stored: {error}"),
            )
        });
        drop(guard);
        return;
    }
    request.audio_path = Some(audio_path.clone());
    let bytes = request.audio.len() as u64;
    let duration = audio_duration_seconds(&audio_path);
    registry.update(&job_id, |job| {
        job.audio_bytes = Some(bytes);
        job.audio_content_type = Some(request.mime_type.clone());
        job.audio_path = Some(audio_path.display().to_string());
        job.audio_url_path = Some(format!("{job_id}/{audio_name}"));
        job.audio_duration_seconds = duration;
        job.record(
            "info",
            "downloaded",
            format!(
                "downloaded {:.1} MB of {} audio{}",
                bytes as f64 / (1024.0 * 1024.0),
                request.mime_type,
                duration
                    .map(|value| format!(" · {:.0}s", value))
                    .unwrap_or_default()
            ),
        );
    });
    if cancel.load(Ordering::SeqCst) {
        finish_cancelled(&registry, &job_id);
        drop(guard);
        return;
    }

    let provider: Box<dyn AsrProvider> = if context.test_mode {
        match DeterministicFakeAsrProvider::new(test_asr_transcript(), Some("en".into())) {
            Ok(provider) => Box::new(provider),
            Err(error) => {
                registry.update(&job_id, |job| {
                    job.fail("transcribe", error.code(), error.to_string())
                });
                drop(guard);
                return;
            }
        }
    } else {
        let Some(url) = context.comfyui_url.as_deref() else {
            registry.update(&job_id, |job| {
                job.fail(
                    "transcribe",
                    "transcription_unavailable",
                    "no loopback ComfyUI endpoint was resolved; start ComfyUI Desktop or set NIP_COMFYUI_URL",
                )
            });
            drop(guard);
            return;
        };
        match ComfyUiAsrProvider::with_render_script(
            url,
            &context.staging_root,
            &context.render_script,
            context.chunk_seconds,
        ) {
            Ok(provider) => Box::new(provider.with_cancel(cancel.clone())),
            Err(error) => {
                registry.update(&job_id, |job| {
                    job.fail("transcribe", error.code(), error.to_string())
                });
                drop(guard);
                return;
            }
        }
    };

    let progress_registry = registry.clone();
    let progress_job = job_id.clone();
    let result = provider.transcribe_with_progress(&request, &move |progress| {
        progress_registry.apply_progress(&progress_job, &progress);
    });
    drop(guard);

    match result {
        Ok(result) => {
            let characters = result.text.chars().count();
            let preview = preview_text(&result.text);
            if let Err(error) = fs::write(directory.join("transcript.txt"), &result.text) {
                registry.update(&job_id, |job| {
                    job.fail(
                        "commit",
                        "storage_unavailable",
                        format!("the transcript artifact could not be written: {error}"),
                    )
                });
                return;
            }
            let committed = service
                .lock()
                .map_err(|_| "NIP service lock failed".to_owned())
                .and_then(|mut service| {
                    service
                        .commit_podcast_transcript(&episode, result, Utc::now())
                        .map(|_| service.event_for_episode(&episode).ok().flatten())
                        .map_err(|error: NipError| error.to_string())
                });
            match committed {
                Ok(event) => registry.update(&job_id, |job| {
                    job.event_id = event.map(|event| event.event_id.as_str().to_owned());
                    job.transcript_characters = Some(characters as u64);
                    job.transcript_preview = Some(preview);
                    job.transcript_path =
                        Some(directory.join("transcript.txt").display().to_string());
                    job.record(
                        "info",
                        "transcribed",
                        format!("committed {characters} characters to the local ledger"),
                    );
                    job.state = "transcribed".into();
                    job.finished_at = Some(Utc::now());
                }),
                Err(message) => registry.update(&job_id, |job| {
                    job.fail("commit", "transcription_failed", message)
                }),
            }
            cleanup_working_audio(&directory);
        }
        Err(AsrError::Cancelled) => finish_cancelled(&registry, &job_id),
        Err(error) => {
            if let Ok(mut service) = service.lock() {
                let _ = service.record_transcription_failure(&episode, error.clone());
            }
            let code = error.code();
            let message = asr_error_message(&error);
            registry.update(&job_id, |job| job.fail("transcribe", code, message));
            cleanup_working_audio(&directory);
        }
    }
}

fn finish_cancelled(registry: &JobRegistry, job_id: &str) {
    cleanup_working_audio(&registry.job_dir(job_id));
    registry.update(job_id, |job| {
        job.record(
            "warn",
            "cancelled",
            "transcription cancelled; the episode is ready to retry",
        );
        job.state = "cancelled".into();
        job.finished_at = Some(Utc::now());
    });
}

fn saved_audio_name(file_name: &str, mime_type: &str) -> String {
    const PLAYABLE: &[&str] = &["mp3", "m4a", "aac", "ogg", "opus", "wav", "flac"];
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .filter(|value| PLAYABLE.contains(&value.as_str()))
        .unwrap_or_else(|| {
            match mime_type {
                "audio/mpeg" => "mp3",
                "audio/mp4" | "audio/aac" => "m4a",
                "audio/ogg" | "audio/opus" => "ogg",
                "audio/flac" => "flac",
                "audio/wav" | "audio/x-wav" => "wav",
                _ => "audio",
            }
            .to_owned()
        });
    format!("source.{extension}")
}

fn preview_text(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let preview: String = collapsed.chars().take(320).collect();
    if preview.len() < collapsed.len() {
        format!("{preview}…")
    } else {
        preview
    }
}

/// Best-effort duration for the review panel. The pack owns media processing;
/// this only reads a header so the UI can show "31.2 MB · 42 min".
fn audio_duration_seconds(path: &Path) -> Option<f64> {
    let ffprobe = env::var("NIP_FFPROBE_BIN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "ffprobe".to_owned());
    let output = std::process::Command::new(ffprobe)
        .arg("-v")
        .arg("error")
        .arg("-show_entries")
        .arg("format=duration")
        .arg("-of")
        .arg("default=nw=1:nk=1")
        .arg(path)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .ok()
}

fn transcription_failure(error: &NipError) -> (&'static str, String) {
    match error {
        NipError::AudioUnavailable => (
            "audio_unavailable",
            "the podcast audio enclosure could not be downloaded".into(),
        ),
        NipError::UnsupportedAudio => (
            "unsupported_audio",
            "the episode has no supported audio enclosure".into(),
        ),
        other => ("transcription_failed", other.to_string()),
    }
}

fn asr_error_message(error: &AsrError) -> String {
    match error {
        AsrError::Unavailable => {
            "the local ASR provider is unavailable; no remote fallback was attempted".into()
        }
        AsrError::Timeout => {
            "local ASR timed out; the pack CLI was stopped and no transcript was committed".into()
        }
        AsrError::OutOfMemory => {
            "local ASR ran out of GPU memory. The pack frees VRAM and retries by splitting chunks; close other GPU apps or lower NIP_ASR_CHUNK_SECONDS and retry."
                .into()
        }
        AsrError::AudioPreparation => {
            "audio could not be split for local ASR; check that ffmpeg can read the episode".into()
        }
        AsrError::MalformedOutput => {
            "the local ASR provider returned an empty or malformed transcript".into()
        }
        AsrError::InvalidInput => "the episode audio is not a valid local ASR input".into(),
        AsrError::Cancelled => "transcription was cancelled".into(),
        AsrError::ProviderError(message) => message.clone(),
    }
}
fn structured_error(code: impl Into<String>, message: impl Into<String>) -> CallToolResult {
    CallToolResult::structured_error(json!({"code": code.into(), "message": message.into()}))
}

/// `NipError` shows a coarse label for every storage failure. Walk the source
/// chain so a caller sees which operation actually failed instead of
/// "NIP storage could not be initialized" for an unrelated derivation step.
fn error_chain(error: &dyn std::error::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = error.source();
    while let Some(cause) = source {
        parts.push(cause.to_string());
        source = cause.source();
    }
    parts.join(": ")
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
    let code = error.code();
    structured_error(code, asr_error_message(&error))
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
    let jobs = JobRegistry::open(service.config().asr_staging_root());
    let server = NipMcp {
        service: Arc::new(Mutex::new(service)),
        jobs,
        video_cancel: Arc::new(Mutex::new(HashMap::new())),
        gate: Arc::new(Mutex::new(())),
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
    let media_root = server
        .service
        .lock()
        .map(|service| service.config().asr_staging_root())
        .unwrap_or_default();
    let media_handler = {
        let root = media_root.clone();
        move |axum::extract::Path((job_id, name)): axum::extract::Path<(String, String)>,
              headers: axum::http::HeaderMap| {
            let root = root.clone();
            async move { serve_media(&root, &job_id, &name, &headers) }
        }
    };
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
        .route("/media/{job_id}/{name}", axum::routing::get(media_handler))
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

/// Serve cached audio/video for the review player. Playback is local-only:
/// the MCP server is bound to loopback, and every path is resolved inside the
/// media cache. Range requests are supported so long audio can seek.
fn serve_media(
    root: &Path,
    job_id: &str,
    name: &str,
    headers: &axum::http::HeaderMap,
) -> axum::response::Response {
    use axum::body::Body;
    use axum::http::{header, StatusCode};
    use axum::response::IntoResponse;

    let artifact = match media::resolve_artifact(root, job_id, name) {
        Ok(artifact) => artifact,
        Err(message) => return (StatusCode::NOT_FOUND, message).into_response(),
    };
    let bytes = match fs::read(&artifact.path) {
        Ok(bytes) => bytes,
        Err(_) => return (StatusCode::NOT_FOUND, "media file could not be read").into_response(),
    };
    let total = bytes.len();
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| parse_byte_range(value, total));
    match range {
        Some((start, end)) => {
            let slice = bytes[start..=end].to_vec();
            axum::response::Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(header::CONTENT_TYPE, artifact.mime)
                .header(header::ACCEPT_RANGES, "bytes")
                .header(
                    header::CONTENT_RANGE,
                    format!("bytes {start}-{end}/{total}"),
                )
                .header(header::CONTENT_LENGTH, end - start + 1)
                .body(Body::from(slice))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        None => axum::response::Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, artifact.mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_LENGTH, total)
            .body(Body::from(bytes))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
    }
}

/// `bytes=start-end`, `bytes=start-`, `bytes=-suffix`. Returns inclusive bounds.
fn parse_byte_range(value: &str, total: usize) -> Option<(usize, usize)> {
    let spec = value.trim().strip_prefix("bytes=")?;
    let (start, end) = spec.split_once('-')?;
    if total == 0 {
        return None;
    }
    if start.is_empty() {
        let suffix: usize = end.trim().parse().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = total.saturating_sub(suffix);
        return Some((start, total - 1));
    }
    let start: usize = start.trim().parse().ok()?;
    if start >= total {
        return None;
    }
    let end = if end.trim().is_empty() {
        total - 1
    } else {
        end.trim().parse::<usize>().ok()?.min(total - 1)
    };
    (end >= start).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linkzag_render_mode_defaults_to_flash_and_accepts_full() {
        let defaulted: LinkZagRenderParams = serde_json::from_value(json!({
            "visual_spec_id": "spec-1",
            "visual_spec_revision": 1
        }))
        .unwrap();
        assert_eq!(defaulted.capture_mode, LinkZagCaptureMode::Flash);

        let full: LinkZagRenderParams = serde_json::from_value(json!({
            "visual_spec_id": "spec-1",
            "visual_spec_revision": 1,
            "capture_mode": "full"
        }))
        .unwrap();
        assert_eq!(full.capture_mode, LinkZagCaptureMode::Full);
    }

    #[test]
    fn linkzag_render_mode_rejects_unknown_values() {
        let result = serde_json::from_value::<LinkZagRenderParams>(json!({
            "visual_spec_id": "spec-1",
            "visual_spec_revision": 1,
            "capture_mode": "turbo"
        }));
        assert!(result.is_err());
    }

    #[test]
    fn byte_ranges_support_browser_seeking() {
        assert_eq!(parse_byte_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_byte_range("bytes=900-", 1000), Some((900, 999)));
        assert_eq!(parse_byte_range("bytes=-50", 1000), Some((950, 999)));
        assert_eq!(parse_byte_range("bytes=0-100000", 1000), Some((0, 999)));
        assert_eq!(parse_byte_range("bytes=1000-", 1000), None);
        assert_eq!(parse_byte_range("bytes=-0", 1000), None);
        assert_eq!(parse_byte_range("items=0-1", 1000), None);
        assert_eq!(parse_byte_range("bytes=0-1", 0), None);
    }

    #[test]
    fn cached_audio_names_stay_inside_the_job_directory() {
        assert_eq!(saved_audio_name("episode.mp3", "audio/mpeg"), "source.mp3");
        assert_eq!(
            saved_audio_name("../../etc/passwd", "audio/mpeg"),
            "source.mp3"
        );
        assert_eq!(saved_audio_name("noext", "audio/mp4"), "source.m4a");
        assert_eq!(saved_audio_name("x", "audio/ogg"), "source.ogg");
        assert_eq!(saved_audio_name("x.weird", "audio/mpeg"), "source.mp3");
    }

    #[test]
    fn transcript_previews_are_single_line_and_bounded() {
        let preview = preview_text(&format!("{}\n\nsecond paragraph", "word ".repeat(120)));
        assert!(!preview.contains('\n'));
        assert!(preview.chars().count() <= 321);
        assert!(preview.ends_with('…'));
        assert_eq!(preview_text("short text"), "short text");
    }

    #[test]
    fn linkzag_asset_lineage_is_pinned_to_the_visual_spec_and_canonical_sources() {
        let now = "2026-11-18T09:01:00Z".parse().unwrap();
        let asset = VideoAsset {
            asset_id: "rendered-asset".into(),
            revision: 1,
            asset_kind: "linkzag_segment".into(),
            relative_path: None,
            mime_type: Some("video/mp4".into()),
            content_hash: Some("sha256:output".into()),
            width: Some(1280),
            height: Some(720),
            duration_ms: Some(12_000),
            provider: "linkzag".into(),
            workflow_id: None,
            model: None,
            reproducibility: "deterministic".into(),
            capability_state: "ready".into(),
            license_state: "fixture_only".into(),
            job_id: Some("render-job".into()),
            created_at: now,
        };
        let spec = VideoVisualSpec {
            spec_id: "visual-spec-1".into(),
            revision: 3,
            schema_version: "video-visual-spec-v1".into(),
            project_id: "project-1".into(),
            episode_id: "episode-1".into(),
            scene_id: Some("scene-1".into()),
            shot_id: None,
            template: nip_domain::VideoVisualTemplate::EvidenceCard,
            duration_ms: 12_000,
            width: 1280,
            height: 720,
            fps: 30,
            payload: nip_domain::VideoVisualPayload::EvidenceCard {
                title: "Fixture".into(),
                body: "Evidence remains canonical.".into(),
                disclosure: None,
            },
            sources: vec![
                nip_domain::VideoVisualSource {
                    source_kind: VideoVisualSourceKind::Event,
                    source_id: "event-1".into(),
                    source_revision: None,
                    start_offset: None,
                    end_offset: None,
                    quote: None,
                },
                nip_domain::VideoVisualSource {
                    source_kind: VideoVisualSourceKind::Claim,
                    source_id: "claim-1".into(),
                    source_revision: None,
                    start_offset: None,
                    end_offset: None,
                    quote: None,
                },
                nip_domain::VideoVisualSource {
                    source_kind: VideoVisualSourceKind::SignalSnapshot,
                    source_id: "snapshot-1".into(),
                    source_revision: Some(2),
                    start_offset: None,
                    end_offset: None,
                    quote: None,
                },
            ],
            deterministic: true,
            created_at: now,
        };

        assert_eq!(
            video_visual_spec_ref(&json!({
                "visual_spec_id": "visual-spec-1",
                "visual_spec_revision": 3
            })),
            Some(("visual-spec-1", 3))
        );
        assert_eq!(
            video_visual_spec_ref(&json!({ "visual_spec_id": "visual-spec-1" })),
            None
        );
        let mut second_spec = spec.clone();
        second_spec.spec_id = "visual-spec-2".into();
        second_spec.revision = 1;
        let lineage = linkzag_asset_lineage(&asset, &[spec.clone(), second_spec]);
        assert_eq!(lineage.len(), 4);
        assert_eq!(lineage[0].upstream_kind, VideoAssetUpstreamKind::VisualSpec);
        assert_eq!(lineage[0].upstream_id, "visual-spec-1");
        assert_eq!(lineage[0].upstream_revision, Some(3));
        assert_eq!(lineage[1].upstream_kind, VideoAssetUpstreamKind::Event);
        assert_eq!(lineage[1].upstream_id, "event-1");
        assert_eq!(lineage[2].upstream_kind, VideoAssetUpstreamKind::Claim);
        assert_eq!(lineage[2].upstream_id, "claim-1");
        assert_eq!(lineage[3].upstream_kind, VideoAssetUpstreamKind::VisualSpec);
        assert_eq!(lineage[3].upstream_id, "visual-spec-2");
    }
}
