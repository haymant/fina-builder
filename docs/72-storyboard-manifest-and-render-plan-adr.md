# 72 — Native storyboard manifest and render-plan boundary

**Status:** Proposed decision (contract decision; implementation is partial/pending), 2026-11-19. This ADR freezes the intended artifact boundary and schemas, not a claim that those schemas or end-to-end tools are implemented. Existing DTOs and the in-progress EDL implementation are described separately below.

## Context

Fina’s storyboard must be a **strict functional superset of a simple ordered slide list**: it is an editable, evidence-first directing and production-coordination manifest for beats, scenes, shots, visual intent, narration, audio, captions, timing, disclosures, and asset/provider needs. It is not a list of slide renderings, a renderer-specific scene file, or a final video model. There is no requirement to preserve or interoperate with Rehab Video Maker; it is decommissioned and is not a compatibility target.

The intended artifact chain is:

```text
NIP evidence snapshot → Narrative → StoryboardManifest → RenderPlan
                                                  → rendered/generated assets
                                                  → VideoTimeline / EDL (doc 71)
                                                  → QA → export
```

The distinction matters: the manifest is the editable editorial source; the render plan is a pinned, deterministic compilation of required per-shot/per-cue work; the EDL is the downstream exact placement and assembly contract once outputs exist. The RenderPlan must not duplicate EDL tracks, trims, frame placements, transitions, or export settings.

**Current state, not target state:** Rust `VideoStoryboard` is a revisioned metadata record (`storyboard_id`, `narrative_id`, `schema_version`, review status), while scenes, shots, evidence, audio cues, and visual specs are separate records with incomplete cross-links. UI `VideoStoryboardDocument` uses `fina-slides-v1` with ordered `slides[]` bundling one scene, shot(s), audio cue, visual spec, and evidence; the browser builder currently creates a deterministic three-beat candidate. It is a UI/export projection, not the canonical full manifest. Current Rust `VideoTimeline` is a flat millisecond clip DTO. The repository also contains in-progress Rust `fina.edl.v1` compiler/store code based on doc 71; this ADR does not replace or restate that schema. Neither the new native manifest nor a persisted compiled RenderPlan/readback workflow is established by the legacy DTOs.

## Decision

1. Adopt backend-owned, versioned `StoryboardManifest` and `RenderPlan` records as distinct artifacts. Persist the full manifest at an exact storyboard revision; keep scene/shot/audio/visual/asset records as first-class revisioned records and refer to them, rather than requiring a one-slide/one-scene/one-shot shape.
2. Treat `fina-slides-v1` as a lossy presentation/export projection only, if retained. It is never the final video model, canonical persisted manifest, or render-plan input. No Rehab schema import/export, adapter, round-trip, or runtime dependency is planned.
3. Compile a manifest revision and exact dependency revisions through a deterministic compiler into a pinned RenderPlan. The plan describes render/generation requests and dependencies, not final edit placement. LinkZag defaults to Flash real-time preview capture and offers Full deterministic screenshot capture; manifests record capture mode, chart backend and determinism. Capability-specific providers handle only explicitly configured still/video/TTS/music work. Assets and jobs retain lineage to plan, manifest, beat/scene/shot/cue, and evidence.
4. Keep `VideoTimeline`/EDL downstream and use doc 71’s `fina.edl.v1`, frame/sample-based timing, profile, fingerprint, QA, and export boundaries. Do not introduce a competing EDL schema in this ADR. The present flat `VideoTimeline` DTO remains legacy; migration/read compatibility is a separate implementation concern.
5. Store and expose these artifacts only through typed, authorized Fina domain APIs/tools. The agent/UI may propose editorial content, but cannot write storage tables, claim capability readiness, or bypass validators. Missing providers remain visible as blockers/unavailable states; no silent provider substitution.

## Contract sketches (proposed)

These TypeScript-like definitions are normative in semantics, illustrative in exact language mapping. `Ref` is `{ id: string; revision: number }`, matching docs 70–71. Unknown fields are rejected at public mutation boundaries. Persist canonical JSON/hash after normalization; never trust client-supplied hashes.

```ts
type Ref = { id: string; revision: number };
type EvidenceRef = {
  kind: "event" | "claim" | "entity" | "projection";
  id: string;
  revision?: number;
  span?: {
    representation: string; // stable normalized source-text version
    unit: "utf8_byte";
    start: number; end: number; // half-open [start,end)
  };
  quote_hash?: `sha256:${string}`;
};
type TimedHint = { duration_ms?: number; start_ms?: number };
type VisualSpecRef = Ref;

type StoryboardManifest = {
  schema_version: "fina.storyboard.v1";
  title: string;
  language: string;
  project_ref: Ref;
  episode_ref: Ref;
  narrative_ref: Ref;
  evidence_snapshot: { as_of: string; refs: EvidenceRef[]; coverage_ref?: Ref };
  creative_brief: {
    audience?: string; purpose?: string; thesis: string; tone?: string;
    disclosure_refs: Ref[];
  };
  render_profile_ref: Ref; // visual-render profile, not the EDL export profile
  beats: Array<{
    beat_id: string;
    ordinal: number;
    kind: "hook" | "context" | "claim" | "analysis" | "quote" |
          "chart" | "diagram" | "broll" | "transition" | "close";
    narration?: { text: string; language: string; evidence_refs: EvidenceRef[] };
    on_screen?: { heading?: string; subtitle?: string; bullets?: string[];
                  quote?: string; attribution?: string; source_label?: string };
    evidence_refs: EvidenceRef[];
    visual_intent: {
      spec_type: string; payload_ref?: VisualSpecRef;
      motion: "static" | "animated" | "auto";
      fallback: "card" | "still" | "blocked";
    };
    scene_refs: Ref[]; shot_refs: Ref[]; audio_cue_refs: Ref[];
    caption_cue_refs: Ref[];
    transition?: { kind: string; duration_ms?: number };
    timing: TimedHint;
    review_state: "draft" | "needs_review" | "approved" | "rejected";
  }>;
  asset_requirements: Array<{
    requirement_id: string; shot_ref: Ref; capability: string;
    provider_policy: "deterministic_first" | "configured_local" |
                    "approved_profile_only" | "none";
    provider_profile_ref?: Ref; rights_profile_ref?: Ref;
    required: boolean;
  }>;
  audio_plan: {
    cue_refs: Ref[]; music_policy: "none" | "optional" | "required";
    caption_tracks: Array<{ language: string; required: boolean }>;
  };
  policy: { max_animated_shots: number; missing_capability: "block" | "declared_fallback" };
};
```

A manifest envelope is `{storyboard_id, revision, manifest, manifest_hash, review_status, created_at, created_by}`. Scene/shot refs and evidence are revision-pinned. Quotes are verified against the referenced event span; transcript text is not copied wholesale into the manifest. Every factual narration statement, quote, and data-driven visual must carry evidence at the narrowest practical beat/scene/shot/cue scope. Analysis or transition content may be explicitly labeled non-claiming; inheritance from a beat is not a substitute for storing/checking required shot-level lineage. Entity and projection refs are additive, not replacements for canonical source evidence.

Timing in the manifest is integer **milliseconds** for editorial hints, cue intent, and measured media metadata. Hints are not exact frame placement. The RenderPlan pins a rational frame rate/profile and records deterministic quantization from ms to renderer frames where necessary; conversions use checked integer/rational arithmetic and report rounding. Audio source trims/durations, once measured, record integer samples and their sample rate. Caption cue boundaries use frame indices. Exact assembled placement belongs only to the doc 71 EDL (`[start_frame,end_frame)`, audio sample trims).

```ts
type RenderPlan = {
  schema_version: "fina.render-plan.v1";
  plan_id: string; revision: number;
  project_ref: Ref; episode_ref: Ref; narrative_ref: Ref;
  storyboard_ref: Ref; storyboard_hash: `sha256:${string}`;
  render_profile_ref: Ref; compiler_version: string;
  capability_snapshot: Array<{
    capability: string; state: "ready" | "blocked" | "unavailable" |
            "not_configured" | "degraded";
    provider_profile_ref?: Ref;
  }>;
  steps: Array<{
    step_id: string; ordinal: number;
    kind: "linkzag_render" | "asset_generation" | "audio_generation" |
          "caption_build";
    beat_id?: string; scene_ref?: Ref; shot_ref?: Ref; cue_ref?: Ref;
    visual_spec_refs: Ref[]; input_asset_refs: Ref[];
    evidence_refs: EvidenceRef[];
    capability: string; provider_profile_ref?: Ref;
    output_contract: { asset_kind: string; mime_types: string[];
                      width?: number; height?: number; fps?: { num: number; den: number } };
    depends_on: string[];
  }>;
  dependency_refs: Ref[]; // every consumed scene/shot/spec/cue/profile/input asset revision
  input_fingerprint: `sha256:${string}`;
  plan_hash: `sha256:${string}`;
  status: "ready" | "blocked";
  findings: Array<{ code: string; severity: "blocker" | "warning"; subject_ref?: Ref }>;
};
```

The plan is a recipe/dependency DAG for producing renderable media and captions, not proof those outputs exist. Completed job/output refs are recorded in durable job/asset lineage, not retroactively appended to the immutable plan. The EDL builder then consumes exact rendered asset revisions/hashes plus selected audio/caption assets and the output profile, as defined in doc 71.

## Ordering, revisions, and fingerprints

- `ordinal` is a non-negative, unique, contiguous zero-based position within its parent collection. Serialized arrays are normalized in ordinal order; equal ordinals are invalid, never resolved by arrival order. Child refs within a beat are normalized by ordinal then stable ID/revision. Plan steps use stable topological order: ready steps ordered by `(ordinal, step_id)`; dependencies precede dependants. No map/object iteration or wall-clock timestamp affects order or hash.
- Revisions are append-only. A storyboard edit creates a new revision with optimistic `expected_revision`; old revisions and plans remain readable. Scene/shot/cue/spec/profile refs name exact revisions. Changed source/evidence snapshot, storyboard, dependency, provider/profile revision, compiler version, or normalized payload yields a new fingerprint/plan; it never mutates an earlier plan or its outputs.
- Fingerprint/hash input is canonical normalized JSON with stable key order and exact refs/content hashes, excluding created/updated timestamps, job progress, local paths, and secret values. A provider request identity/configuration revision is pinned, but credentials are not stored. Nondeterministic provider outputs are identified as such; identical plan hash does not promise identical generated bytes.

## Profiles, validation, and failure behavior

A render profile is a configured revisioned capability bundle: supported VisualSpec types, renderer/version, dimensions, rational FPS, motion/resource limits, and any locality/consent constraints. It is distinct from doc 71’s output/export profile. Capability discovery reports `ready`, `blocked`, `unavailable`, `not_configured`, or `degraded` per operation and profile. A profile ID is an allowlisted opaque reference—not a URL, model name, command line, or credential. No automatic local-to-remote fallback is allowed. An explicitly selected fallback is recorded in the manifest/plan and must satisfy evidence, rights, and output requirements.

Validation before save/compile checks schema/version; project/episode/narrative ownership; unique stable IDs and contiguous deterministic ordering; exact revision existence; valid scene→shot→beat/cue links; evidence snapshot membership, span bounds and quote hash; required factual-visual evidence; allowed VisualSpec payload and capability; legal timing/transition hints; profile/rights/consent state; and bounded resource estimates. Compile also verifies all dependencies and outputs are typed and all requested operations are actually available. Validation is deterministic and does not generate media.

Malformed requests return typed errors (`invalid_argument`, `not_found`, `revision_conflict`, `cross_project_reference`). Well-formed editorial/capability failures return blockers and remediation (`evidence.invalid_span`, `dependency_missing`, `capability_unavailable`, `provider_unavailable`, `rights_blocked`, `resource_limit`, `unsupported_visual_spec`); they do not yield an executable ready plan. Save/compile never silently drops a beat, invents evidence/assets, changes providers, or reports success for queued/failed work. A failed, cancelled, or interrupted job remains distinct from a blocked plan; partial outputs are not final assets. Retry creates a new auditable attempt. Repeating an identical mutation with the same request ID is idempotent; changed input requires a new request ID.

## Persistence and tool boundary

**Proposed:** Rust domain DTOs and migrations add a typed manifest body/revision/hash and immutable RenderPlan record/readback. A JSON document may be stored as a typed versioned payload, but the authoritative contract is backend persisted data—not the React object, download file, or database table interface. Preserve legacy project/episode/narrative/scene/shot/visual-spec DTOs during migration; convert old `fina-slides-v1` candidates only through an explicit, versioned one-way projection/import path if needed, never as Rehab compatibility.

Expose versioned save/get/list/validate operations for storyboard revisions and compile/get/list operations for plans. Writes use opaque request IDs and expected revisions; reads select exact revisions and page consistently (docs 70 conventions). Only the domain service validates and writes. The UI and external agents use the same API, may maintain unsaved drafts, and must read persisted revisions back. No direct DuckDB/table writes, provider secrets, arbitrary host paths, FFmpeg fragments, or caller-asserted validation/QA state. Workers receive a `plan_ref`, resolve only managed asset refs, verify content hashes, and create durable jobs/output lineage. The exact EDL/timeline/QA/export tools and contracts remain doc 71’s responsibility.

## Acceptance tests

1. Schema/round-trip fixtures cover hooks, quotes with verified spans, chart/diagram data, b-roll, localization, disclosure, multiple scenes/shots/layers, narration/audio/captions, transitions, and required/optional provider states. A manifest can express more than one slide/scene/shot and more than one visual/audio dependency per beat.
2. Current `fina-slides-v1` fixture remains an explicitly labeled projection; no code path treats it as canonical render input. No Rehab schema or runtime dependency is introduced.
3. Ordering tests reject duplicate/missing ordinals and reproduce identical normalized manifest and plan hashes across process restarts; shuffled insertion/map order has no effect.
4. Negative validation tests cover stale/cross-project refs, missing readback revisions, invalid UTF-8-byte spans/quote hashes, unsupported VisualSpec/provider, absent consent/rights, timing overflow, resource limits, and dangling beat/scene/shot/cue links. Blockers produce no ready executable plan.
5. Revision tests prove optimistic conflict detection, immutable historical reads, changed input/profile/compiler → new plan/hash, and that a later storyboard edit cannot alter an earlier plan or authorize reuse silently.
6. Plan compilation tests assert exact manifest/dependency/profile refs, deterministic topological steps, canonical hash, explicit frame quantization, and truthful capability snapshot. Missing provider does not call a substitute; LinkZag visual output in either capture mode is not labeled generative footage.
7. Tool-boundary tests reject unknown fields, arbitrary paths/secrets/provider endpoints, direct table writes, and fake successful outputs. Idempotent replay does not duplicate plan/job; failed/cancelled/interrupted jobs do not register success assets.
8. E2E reads back the exact storyboard and plan revisions, follows plan→job→asset lineage and then feeds selected verified outputs into doc 71’s EDL/QA/export flow. EDL hashes and frame/sample placement conform to doc 71; the plan contains no duplicate EDL placement. Until that downstream flow is implemented and passes its own gates, the result is a render preview/draft, not export-ready.

## References

- [69 — Agent-native modes and full journey plan](69-agent-native-modes-and-full-journey-plan.md), especially §§3, 5, 7, and P4–P5.
- [70 — External-agent tool and skill contract](70-external-agent-tool-and-skill-contract.md), especially §§4–5, 5.1, and stages E–I.
- [71 — EDL, QA and export tool interface design](71-edl-qa-export-tool-interface-design.md), especially §§3–8; authoritative for the downstream EDL and export contracts.
- Current Rust DTOs: `crates/nip-domain/src/lib.rs` (`VideoStoryboard`, `VideoScene`, `VideoShot`, `VideoVisualSpec`, `VideoAudioCue`, `VideoTimeline`, evidence/asset records); in-progress EDL compiler/store: `crates/nip-engine/src/video_edl.rs` and `crates/nip-store/src/lib.rs`. Native `VideoAudioCue` rows are immutable and revision-pinned; storyboard-wide narration uses one cue with no scene ref, exact registered audio asset ref, retained script/hash and measured audio facts. Actual file-byte hashing and ffprobe remain QA gates.
- Current UI DTOs/builder: `src/features/video/types.ts` (`VideoStoryboardDocument`/`VideoStoryboardSlide`) and `src/features/video/storyboard.ts` (`buildTranscriptStoryboard`).
