//! Managed P3 export producer for the installed preview EDL profile.
//!
//! The producer accepts only exact persisted refs. It resolves registered assets
//! through the EDL inventory, re-hashes bytes before invoking FFmpeg, builds argv
//! from typed EDL/profile values, and publishes no asset/manifest before independent
//! probe, decode and hash checks succeed.
use crate::{
    video_edl::{self, AudioKind, EDLManifestV1, Ref as EdlRef, TransitionKind},
    video_export::{
        parse_ffprobe_output, prepare_temp_output_path, resolve_managed_input, sha256_file,
        validate_probe, AudioPolicy, ExportContainer, ExportInput, ExportProfile, H264Preset,
        ProbeOutput, Rational, VideoCodec,
    },
};
use chrono::Utc;
use nip_domain::{
    VideoAsset, VideoExportLineageRefV1, VideoExportManifestFileV1, VideoExportManifestV1,
    VideoExportProbeV1, VideoExportRef, VideoExportToolchainV1, VideoJob,
};
use nip_store::{Store, VideoEdlAssetFact, VideoEdlRef, VideoEdlRevision};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

pub const EXPORT_OPERATION: &str = "video.export.ffmpeg";
pub const EXPORT_PROFILE_ID: &str = video_edl::PREVIEW_PROFILE_ID;
pub const EXPORT_COMPILER_VERSION: &str = "fina-video-export-producer-v1";
const MAX_REQUEST_ID: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportRequest {
    pub timeline_ref: EdlRef,
    pub qa_report_ref: EdlRef,
    pub export_profile_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportStartRequest {
    pub timeline_ref: EdlRef,
    pub qa_report_ref: EdlRef,
    pub export_profile_id: String,
    pub request_id: String,
}
#[derive(Debug, Clone)]
pub struct ResolvedMedia {
    pub asset_id: String,
    pub revision: u32,
    pub role: MediaRole,
    pub path: PathBuf,
    pub sha256: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaRole {
    Video,
    Audio,
}
#[derive(Debug, Clone)]
pub struct ExportPlan {
    pub request: ExportRequest,
    pub timeline: VideoEdlRevision,
    pub edl: EDLManifestV1,
    pub qa_input_fingerprint: String,
    pub input_fingerprint: String,
    pub media: Vec<ResolvedMedia>,
    pub profile: ExportProfile,
    pub warnings: Vec<String>,
    pub persisted_lineage: Vec<VideoExportLineageRefV1>,
    pub job_id: String,
    pub output_asset_id: String,
}
#[derive(Debug, Clone)]
pub struct ExportResult {
    pub manifest: VideoExportManifestV1,
    pub asset: VideoAsset,
    pub output_path: PathBuf,
}

pub fn installed_profiles() -> Value {
    json!([{
        "profile_ref": {"id": EXPORT_PROFILE_ID, "revision": 1},
        "purpose": "preview",
        "container": "mp4",
        "video_codec": "h264",
        "audio_codec": "aac",
        "dimensions": {"width": 1280, "height": 720},
        "frame_rate": {"num": 30, "den": 1},
        "audio_policy": "optional_narration_aac",
        "caption_policy": "unsupported",
        "max_duration_ms": 600000,
        "deterministic": true,
        "locality": "local",
        "capability_state": if tool_available("ffmpeg") && tool_available("ffprobe") { "available" } else { "unavailable" },
        "warnings_allowed": true,
        "preview_only": true
    }])
}

pub fn preflight(
    store: &Store,
    media_root: &Path,
    request: &ExportRequest,
) -> Result<Value, String> {
    let plan = match build_plan(store, media_root, request) {
        Ok(plan) => plan,
        Err(error) => {
            let code = error.split(':').next().unwrap_or("export_blocked");
            return Ok(json!({
                "decision":"block",
                "blockers":[{"code":code,"message":error}],
                "warnings":[],
                "capability_state":if tool_available("ffmpeg") && tool_available("ffprobe") {"available"} else {"unavailable"},
                "profile_ref":{"id":request.export_profile_id,"revision":1}
            }));
        }
    };
    let bytes = plan.media.iter().try_fold(0u64, |sum, media| {
        sum.checked_add(fs::metadata(&media.path).ok()?.len())
    });
    Ok(json!({
        "decision": if plan.warnings.is_empty() { "allow" } else { "allow_with_warnings" },
        "blockers": [],
        "warnings": plan.warnings,
        "input_fingerprint": plan.input_fingerprint,
        "qa_input_fingerprint": plan.qa_input_fingerprint,
        "estimated_bytes": bytes.map(|value| value.saturating_mul(2)),
        "resource_estimate": {"video_clips": plan.edl.video_tracks[0].clips.len(), "duration_frames": plan.edl.sequence.total_frames},
        "capability_state": "available",
        "profile_ref": {"id": EXPORT_PROFILE_ID, "revision": 1}
    }))
}

pub fn start(
    store: &mut Store,
    media_root: &Path,
    request: &ExportStartRequest,
) -> Result<(Value, bool), String> {
    validate_request_id(&request.request_id)?;
    let export_request = ExportRequest {
        timeline_ref: request.timeline_ref.clone(),
        qa_report_ref: request.qa_report_ref.clone(),
        export_profile_id: request.export_profile_id.clone(),
    };
    let plan = build_plan(store, media_root, &export_request)?;
    let payload_hash = sha256(
        &serde_json::to_vec(&json!({
            "timeline_ref": request.timeline_ref,
            "qa_report_ref": request.qa_report_ref,
            "export_profile_id": request.export_profile_id,
            "input_fingerprint": plan.input_fingerprint,
        }))
        .map_err(|error| error.to_string())?,
    );
    if let Some((old_hash, job_id)) = store
        .video_export_run_request(&request.request_id)
        .map_err(|e| e.to_string())?
    {
        if old_hash != payload_hash {
            return Err(
                "revision_conflict: request_id was reused with different exact inputs".into(),
            );
        }
        let job = store
            .video_job(&job_id)
            .map_err(|e| e.to_string())?
            .ok_or("stored export job is missing")?;
        return Ok((json!({"job": job, "poll_tool": "video_job_status"}), false));
    }
    let request_digest = sha256(request.request_id.as_bytes());
    let job_id = format!("video-export-{}", &request_digest[7..31]);
    let job = VideoJob {
        job_id: job_id.clone(),
        operation: EXPORT_OPERATION.into(),
        status: "queued".into(),
        input_revision: Some(plan.timeline.project_revision),
        progress_millis: 0,
        cancellation_requested: false,
        resource_estimate: Some(
            json!({"duration_frames": plan.edl.sequence.total_frames, "video_clips": plan.edl.video_tracks[0].clips.len()}),
        ),
        output_manifest: None,
        safe_error_message: None,
        started_at: None,
        finished_at: None,
        created_at: Utc::now(),
    };
    if let Err(error) = store.create_video_export_job(&request.request_id, &payload_hash, &job) {
        // Concurrent identical starts may race on the unique idempotency key.
        if let Some((old_hash, old_job)) = store
            .video_export_run_request(&request.request_id)
            .map_err(|e| e.to_string())?
        {
            if old_hash != payload_hash {
                return Err(
                    "revision_conflict: request_id was reused with different exact inputs".into(),
                );
            }
            let existing = store
                .video_job(&old_job)
                .map_err(|e| e.to_string())?
                .ok_or("stored export job is missing")?;
            return Ok((
                json!({"job":existing,"poll_tool":"video_job_status"}),
                false,
            ));
        }
        return Err(error.to_string());
    }
    Ok((json!({"job": job, "poll_tool": "video_job_status"}), true))
}

pub fn prepare_worker(
    store: &Store,
    media_root: &Path,
    request: &ExportStartRequest,
    job_id: &str,
) -> Result<ExportPlan, String> {
    let export_request = ExportRequest {
        timeline_ref: request.timeline_ref.clone(),
        qa_report_ref: request.qa_report_ref.clone(),
        export_profile_id: request.export_profile_id.clone(),
    };
    let mut plan = build_plan(store, media_root, &export_request)?;
    plan.job_id = job_id.to_owned();
    plan.output_asset_id = format!(
        "asset-{}",
        job_id.strip_prefix("video-export-").unwrap_or(job_id)
    );
    Ok(plan)
}

pub fn execute(
    plan: &ExportPlan,
    media_root: &Path,
    cancel: &AtomicBool,
) -> Result<ExportResult, String> {
    let mut cleanup = Vec::new();
    let result = execute_inner(plan, media_root, cancel, &mut cleanup);
    if result.is_err() {
        for path in cleanup {
            let _ = fs::remove_file(path);
        }
    }
    result
}

fn execute_inner(
    plan: &ExportPlan,
    media_root: &Path,
    cancel: &AtomicBool,
    cleanup: &mut Vec<PathBuf>,
) -> Result<ExportResult, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("job_cancelled: export cancelled before execution".into());
    }
    fs::create_dir_all(media_root)
        .map_err(|_| "storage_unavailable: managed media root is unavailable")?;
    let root = fs::canonicalize(media_root)
        .map_err(|_| "storage_unavailable: managed media root is unavailable")?;
    // Revalidate all input hashes immediately before the process to catch TOCTOU changes.
    for item in &plan.media {
        let relative = item
            .path
            .strip_prefix(&root)
            .map_err(|_| "path_rejected: input escaped managed root")?;
        let resolved = resolve_managed_input(&root, &ExportInput::new(relative))
            .map_err(|_| "path_rejected: input is no longer a verified managed file")?;
        if sha256_file(&resolved)
            .map_err(|_| "media_integrity_failed: input could not be hashed")?
            != item.sha256
        {
            return Err("input_changed: media bytes changed after preflight".into());
        }
    }
    let temp = prepare_temp_output_path(&root, &plan.job_id, &plan.profile)
        .map_err(|_| "storage_unavailable: export staging path could not be prepared")?;
    cleanup.push(temp.clone());
    let ffmpeg_version = tool_version("ffmpeg")?;
    let ffprobe_version = tool_version("ffprobe")?;
    let command = build_timeline_command(plan, &temp)?;
    let status = run_cancellable(command, cancel)?;
    if !status.success() {
        let _ = fs::remove_file(&temp);
        return Err("export_failed: FFmpeg exited unsuccessfully".into());
    }
    if cancel.load(Ordering::SeqCst) {
        let _ = fs::remove_file(&temp);
        return Err("job_cancelled: export cancelled".into());
    }
    let probe_bytes = run_capture(
        Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_format",
                "-show_streams",
                "-of",
                "json",
            ])
            .arg(&temp),
    )?;
    let probe = parse_ffprobe_output(&probe_bytes)
        .map_err(|_| "media_integrity_failed: output probe is invalid")?;
    validate_probe(&probe, &plan.profile)
        .map_err(|_| "media_integrity_failed: output does not match the installed profile")?;
    let duration_ms = (probe.duration_seconds * 1000.0).round() as u64;
    let expected_ms = frames_to_ms(
        plan.edl.sequence.total_frames,
        plan.edl.sequence.frame_rate.num,
        plan.edl.sequence.frame_rate.den,
    )
    .ok_or("timeline_invalid: duration overflow")?;
    if duration_ms.abs_diff(expected_ms) > 100 {
        let _ = fs::remove_file(&temp);
        return Err("media_integrity_failed: output duration differs from EDL".into());
    }
    let mut decode = Command::new("ffmpeg");
    decode
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(&temp)
        .args(["-f", "null", "-"]);
    let decode_status = run_cancellable(decode, cancel)?;
    if !decode_status.success() {
        let _ = fs::remove_file(&temp);
        return Err("media_integrity_failed: output decode check failed".into());
    }
    let output_sha256 =
        sha256_file(&temp).map_err(|_| "media_integrity_failed: output hash failed")?;
    let byte_size = fs::metadata(&temp)
        .map_err(|_| "storage_unavailable: output file missing")?
        .len();
    let final_dir = ensure_output_dir(&root)?;
    let output_name = format!("{}.mp4", plan.output_asset_id);
    let output_path = final_dir.join(&output_name);
    if output_path.exists() {
        let _ = fs::remove_file(&temp);
        return Err("revision_conflict: output for this job already exists".into());
    }
    fs::rename(&temp, &output_path)
        .map_err(|_| "storage_unavailable: atomic output registration failed")?;
    let relative_path = PathBuf::from("video-exports")
        .join(&output_name)
        .to_string_lossy()
        .into_owned();
    cleanup.push(output_path.clone());
    let output_asset = VideoAsset {
        asset_id: plan.output_asset_id.clone(),
        revision: 1,
        asset_kind: "video".into(),
        relative_path: Some(relative_path),
        mime_type: Some("video/mp4".into()),
        content_hash: Some(output_sha256.clone()),
        width: Some(probe.width),
        height: Some(probe.height),
        duration_ms: Some(duration_ms),
        provider: "fina_video_export_producer".into(),
        workflow_id: Some(EXPORT_COMPILER_VERSION.into()),
        model: None,
        reproducibility: "deterministic".into(),
        capability_state: "ready".into(),
        license_state: "internal_review_only".into(),
        job_id: Some(plan.job_id.clone()),
        created_at: Utc::now(),
    };
    let manifest = make_manifest(
        plan,
        &probe,
        duration_ms,
        byte_size,
        output_sha256,
        ffmpeg_version,
        ffprobe_version,
        output_asset.created_at,
    );
    Ok(ExportResult {
        manifest,
        asset: output_asset,
        output_path,
    })
}

pub fn finalize(store: &mut Store, result: &ExportResult, job: &VideoJob) -> Result<(), String> {
    store
        .commit_video_export(&result.manifest, &result.asset, job)
        .map_err(|e| e.to_string())
}

pub fn fail_job(
    store: &mut Store,
    job_id: &str,
    error: &str,
    cancelled: bool,
) -> Result<(), String> {
    let mut job = store
        .video_job(job_id)
        .map_err(|e| e.to_string())?
        .ok_or("not_found: export job disappeared")?;
    if matches!(job.status.as_str(), "succeeded" | "failed" | "cancelled") {
        return Ok(());
    }
    job.status = if cancelled { "cancelled" } else { "failed" }.into();
    job.safe_error_message = Some(error.chars().take(300).collect());
    job.finished_at = Some(Utc::now());
    if store
        .update_video_export_job_active(&job)
        .map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    let latest = store
        .video_job(job_id)
        .map_err(|e| e.to_string())?
        .ok_or("not_found: export job disappeared")?;
    if matches!(latest.status.as_str(), "succeeded" | "failed" | "cancelled") {
        Ok(())
    } else {
        Err("revision_conflict: export job terminal transition was not applied".into())
    }
}

fn build_plan(
    store: &Store,
    media_root: &Path,
    request: &ExportRequest,
) -> Result<ExportPlan, String> {
    if request.timeline_ref.id.trim().is_empty()
        || request.timeline_ref.revision == 0
        || request.qa_report_ref.id.trim().is_empty()
        || request.qa_report_ref.revision != 1
    {
        return Err("invalid_argument: exact timeline and QA refs are required".into());
    }
    if request.export_profile_id != EXPORT_PROFILE_ID {
        return Err("profile_unavailable: requested profile is not installed".into());
    }
    if !tool_available("ffmpeg") || !tool_available("ffprobe") {
        return Err("capability_unavailable: local FFmpeg and ffprobe are required".into());
    }
    let timeline = store
        .video_edl_timeline(&request.timeline_ref.id, request.timeline_ref.revision)
        .map_err(|e| e.to_string())?
        .ok_or("not_found: exact timeline revision was not found")?;
    if timeline.build_status != "ready"
        || timeline.profile_id != EXPORT_PROFILE_ID
        || timeline.profile_revision != 1
    {
        return Err(
            "profile_unavailable: timeline is not built for the installed preview profile".into(),
        );
    }
    let edl: EDLManifestV1 = serde_json::from_str(&timeline.manifest_json)
        .map_err(|_| "timeline_invalid: stored EDL is corrupt")?;
    validate_edl_shape(&edl)?;
    let qa_stored = store
        .video_qa_stored_report(&request.qa_report_ref.id)
        .map_err(|e| e.to_string())?
        .ok_or("stale_qa_report: evaluator-produced QA report was not found")?;
    if qa_stored.timeline_id != timeline.timeline_id
        || qa_stored.timeline_revision != timeline.revision
        || qa_stored.project_id != timeline.project_id
        || qa_stored.profile_id != timeline.profile_id
        || qa_stored.profile_revision != timeline.profile_revision
    {
        return Err(
            "stale_qa_report: QA report references different exact timeline/profile inputs".into(),
        );
    }
    let qa: Value = serde_json::from_str(&qa_stored.report_json)
        .map_err(|_| "stale_qa_report: stored QA report is invalid")?;
    if qa["report_ref"]["id"].as_str() != Some(request.qa_report_ref.id.as_str())
        || qa["report_ref"]["revision"].as_u64() != Some(1)
        || qa["timeline_ref"]["id"].as_str() != Some(timeline.timeline_id.as_str())
        || qa["timeline_ref"]["revision"].as_u64() != Some(timeline.revision as u64)
        || qa["timeline_hash"].as_str() != Some(timeline.timeline_hash.as_str())
        || qa["input_fingerprint"].as_str() != Some(qa_stored.input_fingerprint.as_str())
        || qa["profile_ref"]["id"].as_str() != Some(timeline.profile_id.as_str())
        || qa["profile_ref"]["revision"].as_u64() != Some(timeline.profile_revision as u64)
        || qa["evaluator_version"].as_str() != Some(crate::video_qa::EVALUATOR_VERSION)
        || qa["schema_version"].as_str() != Some(crate::video_qa::QA_SCHEMA_VERSION)
    {
        return Err(
            "stale_qa_report: report fingerprint, timeline hash or evaluator binding is stale"
                .into(),
        );
    }
    if qa["execution_state"].as_str() != Some("complete")
        || qa["check_summary"]["blockers"].as_u64().unwrap_or(1) > 0
        || qa["check_summary"]["not_run"].as_u64().unwrap_or(1) > 0
        || qa["decision"].as_str() == Some("block")
    {
        return Err("blocked_by_qa: QA must be evaluator-complete with zero blockers and zero not-run checks".into());
    }
    if !matches!(
        qa["decision"].as_str(),
        Some("allow" | "allow_with_warnings")
    ) {
        return Err("blocked_by_qa: QA decision does not authorize export".into());
    }
    let fresh_qa = crate::video_qa_adapter::evaluate_current(store, media_root, &timeline, &edl)
        .map_err(|error| {
            format!("blocked_by_qa: current trusted QA facts could not be recomputed: {error}")
        })?;
    ensure_fresh_qa_fingerprint(&qa_stored.input_fingerprint, fresh_qa.input_fingerprint())?;
    if fresh_qa.execution_state() != crate::video_qa::ExecutionState::Complete
        || fresh_qa.check_summary().blockers > 0
        || fresh_qa.check_summary().not_run > 0
        || fresh_qa.decision() == crate::video_qa::QaDecision::Block
    {
        return Err(
            "blocked_by_qa: fresh deterministic QA has blockers or required checks not run".into(),
        );
    }
    let profile_warnings_allowed =
        installed_profile_warnings_allowed(&request.export_profile_id, 1);
    let mut warnings: Vec<String> = fresh_qa
        .findings()
        .iter()
        .filter(|finding| {
            finding.severity == crate::video_qa::FindingSeverity::Warning
                || finding.state == crate::video_qa::FindingState::Failed
                    && finding.severity != crate::video_qa::FindingSeverity::Blocker
        })
        .map(|finding| format!("{}: {}", finding.code, finding.message))
        .collect();
    if fresh_qa.decision() == crate::video_qa::QaDecision::AllowWithWarnings
        && !profile_warnings_allowed
    {
        return Err(
            "blocked_by_qa: exact installed profile does not permit allow_with_warnings".into(),
        );
    }
    let refs = collect_inputs(&edl);
    let shots = refs.shots.iter().map(to_store_ref).collect::<Vec<_>>();
    let assets = refs.assets.iter().map(to_store_ref).collect::<Vec<_>>();
    let cues = refs.cues.iter().map(to_store_ref).collect::<Vec<_>>();
    let evidence = refs.evidence.iter().cloned().collect::<Vec<_>>();
    let inventory = store
        .video_edl_inventory(
            &VideoEdlRef {
                id: timeline.project_id.clone(),
                revision: timeline.project_revision,
            },
            &VideoEdlRef {
                id: timeline.episode_id.clone(),
                revision: timeline.episode_revision,
            },
            &VideoEdlRef {
                id: timeline.storyboard_id.clone(),
                revision: timeline.storyboard_revision,
            },
            &shots,
            &assets,
            &cues,
            &evidence,
        )
        .map_err(|e| format!("cross_project_reference: {e}"))?;
    if let Some(track) = edl.audio_tracks.first() {
        if track.ordinal != 0 || edl.video_tracks[0].ordinal != 0 {
            return Err("timeline_invalid: supported V1/A1 track ordinals must be zero".into());
        }
        let clip = &track.clips[0];
        let cue = inventory
            .cues
            .iter()
            .find(|cue| cue.cue.id == clip.cue_ref.id && cue.cue.revision == clip.cue_ref.revision)
            .ok_or("input_changed: exact persisted narration cue facts are missing")?;
        if cue.sample_rate != clip.source_sample_rate {
            return Err(
                "timeline_invalid: narration sample rate differs from its persisted cue".into(),
            );
        }
        let samples = frames_to_samples(
            clip.duration_frames,
            clip.source_sample_rate,
            edl.sequence.frame_rate.num,
            edl.sequence.frame_rate.den,
        )
        .ok_or("timeline_invalid: narration frame/sample conversion is not exact")?;
        let end = clip
            .source_in_sample
            .checked_add(samples)
            .ok_or("timeline_invalid: narration sample range overflow")?;
        if end > cue.sample_count {
            return Err(
                "timeline_invalid: narration source sample range exceeds persisted cue bounds"
                    .into(),
            );
        }
        if cue.channels == 0 || cue.sample_count == 0 {
            return Err(
                "input_changed: persisted narration cue has invalid sample/frame facts".into(),
            );
        }
    }
    let mut persisted_lineage = Vec::new();
    for asset in &inventory.assets {
        if asset.license_state == "internal_review_only" {
            warnings.push(format!("rights.internal_review_only: asset {}@{} is restricted to private review and is not rights-cleared", asset.asset.id, asset.asset.revision));
        }
        for link in store
            .video_asset_lineage(&asset.asset.id, asset.asset.revision)
            .map_err(|error| {
                format!("storage_unavailable: input lineage could not be read: {error}")
            })?
        {
            persisted_lineage.push(VideoExportLineageRefV1 {
                kind: link.upstream_kind.as_str().into(),
                id: link.upstream_id,
                revision: link.upstream_revision,
            });
        }
    }
    let fact_map: BTreeMap<(String, u32), &VideoEdlAssetFact> = inventory
        .assets
        .iter()
        .map(|fact| ((fact.asset.id.clone(), fact.asset.revision), fact))
        .collect();
    let root = fs::canonicalize(media_root)
        .map_err(|_| "storage_unavailable: managed media root is unavailable")?;
    let mut media = Vec::new();
    let video_keys: BTreeSet<(String, u32)> = edl
        .video_tracks
        .iter()
        .flat_map(|track| &track.clips)
        .map(|clip| (clip.asset_ref.id.clone(), clip.asset_ref.revision))
        .collect();
    let audio_keys: BTreeSet<(String, u32)> = edl
        .audio_tracks
        .iter()
        .flat_map(|track| &track.clips)
        .map(|clip| (clip.asset_ref.id.clone(), clip.asset_ref.revision))
        .collect();
    let expected_hashes: BTreeMap<(String, u32), String> = edl
        .video_tracks
        .iter()
        .flat_map(|track| &track.clips)
        .map(|clip| {
            (
                (clip.asset_ref.id.clone(), clip.asset_ref.revision),
                clip.verified_sha256.0.clone(),
            )
        })
        .chain(
            edl.audio_tracks
                .iter()
                .flat_map(|track| &track.clips)
                .map(|clip| {
                    (
                        (clip.asset_ref.id.clone(), clip.asset_ref.revision),
                        clip.verified_sha256.0.clone(),
                    )
                }),
        )
        .collect();
    let mut keys: Vec<_> = video_keys.union(&audio_keys).cloned().collect();
    keys.sort();
    for (id, revision) in keys {
        let fact = fact_map
            .get(&(id.clone(), revision))
            .ok_or("input_changed: exact registered asset revision is missing")?;
        if fact.capability_state != "ready" {
            return Err("input_changed: input asset is not ready".into());
        }
        if !matches!(
            fact.license_state.as_str(),
            "approved" | "internal_review_only"
        ) {
            return Err(format!(
                "rights_blocked: input asset rights state is not permitted ({})",
                fact.license_state
            ));
        }
        if fact.license_state == "internal_review_only"
            && request.export_profile_id != EXPORT_PROFILE_ID
        {
            return Err(
                "rights_blocked: internal-review assets are limited to the exact preview profile"
                    .into(),
            );
        }
        let relative = fact
            .relative_path
            .as_deref()
            .ok_or("input_changed: registered input path is missing")?;
        let input_path =
            resolve_managed_input(&root, &ExportInput::new(relative)).map_err(|_| {
                "path_rejected: registered media path is not confined to managed storage"
            })?;
        let hash = sha256_file(&input_path)
            .map_err(|_| "media_integrity_failed: input bytes could not be hashed")?;
        let pinned = expected_hashes
            .get(&(id.clone(), revision))
            .ok_or("timeline_invalid: EDL asset hash is missing")?;
        if normalize_hash(pinned) != hash
            || fact.content_hash.as_deref().map(normalize_hash).as_deref() != Some(hash.as_str())
        {
            return Err(
                "input_changed: current bytes differ from EDL or registered asset fingerprint"
                    .into(),
            );
        }
        let role = if video_keys.contains(&(id.clone(), revision)) {
            MediaRole::Video
        } else {
            MediaRole::Audio
        };
        if (role == MediaRole::Video
            && fact
                .mime_type
                .as_deref()
                .is_none_or(|v| !v.starts_with("video/")))
            || (role == MediaRole::Audio
                && fact
                    .mime_type
                    .as_deref()
                    .is_none_or(|v| !v.starts_with("audio/")))
        {
            return Err(
                "input_changed: registered media type does not match EDL track role".into(),
            );
        }
        media.push(ResolvedMedia {
            asset_id: id,
            revision,
            role,
            path: input_path,
            sha256: hash,
        });
    }
    let input_fingerprint = sha256(&serde_json::to_vec(&json!({
        "timeline_hash": timeline.timeline_hash,
        "timeline_input_fingerprint": timeline.input_fingerprint,
        "qa_input_fingerprint": qa_stored.input_fingerprint,
        "profile_ref": {"id":timeline.profile_id,"revision":timeline.profile_revision},
        "inputs": media.iter().map(|m| json!({"asset_ref":{"id":m.asset_id,"revision":m.revision},"sha256":m.sha256,"role":format!("{:?}",m.role).to_lowercase()})).collect::<Vec<_>>(),
    })).map_err(|e| e.to_string())?);
    if !warnings.is_empty() && !profile_warnings_allowed {
        return Err("blocked_by_qa: exact installed profile does not permit warnings".into());
    }
    let mut profile = ExportProfile {
        id: EXPORT_PROFILE_ID.into(),
        container: ExportContainer::Mp4,
        video_codec: VideoCodec::H264,
        width: 1280,
        height: 720,
        frame_rate: Rational::new(30, 1).map_err(|e| e.to_string())?,
        audio: AudioPolicy::OptionalAac,
        crf: 23,
        preset: H264Preset::Fast,
        max_duration_ms: Some(600_000),
    };
    if edl.audio_tracks.is_empty() {
        profile.audio = AudioPolicy::OptionalAac;
    }
    profile.validate().map_err(|e| e.to_string())?;
    Ok(ExportPlan {
        request: request.clone(),
        timeline,
        edl,
        qa_input_fingerprint: qa_stored.input_fingerprint,
        input_fingerprint,
        media,
        profile,
        warnings,
        persisted_lineage,
        job_id: String::new(),
        output_asset_id: String::new(),
    })
}

#[derive(Default)]
struct InputRefs {
    shots: BTreeSet<EdlRef>,
    assets: BTreeSet<EdlRef>,
    cues: BTreeSet<EdlRef>,
    evidence: BTreeSet<(String, String)>,
}
fn collect_inputs(edl: &EDLManifestV1) -> InputRefs {
    let mut refs = InputRefs::default();
    for clip in edl.video_tracks.iter().flat_map(|track| &track.clips) {
        refs.shots.insert(clip.shot_ref.clone());
        refs.assets.insert(clip.asset_ref.clone());
        refs.evidence.extend(
            clip.evidence_refs
                .iter()
                .map(|e| (e.kind.clone(), e.id.clone())),
        );
    }
    for clip in edl.audio_tracks.iter().flat_map(|track| &track.clips) {
        refs.assets.insert(clip.asset_ref.clone());
        refs.cues.insert(clip.cue_ref.clone());
        refs.evidence.extend(
            clip.evidence_refs
                .iter()
                .map(|e| (e.kind.clone(), e.id.clone())),
        );
    }
    for track in &edl.caption_tracks {
        refs.assets.insert(track.asset_ref.clone());
    }
    refs
}
fn to_store_ref(value: &EdlRef) -> VideoEdlRef {
    VideoEdlRef {
        id: value.id.clone(),
        revision: value.revision,
    }
}

pub fn validate_edl_shape(edl: &EDLManifestV1) -> Result<(), String> {
    if edl.schema_version != video_edl::EDL_SCHEMA_V1 || edl.video_tracks.len() != 1 {
        return Err(
            "timeline_invalid: exporter supports fina.edl.v1 with exactly one video track".into(),
        );
    }
    if !edl.caption_tracks.is_empty() {
        return Err("timeline_invalid: caption tracks are not supported by this exporter".into());
    }
    if edl.video_tracks[0].clips.is_empty() {
        return Err("timeline_invalid: at least one video clip is required".into());
    }
    let mut cursor = 0u64;
    for clip in &edl.video_tracks[0].clips {
        if clip.duration_frames == 0 || clip.start_frame != cursor {
            return Err(
                "timeline_invalid: video clips must be contiguous cuts in track order".into(),
            );
        }
        if clip.transition_after.as_ref().is_some_and(|transition| {
            transition.kind != TransitionKind::Cut || transition.duration_frames != 0
        }) {
            return Err("timeline_invalid: only zero-duration cuts are supported".into());
        }
        cursor = clip
            .start_frame
            .checked_add(clip.duration_frames)
            .ok_or("timeline_invalid: video timing overflow")?;
    }
    if cursor != edl.sequence.total_frames {
        return Err("timeline_invalid: EDL total_frames does not match video cuts".into());
    }
    if edl.audio_tracks.len() > 1 {
        return Err("timeline_invalid: multiple audio tracks are unsupported".into());
    }
    if let Some(track) = edl.audio_tracks.first() {
        if track.kind != AudioKind::Narration || track.clips.len() != 1 {
            return Err(
                "timeline_invalid: only one narration track with one audio cue is supported".into(),
            );
        }
        let clip = &track.clips[0];
        if clip.duration_frames == 0
            || clip.source_sample_rate == 0
            || clip.gain_millidb != 0
            || clip.fade_in_frames != 0
            || clip.fade_out_frames != 0
        {
            return Err(
                "timeline_invalid: narration must be a positive unmodified clip without fades"
                    .into(),
            );
        }
        if clip
            .start_frame
            .checked_add(clip.duration_frames)
            .is_none_or(|end| end > edl.sequence.total_frames)
        {
            return Err("timeline_invalid: narration clip exceeds sequence bounds".into());
        }
    }
    if edl.sequence.width != 1280
        || edl.sequence.height != 720
        || edl.sequence.frame_rate.num != 30
        || edl.sequence.frame_rate.den != 1
    {
        return Err(
            "profile_unavailable: EDL sequence does not match installed 720p30 profile".into(),
        );
    }
    let duration_ms = frames_to_ms(
        cursor,
        edl.sequence.frame_rate.num,
        edl.sequence.frame_rate.den,
    )
    .ok_or("timeline_invalid: total duration overflow")?;
    if duration_ms > 600_000 {
        return Err(
            "resource_limit: total duration exceeds installed preview profile limit".into(),
        );
    }
    Ok(())
}

fn installed_profile_warnings_allowed(profile_id: &str, revision: u32) -> bool {
    profile_id == EXPORT_PROFILE_ID && revision == 1
}

fn ensure_fresh_qa_fingerprint(stored: &str, fresh: &str) -> Result<(), String> {
    if stored.is_empty() || fresh.is_empty() || stored != fresh {
        Err(
            "stale_qa_report: recomputed trusted QA input fingerprint differs from stored report"
                .into(),
        )
    } else {
        Ok(())
    }
}

fn frames_to_samples(frames: u64, sample_rate: u32, fps_num: u32, fps_den: u32) -> Option<u64> {
    let numerator = u128::from(frames)
        .checked_mul(u128::from(sample_rate))?
        .checked_mul(u128::from(fps_den))?;
    let denominator = u128::from(fps_num);
    if denominator == 0 || numerator % denominator != 0 {
        return None;
    }
    u64::try_from(numerator / denominator).ok()
}

fn build_timeline_command(plan: &ExportPlan, output: &Path) -> Result<Command, String> {
    let root_inputs: Vec<_> = plan.media.iter().collect();
    let video_clips = &plan.edl.video_tracks[0].clips;
    let mut command = Command::new("ffmpeg");
    command.args([
        "-hide_banner",
        "-nostdin",
        "-y",
        "-filter_complex_threads",
        "1",
    ]);
    let mut input_index = BTreeMap::new();
    for (index, media) in root_inputs.iter().enumerate() {
        input_index.insert((media.asset_id.clone(), media.revision), index);
        command.arg("-i").arg(&media.path);
    }
    let mut filters = Vec::new();
    for (index, clip) in video_clips.iter().enumerate() {
        let source = *input_index
            .get(&(clip.asset_ref.id.clone(), clip.asset_ref.revision))
            .ok_or("input_changed: video input was not resolved")?;
        let trim_start = frames_to_seconds(
            clip.source_in_frame,
            plan.edl.sequence.frame_rate.num,
            plan.edl.sequence.frame_rate.den,
        )
        .ok_or("timeline_invalid: video source trim overflow")?;
        let duration = frames_to_seconds(
            clip.duration_frames,
            plan.edl.sequence.frame_rate.num,
            plan.edl.sequence.frame_rate.den,
        )
        .ok_or("timeline_invalid: clip duration overflow")?;
        filters.push(format!("[{source}:v:0]trim=start={trim_start:.9}:duration={duration:.9},setpts=PTS-STARTPTS,fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v{index}]"));
    }
    let joins = (0..video_clips.len())
        .map(|index| format!("[v{index}]"))
        .collect::<String>();
    filters.push(format!(
        "{joins}concat=n={}:v=1:a=0[vout]",
        video_clips.len()
    ));
    let audio_clip = plan
        .edl
        .audio_tracks
        .first()
        .and_then(|track| track.clips.first());
    if let Some(clip) = audio_clip {
        let source = *input_index
            .get(&(clip.asset_ref.id.clone(), clip.asset_ref.revision))
            .ok_or("input_changed: narration input was not resolved")?;
        let span = frames_to_samples(
            clip.duration_frames,
            clip.source_sample_rate,
            plan.edl.sequence.frame_rate.num,
            plan.edl.sequence.frame_rate.den,
        )
        .ok_or("timeline_invalid: audio frame/sample conversion is not exact")?;
        let end = clip
            .source_in_sample
            .checked_add(span)
            .ok_or("timeline_invalid: audio trim overflow")?;
        let delay = u64::try_from(
            u128::from(clip.start_frame)
                .checked_mul(1000)
                .ok_or("timeline_invalid: audio delay overflow")?
                * u128::from(plan.edl.sequence.frame_rate.den)
                / u128::from(plan.edl.sequence.frame_rate.num),
        )
        .map_err(|_| "timeline_invalid: audio delay overflow")?;
        let duration = frames_to_seconds(
            plan.edl.sequence.total_frames,
            plan.edl.sequence.frame_rate.num,
            plan.edl.sequence.frame_rate.den,
        )
        .ok_or("timeline_invalid: audio duration overflow")?;
        filters.push(format!("[{source}:a:0]atrim=start_sample={}:end_sample={end},asetpts=PTS-STARTPTS,adelay={delay}:all=1,apad,atrim=duration={duration:.9}[aout]",clip.source_in_sample));
    }
    command.arg("-filter_complex").arg(filters.join(";"));
    command.args(["-map", "[vout]"]);
    if audio_clip.is_some() {
        command.args(["-map", "[aout]", "-c:a", "aac", "-ar", "48000", "-ac", "2"]);
    } else {
        command.arg("-an");
    }
    command
        .args([
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-r",
            "30",
            "-frames:v",
        ])
        .arg(plan.edl.sequence.total_frames.to_string());
    let duration = frames_to_seconds(
        plan.edl.sequence.total_frames,
        plan.edl.sequence.frame_rate.num,
        plan.edl.sequence.frame_rate.den,
    )
    .ok_or("timeline_invalid: output duration overflow")?;
    command
        .args([
            "-t",
            &format!("{duration:.9}"),
            "-f",
            "mp4",
            "-movflags",
            "+faststart",
        ])
        .arg(output);
    Ok(command)
}

fn make_manifest(
    plan: &ExportPlan,
    probe: &ProbeOutput,
    duration_ms: u64,
    byte_size: u64,
    hash: String,
    ffmpeg: String,
    ffprobe: String,
    created_at: chrono::DateTime<Utc>,
) -> VideoExportManifestV1 {
    let mut lineage = plan.persisted_lineage.clone();
    lineage.extend(
        plan.edl
            .lineage_refs
            .iter()
            .map(|reference| VideoExportLineageRefV1 {
                kind: reference.kind.clone(),
                id: reference.id.clone(),
                revision: reference.revision,
            }),
    );
    lineage.extend(vec![
        VideoExportLineageRefV1 {
            kind: "timeline".into(),
            id: plan.timeline.timeline_id.clone(),
            revision: Some(plan.timeline.revision),
        },
        VideoExportLineageRefV1 {
            kind: "qa_report".into(),
            id: plan.request.qa_report_ref.id.clone(),
            revision: Some(plan.request.qa_report_ref.revision),
        },
        VideoExportLineageRefV1 {
            kind: "project".into(),
            id: plan.timeline.project_id.clone(),
            revision: Some(plan.timeline.project_revision),
        },
        VideoExportLineageRefV1 {
            kind: "episode".into(),
            id: plan.timeline.episode_id.clone(),
            revision: Some(plan.timeline.episode_revision),
        },
        VideoExportLineageRefV1 {
            kind: "storyboard".into(),
            id: plan.timeline.storyboard_id.clone(),
            revision: Some(plan.timeline.storyboard_revision),
        },
    ]);
    for clip in plan.edl.video_tracks.iter().flat_map(|t| &t.clips) {
        lineage.push(VideoExportLineageRefV1 {
            kind: "asset".into(),
            id: clip.asset_ref.id.clone(),
            revision: Some(clip.asset_ref.revision),
        });
        lineage.push(VideoExportLineageRefV1 {
            kind: "shot".into(),
            id: clip.shot_ref.id.clone(),
            revision: Some(clip.shot_ref.revision),
        });
        if let Some(spec) = &clip.visual_spec_ref {
            lineage.push(VideoExportLineageRefV1 {
                kind: "visual_spec".into(),
                id: spec.id.clone(),
                revision: Some(spec.revision),
            });
        }
        lineage.extend(
            clip.evidence_refs
                .iter()
                .map(|reference| VideoExportLineageRefV1 {
                    kind: reference.kind.clone(),
                    id: reference.id.clone(),
                    revision: reference.revision,
                }),
        );
    }
    for clip in plan.edl.audio_tracks.iter().flat_map(|t| &t.clips) {
        lineage.push(VideoExportLineageRefV1 {
            kind: "asset".into(),
            id: clip.asset_ref.id.clone(),
            revision: Some(clip.asset_ref.revision),
        });
        lineage.push(VideoExportLineageRefV1 {
            kind: "audio_cue".into(),
            id: clip.cue_ref.id.clone(),
            revision: Some(clip.cue_ref.revision),
        });
        lineage.extend(
            clip.evidence_refs
                .iter()
                .map(|reference| VideoExportLineageRefV1 {
                    kind: reference.kind.clone(),
                    id: reference.id.clone(),
                    revision: reference.revision,
                }),
        );
    }
    lineage.sort_by(|a, b| {
        a.kind
            .cmp(&b.kind)
            .then(a.id.cmp(&b.id))
            .then(a.revision.cmp(&b.revision))
    });
    lineage.dedup();
    let manifest_id = format!(
        "manifest-{}",
        plan.job_id
            .strip_prefix("video-export-")
            .unwrap_or(&plan.job_id)
    );
    let audio = probe.audio_codec.is_some();
    VideoExportManifestV1 {
        manifest_ref: VideoExportRef {
            id: manifest_id,
            revision: 1,
        },
        state: "succeeded".into(),
        project_ref: VideoExportRef {
            id: plan.timeline.project_id.clone(),
            revision: plan.timeline.project_revision,
        },
        episode_ref: VideoExportRef {
            id: plan.timeline.episode_id.clone(),
            revision: plan.timeline.episode_revision,
        },
        timeline_ref: VideoExportRef {
            id: plan.timeline.timeline_id.clone(),
            revision: plan.timeline.revision,
        },
        timeline_hash: plan.timeline.timeline_hash.clone(),
        qa_report_ref: VideoExportRef {
            id: plan.request.qa_report_ref.id.clone(),
            revision: plan.request.qa_report_ref.revision,
        },
        qa_input_fingerprint: plan.qa_input_fingerprint.clone(),
        export_profile_ref: VideoExportRef {
            id: EXPORT_PROFILE_ID.into(),
            revision: 1,
        },
        input_fingerprint: plan.input_fingerprint.clone(),
        output_asset_ref: VideoExportRef {
            id: plan.output_asset_id.clone(),
            revision: 1,
        },
        output_sha256: hash.clone(),
        probe: VideoExportProbeV1 {
            container: "mp4".into(),
            video_codec: "h264".into(),
            audio_codec: probe.audio_codec.clone(),
            width: probe.width,
            height: probe.height,
            frame_rate_num: probe.frame_rate.numerator,
            frame_rate_den: probe.frame_rate.denominator,
            duration_ms,
            byte_size,
            has_audio: audio,
            has_captions: false,
        },
        files: vec![VideoExportManifestFileV1 {
            kind: "master".into(),
            asset_ref: VideoExportRef {
                id: plan.output_asset_id.clone(),
                revision: 1,
            },
            sha256: hash,
        }],
        toolchain: VideoExportToolchainV1 {
            ffmpeg_version: ffmpeg,
            ffprobe_version: ffprobe,
            compiler_version: EXPORT_COMPILER_VERSION.into(),
        },
        deterministic: true,
        preview_only: true,
        lineage_refs: lineage,
        created_at,
    }
}

fn run_cancellable(
    mut command: Command,
    cancel: &AtomicBool,
) -> Result<std::process::ExitStatus, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| "capability_unavailable: FFmpeg could not start")?;
    let started = std::time::Instant::now();
    loop {
        if cancel.load(Ordering::SeqCst) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("job_cancelled: export cancelled".into());
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|_| "export_failed: process status unavailable")?
        {
            return Ok(status);
        }
        if started.elapsed() > Duration::from_secs(600) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                "resource_limit: media process exceeded the 10 minute profile execution limit"
                    .into(),
            );
        }
        thread::sleep(Duration::from_millis(100));
    }
}
fn run_capture(command: &mut Command) -> Result<Vec<u8>, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let child = command
        .spawn()
        .map_err(|_| "capability_unavailable: media tool could not start")?;
    let output = bounded_output(child, Duration::from_secs(10))
        .ok_or("resource_limit: media tool exceeded its 10 second operation limit")?;
    if !output.status.success() {
        return Err("media_integrity_failed: media probe or decode command failed".into());
    }
    if output.stdout.len() > 1_048_576 {
        return Err("resource_limit: media tool output exceeded the bounded response size".into());
    }
    Ok(output.stdout)
}
fn tool_version(tool: &str) -> Result<String, String> {
    let output = run_capture(Command::new(tool).arg("-version"))?;
    let text = String::from_utf8_lossy(&output);
    Ok(text
        .lines()
        .next()
        .unwrap_or("unknown")
        .chars()
        .take(200)
        .collect())
}
fn bounded_output(
    mut child: std::process::Child,
    timeout: Duration,
) -> Option<std::process::Output> {
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) => {}
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        thread::sleep(Duration::from_millis(20));
    }
}
fn tool_available(tool: &str) -> bool {
    let Ok(child) = Command::new(tool)
        .arg("-version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let start = std::time::Instant::now();
    let mut child = child;
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return status.success();
        }
        if start.elapsed() > Duration::from_secs(10) {
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }
        thread::sleep(Duration::from_millis(20));
    }
}
fn ensure_output_dir(root: &Path) -> Result<PathBuf, String> {
    let path = root.join("video-exports");
    match fs::symlink_metadata(&path) {
        Ok(m) if m.file_type().is_symlink() || !m.is_dir() => {
            return Err("path_rejected: export output directory is unsafe".into())
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => fs::create_dir(&path)
            .map_err(|_| "storage_unavailable: output directory could not be created")?,
        Err(_) => {
            return Err("storage_unavailable: output directory could not be inspected".into())
        }
    }
    let canonical = fs::canonicalize(&path)
        .map_err(|_| "storage_unavailable: output directory could not be resolved")?;
    if !canonical.starts_with(root) {
        return Err("path_rejected: export output directory escaped managed root".into());
    }
    Ok(canonical)
}
fn frames_to_seconds(frames: u64, num: u32, den: u32) -> Option<f64> {
    if num == 0 || den == 0 {
        return None;
    }
    Some(frames as f64 * den as f64 / num as f64)
}
fn frames_to_ms(frames: u64, num: u32, den: u32) -> Option<u64> {
    u64::try_from(
        u128::from(frames)
            .checked_mul(1000)?
            .checked_mul(u128::from(den))?
            / u128::from(num),
    )
    .ok()
}
fn normalize_hash(value: &str) -> String {
    if value.starts_with("sha256:") {
        value.to_owned()
    } else {
        format!("sha256:{value}")
    }
}
fn sha256(data: &[u8]) -> String {
    let bytes = Sha256::digest(data);
    format!(
        "sha256:{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}
fn validate_request_id(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > MAX_REQUEST_ID {
        return Err("invalid_argument: request_id must be non-empty and at most 128 bytes".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video_edl::{
        AudioClipV1, AudioTrackV1, CaptionDelivery, CaptionFormat, CaptionTrackV1, FindingRef,
        FitMode, Hash, Rational as EdlRational, SequenceV1, TransitionV1, VideoClipV1,
        VideoTrackV1,
    };

    fn cut_clip(id: &str, start: u64, duration: u64) -> VideoClipV1 {
        VideoClipV1 {
            clip_id: id.into(),
            shot_ref: EdlRef {
                id: format!("shot-{id}"),
                revision: 2,
            },
            visual_spec_ref: None,
            asset_ref: EdlRef {
                id: format!("asset-{id}"),
                revision: 3,
            },
            verified_sha256: Hash("sha256:input".into()),
            start_frame: start,
            duration_frames: duration,
            source_in_frame: 0,
            fit: FitMode::Contain,
            transition_after: None,
            evidence_refs: vec![],
        }
    }

    fn edl() -> EDLManifestV1 {
        EDLManifestV1 {
            schema_version: video_edl::EDL_SCHEMA_V1.into(),
            project_ref: EdlRef {
                id: "p".into(),
                revision: 1,
            },
            episode_ref: EdlRef {
                id: "e".into(),
                revision: 1,
            },
            storyboard_ref: EdlRef {
                id: "s".into(),
                revision: 4,
            },
            output_profile_ref: EdlRef {
                id: EXPORT_PROFILE_ID.into(),
                revision: 1,
            },
            sequence: SequenceV1 {
                width: 1280,
                height: 720,
                frame_rate: EdlRational { num: 30, den: 1 },
                pixel_aspect_ratio: EdlRational { num: 1, den: 1 },
                audio_sample_rate: 48_000,
                total_frames: 60,
            },
            video_tracks: vec![VideoTrackV1 {
                track_id: "V1".into(),
                ordinal: 0,
                clips: vec![cut_clip("a", 0, 30), cut_clip("b", 30, 30)],
            }],
            audio_tracks: vec![],
            caption_tracks: vec![],
            lineage_refs: vec![],
            timeline_hash: Hash("sha256:timeline".into()),
        }
    }

    fn plan(_root: &Path) -> ExportPlan {
        ExportPlan {
            request: ExportRequest {
                timeline_ref: EdlRef {
                    id: "timeline".into(),
                    revision: 1,
                },
                qa_report_ref: EdlRef {
                    id: "qa".into(),
                    revision: 1,
                },
                export_profile_id: EXPORT_PROFILE_ID.into(),
            },
            timeline: VideoEdlRevision {
                timeline_id: "timeline".into(),
                revision: 1,
                project_id: "p".into(),
                project_revision: 1,
                episode_id: "e".into(),
                episode_revision: 1,
                storyboard_id: "s".into(),
                storyboard_revision: 4,
                profile_id: EXPORT_PROFILE_ID.into(),
                profile_revision: 1,
                schema_version: "fina.edl.v1".into(),
                build_version: "test".into(),
                build_status: "ready".into(),
                timeline_hash: "sha256:timeline".into(),
                input_fingerprint: "sha256:edl".into(),
                manifest_json: String::new(),
                findings_json: "[]".into(),
                created_at: Utc::now(),
            },
            edl: edl(),
            qa_input_fingerprint: "sha256:qa".into(),
            input_fingerprint: "sha256:export".into(),
            media: vec![],
            profile: ExportProfile {
                id: EXPORT_PROFILE_ID.into(),
                container: ExportContainer::Mp4,
                video_codec: VideoCodec::H264,
                width: 1280,
                height: 720,
                frame_rate: Rational::new(30, 1).unwrap(),
                audio: AudioPolicy::OptionalAac,
                crf: 23,
                preset: H264Preset::Fast,
                max_duration_ms: Some(600_000),
            },
            warnings: vec![],
            persisted_lineage: vec![],
            job_id: "video-export-test".into(),
            output_asset_id: "asset-output".into(),
        }
    }

    #[test]
    fn changed_or_missing_qa_fingerprint_is_stale() {
        assert!(ensure_fresh_qa_fingerprint("sha256:same", "sha256:same").is_ok());
        assert!(ensure_fresh_qa_fingerprint("sha256:old", "sha256:new")
            .unwrap_err()
            .starts_with("stale_qa_report:"));
        assert!(ensure_fresh_qa_fingerprint("", "sha256:new").is_err());
    }

    #[test]
    fn exact_installed_profile_alone_authorizes_warning_decisions() {
        assert!(installed_profile_warnings_allowed(EXPORT_PROFILE_ID, 1));
        assert!(!installed_profile_warnings_allowed("invented-preview", 1));
        assert!(!installed_profile_warnings_allowed(EXPORT_PROFILE_ID, 2));
        assert!(installed_profiles()[0]["warnings_allowed"]
            .as_bool()
            .unwrap());
    }

    #[test]
    fn failed_profile_preflight_creates_no_export_job() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = Store::open(temp.path().join("db.duckdb")).unwrap();
        let request = ExportStartRequest {
            timeline_ref: EdlRef {
                id: "missing".into(),
                revision: 1,
            },
            qa_report_ref: EdlRef {
                id: "missing-qa".into(),
                revision: 1,
            },
            export_profile_id: "uninstalled-profile".into(),
            request_id: "no-job".into(),
        };
        assert!(start(&mut store, temp.path(), &request)
            .unwrap_err()
            .starts_with("profile_unavailable:"));
        assert!(store.video_jobs(20).unwrap().is_empty());
    }

    #[test]
    fn rejects_captions_tracks_gaps_transitions_and_duration_over_profile_limit() {
        let mut e = edl();
        e.caption_tracks.push(CaptionTrackV1 {
            track_id: "C1".into(),
            language: "en".into(),
            format: CaptionFormat::Webvtt,
            delivery: CaptionDelivery::Sidecar,
            asset_ref: EdlRef {
                id: "captions".into(),
                revision: 1,
            },
            verified_sha256: Hash("sha256:c".into()),
        });
        assert!(validate_edl_shape(&e)
            .unwrap_err()
            .contains("caption tracks"));
        let mut e = edl();
        e.video_tracks.push(e.video_tracks[0].clone());
        assert!(validate_edl_shape(&e)
            .unwrap_err()
            .contains("exactly one video track"));
        let mut e = edl();
        e.video_tracks[0].clips[1].start_frame = 29;
        assert!(validate_edl_shape(&e)
            .unwrap_err()
            .contains("contiguous cuts"));
        let mut e = edl();
        e.video_tracks[0].clips[0].transition_after = Some(TransitionV1 {
            kind: TransitionKind::Crossfade,
            duration_frames: 2,
        });
        assert!(validate_edl_shape(&e)
            .unwrap_err()
            .contains("zero-duration cuts"));
        let mut e = edl();
        e.sequence.total_frames = 600_001 * 30;
        e.video_tracks[0].clips.truncate(1);
        e.video_tracks[0].clips[0].duration_frames = e.sequence.total_frames;
        assert!(validate_edl_shape(&e)
            .unwrap_err()
            .starts_with("resource_limit:"));
    }

    #[test]
    fn narration_is_single_track_and_frame_sample_math_is_exact_and_bounded() {
        let mut e = edl();
        e.audio_tracks.push(AudioTrackV1 {
            track_id: "A1".into(),
            ordinal: 0,
            kind: AudioKind::Narration,
            clips: vec![AudioClipV1 {
                clip_id: "narration".into(),
                cue_ref: EdlRef {
                    id: "cue".into(),
                    revision: 1,
                },
                asset_ref: EdlRef {
                    id: "audio".into(),
                    revision: 1,
                },
                verified_sha256: Hash("sha256:audio".into()),
                start_frame: 0,
                duration_frames: 60,
                source_in_sample: 0,
                source_sample_rate: 48_000,
                gain_millidb: 0,
                fade_in_frames: 0,
                fade_out_frames: 0,
                evidence_refs: vec![],
            }],
        });
        assert!(validate_edl_shape(&e).is_ok());
        assert_eq!(frames_to_samples(60, 48_000, 30, 1), Some(96_000));
        assert_eq!(frames_to_samples(1, 48_000, 29, 1), None);
        e.audio_tracks[0].clips[0].duration_frames = 61;
        e.audio_tracks[0].clips[0].start_frame = 0;
        assert!(validate_edl_shape(&e)
            .unwrap_err()
            .contains("sequence bounds"));
    }

    #[test]
    fn command_argv_keeps_paths_as_individual_args_and_filters_generated() {
        let root = tempfile::tempdir().unwrap();
        let output_dir = root.path().join("video-exports");
        fs::create_dir(&output_dir).unwrap();
        let mut p = plan(root.path());
        p.media = vec![
            ResolvedMedia {
                asset_id: "asset-a".into(),
                revision: 3,
                role: MediaRole::Video,
                path: root.path().join("clip ' ; $().mp4"),
                sha256: "sha256:x".into(),
            },
            ResolvedMedia {
                asset_id: "asset-b".into(),
                revision: 3,
                role: MediaRole::Video,
                path: root.path().join("second.mp4"),
                sha256: "sha256:y".into(),
            },
        ];
        let cmd = build_timeline_command(&p, &output_dir.join("tmp.mp4")).unwrap();
        let args = cmd
            .get_args()
            .map(|v| v.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args
            .windows(2)
            .any(|a| a[0] == "-i" && a[1].contains("clip ' ; $().mp4")));
        assert_eq!(cmd.get_program().to_string_lossy(), "ffmpeg");
        assert!(args.iter().any(|v| v.contains("concat=n=2")));
    }

    #[test]
    fn manifest_lineage_contains_full_pinned_edl_and_clip_evidence_refs_deduplicated() {
        let root = tempfile::tempdir().unwrap();
        let mut p = plan(root.path());
        p.persisted_lineage.push(VideoExportLineageRefV1 {
            kind: "claim".into(),
            id: "claim-1".into(),
            revision: None,
        });
        p.edl.lineage_refs.push(FindingRef {
            kind: "source".into(),
            id: "source-1".into(),
            revision: Some(7),
        });
        p.edl.video_tracks[0].clips[0].evidence_refs = vec![FindingRef {
            kind: "claim".into(),
            id: "claim-1".into(),
            revision: None,
        }];
        p.edl.video_tracks[0].clips[0].visual_spec_ref = Some(EdlRef {
            id: "spec-1".into(),
            revision: 9,
        });
        let probe = ProbeOutput {
            container_names: "mov,mp4".into(),
            video_codec: "h264".into(),
            audio_codec: None,
            width: 1280,
            height: 720,
            frame_rate: Rational::new(30, 1).unwrap(),
            duration_seconds: 2.0,
            byte_size: Some(42),
        };
        let manifest = make_manifest(
            &p,
            &probe,
            2_000,
            42,
            "sha256:out".into(),
            "ffmpeg".into(),
            "ffprobe".into(),
            Utc::now(),
        );
        assert!(manifest
            .lineage_refs
            .iter()
            .any(|r| r.kind == "source" && r.id == "source-1" && r.revision == Some(7)));
        assert!(manifest
            .lineage_refs
            .iter()
            .any(|r| r.kind == "claim" && r.id == "claim-1"));
        assert!(manifest
            .lineage_refs
            .iter()
            .any(|r| r.kind == "visual_spec" && r.id == "spec-1" && r.revision == Some(9)));
        assert_eq!(
            manifest
                .lineage_refs
                .iter()
                .filter(|r| r.kind == "claim" && r.id == "claim-1")
                .count(),
            1
        );
        assert_eq!(manifest.output_sha256, manifest.files[0].sha256);
        assert_eq!(manifest.probe.byte_size, 42);
    }

    #[test]
    fn output_probe_is_parsed_and_conformance_checked_before_manifest_values() {
        let probe = parse_ffprobe_output(br#"{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720,"avg_frame_rate":"30/1"}],"format":{"format_name":"mp4","duration":"2.0","size":"12"}}"#).unwrap();
        let mut profile = plan(Path::new(".")).profile;
        assert!(validate_probe(&probe, &profile).is_ok());
        assert_eq!(probe.width, 1280);
        assert_eq!(probe.byte_size, Some(12));
        profile.width = 1920;
        assert!(validate_probe(&probe, &profile).is_err());
        assert_eq!(sha256(b"stable output"), sha256(b"stable output"));
    }
}
