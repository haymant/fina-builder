//! Pure compiler and validator for the immutable `fina.edl.v1` timeline format.
//!
//! This module deliberately does not resolve files, invoke FFmpeg, inspect media bytes,
//! or persist records. Callers supply exact refs and verified hashes; unresolved inputs
//! remain represented as blockers in the returned non-exportable candidate.

use std::collections::BTreeSet;

use nip_domain::{VideoTimeline, VideoTimelineClip};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const EDL_SCHEMA_V1: &str = "fina.edl.v1";

/// Revision-pinned reference used throughout the EDL.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Ref {
    pub id: String,
    pub revision: u32,
}

/// SHA-256 digest in the external contract's `sha256:<hex>` representation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Hash(pub String);

impl Hash {
    pub fn from_bytes(bytes: &[u8]) -> Self {
        Self(format!("sha256:{}", hex(&Sha256::digest(bytes))))
    }
}

/// Typed evidence/lineage pointer. Canonical source truth is referenced, not copied.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct FindingRef {
    pub kind: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rational {
    pub num: u32,
    pub den: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SequenceV1 {
    pub width: u32,
    pub height: u32,
    pub frame_rate: Rational,
    pub pixel_aspect_ratio: Rational,
    pub audio_sample_rate: u32,
    pub total_frames: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FitMode {
    Contain,
    Cover,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransitionKind {
    Cut,
    Crossfade,
    FadeToBlack,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransitionV1 {
    pub kind: TransitionKind,
    pub duration_frames: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoClipV1 {
    pub clip_id: String,
    pub shot_ref: Ref,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visual_spec_ref: Option<Ref>,
    pub asset_ref: Ref,
    pub verified_sha256: Hash,
    pub start_frame: u64,
    pub duration_frames: u64,
    pub source_in_frame: u64,
    pub fit: FitMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transition_after: Option<TransitionV1>,
    #[serde(default)]
    pub evidence_refs: Vec<FindingRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoTrackV1 {
    pub track_id: String,
    pub ordinal: u32,
    pub clips: Vec<VideoClipV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioKind {
    Narration,
    Music,
    Effects,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioClipV1 {
    pub clip_id: String,
    pub cue_ref: Ref,
    pub asset_ref: Ref,
    pub verified_sha256: Hash,
    pub start_frame: u64,
    pub duration_frames: u64,
    pub source_in_sample: u64,
    pub source_sample_rate: u32,
    pub gain_millidb: i32,
    pub fade_in_frames: u64,
    pub fade_out_frames: u64,
    #[serde(default)]
    pub evidence_refs: Vec<FindingRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioTrackV1 {
    pub track_id: String,
    pub ordinal: u32,
    pub kind: AudioKind,
    pub clips: Vec<AudioClipV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptionFormat {
    Webvtt,
    Srt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptionDelivery {
    Sidecar,
    BurnIn,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptionTrackV1 {
    pub track_id: String,
    pub language: String,
    pub format: CaptionFormat,
    pub delivery: CaptionDelivery,
    pub asset_ref: Ref,
    pub verified_sha256: Hash,
}

/// `timeline_hash` is computed over all preceding content, excluding itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EDLManifestV1 {
    pub schema_version: String,
    pub project_ref: Ref,
    pub episode_ref: Ref,
    pub storyboard_ref: Ref,
    pub output_profile_ref: Ref,
    pub sequence: SequenceV1,
    pub video_tracks: Vec<VideoTrackV1>,
    #[serde(default)]
    pub audio_tracks: Vec<AudioTrackV1>,
    #[serde(default)]
    pub caption_tracks: Vec<CaptionTrackV1>,
    #[serde(default)]
    pub lineage_refs: Vec<FindingRef>,
    pub timeline_hash: Hash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Blocker,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    pub code: String,
    pub severity: Severity,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject_ref: Option<FindingRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompileOutcome {
    /// May be an invalid, diagnostic-only candidate when `ready` is false.
    pub manifest: EDLManifestV1,
    pub findings: Vec<Finding>,
    pub ready: bool,
}

/// Existence/claim policy known to the caller. `None` means the corresponding external
/// inventory was not supplied; `Some(empty)` means no referenced items exist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationContext {
    pub claiming_shot_refs: BTreeSet<Ref>,
    pub available_assets: Option<BTreeSet<Ref>>,
    pub available_evidence: Option<BTreeSet<FindingRef>>,
    /// V1 can encode these transition kinds; render capability remains an explicit gate.
    pub supported_transitions: BTreeSet<TransitionKind>,
}

impl Default for ValidationContext {
    fn default() -> Self {
        Self {
            claiming_shot_refs: BTreeSet::new(),
            available_assets: None,
            available_evidence: None,
            supported_transitions: [TransitionKind::Cut].into_iter().collect(),
        }
    }
}

/// Validate a candidate manifest and return deterministic, stable-code findings.
pub fn validate_edl_v1(manifest: &EDLManifestV1, context: &ValidationContext) -> Vec<Finding> {
    let mut findings = Vec::new();
    if manifest.schema_version != EDL_SCHEMA_V1 {
        finding(
            &mut findings,
            "timeline.malformed_timing",
            "Unsupported EDL schema version",
            None,
        );
    }
    let seq = &manifest.sequence;
    if seq.width == 0
        || seq.height == 0
        || seq.frame_rate.num == 0
        || seq.frame_rate.den == 0
        || seq.pixel_aspect_ratio.num == 0
        || seq.pixel_aspect_ratio.den == 0
        || seq.audio_sample_rate == 0
    {
        finding(
            &mut findings,
            "timeline.malformed_timing",
            "Sequence dimensions, rates, and sample rate must be positive",
            None,
        );
    }
    if manifest.video_tracks.is_empty()
        || manifest
            .video_tracks
            .iter()
            .all(|track| track.clips.is_empty())
    {
        finding(
            &mut findings,
            "asset.missing",
            "V1 EDL requires at least one video clip",
            None,
        );
    }

    let mut max_end = 0_u64;
    for track in &manifest.video_tracks {
        for (index, clip) in track.clips.iter().enumerate() {
            let subject = Some(FindingRef {
                kind: "shot".into(),
                id: clip.shot_ref.id.clone(),
                revision: Some(clip.shot_ref.revision),
            });
            if clip.duration_frames == 0 {
                finding(
                    &mut findings,
                    "timeline.malformed_timing",
                    "Video clip duration must be positive",
                    subject.clone(),
                );
            }
            let end = match clip.start_frame.checked_add(clip.duration_frames) {
                Some(end) => end,
                None => {
                    finding(
                        &mut findings,
                        "timeline.frame_overflow",
                        "Video clip end frame overflows u64",
                        subject.clone(),
                    );
                    continue;
                }
            };
            max_end = max_end.max(end);
            if index == 0 && clip.start_frame != 0 {
                finding(
                    &mut findings,
                    "timeline.gap",
                    "Video track does not begin at frame zero",
                    subject.clone(),
                );
            }
            if clip.asset_ref.id.trim().is_empty()
                || clip.asset_ref.revision == 0
                || !valid_sha256(&clip.verified_sha256.0)
            {
                finding(
                    &mut findings,
                    "asset.missing",
                    "Video clip lacks an exact asset ref or verified SHA-256",
                    subject.clone(),
                );
            } else if context
                .available_assets
                .as_ref()
                .is_some_and(|assets| !assets.contains(&clip.asset_ref))
            {
                finding(
                    &mut findings,
                    "asset.missing",
                    "Referenced video asset revision is unavailable",
                    subject.clone(),
                );
            }
            if clip.shot_ref.id.trim().is_empty() || clip.shot_ref.revision == 0 {
                finding(
                    &mut findings,
                    "timeline.malformed_timing",
                    "Shot reference must include a non-empty ID and positive revision",
                    subject.clone(),
                );
            }
            if context.claiming_shot_refs.contains(&clip.shot_ref) && clip.evidence_refs.is_empty()
            {
                finding(
                    &mut findings,
                    "evidence.missing_required_ref",
                    "Claiming shot has no evidence refs",
                    subject.clone(),
                );
            }
            for evidence in &clip.evidence_refs {
                if evidence.kind.trim().is_empty() || evidence.id.trim().is_empty() {
                    finding(
                        &mut findings,
                        "evidence.missing_required_ref",
                        "Evidence ref must include kind and ID",
                        subject.clone(),
                    );
                } else if context
                    .available_evidence
                    .as_ref()
                    .is_some_and(|known| !known.contains(evidence))
                {
                    finding(
                        &mut findings,
                        "evidence.missing_required_ref",
                        "Referenced evidence is unavailable",
                        subject.clone(),
                    );
                }
            }
            if let Some(transition) = &clip.transition_after {
                if !context.supported_transitions.contains(&transition.kind) {
                    finding(
                        &mut findings,
                        "timeline.unsupported_transition",
                        "Transition is not enabled by the caller's capability policy",
                        subject.clone(),
                    );
                }
                if (transition.kind == TransitionKind::Cut && transition.duration_frames != 0)
                    || (transition.kind != TransitionKind::Cut && transition.duration_frames == 0)
                {
                    finding(&mut findings, "timeline.malformed_timing", "Cut must have zero duration; non-cut transitions must have positive duration", subject.clone());
                }
                if transition.duration_frames > clip.duration_frames {
                    finding(
                        &mut findings,
                        "timeline.malformed_timing",
                        "Transition duration exceeds its outgoing clip",
                        subject.clone(),
                    );
                }
                if index + 1 == track.clips.len() {
                    finding(
                        &mut findings,
                        "timeline.malformed_timing",
                        "Final clip cannot declare a transition without a following clip",
                        subject.clone(),
                    );
                }
            }

            if index > 0 {
                let prev = &track.clips[index - 1];
                if let Some(prev_end) = prev.start_frame.checked_add(prev.duration_frames) {
                    let transition_frames = prev
                        .transition_after
                        .as_ref()
                        .map_or(0, |t| t.duration_frames);
                    match prev_end.checked_sub(transition_frames) {
                        None => finding(
                            &mut findings,
                            "timeline.malformed_timing",
                            "Transition begins before its outgoing clip",
                            subject.clone(),
                        ),
                        Some(expected_start) if clip.start_frame > expected_start => finding(
                            &mut findings,
                            "timeline.gap",
                            "Video track contains an unapproved gap",
                            subject.clone(),
                        ),
                        Some(expected_start) if clip.start_frame < expected_start => finding(
                            &mut findings,
                            "timeline.unexpected_overlap",
                            "Video clips overlap beyond the declared transition",
                            subject.clone(),
                        ),
                        _ => {}
                    }
                }
            }
        }
    }
    for track in &manifest.audio_tracks {
        for clip in &track.clips {
            let subject = Some(FindingRef {
                kind: "cue".into(),
                id: clip.cue_ref.id.clone(),
                revision: Some(clip.cue_ref.revision),
            });
            if clip.duration_frames == 0 || clip.source_sample_rate == 0 {
                finding(
                    &mut findings,
                    "timeline.malformed_timing",
                    "Audio duration and source sample rate must be positive",
                    subject.clone(),
                );
            }
            match clip.start_frame.checked_add(clip.duration_frames) {
                Some(end) => max_end = max_end.max(end),
                None => finding(
                    &mut findings,
                    "timeline.frame_overflow",
                    "Audio clip end frame overflows u64",
                    subject.clone(),
                ),
            }
            if clip
                .fade_in_frames
                .checked_add(clip.fade_out_frames)
                .map_or(true, |fades| fades > clip.duration_frames)
            {
                finding(
                    &mut findings,
                    "timeline.malformed_timing",
                    "Audio fades exceed the clip duration",
                    subject.clone(),
                );
            }
            if clip.asset_ref.id.trim().is_empty()
                || clip.asset_ref.revision == 0
                || !valid_sha256(&clip.verified_sha256.0)
            {
                finding(
                    &mut findings,
                    "asset.missing",
                    "Audio clip lacks an exact asset ref or verified SHA-256",
                    subject.clone(),
                );
            } else if context
                .available_assets
                .as_ref()
                .is_some_and(|assets| !assets.contains(&clip.asset_ref))
            {
                finding(
                    &mut findings,
                    "asset.missing",
                    "Referenced audio asset revision is unavailable",
                    subject.clone(),
                );
            }
        }
    }
    for track in &manifest.caption_tracks {
        let subject = Some(FindingRef {
            kind: "caption_track".into(),
            id: track.track_id.clone(),
            revision: None,
        });
        if track.track_id.trim().is_empty() || track.language.trim().is_empty() {
            finding(
                &mut findings,
                "timeline.malformed_timing",
                "Caption track ID and language must be non-empty",
                subject.clone(),
            );
        }
        if track.asset_ref.id.trim().is_empty()
            || track.asset_ref.revision == 0
            || !valid_sha256(&track.verified_sha256.0)
        {
            finding(
                &mut findings,
                "asset.missing",
                "Caption track lacks an exact asset ref or verified SHA-256",
                subject.clone(),
            );
        } else if context
            .available_assets
            .as_ref()
            .is_some_and(|assets| !assets.contains(&track.asset_ref))
        {
            finding(
                &mut findings,
                "asset.missing",
                "Referenced caption asset revision is unavailable",
                subject,
            );
        }
    }
    if seq.total_frames != max_end {
        finding(
            &mut findings,
            "timeline.malformed_timing",
            "Sequence total_frames must equal the maximum half-open video clip end",
            None,
        );
    }
    findings
}

/// Compile a supplied typed candidate: derive total length, validate, and stamp its
/// deterministic content hash. Blocked candidates are diagnostics, not export approval.
pub fn compile_edl_v1(mut manifest: EDLManifestV1, context: &ValidationContext) -> CompileOutcome {
    let mut max_end = 0_u64;
    let mut overflow = false;
    for clip in manifest.video_tracks.iter().flat_map(|track| &track.clips) {
        match clip.start_frame.checked_add(clip.duration_frames) {
            Some(end) => max_end = max_end.max(end),
            None => overflow = true,
        }
    }
    for clip in manifest.audio_tracks.iter().flat_map(|track| &track.clips) {
        match clip.start_frame.checked_add(clip.duration_frames) {
            Some(end) => max_end = max_end.max(end),
            None => overflow = true,
        }
    }
    manifest.sequence.total_frames = if overflow { 0 } else { max_end };
    let mut findings = validate_edl_v1(&manifest, context);
    if overflow && !findings.iter().any(|f| f.code == "timeline.frame_overflow") {
        finding(
            &mut findings,
            "timeline.frame_overflow",
            "Total frame calculation overflowed u64",
            None,
        );
    }
    manifest.timeline_hash = timeline_hash(&manifest);
    let ready = !overflow && findings.iter().all(|f| f.severity != Severity::Blocker);
    CompileOutcome {
        manifest,
        findings,
        ready,
    }
}

/// Build a v1 candidate from the existing flat, millisecond-based domain timeline.
/// Hashes, profile/parent refs, video geometry/rates, and claim policy must be supplied
/// by the caller; absent asset/hash metadata produces an `asset.missing` blocker.
pub fn compile_legacy_timeline(
    timeline: &VideoTimeline,
    context: &LegacyCompileContext,
) -> CompileOutcome {
    let mut findings = Vec::new();
    let mut clips = Vec::with_capacity(timeline.clips.len());
    let mut saw_overflow = false;
    for (index, old) in timeline.clips.iter().enumerate() {
        match legacy_clip(old, index, context, &mut findings) {
            Some(clip) => clips.push(clip),
            None => saw_overflow = true,
        }
    }
    let mut manifest = EDLManifestV1 {
        schema_version: EDL_SCHEMA_V1.into(),
        project_ref: context.project_ref.clone(),
        episode_ref: context.episode_ref.clone(),
        storyboard_ref: context.storyboard_ref.clone(),
        output_profile_ref: context.output_profile_ref.clone(),
        sequence: context.sequence.clone(),
        video_tracks: vec![VideoTrackV1 {
            track_id: "V1".into(),
            ordinal: 0,
            clips,
        }],
        audio_tracks: Vec::new(),
        caption_tracks: Vec::new(),
        lineage_refs: Vec::new(),
        timeline_hash: Hash(String::new()),
    };
    let mut frame_end = 0_u64;
    for clip in &manifest.video_tracks[0].clips {
        match clip.start_frame.checked_add(clip.duration_frames) {
            Some(end) => frame_end = frame_end.max(end),
            None => saw_overflow = true,
        }
    }
    manifest.sequence.total_frames = if saw_overflow { 0 } else { frame_end };
    let mut validation_context = context.validation.clone();
    validation_context
        .claiming_shot_refs
        .extend(context.claiming_shot_refs.iter().cloned());
    let mut validation = validate_edl_v1(&manifest, &validation_context);
    findings.append(&mut validation);
    // The legacy stored total is independently checked so stale/malformed DTO timing is visible.
    if timeline
        .clips
        .iter()
        .filter_map(legacy_end_ms)
        .max()
        .unwrap_or(0)
        != timeline.total_duration_ms
    {
        finding(
            &mut findings,
            "timeline.malformed_timing",
            "Legacy total_duration_ms does not match the maximum clip end",
            None,
        );
    }
    manifest.timeline_hash = timeline_hash(&manifest);
    let ready = !saw_overflow && findings.iter().all(|f| f.severity != Severity::Blocker);
    CompileOutcome {
        manifest,
        findings,
        ready,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyCompileContext {
    pub project_ref: Ref,
    pub episode_ref: Ref,
    pub storyboard_ref: Ref,
    pub output_profile_ref: Ref,
    pub sequence: SequenceV1,
    /// Verified SHA-256 values keyed by exact legacy asset ID/revision.
    pub verified_asset_hashes: Vec<(Ref, Hash)>,
    pub visual_spec_refs_by_shot: Vec<(Ref, Ref)>,
    pub claiming_shot_refs: BTreeSet<Ref>,
    pub validation: ValidationContext,
}

fn legacy_clip(
    old: &VideoTimelineClip,
    index: usize,
    context: &LegacyCompileContext,
    findings: &mut Vec<Finding>,
) -> Option<VideoClipV1> {
    let start = milliseconds_to_frames(old.start_ms, &context.sequence.frame_rate);
    let duration = milliseconds_to_frames(old.duration_ms, &context.sequence.frame_rate);
    let (start_frame, start_quantized) = match start {
        Some(value) => value,
        None => {
            finding(
                findings,
                "timeline.frame_overflow",
                "Legacy start time cannot be represented in frame space",
                Some(shot_subject(old)),
            );
            return None;
        }
    };
    let (duration_frames, duration_quantized) = match duration {
        Some(value) => value,
        None => {
            finding(
                findings,
                "timeline.frame_overflow",
                "Legacy duration cannot be represented in frame space",
                Some(shot_subject(old)),
            );
            return None;
        }
    };
    if old.duration_ms == 0
        || duration_frames == 0
        || old.start_ms.checked_add(old.duration_ms).is_none()
    {
        finding(
            findings,
            "timeline.malformed_timing",
            "Legacy clip timing is zero or overflows milliseconds",
            Some(shot_subject(old)),
        );
    }
    if start_quantized || duration_quantized {
        warning(
            findings,
            "timeline.frame_quantized",
            "Millisecond timing was rounded to the nearest sequence frame",
            Some(shot_subject(old)),
        );
    }
    let asset_ref = match (old.asset_id.as_ref(), old.asset_revision) {
        (Some(id), Some(revision)) => Ref {
            id: id.clone(),
            revision,
        },
        _ => Ref {
            id: String::new(),
            revision: 0,
        },
    };
    let asset_hash = context
        .verified_asset_hashes
        .iter()
        .find(|(r, _)| *r == asset_ref)
        .map(|(_, h)| h.clone())
        .unwrap_or_else(|| Hash(String::new()));
    let shot_ref = Ref {
        id: old.shot_id.clone(),
        revision: old.shot_revision,
    };
    let visual_spec_ref = context
        .visual_spec_refs_by_shot
        .iter()
        .find(|(shot, _)| *shot == shot_ref)
        .map(|(_, spec)| spec.clone());
    let evidence_refs = old
        .evidence
        .iter()
        .map(|e| FindingRef {
            kind: e.evidence_kind.clone(),
            id: e.evidence_id.clone(),
            revision: None,
        })
        .collect();
    Some(VideoClipV1 {
        clip_id: format!("legacy-{}", index),
        shot_ref,
        visual_spec_ref,
        asset_ref,
        verified_sha256: asset_hash,
        start_frame,
        duration_frames,
        source_in_frame: 0,
        fit: FitMode::Contain,
        transition_after: None,
        evidence_refs,
    })
}

fn legacy_end_ms(clip: &VideoTimelineClip) -> Option<u64> {
    clip.start_ms.checked_add(clip.duration_ms)
}

fn milliseconds_to_frames(ms: u64, rate: &Rational) -> Option<(u64, bool)> {
    if rate.num == 0 || rate.den == 0 {
        return None;
    }
    let numerator = u128::from(ms).checked_mul(u128::from(rate.num))?;
    let denominator = u128::from(rate.den).checked_mul(1_000)?;
    let rounded = numerator.checked_add(denominator / 2)? / denominator;
    Some((u64::try_from(rounded).ok()?, numerator % denominator != 0))
}

/// SHA-256 over canonical JSON of the manifest body. Struct field order is fixed by this
/// module; array order is semantically significant. No timestamps or local paths are fields.
pub fn timeline_hash(manifest: &EDLManifestV1) -> Hash {
    #[derive(Serialize)]
    struct Canonical<'a> {
        schema_version: &'a str,
        project_ref: &'a Ref,
        episode_ref: &'a Ref,
        storyboard_ref: &'a Ref,
        output_profile_ref: &'a Ref,
        sequence: &'a SequenceV1,
        video_tracks: &'a [VideoTrackV1],
        audio_tracks: &'a [AudioTrackV1],
        caption_tracks: &'a [CaptionTrackV1],
        lineage_refs: &'a [FindingRef],
    }
    let canonical = Canonical {
        schema_version: &manifest.schema_version,
        project_ref: &manifest.project_ref,
        episode_ref: &manifest.episode_ref,
        storyboard_ref: &manifest.storyboard_ref,
        output_profile_ref: &manifest.output_profile_ref,
        sequence: &manifest.sequence,
        video_tracks: &manifest.video_tracks,
        audio_tracks: &manifest.audio_tracks,
        caption_tracks: &manifest.caption_tracks,
        lineage_refs: &manifest.lineage_refs,
    };
    match serde_json::to_vec(&canonical) {
        Ok(bytes) => Hash::from_bytes(&bytes),
        // All fields are infallibly serializable, so this is defensive and stable.
        Err(_) => Hash("sha256:serialization-error".into()),
    }
}

fn valid_sha256(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn shot_subject(clip: &VideoTimelineClip) -> FindingRef {
    FindingRef {
        kind: "shot".into(),
        id: clip.shot_id.clone(),
        revision: Some(clip.shot_revision),
    }
}

fn finding(
    findings: &mut Vec<Finding>,
    code: &str,
    message: &str,
    subject_ref: Option<FindingRef>,
) {
    findings.push(Finding {
        code: code.into(),
        severity: Severity::Blocker,
        message: message.into(),
        subject_ref,
    });
}

fn warning(
    findings: &mut Vec<Finding>,
    code: &str,
    message: &str,
    subject_ref: Option<FindingRef>,
) {
    findings.push(Finding {
        code: code.into(),
        severity: Severity::Warning,
        message: message.into(),
        subject_ref,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ref_(id: &str, revision: u32) -> Ref {
        Ref {
            id: id.into(),
            revision,
        }
    }
    fn clip(id: &str, start: u64, duration: u64) -> VideoClipV1 {
        VideoClipV1 {
            clip_id: id.into(),
            shot_ref: ref_(&format!("shot-{id}"), 1),
            visual_spec_ref: None,
            asset_ref: ref_(&format!("asset-{id}"), 1),
            verified_sha256: Hash(format!("sha256:{}", "a".repeat(64))),
            start_frame: start,
            duration_frames: duration,
            source_in_frame: 0,
            fit: FitMode::Contain,
            transition_after: None,
            evidence_refs: vec![],
        }
    }
    fn manifest(clips: Vec<VideoClipV1>) -> EDLManifestV1 {
        EDLManifestV1 {
            schema_version: EDL_SCHEMA_V1.into(),
            project_ref: ref_("p", 1),
            episode_ref: ref_("e", 1),
            storyboard_ref: ref_("s", 1),
            output_profile_ref: ref_("profile", 1),
            sequence: SequenceV1 {
                width: 1280,
                height: 720,
                frame_rate: Rational { num: 30, den: 1 },
                pixel_aspect_ratio: Rational { num: 1, den: 1 },
                audio_sample_rate: 48_000,
                total_frames: 0,
            },
            video_tracks: vec![VideoTrackV1 {
                track_id: "V1".into(),
                ordinal: 0,
                clips,
            }],
            audio_tracks: vec![],
            caption_tracks: vec![],
            lineage_refs: vec![],
            timeline_hash: Hash(String::new()),
        }
    }
    fn contains(outcome: &CompileOutcome, code: &str) -> bool {
        outcome.findings.iter().any(|f| f.code == code)
    }

    #[test]
    fn deterministic_hash_independent_of_existing_hash_field() {
        let first = compile_edl_v1(
            manifest(vec![clip("1", 0, 30)]),
            &ValidationContext::default(),
        );
        let mut candidate = first.manifest.clone();
        candidate.timeline_hash = Hash("sha256:ignored".into());
        let second_hash = timeline_hash(&candidate);
        assert_eq!(first.manifest.timeline_hash, second_hash);
        let second = compile_edl_v1(
            manifest(vec![clip("1", 0, 30)]),
            &ValidationContext::default(),
        );
        assert_eq!(first.manifest.timeline_hash, second.manifest.timeline_hash);
        assert_eq!(first.manifest.timeline_hash.0.len(), 71);
    }

    #[test]
    fn invalid_duration_and_frame_overflow_are_blockers() {
        let zero = compile_edl_v1(
            manifest(vec![clip("zero", 0, 0)]),
            &ValidationContext::default(),
        );
        assert!(contains(&zero, "timeline.malformed_timing"));
        let overflow = compile_edl_v1(
            manifest(vec![clip("huge", u64::MAX, 1)]),
            &ValidationContext::default(),
        );
        assert!(contains(&overflow, "timeline.frame_overflow"));
        assert!(!overflow.ready);
    }

    #[test]
    fn detects_gap_and_overlap() {
        let gap = compile_edl_v1(
            manifest(vec![clip("a", 0, 10), clip("b", 12, 5)]),
            &ValidationContext::default(),
        );
        assert!(contains(&gap, "timeline.gap"));
        let overlap = compile_edl_v1(
            manifest(vec![clip("a", 0, 10), clip("b", 9, 5)]),
            &ValidationContext::default(),
        );
        assert!(contains(&overlap, "timeline.unexpected_overlap"));
    }

    #[test]
    fn detects_missing_asset_and_claiming_evidence() {
        let mut missing = clip("a", 0, 10);
        missing.asset_ref.id.clear();
        let candidate = manifest(vec![missing]);
        let mut context = ValidationContext::default();
        context.claiming_shot_refs.insert(ref_("shot-a", 1));
        let outcome = compile_edl_v1(candidate, &context);
        assert!(contains(&outcome, "asset.missing"));
        assert!(contains(&outcome, "evidence.missing_required_ref"));
        assert!(!outcome.ready);
    }

    #[test]
    fn rejects_unsupported_transitions() {
        let mut first = clip("a", 0, 10);
        first.transition_after = Some(TransitionV1 {
            kind: TransitionKind::Crossfade,
            duration_frames: 2,
        });
        let candidate = manifest(vec![first, clip("b", 8, 5)]);
        let outcome = compile_edl_v1(candidate, &ValidationContext::default());
        assert!(contains(&outcome, "timeline.unsupported_transition"));
    }
}

use chrono::Utc;
use nip_store::{Store, VideoEdlAssetFact, VideoEdlRef, VideoEdlRevision};
use std::collections::BTreeMap;

pub const PREVIEW_PROFILE_ID: &str = "mp4-h264-720p30-preview-v1";
pub const PREVIEW_PROFILE_REVISION: u32 = 1;
pub const EDL_BUILD_VERSION: &str = "fina-edl-compiler-v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoClipBuildRequest {
    pub shot_ref: Ref,
    pub asset_ref: Ref,
    #[serde(default)]
    pub start_frame: Option<u64>,
    pub duration_frames: u64,
    pub source_in_frame: u64,
    pub fit: FitMode,
    #[serde(default)]
    pub transition_after: Option<TransitionV1>,
    #[serde(default)]
    pub evidence_refs: Vec<FindingRef>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoTrackBuildRequest {
    pub track_id: String,
    pub ordinal: u32,
    pub clips: Vec<VideoClipBuildRequest>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioClipBuildRequest {
    pub clip_id: String,
    pub cue_ref: Ref,
    pub asset_ref: Ref,
    pub start_frame: u64,
    pub duration_frames: u64,
    pub source_in_sample: u64,
    pub source_sample_rate: u32,
    pub gain_millidb: i32,
    #[serde(default)]
    pub fade_in_frames: u64,
    #[serde(default)]
    pub fade_out_frames: u64,
    #[serde(default)]
    pub evidence_refs: Vec<FindingRef>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioTrackBuildRequest {
    pub track_id: String,
    pub ordinal: u32,
    pub kind: AudioKind,
    pub clips: Vec<AudioClipBuildRequest>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaptionTrackBuildRequest {
    pub track_id: String,
    pub language: String,
    pub format: CaptionFormat,
    pub delivery: CaptionDelivery,
    pub asset_ref: Ref,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoTimelineBuildRequest {
    pub project_ref: Ref,
    pub episode_ref: Ref,
    pub storyboard_ref: Ref,
    pub output_profile_id: String,
    pub video_tracks: Vec<VideoTrackBuildRequest>,
    #[serde(default)]
    pub audio_tracks: Vec<AudioTrackBuildRequest>,
    #[serde(default)]
    pub caption_tracks: Vec<CaptionTrackBuildRequest>,
    pub gap_policy: String,
    pub request_id: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoTimelineBuildFinding {
    pub code: String,
    pub severity: Severity,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject_ref: Option<FindingRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remediation: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoTimelineBuildSummary {
    pub video_clips: u32,
    pub audio_clips: u32,
    pub caption_tracks: u32,
    pub total_frames: u64,
    pub duration_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoTimelineBuildResult {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeline_ref: Option<Ref>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeline_hash: Option<Hash>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<VideoTimelineBuildSummary>,
    pub findings: Vec<VideoTimelineBuildFinding>,
    pub input_fingerprint: Hash,
}

/// Resolve trusted inventory/profile data, compile and validate, and persist only ready records.
pub fn build_video_timeline(
    store: &mut Store,
    request: &VideoTimelineBuildRequest,
) -> Result<VideoTimelineBuildResult, String> {
    if request.request_id.trim().is_empty() || request.request_id.len() > 128 {
        return Err("request_id must contain 1-128 non-whitespace characters".into());
    }
    if request.output_profile_id != PREVIEW_PROFILE_ID {
        return Err(format!(
            "output_profile_id must name installed profile {PREVIEW_PROFILE_ID}"
        ));
    }
    if request.gap_policy != "block" {
        return Err("gap_policy must be block; implicit gap filling is unsupported".into());
    }
    let mut normalized = request.clone();
    normalized.request_id.clear();
    let payload_bytes = serde_json::to_vec(&normalized).map_err(|e| e.to_string())?;
    let payload_hash = Hash::from_bytes(&payload_bytes).0;
    if let Some(prior) = store
        .video_edl_request_result(&request.request_id, &payload_hash)
        .map_err(|e| e.to_string())?
    {
        return serde_json::from_str(&prior).map_err(|e| e.to_string());
    }
    let project = VideoEdlRef {
        id: request.project_ref.id.clone(),
        revision: request.project_ref.revision,
    };
    let episode = VideoEdlRef {
        id: request.episode_ref.id.clone(),
        revision: request.episode_ref.revision,
    };
    let storyboard = VideoEdlRef {
        id: request.storyboard_ref.id.clone(),
        revision: request.storyboard_ref.revision,
    };
    let shots: Vec<VideoEdlRef> = request
        .video_tracks
        .iter()
        .flat_map(|t| &t.clips)
        .map(|c| VideoEdlRef {
            id: c.shot_ref.id.clone(),
            revision: c.shot_ref.revision,
        })
        .collect();
    let mut assets: Vec<VideoEdlRef> = request
        .video_tracks
        .iter()
        .flat_map(|t| &t.clips)
        .map(|c| &c.asset_ref)
        .chain(
            request
                .audio_tracks
                .iter()
                .flat_map(|t| &t.clips)
                .map(|c| &c.asset_ref),
        )
        .chain(request.caption_tracks.iter().map(|c| &c.asset_ref))
        .map(|r| VideoEdlRef {
            id: r.id.clone(),
            revision: r.revision,
        })
        .collect();
    assets.sort_by(|a, b| a.id.cmp(&b.id).then(a.revision.cmp(&b.revision)));
    assets.dedup();
    let selected_cues: Vec<VideoEdlRef> = request
        .audio_tracks
        .iter()
        .flat_map(|t| &t.clips)
        .map(|c| VideoEdlRef {
            id: c.cue_ref.id.clone(),
            revision: c.cue_ref.revision,
        })
        .collect();
    let supplied_evidence: Vec<(String, String)> = request
        .video_tracks
        .iter()
        .flat_map(|t| &t.clips)
        .flat_map(|c| &c.evidence_refs)
        .chain(
            request
                .audio_tracks
                .iter()
                .flat_map(|t| &t.clips)
                .flat_map(|c| &c.evidence_refs),
        )
        .map(|e| (e.kind.clone(), e.id.clone()))
        .collect();
    let inventory = store
        .video_edl_inventory(
            &project,
            &episode,
            &storyboard,
            &shots,
            &assets,
            &selected_cues,
            &supplied_evidence,
        )
        .map_err(|e| e.to_string())?;
    let facts: BTreeMap<(String, u32), VideoEdlAssetFact> = inventory
        .assets
        .iter()
        .cloned()
        .map(|f| ((f.asset.id.clone(), f.asset.revision), f))
        .collect();
    let mut findings = Vec::new();
    let valid_asset =
        |r: &Ref, expected: &str, for_shot: Option<&Ref>| -> Option<(Hash, Option<Ref>)> {
            let fact = facts.get(&(r.id.clone(), r.revision))?;
            let raw = fact.content_hash.as_deref()?;
            let hash = normalize_hash(raw)?;
            let path = fact.relative_path.as_deref()?;
            if !safe_relative_media_path(path)
                || fact.capability_state != "ready"
                || !matches!(
                    fact.license_state.as_str(),
                    "approved" | "internal_review_only"
                )
            {
                return None;
            }
            if let Some(mime) = fact.mime_type.as_deref() {
                if !mime.starts_with(expected) {
                    return None;
                }
            } else {
                return None;
            }
            if expected == "video/"
                && (fact.width.unwrap_or(0) == 0
                    || fact.height.unwrap_or(0) == 0
                    || fact.duration_ms.unwrap_or(0) == 0)
            {
                return None;
            }
            if let Some(shot) = for_shot {
                if !fact
                    .related_shots
                    .iter()
                    .any(|s| s.id == shot.id && s.revision == shot.revision)
                {
                    return None;
                }
            }
            let spec = fact.visual_spec.as_ref().map(|s| Ref {
                id: s.id.clone(),
                revision: s.revision,
            });
            Some((hash, spec))
        };
    let mut usable_assets = BTreeSet::new();
    let mut video_tracks = Vec::new();
    for track in &request.video_tracks {
        let mut clips = Vec::new();
        let mut cursor = 0u64;
        for (i, c) in track.clips.iter().enumerate() {
            let start = c.start_frame.unwrap_or(cursor);
            let subject = Some(FindingRef {
                kind: "shot".into(),
                id: c.shot_ref.id.clone(),
                revision: Some(c.shot_ref.revision),
            });
            if !inventory
                .selected_shots
                .iter()
                .any(|f| f.shot.id == c.shot_ref.id && f.shot.revision == c.shot_ref.revision)
            {
                findings.push(blocker(
                    "storyboard.shot_unmapped",
                    "Selected exact shot revision does not belong to the requested storyboard",
                    subject.clone(),
                ));
            }
            let verified = valid_asset(&c.asset_ref, "video/", Some(&c.shot_ref));
            let (hash, spec) = verified.clone().unwrap_or((Hash(String::new()), None));
            if verified.is_some() {
                usable_assets.insert(c.asset_ref.clone());
            } else {
                findings.push(blocker("asset.missing", "Selected video asset is missing, unsafe, unhashable, not ready, unlicensed, or unrelated to this exact shot", subject.clone()));
            }
            if facts
                .get(&(c.asset_ref.id.clone(), c.asset_ref.revision))
                .is_some_and(|f| f.license_state == "internal_review_only")
            {
                findings.push(timeline_warning(
                    "rights.internal_review_only",
                    "Asset is licensed for internal review only; this preview EDL is not rights clearance or publication approval",
                    Some(FindingRef {
                        kind: "asset".into(),
                        id: c.asset_ref.id.clone(),
                        revision: Some(c.asset_ref.revision),
                    }),
                ));
            }
            if let Some(fact) = facts.get(&(c.asset_ref.id.clone(), c.asset_ref.revision)) {
                let available_frames = fact.duration_ms.map(|ms| u128::from(ms) * 30 / 1000);
                let trim_end =
                    u128::from(c.source_in_frame).checked_add(u128::from(c.duration_frames));
                if available_frames.is_some_and(|limit| trim_end.is_none_or(|end| end > limit)) {
                    findings.push(blocker(
                        "timeline.source_out_of_bounds",
                        "Video source trim extends beyond the stored source duration",
                        subject.clone(),
                    ));
                }
            }
            clips.push(VideoClipV1 {
                clip_id: format!("{}-{i:04}", track.track_id),
                shot_ref: c.shot_ref.clone(),
                visual_spec_ref: spec,
                asset_ref: c.asset_ref.clone(),
                verified_sha256: hash,
                start_frame: start,
                duration_frames: c.duration_frames,
                source_in_frame: c.source_in_frame,
                fit: c.fit,
                transition_after: c.transition_after.clone(),
                evidence_refs: c.evidence_refs.clone(),
            });
            cursor = start
                .checked_add(c.duration_frames)
                .unwrap_or(u64::MAX)
                .saturating_sub(c.transition_after.as_ref().map_or(0, |t| t.duration_frames));
        }
        video_tracks.push(VideoTrackV1 {
            track_id: track.track_id.clone(),
            ordinal: track.ordinal,
            clips,
        });
    }
    let selected_shot_set: BTreeSet<Ref> = shots
        .iter()
        .map(|s| Ref {
            id: s.id.clone(),
            revision: s.revision,
        })
        .collect();
    for fact in &inventory.storyboard_shots {
        if !selected_shot_set.contains(&Ref {
            id: fact.shot.id.clone(),
            revision: fact.shot.revision,
        }) {
            findings.push(blocker(
                "storyboard.shot_unmapped",
                "Storyboard shot has no selected rendered clip",
                Some(FindingRef {
                    kind: "shot".into(),
                    id: fact.shot.id.clone(),
                    revision: Some(fact.shot.revision),
                }),
            ));
        }
    }
    let claiming: BTreeSet<Ref> = inventory
        .storyboard_shots
        .iter()
        .filter(|s| s.claiming)
        .map(|s| Ref {
            id: s.shot.id.clone(),
            revision: s.shot.revision,
        })
        .collect();
    let available_assets: BTreeSet<Ref> = usable_assets;
    let available_evidence: BTreeSet<FindingRef> = inventory
        .evidence
        .iter()
        .map(|(kind, id)| FindingRef {
            kind: kind.clone(),
            id: id.clone(),
            revision: None,
        })
        .collect();
    let mut context = ValidationContext {
        claiming_shot_refs: claiming,
        available_assets: Some(available_assets),
        available_evidence: Some(available_evidence),
        supported_transitions: [TransitionKind::Cut].into_iter().collect(),
    };
    // Caller can provide evidence refs, but only exact canonical refs resolved above enter context.
    context
        .claiming_shot_refs
        .extend(
            inventory
                .selected_shots
                .iter()
                .filter(|s| s.claiming)
                .map(|s| Ref {
                    id: s.shot.id.clone(),
                    revision: s.shot.revision,
                }),
        );
    let mut audio_tracks = Vec::new();
    for track in &request.audio_tracks {
        let mut clips = Vec::new();
        for c in &track.clips {
            let valid = valid_asset(&c.asset_ref, "audio/", None);
            let (hash, _) = valid.clone().unwrap_or((Hash(String::new()), None));
            if facts
                .get(&(c.asset_ref.id.clone(), c.asset_ref.revision))
                .is_some_and(|f| f.license_state == "internal_review_only")
            {
                findings.push(timeline_warning(
                    "rights.internal_review_only",
                    "Audio asset is licensed for internal review only; this preview EDL is not rights clearance or publication approval",
                    Some(FindingRef {
                        kind: "asset".into(),
                        id: c.asset_ref.id.clone(),
                        revision: Some(c.asset_ref.revision),
                    }),
                ));
            }
            let cue_fact = inventory
                .cues
                .iter()
                .find(|f| f.cue.id == c.cue_ref.id && f.cue.revision == c.cue_ref.revision);
            let exact_cue = cue_fact.is_some_and(|f| {
                f.project.id == request.project_ref.id
                    && f.project.revision == request.project_ref.revision
                    && f.episode.id == request.episode_ref.id
                    && f.episode.revision == request.episode_ref.revision
                    && f.storyboard.id == request.storyboard_ref.id
                    && f.storyboard.revision == request.storyboard_ref.revision
                    && f.asset.id == c.asset_ref.id
                    && f.asset.revision == c.asset_ref.revision
                    && f.duration_ms > 0
                    && f.sample_rate == c.source_sample_rate
                    && f.sample_count > 0
            });
            if !exact_cue {
                findings.push(blocker("audio.cue_mismatch", "Audio cue is missing or its exact project/episode/storyboard/asset/timing refs do not match this build", Some(FindingRef{kind:"cue".into(),id:c.cue_ref.id.clone(),revision:Some(c.cue_ref.revision)})));
            } else if let Some(fact) = cue_fact {
                let end_sample = u128::from(c.duration_frames)
                    .checked_mul(u128::from(c.source_sample_rate))
                    .and_then(|v| v.checked_div(30))
                    .and_then(|v| u64::try_from(v).ok())
                    .and_then(|span| c.source_in_sample.checked_add(span));
                if end_sample.is_none_or(|end| end > fact.sample_count) {
                    findings.push(blocker(
                        "audio.source_out_of_bounds",
                        "Audio source sample trim exceeds the registered cue sample count",
                        Some(FindingRef {
                            kind: "cue".into(),
                            id: c.cue_ref.id.clone(),
                            revision: Some(c.cue_ref.revision),
                        }),
                    ));
                }
            }
            let mut audio_evidence = c.evidence_refs.clone();
            if let Some(fact) = cue_fact.filter(|_| exact_cue) {
                audio_evidence.extend(fact.evidence.iter().map(|e| FindingRef {
                    kind: e.evidence_kind.clone(),
                    id: e.evidence_id.clone(),
                    revision: None,
                }));
            }
            audio_evidence.sort();
            audio_evidence.dedup();
            if valid.is_some() {
                context
                    .available_assets
                    .as_mut()
                    .unwrap()
                    .insert(c.asset_ref.clone());
            } else {
                findings.push(blocker(
                    "asset.missing",
                    "Selected audio asset is missing, unsafe, unhashable, or not ready",
                    Some(FindingRef {
                        kind: "cue".into(),
                        id: c.cue_ref.id.clone(),
                        revision: Some(c.cue_ref.revision),
                    }),
                ));
            }
            clips.push(AudioClipV1 {
                clip_id: c.clip_id.clone(),
                cue_ref: c.cue_ref.clone(),
                asset_ref: c.asset_ref.clone(),
                verified_sha256: hash,
                start_frame: c.start_frame,
                duration_frames: c.duration_frames,
                source_in_sample: c.source_in_sample,
                source_sample_rate: c.source_sample_rate,
                gain_millidb: c.gain_millidb,
                fade_in_frames: c.fade_in_frames,
                fade_out_frames: c.fade_out_frames,
                evidence_refs: audio_evidence,
            });
        }
        audio_tracks.push(AudioTrackV1 {
            track_id: track.track_id.clone(),
            ordinal: track.ordinal,
            kind: track.kind,
            clips,
        });
    }
    let mut caption_tracks = Vec::new();
    for c in &request.caption_tracks {
        let valid = valid_asset(&c.asset_ref, "text/", None);
        let (hash, _) = valid.clone().unwrap_or((Hash(String::new()), None));
        if valid.is_some() {
            context
                .available_assets
                .as_mut()
                .unwrap()
                .insert(c.asset_ref.clone());
        } else {
            findings.push(blocker(
                "asset.missing",
                "Selected caption asset is missing, unsafe, unhashable, or not ready",
                Some(FindingRef {
                    kind: "caption_track".into(),
                    id: c.track_id.clone(),
                    revision: None,
                }),
            ));
        }
        findings.push(blocker("caption.asset_unverified","Caption asset format and cue timing cannot be independently verified by the current inventory",Some(FindingRef{kind:"caption_track".into(),id:c.track_id.clone(),revision:None})));
        caption_tracks.push(CaptionTrackV1 {
            track_id: c.track_id.clone(),
            language: c.language.clone(),
            format: c.format,
            delivery: c.delivery,
            asset_ref: c.asset_ref.clone(),
            verified_sha256: hash,
        });
    }
    let manifest = EDLManifestV1 {
        schema_version: EDL_SCHEMA_V1.into(),
        project_ref: request.project_ref.clone(),
        episode_ref: request.episode_ref.clone(),
        storyboard_ref: request.storyboard_ref.clone(),
        output_profile_ref: Ref {
            id: PREVIEW_PROFILE_ID.into(),
            revision: PREVIEW_PROFILE_REVISION,
        },
        sequence: SequenceV1 {
            width: 1280,
            height: 720,
            frame_rate: Rational { num: 30, den: 1 },
            pixel_aspect_ratio: Rational { num: 1, den: 1 },
            audio_sample_rate: 48000,
            total_frames: 0,
        },
        video_tracks,
        audio_tracks,
        caption_tracks,
        lineage_refs: vec![],
        timeline_hash: Hash(String::new()),
    };
    let outcome = compile_edl_v1(manifest, &context);
    findings.extend(
        outcome
            .findings
            .into_iter()
            .map(|f| VideoTimelineBuildFinding {
                code: f.code,
                severity: f.severity,
                message: f.message,
                subject_ref: f.subject_ref,
                remediation: None,
            }),
    );
    findings.sort_by(|a, b| {
        a.code.cmp(&b.code).then(
            a.subject_ref
                .as_ref()
                .map(|r| (&r.kind, &r.id, r.revision))
                .cmp(&b.subject_ref.as_ref().map(|r| (&r.kind, &r.id, r.revision))),
        )
    });
    findings.dedup_by(|a, b| a.code == b.code && a.subject_ref == b.subject_ref);
    let fingerprint_body = serde_json::json!({"build_version":EDL_BUILD_VERSION,"timeline_hash":outcome.manifest.timeline_hash,"manifest":outcome.manifest});
    let fpbytes = serde_json::to_vec(&fingerprint_body).map_err(|e| e.to_string())?;
    let fingerprint = Hash::from_bytes(&fpbytes);
    let ready = outcome.ready && findings.iter().all(|f| f.severity != Severity::Blocker);
    let duration_ms = if ready {
        u128::from(outcome.manifest.sequence.total_frames)
            .checked_mul(1000)
            .and_then(|v| v.checked_mul(u128::from(outcome.manifest.sequence.frame_rate.den)))
            .and_then(|v| v.checked_div(u128::from(outcome.manifest.sequence.frame_rate.num)))
            .and_then(|v| u64::try_from(v).ok())
    } else {
        None
    };
    if ready && duration_ms.is_none() {
        findings.push(blocker(
            "timeline.frame_overflow",
            "Timeline duration overflows supported millisecond summary",
            None,
        ));
    }
    let result = VideoTimelineBuildResult {
        status: if ready && duration_ms.is_some() {
            "ready"
        } else {
            "blocked"
        }
        .into(),
        timeline_ref: if ready && duration_ms.is_some() {
            Some(Ref {
                id: format!("timeline-{}", &fingerprint.0[7..39]),
                revision: 1,
            })
        } else {
            None
        },
        timeline_hash: Some(outcome.manifest.timeline_hash.clone()),
        summary: if ready {
            duration_ms.map(|duration_ms| VideoTimelineBuildSummary {
                video_clips: outcome
                    .manifest
                    .video_tracks
                    .iter()
                    .map(|t| t.clips.len() as u32)
                    .sum(),
                audio_clips: outcome
                    .manifest
                    .audio_tracks
                    .iter()
                    .map(|t| t.clips.len() as u32)
                    .sum(),
                caption_tracks: outcome.manifest.caption_tracks.len() as u32,
                total_frames: outcome.manifest.sequence.total_frames,
                duration_ms,
            })
        } else {
            None
        },
        findings: findings.clone(),
        input_fingerprint: fingerprint.clone(),
    };
    let result_json = serde_json::to_string(&result).map_err(|e| e.to_string())?;
    let now = Utc::now();
    if ready && duration_ms.is_some() {
        let rec = VideoEdlRevision {
            timeline_id: result.timeline_ref.as_ref().unwrap().id.clone(),
            revision: 1,
            project_id: request.project_ref.id.clone(),
            project_revision: request.project_ref.revision,
            episode_id: request.episode_ref.id.clone(),
            episode_revision: request.episode_ref.revision,
            storyboard_id: request.storyboard_ref.id.clone(),
            storyboard_revision: request.storyboard_ref.revision,
            profile_id: PREVIEW_PROFILE_ID.into(),
            profile_revision: PREVIEW_PROFILE_REVISION,
            schema_version: EDL_SCHEMA_V1.into(),
            build_version: EDL_BUILD_VERSION.into(),
            build_status: "ready".into(),
            timeline_hash: outcome.manifest.timeline_hash.0.clone(),
            input_fingerprint: fingerprint.0.clone(),
            manifest_json: serde_json::to_string(&outcome.manifest).map_err(|e| e.to_string())?,
            findings_json: serde_json::to_string(&findings).map_err(|e| e.to_string())?,
            created_at: now,
        };
        if let Some(replay) = store
            .save_video_edl_build(&rec, &request.request_id, &payload_hash, &result_json)
            .map_err(|e| e.to_string())?
        {
            return serde_json::from_str(&replay).map_err(|e| e.to_string());
        }
    } else if let Some(replay) = store
        .save_video_edl_blocked_request(&request.request_id, &payload_hash, &result_json, now)
        .map_err(|e| e.to_string())?
    {
        return serde_json::from_str(&replay).map_err(|e| e.to_string());
    }
    Ok(result)
}
fn blocker(
    code: &str,
    message: &str,
    subject_ref: Option<FindingRef>,
) -> VideoTimelineBuildFinding {
    VideoTimelineBuildFinding {
        code: code.into(),
        severity: Severity::Blocker,
        message: message.into(),
        subject_ref,
        remediation: Some(
            "Resolve the exact source record and rebuild with a new request_id".into(),
        ),
    }
}
fn timeline_warning(
    code: &str,
    message: &str,
    subject_ref: Option<FindingRef>,
) -> VideoTimelineBuildFinding {
    VideoTimelineBuildFinding {
        code: code.into(),
        severity: Severity::Warning,
        message: message.into(),
        subject_ref,
        remediation: Some(
            "Keep the output on the private preview profile until rights are cleared".into(),
        ),
    }
}
fn normalize_hash(value: &str) -> Option<Hash> {
    let raw = value.strip_prefix("sha256:").unwrap_or(value);
    if raw.len() != 64 || !raw.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some(Hash(format!("sha256:{}", raw.to_ascii_lowercase())))
}
fn safe_relative_media_path(value: &str) -> bool {
    if value.trim().is_empty()
        || value.contains('\\')
        || value.starts_with('/')
        || value.contains(':')
    {
        return false;
    }
    let p = std::path::Path::new(value);
    !p.is_absolute()
        && p.components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use chrono::Utc;
    use nip_domain::{
        VideoAnalysisMode, VideoAsset, VideoAssetLineage, VideoAssetUpstreamKind, VideoAudioCue,
        VideoEpisode, VideoEpisodeStatus, VideoNarrative, VideoProject, VideoProjectStatus,
        VideoReviewStatus, VideoScene, VideoShot, VideoShotStatus, VideoStoryboard,
    };
    use nip_store::Store;
    use tempfile::TempDir;

    fn fixture() -> (TempDir, Store, VideoTimelineBuildRequest) {
        let temp = TempDir::new().unwrap();
        let mut store = Store::open(temp.path().join("edl.duckdb")).unwrap();
        let now = Utc::now();
        store
            .save_video_project(&VideoProject {
                project_id: "p1".into(),
                revision: 1,
                title: "test".into(),
                language: "en".into(),
                target_platform: "preview".into(),
                target_duration_ms: None,
                audience: None,
                style_profile: None,
                status: VideoProjectStatus::Draft,
                created_at: now,
                updated_at: now,
            })
            .unwrap();
        store
            .save_video_episode(&VideoEpisode {
                episode_id: "e1".into(),
                project_id: "p1".into(),
                revision: 1,
                title: None,
                as_of: None,
                disclosure: None,
                status: VideoEpisodeStatus::Draft,
                created_at: now,
                updated_at: now,
            })
            .unwrap();
        store
            .save_video_narrative(&VideoNarrative {
                narrative_id: "n1".into(),
                episode_id: "e1".into(),
                revision: 1,
                summary: None,
                thesis: None,
                analysis_mode: VideoAnalysisMode::DeterministicCandidate,
                review_status: VideoReviewStatus::Candidate,
                derivation_run_id: None,
                created_at: now,
                updated_at: now,
            })
            .unwrap();
        store
            .save_video_storyboard(&VideoStoryboard {
                storyboard_id: "sb1".into(),
                narrative_id: "n1".into(),
                revision: 1,
                schema_version: "v1".into(),
                review_status: VideoReviewStatus::Draft,
                created_at: now,
                updated_at: now,
            })
            .unwrap();
        store
            .save_video_scene(&VideoScene {
                scene_id: "sc1".into(),
                storyboard_id: "sb1".into(),
                revision: 1,
                ordinal: 0,
                purpose: "test".into(),
                narration_text: None,
                visual_intent: None,
                duration_ms: Some(1000),
                created_at: now,
                updated_at: now,
            })
            .unwrap();
        store
            .save_video_shot(&VideoShot {
                shot_id: "sh1".into(),
                scene_id: "sc1".into(),
                revision: 1,
                ordinal: 0,
                shot_type: "video".into(),
                duration_ms: 1000,
                camera_motion: None,
                visual_prompt: None,
                status: VideoShotStatus::Complete,
                created_at: now,
                updated_at: now,
            })
            .unwrap();
        let asset = VideoAsset {
            asset_id: "a1".into(),
            revision: 1,
            asset_kind: "video".into(),
            relative_path: Some("managed/a1.mp4".into()),
            mime_type: Some("video/mp4".into()),
            content_hash: Some(format!("sha256:{}", "a".repeat(64))),
            width: Some(1280),
            height: Some(720),
            duration_ms: Some(1000),
            provider: "fixture".into(),
            workflow_id: None,
            model: None,
            reproducibility: "fixture".into(),
            capability_state: "ready".into(),
            license_state: "approved".into(),
            job_id: None,
            created_at: now,
        };
        store.save_video_asset(&asset).unwrap();
        store
            .save_video_asset_lineage(&VideoAssetLineage {
                asset_id: "a1".into(),
                asset_revision: 1,
                upstream_kind: VideoAssetUpstreamKind::Shot,
                upstream_id: "sh1".into(),
                upstream_revision: Some(1),
                relationship: "rendered_from".into(),
                input_hash: None,
                created_at: now,
            })
            .unwrap();
        let request = VideoTimelineBuildRequest {
            project_ref: Ref {
                id: "p1".into(),
                revision: 1,
            },
            episode_ref: Ref {
                id: "e1".into(),
                revision: 1,
            },
            storyboard_ref: Ref {
                id: "sb1".into(),
                revision: 1,
            },
            output_profile_id: PREVIEW_PROFILE_ID.into(),
            video_tracks: vec![VideoTrackBuildRequest {
                track_id: "V1".into(),
                ordinal: 0,
                clips: vec![VideoClipBuildRequest {
                    shot_ref: Ref {
                        id: "sh1".into(),
                        revision: 1,
                    },
                    asset_ref: Ref {
                        id: "a1".into(),
                        revision: 1,
                    },
                    start_frame: Some(0),
                    duration_frames: 30,
                    source_in_frame: 0,
                    fit: FitMode::Contain,
                    transition_after: None,
                    evidence_refs: vec![],
                }],
            }],
            audio_tracks: vec![],
            caption_tracks: vec![],
            gap_policy: "block".into(),
            request_id: "req-1".into(),
        };
        (temp, store, request)
    }
    fn has(result: &VideoTimelineBuildResult, code: &str) -> bool {
        result.findings.iter().any(|f| f.code == code)
    }

    fn add_narration(store: &mut Store, license_state: &str) -> VideoAudioCue {
        let now = Utc::now();
        let asset = VideoAsset {
            asset_id: "narration".into(),
            revision: 1,
            asset_kind: "audio".into(),
            relative_path: Some("audio/narration.wav".into()),
            mime_type: Some("audio/wav".into()),
            content_hash: Some(format!("sha256:{}", "b".repeat(64))),
            width: None,
            height: None,
            duration_ms: Some(52_600),
            provider: "local_tts".into(),
            workflow_id: Some("voiceover-run-1".into()),
            model: Some("approved-voice-model".into()),
            reproducibility: "nondeterministic".into(),
            capability_state: "ready".into(),
            license_state: license_state.into(),
            job_id: None,
            created_at: now,
        };
        store.save_video_asset(&asset).unwrap();
        let script = "The retained narration script for this synthetic review pilot.";
        let cue = VideoAudioCue {
            cue_id: "cue-storyboard-narration".into(),
            revision: 1,
            project_id: "p1".into(),
            project_revision: 1,
            episode_id: "e1".into(),
            episode_revision: 1,
            storyboard_id: "sb1".into(),
            storyboard_revision: 1,
            scene_id: None,
            scene_revision: None,
            asset_id: "narration".into(),
            asset_revision: 1,
            source_text: script.into(),
            source_text_hash: Hash::from_bytes(script.as_bytes()).0,
            voice_id: "voice-neutral-en".into(),
            provider: "local_tts".into(),
            production_metadata: serde_json::json!({"workflow_id":"voiceover-run-1","model":"approved-voice-model"}),
            duration_ms: 52_600,
            sample_count: 2_524_800,
            sample_rate: 48_000,
            channels: 1,
            evidence: vec![],
            created_at: now,
        };
        store.save_video_audio_cue(&cue).unwrap();
        cue
    }
    fn add_audio_request(request: &mut VideoTimelineBuildRequest, cue: &VideoAudioCue) {
        request.audio_tracks = vec![AudioTrackBuildRequest {
            track_id: "A1".into(),
            ordinal: 0,
            kind: AudioKind::Narration,
            clips: vec![AudioClipBuildRequest {
                clip_id: "narration-1".into(),
                cue_ref: Ref {
                    id: cue.cue_id.clone(),
                    revision: cue.revision,
                },
                asset_ref: Ref {
                    id: cue.asset_id.clone(),
                    revision: cue.asset_revision,
                },
                start_frame: 0,
                duration_frames: 1_578,
                source_in_sample: 0,
                source_sample_rate: 48_000,
                gain_millidb: 0,
                fade_in_frames: 0,
                fade_out_frames: 0,
                evidence_refs: vec![],
            }],
        }];
    }

    #[test]
    fn storyboard_narration_cue_round_trips_idempotently_and_builds_audio_clip() {
        let (_temp, mut store, mut request) = fixture();
        let cue = add_narration(&mut store, "approved");
        store.save_video_audio_cue(&cue).unwrap();
        assert_eq!(
            store.video_audio_cue(&cue.cue_id, 1).unwrap(),
            Some(cue.clone())
        );
        assert_eq!(
            store.video_audio_cues("sb1", 1, 20).unwrap(),
            vec![cue.clone()]
        );
        add_audio_request(&mut request, &cue);
        let result = build_video_timeline(&mut store, &request).unwrap();
        assert_eq!(result.status, "ready");
        let stored = store
            .video_edl_timeline(&result.timeline_ref.as_ref().unwrap().id, 1)
            .unwrap()
            .unwrap();
        let manifest: EDLManifestV1 = serde_json::from_str(&stored.manifest_json).unwrap();
        let clip = &manifest.audio_tracks[0].clips[0];
        assert_eq!(clip.cue_ref.id, cue.cue_id);
        assert_eq!(clip.asset_ref.id, cue.asset_id);
        assert_eq!(clip.duration_frames, 1_578);
        assert!(!has(&result, "audio.cue_unverified"));
    }

    #[test]
    fn missing_or_wrong_asset_cue_is_a_blocker() {
        let (_temp, mut store, mut request) = fixture();
        let cue = add_narration(&mut store, "approved");
        add_audio_request(&mut request, &cue);
        request.audio_tracks[0].clips[0].cue_ref.revision = 2;
        let result = build_video_timeline(&mut store, &request).unwrap();
        assert_eq!(result.status, "blocked");
        assert!(has(&result, "audio.cue_mismatch"));
        let (_temp, mut store, mut request) = fixture();
        let cue = add_narration(&mut store, "approved");
        let other = VideoAsset {
            asset_id: "wrong-audio".into(),
            revision: 1,
            ..store
                .video_assets(20)
                .unwrap()
                .into_iter()
                .find(|a| a.asset_id == "narration")
                .unwrap()
        };
        store.save_video_asset(&other).unwrap();
        add_audio_request(&mut request, &cue);
        request.audio_tracks[0].clips[0].asset_ref.id = "wrong-audio".into();
        let result = build_video_timeline(&mut store, &request).unwrap();
        assert_eq!(result.status, "blocked");
        assert!(has(&result, "audio.cue_mismatch"));
    }

    #[test]
    fn preview_allows_internal_review_only_with_warning_but_blocks_fixture_and_unknown() {
        let (_temp, mut store, mut request) = fixture();
        let base = store
            .video_assets(20)
            .unwrap()
            .into_iter()
            .find(|a| a.asset_id == "a1")
            .unwrap();
        let review = VideoAsset {
            revision: 2,
            license_state: "internal_review_only".into(),
            ..base.clone()
        };
        store.save_video_asset(&review).unwrap();
        store
            .save_video_asset_lineage(&VideoAssetLineage {
                asset_id: "a1".into(),
                asset_revision: 2,
                upstream_kind: VideoAssetUpstreamKind::Shot,
                upstream_id: "sh1".into(),
                upstream_revision: Some(1),
                relationship: "rendered_from".into(),
                input_hash: None,
                created_at: Utc::now(),
            })
            .unwrap();
        request.video_tracks[0].clips[0].asset_ref.revision = 2;
        let result = build_video_timeline(&mut store, &request).unwrap();
        assert_eq!(result.status, "ready");
        assert!(result
            .findings
            .iter()
            .any(|f| f.code == "rights.internal_review_only" && f.severity == Severity::Warning));
        for (revision, state) in [(3, "fixture_only"), (4, "unknown")] {
            let asset = VideoAsset {
                revision,
                license_state: state.into(),
                ..base.clone()
            };
            store.save_video_asset(&asset).unwrap();
            store
                .save_video_asset_lineage(&VideoAssetLineage {
                    asset_id: "a1".into(),
                    asset_revision: revision,
                    upstream_kind: VideoAssetUpstreamKind::Shot,
                    upstream_id: "sh1".into(),
                    upstream_revision: Some(1),
                    relationship: "rendered_from".into(),
                    input_hash: None,
                    created_at: Utc::now(),
                })
                .unwrap();
            request.video_tracks[0].clips[0].asset_ref.revision = revision;
            request.request_id = format!("rights-{revision}");
            let blocked = build_video_timeline(&mut store, &request).unwrap();
            assert_eq!(blocked.status, "blocked");
            assert!(has(&blocked, "asset.missing"));
        }
    }

    #[test]
    fn build_persists_ready_edl_and_hash_is_stable_and_immutable() {
        let (_temp, mut store, request) = fixture();
        let one = build_video_timeline(&mut store, &request).unwrap();
        assert_eq!(one.status, "ready");
        let reference = one.timeline_ref.clone().unwrap();
        let saved = store
            .video_edl_timeline(&reference.id, reference.revision)
            .unwrap()
            .unwrap();
        let manifest: EDLManifestV1 = serde_json::from_str(&saved.manifest_json).unwrap();
        assert_eq!(manifest.output_profile_ref.id, PREVIEW_PROFILE_ID);
        assert_eq!(manifest.sequence.width, 1280);
        assert_eq!(manifest.timeline_hash, one.timeline_hash.clone().unwrap());
        let same = build_video_timeline(&mut store, &request).unwrap();
        assert_eq!(same, one);
        let mut other_key = request.clone();
        other_key.request_id = "req-2".into();
        let stable = build_video_timeline(&mut store, &other_key).unwrap();
        assert_eq!(stable.input_fingerprint, one.input_fingerprint);
        assert_eq!(stable.timeline_ref, one.timeline_ref);
        assert_eq!(store.video_edl_timelines("p1", 1, 10).unwrap().len(), 1);
        let loaded = store.video_edl_timeline(&reference.id, 1).unwrap().unwrap();
        assert_eq!(loaded.manifest_json, saved.manifest_json);
    }
    #[test]
    fn missing_asset_and_evidence_are_blockers() {
        let (_temp, mut store, mut request) = fixture();
        request.video_tracks[0].clips[0].asset_ref = Ref {
            id: "not-there".into(),
            revision: 1,
        };
        let result = build_video_timeline(&mut store, &request).unwrap();
        assert_eq!(result.status, "blocked");
        assert!(result.timeline_ref.is_none());
        assert!(has(&result, "asset.missing"));
        let (_temp, mut store, mut request) = fixture();
        request.video_tracks[0].clips[0]
            .evidence_refs
            .push(FindingRef {
                kind: "event".into(),
                id: "missing-event".into(),
                revision: None,
            });
        let result = build_video_timeline(&mut store, &request).unwrap();
        assert_eq!(result.status, "blocked");
        assert!(has(&result, "evidence.missing_required_ref"));
    }
    #[test]
    fn gaps_and_overlaps_are_blocked() {
        for (second_start, expected) in [
            (Some(31), "timeline.gap"),
            (Some(29), "timeline.unexpected_overlap"),
        ] {
            let (_temp, mut store, mut request) = fixture();
            request.video_tracks[0].clips.push(VideoClipBuildRequest {
                shot_ref: Ref {
                    id: "sh1".into(),
                    revision: 1,
                },
                asset_ref: Ref {
                    id: "a1".into(),
                    revision: 1,
                },
                start_frame: second_start,
                duration_frames: 5,
                source_in_frame: 0,
                fit: FitMode::Contain,
                transition_after: None,
                evidence_refs: vec![],
            });
            let result = build_video_timeline(&mut store, &request).unwrap();
            assert_eq!(result.status, "blocked");
            assert!(has(&result, expected));
        }
    }
    #[test]
    fn rejects_cross_project_episode_and_storyboard_refs_and_request_key_reuse() {
        let (_temp, mut store, mut request) = fixture();
        request.project_ref.revision = 2;
        assert!(build_video_timeline(&mut store, &request).is_err());
        let (_temp, mut store, mut request) = fixture();
        request.episode_ref.id = "other-episode".into();
        assert!(build_video_timeline(&mut store, &request).is_err());
        let (_temp, mut store, mut request) = fixture();
        request.storyboard_ref.id = "other-storyboard".into();
        assert!(build_video_timeline(&mut store, &request).is_err());
        let (_temp, mut store, mut request) = fixture();
        let _ = build_video_timeline(&mut store, &request).unwrap();
        request.video_tracks[0].clips[0].fit = FitMode::Cover;
        assert!(build_video_timeline(&mut store, &request)
            .unwrap_err()
            .contains("reused with a different payload"));
    }
}
