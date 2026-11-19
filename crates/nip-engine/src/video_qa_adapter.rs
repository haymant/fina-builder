//! Trusted adapter for deterministic video QA. Public callers provide only exact refs and an idempotency key.
use crate::{
    video_edl::{EDLManifestV1, Ref as EdlRef},
    video_qa::{
        self, AssetRef, AssetRightsStatus, AssetRole, AudioClip, DecodeResult, EvidenceCheck,
        EvidenceRef, MediaFacts, NormalizedTimeline, OutputProfileRequirements, ProbeProperties,
        QaInput, QaReport, VersionedRef, VideoClip,
    },
};
use chrono::Utc;
use nip_domain::VideoJob;
use nip_store::{Store, VideoEdlRef, VideoQaStoredReport};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc::{sync_channel, Receiver, RecvTimeoutError},
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VideoQaRunRequest {
    pub timeline_ref: EdlRef,
    pub qa_profile_id: String,
    pub request_id: String,
}

pub fn run(
    store: &mut Store,
    media_root: &Path,
    request: &VideoQaRunRequest,
) -> Result<Value, String> {
    if request.request_id.trim().is_empty()
        || request.request_id.len() > 128
        || request.qa_profile_id.trim().is_empty()
    {
        return Err("invalid_argument: request_id and qa_profile_id are required".into());
    }
    let record = store
        .video_edl_timeline(&request.timeline_ref.id, request.timeline_ref.revision)
        .map_err(|e| e.to_string())?
        .ok_or("not_found: exact timeline revision was not found")?;
    if record.build_status != "ready" {
        return Err("timeline_invalid: only a ready EDL can be evaluated".into());
    }
    if record.profile_id != request.qa_profile_id
        || request.qa_profile_id != crate::video_edl::PREVIEW_PROFILE_ID
    {
        return Err("unsupported_profile: QA profile must exactly match the installed timeline profile revision".into());
    }
    let payload =
        json!({"timeline_ref":request.timeline_ref,"qa_profile_id":request.qa_profile_id});
    let payload_hash = sha256(&serde_json::to_vec(&payload).map_err(|e| e.to_string())?);
    let request_hash = sha256(request.request_id.as_bytes());
    let job_id = format!("video-qa-{}", &request_hash[7..31]);
    let manifest: EDLManifestV1 = serde_json::from_str(&record.manifest_json)
        .map_err(|_| "timeline_invalid: stored EDL manifest is corrupt")?;
    let report = evaluate_current(store, media_root, &record, &manifest)?;
    let report_key = sha256(format!("{payload_hash}\0{}", report.input_fingerprint()).as_bytes());
    let report_id = format!("qa-{}", &report_key[7..39]);
    let report_json = report_json(&report, &report_id, 1, &request.request_id);
    let now = Utc::now();
    let job = VideoJob {
        job_id: job_id.clone(),
        operation: "video.qa.deterministic".into(),
        status: "succeeded".into(),
        input_revision: Some(record.project_revision),
        progress_millis: 100_000,
        cancellation_requested: false,
        resource_estimate: Some(
            json!({"timeline_ref":request.timeline_ref,"qa_profile_id":request.qa_profile_id,"request_id":request.request_id}),
        ),
        output_manifest: Some(
            json!({"report_ref":{"id":report_id,"revision":1},"input_fingerprint":report.input_fingerprint(),"decision":match report.decision() {
                video_qa::QaDecision::Allow => "allow",
                video_qa::QaDecision::AllowWithWarnings => "allow_with_warnings",
                video_qa::QaDecision::Block => "block",
            }}),
        ),
        safe_error_message: None,
        started_at: Some(now),
        finished_at: Some(now),
        created_at: now,
    };
    let persisted = VideoQaStoredReport {
        report_id: report_id.clone(),
        timeline_id: record.timeline_id,
        timeline_revision: record.revision,
        project_id: record.project_id,
        input_fingerprint: report.input_fingerprint().into(),
        evaluator_version: report.evaluator_version().into(),
        profile_id: record.profile_id,
        profile_revision: record.profile_revision,
        report_json: report_json.to_string(),
        created_at: now,
    };
    if let Some((old_hash, old_job, old_report)) = store
        .video_qa_request(&request.request_id)
        .map_err(|e| e.to_string())?
    {
        if old_hash != payload_hash {
            return Err(
                "revision_conflict: request_id was reused with different exact inputs".into(),
            );
        }
        let old = store
            .video_qa_stored_report(&old_report)
            .map_err(|e| e.to_string())?
            .ok_or("stored QA report is missing")?;
        if old.input_fingerprint != report.input_fingerprint() {
            return Err(
                "input_changed: QA inputs changed since this request_id; use a new request_id"
                    .into(),
            );
        }
        let j = store
            .video_job(&old_job)
            .map_err(|e| e.to_string())?
            .ok_or("stored QA job unavailable")?;
        return Ok(
            json!({"job":j,"report_ref":{"id":old_report,"revision":1},"poll_tool":"video_job_status"}),
        );
    }
    store
        .save_video_qa_run(&request.request_id, &payload_hash, &job, &persisted)
        .map_err(|e| e.to_string())?;
    Ok(
        json!({"job":job,"report_ref":{"id":report_id,"revision":1},"report":report_json,"poll_tool":"video_job_status"}),
    )
}

/// Rebuild canonical QA inputs exclusively from the persisted timeline, Store facts,
/// managed media bytes and installed adapter policy. Export invokes this again at
/// preflight/start/worker time; no stored or caller-authored report is authoritative.
pub fn evaluate_current(
    store: &Store,
    media_root: &Path,
    record: &nip_store::VideoEdlRevision,
    manifest: &EDLManifestV1,
) -> Result<QaReport, String> {
    let shot_refs: Vec<_> = manifest
        .video_tracks
        .iter()
        .flat_map(|t| &t.clips)
        .map(|c| VideoEdlRef {
            id: c.shot_ref.id.clone(),
            revision: c.shot_ref.revision,
        })
        .collect();
    let asset_refs: Vec<_> = manifest
        .video_tracks
        .iter()
        .flat_map(|t| &t.clips)
        .map(|c| &c.asset_ref)
        .chain(
            manifest
                .audio_tracks
                .iter()
                .flat_map(|t| &t.clips)
                .map(|c| &c.asset_ref),
        )
        .chain(manifest.caption_tracks.iter().map(|c| &c.asset_ref))
        .map(|r| VideoEdlRef {
            id: r.id.clone(),
            revision: r.revision,
        })
        .collect::<Vec<_>>();
    let mut asset_refs = asset_refs;
    asset_refs.sort_by(|a, b| a.id.cmp(&b.id).then(a.revision.cmp(&b.revision)));
    asset_refs.dedup();
    let video_asset_keys: BTreeSet<(String, u32)> = manifest
        .video_tracks
        .iter()
        .flat_map(|t| &t.clips)
        .map(|c| (c.asset_ref.id.clone(), c.asset_ref.revision))
        .collect();
    let audio_asset_keys: BTreeSet<(String, u32)> = manifest
        .audio_tracks
        .iter()
        .flat_map(|t| &t.clips)
        .map(|c| (c.asset_ref.id.clone(), c.asset_ref.revision))
        .collect();
    let evidence_refs: Vec<_> = manifest
        .video_tracks
        .iter()
        .flat_map(|t| &t.clips)
        .flat_map(|c| &c.evidence_refs)
        .chain(
            manifest
                .audio_tracks
                .iter()
                .flat_map(|t| &t.clips)
                .flat_map(|c| &c.evidence_refs),
        )
        .map(|r| (r.kind.clone(), r.id.clone()))
        .collect();
    let cue_refs: Vec<VideoEdlRef> = manifest
        .audio_tracks
        .iter()
        .flat_map(|track| &track.clips)
        .map(|clip| VideoEdlRef {
            id: clip.cue_ref.id.clone(),
            revision: clip.cue_ref.revision,
        })
        .collect();
    let inv = store
        .video_edl_inventory(
            &VideoEdlRef {
                id: record.project_id.clone(),
                revision: record.project_revision,
            },
            &VideoEdlRef {
                id: record.episode_id.clone(),
                revision: record.episode_revision,
            },
            &VideoEdlRef {
                id: record.storyboard_id.clone(),
                revision: record.storyboard_revision,
            },
            &shot_refs,
            &asset_refs,
            &cue_refs,
            &evidence_refs,
        )
        .map_err(|e| format!("cross_project_reference: {e}"))?;
    let fps = (
        manifest.sequence.frame_rate.num,
        manifest.sequence.frame_rate.den,
    );
    let total_ms = frames_ms(manifest.sequence.total_frames, fps)
        .ok_or("timeline_invalid: duration overflow")?;
    let claiming: BTreeSet<String> = inv
        .selected_shots
        .iter()
        .filter(|s| s.claiming)
        .map(|s| format!("{}@{}", s.shot.id, s.shot.revision))
        .collect();
    let video_clips = manifest
        .video_tracks
        .iter()
        .flat_map(|t| &t.clips)
        .map(|c| {
            let (start_ms, duration_ms) = frame_range_ms(c.start_frame, c.duration_frames, fps)
                .ok_or("timeline timing overflow")?;
            Ok(VideoClip {
                clip_id: c.clip_id.clone(),
                shot_id: c.shot_ref.id.clone(),
                asset: AssetRef {
                    id: c.asset_ref.id.clone(),
                    revision: c.asset_ref.revision,
                },
                expected_sha256: c.verified_sha256.0.clone(),
                start_ms,
                duration_ms,
                source_in_ms: frames_ms(c.source_in_frame, fps).ok_or("source trim overflow")?,
                gap_allowed_before: false,
                overlap_allowed_with_previous: c
                    .transition_after
                    .as_ref()
                    .is_some_and(|t| t.duration_frames > 0),
                evidence: c
                    .evidence_refs
                    .iter()
                    .map(|e| EvidenceRef {
                        kind: e.kind.clone(),
                        id: e.id.clone(),
                        required: claiming
                            .contains(&format!("{}@{}", c.shot_ref.id, c.shot_ref.revision)),
                    })
                    .collect(),
            })
        })
        .collect::<Result<Vec<_>, &str>>()?;
    let audio_clips = manifest
        .audio_tracks
        .iter()
        .flat_map(|t| &t.clips)
        .map(|c| {
            let (start_ms, duration_ms) = frame_range_ms(c.start_frame, c.duration_frames, fps)
                .ok_or("audio timing overflow")?;
            Ok(AudioClip {
                clip_id: c.clip_id.clone(),
                asset: AssetRef {
                    id: c.asset_ref.id.clone(),
                    revision: c.asset_ref.revision,
                },
                expected_sha256: c.verified_sha256.0.clone(),
                start_ms,
                duration_ms,
                source_in_ms: sample_ms(c.source_in_sample, c.source_sample_rate)
                    .ok_or("audio source trim overflow")?,
                evidence: c
                    .evidence_refs
                    .iter()
                    .map(|e| EvidenceRef {
                        kind: e.kind.clone(),
                        id: e.id.clone(),
                        required: true,
                    })
                    .collect(),
            })
        })
        .collect::<Result<Vec<_>, &str>>()?;
    let timeline = NormalizedTimeline {
        timeline_ref: VersionedRef {
            id: record.timeline_id.clone(),
            revision: record.revision,
        },
        project_ref: VersionedRef {
            id: record.project_id.clone(),
            revision: record.project_revision,
        },
        timeline_hash: record.timeline_hash.clone(),
        profile_ref: VersionedRef {
            id: record.profile_id.clone(),
            revision: record.profile_revision,
        },
        total_duration_ms: total_ms,
        required_shot_ids: inv
            .storyboard_shots
            .iter()
            .map(|s| s.shot.id.clone())
            .collect(),
        video_clips,
        audio_clips,
        parent_refs_valid: Some(true),
    };
    let root = media_root
        .canonicalize()
        .unwrap_or_else(|_| media_root.to_path_buf());
    let mut media_facts = Vec::new();
    let mut rights = BTreeMap::new();
    let mut evidence_checks = BTreeMap::new();
    for asset in &asset_refs {
        let key = (asset.id.clone(), asset.revision);
        if !video_asset_keys.contains(&key) && !audio_asset_keys.contains(&key) {
            continue;
        }
        let fact = inv
            .assets
            .iter()
            .find(|a| a.asset.id == asset.id && a.asset.revision == asset.revision);
        let role = if audio_asset_keys.contains(&key) {
            AssetRole::Audio
        } else {
            AssetRole::Video
        };
        let expected = fact
            .and_then(|f| f.content_hash.as_deref())
            .map(normalize_hash)
            .flatten();
        // The available ledger stores an asset license state, but not the current canonical source-rights decision.
        match fact.map(|f| f.license_state.as_str()) {
            Some("internal_review_only") => {
                rights.insert(
                    format!("{}@{}", asset.id, asset.revision),
                    AssetRightsStatus::InternalReviewOnly,
                );
            }
            Some("blocked") => {
                rights.insert(
                    format!("{}@{}", asset.id, asset.revision),
                    AssetRightsStatus::Blocked,
                );
            }
            Some("purge_required") => {
                rights.insert(
                    format!("{}@{}", asset.id, asset.revision),
                    AssetRightsStatus::PurgeRequired,
                );
            }
            Some("unreviewed") => {
                rights.insert(
                    format!("{}@{}", asset.id, asset.revision),
                    AssetRightsStatus::Unreviewed,
                );
            }
            _ => {}
        }
        let Some(meta) = fact else {
            continue;
        };
        let Some(relative) = meta.relative_path.as_deref() else {
            continue;
        };
        if !safe_relative(relative) {
            continue;
        }
        let candidate = root.join(relative);
        let (canonical, escaped) = resolve_confined(&root, &candidate);
        let Ok(path) = canonical else {
            continue;
        };
        let mut hasher = Sha256::new();
        let actual = File::open(&path).ok().and_then(|mut f| {
            let mut b = [0u8; 65536];
            loop {
                match f.read(&mut b) {
                    Ok(0) => break,
                    Ok(n) => hasher.update(&b[..n]),
                    Err(_) => return None,
                }
            }
            Some(format!("sha256:{}", hex(&hasher.finalize())))
        });
        let probe = probe_media(&path, role);
        let decode = decode_media(&path);
        let mut source_valid = if role == AssetRole::Video {
            Some(meta.related_shots.iter().any(|s| {
                manifest
                    .video_tracks
                    .iter()
                    .flat_map(|t| &t.clips)
                    .any(|c| {
                        c.asset_ref.id == asset.id
                            && c.asset_ref.revision == asset.revision
                            && c.shot_ref.id == s.id
                            && c.shot_ref.revision == s.revision
                    })
            }))
        } else {
            None
        };
        if role == AssetRole::Audio {
            source_valid = Some(
                meta.capability_state == "ready"
                    && matches!(
                        meta.license_state.as_str(),
                        "approved" | "internal_review_only"
                    ),
            );
        }
        media_facts.push(MediaFacts {
            asset: AssetRef {
                id: asset.id.clone(),
                revision: asset.revision,
            },
            role,
            resolved_path: path.to_string_lossy().into_owned(),
            managed_root: root.to_string_lossy().into_owned(),
            symlink_escape_detected: escaped,
            actual_sha256: actual,
            expected_sha256: expected,
            probe,
            decode_result: decode,
            source_lineage_valid: source_valid,
        });
    }
    for ev in &evidence_refs {
        let k = format!("{}:{}", ev.0, ev.1);
        let valid = inv.evidence.contains(ev);
        let span_valid = if ev.0 == "event" {
            // Event IDs enter the validated inventory only through a selected cue
            // with an exact retained-text span; unspanned lineage refs are excluded.
            valid
        } else {
            store
                .video_evidence_span_valid(&ev.0, &ev.1)
                .unwrap_or(false)
        };
        evidence_checks.insert(
            k,
            EvidenceCheck {
                reference_valid: valid,
                span_valid,
                non_claiming_reason: None,
            },
        );
    }
    let profile = OutputProfileRequirements {
        profile_ref: timeline.profile_ref.clone(),
        available: true,
        required_container: "mp4".into(),
        required_video_codec: "h264".into(),
        width: manifest.sequence.width,
        height: manifest.sequence.height,
        fps_num: fps.0,
        fps_den: fps.1,
        min_duration_ms: 1,
        max_duration_ms: 600_000,
        audio_required: false,
        required_audio_codec: None,
        required_audio_sample_rate: None,
        required_audio_channels: None,
    };
    let input = QaInput {
        timeline,
        media_facts,
        rights,
        evidence_checks,
        profile,
    };
    Ok(video_qa::evaluate(&input))
}

fn report_json(r: &QaReport, id: &str, rev: u32, run_id: &str) -> Value {
    let mut v = serde_json::to_value(r).unwrap_or(Value::Null);
    if let Some(o) = v.as_object_mut() {
        o.insert("report_ref".into(), json!({"id":id,"revision":rev}));
        o.insert("run_id".into(), json!(run_id));
        o.insert("created_at".into(), json!(Utc::now()));
    }
    v
}
fn frames_ms(frames: u64, fps: (u32, u32)) -> Option<u64> {
    if fps.0 == 0 || fps.1 == 0 {
        return None;
    }
    u64::try_from(
        u128::from(frames)
            .checked_mul(1000)?
            .checked_mul(u128::from(fps.1))?
            / u128::from(fps.0),
    )
    .ok()
}
fn frame_range_ms(start_frame: u64, duration_frames: u64, fps: (u32, u32)) -> Option<(u64, u64)> {
    let end_frame = start_frame.checked_add(duration_frames)?;
    let start_ms = frames_ms(start_frame, fps)?;
    let end_ms = frames_ms(end_frame, fps)?;
    Some((start_ms, end_ms.checked_sub(start_ms)?))
}
fn sample_ms(samples: u64, rate: u32) -> Option<u64> {
    if rate == 0 {
        return None;
    }
    u64::try_from(u128::from(samples).checked_mul(1000)? / u128::from(rate)).ok()
}
fn safe_relative(v: &str) -> bool {
    let p = Path::new(v);
    !v.is_empty()
        && !p.is_absolute()
        && !v.contains('\\')
        && p.components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}
fn resolve_confined(root: &Path, p: &Path) -> (Result<PathBuf, std::io::Error>, bool) {
    let c = p.canonicalize();
    let r = root.canonicalize();
    match (c, r) {
        (Ok(c), Ok(r)) => {
            let escape = !c.starts_with(&r) || c == r;
            (Ok(c), escape)
        }
        (Err(e), _) => (Err(e), false),
        _ => (Err(std::io::Error::other("media root unavailable")), true),
    }
}
fn normalize_hash(s: &str) -> Option<String> {
    let h = s.strip_prefix("sha256:").unwrap_or(s);
    (h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| format!("sha256:{}", h.to_ascii_lowercase()))
}
fn sha256(b: &[u8]) -> String {
    format!("sha256:{}", hex(&Sha256::digest(b)))
}
fn hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char)
    }
    s
}
fn bounded_output(mut c: std::process::Child, timeout: Duration) -> Option<std::process::Output> {
    let start = Instant::now();
    loop {
        if let Ok(Some(_)) = c.try_wait() {
            return c.wait_with_output().ok();
        }
        if start.elapsed() > timeout {
            let _ = c.kill();
            let _ = c.wait();
            return None;
        }
        thread::sleep(Duration::from_millis(20));
    }
}
fn probe_media(path: &Path, role: AssetRole) -> Option<ProbeProperties> {
    let mut c = Command::new("ffprobe");
    c.args(["-v","error","-show_entries","format=format_name,duration:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels,duration","-of","json"]).arg(path).stdout(Stdio::piped()).stderr(Stdio::null());
    let o = bounded_output(c.spawn().ok()?, Duration::from_secs(10))?;
    if !o.status.success() || o.stdout.len() > 65536 {
        return None;
    }
    let j: Value = serde_json::from_slice(&o.stdout).ok()?;
    let streams = j["streams"].as_array()?;
    let v = streams.iter().find(|s| s["codec_type"] == "video");
    let a = streams.iter().find(|s| s["codec_type"] == "audio");
    let (fps_num, fps_den) = v
        .and_then(|s| s["r_frame_rate"].as_str())
        .and_then(parse_ratio)
        .map_or((None, None), |(n, d)| (Some(n), Some(d)));
    let duration = j["format"]["duration"]
        .as_str()
        .and_then(|x| x.parse::<f64>().ok())
        .filter(|x| x.is_finite() && *x >= 0.0)
        .map(|x| (x * 1000.0) as u64)
        .or_else(|| {
            v.and_then(|s| s["duration"].as_str())
                .and_then(|x| x.parse::<f64>().ok())
                .map(|x| (x * 1000.0) as u64)
        });
    let audio_channels = a
        .and_then(|s| s["channels"].as_u64())
        .and_then(|n| u16::try_from(n).ok());
    let audio_clipped = if role == AssetRole::Audio {
        analyze_audio_clipping(path, audio_channels)
    } else {
        None
    };
    Some(ProbeProperties {
        container: j["format"]["format_name"].as_str().map(|s| {
            if s.split(',').any(|x| x == "mov" || x == "mp4") {
                "mp4".into()
            } else {
                s.split(',').next().unwrap_or(s).into()
            }
        }),
        video_codec: v.and_then(|s| s["codec_name"].as_str()).map(str::to_owned),
        width: v
            .and_then(|s| s["width"].as_u64())
            .and_then(|n| u32::try_from(n).ok()),
        height: v
            .and_then(|s| s["height"].as_u64())
            .and_then(|n| u32::try_from(n).ok()),
        fps_num,
        fps_den,
        duration_ms: duration,
        has_audio_stream: Some(a.is_some()),
        audio_codec: a.and_then(|s| s["codec_name"].as_str()).map(str::to_owned),
        audio_sample_rate: a
            .and_then(|s| s["sample_rate"].as_str())
            .and_then(|s| s.parse().ok()),
        audio_channels,
        audio_clipped,
    })
}

// Detect sustained decoded digital near-rail plateaus, not a single transient or
// two-sample peak. This cannot certify against analog, inter-sample, or upstream clipping.
const CLIPPING_SAMPLE_THRESHOLD: f32 = 0.9999;
const CLIPPING_RUN_LENGTH: u8 = 3;
const MAX_CLIPPING_SAMPLE_VALUES: u64 = 64_000_000;
const CLIPPING_ANALYSIS_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_CLIPPING_CHANNELS: usize = 64;

struct ClippingSampleScanner {
    channels: usize,
    near_rail_runs: Vec<u8>,
    sample_count: u64,
    clipped: bool,
    partial: [u8; 4],
    partial_len: usize,
}

impl ClippingSampleScanner {
    fn new(channels: usize) -> Option<Self> {
        (1..=MAX_CLIPPING_CHANNELS)
            .contains(&channels)
            .then(|| Self {
                channels,
                near_rail_runs: vec![0; channels],
                sample_count: 0,
                clipped: false,
                partial: [0; 4],
                partial_len: 0,
            })
    }

    fn push_sample(&mut self, sample: f32) -> bool {
        if !sample.is_finite() || self.sample_count >= MAX_CLIPPING_SAMPLE_VALUES {
            return false;
        }
        let channel = self.sample_count as usize % self.channels;
        let run = if sample.abs() >= CLIPPING_SAMPLE_THRESHOLD {
            self.near_rail_runs[channel].saturating_add(1)
        } else {
            0
        };
        self.near_rail_runs[channel] = run;
        self.clipped |= run >= CLIPPING_RUN_LENGTH;
        self.sample_count += 1;
        true
    }

    fn push_bytes(&mut self, bytes: &[u8]) -> bool {
        let mut offset = 0;
        if self.partial_len > 0 {
            let needed = 4 - self.partial_len;
            let take = needed.min(bytes.len());
            self.partial[self.partial_len..self.partial_len + take].copy_from_slice(&bytes[..take]);
            self.partial_len += take;
            offset += take;
            if self.partial_len == 4 {
                let sample = f32::from_le_bytes(self.partial);
                self.partial_len = 0;
                if !self.push_sample(sample) {
                    return false;
                }
            } else {
                return true;
            }
        }
        while offset + 4 <= bytes.len() {
            let sample = f32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
            if !self.push_sample(sample) {
                return false;
            }
            offset += 4;
        }
        let remaining = bytes.len() - offset;
        self.partial[..remaining].copy_from_slice(&bytes[offset..]);
        self.partial_len = remaining;
        true
    }

    fn finish(self) -> Option<bool> {
        if self.sample_count == 0
            || self.partial_len != 0
            || self.sample_count % self.channels as u64 != 0
        {
            None
        } else {
            Some(self.clipped)
        }
    }
}

fn analyze_audio_clipping(path: &Path, channels: Option<u16>) -> Option<bool> {
    let channels = usize::from(channels?);
    let mut scanner = ClippingSampleScanner::new(channels)?;
    let mut child = Command::new("ffmpeg")
        .args(["-hide_banner", "-nostdin", "-v", "error", "-xerror", "-i"])
        .arg(path)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-c:a",
            "pcm_f32le",
            "-f",
            "f32le",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    let (sender, receiver) = sync_channel::<std::io::Result<Vec<u8>>>(2);
    let reader = thread::spawn(move || {
        let mut buffer = [0u8; 64 * 1024];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    if sender.send(Ok(buffer[..length].to_vec())).is_err() {
                        break;
                    }
                }
                Err(error) => {
                    let _ = sender.send(Err(error));
                    break;
                }
            }
        }
    });
    let started = Instant::now();
    let mut exit_status = None;
    loop {
        if started.elapsed() >= CLIPPING_ANALYSIS_TIMEOUT {
            stop_clipping_reader(&mut child, receiver, reader);
            return None;
        }
        match receiver.recv_timeout(Duration::from_millis(25)) {
            Ok(Ok(bytes)) => {
                if !scanner.push_bytes(&bytes) {
                    stop_clipping_reader(&mut child, receiver, reader);
                    return None;
                }
            }
            Ok(Err(_)) => {
                stop_clipping_reader(&mut child, receiver, reader);
                return None;
            }
            Err(RecvTimeoutError::Timeout) => match child.try_wait() {
                Ok(Some(status)) => exit_status = Some(status),
                Ok(None) => {}
                Err(_) => {
                    stop_clipping_reader(&mut child, receiver, reader);
                    return None;
                }
            },
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    let status = match exit_status {
        Some(status) => status,
        None => child.wait().ok()?,
    };
    if !status.success() || reader.join().is_err() {
        return None;
    }
    scanner.finish()
}

fn stop_clipping_reader(
    child: &mut std::process::Child,
    receiver: Receiver<std::io::Result<Vec<u8>>>,
    reader: thread::JoinHandle<()>,
) {
    let _ = child.kill();
    let _ = child.wait();
    drop(receiver);
    let _ = reader.join();
}

fn parse_ratio(s: &str) -> Option<(u32, u32)> {
    let mut i = s.split('/');
    Some((i.next()?.parse().ok()?, i.next()?.parse().ok()?))
}
fn decode_media(path: &Path) -> DecodeResult {
    let child = Command::new("ffmpeg")
        .args(["-v", "error", "-xerror", "-i"])
        .arg(path)
        .args(["-f", "null", "-"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let Ok(child) = child else {
        return DecodeResult::NotRun;
    };
    match bounded_output(child, Duration::from_secs(120)) {
        Some(o) if o.status.success() => DecodeResult::Decoded,
        Some(_) => DecodeResult::Failed,
        None => DecodeResult::Failed,
    }
}

#[cfg(test)]
mod clipping_tests {
    use super::{ClippingSampleScanner, MAX_CLIPPING_SAMPLE_VALUES};

    fn bytes(samples: &[f32]) -> Vec<u8> {
        samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect()
    }

    fn scan(samples: &[f32], channels: usize) -> Option<bool> {
        let mut scanner = ClippingSampleScanner::new(channels)?;
        if !scanner.push_bytes(&bytes(samples)) {
            return None;
        }
        scanner.finish()
    }

    #[test]
    fn scanner_detects_sustained_positive_and_negative_near_rail_plateaus() {
        assert_eq!(scan(&[0.2, 1.0, 1.0, 1.0, 0.2], 1), Some(true));
        assert_eq!(scan(&[-1.0, -1.0, -1.0], 1), Some(true));
    }

    #[test]
    fn scanner_does_not_call_an_isolated_or_two_sample_peak_clipping() {
        assert_eq!(scan(&[0.2, 1.0, 0.2], 1), Some(false));
        assert_eq!(scan(&[1.0, 1.0], 1), Some(false));
        assert_eq!(scan(&[0.2, 0.3, 0.4], 1), Some(false));
    }

    #[test]
    fn scanner_tracks_runs_per_channel_across_interleaved_samples() {
        assert_eq!(scan(&[1.0, 1.0, 1.0, 0.0, 0.0, 1.0], 2), Some(false));
        assert_eq!(scan(&[1.0, 0.0, 1.0, 0.0, 1.0, 0.0], 2), Some(true));
    }

    #[test]
    fn scanner_rejects_empty_misaligned_nonfinite_and_over_budget_streams() {
        assert_eq!(scan(&[], 1), None);
        assert_eq!(scan(&[f32::NAN], 1), None);
        assert_eq!(scan(&[f32::INFINITY], 1), None);
        assert_eq!(scan(&[0.0], 0), None);

        let mut partial = ClippingSampleScanner::new(1).unwrap();
        assert!(partial.push_bytes(&[0, 0, 0]));
        assert_eq!(partial.finish(), None);

        let mut over_budget = ClippingSampleScanner::new(1).unwrap();
        over_budget.sample_count = MAX_CLIPPING_SAMPLE_VALUES;
        assert!(!over_budget.push_bytes(&bytes(&[0.0])));
    }

    #[test]
    fn scanner_preserves_partial_float_samples_across_chunks() {
        let stream = bytes(&[1.0, 1.0, 1.0]);
        let mut scanner = ClippingSampleScanner::new(1).unwrap();
        assert!(scanner.push_bytes(&stream[..1]));
        assert!(scanner.push_bytes(&stream[1..2]));
        assert!(scanner.push_bytes(&stream[2..9]));
        assert!(scanner.push_bytes(&stream[9..]));
        assert_eq!(scanner.finish(), Some(true));
    }
}
