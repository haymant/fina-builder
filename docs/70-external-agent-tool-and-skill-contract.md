# 70 — External-agent tool and skill contract

**Status:** Proposed interface contract, 2026-11-19. This document separates current implementation from the proposed production interface. It does not claim that the complete agent journey exists today.

## 1. Goal and product boundary

A Manus-like external agent should be able to complete the same user-visible tasks that Fina Builder provides in its desktop UI, using documented tools rather than browser-only state or direct database access. The agent should be able to start from a prompt, an existing NIP event, an approved podcast source, or an authorized local transcript; research and organize evidence; draft and revise a commentary storyboard; select configured local or remote media providers; render; evaluate QA; assemble an export; and return the final artifact with exact lineage.

The external-agent path is a first-class usage mode and an acceptance test for whether Fina Builder's capabilities are explicit, discoverable, permissioned, resumable, and usable outside the UI. Fina's native storyboard and tools are the contract. Rehab Video Maker is only a functional reference; no schema compatibility is in scope.

The external agent is the **editorial orchestrator**, not the storage engine. It may draft a thesis, script, scene/shot plan, prompts and revisions. Fina owns canonical source/evidence records, provider invocation, validation, immutable revisions, jobs, managed files, QA decisions, export manifests and lineage. External clients never write DuckDB tables, receive model/provider secrets, or submit arbitrary host paths to render workers.

## 2. Current foundation and exposed gap

`crates/nip-engine/src/main.rs` registers a substantial MCP catalog. It serves stdio by default and can serve Streamable HTTP on loopback. NIP tools already cover health/capabilities, source and podcast RSS records, local transcription jobs, canonical event search/read, RIGA-backed claim extraction with consent controls, narrative clusters/graph/signal snapshots, and many Video persistence/render/job operations.

The desktop starts **one** `nip-engine` sidecar against its DuckDB, on an ephemeral loopback port, and the UI/RIGA integration proxies to that owner. Root `.mcp.json` currently contains only `riga-flow` and `tac-engine`; it does not expose NIP/Video to a general external agent. Starting a second engine against the desktop database would violate the single-writer constraint. The sidecar's loopback host checks and the provider bridge token are not a complete external-caller authentication and authorization system.

Video already persists versioned project/episode/narrative/storyboard/scene/shot/asset/job/QA/timeline/export records and can render a bounded ordered list of saved VisualSpec revisions through LinkZag, register the MP4, and link lineage. Its current production path is a short silent MP4, not a complete voiceover/commentary export. Storyboard/scene/shot save tools lack corresponding read/list operations. QA, timeline, and export-manifest save tools persist records; they do not yet run evaluators, build an EDL, or export an assembled video. Comfy is currently wired for optional NIP ASR, not Video image/video/TTS generation.

The interface below therefore marks **Existing**, **Partial**, or **Proposed**. Existing internal MCP names should be retained behind a versioned external facade where practical; proposed names are stable public aliases, not claims that code already implements them.

## 3. Connection and deployment model

Expose one logical MCP server, provisionally named `fina`, with stable tool prefixes `fina_nip_*`, `fina_video_*`, `fina_job_*`, and `fina_media_*`. It may be delivered as one server or as separately permissioned NIP and Video servers, but tool schemas, IDs and job behavior must be consistent.

### Supported connection modes

1. **Standalone owner (CLI/stdio):** a single Fina MCP process owns one configured data directory and DuckDB. It is appropriate for an agent working in a dedicated workspace. The process must refuse a second writer for that database.
2. **Desktop companion (preferred for operating the desktop):** an authenticated host-owned bridge proxies authorized MCP calls to the existing Tauri-owned NIP sidecar. The bridge must not start another NIP engine and must not hand the sidecar's internal token to the model or external client.
3. **Remote agent connection:** use an authenticated connector/session with explicit scopes and an allowlisted data-egress boundary. Never expose the unauthenticated loopback MCP endpoint or ComfyUI endpoint through a tunnel or public port.

A filesystem `.mcp.json` entry is a local development convenience, not the production trust model. In production, pairing/authentication, server identity, caller scopes, revocation, single-writer ownership, data-egress policy and audit identity must be established by the host/connector before tools become available.

### Caller identity and scopes

The host/bridge—not a tool argument—establishes `principal_id`, project grants and scopes. Suggested scopes:

- `nip:read`, `nip:ingest`, `nip:derive`, `nip:review`, `nip:admin`;
- `video:read`, `video:edit`, `video:generate`, `video:render`, `video:export`;
- `media:read`, `media:upload`;
- separately granted `publish:private`, `publish:public` if publishing is implemented.

A caller-supplied `actor` is audit metadata only and never establishes identity. Likewise, `rights_confirmed: true` is not proof of user authorization. Rights review, remote model egress, voice-clone consent, paid generation, destructive removal and public publishing require host-recorded approval/consent IDs or a dedicated confirmation flow.

## 4. Shared tool contract

### 4.1 Request conventions

Every tool uses a strict JSON object schema (`additionalProperties: false` at the public boundary), a documented schema version, bounded input size, and typed response. Mutations accept an opaque `request_id` as an idempotency key. Revisioned writes require `expected_revision`; omit it only for explicitly documented first-create operations. Reads accept an exact `revision` when historical reproducibility matters. Pagination uses opaque `cursor` plus bounded `limit` (default 20, hard maximum 100).

A provider profile is an opaque configured ID, not an arbitrary URL/model name. A tool may expose `provider_profile_id` only from `fina_capabilities_get`; credentials, environment variables, filesystem paths and internal endpoints are never returned.

### 4.2 Success, error and job envelopes

Short synchronous operation:

```json
{
  "ok": true,
  "request_id": "req_…",
  "data": {},
  "warnings": [],
  "lineage_refs": []
}
```

Structured error:

```json
{
  "ok": false,
  "request_id": "req_…",
  "error": {
    "code": "consent_required",
    "message": "Remote claim extraction is blocked until the selected provider is approved.",
    "retryable": false,
    "required_action": "obtain_host_consent"
  }
}
```

Long operation start returns a durable `JobHandle`:

```json
{
  "job_id": "job_…",
  "operation": "video.render.linkzag",
  "state": "queued",
  "submitted_at": "RFC3339",
  "poll_tool": "fina_job_get",
  "cancel_tool": "fina_job_cancel",
  "input_refs": [{"kind": "visual_spec", "id": "…", "revision": 2}]
}
```

`JobState` is `queued | running | succeeded | failed | cancelled | interrupted | blocked`. A later read returns progress, current step, safe error code/message, warnings, `output_refs`, input revisions/hash, provider/model metadata where policy permits, and timestamps. Polling must be bounded with a suggested interval/backoff; agents should not spin.

Common error codes: `invalid_argument`, `not_found`, `revision_conflict`, `idempotency_conflict`, `permission_denied`, `confirmation_required`, `rights_review_required`, `consent_required`, `provider_unavailable`, `capability_unavailable`, `resource_limit`, `blocked_by_qa`, `dependency_missing`, `job_not_cancellable`, `storage_unavailable`, `internal`. Errors must be safe for user display and must not disclose credentials, raw provider response secrets, arbitrary local paths or transcript text beyond the caller's granted scope.

### 4.3 Core reusable types

```ts
type Ref = { id: string; revision: number };
type EvidenceRef = {
  kind: "event" | "claim" | "entity";
  id: string;
  revision?: number;
  start_offset?: number;
  end_offset?: number;
  quote_hash?: string;
};
type Page<T> = { items: T[]; next_cursor: string | null; snapshot_as_of?: string };
type CapabilityState = "ready" | "blocked" | "unavailable" | "not_configured" | "degraded";
type Capability = {
  name: string;
  state: CapabilityState;
  provider_profile_id?: string;
  locality: "local" | "remote" | "mixed" | "none";
  requires_consent: boolean;
  constraints: Record<string, unknown>;
  blockers: { code: string; message: string; action?: string }[];
};
```

Evidence offsets must be defined against a stable normalized transcript representation (Unicode code points or byte offsets—choose one, store the convention and version it). Tool responses include excerpts only when permitted and enough provenance to verify a quote against the retained event.

## 5. End-to-end public tool catalog

This is the proposed complete tool surface for the agent workflow. Internal current names are shown in parentheses where the operation already exists. New public tools should use domain-specific DTOs rather than opaque arbitrary JSON record writes.

### Stage A — discover system, capabilities and constraints

| Public tool | Request → response | Status / guardrail |
|---|---|---|
| `fina_health({})` | `→ {state, api_version, schema_version, owner_mode, database_ready}` | Existing `health`; do not return data paths or secrets. |
| `fina_capabilities_get({scope?: string[]})` | `→ {capabilities: Capability[], as_of}` | Existing `capabilities` is a foundation. Expand to truthful per-operation discovery; it must distinguish installed CLI, configured provider, executable provider and actually tested capability. |
| `fina_resources_get({})` | `→ {cpu, memory, gpu, active_jobs, queue_depth, concurrency_limits, warnings}` | Existing `nip_resource_status` is a foundation; add Video/renderer/resource estimates. |
| `fina_provider_profiles_list({capability?: string})` | `→ Page<{provider_profile_id, capability, state, locality, model_label, consent_state, license_state}>` | Proposed. Never return credentials or raw endpoints. |
| `fina_policy_check({operation, inputs, provider_profile_id?})` | `→ {allowed, blockers[], approvals_required[], data_egress_summary}` | Proposed preflight; authoritative checks still repeat inside each mutation/job. |

### Stage B — source discovery, registration and ingestion

| Public tool | Request | Response / status |
|---|---|---|
| `fina_nip_sources_list` | `{kind?, state?, cursor?, limit?}` | `Page<SourceSummary>`. Existing `list_sources`; only registered source kinds are not proof of a working fetch adapter. |
| `fina_nip_source_register` | `{source_id, kind, display_name, locator, rights_statement, rights_approval_id, topics?, polling?, request_id}` | `{source, subscription?, warnings[]}`. Existing `create_source` and `subscribe_podcast_feed` are foundations; rights approval must be host-recorded, not a caller boolean. |
| `fina_nip_source_update` | `{source_id, expected_revision, patch, request_id}` | `{source}`. Existing `update_source`; preserve immutable/auditable revisions. |
| `fina_nip_source_set_state` | `{source_id, state: active|paused|removed, reason, request_id}` | `{source_id, state}`. Existing `set_source_state`. |
| `fina_nip_podcast_episodes_list` | `{source_id?, title_contains?, published_after?, published_before?, cursor?, limit?}` | `Page<EpisodeCandidate>`. Existing `list_episode_page` and `list_podcast_episodes`. |
| `fina_nip_podcast_feed_refresh` | `{source_id?, request_id}` | `JobHandle` or bounded `RefreshReport`. Existing `refresh_podcast_feeds` is synchronous; move long work to durable jobs. |
| `fina_nip_event_import` | `{source_id, title, text_or_upload_ref, canonical_url?, source_native_id?, published_at?, rights_approval_id, request_id}` | `{event_id, revision, created|deduplicated, content_hash, provenance}`. Existing `import_local_event` handles user-owned local text after rights confirmation; accept an opaque managed upload reference instead of an agent-local path. |
| `fina_nip_event_search` | `{text?, source_id?, as_of?, cursor?, limit?}` | `Page<EventSummary>`. Existing `search_events`. |
| `fina_nip_event_get` | `{event_id, include_text?, text_range?: {start_offset,end_offset}}` | `{event, transcript_segments?, content_hash, rights_state}`. Existing `get_event`; enforce project/source access and bounded excerpts. |

RSS fetch and local import/transcription are implemented paths. Generic web, filings and social kinds are not yet generalized fetch adapters; tools must return `capability_unavailable` rather than pretend otherwise. Source registrations and feed refreshes have external effects and need explicit user authorization.

### Stage C — transcript and claim/evidence creation

| Public tool | Request | Response / status |
|---|---|---|
| `fina_nip_transcription_start` | `{episode_ref: {source_id, source_native_id?, canonical_url?}, policy: publisher_first_local_only, asr_profile_id?, request_id}` | `JobHandle`; existing `start_podcast_transcription` and synchronous `transcribe_podcast_episode` are foundations. No implicit remote-ASR fallback. |
| `fina_job_get` | `{job_id, wait_seconds?: 0..20}` | `JobStatus`; existing `podcast_transcription_status` and `video_job_status` cover different job types. Public facade unifies read shape while preserving type-specific fields. |
| `fina_job_list` | `{kind?, project_id?, source_id?, state?, cursor?, limit?}` | `Page<JobStatus>`. Existing separate list tools cover transcription and Video jobs; add filters/cursors. |
| `fina_job_cancel` | `{job_id, reason?, request_id}` | `{job_id, state, cancellation_requested}`. Existing cancel tools are cooperative; return terminal status accurately. |
| `fina_job_retry` | `{job_id, request_id, overrides?}` | `JobHandle` with `retry_of`. Existing `retry_video_job` covers LinkZag only. |
| `fina_nip_claims_extract` | `{event_id, extraction_profile_id?, schema_version, max_claims?, request_id}` | `JobHandle` then `{run_id, state, claims[], coverage, provider_ref, evidence_warnings[]}`. Existing `extract_claims_from_event` is synchronous RIGA-backed; remote use requires provider/model-bound consent and no silent fallback. |
| `fina_nip_claims_list` | `{event_id?, claim_run_id?, entity_id?, cursor?, limit?}` | `Page<Claim>` with exact evidence refs, attribution, review state and derivation lineage. Existing `list_claims` is unfiltered. |
| `fina_nip_claim_review` | `{claim_id, expected_revision, decision: accept|correct|reject|defer, corrected_text?, evidence_ref?, reason, request_id}` | `{claim, review_audit_ref}`. Proposed; model-generated claims remain candidates until reviewed according to policy. |

`Claim` should be typed (claim kind, speaker/author, assertion text, confidence, polarity/horizon only when justified, evidence spans, extraction run, provider/model/prompt schema and review state). A successful zero-claim run is distinct from an error. Each run reports sampled/completed/omitted transcript coverage so partial extraction cannot look complete.

### Stage D — entities and NIP projections

| Public tool | Request | Response / status |
|---|---|---|
| `fina_nip_entity_mentions_list` | `{event_id?, claim_run_id?, unresolved_only?, cursor?, limit?}` | `Page<EntityMention>`. Proposed; no canonical entity/mention model yet. |
| `fina_nip_entity_resolve` | `{mention_ids[], mode: deterministic_only|suggest, resolver_profile_id?, request_id}` | `JobHandle` or `{resolution_run_id, resolved[], unresolved[], coverage}`. Proposed; deterministic alias/ticker resolution first; optional provider suggestions never write canonical identity automatically. |
| `fina_nip_entity_review` | `{mention_id, expected_revision, decision: link|create|unresolved|reject, entity_id?, canonical_name?, aliases?, reason, request_id}` | `{mention, entity_ref?, review_audit_ref}`. Proposed, human decision required to create/link identity. |
| `fina_nip_projection_build` | `{kind: clusters|narrative_graph|entity_graph|radar|event_timeline, as_of, from?, to?, source_ids?, entity_ids?, formula_version?, request_id}` | `JobHandle` or `{snapshot_id, kind, revision, coverage, input_refs, formula_version}`. Existing cluster/graph/signal operations cover only narrower narrative projections; entity graph, entity Radar and NIP timeline are proposed. |
| `fina_nip_projection_get` | `{snapshot_id, revision?, cursor?, limit?}` | `{snapshot, items, next_cursor, coverage, lineage}`. Existing `list_narrative_graph`, `list_narrative_clusters`, `narrative_signal_snapshot` are foundations; persisted snapshot readback/version selectors are needed. |
| `fina_nip_projection_list` | `{kind, as_of?, cursor?, limit?}` | `Page<ProjectionSummary>`. Proposed. |

The NIP event/claim timeline and Video edit timeline are different artifacts. Radar must label descriptive feature values and coverage, not imply validated investment signals. Do not label the current weekly `narrative_signal_snapshot` as an entity Radar or a complete event timeline.

### Stage E — video project, narrative and storyboard

| Public tool | Request | Response / status |
|---|---|---|
| `fina_video_projects_list` | `{cursor?, limit?}` | `Page<VideoProject>`. Existing `list_video_projects` returns current project revisions, without cursor. |
| `fina_video_project_create` | `{project: {project_id?, title, language, audience?, target_platform?, target_duration_ms?, style_profile_id?}, request_id}` | `{project_id, revision, ...}`. Existing `create_video_project` appends a supplied record revision; public API should make create/update semantics explicit. |
| `fina_video_project_get` | `{project_id, revision?}` | Exact `VideoProject`; existing `get_video_project` returns current immutable revision. |
| `fina_video_episode_create` | `{episode: {episode_id?, project_id, expected_project_revision, title?, source_snapshot_refs[], as_of?, disclosure?}, request_id}` | `{episode_id, revision, ...}`. Existing `create_video_episode`; add typed source snapshot fields and get/list endpoints. |
| `fina_video_episode_get/list` | `{episode_id, revision?}` / `{project_id, cursor?, limit?}` | Exact `VideoEpisode` / `Page<VideoEpisode>`. Proposed readback (service/store methods exist but tools are missing). |
| `fina_video_evidence_link` | `{episode_id, episode_revision, evidence_refs: EvidenceRef[], request_id}` | `{links[], warnings[]}`. Existing `link_video_evidence`; public contract should prefer stable refs/ranges to arbitrary JSON. |
| `fina_video_evidence_list` | `{episode_id, episode_revision, cursor?, limit?}` | `Page<EvidenceRef>`. Existing `list_video_evidence`. |
| `fina_video_narrative_save` | `{narrative_id?, episode_id, expected_revision?, source_snapshot_ref, thesis, summary?, analysis_mode, review_status, beats:[NarrativeBeat], request_id}` | `{narrative_id, revision, ...}`. Existing `save_video_narrative` accepts typed record through JSON; keep append-only revision rule. |
| `fina_video_narrative_get/list` | `{narrative_id, revision?}` / `{episode_id, cursor?, limit?}` | Exact `Narrative` / page. Existing tools read/list latest revisions; add exact historical revision support. |
| `fina_video_storyboard_save` | `{storyboard_id?, project_id, episode_id, narrative_ref, expected_revision?, manifest: StoryboardManifest, request_id}` | `{storyboard_id, revision, manifest_hash, review_status}`. Existing `save_video_storyboard` stores a versioned record but not the full browser storyboard document. |
| `fina_video_storyboard_get/list` | `{storyboard_id, revision?}` / `{project_id?, episode_id?, cursor?, limit?}` | Exact manifest / page. **Proposed missing readback.** |
| `fina_video_storyboard_validate` | `{storyboard_id, revision, policy_profile_id?}` | `{valid, blockers[], warnings[], evidence_coverage, capability_coverage, estimated_duration_ms, estimated_cost?, input_hash}`. Proposed real validator; must not mutate the storyboard. |

### 5.1 Native storyboard contract

`StoryboardManifest` is Fina's editable directing plan. It should cover the baseline capabilities in a narrative-beat workflow, then add Fina-specific lineage and production structure. It is not a raw pixel buffer, renderer-specific scene JSON or final MP4. Compilers and tools must preserve the exact storyboard revision they consume.

```ts
type StoryboardManifest = {
  schema_version: "fina.storyboard.v1";
  title: string;
  language: string;
  fps: 24 | 25 | 30 | 50 | 60;
  target: { width: number; height: number; duration_ms?: number; profile_id: string };
  creative_brief: { audience?: string; thesis: string; tone?: string; disclosure_refs: string[] };
  evidence_snapshot: { as_of: string; refs: EvidenceRef[]; coverage_ref?: Ref };
  beats: Array<{
    beat_id: string; ordinal: number;
    kind: "hook" | "context" | "claim" | "analysis" | "quote" | "chart" | "diagram" | "broll" | "transition" | "close";
    narration: string;
    on_screen?: { heading?: string; subtitle?: string; bullets?: string[]; quote?: string; attribution?: string; source_label?: string };
    evidence_refs: EvidenceRef[];
    visual_intent: { type: string; payload_ref?: Ref; static_or_animated: "static" | "animated" | "auto"; fallback: "card" | "still" | "blocked" };
    scene_refs: Ref[]; shot_refs: Ref[]; audio_cue_refs: Ref[];
    transition?: { kind: string; duration_ms?: number };
    duration_hint_ms?: number;
    review_state: "draft" | "needs_review" | "approved" | "rejected";
  }>;
  asset_requirements: Array<{ shot_ref: Ref; capability: string; provider_policy: string; rights_profile_id?: string }>;
  audio_plan: { voice_profile_id?: string; tts_profile_id?: string; music_policy: "none" | "optional" | "required"; caption_tracks: string[] };
  render_policy: { max_animated_shots: number; deterministic_first: boolean; missing_provider: "fallback" | "block" };
};
```

Each beat may link to multiple scenes/shots; a scene may contain multiple shots and layered assets. Narration, evidence, duration, visual treatment and audio cues are editable separately. Exact source quotes require evidence refs. Numeric chart data needs evidence/source refs for its values. Unsupported data becomes a card or a blocker; it is never fabricated to satisfy a visual plan.

### Stage F — scenes, shots, visuals and managed assets

| Public tool | Request | Response / status |
|---|---|---|
| `fina_video_scene_save` | `{scene_id?, storyboard_ref, expected_revision?, ordinal, purpose, duration_hint_ms?, transition?, evidence_refs[], request_id}` | `{scene_id, revision}`. Existing `save_video_scene` persists typed record; currently no get/list. |
| `fina_video_scene_get/list` | `{scene_id, revision?}` / `{storyboard_id, cursor?, limit?}` | Exact scene / page. Proposed. |
| `fina_video_shot_save` | `{shot_id?, scene_ref, expected_revision?, ordinal, shot_type, duration_hint_ms?, visual_intent, evidence_refs[], asset_refs[], audio_cue_refs[], request_id}` | `{shot_id, revision}`. Existing `save_video_shot` persists typed record; current type lacks full relations/readback. |
| `fina_video_shot_get/list` | `{shot_id, revision?}` / `{scene_id, cursor?, limit?}` | Exact shot / page. Proposed. |
| `fina_video_visual_spec_save` | `{spec_id?, scene_ref, shot_ref?, expected_revision?, spec_type, payload, dimensions, fps, evidence_refs[], asset_refs[], request_id}` | `{spec_id, revision, spec_hash}`. Existing `save_video_visual_spec`; constrain `payload` by `spec_type`, not arbitrary renderer JSON. |
| `fina_video_visual_spec_get/list` | `{spec_id, revision}` / `{project_id?, episode_id?, scene_id?, shot_id?, cursor?, limit?}` | Exact spec / page. Existing get/list foundations; add precise filters and pagination. |
| `fina_video_assets_list/get` | `{project_id?, kind?, cursor?, limit?}` / `{asset_id, revision?}` | Managed metadata and rights state. Existing list/register/lineage operations; get is proposed. |
| `fina_media_upload_begin` | `{project_id, file_name, mime_type, size_bytes, sha256, purpose, rights_approval_id}` | `{upload_id, authorized_upload_handle, expires_at, max_bytes}`. Proposed secure managed upload; never accept agent-local file paths. |
| `fina_video_asset_import` | `{upload_id, metadata, license_ref, evidence_refs[], request_id}` | `{asset_id, revision, content_hash, probe}`. Proposed byte-backed import; current `register_video_asset` only stores metadata and is not an upload. |
| `fina_video_lineage_get` | `{asset_id, revision?, depth?, include_evidence?}` | `{nodes[], edges[], source_refs[], hashes[], jobs[]}`. Direct link/list foundations exist; transitive export-to-evidence lineage readback is proposed. |

Allowed `spec_type` values are capability-gated and versioned (for example `evidence_card`, `quote_card`, `kinetic_text`, `chart`, `dag`, `petrinet`, `mermaid`, `svg_timeline`, `image_layer`, `caption`, `scene_transition`). Validate each payload against a type-specific schema. LinkZag compiler input is derived from these typed specs; the agent should not author arbitrary filesystem scene paths.

### Stage G — provider selection, asset generation and rendering

| Public tool | Request | Response / status |
|---|---|---|
| `fina_video_asset_generate` | `{shot_ref, capability: still_image|video|tts|music, provider_profile_id, prompt_or_text, evidence_refs[], parameters, consent_ref?, rights_profile_id?, request_id}` | `JobHandle`; proposed for image/video/TTS/music. Capability-specific tools may be split; tool must block if capability is not actually executable. |
| `fina_video_render_plan_compile` | `{storyboard_ref, visual_spec_refs[], selected_asset_refs[], profile_id, request_id}` | `{plan_id, revision, plan_hash, compiler_version, input_refs[], jobs[], blockers[], warnings[]}`. Proposed. Persist exact plans so a retry does not silently use changed records. |
| `fina_video_render_plan_get` | `{plan_id, revision?}` | Exact immutable render plan. Proposed. |
| `fina_video_render_start` | `{plan_ref, request_id}` | `JobHandle`. Proposed render-by-plan boundary. |
| `fina_video_render_linkzag` | Current tool `render_video_linkzag`: `{visual_specs:[{spec_id,revision}], capture_mode?:"flash"|"full"}`; omitted mode defaults to Flash. | `JobHandle`. Flash uses Playwright `recordVideo`/Canvas ECharts and is marked nondeterministic; Full uses deterministic frame screenshots/SVG. Both modes accept 1–24 exact saved VisualSpec revisions and produce silent MP4 with mode/backend/determinism in the manifest. This remains a bounded renderer operation and bypasses a persisted RenderPlan/EDL; it is not the general export API. |

Provider profiles are allowlisted by capability and policy. The tool returns a blocker with a repair action when a TTS/image/video provider is not configured. Comfy pack commands or a model installed elsewhere are not evidence that Fina has an executable Video adapter. Remote calls state what data leaves the device before user approval; no automatic provider fallback changes a local-only request to cloud.

### Stage H — narration, captions and audio QA

| Public tool | Request | Response / status |
|---|---|---|
| `fina_video_audio_cues_save` | `{storyboard_ref, cues:[{cue_id?, shot_ref, text, language, voice_profile_id?, provider_profile_id?, consent_ref?, expected_revision?}], request_id}` | `{cue_refs[], revisions[]}`. Proposed. Keep text editable and tie generated bytes to cue revision. |
| `fina_video_audio_generate` | `{cue_ref, provider_profile_id, voice_profile_id?, pronunciation_profile_id?, settings, request_id}` | `JobHandle`; proposed. Voice consent/profile readiness checked before work starts. |
| `fina_video_captions_build` | `{storyboard_ref, audio_asset_refs[], languages[], format: srt|vtt|ass, request_id}` | `JobHandle` or `{caption_asset_refs[], alignment_report}`. Proposed. |
| `fina_video_audio_qa_run` | `{storyboard_ref, audio_asset_refs[], transcript_policy, limits, request_id}` | `ReportRef` with ASR/script comparison, missing/truncated/looping cue, pacing, levels and clipping findings. Proposed. |

The local no-TTS route may produce a silent **preview** if the user selects it and the export profile allows it. It must never be represented as a narrated/publish-ready commentary. Publishing or voice cloning requires explicit separate authorization.

### Stage I — QA, edit timeline, assembly and export

| Public tool | Request | Response / status |
|---|---|---|
| `fina_video_qa_run` | `{storyboard_ref, render_plan_ref?, asset_refs[], audio_report_ref?, policy_profile_id, request_id}` | `{report_id, revision, status: passed|warning|blocked, findings[], evaluator_version, input_hashes[]}`. Existing QA report save/get/list persists data; evaluator is proposed. |
| `fina_video_qa_get/list` | `{report_id, revision?}` / `{project_id, cursor?, limit?}` | Report / page. Existing get/list foundations. |
| `fina_video_timeline_build` | `{storyboard_ref, render_plan_ref, asset_selection:[{shot_ref, asset_ref}], audio_selection:[{cue_ref, asset_ref}], caption_refs[], profile_id, gap_policy, request_id}` | `{timeline_id, revision, timeline_hash, duration_ms, blockers[], warnings[]}`. Proposed builder. Existing save/get/list stores caller-supplied timeline only; current `VideoTimeline` does not fully represent tracks, trims, captions, audio and transitions. |
| `fina_video_timeline_get/list` | `{timeline_id, revision?}` / `{project_id, cursor?, limit?}` | Exact edit timeline / page. Existing persistence readback. |
| `fina_video_export_start` | `{timeline_ref, qa_report_ref, export_profile_id, request_id}` | `JobHandle`; proposed general FFmpeg export. Requires a passing report for identical pinned input hashes and no policy blockers. |
| `fina_video_export_get/list` | `{manifest_id, revision?}` / `{project_id, cursor?, limit?}` | Exact export manifest / page. Existing export-manifest persistence tools; producer is proposed. |
| `fina_media_get` | `{asset_id, revision, representation?: original|proxy|thumbnail}` | `{media_handle, mime_type, size_bytes, sha256, expires_at}`. Proposed authorized media retrieval. Never return raw local paths. |
| `fina_video_playback_get` | `{asset_id, revision}` | `{short_lived_url, expires_at, mime_type}` after access checks. Optional; route may instead issue a media resource URI. |

QA findings should have stable `code`, `severity`, `subject_ref`, measured/expected values, evidence refs and remediation. Hard blockers include missing/unsupported assets, missing lineage/evidence, rights/licensing gaps, invalid paths/hashes, source coverage policy failure, unresolved required review, timeline gaps/overlaps, codec/dimension/duration violation and missing audio/captions when required. Warnings must be distinguishable from blockers. A caller cannot set the QA state to passed by saving a report.

The detailed proposed EDL schema, exact tool requests/results, deterministic QA checks, export-profile gates, manifest lineage and acceptance suite are specified in [doc 71 — EDL, QA evaluation and export tool interface design](71-edl-qa-export-tool-interface-design.md). It expands this high-level Stage I contract; it does not claim the builders/evaluator/exporter are implemented.

### Stage J — final readback and proof of lineage

The agent must be able to read the exact records and report for the produced file:

1. final asset and export manifest;
2. QA report, export profile and `timeline_hash`;
3. edit timeline and exact selected visual/audio/caption assets;
4. render plan, LinkZag/compiler/provider job IDs and input hashes;
5. exact storyboard, scene, shot, narrative and evidence revisions;
6. canonical NIP event/claim/entity refs, transcript offsets, `as_of` snapshot and source rights state.

The final response to the user should include the playable media handle/link, duration/format, whether audio is present, QA result, relevant warnings, and source/evidence lineage. It should not expose a raw `/home/...` path or claim generated footage when the output is deterministic motion graphics.

## 6. Skill interfaces

Skills provide orchestration instructions and editorial policy; tools provide typed state transitions. A skill must not hide persistence in local JSON, invent tool availability, directly write tables or claim successful generation when a job is only queued.

### 6.1 `fina-nip-research`

**Use when:** the task is to find/ingest an event, retain a transcript, extract claims, resolve entities, inspect graph/Radar/timeline projections, or prepare an evidence pack without producing a video.

**Inputs:** topic or source; optional existing `source_id`/`event_id`; source/date window; transcript policy; allowed data boundary; desired NIP projections; user authorization/approval context.

**Workflow:** capability and policy preflight → source search/list → confirm source rights and active adapters → ingest/refresh/import → transcription job if needed → retrieve canonical event → extract claims with consent-aware provider → validate evidence/coverage → resolve/review entities → build requested projections with `as_of` → read back exact revisions and report coverage.

**Output contract:** `ResearchResult {source_refs, event_refs, transcript_status, claim_run_refs, entity_refs, projection_refs, as_of, coverage, blockers, warnings}`. It must distinguish an unavailable adapter, failed transcription, zero claims, partial coverage and complete successful analysis.

### 6.2 `fina-commentary-video` (primary end-to-end skill)

**Use when:** the user asks for a prompt-driven commentary/explainer video from an event, transcript, podcast source or a set of retained NIP evidence.

**Inputs (skill request, not a monolithic tool call):**

```json
{
  "prompt": "Make a commentary video about …",
  "source": {"mode": "existing_events|approved_source_search|local_import", "event_ids": [], "source_ids": []},
  "editorial": {"language": "en", "audience": "…", "target_duration_ms": 600000, "style_profile_id": "…"},
  "production": {"voice_profile_id": null, "provider_policy": "local_first", "max_animated_shots": 10, "render_profile_id": "review-1080p"},
  "delivery": {"export": true, "publish": false}
}
```

Fields are optional except `prompt` and a usable source selection. `publish` defaults to false. A skill should ask the user only for missing high-impact choices (rights, remote data egress, voice cloning, paid generation, publication visibility); otherwise it uses transparent defaults and proceeds.

**Required sequence:**

1. Call `fina_health`, `fina_capabilities_get`, `fina_resources_get` and `fina_policy_check`; report unavailable modes before promising them.
2. Select or ingest only an authorized source. Use NIP's canonical source/event tools; do not scrape unsupported source kinds or duplicate transcript truth in Video.
3. Obtain the publisher transcript or selected local ASR result; poll a durable job. Read back event and offsets.
4. Run claims/evidence extraction and relevant entity/projection work only if useful to the requested story. Preserve the research snapshot and `as_of`; clearly flag incomplete coverage.
5. Draft a thesis and commentary beats. Separate what the source says from analysis; attach evidence refs to factual statements/quotes; label interpretation; never fabricate quotes, chart data or causal links.
6. Create project/episode/narrative and save a complete native `StoryboardManifest`. Validate it, then read back the exact revision for review. If user feedback changes a beat, append a new revision and recompile only affected downstream work.
7. Select only configured providers. Create visual/audio jobs and poll them. For deterministic first output, use cards, charts and diagrams; keep generated video optional. An unavailable TTS provider produces a clearly labeled silent preview only if permitted by the user/profile.
8. Compile a revision-pinned render plan; render; read back outputs and hashes. Do not proceed on an explicit job failure.
9. Run real structural, evidence, audio and rights QA. Fix blockers or return a blocked draft; never save or report a fabricated passing result.
10. Build and read back the edit timeline/EDL. Export only against a current passing QA report for identical input hashes.
11. Read back export manifest and transitive lineage; return artifact, preview, duration/codec/audio presence, QA summary, evidence references and remaining warnings.

**Completion states:** `draft_ready`, `preview_ready`, `export_ready`, `blocked`, `failed`, `cancelled`. “Render job succeeded” is not equivalent to “publish-ready.” Publishing is a separate, explicitly permissioned skill/action.

### 6.3 `fina-video-revise-export`

**Use when:** a user asks to revise an existing Fina storyboard/video, inspect QA/lineage, render selected changes, or assemble a new export from existing approved assets.

**Inputs:** `project_id`, optional `episode_id`/`storyboard_id`/export refs, requested edits, re-render scope, export profile. It must read the current exact revisions first; create new immutable revisions; retain unchanged asset refs; rerun required QA; assemble from a new pinned timeline. It must not silently mutate old artifacts or weaken a previous blocker.

**Output:** new revision refs, rerendered job IDs, invalidated/reused asset summary, QA and export refs, lineage difference from the previous export.

### 6.4 Skill discovery and tool metadata

Each installed skill should declare a name, concise description, invocation examples, required tool server/scopes, capability prerequisites, safety-sensitive actions, and output schema. Avoid undocumented frontmatter fields that only one agent runner understands. Provide the same human-readable `SKILL.md` plus a machine-readable skill manifest (`skill.json` or equivalent) listing:

```json
{
  "schema_version": "fina.skill.v1",
  "name": "fina-commentary-video",
  "description": "Create an evidence-linked commentary video from approved NIP sources.",
  "tools": ["fina_capabilities_get", "fina_nip_event_search", "fina_video_storyboard_save"],
  "required_scopes": ["nip:read", "video:edit", "video:render"],
  "optional_scopes": ["nip:ingest", "nip:derive", "video:generate", "video:export"],
  "outputs": ["StoryboardRef", "QaReportRef", "ExportManifestRef", "LineageGraph"]
}
```

The registry should expose installed skill version and missing prerequisites through `fina_skills_list` / `fina_skill_get`. These tools describe available instructions; they do not execute an LLM agent on their own.

## 7. Authorization and safety policy

- **Rights and source access:** source registration/fetch requires an approved rights statement and host-recorded approval. Public URL does not automatically authorize retention or reuse.
- **Remote model egress:** tool input names the exact selected provider profile and data class; host checks consent bound to that provider/model before sending transcript or private narrative content. Revocation is effective before the next call. No hidden remote fallback.
- **Voice and likeness:** voice synthesis/cloning requires consent scope and permitted profile. Do not clone source hosts/guests. Keep voice reference files private and expose only profile IDs/status.
- **Paid or generative operations:** check estimated cost/resource use and obtain explicit approval where configured. A job ID does not imply spending approval.
- **Publishing:** export is not publishing. Public posting, upload, broad distribution and account actions require a separate preview of exact payload/destination/visibility and final user confirmation.
- **Destructive actions:** deletion/cleanup tools require scoped authorization, impact summary and confirmation token; permanent deletion must be idempotent and auditable.
- **Paths/network:** accept managed object IDs, short-lived upload handles and allowlisted URLs only. Validate MIME, size, checksum and file contents; block SSRF/redirect escapes, symlink traversal and arbitrary local paths.
- **Prompt injection:** source/transcript text is untrusted data. It cannot change tool permissions, provider settings or system policy. Tool outputs label quoted source content as data.
- **Agent privacy:** store audit identity, requested scopes, exact revision/job refs and consent decisions, but do not log secrets or dump long raw transcripts unnecessarily.

## 8. Errors, revisions, retries and consistency

1. All writes are either idempotent by `request_id` or return the prior result for the same key; the same key with a different payload is `idempotency_conflict`.
2. Use `expected_revision` on edits; stale writes return `revision_conflict` with current revision and no partial writes.
3. Parent/child creation must be atomic as a batch or staged with durable parent refs. Every child is validated against project, episode, narrative and storyboard ownership before commit.
4. A job pins all input IDs, revisions, hashes and provider profile. Retrying creates a new job attempt linked with `retry_of`; it never overwrites a previous output.
5. Cancellation is cooperative and reports whether it was accepted, too late, or completed. Resource exhaustion returns a typed blocker plus safe retry guidance.
6. Partial success is explicit. If an ASR transcript is committed but claim extraction fails, return both the committed event ref and the failed claim job; do not roll back or pretend the entire journey failed without explaining retained outputs.
7. External tools never take arbitrary `limit`, timeouts or durations. Enforce server-side maxes for transcript excerpts, job wait, concurrency, media bytes, clip length and generated assets.
8. The Video edit timeline references saved assets and exact cue/shot revisions. A change invalidates only dependent compiled/rendered assets; old lineage remains immutable.

## 9. Acceptance tests for the external-agent contract

Tests should run against the actual MCP transport/bridge, not invoke store methods directly. Use a fixture database and deterministic fake providers for CI; separately test the user-configured desktop/provider path.

**Implemented fixture coverage:** `playwright/external-agent-commentary-e2e.spec.ts` uses a small Streamable HTTP MCP client (`playwright/support/nipMcpClient.ts`) against the isolated NIP fixture engine. Run it with `npm run test:e2e:journey:external-agent`. It ingests and transcribes three fixture podcast episodes with Host/Guest turns; verifies speaker-attributed claims and quote offsets; checks persisted narrative membership/claim-support edges and weekly Radar/Timeline evidence counts; then writes Video records, renders with LinkZag, verifies MP4 hash/media properties and exact VisualSpec/event/claim lineage. The graph is intentionally entity-rich but not a canonical entity graph: current NIP nodes remain `narrative`, `event` and `claim`, with no entity resolution or entity-node API. The run ends at `preview_ready`: product QA evaluation, EDL building, general export production, and the authenticated external bridge remain unavailable or untested. The transcript labels are preserved in text/claim attribution; they do **not** represent ASR diarization segments. A successful run writes `playwright/.data/nip/<NIP_E2E_RUN_ID>/external-agent-commentary-result.json`. This is an MCP tool-contract simulation, **not** a security test of a production external-agent connector.

**Measured run (2026-11-19):** both Playwright tests passed in 5.8 minutes. The fixture journey retained 3 events, persisted 9 speaker-attributed claims with exact quote spans, and produced 1 narrative node, 3 event nodes, 9 claim nodes, 3 membership edges and 9 claim-support edges; the Radar/Timeline signal snapshot included all 3 events. The assembled silent preview was H.264 MP4, 1280×720 at 30 fps, 24.933333 seconds, 713,576 bytes; SHA-256 `e0ca1b8f05b25a9138a239dbc5948ff9447f7e8f501d8cd3984e30d949c9b395`. The run receipt is `playwright/.data/nip/e2e-run/external-agent-commentary-result.json`.

### Tool/schema tests

- Enumerate tool names/descriptions/schemas; every tool has strict input schema, versioned output, permission class and capability requirement.
- Unknown keys, wrong IDs/revisions, cross-project refs, invalid evidence spans, malformed media handles and oversized content fail safely.
- Verify identity/scopes are host-bound; a fake `actor`, `rights_confirmed: true` or `consent: true` cannot bypass authorization.
- Verify idempotent create/retry, stale revision conflict, cursor pagination, sanitized errors and secret/path redaction.

### End-to-end journeys

1. **Existing transcript:** find/read canonical event → claims/evidence → optional entity/projections → create project/episode/narrative/storyboard → read back → render → QA → timeline/EDL → export → retrieve media handle and transitive lineage.
2. **Podcast ingestion:** authorized source/feed → episode selection → publisher transcript or local ASR job → event commit → same remainder of journey.
3. **Local transcript:** authorized managed upload → idempotent event import → same production journey.
4. **External agent-only:** perform all steps using only public MCP tools and installed skill, with no browser-only state, direct DB, raw filesystem path or hidden tool.
5. **Revision/recovery:** pause after a queued render, restart desktop/bridge, reconnect, list/read job, resume/poll, revise one beat, reuse unaffected assets, export new lineage without mutating prior export.
6. **Unavailable capability:** no TTS/image/video provider, remote consent denied, Comfy not running, local ASR absent, unsupported source type, CPU admission denied. Skill reports blocked/unavailable accurately and offers permitted fallback; never claims success.
7. **QA blockers:** unsupported chart evidence, missing asset, unreviewed required claim, wrong dimensions/codec, missing audio when required, timeline gap/overlap, license/rights missing, lineage hash mismatch. Export is blocked.
8. **Security:** second engine writer rejected; unauthenticated external caller rejected; wrong-project scope rejected; path traversal/SSRF rejected; source prompt injection cannot invoke unapproved tools; destructive/public actions require actual host confirmation.

## 10. Implementation sequence

### P0 — Exposure and trust boundary

- Decide companion-bridge versus standalone-owner product behavior and implement caller auth/scope, pairing, audit identity, health and revocation.
- Ensure one database has one writer; add a lock/owner lease or OS-level guard across processes, not merely a per-process Rust mutex.
- Expose the NIP MCP tool catalog only through that supported boundary. Do not add a raw public `.mcp.json` entry that starts a second engine on the desktop database.

### P1 — Public facade and readback

- Normalize tool names, JSON schemas, errors, request IDs, revisions and pagination.
- Add missing project-episode, storyboard, scene, shot, projection and asset get/list reads.
- Replace arbitrary record-JSON writes at the external boundary with strict typed DTOs.
- Add a skills registry/manifest and publish `fina-nip-research` plus `fina-commentary-video` instructions early, clearly labeling unavailable functions.

### P2 — Storyboard compiler and provider truth

- Persist complete native `StoryboardManifest` revisions, evidence/audio/asset relations and readback.
- Add compile/validate-to-RenderPlan with exact input hashes and blockers.
- Make capability discovery per operation/provider; integrate TTS and caption timing before advertising narrated-video readiness.

### P3 — QA, EDL and export

- Implement actual QA evaluators, a multi-track edit timeline builder, FFmpeg export job and secure media retrieval.
- Make export require a passing QA report for the exact pinned inputs; register manifest/hash/lineage atomically.

### P4 — Full Manus-style acceptance

- Run all eight journeys above with the test MCP client, including restart/recovery, permissions and unavailable-provider paths.
- Add a desktop companion test that proves calls target the existing sidecar and never open a second DuckDB writer.
- Test the actual installed skill instructions with tool stubs and a deterministic fixture; check that it follows the tools, asks at the right approval boundary, and does not call unavailable features.

## 11. Existing implementation references

- MCP catalog and request DTOs: `crates/nip-engine/src/main.rs`.
- Domain types: `crates/nip-domain/src/lib.rs`.
- Persistence and hierarchical validation: `crates/nip-store/src/lib.rs`, `crates/nip-store/migrations/`.
- NIP engine service and Video record methods: `crates/nip-engine/src/lib.rs`.
- LinkZag renderer and assembly: `crates/nip-engine/src/linkzag.rs`.
- Tauri sidecar ownership: `src-tauri/src/nip_http.rs`, `src-tauri/src/lib.rs`.
- Tauri MCP proxy commands: `src-tauri/src/mcp_commands.rs`, `src/api/nipTransport.ts`.
- NIP ASR and local media staging: `crates/nip-engine/src/jobs.rs`, `crates/nip-engine/src/main.rs`.
- Current external MCP config (RIGA/TAC only): `.mcp.json`.
- Current storyboard candidate: `src/features/video/storyboard.ts`; Video UI/API: `src/features/video/`.
- Current measured video journey: `playwright/video-commentary-e2e.spec.ts`, `docs/68-video-workspace-handoff.md`.
- Architecture plan: `docs/69-agent-native-modes-and-full-journey-plan.md`.
