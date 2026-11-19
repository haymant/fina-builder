# 66 — FinA Builder Video Workspace: alignment review and implementation plan

**Status:** Corrected implementation plan, based on the attached “FinA Builder Video Workspace” requirement and fina-builder `main` after pulling origin on 2026-11-18 (`67a1629`). This document is a plan; it does not claim that the Video Workspace is implemented.

## 1. Executive decision

Implement Video Workspace as a native, bounded production domain inside the existing Tauri 2 + React fina-builder application. Its primary user model is:

```text
Project → Episode → Narrative → Storyboard → Scenes → Shots → Assets → QA → Timeline → Export
```

The workspace is not an infinite canvas, a node-graph editor, or a replacement for the existing Narrative Intelligence workspace. Narrative Intelligence remains the evidence-first source layer. Video Workspace consumes retained events, transcripts, claims, signal snapshots and charts through typed references, then creates versioned production artifacts.

The first implementation must be deterministic and reviewable. It must remain usable when no OpenAI-compatible LLM endpoint, ASR runtime or generative-video model is available: a permitted transcript/document event, deterministic text candidates and human-approved evidence are sufficient to plan and render a commentary video. Live LLM, ASR and generative-video execution are opt-in capability gates after the mock/fixture path, artifact lineage, cancellation, cleanup and QA gates pass.

## 2. Alignment corrections to the attached requirement

| Attached requirement | Corrected fina-builder interpretation |
|---|---|
| Add a generic “Video Workspace” beside Podcast/Research/Trading/Agent workspaces | Add a `video` application location alongside the existing dashboard, trade and narrative locations. Preserve the existing menu, dashboard tiles, trade repository and Narrative Intelligence routes. Do not invent a generic canvas. |
| Source → Narrative is the first video phase | Reuse NIP retained events, transcript review, claims, graph, Radar and Timeline when available. A transcript-first or user-owned document event may enter Video without ASR. When LLM extraction is unavailable, use deterministic candidates and human-approved evidence; Video must reference immutable `event_id`/`claim_id` records instead of creating a second transcript or research store. |
| Everything can be indexed in DuckDB and large assets use `NIP_LAKE_DIR` | Store production metadata, manifests, prompts, lineage, QA and job state in versioned DuckDB tables. Store large media under a dedicated NIP-managed media subtree, resolved from the NIP data/lake policy; do not put blobs in DuckDB, TAC market partitions, localStorage or the Git repository. Keep canonical event truth separate from video projections. |
| All providers are “handled by modules/comfy” | `modules/comfy` is the checked-out local workflow pack and its CLI/loopback ComfyUI boundary. fina-builder owns the typed provider contract, job lifecycle, consent/policy checks, lineage and persistence. The first adapter calls the pack CLI/loopback service; future cloud adapters remain separate implementations and are never called directly from React or business logic. Every provider invocation runs as an owned, cancellable child job with bounded concurrency; it must not block the NIP DuckDB writer or request path. |
| ComfyUI, Kling, Runway, Hailuo, Jimeng, Pika and Seedance are listed as implementations | Do not add credentials, network calls or provider claims for unavailable services. Start with `mock` and the optional local Comfy adapter. Add another provider only with a typed adapter, terms/licensing review, secret boundary, deterministic fixture and opt-in live test. |
| Provider/workflow registry is a ComfyTV-like generic registry | Add a versioned registry contract in the Video domain. A record identifies capability, provider adapter, workflow ID, schema version, model identity and supported parameters. It is metadata and selection policy, not an editable node graph. The local Comfy pack remains independently versioned. |
| Avatar Studio and VRM are part of the core production flow | `modules/rehab-video-maker` is checked out, but the parent README explicitly marks it legacy/reference-only and says not to add dependencies on it. Port its useful contracts—private avatar assets, measured narration timing, short per-shot renders, review sheets and disclosure—into native fina-builder types. Treat VRM as an optional, consented provider capability; never route product execution through the legacy submodule. |
| Diagram Studio is powered by LinkZag | `modules/linkZagShow` is present as a file-driven dual-mode renderer. Flash is the real-time speed-first path with Playwright `recordVideo` and Canvas ECharts; Full preserves deterministic per-frame screenshots and SVG ECharts. Use it as an isolated renderer adapter for chart/diagram/markdown/code/image scenes and bounded commentary templates. Its YAML/JSON/Markdown scene files, PNG/frame capture, MP4/WebM/MOV outputs and `segment.json` manifest are an execution contract, not the Video Workspace's canonical data model. |
| Phase 1 includes transcript → storyboard → audio/video generation → diagrams → assembly → MP4 | Split this into vertical slices. The first release proves evidence-linked project/storyboard/shot planning with transcript/document fixtures, deterministic candidates or human-approved claims, LinkZag-ready visual specs, mock assets and a render-plan export. Flash supplies quick previews by default; Full provides deterministic production capture when reproducibility or frame review is required. Local ASR, LLM extraction, TTS and generative video remain separately gated capabilities. |
| Every asset can be regenerated from prompt/seed | Store prompt, model, parameters, workflow/version, source references, upstream asset IDs, input content hashes, provider, timestamps, job/run IDs and license/policy state. Do not promise reproducibility for nondeterministic providers; record the provider's reproducibility limitations. |
| QA includes hallucination detection and brand consistency | Implement deterministic structural QA first: evidence coverage, missing dependencies, timing, media existence, duration, resolution, codec, audio stream, black-frame/gap checks where measurable, and policy/license metadata. Model-based hallucination, continuity and brand review are advisory future checks with explicit unavailable states. |
| Agent skills own execution | Skills orchestrate bounded MCP tools and review steps. Deterministic validation, manifests, state transitions and media inspection remain Rust/FFmpeg code. Skills never become a second database or bypass provider/rights boundaries. |

## 3. Existing fina-builder capabilities to reuse

The pulled baseline already provides the important foundations:

- Tauri 2 desktop shell, same-origin browser/MCP development path, and process-scoped NIP sidecar configuration.
- NIP DuckDB ledger with immutable source events, optional model-derived claims, graph projections, signal snapshots, source registry and Parquet export/restore. Video must also accept transcript/document events and deterministic text candidates without requiring a model-derived claim run.
- Evidence-linked Narrative Workspace with transcript review, extraction progress, provider status/consent, Operational Monitor, Graph, Radar, Timeline, ETF Themes and Editorial Planning.
- Async NIP jobs with progress, cancellation, bounded concurrency and persisted reports.
- `modules/comfy` as a standalone cross-platform local workflow pack. Its current CLI supports `t2v`, `i2v`, `flf2v`, `r2v`, `t2i`, `i2i`, `frame`, `tts` and `asr`; speech is optional. The supported execution targets are macOS Apple Silicon/MPS, Linux CUDA, Linux ROCm where available, and CPU with reduced expectations.
- `ffmpeg`/`ffprobe` for local media inspection and eventual assembly.
- `modules/linkZagShow` as a Flash/Full scene and segment renderer: local scenes, ECharts, Mermaid, XYFlow, Markdown, code and image items; Flash Playwright `recordVideo`/Canvas capture; Full deterministic Playwright frame capture/SVG charts; FFmpeg encoding; and a machine-readable `segment.json` output manifest.
- `modules/rehab-video-maker` as a reference-only source for measured TTS/caption timing, avatar/VRM asset handling, shot budgets and release review checks. It is not a runtime dependency.
- Existing chart/graph UI patterns and NIP signal data; VRM assets in the reference module are optional inputs, not an automatic product capability.

## 4. Target architecture

### 4.1 Frontend

Add `src/features/video/` with typed API calls and view components. Add a `video` location to the existing workspace navigation rather than replacing the current landing page. The first views are:

1. **Projects** — project list, status, target platform/length/style, source/evidence count.
2. **Episode workspace** — selected source events, claims, narrative outline and disclosure.
3. **Storyboard** — ordered scenes with narration, timing, visual intent and evidence links.
4. **Shot planner** — shot duration/type/motion, prompt, references, selected assets and requirements.
5. **Asset library** — reusable assets, lineage, license/policy status, preview and regeneration inputs.
6. **Production jobs** — queued/running/succeeded/failed/cancelled state, progress, logs without source-content leakage, artifacts and retry.
7. **QA and assembly** — deterministic findings, timeline/EDL/FFmpeg plan, export readiness and final output path.

React must call the same-origin NIP/video MCP transport in browser development and the typed Tauri bridge in desktop mode. It must not spawn `render.py`, call ComfyUI directly, read arbitrary filesystem paths, or hold provider credentials.

### 4.2 Rust service boundary

Initially extend the NIP sidecar with a bounded `video_*` MCP surface so browser and Tauri paths share one lifecycle and one policy boundary. Keep Video tables separate from `nip_events`, `nip_claims` and source-registry truth. Do not require doc 65 (`entity-claims-features-signal-research.md`) to land before Video V0; consume only the stable NIP event/claim/evidence interfaces that already exist and keep future entity/claim/feature/signal projections behind typed optional references. If video jobs later require independent resource isolation, split them into a dedicated sidecar only after a process-boundary ADR.

Recommended bounded contracts:

- `create_video_project`, `list_video_projects`, `get_video_project`, `update_video_project`;
- `create_video_episode`, `link_video_evidence`, `list_video_evidence`;
- `save_video_narrative`, `save_video_storyboard`, `save_video_scene`, `save_video_shot`;
- `list_video_assets`, `register_video_asset`, `delete_video_asset`;
- `list_video_workflows`, `get_video_workflow`;
- `plan_video_production`, `start_video_job`, `video_job_status`, `cancel_video_job`;
- `run_video_qa`, `build_video_timeline`, `export_video_plan`, `export_video`;
- `video_resource_status` and `video_capabilities`.

Every mutating result returns a stable ID, revision/run ID, status and provenance. Long-running generation and assembly return immediately with a job ID and are polled through the existing job protocol.

### 4.3 Domain model

Use explicit versioned records rather than untyped JSON blobs:

- `VideoProject`: title, language, target platform, target duration, audience, style profile, status, created/updated times and revision.
- `VideoEpisode`: project ID, source event IDs, transcript/event selection, disclosure and point-in-time/as-of context.
- `VideoNarrative`: summary, thesis, sections, key points, approved claims or human-authored points, evidence IDs, analysis mode and derivation run.
- `VideoStoryboard`: narrative ID, ordered scene IDs, formula/schema version and review status.
- `VideoScene`: start/end or duration, purpose, narration text, visual intent, evidence IDs and ordered shot IDs.
- `VideoShot`: duration, shot type, camera motion, image/video prompt, references, selected asset IDs, audio/diagram requirements and status.
- `VideoAsset`: kind, URI/path relative to managed media root, MIME, hash, dimensions/duration, provider/workflow/model, prompt/parameters, upstream asset IDs, source hashes, explicit evidence references, license state, created time and job ID.
- `VideoWorkflow`: capability, provider adapter, workflow ID, schema/version, model identity, supported platforms and parameter schema.
- `VideoJob`: operation, inputs, run ID, progress, cancellation state, resource estimate, outputs, errors and cleanup status.
- `VideoQaReport`: checks, findings, severity, measured values, formula/tool versions, input revision and run ID.
- `VideoTimeline`: ordered clips/audio/captions/transitions, source asset IDs, durations, EDL/FFmpeg plan and export revision.

A narrative, claim, chart or source event is referenced by immutable ID and revision. A copied narration sentence must retain the source claim/event evidence; generated prose is not treated as source truth. Scene, shot and asset lineage must preserve evidence IDs and, where available, transcript time spans or claim revisions so a rendered frame/segment can be traced back to source events without reverse-engineering a prompt. A deterministic candidate is not an authoritative claim until a human or approved model-derived review promotes it, and the promotion must remain auditable.

### 4.4 Storage and lifecycle

The current NIP store migration registry ends at schema version 10. Add the Video migration as the next coordinated migration (currently 0011), update the Rust migration constants and schema-version assertions together, and include migration/restore/Parquet coverage. Doc 65 (`entity-claims-features-signal-research.md`) is a future research/implementation phase, not a prerequisite for this Video migration; do not implement its future entity/feature tables as part of V0 and do not create a second migration registry or hard-code a conflicting version. Suggested table groups are `video_projects`, `video_episodes`, `video_narratives`, `video_storyboards`, `video_scenes`, `video_shots`, `video_assets`, `video_workflows`, `video_jobs`, `video_qa_reports` and `video_timelines`.

DuckDB stores metadata and manifests. Large files live below an explicitly defined NIP-owned media root (a documented `NIP_MEDIA_DIR` or a fixed child of `NIP_DATA_DIR`, never an arbitrary provider path), with content hashes and relative paths in DuckDB. Managed media access uses opaque asset IDs or validated service URLs, not raw filesystem paths. Temporary input/chunk files are job-owned and deleted on success, failure, cancellation and restart recovery. A user-created export is disclosed as non-recallable. Asset deletion must refuse or explicitly version a replacement when another shot or timeline depends on it.

### 4.5 Provider and workflow adapters

Define typed provider ports in the Video boundary:

- `ImageGenerationProvider`;
- `VideoGenerationProvider`;
- `VoiceGenerationProvider`;
- `MusicGenerationProvider`;
- `DiagramRenderer`;
- `AvatarProvider` (later).

The first implementations are `MockProvider`, `LinkZagRenderer` and `ComfyPackProvider`. `LinkZagRenderer` writes a generated scene file into a job-owned directory and invokes the pinned submodule CLI. The adapter distinguishes command outputs: `segment` is validated through `segment.json`; `capture` through its frame manifest; `render` as a still; and `video` through ffprobe plus the resolved scene checksum. All outputs are imported only from declared job paths. The adapter records the LinkZag submodule commit, scene checksum, dimensions, duration, FPS, format, transparency and FFmpeg probe results. React never imports LinkZag packages directly.

LinkZag is also the first non-generative video-production path. Extend the submodule or its adapter with versioned, bounded commentary templates rather than exposing an arbitrary canvas: evidence/quote cards, claim-and-source lower thirds, chart transitions, kinetic text, captions, timeline/progress markers, background plates and shot transitions. These templates consume `VideoVisualSpec` plus evidence references; Flash is a real-time nondeterministic preview, while Full produces reproducible stills or short segments. They are not presented as model-generated footage and must be labeled in the UI as LinkZag renderer output. A missing generative-video model therefore degrades a shot to an approved LinkZag template, fixture asset or explicit unavailable state; it must never silently claim that a model generated the shot.

`ComfyPackProvider` invokes the checked-out `modules/comfy/scripts/render.py` or its documented loopback execution contract, passes only validated local paths and parameters, captures the pinned pack commit/workflow/model identity, and stores outputs in a managed job directory. It must not pass RSS URLs, secrets or unapproved source content. Generated output licensing and required H3 attribution are recorded in the asset metadata.

Set `NIP_COMFY_DIR` to the checked-out Comfy pack directory when configured, for example `/home/ubuntu/fina-builder/modules/comfy`. This variable locates the pack only; capability detection must separately verify the ComfyUI endpoint, workflow/custom nodes, model weights, device backend and available resources. The absence of an OpenAI-compatible LLM endpoint must not be conflated with Comfy availability: claim extraction, ASR, TTS and generative video each report independent capability states.

The legacy Rehab Video Maker is not an adapter. Its `skills/tech-commentary-slideshow` and `skills/podcast-avatar-commentary` procedures are reference material for native implementation. If VRM support is later approved, fina-builder owns a new adapter contract that accepts a user-selected `.vrm`/`.glb` asset, verifies its hash and consent/license metadata, renders short shot-scoped outputs, records the model/runtime version and runs deterministic media QA. The legacy Python scripts are not called from the desktop product.

### 4.6 Timeline and QA

Start with a deterministic timeline JSON and FFmpeg render plan. `ffprobe` validates media streams, duration, dimensions, sample rate, channels and codec. A final MP4 export is available only when all required clips, audio, captions, evidence and license checks pass. The first export may use fixture media and a mock provider; live H3 output is an opt-in smoke, never a required CI dependency.

### 4.7 Analysis and capability states

Video V0 must not require a model-assisted NIP derivation. A retained transcript/document event can be selected directly, and the user can create human-authored narrative points or approve deterministic candidates. The implementation may expose a deterministic text baseline for sentence spans, dates, currencies, percentages, tickers, URLs, speakers, gazetteer entities, keyphrases, extractive summaries and lexical search. These outputs are candidates/observations, not authoritative claims. Optional local NER or relation extraction, such as a pinned ONNX model, is a separate provider with its own model hash and quality report; it does not replace narrative synthesis.

Persist and display operation-level states such as `ready`, `not_configured`, `runtime_unavailable`, `model_missing`, `consent_required`, `candidate_only`, `human_review_required`, `unsupported` and `failed`. LLM extraction, local ASR, TTS, generative image/video, LinkZag capture mode (`flash` real-time preview or `full` deterministic capture) and FFmpeg assembly must be independently reported. The UI must explain what was verified and what was not, for example: “Evidence and Full-mode deterministic visuals verified; no model-generated video was executed.”

## 5. Delivery phases

### V0 — contract and vertical-slice foundation

- Add video domain types, migrations, MCP contracts and frontend navigation.
- Create a project from one retained transcript/document NIP event and link available claims/evidence; do not require an LLM extraction run or doc 65 projections.
- Create a two-scene storyboard and three shots manually.
- Store revisions and evidence links; show the analysis mode and evidence status in the Video Workspace.
- Add mock assets and a LinkZag-compatible production plan with an explicit Flash/Full capture mode.

**Gate:** restart-safe persistence, evidence links, no raw source duplication, and passing browser/Tauri transport tests.

### V1 — planning and reusable asset system

- Add scene/shot editor, reusable asset registry, workflow registry, lineage display and project/episode review.
- Add a bounded, versioned `VideoVisualSpec`/chart asset contract for available NIP signal snapshots, transcript spans and approved claims, and compile only that supported subset to LinkZag scenes; do not persist arbitrary LinkZag scene JSON as the canonical business model.
- Extend LinkZag with commentary templates for evidence cards, quote cards, kinetic text, chart transitions, captions and scene transitions. Flash provides fast real-time capture by default; Full keeps deterministic frame capture for reproducible review, so visual video can be assembled without a generative-video model.
- Add job state/progress/cancellation and resource monitor.
- Export storyboard JSON, shot list, asset requirements, LinkZag scene files and timeline JSON.

**Gate:** every generated/planned asset has lineage; missing dependencies and unsupported capabilities are visible.

### V2 — optional local media execution and enhanced renderer

- Harden the isolated LinkZag renderer adapter for PNG, MP4, WebM and transparent overlay outputs, including the bounded commentary template library.
- Verify `segment.json` and import LinkZag outputs as evidence/lineage-bearing assets.
- Implement `ComfyPackProvider` for `t2i`, `i2v`/`t2v`, `tts`, `asr` only where the current pack supports the request and the configured runtime/model is ready.
- Add local-only capability detection, model/license disclosure, platform/device status and low-memory warning.
- Add success/failure/cancel/restart cleanup and safe playback through managed media URLs.
- Keep the mock path as the default deterministic test provider.

**Gate:** LinkZag adapter and commentary-template tests, Flash capture/provenance checks, and Full deterministic renderer smoke pass in CI or a provisioned renderer environment. Comfy remains an opt-in live smoke on a pre-provisioned machine. No claim of model-generation quality or cross-platform performance without measurements.

### V3 — QA, assembly and export

- Add deterministic QA report and severity model.
- Build EDL/timeline/FFmpeg plan and optional final MP4 export.
- Add subtitle/audio alignment and gap/missing-media checks.
- Add narrated Playwright demo for planning, mock generation, QA and export readiness.

**Gate:** reproducible fixture export, invalid-plan refusal, safe cleanup and artifact lineage.

### Later, separately gated

VRM/avatar studio, cloud video providers, music licensing integrations, model-assisted continuity/hallucination review, publishing APIs, multi-user collaboration, paper performance claims and automatic content publication. LinkZag itself is not deferred; its bounded renderer adapter is part of V2, while a deeper in-process import of its React packages is explicitly not planned.

## 6. Explicit non-goals

Do not turn Video Workspace into a generic node editor. Do not move NIP canonical evidence into a media store. Do not add provider credentials to the frontend. Do not scrape or bypass podcast/platform restrictions. Do not claim an asset is reproducible when the provider is nondeterministic. Do not label deterministic candidates as model-verified claims. Do not make doc 65 a prerequisite for Video V0. Do not ship generated investment advice, unverified financial claims, or an automatic publishing path. Do not make a live ComfyUI installation or multi-gigabyte model download a default app dependency.
