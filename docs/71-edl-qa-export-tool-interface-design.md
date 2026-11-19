# 71 — EDL, QA evaluation and export tool interface design

**Status:** Proposed interface and implementation design, 2026-11-19. This extends the public external-agent contract in [doc 70](70-external-agent-tool-and-skill-contract.md) and is grounded in the current NIP/Video records. It describes interfaces and gates; the evaluator, EDL compiler and general export producer are not implemented yet.

## 1. Decision

Treat the edit decision list (EDL) as Fina's canonical, immutable, revision-pinned **VideoTimeline**, not as an arbitrary FFmpeg command or a renderer-specific scene file. `LinkZag` supports Flash real-time preview capture and Full deterministic shot/segment capture; mode, chart backend and determinism are explicit manifest metadata. The EDL selects and places rendered assets, narration/music/effects and captions; the export worker assembles those selections into an output profile. A separate QA evaluator inspects the exact EDL inputs and the rendered media. Export is permitted only when a current QA report authorizes the same input fingerprint under the selected policy.

The production chain is:

```text
Storyboard + rendered shot assets + audio/caption assets
          │ exact revisions and hashes
          ▼
Timeline/EDL build ──► QA evaluation ──► export preflight ──► FFmpeg export job
          │                    │                                   │
          └──── immutable refs ┴──── QA report ref ───────► Export manifest + output asset + lineage
```

A completed LinkZag render is a rendered input, not a final export. A successful MP4 is a **preview** if the selected profile permits silence; neither render success nor an export manifest alone means narrated, reviewed or publish-ready.

## 2. Current implementation and concrete gaps

The current persistence DTOs are useful foundations but are not yet production interfaces:

- `VideoTimeline` has a flat `clips[]` list with `shot_id`, optional `asset_id`, millisecond start/duration, evidence, project/revision fields and total duration. Store validation checks project/shot ownership, positive lengths, order/no overlap and duration consistency, but not complete storyboard coverage, unintended gaps, renderability, per-track relations or media-byte integrity.
- `VideoQaReport` stores project/input revision, `passed | warning | blocked`, findings, and creation time. Persistence checks report/status/finding consistency and evidence ID existence. It does not run checks or pin the exact timeline, asset bytes, policy, evaluator version or input hashes. A caller can currently submit a structurally consistent `passed` report through `save_video_qa_report`.
- `VideoExportManifest` stores a project/storyboard/export kind, file metadata, IDs and evidence. Persistence checks basic required fields but does not produce files, probe them, validate paths/hashes or prove that referenced inputs exist. The LinkZag worker currently writes an untyped job `output_manifest` and a `VideoAsset`; it does not create a verified final export manifest.
- `VideoAudioCue` is a separate immutable, revisioned narration/audio record. It pins exact project, episode, storyboard, optional scene, and registered audio asset refs; retains the exact source script and SHA-256, voice/provider/production metadata, measured duration/sample/channel facts, and evidence refs. A cue with no scene ref covers the whole storyboard (the current pilot's one 52.6-second narration file); it does not invent word-level or per-scene timings.
- MCP exposes `save/get/list_video_timeline`, `save/get/list_video_qa_report`, and `save/get/list_video_export_manifest`; there is no EDL builder, QA evaluator, export preflight or general FFmpeg export producer. These save operations persist records, not completed pipeline work.

The current direct `save_*` mutation tools should be treated as internal persistence primitives. The external-agent facade must not let a caller assert QA success or mint a successful export manifest.

## 3. Shared interface conventions

### 3.1 Immutable references and fingerprints

Use:

```ts
type Ref = { id: string; revision: number };
type Hash = `sha256:${string}`;
type FindingRef = { kind: string; id: string; revision?: number };
```

Every tool consumes exact revisions. The compiled EDL records project, episode, storyboard, scene/shot, VisualSpec, rendered asset, audio/caption asset and evidence refs that it actually used. For each media input it pins the byte hash verified by the worker. Compute `timeline_hash` and `input_fingerprint` from canonical JSON with stable key order and without timestamps, progress or local paths. The fingerprint includes profile ID+revision, EDL schema/compiler version, source refs and their hashes. Preserve event/claim evidence as typed refs with offsets; do not copy canonical transcript truth into Video.

A changed storyboard, selected asset, evidence ref, profile revision or input hash means a new EDL revision and new QA run. Old reports/manifests remain readable as history; they never silently authorize new inputs.

### 3.2 Time and paths

The EDL's sequence has a rational frame rate `{num, den}`. Video placement uses integer frame indices and half-open intervals `[start_frame, end_frame)`, with `duration_frames = end_frame - start_frame`. Audio source trims use integer sample indices plus the input sample rate; caption cues use frame boundaries. Conversion/quantization is explicit and reported, never implicit floating-point arithmetic. Use checked integer math for all additions/conversions.

Tool arguments accept asset IDs/revisions and profile IDs, never arbitrary filesystem paths, URLs, FFmpeg flags or shell fragments. The owned worker resolves assets inside the managed media root, rejects traversal and symlink escapes, probes actual bytes and writes into a job-owned temporary directory before atomic registration.

## 4. Native EDL schema

### 4.1 `fina.edl.v1`

```ts
type EDLManifestV1 = {
  schema_version: "fina.edl.v1";
  project_ref: Ref;
  episode_ref: Ref;
  storyboard_ref: Ref;
  output_profile_ref: { id: string; revision: number };
  sequence: {
    width: number; height: number;
    frame_rate: { num: number; den: number };
    pixel_aspect_ratio: { num: number; den: number };
    audio_sample_rate: number;
    total_frames: number;
  };
  video_tracks: Array<{
    track_id: string; ordinal: number;
    clips: Array<{
      clip_id: string;
      shot_ref: Ref;
      visual_spec_ref?: Ref;
      asset_ref: Ref;
      verified_sha256: Hash;
      start_frame: number; duration_frames: number; source_in_frame: number;
      fit: "contain" | "cover";
      transition_after?: {
        kind: "cut" | "crossfade" | "fade_to_black";
        duration_frames: number;
      };
      evidence_refs: FindingRef[];
    }>;
  }>;
  audio_tracks: Array<{
    track_id: string; ordinal: number;
    kind: "narration" | "music" | "effects";
    clips: Array<{
      clip_id: string; cue_ref: Ref; asset_ref: Ref; verified_sha256: Hash;
      start_frame: number; duration_frames: number;
      source_in_sample: number; source_sample_rate: number;
      gain_millidb: number; fade_in_frames: number; fade_out_frames: number;
      evidence_refs: FindingRef[];
    }>;
  }>;
  caption_tracks: Array<{
    track_id: string; language: string;
    format: "webvtt" | "srt";
    delivery: "sidecar" | "burn_in";
    asset_ref: Ref; verified_sha256: Hash;
  }>;
  lineage_refs: FindingRef[];
  timeline_hash: Hash;
};
```

Constraints for V1: at least one video clip; supported track/effect combinations are explicit and capability-gated; unknown filters are rejected. Video clips follow their supplied array/track order, with `start_frame` either explicit or deterministically auto-placed after the previous clip and declared transition. Overlap is allowed only for the matching, explicit transition pair; other overlap is a blocker. Default gap policy is `block`. A filler card, black frame, hold or silence is an explicit clip/decision, not silent implicit behavior. `total_frames` is derived from the maximum half-open clip end. Empty/missing rendered inputs remain compile blockers rather than fabricated success.

A canonical stored timeline adds `{timeline_id, revision, created_at, build_version, build_status, build_findings}` around the EDL body. `build_status` is `ready | blocked`; a blocked candidate may be returned as diagnostics but is not eligible for QA/export. Do not overload the current `input_revision` or `export_revision` fields with new meanings. Keep v1 records readable; create the next coordinated store migration after the current latest migration (currently `0012`) for the typed EDL, hashes, profile refs and normalized/readable history.

### 4.2 EDL build tool

**`fina_video_timeline_build`** compiles and validates an EDL synchronously. It is a deterministic control-plane operation, not a media render job.

Request:

```json
{
  "project_ref": {"id":"project-123","revision":2},
  "episode_ref": {"id":"episode-456","revision":1},
  "storyboard_ref": {"id":"storyboard-789","revision":3},
  "output_profile_id":"mp4-h264-720p30-preview-v1",
  "video_tracks":[{
    "track_id":"V1","ordinal":0,
    "clips":[
      {"shot_ref":{"id":"shot-1","revision":1},"asset_ref":{"id":"asset-1","revision":1},"start_frame":0,"duration_frames":180,"source_in_frame":0,"fit":"contain","transition_after":{"kind":"cut","duration_frames":0}},
      {"shot_ref":{"id":"shot-2","revision":1},"asset_ref":{"id":"asset-2","revision":1},"duration_frames":210,"source_in_frame":0,"fit":"contain"}
    ]
  }],
  "audio_tracks":[],
  "caption_tracks":[],
  "gap_policy":"block",
  "request_id":"req-unique"
}
```

Success/blocked result:

```json
{
  "status":"ready",
  "timeline_ref":{"id":"timeline-abc","revision":1},
  "timeline_hash":"sha256:…",
  "summary":{"video_clips":2,"audio_clips":0,"caption_tracks":0,"total_frames":390,"duration_ms":13000},
  "findings":[],
  "input_fingerprint":"sha256:…"
}
```

A valid request with editorial blockers returns `status:"blocked"`, no exportable `timeline_ref`, plus stable findings and remediation; malformed IDs/schema return a typed error. A `request_id` is idempotent: repeating the same payload returns the same result; changing any input requires a new key. Persist only ready immutable revisions, or persist blocked candidates explicitly as non-exportable drafts—never as ready. `fina_video_timeline_get({timeline_ref})` reads back the exact normalized EDL; `fina_video_timeline_list({project_ref, cursor?, limit?})` returns revision summaries and hashes. Keep any raw `save_video_timeline` endpoint internal or restrict it to non-exportable drafts.

The compiler verifies project/episode/storyboard ownership; exact shot/asset/cue revisions; cue-to-storyboard and cue-to-audio-asset equality; asset-to-shot/VisualSpec relation; dimensions/FPS compatibility; in/out bounds; positive durations; contiguous or explicitly transitioned video coverage; declared audio/caption compatibility; evidence references and required coverage; output-profile limits; deterministic ordering; and source/asset lineage. Cue registration validates the managed relative path shape and a registered SHA-256 metadata value, but does not read media bytes or run ffprobe; actual hash/probe/decode/channel/sample-rate checks remain mandatory QA checks and missing QA facts block QA. It reports—not silently fixes—trimming, frame quantization, omissions, unsupported effects and optional-track absence.

## 5. Deterministic QA interface

### 5.1 Tool request and job semantics

**`fina_video_qa_run`** consumes only a ready `timeline_ref` and a configured `qa_profile_id`. Mandatory check groups cannot be omitted by the caller. QA runs as a durable job because media hashing, decoding and stream probing may be slow; the tool returns a `JobHandle`, and `fina_job_get` exposes the terminal `report_ref`. Repeating the same `request_id` and fingerprints is idempotent.

```json
{
  "timeline_ref":{"id":"timeline-abc","revision":1},
  "qa_profile_id":"commentary-preview-v1",
  "advisory_model_review":false,
  "request_id":"qa-unique"
}
```

`advisory_model_review` is optional and only runs with an available, consented provider. Its unavailable/failed result is reported as `not_run` or `unavailable`; it cannot turn a deterministic blocker into a pass or claim a completed hallucination/brand audit.

### 5.2 QA report contract

```ts
type QaFinding = {
  finding_id: string; code: string;
  severity: "blocker" | "warning" | "info";
  state: "failed" | "passed" | "not_applicable" | "not_run";
  subject_ref?: FindingRef;
  message: string;
  expected?: unknown; actual?: unknown;
  evidence_refs: FindingRef[];
  remediation?: { action: string; tool?: string; arguments_hint?: object };
};
type QaReport = {
  report_ref: Ref; project_ref: Ref; timeline_ref: Ref;
  timeline_hash: Hash; input_fingerprint: Hash;
  qa_profile_ref: Ref; evaluator_version: string;
  run_id: string; execution_state: "complete" | "partial" | "failed";
  decision: "allow" | "allow_with_warnings" | "block";
  check_summary: { passed: number; warnings: number; blockers: number; not_run: number };
  findings: QaFinding[]; created_at: string;
};
```

Finding codes are stable machine interfaces, for example `timeline.gap`, `timeline.unexpected_overlap`, `timeline.duration_mismatch`, `storyboard.shot_unmapped`, `evidence.missing_required_ref`, `evidence.invalid_span`, `rights.source_blocked`, `asset.missing`, `asset.path_escape`, `asset.hash_mismatch`, `asset.decode_failed`, `media.codec_unsupported`, `media.dimensions_mismatch`, `media.duration_short`, `audio.required_missing`, `audio.clipped`, `caption.required_missing`, `caption.out_of_bounds`, `export.profile_unavailable`. Messages may improve, but code/severity semantics are versioned.

### 5.3 Required check groups

1. **Production graph:** every required beat/shot maps to an exact rendered asset or an explicit allowed nonvisual item; parent refs belong to the same project/episode/storyboard; every selected asset is still present and has exact source lineage.
2. **Evidence:** factual narration, quotes and data visuals have valid canonical event/claim refs; offsets are ordered, in bounds and quotes match the retained source; required scene/shot coverage meets the profile threshold. Editorial transitions/backgrounds may be marked non-claiming with a reason.
3. **Rights and policy:** source rights are not blocked/purge-required; required review, asset license and attribution fields are present; remote/provider approvals and voice permissions are valid where applicable. A `rights_confirmed` request boolean is never authoritative.
4. **Media integrity:** actual bytes exist under managed root; no traversal/symlink escape; SHA-256 matches; container decodes; actual MIME/container and streams match metadata; dimensions, frame rate, pixel format, duration and size satisfy the profile.
5. **Timeline:** frame arithmetic is safe; no unapproved gap/overlap; explicit transitions are in bounds; clips fit source duration; total frames match the sequence; A/V trims and subtitle cues remain in bounds.
6. **Audio/captions:** profile-specific required tracks exist; narration is not truncated; durations align within configured tolerance; codec/sample rate/channels/loudness/clipping checks are reported; caption language/timing/text policy is met. If no audio is allowed for a silent preview, the result remains visibly `preview_only`.
7. **Output validation:** after export, run ffprobe and re-hash the actual output; confirm format, streams, duration, dimensions and manifest values agree. This post-export validation is mandatory before the manifest becomes `succeeded`.

Every required check must finish as passed or a profile-authorized warning. A required check that is `not_run` yields `decision:"block"`, not a vacuous pass. Deterministic checks produce blockers/warnings; model-based checks are clearly advisory.

`fina_video_qa_get({report_ref})` reads the immutable report. The external facade does not expose a write tool for a caller-provided `passed` status. The existing store save primitive is evaluator-only; human review/waiver, if later supported, must be a separate authenticated audit record and cannot delete or downgrade a hard safety/rights blocker.

## 6. Export profile, preflight and production

### 6.1 Profiles

Expose **`fina_video_export_profiles_list({purpose?, limit?})`** so an agent chooses an installed, policy-allowlisted profile rather than inventing FFmpeg arguments. Each profile reports a revision, purpose (`preview | review | master`), container, video/audio codec, dimensions, rational FPS, audio/caption policies, max duration/size, deterministic/toolchain requirements, locality, capability state and blockers.

Examples:

- `mp4-h264-720p30-preview-v1`: silent permitted, stamped `preview_only`, no publishing claims.
- `mp4-h264-1080p30-commentary-v1`: AAC narration required; configured caption policy; warning allowance explicitly defined.
- Any profile unavailable on this host is reported unavailable; no silent substitution to another profile/provider.

### 6.2 Export preflight

**`fina_video_export_preflight`** is read-only and may be called before start:

```json
{
  "timeline_ref":{"id":"timeline-abc","revision":1},
  "qa_report_ref":{"id":"qa-123","revision":1},
  "export_profile_id":"mp4-h264-720p30-preview-v1"
}
```

It returns `{decision: allow | allow_with_warnings | block, blockers[], warnings[], input_fingerprint, estimated_bytes?, resource_estimate?, capability_state}`. It checks exact equality of timeline hash/fingerprint/profile and the QA report; report decision/profile policy; fresh input byte hashes and rights state; required audio/captions; available encoder/resource limits; and managed output capacity. It performs no render/export and does not reserve paid/remote work. `export_start` repeats all authoritative checks to close the time-of-check/time-of-use gap.

### 6.3 Export job and verified manifest

**`fina_video_export_start`** accepts only exact timeline, QA and profile refs plus idempotency key:

```json
{
  "timeline_ref":{"id":"timeline-abc","revision":1},
  "qa_report_ref":{"id":"qa-123","revision":1},
  "export_profile_id":"mp4-h264-720p30-preview-v1",
  "request_id":"export-unique"
}
```

If preflight blocks, return a structured `blocked_by_qa`, `stale_qa_report`, `input_changed`, `rights_blocked`, `profile_unavailable` or `resource_limit` error with findings; do not create a running job. Otherwise return a durable `JobHandle` for `video.export.ffmpeg`. `fina_job_get` status contains safe progress, current step and, at success, an `export_manifest_ref` and output asset ref. Cancel/retry follow the shared job protocol; retry creates a new attempt and never mutates an already succeeded manifest.

The exporter invokes FFmpeg with typed, generated argv (never a shell string), resolves only verified managed asset paths, and writes to a job-owned temp output. At completion it checks ffprobe/probe constraints and SHA-256, atomically moves the file into managed media storage, then commits the output `VideoAsset`, typed `VideoExportManifest`, QA/timeline references and full lineage. If the database commit fails, delete the just-written artifact or mark it for orphan cleanup; partial/cancelled files are never exposed as final outputs.

Extend the export manifest to include:

```ts
type ExportManifestV1 = {
  manifest_ref: Ref; state: "succeeded";
  project_ref: Ref; episode_ref: Ref;
  timeline_ref: Ref; timeline_hash: Hash;
  qa_report_ref: Ref; qa_input_fingerprint: Hash;
  export_profile_ref: Ref; input_fingerprint: Hash;
  output_asset_ref: Ref; output_sha256: Hash;
  probe: { container: string; video_codec: string; audio_codec?: string;
    width: number; height: number; frame_rate: {num:number;den:number};
    duration_ms: number; byte_size: number; has_audio: boolean; has_captions: boolean };
  files: Array<{ kind: "master" | "caption_sidecar"; asset_ref: Ref; sha256: Hash }>;
  toolchain: { ffmpeg_version: string; ffprobe_version: string; compiler_version: string };
  deterministic: boolean; preview_only: boolean;
  lineage_refs: FindingRef[]; created_at: string;
};
```

No manifest is `succeeded` until the file exists, actual hash/probe have passed and lineage registration commits. Manifest read/list tools are `fina_video_export_get({manifest_ref})` and `fina_video_export_list({project_ref, cursor?, limit?})`; media bytes use an authorized short-lived handle, never a raw host path. The manifest is proof of a completed export—not a publish action.

## 7. Pipeline state and policy rules

1. Agent calls `fina_video_export_profiles_list` and reads exact storyboard, shot and rendered asset revisions.
2. `fina_video_timeline_build` validates and persists a ready immutable EDL (or returns blockers).
3. `fina_video_qa_run` executes mandatory deterministic checks; agent polls until the report is terminal.
4. If blocked, the agent uses finding remediation to revise the storyboard/assets/EDL and obtains a new timeline hash and QA report. No user-edited JSON can mark findings passed.
5. `fina_video_export_preflight` gives a clear dry-run explanation; `fina_video_export_start` repeats checks and begins the local export job only if policy permits.
6. Agent polls; only a succeeded job with export manifest ref is complete. It reads back manifest, asset, probe and transitive lineage, then reports audio presence and preview/review/master status truthfully.

`allow_with_warnings` is profile-dependent. An informational/advisory warning may pass a preview profile if the policy says so; any blocker always blocks. A silent preview profile is allowed to contain no audio but the output is marked `preview_only`; a commentary profile that requires narration/captions rejects silence. Exporting is not publishing; public distribution remains a separate permissioned operation.

## 8. Stable errors and failure behavior

Return safe typed errors: `invalid_argument`, `not_found`, `revision_conflict`, `cross_project_reference`, `unsupported_profile`, `dependency_missing`, `timeline_invalid`, `input_changed`, `stale_qa_report`, `blocked_by_qa`, `rights_blocked`, `consent_required`, `path_rejected`, `media_integrity_failed`, `capability_unavailable`, `resource_limit`, `job_cancelled`, `export_failed`, `storage_unavailable`.

Failures must identify the stable finding/error code and actionable repair without returning credentials or arbitrary paths. `failed`, `cancelled`, `interrupted` and `blocked` remain distinct durable states. A failure never leaves a false success manifest or deletes a prior successful export. The same request ID/payload returns the same job; a retry gets a new attempt ID and an auditable `retry_of` ref.

## 9. Acceptance tests required before calling the production path complete

### EDL and transport

- MCP schema rejects unknown fields, arbitrary paths, shell arguments and non-positive/overflowing timings.
- Valid storyboard + rendered assets compiles to a stable EDL hash and deterministic ordered tracks; identical inputs reproduce the same hash.
- Cross-project, stale shot/asset, missing output, unsupported transition, out-of-bounds trims, unapproved overlap/gap and mismatched profile/FPS fail with stable blockers.
- Readback returns the same EDL hash/revisions; new edits create a higher immutable revision; old EDL remains readable.
- Audio/caption track and sidecar/burn-in policy are explicit; a silent preview and a narration-required profile produce different truthful results.

### QA

- Fixture tests for missing media, corrupt container, altered bytes/hash, path traversal/symlink escape, wrong codec/dimensions/FPS/duration, timeline gap/overlap, missing/invalid evidence span, blocked source rights, missing required narration/captions, clipping and caption out-of-bounds.
- Verify severity/status consistency, every required check completed, deterministic finding IDs/codes, evaluator version and complete input fingerprint.
- A caller cannot save or forge `passed`; contradictory status/finding sets are rejected.
- Any changed timeline, asset hash, profile or required evidence makes the old QA report unusable for export.
- Advisory model checks unavailable/failed are reported as such and never masquerade as passed.

### Export and end-to-end

- QA blocker prevents job creation; stale report/profile/hash blocks; eligible warning behavior follows profile.
- Export worker command is shell-free and confined to managed paths; FFmpeg timeout/failure/cancel/restart cleans partials and records accurate job state.
- Fixture export verifies actual bytes/hash, ffprobe/container/video/audio/caption fields, duration/frame count, output asset, manifest and source→claim→storyboard→shot→rendered asset→EDL→QA→export lineage.
- Manifest is written only after output validation and atomic registration. Manifest probe/hash must exactly match independent ffprobe/SHA-256.
- Retry does not mutate an earlier manifest; idempotent duplicate start does not create a second output.
- Playwright external-agent journey completes only with `export_ready` when profile gates pass. Silent fixture profile returns `preview_ready`; required-narration profile blocks until audio/captions exist.

The current preview EDL compiler accepts an exact registered `internal_review_only` license state for private review only and emits `rights.internal_review_only`; `approved` is also accepted. `fixture_only`, unknown, blocked, purge-required, unreviewed, empty, and other states remain build blockers. This is not rights clearance: QA semantics are unchanged, so missing/unreviewed rights and missing actual media checks still block QA. The new suite should extend `playwright/external-agent-commentary-e2e.spec.ts`; retain the current silent LinkZag preview assertion as a separate earlier stage, then add EDL→QA→preflight→export and the listed negative gates.

## 10. Implementation sequence

**P0 — contract and trust.** Add typed Rust DTOs and JSON Schema tests; restrict direct save QA/export tools to internal persistence; define profile registry and stable finding/error codes. Keep current v1 records readable.

**P1 — EDL compiler.** Add a versioned timeline schema and coordinated store migration; implement pure compile/validation, canonical hashing, exact revision/ownership/evidence checks, timeline get/list readback and deterministic fixture tests. Do not invoke FFmpeg from the MCP request thread.

**P2 — deterministic QA.** Implement mandatory metadata/evidence/path/hash/ffprobe/timing/rights checks as a durable job. Persist evaluator-created reports with exact fingerprints; add changed-input/stale-report tests.

**P3 — general exporter.** Implement profile-gated FFmpeg assembly, temp-path confinement, atomic output/manifest/asset/lineage registration, cancellation/cleanup/retry and output verification.

**P4 — external-agent completion.** Extend the MCP E2E to test successful preview and narrated profiles, blocker remediation, stale QA, negative media/path gates, output hash/probe and end-to-end evidence lineage. Update capabilities only after each operation has a real executable path and tests.
