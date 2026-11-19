//! Pure deterministic evaluation of normalized video timelines.
//!
//! This module deliberately performs no I/O. Adapters must resolve exact revisions,
//! inspect managed paths (including symlink escapes), hash bytes, probe streams, run
//! decode checks, and fetch current rights/evidence facts before calling [`evaluate`].
//! A report authorizes only its `input_fingerprint`; callers must re-evaluate after any
//! input, policy, or profile change. This module does not persist reports or create jobs.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path};

pub const QA_SCHEMA_VERSION: &str = "fina.video_qa.v1";
pub const EVALUATOR_VERSION: &str = "fina-video-qa-deterministic-v1";

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct VersionedRef {
    pub id: String,
    pub revision: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct AssetRef {
    pub id: String,
    pub revision: u32,
}
impl AssetRef {
    fn key(&self) -> String {
        format!("{}@{}", self.id, self.revision)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceRef {
    pub kind: String,
    pub id: String,
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VideoClip {
    pub clip_id: String,
    pub shot_id: String,
    pub asset: AssetRef,
    /// Hash pinned by the normalized timeline/EDL.
    pub expected_sha256: String,
    pub start_ms: u64,
    pub duration_ms: u64,
    pub source_in_ms: u64,
    /// Whether a preceding gap was explicitly authorized by the editorial timeline.
    pub gap_allowed_before: bool,
    /// Whether an overlap with the previous clip is an explicit transition.
    pub overlap_allowed_with_previous: bool,
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AudioClip {
    pub clip_id: String,
    pub asset: AssetRef,
    pub expected_sha256: String,
    pub start_ms: u64,
    pub duration_ms: u64,
    pub source_in_ms: u64,
    pub evidence: Vec<EvidenceRef>,
}

/// A normalized, revision-pinned timeline. Input ordering is retained for adjacent
/// transition semantics; evaluation and fingerprinting are otherwise deterministic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NormalizedTimeline {
    pub timeline_ref: VersionedRef,
    pub project_ref: VersionedRef,
    pub timeline_hash: String,
    pub profile_ref: VersionedRef,
    pub total_duration_ms: u64,
    pub required_shot_ids: Vec<String>,
    pub video_clips: Vec<VideoClip>,
    pub audio_clips: Vec<AudioClip>,
    /// `Some(false)` is an explicit timeline fact; `None` is missing required input.
    pub parent_refs_valid: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetRole {
    Video,
    Audio,
}

/// License state of a selected media asset. Internal-review-only is distinct
/// from rights approval and is permitted only for the installed preview profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssetRightsStatus {
    Unreviewed,
    Approved,
    InternalReviewOnly,
    Blocked,
    PurgeRequired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecodeResult {
    Decoded,
    Failed,
    NotRun,
}

/// Probe values are optional intentionally: an absent required probe result is a
/// blocking `not_run`, never a successful default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProbeProperties {
    pub container: Option<String>,
    pub video_codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps_num: Option<u32>,
    pub fps_den: Option<u32>,
    pub duration_ms: Option<u64>,
    pub has_audio_stream: Option<bool>,
    pub audio_codec: Option<String>,
    pub audio_sample_rate: Option<u32>,
    pub audio_channels: Option<u16>,
    pub audio_clipped: Option<bool>,
}

/// Facts acquired by a trusted adapter for the exact asset revision. The evaluator
/// checks lexical confinement and the adapter's symlink-escape verdict without
/// opening a file or running a process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MediaFacts {
    pub asset: AssetRef,
    pub role: AssetRole,
    pub resolved_path: String,
    pub managed_root: String,
    pub symlink_escape_detected: bool,
    pub actual_sha256: Option<String>,
    pub expected_sha256: Option<String>,
    pub probe: Option<ProbeProperties>,
    pub decode_result: DecodeResult,
    /// Adapter validation of source lineage/project ownership for this exact asset.
    pub source_lineage_valid: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceCheck {
    pub reference_valid: bool,
    pub span_valid: bool,
    /// An explicit non-claiming editorial decision may satisfy a non-required ref.
    pub non_claiming_reason: Option<String>,
}

/// Installed profile requirements; these are data, not caller-selected codec flags.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutputProfileRequirements {
    pub profile_ref: VersionedRef,
    pub available: bool,
    pub required_container: String,
    pub required_video_codec: String,
    pub width: u32,
    pub height: u32,
    pub fps_num: u32,
    pub fps_den: u32,
    pub min_duration_ms: u64,
    pub max_duration_ms: u64,
    pub audio_required: bool,
    pub required_audio_codec: Option<String>,
    pub required_audio_sample_rate: Option<u32>,
    pub required_audio_channels: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QaInput {
    pub timeline: NormalizedTimeline,
    pub media_facts: Vec<MediaFacts>,
    /// Current rights facts keyed by `asset-id@revision`.
    pub rights: BTreeMap<String, AssetRightsStatus>,
    /// Current evidence facts keyed by `kind:id`.
    pub evidence_checks: BTreeMap<String, EvidenceCheck>,
    pub profile: OutputProfileRequirements,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingSeverity {
    Blocker,
    Warning,
    Info,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingState {
    Failed,
    Passed,
    NotApplicable,
    NotRun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QaDecision {
    Allow,
    AllowWithWarnings,
    Block,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionState {
    Complete,
    Partial,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindingRef {
    pub kind: String,
    pub id: String,
    pub revision: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Remediation {
    pub action: String,
    pub adapter_requirement: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QaFinding {
    pub finding_id: String,
    pub code: String,
    pub severity: FindingSeverity,
    pub state: FindingState,
    pub subject_ref: Option<FindingRef>,
    pub message: String,
    pub expected: Option<String>,
    pub actual: Option<String>,
    pub evidence_refs: Vec<EvidenceRef>,
    pub remediation: Option<Remediation>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckSummary {
    pub passed: u32,
    pub warnings: u32,
    pub blockers: u32,
    pub not_run: u32,
}

/// Versioned immutable-by-contract evaluation result. It is returned by value and
/// contains no handles to mutable evaluator state or persistence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QaReport {
    schema_version: String,
    evaluator_version: String,
    project_ref: VersionedRef,
    timeline_ref: VersionedRef,
    timeline_hash: String,
    profile_ref: VersionedRef,
    input_fingerprint: String,
    execution_state: ExecutionState,
    decision: QaDecision,
    check_summary: CheckSummary,
    findings: Vec<QaFinding>,
}
impl QaReport {
    pub fn schema_version(&self) -> &str {
        &self.schema_version
    }
    pub fn evaluator_version(&self) -> &str {
        &self.evaluator_version
    }
    pub fn project_ref(&self) -> &VersionedRef {
        &self.project_ref
    }
    pub fn timeline_ref(&self) -> &VersionedRef {
        &self.timeline_ref
    }
    pub fn timeline_hash(&self) -> &str {
        &self.timeline_hash
    }
    pub fn profile_ref(&self) -> &VersionedRef {
        &self.profile_ref
    }
    pub fn input_fingerprint(&self) -> &str {
        &self.input_fingerprint
    }
    pub fn execution_state(&self) -> ExecutionState {
        self.execution_state
    }
    pub fn decision(&self) -> QaDecision {
        self.decision
    }
    pub fn check_summary(&self) -> CheckSummary {
        self.check_summary
    }
    pub fn findings(&self) -> &[QaFinding] {
        &self.findings
    }
}

/// Evaluate only already-resolved facts; this function does no filesystem or process
/// I/O, and always treats missing facts for mandatory checks as blockers.
pub fn evaluate(input: &QaInput) -> QaReport {
    let mut findings = Vec::new();
    let mut emitter = Emitter {
        findings: &mut findings,
    };

    if input.timeline.profile_ref != input.profile.profile_ref {
        emitter.failed(
            "export.profile_unavailable",
            FindingSeverity::Blocker,
            None,
            "The timeline profile reference does not match the evaluated profile.",
            Some(format!(
                "{}@{}",
                input.profile.profile_ref.id, input.profile.profile_ref.revision
            )),
            Some(format!(
                "{}@{}",
                input.timeline.profile_ref.id, input.timeline.profile_ref.revision
            )),
            "Resolve the exact profile revision used to compile this timeline.",
        );
    } else if !input.profile.available || !valid_profile(&input.profile) {
        emitter.failed(
            "export.profile_unavailable",
            FindingSeverity::Blocker,
            None,
            "The selected output profile is unavailable or internally invalid.",
            Some("available profile with positive dimensions and rational frame rate".into()),
            Some(format!("available={}", input.profile.available)),
            "Install or select an available, configured output profile.",
        );
    } else {
        emitter.passed(
            "export.profile_available",
            FindingSeverity::Info,
            None,
            "The exact output profile is available and internally valid.",
        );
    }

    match input.timeline.parent_refs_valid {
        Some(true) => emitter.passed(
            "production.parent_refs_valid",
            FindingSeverity::Info,
            None,
            "Timeline parent references are valid for this project/episode/storyboard.",
        ),
        Some(false) => emitter.failed(
            "production.parent_refs_invalid",
            FindingSeverity::Blocker,
            None,
            "A timeline parent reference is invalid or belongs to another production graph.",
            None,
            None,
            "Resolve and rebuild the timeline using exact same-project parent revisions.",
        ),
        None => emitter.not_run(
            "production.parent_refs_unchecked",
            None,
            "Required production parent-reference checks were not supplied.",
            "Adapter must validate project, episode, and storyboard ownership for exact revisions.",
        ),
    }

    evaluate_timeline(&input.timeline, &mut emitter);

    let mut selected: BTreeMap<String, (AssetRef, AssetRole, Vec<String>)> = BTreeMap::new();
    for clip in &input.timeline.video_clips {
        selected
            .entry(clip.asset.key())
            .or_insert_with(|| (clip.asset.clone(), AssetRole::Video, Vec::new()))
            .2
            .push(clip.expected_sha256.clone());
        evaluate_evidence(
            &clip.evidence,
            &input.evidence_checks,
            &clip.shot_id,
            &mut emitter,
        );
    }
    for clip in &input.timeline.audio_clips {
        selected
            .entry(clip.asset.key())
            .or_insert_with(|| (clip.asset.clone(), AssetRole::Audio, Vec::new()))
            .2
            .push(clip.expected_sha256.clone());
        evaluate_evidence(
            &clip.evidence,
            &input.evidence_checks,
            &clip.clip_id,
            &mut emitter,
        );
    }
    evaluate_shot_coverage(&input.timeline, &mut emitter);
    evaluate_audio_timeline(&input.timeline, &input.profile, &mut emitter);

    // Rights are independent facts and must be checked even when media facts are
    // missing or ambiguous, so evaluate each selected revision exactly once.
    for (key, (asset, _, _)) in &selected {
        evaluate_rights(
            asset,
            input.rights.get(key),
            input.profile.profile_ref.id == crate::video_edl::PREVIEW_PROFILE_ID,
            &mut emitter,
        );
    }

    let mut facts_by_key: BTreeMap<String, Vec<&MediaFacts>> = BTreeMap::new();
    for facts in &input.media_facts {
        facts_by_key
            .entry(facts.asset.key())
            .or_default()
            .push(facts);
    }
    for (key, (asset, role, clip_hashes)) in selected {
        let refs: Vec<_> = clip_hashes.iter().map(String::as_str).collect();
        let candidates = facts_by_key.get(&key).cloned().unwrap_or_default();
        if candidates.is_empty() {
            emitter.failed("asset.missing", FindingSeverity::Blocker, Some(asset_subject(&asset)),
                "No verified media facts were supplied for the selected asset revision.",
                Some("exact asset revision with complete adapter facts".into()), None,
                "Resolve this exact asset revision and supply its hash, managed path, probe, decode, rights, and lineage facts.");
            emit_missing_asset_checks(&asset, role, &mut emitter);
            continue;
        }
        if candidates.len() > 1 {
            emitter.failed(
                "asset.facts_ambiguous",
                FindingSeverity::Blocker,
                Some(asset_subject(&asset)),
                "More than one media-facts record was supplied for the same exact asset revision.",
                Some("one unambiguous facts record".into()),
                Some(candidates.len().to_string()),
                "Deduplicate adapter results for this exact asset revision.",
            );
            continue;
        }
        let facts = candidates[0];
        if facts.role != role {
            emitter.failed(
                "asset.role_mismatch",
                FindingSeverity::Blocker,
                Some(asset_subject(&asset)),
                "The media facts role does not match the timeline use.",
                Some(format!("{role:?}")),
                Some(format!("{:?}", facts.role)),
                "Resolve the correct media asset for this timeline track.",
            );
        } else {
            emitter.passed(
                "asset.role_valid",
                FindingSeverity::Info,
                Some(asset_subject(&asset)),
                "The exact asset role matches its timeline use.",
            );
        }
        evaluate_path(facts, &mut emitter);
        evaluate_hash(facts, &refs, &mut emitter);
        evaluate_lineage(facts, &mut emitter);
        evaluate_decode(facts, &mut emitter);
        evaluate_probe(facts, role, &input.profile, &mut emitter);
        evaluate_source_bounds(
            &asset,
            role,
            &input.timeline,
            facts.probe.as_ref().and_then(|p| p.duration_ms),
            &mut emitter,
        );
    }

    let summary = summarize(&findings);
    let has_block = summary.blockers > 0 || summary.not_run > 0;
    let decision = if has_block {
        QaDecision::Block
    } else if summary.warnings > 0 {
        QaDecision::AllowWithWarnings
    } else {
        QaDecision::Allow
    };
    let execution_state = if summary.not_run > 0 {
        ExecutionState::Partial
    } else {
        ExecutionState::Complete
    };
    let input_fingerprint = fingerprint(input);
    QaReport {
        schema_version: QA_SCHEMA_VERSION.into(),
        evaluator_version: EVALUATOR_VERSION.into(),
        project_ref: input.timeline.project_ref.clone(),
        timeline_ref: input.timeline.timeline_ref.clone(),
        timeline_hash: input.timeline.timeline_hash.clone(),
        profile_ref: input.profile.profile_ref.clone(),
        input_fingerprint,
        execution_state,
        decision,
        check_summary: summary,
        findings,
    }
}

struct Emitter<'a> {
    findings: &'a mut Vec<QaFinding>,
}
impl Emitter<'_> {
    #[allow(clippy::too_many_arguments)] // Mirrors the complete typed finding payload.
    fn add(
        &mut self,
        code: &str,
        severity: FindingSeverity,
        state: FindingState,
        subject_ref: Option<FindingRef>,
        message: &str,
        expected: Option<String>,
        actual: Option<String>,
        remediation: Option<Remediation>,
    ) {
        let seq = self.findings.len();
        self.findings.push(QaFinding {
            finding_id: format!("{}-{seq:04}", code.replace('.', "-")),
            code: code.into(),
            severity,
            state,
            subject_ref,
            message: message.into(),
            expected,
            actual,
            evidence_refs: Vec::new(),
            remediation,
        });
    }
    fn passed(
        &mut self,
        code: &str,
        severity: FindingSeverity,
        subject: Option<FindingRef>,
        message: &str,
    ) {
        self.add(
            code,
            severity,
            FindingState::Passed,
            subject,
            message,
            None,
            None,
            None,
        )
    }
    #[allow(clippy::too_many_arguments)] // Keeps deterministic failure payloads explicit at call sites.
    fn failed(
        &mut self,
        code: &str,
        severity: FindingSeverity,
        subject: Option<FindingRef>,
        message: &str,
        expected: Option<String>,
        actual: Option<String>,
        action: &str,
    ) {
        self.add(
            code,
            severity,
            FindingState::Failed,
            subject,
            message,
            expected,
            actual,
            Some(Remediation {
                action: action.into(),
                adapter_requirement: None,
            }),
        )
    }
    fn not_run(
        &mut self,
        code: &str,
        subject: Option<FindingRef>,
        message: &str,
        adapter_requirement: &str,
    ) {
        self.add(
            code,
            FindingSeverity::Blocker,
            FindingState::NotRun,
            subject,
            message,
            None,
            None,
            Some(Remediation {
                action: "Complete the required deterministic check before export.".into(),
                adapter_requirement: Some(adapter_requirement.into()),
            }),
        )
    }
    fn attach_evidence(&mut self, reference: EvidenceRef) {
        if let Some(finding) = self.findings.last_mut() {
            finding.evidence_refs.push(reference);
        }
    }
}

fn evaluate_timeline(timeline: &NormalizedTimeline, out: &mut Emitter<'_>) {
    if timeline.video_clips.is_empty() {
        out.failed(
            "timeline.empty",
            FindingSeverity::Blocker,
            None,
            "Timeline has no video clips.",
            Some("at least one video clip".into()),
            Some("0".into()),
            "Build a timeline with at least one rendered video clip.",
        );
    } else {
        out.passed(
            "timeline.nonempty",
            FindingSeverity::Info,
            None,
            "Timeline contains video clips.",
        );
    }
    let mut previous_end: Option<u64> = None;
    let mut max_end = 0u64;
    let mut arithmetic_valid = true;
    for (index, clip) in timeline.video_clips.iter().enumerate() {
        let subject = Some(FindingRef {
            kind: "clip".into(),
            id: clip.clip_id.clone(),
            revision: None,
        });
        if index == 0 && clip.start_ms > 0 && !clip.gap_allowed_before {
            out.failed(
                "timeline.gap",
                FindingSeverity::Blocker,
                subject.clone(),
                "An unapproved opening gap exists before the first video clip.",
                Some("start at 0 ms or explicitly authorized gap".into()),
                Some(format!("start {} ms", clip.start_ms)),
                "Start at sequence zero or encode an explicit allowed editorial gap.",
            );
        }
        if clip.duration_ms == 0 {
            arithmetic_valid = false;
            out.failed(
                "timeline.duration_invalid",
                FindingSeverity::Blocker,
                subject.clone(),
                "Video clip duration must be positive.",
                Some("> 0 ms".into()),
                Some("0 ms".into()),
                "Set a positive, explicitly quantized clip duration.",
            );
        }
        let end = clip.start_ms.checked_add(clip.duration_ms);
        match end {
            Some(end) => {
                max_end = max_end.max(end);
                if let Some(prev) = previous_end {
                    if clip.start_ms > prev && !clip.gap_allowed_before {
                        out.failed(
                            "timeline.gap",
                            FindingSeverity::Blocker,
                            subject.clone(),
                            "An unapproved gap exists between adjacent video clips.",
                            Some(format!("start <= {prev} ms or explicit gap")),
                            Some(format!("start {} ms", clip.start_ms)),
                            "Close the gap or encode an explicit allowed editorial gap.",
                        );
                    } else if clip.start_ms < prev && !clip.overlap_allowed_with_previous {
                        out.failed(
                            "timeline.unexpected_overlap",
                            FindingSeverity::Blocker,
                            subject.clone(),
                            "Video clips overlap without an explicit transition.",
                            Some(format!("start >= {prev} ms or explicit transition")),
                            Some(format!("start {} ms", clip.start_ms)),
                            "Resolve the overlap or declare its matching transition.",
                        );
                    } else if clip.start_ms == prev
                        || clip.start_ms > prev && clip.gap_allowed_before
                        || clip.start_ms < prev && clip.overlap_allowed_with_previous
                    {
                        out.passed(
                            "timeline.adjacency_valid",
                            FindingSeverity::Info,
                            subject.clone(),
                            "Clip adjacency is contiguous or explicitly authorized.",
                        );
                    }
                }
                previous_end = Some(end);
            }
            None => {
                arithmetic_valid = false;
                out.failed(
                    "timeline.arithmetic_overflow",
                    FindingSeverity::Blocker,
                    subject,
                    "Clip end time overflows checked integer arithmetic.",
                    None,
                    None,
                    "Rebuild the timeline using checked duration arithmetic.",
                );
            }
        }
    }
    if arithmetic_valid {
        out.passed(
            "timeline.arithmetic_valid",
            FindingSeverity::Info,
            None,
            "Timeline clip end times use safe checked integer arithmetic.",
        );
    }
    if max_end != timeline.total_duration_ms {
        out.failed(
            "timeline.duration_mismatch",
            FindingSeverity::Blocker,
            None,
            "Declared timeline duration does not match the maximum clip end.",
            Some(format!("{} ms", max_end)),
            Some(format!("{} ms", timeline.total_duration_ms)),
            "Recompute total duration from normalized clip boundaries.",
        );
    } else {
        out.passed(
            "timeline.duration_match",
            FindingSeverity::Info,
            None,
            "Declared timeline duration matches the maximum clip end.",
        );
    }
}

fn evaluate_shot_coverage(timeline: &NormalizedTimeline, out: &mut Emitter<'_>) {
    let covered: BTreeSet<&str> = timeline
        .video_clips
        .iter()
        .map(|c| c.shot_id.as_str())
        .collect();
    let mut missing: Vec<&str> = timeline
        .required_shot_ids
        .iter()
        .map(String::as_str)
        .filter(|id| !covered.contains(id))
        .collect();
    missing.sort_unstable();
    if missing.is_empty() {
        out.passed(
            "storyboard.shot_coverage",
            FindingSeverity::Info,
            None,
            "Every required storyboard shot maps to a timeline video clip.",
        );
    } else {
        for shot in missing {
            out.failed("storyboard.shot_unmapped", FindingSeverity::Blocker,
                Some(FindingRef { kind: "shot".into(), id: shot.into(), revision: None }),
                "A required storyboard shot has no timeline mapping.", Some("mapped video clip".into()), None,
                "Map the required shot to an exact rendered asset or resolve its explicit nonvisual disposition.");
        }
    }
}

fn evaluate_audio_timeline(
    timeline: &NormalizedTimeline,
    profile: &OutputProfileRequirements,
    out: &mut Emitter<'_>,
) {
    if profile.audio_required && timeline.audio_clips.is_empty() {
        out.failed("audio.required_missing", FindingSeverity::Blocker, None,
            "The selected profile requires an audio track, but the timeline has none.",
            Some("at least one audio clip".into()), Some("0 audio clips".into()),
            "Add a compliant narration/audio clip or select a profile that explicitly permits silence.");
    } else if profile.audio_required {
        out.passed(
            "audio.required_present",
            FindingSeverity::Info,
            None,
            "Required timeline audio is present.",
        );
    } else {
        out.add(
            "audio.required_missing",
            FindingSeverity::Info,
            FindingState::NotApplicable,
            None,
            "Audio is not required by this profile; silence remains profile-authorized.",
            None,
            None,
            None,
        );
    }
    for clip in &timeline.audio_clips {
        let subject = Some(FindingRef {
            kind: "audio_clip".into(),
            id: clip.clip_id.clone(),
            revision: None,
        });
        match clip.start_ms.checked_add(clip.duration_ms) {
            Some(end) if clip.duration_ms > 0 && end <= timeline.total_duration_ms => out.passed(
                "audio.timeline_bounds_valid",
                FindingSeverity::Info,
                subject,
                "Audio clip lies within timeline bounds.",
            ),
            Some(_end) if clip.duration_ms == 0 => out.failed(
                "audio.timeline_bounds_invalid",
                FindingSeverity::Blocker,
                subject,
                "Audio clip duration must be positive.",
                Some("> 0 ms".into()),
                Some("0 ms".into()),
                "Set a positive audio clip duration.",
            ),
            Some(end) => out.failed(
                "audio.timeline_bounds_invalid",
                FindingSeverity::Blocker,
                subject,
                "Audio clip extends beyond the timeline.",
                Some(format!("<= {} ms", timeline.total_duration_ms)),
                Some(format!("end {end} ms")),
                "Trim or reposition the audio clip within the timeline.",
            ),
            None => out.failed(
                "timeline.arithmetic_overflow",
                FindingSeverity::Blocker,
                subject,
                "Audio clip end time overflows checked integer arithmetic.",
                None,
                None,
                "Rebuild the audio clip using checked integer arithmetic.",
            ),
        }
    }
}

fn evaluate_source_bounds(
    asset: &AssetRef,
    role: AssetRole,
    timeline: &NormalizedTimeline,
    source_duration_ms: Option<u64>,
    out: &mut Emitter<'_>,
) {
    match role {
        AssetRole::Video => {
            for clip in timeline
                .video_clips
                .iter()
                .filter(|clip| clip.asset == *asset)
            {
                let subject = Some(FindingRef {
                    kind: "clip".into(),
                    id: clip.clip_id.clone(),
                    revision: None,
                });
                check_source_range(
                    clip.source_in_ms,
                    clip.duration_ms,
                    source_duration_ms,
                    subject,
                    "timeline.source_out_of_bounds",
                    "Video clip source trim extends beyond the selected media.",
                    out,
                );
            }
        }
        AssetRole::Audio => {
            for clip in timeline
                .audio_clips
                .iter()
                .filter(|clip| clip.asset == *asset)
            {
                let subject = Some(FindingRef {
                    kind: "audio_clip".into(),
                    id: clip.clip_id.clone(),
                    revision: None,
                });
                check_source_range(
                    clip.source_in_ms,
                    clip.duration_ms,
                    source_duration_ms,
                    subject,
                    "audio.source_out_of_bounds",
                    "Audio clip source trim extends beyond the selected media.",
                    out,
                );
            }
        }
    }
}

fn check_source_range(
    source_in_ms: u64,
    duration_ms: u64,
    source_duration_ms: Option<u64>,
    subject: Option<FindingRef>,
    code: &str,
    message: &str,
    out: &mut Emitter<'_>,
) {
    let Some(source_duration_ms) = source_duration_ms else {
        out.not_run("timeline.source_bounds_unchecked", subject, "Source trim cannot be validated because probed source duration is missing.",
            "Adapter must provide actual source duration; evaluator checks source_in + clip duration with checked integer arithmetic.");
        return;
    };
    match source_in_ms.checked_add(duration_ms) {
        Some(end) if duration_ms > 0 && end <= source_duration_ms => out.passed(
            "timeline.source_bounds_valid",
            FindingSeverity::Info,
            subject,
            "Source trim fits within the probed media duration.",
        ),
        Some(_end) if duration_ms == 0 => out.failed(
            code,
            FindingSeverity::Blocker,
            subject,
            "Source clip duration must be positive.",
            Some("> 0 ms".into()),
            Some("0 ms".into()),
            "Set a positive source trim duration.",
        ),
        Some(end) => out.failed(
            code,
            FindingSeverity::Blocker,
            subject,
            message,
            Some(format!("source end <= {source_duration_ms} ms")),
            Some(format!("source end {end} ms")),
            "Trim the selected clip to the exact source media bounds.",
        ),
        None => out.failed(
            "timeline.arithmetic_overflow",
            FindingSeverity::Blocker,
            subject,
            "Source trim end overflows checked integer arithmetic.",
            None,
            None,
            "Rebuild the source trim using checked integer arithmetic.",
        ),
    }
}

fn evaluate_evidence(
    refs: &[EvidenceRef],
    checks: &BTreeMap<String, EvidenceCheck>,
    subject_id: &str,
    out: &mut Emitter<'_>,
) {
    if refs.is_empty() {
        out.add(
            "evidence.missing_required_ref",
            FindingSeverity::Info,
            FindingState::NotApplicable,
            Some(FindingRef {
                kind: "clip".into(),
                id: subject_id.into(),
                revision: None,
            }),
            "No evidence reference is declared for this clip.",
            None,
            None,
            None,
        );
        return;
    }
    for evidence in refs {
        let subject = Some(FindingRef {
            kind: evidence.kind.clone(),
            id: evidence.id.clone(),
            revision: None,
        });
        let key = format!("{}:{}", evidence.kind, evidence.id);
        let Some(check) = checks.get(&key) else {
            if evidence.required {
                out.not_run("evidence.required_check_unavailable", subject,
                    "Required evidence reference has no canonical validation result.",
                    "Adapter must validate canonical event/claim existence, offsets, bounds, and quote retention.");
                out.attach_evidence(evidence.clone());
            } else {
                out.add(
                    "evidence.optional_check_unavailable",
                    FindingSeverity::Info,
                    FindingState::NotApplicable,
                    subject,
                    "Optional evidence was not supplied for validation.",
                    None,
                    None,
                    None,
                );
                out.attach_evidence(evidence.clone());
            }
            continue;
        };
        if evidence.required && !check.reference_valid {
            out.failed("evidence.missing_required_ref", FindingSeverity::Blocker, subject,
                "Required evidence reference is missing or invalid in the canonical evidence source.",
                Some("valid canonical reference".into()), Some("invalid".into()),
                "Resolve the canonical event/claim reference and attach its validated revision.");
            out.attach_evidence(evidence.clone());
        } else if !check.reference_valid
            && check
                .non_claiming_reason
                .as_deref()
                .unwrap_or("")
                .trim()
                .is_empty()
        {
            out.failed("evidence.missing_required_ref", FindingSeverity::Blocker, subject,
                "Evidence is invalid and has no explicit non-claiming editorial reason.",
                Some("valid evidence or explicit non-claiming reason".into()), Some("invalid".into()),
                "Supply validated evidence or an explicit non-claiming reason for the editorial clip.");
            out.attach_evidence(evidence.clone());
        } else if !check.span_valid {
            out.failed(
                "evidence.invalid_span",
                FindingSeverity::Blocker,
                subject,
                "Evidence offsets or retained quote span are invalid or out of bounds.",
                Some("ordered in-bounds offsets and matching retained quote".into()),
                Some("invalid span".into()),
                "Revalidate evidence offsets and quote against the canonical source.",
            );
            out.attach_evidence(evidence.clone());
        } else {
            out.passed(
                "evidence.reference_valid",
                FindingSeverity::Info,
                subject,
                "Evidence reference and span passed canonical validation.",
            );
            out.attach_evidence(evidence.clone());
        }
    }
}

fn evaluate_path(facts: &MediaFacts, out: &mut Emitter<'_>) {
    let subject = Some(asset_subject(&facts.asset));
    if lexical_path_confined(&facts.resolved_path, &facts.managed_root)
        && !facts.symlink_escape_detected
    {
        out.passed("asset.path_confined", FindingSeverity::Info, subject,
            "Resolved asset path is lexically inside the managed root and the adapter reported no symlink escape.");
    } else {
        out.failed("asset.path_escape", FindingSeverity::Blocker, subject,
            "Asset path is outside the managed root, traverses a parent component, or escaped through a symlink.",
            Some("confined path and no symlink escape".into()),
            Some(format!("lexical_confined={}, symlink_escape={}", lexical_path_confined(&facts.resolved_path, &facts.managed_root), facts.symlink_escape_detected)),
            "Adapter must resolve paths under the managed root and verify canonical symlink confinement before evaluation.");
    }
}

fn lexical_path_confined(path: &str, root: &str) -> bool {
    let p = Path::new(path);
    let r = Path::new(root);
    p.is_absolute()
        && r.is_absolute()
        && !p
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        && !r
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        && p != r
        && p.starts_with(r)
}

fn evaluate_hash(facts: &MediaFacts, clip_hashes: &[&str], out: &mut Emitter<'_>) {
    let subject = Some(asset_subject(&facts.asset));
    let Some(actual) = facts.actual_sha256.as_deref() else {
        out.not_run(
            "asset.hash_unverified",
            subject,
            "Actual bytes hash was not supplied.",
            "Adapter must SHA-256 the exact managed asset bytes.",
        );
        return;
    };
    let Some(expected) = facts.expected_sha256.as_deref() else {
        out.not_run(
            "asset.hash_unverified",
            subject,
            "Expected asset hash was not supplied by the pinned timeline/source record.",
            "Adapter must resolve the expected hash from the exact immutable asset revision.",
        );
        return;
    };
    if actual == expected && clip_hashes.iter().all(|hash| *hash == expected) {
        out.passed(
            "asset.hash_match",
            FindingSeverity::Info,
            subject,
            "Actual bytes hash matches the pinned timeline and asset hashes.",
        );
    } else {
        out.failed("asset.hash_mismatch", FindingSeverity::Blocker, subject,
            "Actual byte hash differs from the pinned timeline or asset revision hash.",
            Some(format!("timeline={:?}, asset={expected}", clip_hashes)), Some(actual.into()),
            "Re-resolve the exact asset revision, verify its bytes, and rebuild the timeline if its pinned hash changed.");
    }
}

fn evaluate_lineage(facts: &MediaFacts, out: &mut Emitter<'_>) {
    let subject = Some(asset_subject(&facts.asset));
    match facts.source_lineage_valid {
        Some(true) => out.passed(
            "production.asset_lineage_valid",
            FindingSeverity::Info,
            subject,
            "Selected asset has valid exact source lineage.",
        ),
        Some(false) => out.failed(
            "production.asset_lineage_invalid",
            FindingSeverity::Blocker,
            subject,
            "Selected asset source lineage is invalid or belongs to another production graph.",
            Some("valid exact source lineage".into()),
            Some("invalid".into()),
            "Resolve an asset with verified source lineage for this production graph.",
        ),
        None => out.not_run(
            "production.asset_lineage_unchecked",
            subject,
            "Exact source lineage was not supplied.",
            "Adapter must verify asset-to-shot/VisualSpec/source relations and project ownership.",
        ),
    }
}

fn evaluate_decode(facts: &MediaFacts, out: &mut Emitter<'_>) {
    let subject = Some(asset_subject(&facts.asset));
    match facts.decode_result {
        DecodeResult::Decoded => out.passed(
            "asset.decode_valid",
            FindingSeverity::Info,
            subject,
            "Container decode check completed successfully.",
        ),
        DecodeResult::Failed => out.failed(
            "asset.decode_failed",
            FindingSeverity::Blocker,
            subject,
            "Container or stream decode check failed.",
            Some("decode succeeds".into()),
            Some("failed".into()),
            "Repair or rerender the exact media asset, then repeat the adapter decode check.",
        ),
        DecodeResult::NotRun => out.not_run(
            "asset.decode_unchecked",
            subject,
            "Required container decode check did not run.",
            "Adapter must decode/probe the complete selected media asset.",
        ),
    }
}

fn evaluate_probe(
    facts: &MediaFacts,
    role: AssetRole,
    profile: &OutputProfileRequirements,
    out: &mut Emitter<'_>,
) {
    let subject = Some(asset_subject(&facts.asset));
    let Some(probe) = &facts.probe else {
        out.not_run("media.probe_unavailable", subject,
            "Required stream probe properties were not supplied.",
            "Adapter must probe actual container, streams, dimensions, rational frame rate, duration, and audio properties.");
        emit_missing_probe_details(facts, role, profile, out);
        return;
    };
    match role {
        AssetRole::Video => {
            check_string(
                "media.container_mismatch",
                probe.container.as_deref(),
                Some(profile.required_container.as_str()),
                &facts.asset,
                "container",
                out,
            );
            check_string(
                "media.codec_unsupported",
                probe.video_codec.as_deref(),
                Some(profile.required_video_codec.as_str()),
                &facts.asset,
                "video codec",
                out,
            );
            check_u32(
                "media.dimensions_mismatch",
                probe.width,
                Some(profile.width),
                &facts.asset,
                "width",
                out,
            );
            check_u32(
                "media.dimensions_mismatch",
                probe.height,
                Some(profile.height),
                &facts.asset,
                "height",
                out,
            );
            match (probe.fps_num, probe.fps_den) {
                (Some(num), Some(den)) if den > 0 && num as u64 * profile.fps_den as u64 == profile.fps_num as u64 * den as u64 =>
                    out.passed("media.fps_match", FindingSeverity::Info, Some(asset_subject(&facts.asset)), "Video frame rate matches the rational profile rate."),
                (Some(num), Some(den)) if den > 0 => out.failed("media.fps_mismatch", FindingSeverity::Blocker,
                    Some(asset_subject(&facts.asset)), "Video frame rate does not match the output profile.",
                    Some(format!("{}/{}", profile.fps_num, profile.fps_den)), Some(format!("{num}/{den}")),
                    "Rerender or convert using the exact rational frame rate required by the profile."),
                _ => out.not_run("media.fps_unchecked", Some(asset_subject(&facts.asset)),
                    "Video rational frame rate is missing or invalid.", "Adapter must supply positive probed FPS numerator and denominator."),
            }
            match probe.duration_ms {
                Some(duration)
                    if duration >= profile.min_duration_ms
                        && duration <= profile.max_duration_ms =>
                {
                    out.passed(
                        "media.duration_valid",
                        FindingSeverity::Info,
                        Some(asset_subject(&facts.asset)),
                        "Media duration satisfies output profile limits.",
                    )
                }
                Some(duration) if duration < profile.min_duration_ms => out.failed(
                    "media.duration_short",
                    FindingSeverity::Blocker,
                    Some(asset_subject(&facts.asset)),
                    "Media duration is shorter than the profile minimum.",
                    Some(format!(">= {} ms", profile.min_duration_ms)),
                    Some(format!("{duration} ms")),
                    "Rerender or select a profile-compatible duration.",
                ),
                Some(duration) => out.failed(
                    "media.duration_long",
                    FindingSeverity::Blocker,
                    Some(asset_subject(&facts.asset)),
                    "Media duration exceeds the profile maximum.",
                    Some(format!("<= {} ms", profile.max_duration_ms)),
                    Some(format!("{duration} ms")),
                    "Trim the media or select a profile with an authorized duration limit.",
                ),
                None => out.not_run(
                    "media.duration_unchecked",
                    Some(asset_subject(&facts.asset)),
                    "Probed media duration is missing.",
                    "Adapter must supply actual probed stream/container duration.",
                ),
            }
        }
        AssetRole::Audio => {
            if profile.audio_required {
                check_string(
                    "media.audio_codec_unsupported",
                    probe.audio_codec.as_deref(),
                    profile.required_audio_codec.as_deref(),
                    &facts.asset,
                    "audio codec",
                    out,
                );
                check_u32(
                    "media.audio_sample_rate_mismatch",
                    probe.audio_sample_rate,
                    profile.required_audio_sample_rate,
                    &facts.asset,
                    "audio sample rate",
                    out,
                );
                check_u16(
                    "media.audio_channels_mismatch",
                    probe.audio_channels,
                    profile.required_audio_channels,
                    &facts.asset,
                    "audio channels",
                    out,
                );
            }
            match probe.audio_clipped {
                Some(true) => out.failed(
                    "audio.clipped",
                    FindingSeverity::Blocker,
                    Some(asset_subject(&facts.asset)),
                    "At least three consecutive decoded samples reached the near-rail threshold on one channel.",
                    Some("no sustained near-rail run (three samples >= 0.9999)".into()),
                    Some("sustained near-rail run detected".into()),
                    "Repair audio gain/dynamics and rerun the deterministic clipping analysis.",
                ),
                Some(false) => out.passed(
                    "audio.clipping_clear",
                    FindingSeverity::Info,
                    Some(asset_subject(&facts.asset)),
                    "No sustained decoded near-rail run (three samples >= 0.9999) was detected.",
                ),
                None => out.not_run(
                    "audio.clipping_unchecked",
                    Some(asset_subject(&facts.asset)),
                    "Required audio clipping fact is missing.",
                    "Adapter must run deterministic clipping analysis and report its result.",
                ),
            }
            match probe.duration_ms {
                Some(duration) => out.passed(
                    "audio.duration_probed",
                    FindingSeverity::Info,
                    Some(asset_subject(&facts.asset)),
                    &format!("Audio source duration was probed ({duration} ms)."),
                ),
                None => out.not_run(
                    "media.duration_unchecked",
                    Some(asset_subject(&facts.asset)),
                    "Probed audio duration is missing.",
                    "Adapter must supply actual audio duration for source-bound checks.",
                ),
            }
            match probe.has_audio_stream {
                Some(true) => out.passed(
                    "audio.stream_present",
                    FindingSeverity::Info,
                    Some(asset_subject(&facts.asset)),
                    "Audio stream is present.",
                ),
                Some(false) => out.failed(
                    "audio.required_missing",
                    FindingSeverity::Blocker,
                    Some(asset_subject(&facts.asset)),
                    "Selected audio asset has no audio stream.",
                    Some("audio stream".into()),
                    Some("absent".into()),
                    "Replace the selected asset with a decodable audio stream.",
                ),
                None => out.not_run(
                    "audio.stream_unchecked",
                    Some(asset_subject(&facts.asset)),
                    "Audio stream presence was not probed.",
                    "Adapter must probe stream presence for the selected audio asset.",
                ),
            }
        }
    }
}

fn emit_missing_probe_details(
    facts: &MediaFacts,
    role: AssetRole,
    profile: &OutputProfileRequirements,
    out: &mut Emitter<'_>,
) {
    let subject = Some(asset_subject(&facts.asset));
    if role == AssetRole::Video {
        out.not_run(
            "media.container_mismatch",
            Some(asset_subject(&facts.asset)),
            "Container format is not probed.",
            "Adapter must supply the actual container/MIME property for the selected video asset.",
        );
        for (code, label) in [
            ("media.codec_unsupported", "video codec"),
            ("media.dimensions_mismatch", "dimensions"),
            ("media.fps_unchecked", "frame rate"),
            ("media.duration_unchecked", "duration"),
        ] {
            out.not_run(
                code,
                subject.clone(),
                &format!("Required {label} probe fact is missing."),
                "Adapter must supply actual required video probe properties.",
            );
        }
    } else {
        if profile.audio_required {
            for (code, label) in [
                ("media.audio_codec_unsupported", "audio codec"),
                ("media.audio_sample_rate_mismatch", "sample rate"),
                ("media.audio_channels_mismatch", "channel count"),
            ] {
                out.not_run(
                    code,
                    subject.clone(),
                    &format!("Required audio {label} probe fact is missing."),
                    "Adapter must supply actual required audio probe properties.",
                );
            }
        }
        out.not_run(
            "audio.clipping_unchecked",
            subject.clone(),
            "Audio clipping result is missing.",
            "Adapter must run deterministic audio clipping analysis.",
        );
        out.not_run(
            "audio.stream_unchecked",
            subject,
            "Audio stream probe facts are missing.",
            "Adapter must probe actual audio stream presence.",
        );
    }
}

fn check_string(
    code: &str,
    actual: Option<&str>,
    expected: Option<&str>,
    asset: &AssetRef,
    label: &str,
    out: &mut Emitter<'_>,
) {
    let subject = Some(asset_subject(asset));
    let (Some(actual), Some(expected)) = (actual, expected) else {
        out.not_run(
            code,
            subject,
            &format!("Required {label} probe or profile requirement is missing."),
            "Adapter must supply probe facts and resolve the configured profile requirement.",
        );
        return;
    };
    if actual.eq_ignore_ascii_case(expected) {
        out.passed(
            code,
            FindingSeverity::Info,
            subject,
            &format!("Probed {label} matches the output profile."),
        );
    } else {
        out.failed(
            code,
            FindingSeverity::Blocker,
            subject,
            &format!("Probed {label} does not match the output profile."),
            Some(expected.into()),
            Some(actual.into()),
            "Use media encoded with the exact installed output profile.",
        );
    }
}
fn check_u32(
    code: &str,
    actual: Option<u32>,
    expected: Option<u32>,
    asset: &AssetRef,
    label: &str,
    out: &mut Emitter<'_>,
) {
    let subject = Some(asset_subject(asset));
    let (Some(actual), Some(expected)) = (actual, expected) else {
        out.not_run(
            code,
            subject,
            &format!("Required {label} probe or profile requirement is missing."),
            "Adapter must supply probe facts and resolve the configured profile requirement.",
        );
        return;
    };
    if actual == expected {
        out.passed(
            code,
            FindingSeverity::Info,
            subject,
            &format!("Probed {label} matches the output profile."),
        );
    } else {
        out.failed(
            code,
            FindingSeverity::Blocker,
            subject,
            &format!("Probed {label} does not match the output profile."),
            Some(expected.to_string()),
            Some(actual.to_string()),
            "Use media encoded with the exact installed output profile.",
        );
    }
}
fn check_u16(
    code: &str,
    actual: Option<u16>,
    expected: Option<u16>,
    asset: &AssetRef,
    label: &str,
    out: &mut Emitter<'_>,
) {
    let subject = Some(asset_subject(asset));
    let (Some(actual), Some(expected)) = (actual, expected) else {
        out.not_run(
            code,
            subject,
            &format!("Required {label} probe or profile requirement is missing."),
            "Adapter must supply probe facts and resolve the configured profile requirement.",
        );
        return;
    };
    if actual == expected {
        out.passed(
            code,
            FindingSeverity::Info,
            subject,
            &format!("Probed {label} matches the output profile."),
        );
    } else {
        out.failed(
            code,
            FindingSeverity::Blocker,
            subject,
            &format!("Probed {label} does not match the output profile."),
            Some(expected.to_string()),
            Some(actual.to_string()),
            "Use media encoded with the exact installed output profile.",
        );
    }
}

fn evaluate_rights(
    asset: &AssetRef,
    status: Option<&AssetRightsStatus>,
    preview_only: bool,
    out: &mut Emitter<'_>,
) {
    let subject = Some(asset_subject(asset));
    match status {
        Some(AssetRightsStatus::Approved) => out.passed("rights.source_approved", FindingSeverity::Info, subject,
            "Current source rights status is approved."),
        Some(AssetRightsStatus::InternalReviewOnly) if preview_only => out.failed("rights.internal_review_only", FindingSeverity::Warning, subject,
            "Asset is restricted to private internal review; this is not rights clearance or public-release approval.",
            Some("preview-only internal review".into()), Some("internal_review_only".into()),
            "Keep this export on the installed preview profile and complete rights review before any publication."),
        Some(AssetRightsStatus::InternalReviewOnly) => out.failed("rights.internal_review_export_blocked", FindingSeverity::Blocker, subject,
            "Internal-review-only media cannot be used with a non-preview profile.", Some("preview-only profile".into()), Some("non-preview profile".into()),
            "Use the installed preview profile or obtain authorized rights clearance."),
        Some(AssetRightsStatus::Blocked) => out.failed("rights.source_blocked", FindingSeverity::Blocker, subject,
            "Source rights are blocked.", Some("approved".into()), Some("blocked".into()),
            "Resolve rights through the authorized rights-review process; a caller boolean is not authoritative."),
        Some(AssetRightsStatus::PurgeRequired) => out.failed("rights.purge_required", FindingSeverity::Blocker, subject,
            "Source is marked for purge and cannot be used.", Some("approved and retained".into()), Some("purge_required".into()),
            "Remove this source and selected asset from the timeline, then rebuild QA."),
        Some(AssetRightsStatus::Unreviewed) => out.failed("rights.review_required", FindingSeverity::Blocker, subject,
            "Source rights have not been reviewed.", Some("approved".into()), Some("unreviewed".into()),
            "Complete the required rights, license, attribution, and permission review."),
        None => out.not_run("rights.status_unchecked", subject, "Current source rights status is missing.",
            "Adapter must resolve rights status, license, attribution, remote/provider approval, and voice permissions where applicable."),
    }
}

fn emit_missing_asset_checks(asset: &AssetRef, role: AssetRole, out: &mut Emitter<'_>) {
    let subject = Some(asset_subject(asset));
    for (code, message, adapter) in [
        (
            "asset.path_unchecked",
            "Managed path confinement could not be checked.",
            "Adapter must resolve under the managed root and verify symlink confinement.",
        ),
        (
            "asset.hash_unverified",
            "Actual/expected hash comparison could not be checked.",
            "Adapter must hash exact bytes and resolve the pinned expected hash.",
        ),
        (
            "asset.decode_unchecked",
            "Container decode check did not run.",
            "Adapter must decode the exact media asset.",
        ),
        (
            "production.asset_lineage_unchecked",
            "Exact source lineage could not be checked.",
            "Adapter must verify asset lineage and graph ownership.",
        ),
    ] {
        out.not_run(code, subject.clone(), message, adapter);
    }
    match role {
        AssetRole::Video => {
            for (code, message) in [
                (
                    "media.probe_unavailable",
                    "Required video probe facts are unavailable.",
                ),
                ("media.codec_unsupported", "Video codec is not probed."),
                ("media.dimensions_mismatch", "Dimensions are not probed."),
                ("media.fps_unchecked", "Frame rate is not probed."),
                ("media.duration_unchecked", "Duration is not probed."),
            ] {
                out.not_run(
                    code,
                    subject.clone(),
                    message,
                    "Adapter must probe actual selected media streams.",
                );
            }
        }
        AssetRole::Audio => {
            for (code, message) in [
                (
                    "media.probe_unavailable",
                    "Required audio probe facts are unavailable.",
                ),
                (
                    "audio.clipping_unchecked",
                    "Audio clipping result is unavailable.",
                ),
                (
                    "audio.stream_unchecked",
                    "Audio stream presence is unavailable.",
                ),
            ] {
                out.not_run(
                    code,
                    subject.clone(),
                    message,
                    "Adapter must probe and analyze the actual selected audio asset.",
                );
            }
        }
    }
}

fn asset_subject(asset: &AssetRef) -> FindingRef {
    FindingRef {
        kind: "asset".into(),
        id: asset.id.clone(),
        revision: Some(asset.revision),
    }
}
fn valid_profile(profile: &OutputProfileRequirements) -> bool {
    profile.width > 0
        && profile.height > 0
        && profile.fps_num > 0
        && profile.fps_den > 0
        && profile.min_duration_ms <= profile.max_duration_ms
        && !profile.required_container.trim().is_empty()
        && !profile.required_video_codec.trim().is_empty()
        && (!profile.audio_required
            || profile
                .required_audio_codec
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty())
                && profile.required_audio_sample_rate.is_some_and(|n| n > 0)
                && profile.required_audio_channels.is_some_and(|n| n > 0))
}
fn summarize(findings: &[QaFinding]) -> CheckSummary {
    let mut summary = CheckSummary::default();
    for finding in findings {
        match finding.state {
            FindingState::Passed => summary.passed += 1,
            FindingState::NotRun => summary.not_run += 1,
            FindingState::Failed if finding.severity == FindingSeverity::Blocker => {
                summary.blockers += 1
            }
            FindingState::Failed if finding.severity == FindingSeverity::Warning => {
                summary.warnings += 1
            }
            FindingState::Failed | FindingState::NotApplicable => (),
        }
    }
    summary
}

#[derive(Serialize)]
struct FingerprintInput<'a> {
    schema_version: &'static str,
    timeline: &'a NormalizedTimeline,
    profile: &'a OutputProfileRequirements,
    media: BTreeMap<String, Vec<MediaFingerprint>>,
    rights: &'a BTreeMap<String, AssetRightsStatus>,
    evidence_checks: &'a BTreeMap<String, EvidenceCheck>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
struct MediaFingerprint {
    role: AssetRole,
    path_confined: bool,
    symlink_escape_detected: bool,
    actual_sha256: Option<String>,
    expected_sha256: Option<String>,
    probe: Option<ProbeProperties>,
    decode_result: DecodeResult,
    source_lineage_valid: Option<bool>,
}
/// Hashes semantic inputs using stable struct field order and BTreeMap key order.
/// Raw local path strings are excluded; their confinement verdict is included.
pub fn fingerprint(input: &QaInput) -> String {
    let mut media: BTreeMap<String, Vec<MediaFingerprint>> = BTreeMap::new();
    for facts in &input.media_facts {
        media
            .entry(facts.asset.key())
            .or_default()
            .push(MediaFingerprint {
                role: facts.role,
                path_confined: lexical_path_confined(&facts.resolved_path, &facts.managed_root)
                    && !facts.symlink_escape_detected,
                symlink_escape_detected: facts.symlink_escape_detected,
                actual_sha256: facts.actual_sha256.clone(),
                expected_sha256: facts.expected_sha256.clone(),
                probe: facts.probe.clone(),
                decode_result: facts.decode_result,
                source_lineage_valid: facts.source_lineage_valid,
            });
    }
    for records in media.values_mut() {
        records.sort_by_key(|facts| serde_json::to_string(facts).unwrap_or_default());
    }
    let canonical = FingerprintInput {
        schema_version: QA_SCHEMA_VERSION,
        timeline: &input.timeline,
        profile: &input.profile,
        media,
        rights: &input.rights,
        evidence_checks: &input.evidence_checks,
    };
    let bytes = serde_json::to_vec(&canonical).expect("QA fingerprint structs are serializable");
    format!("sha256:{}", hex(&Sha256::digest(bytes)))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> QaInput {
        let asset = AssetRef {
            id: "render-1".into(),
            revision: 2,
        };
        let profile_ref = VersionedRef {
            id: crate::video_edl::PREVIEW_PROFILE_ID.into(),
            revision: 1,
        };
        let timeline = NormalizedTimeline {
            timeline_ref: VersionedRef {
                id: "timeline-1".into(),
                revision: 3,
            },
            project_ref: VersionedRef {
                id: "project-1".into(),
                revision: 4,
            },
            timeline_hash: "sha256:timeline".into(),
            profile_ref: profile_ref.clone(),
            total_duration_ms: 10_000,
            required_shot_ids: vec!["shot-1".into()],
            video_clips: vec![VideoClip {
                clip_id: "clip-1".into(),
                shot_id: "shot-1".into(),
                asset: asset.clone(),
                expected_sha256: "sha256:bytes".into(),
                start_ms: 0,
                duration_ms: 10_000,
                source_in_ms: 0,
                gap_allowed_before: false,
                overlap_allowed_with_previous: false,
                evidence: vec![EvidenceRef {
                    kind: "claim".into(),
                    id: "claim-1".into(),
                    required: true,
                }],
            }],
            audio_clips: vec![],
            parent_refs_valid: Some(true),
        };
        let profile = OutputProfileRequirements {
            profile_ref,
            available: true,
            required_container: "mp4".into(),
            required_video_codec: "h264".into(),
            width: 1280,
            height: 720,
            fps_num: 30,
            fps_den: 1,
            min_duration_ms: 1,
            max_duration_ms: 30_000,
            audio_required: false,
            required_audio_codec: None,
            required_audio_sample_rate: None,
            required_audio_channels: None,
        };
        let probe = ProbeProperties {
            container: Some("mp4".into()),
            video_codec: Some("h264".into()),
            width: Some(1280),
            height: Some(720),
            fps_num: Some(30),
            fps_den: Some(1),
            duration_ms: Some(10_000),
            has_audio_stream: Some(false),
            audio_codec: None,
            audio_sample_rate: None,
            audio_channels: None,
            audio_clipped: None,
        };
        QaInput {
            timeline,
            media_facts: vec![MediaFacts {
                asset: asset.clone(),
                role: AssetRole::Video,
                resolved_path: "/managed/video/render-1.mp4".into(),
                managed_root: "/managed/video".into(),
                symlink_escape_detected: false,
                actual_sha256: Some("sha256:bytes".into()),
                expected_sha256: Some("sha256:bytes".into()),
                probe: Some(probe),
                decode_result: DecodeResult::Decoded,
                source_lineage_valid: Some(true),
            }],
            rights: BTreeMap::from([(asset.key(), AssetRightsStatus::Approved)]),
            evidence_checks: BTreeMap::from([(
                "claim:claim-1".into(),
                EvidenceCheck {
                    reference_valid: true,
                    span_valid: true,
                    non_claiming_reason: None,
                },
            )]),
            profile,
        }
    }

    #[test]
    fn complete_inputs_allow_and_report_stable_fingerprint() {
        let input = fixture();
        let a = evaluate(&input);
        let b = evaluate(&input);
        assert_eq!(a.decision, QaDecision::Allow);
        assert_eq!(a.execution_state, ExecutionState::Complete);
        assert_eq!(a.input_fingerprint, b.input_fingerprint);
        assert_eq!(a.findings, b.findings);
        assert!(a
            .findings
            .iter()
            .any(|f| f.code == "asset.hash_match" && f.state == FindingState::Passed));
    }

    #[test]
    fn blocking_media_rights_evidence_and_timeline_findings_are_typed() {
        let mut input = fixture();
        input.media_facts[0].resolved_path = "/outside/render-1.mp4".into();
        input.media_facts[0].actual_sha256 = Some("sha256:changed".into());
        input.media_facts[0].decode_result = DecodeResult::Failed;
        input.media_facts[0].probe.as_mut().unwrap().width = Some(640);
        input.media_facts[0].probe.as_mut().unwrap().fps_num = Some(24);
        input
            .rights
            .insert("render-1@2".into(), AssetRightsStatus::Blocked);
        input
            .evidence_checks
            .get_mut("claim:claim-1")
            .unwrap()
            .span_valid = false;
        input.timeline.required_shot_ids.push("shot-missing".into());
        input.timeline.total_duration_ms = 9_999;
        let report = evaluate(&input);
        assert_eq!(report.decision, QaDecision::Block);
        let codes: BTreeSet<_> = report.findings.iter().map(|f| f.code.as_str()).collect();
        for required in [
            "asset.path_escape",
            "asset.hash_mismatch",
            "asset.decode_failed",
            "media.dimensions_mismatch",
            "media.fps_mismatch",
            "rights.source_blocked",
            "evidence.invalid_span",
            "storyboard.shot_unmapped",
            "timeline.duration_mismatch",
        ] {
            assert!(codes.contains(required), "missing {required}");
        }
    }

    #[test]
    fn missing_mandatory_facts_block_instead_of_vacuously_passing() {
        let mut input = fixture();
        input.media_facts.clear();
        input.rights.clear();
        input.evidence_checks.clear();
        let report = evaluate(&input);
        assert_eq!(report.decision, QaDecision::Block);
        assert_eq!(report.execution_state, ExecutionState::Partial);
        assert!(report
            .findings
            .iter()
            .any(|f| f.code == "asset.missing" && f.state == FindingState::Failed));
        assert!(report
            .findings
            .iter()
            .any(|f| f.code == "asset.hash_unverified" && f.state == FindingState::NotRun));
        assert!(report
            .findings
            .iter()
            .any(|f| f.code == "rights.status_unchecked" && f.state == FindingState::NotRun));
        assert!(report
            .findings
            .iter()
            .any(|f| f.code == "evidence.required_check_unavailable"
                && f.state == FindingState::NotRun));
    }

    #[test]
    fn changed_semantic_input_invalidates_fingerprint_but_local_path_does_not_leak() {
        let mut input = fixture();
        let original = fingerprint(&input);
        input.media_facts[0].resolved_path = "/managed/video/renamed-location.mp4".into();
        assert_eq!(
            original,
            fingerprint(&input),
            "fingerprint excludes raw local paths"
        );
        input.media_facts[0].actual_sha256 = Some("sha256:different".into());
        assert_ne!(
            original,
            fingerprint(&input),
            "changed bytes invalidate QA fingerprint"
        );
        input.media_facts[0].resolved_path = "/outside/renamed-location.mp4".into();
        assert_ne!(
            original,
            fingerprint(&input),
            "changed confinement verdict invalidates QA fingerprint"
        );
    }

    #[test]
    fn audio_missing_and_clipping_are_blockers_when_required() {
        let mut input = fixture();
        input.profile.audio_required = true;
        input.profile.required_audio_codec = Some("aac".into());
        input.profile.required_audio_sample_rate = Some(48_000);
        input.profile.required_audio_channels = Some(2);
        let missing = evaluate(&input);
        assert!(missing
            .findings
            .iter()
            .any(|f| f.code == "audio.required_missing" && f.state == FindingState::Failed));
        assert_eq!(missing.decision, QaDecision::Block);

        let asset = AssetRef {
            id: "audio-1".into(),
            revision: 1,
        };
        input.timeline.audio_clips.push(AudioClip {
            clip_id: "audio-clip".into(),
            asset: asset.clone(),
            expected_sha256: "sha256:audio".into(),
            start_ms: 0,
            duration_ms: 10_000,
            source_in_ms: 0,
            evidence: vec![],
        });
        input.media_facts.push(MediaFacts {
            asset: asset.clone(),
            role: AssetRole::Audio,
            resolved_path: "/managed/audio/audio-1.wav".into(),
            managed_root: "/managed/audio".into(),
            symlink_escape_detected: false,
            actual_sha256: Some("sha256:audio".into()),
            expected_sha256: Some("sha256:audio".into()),
            probe: Some(ProbeProperties {
                container: Some("wav".into()),
                video_codec: None,
                width: None,
                height: None,
                fps_num: None,
                fps_den: None,
                duration_ms: Some(10_000),
                has_audio_stream: Some(true),
                audio_codec: Some("aac".into()),
                audio_sample_rate: Some(48_000),
                audio_channels: Some(2),
                audio_clipped: Some(true),
            }),
            decode_result: DecodeResult::Decoded,
            source_lineage_valid: Some(true),
        });
        input
            .rights
            .insert(asset.key(), AssetRightsStatus::Approved);
        let clipped = evaluate(&input);
        assert!(!clipped.findings.iter().any(|finding| {
            finding.code == "media.container_mismatch"
                && finding
                    .subject_ref
                    .as_ref()
                    .is_some_and(|subject| subject.id == "audio-1")
        }));
        assert!(clipped
            .findings
            .iter()
            .any(|f| f.code == "audio.clipped" && f.state == FindingState::Failed));
        assert_eq!(clipped.decision, QaDecision::Block);
    }

    #[test]
    fn internal_review_only_warns_for_preview_and_blocks_other_profiles() {
        let mut input = fixture();
        let asset = input.timeline.video_clips[0].asset.clone();
        input
            .rights
            .insert(asset.key(), AssetRightsStatus::InternalReviewOnly);

        let preview = evaluate(&input);
        assert_eq!(preview.decision, QaDecision::AllowWithWarnings);
        assert!(preview.findings.iter().any(|finding| {
            finding.code == "rights.internal_review_only"
                && finding.severity == FindingSeverity::Warning
                && finding.state == FindingState::Failed
        }));

        input.profile.profile_ref.id = "non-preview-profile".into();
        input.timeline.profile_ref.id = "non-preview-profile".into();
        let non_preview = evaluate(&input);
        assert_eq!(non_preview.decision, QaDecision::Block);
        assert!(non_preview.findings.iter().any(|finding| {
            finding.code == "rights.internal_review_export_blocked"
                && finding.severity == FindingSeverity::Blocker
        }));
    }
}
