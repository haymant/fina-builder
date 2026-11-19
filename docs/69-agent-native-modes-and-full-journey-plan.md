# 69 — Agent-native FinA Builder: operating modes and full NIP-to-video plan

**Status:** Proposed architecture and delivery plan, 2026-11-19. This document describes target work; it does not claim the listed gaps are implemented.

## Executive decision

Build **one evidence-first production pipeline** with three interchangeable execution modes, not three separate product/data stacks:

1. **Embedded desktop AI:** fina-builder invokes configured local or remote model providers directly through host-owned capability adapters. No external agent or RIGA is required.
2. **Embedded RIGA reasoning:** NIP delegates selected reasoning tasks to a constrained, temporary RIGA run. NIP still owns source policy, validation, persistence, evidence and audit.
3. **External agent operation:** Manus, OpenCode or another authorized agent orchestrates the same stable NIP/Video/Comfy/LinkZag tools and skills. The desktop product must be agent-operable; this mode is also the cross-layer acceptance test that the app’s capabilities are explicit and not hidden behind UI-only state.

All three modes should share the same versioned inputs/outputs, jobs, validation, provider metadata, lineage, QA and export path. The mode selects **who orchestrates and which provider executes a capability**; it must not change what counts as canonical evidence or a valid production artifact.

Rehab Video Maker is the concrete reference for both the simplified storyboard and the agent-driven production workflow. The successful first Fina transcript-to-video E2E is a much smaller technical slice: it builds a three-beat candidate, renders through LinkZag and verifies evidence lineage. It does **not** establish storyboard or skill/tool parity with Rehab, and it is not a model of the desired full commentary workflow.

## Functional reference: Rehab's storyboard and agent-driven skills

Rehab is a **functional reference only** and is to be decommissioned. Its `tech-commentary-slideshow` consumes a simplified `format: "broll-slides"` JSON deck with top-level `slug`, `title`, `fps` and ordered `shots[]`. Each shot has an `id`, `kind` and exact `narration`, with optional on-screen text, quote/attribution/source, transitions, an existing visual asset or a structured visual hint/data payload. Its visual planner chooses whether a beat remains a card or becomes a chart, DAG, Petri net, Mermaid diagram, SVG, Markdown or existing b-roll. The content skill produces and edits the beat deck; production scripts validate it, make selected LinkZag scenes, synthesize per-beat narration, measure timing, generate captions, run audio/background/export QA, assemble the MP4 and produce a review sheet. Rehab's build command consumes the deck as a pipeline input, but the deck is a simplified storyboard contract—not the encoded MP4 or a substitute for the renderer, audio pipeline and assembler.

Fina-builder's goal is to **perform at least the same commentary-video tasks as Rehab and then extend them**, using Fina's own native storyboard, providers, APIs and agent-facing skills/tools. A comparable prompt should lead to source/research, commentary, an editable beat plan, visuals, narration, QA and final video in Fina. Preserve the useful storyboard concepts (ordered narration beats, visual choices, timing, language, transitions and asset intent), while adding native NIP evidence, claims/entities, revisioned production records, richer scenes/shots/audio, provider/jobs, lineage, QA and recovery. Because Rehab is being decommissioned, do **not** build Rehab-format import/export, round-tripping, runtime dependencies or compatibility adapters. Reuse its behavior as a checklist, not its schema as a Fina contract.

| Rehab reference capability | Fina parity requirement | Fina strict-superset additions |
|---|---|---|
| Prompt-led source research and independent commentary deck | A reusable `fina-commentary-video` skill/tools workflow from prompt through reviewable video | Use retained NIP source/event/transcript data, claims/entities and research projections; exact evidence spans and rights state |
| Deck metadata and ordered narration beats with kinds, on-screen text, quotes, sources, transitions and assets | Model/edit/validate equivalent user-facing storyboard capabilities through Fina's native schema | Persisted revision history, stable IDs, multi-scene/multi-shot relations, audio cues, evidence references, disclosures and provider requirements |
| Card, quote, title/end, b-roll, chart and selective animated technical visuals | Render at least the supported useful visual types with static/animated choices and a safe fallback | Bounded VisualSpec/provider registry, more layouts/layers, render budgets, per-asset provenance and deterministic-vs-generated labeling |
| Voice/TTS, measured beat timing, captions, audio QA, assembly and review sheet | A complete, truthful spoken-video production path, including unavailable-provider states | Multiple local/remote provider profiles, consent/rights, durable cue jobs, stronger evidence/lineage gates and restart-safe jobs |
| Agent skills/tools coordinate source → deck → visuals/audio → render → QA → optional release | A documented external-agent route can perform the same journey without hidden UI state or direct database access | The same operations are available in the desktop and agent surface; add NIP graph/Radar/event timeline, revisioned review, richer QA and export controls |

“Strict superset” here means functional capability. Fina should use its own versioned, revisioned contract. The user-visible skill should be comparable in completeness and ease: one prompt should coordinate source selection or an existing event, commentary drafting, storyboard review, narration/visual production, QA and final video, with publish actions remaining explicitly permissioned.

### Fina's storyboard and production artifacts

The native storyboard is an **editorial and production-coordination manifest**: an enhanced counterpart to Rehab's simplified deck, not merely a slide list. It describes how source-backed narrative beats are realized as scenes, shots, assets, visuals and audio, and refers to exact persisted revisions. Keep three connected artifacts:

| Artifact | Meaning | Primary consumers |
|---|---|---|
| **Storyboard manifest** (schema-versioned and Fina-native) | The editable source-backed beat plan: narration, kinds, on-screen content, optional quote/source/asset/visual hints, language, transitions and timing, expanded with exact evidence refs, scene/shot/audio cues, disclosures, render profile, provider requirements and dependency state. | Human editor, content/production skill, Video UI, external agent, planners and QA tools. |
| **Compiled render plan** (revision-pinned run artifact) | A validated derivation from the storyboard: per-shot LinkZag scene files, generated-media requests, caption/audio jobs, expected output contracts and dependencies. Includes hashes and compiler version. | LinkZag, Comfy or other typed provider adapters. |
| **Video edit timeline / EDL** | Exact clip/audio/caption placement, trims, overlaps, transitions, gaps and final export parameters after assets exist. | QA evaluator, FFmpeg assembler, export producer. |

The storyboard drives the production workflow in the same broad way Rehab's `slides.json` drives its scripts. Fina compiles its persisted storyboard to exact scene/shot and audio requests, then assembles validated outputs from an edit timeline; the manifest itself is neither raw pixels nor the MP4 encoder. The important distinction is not “storyboard versus video input,” but **editable directing plan versus derived render/assembly artifacts**.

The current browser-generated `fina-slides-v1` export currently contains only a deterministic three-beat candidate. Preserve the richer backend-owned Fina records, then replace the heuristic with a full native storyboard and a prompt-to-commentary journey whose render request references persisted storyboard/scene/shot revisions and whose production features meet and extend the functional baseline. No Rehab-format adapter is required.

### Proposed manifest shape (illustrative)

```json
{
  "schema_version": "storyboard.v1",
  "project": { "project_id": "…", "revision": 3 },
  "episode": { "episode_id": "…", "revision": 2 },
  "source_snapshot": {
    "as_of": "…",
    "event_ids": ["…"],
    "claim_run_ids": ["…"],
    "entity_snapshot_id": "…"
  },
  "creative_brief": { "audience": "…", "purpose": "…", "disclosures": ["…"] },
  "beats": [
    { "beat_id": "…", "order": 1, "intent": "…", "evidence_refs": ["event/claim refs"] }
  ],
  "scene_refs": [{ "scene_id": "…", "revision": 1, "beat_id": "…" }],
  "shot_refs": [{ "shot_id": "…", "revision": 2, "scene_id": "…", "order": 1 }],
  "audio_cues": [{ "cue_id": "…", "shot_id": "…", "kind": "narration", "text_ref": "…", "timing": "measured after synthesis" }],
  "asset_requirements": [{ "shot_id": "…", "kind": "diagram", "provider_policy": "deterministic_first" }],
  "render_profile_id": "commentary-720p-review-v1"
}
```

Avoid duplicating unbounded transcript text into the manifest. Use immutable NIP event/claim IDs plus exact offsets/quotes or a content hash, and store any authored narration as a derivation with its source references. A JSON export is a view of the persisted contract, not the source of truth.

## Three operating modes on one shared pipeline

| Concern | 1. Embedded desktop AI | 2. Embedded RIGA reasoning | 3. External agent operation |
|---|---|---|---|
| Orchestrator | fina-builder/Tauri host and NIP jobs | NIP calls a constrained RIGA adapter for selected steps | Manus/OpenCode/etc. calls versioned MCP/CLI/skill surfaces |
| Model calls | Direct local or remote typed provider adapters | Temporary RIGA run/session, isolated to an extraction task | Agent may reason itself or call explicitly selected external model tools |
| Canonical writes | NIP validates then persists; Video stores projections | Same; RIGA returns candidates only | Same; agents must not write DuckDB or bypass domain APIs |
| Privacy boundary | Host-held credentials, explicit per-provider remote consent | Consent bound to provider/profile/model before content leaves NIP; restricted session and strict cleanup | Tool scope and data-egress policy shown to agent; loopback service authenticated and never publicly exposed |
| Fallback | Deterministic NIP candidates, publisher transcript, LinkZag visual templates (Flash preview or Full deterministic capture); unavailable states remain visible | Use deterministic NIP path if RIGA is disabled only when the caller explicitly selects it; no silent fallback | Skill selects a declared fallback or returns a blocked/unavailable result; no fake success |
| Product role | Independently useful installed desktop | Optional reasoning backend | Portability/automation path and agent-native product quality gate |

**Scenario 3 is both a first-class usage mode and a quality guardrail.** Fina's documented skill/tool set must let an external agent perform at least the same prompt-driven commentary workflow as Rehab's content and production skills; it should additionally expose Fina's NIP and evidence-backed features. If the agent cannot discover capabilities, read back persisted records, start/poll/cancel jobs, inspect QA and obtain final lineage without internal-table access or hidden browser state, Fina has not met the product goal.

## Full evidence-to-video journey

```text
rights-approved source
  → bounded fetch / local import
  → episode + publisher transcript or approved ASR
  → immutable NIP event and normalized transcript spans
  → typed claims + entity mentions/resolution + review
  → event/claim graph + descriptive Radar + NIP event timeline
  → point-in-time evidence/projection snapshot
  → Video project / episode / narrative projection
  → storyboard manifest (editorial coordination)
  → persisted scenes and shots
  → compiled render plan and asset requests
  → deterministic visuals + optional generated video/audio assets
  → structural QA
  → edit timeline / EDL
  → LinkZag shot rendering + FFmpeg assembly
  → ffprobe, hashes, export manifest, lineage, review/playback
```

### 1. Fetch and retain source evidence

- Keep the existing source registry and rights/consent boundary. Podcast RSS discovery and publisher transcript references are real; other source types must not be presented as fetched merely because a generic source record can be created.
- Add bounded adapters incrementally (initially approved local documents and a reviewed filing/news source). Enforce allowed schemes/hosts, redirect and SSRF checks, rate and size limits, retention policy, provenance and deduplication.
- Store fetched media/transcripts as managed artifacts where appropriate; create the canonical immutable NIP event with publication time, ingest/known time, content hash, source ID and rights state. Video references that event rather than owning a second transcript copy.

### 2. Transcribe and normalize

- Prefer a publisher-provided transcript where the source contract allows it; otherwise offer an explicitly configured local ASR path (currently the Comfy/Qwen ASR adapter is optional, not a bundled runtime). Preserve word/segment timing, speaker labels where available, language and ASR provenance.
- Keep the deterministic fixture path for CI. A missing local model/runtime must produce `runtime_unavailable`/`model_missing`, not an implicit remote upload.
- Distinguish temporary ASR staging from retained replay cache, show retention, and test deletion/cleanup on success, failure, cancellation and restart.

### 3. Claims and entities

- Extend current free-text claims into versioned annotations: claim type, exact evidence span, speaker/attribution, certainty, polarity/horizon where justified, entity IDs, resolver version, novelty key, extraction run and review status.
- Entity resolution is deterministic-first (exact ticker/alias, normalized alias), then an optional model/provider suggestion, then a human resolution queue. Unresolved mentions remain unresolved; do not guess an entity.
- Require quotes to match source text at the claimed offsets. Allow a successful zero-claim result. Persist window/sample coverage so a partial extraction cannot look complete.
- Use document 65’s gates as the design proposal: reviewed precision before scaling, bounded claims per episode, versioned re-annotation, `known_at`/`as_of` semantics, and visible missing coverage. Do not claim entity-level analytics until those contracts and migrations exist.

### 4. Construct graph, Radar and NIP timeline

Keep these as separate NIP research projections, not Video objects:

- **Graph:** source events, claims, entity mentions, co-mentions, restatements, supersessions, support/contradiction, and narrative membership; edges retain derivation version and evidence.
- **Radar:** descriptive, point-in-time entity/source signals (volume/velocity, novelty/restatement, direction only when supported, source dispersion and coverage). Label it research, not investment advice. Unknown/partial coverage is explicit; no score should hide missing sources.
- **NIP event timeline:** dated events/claims with publication time, known time, evidence and uncertainty. It is distinct from the later Video edit timeline/EDL.

The existing graph, Radar and Timeline UI is useful scaffolding, but current graph nodes are event/claim/cluster centric, and Radar/Timeline reuse weekly narrative snapshots with unknown coverage. The doc 65 typed entities/features are still future scope. Implement the evidence model and coverage first, then enrich visualizations.

### 5. Create Video projection and storyboard

- A Video Episode pins a set of exact NIP event/claim/entity/projection revisions and an `as_of` snapshot; it is a production view, not canonical research truth.
- A Narrative is an authored editorial treatment. Every assertion/quote/narration claim links back to event/claim spans; interpretation and disclosure are labeled separately.
- The Storyboard Manifest coordinates beats, scene/shot references, audio cues, visual intent, transitions, timings, required/selected assets, disclosures and the target render profile. It is persisted and revisioned; tools can list/read it back.
- Scene and shot records are first-class, revisioned child artifacts with evidence, timing, visual/audio requirements and status. A scene may contain multiple shots; a shot may use multiple layers/assets. Do not force one slide = one scene = one shot.
- An agent may propose a storyboard or revisions, but deterministic validators check hierarchy, timing, evidence references, unsupported capability requests and project ownership before persistence.

### 6. Generate/resolve assets and audio

- Route capabilities independently: transcript/claim LLM, ASR, entity suggestion, still-image generation, video generation, TTS, music, deterministic diagrams and assembly each have their own readiness, provider/model/license, consent, estimated time/resource and provenance.
- `modules/comfy` is an independent workflow pack and currently wired into NIP for ASR; its CLI has broader modes, but fina-builder has not yet implemented Video TTS/image/video provider adapters. A CLI existing in a submodule is not proof that an app adapter or model is available.
- Support official/approved remote adapters (e.g. Google Flow/Veo) only after confirming the real API or allowed agent-operated workflow, account permissions, terms, data egress and asset licensing. Keep credentials out of React, the prompt, and manifests. Until then, report unsupported/unconfigured rather than implying integration.
- Optional local speech providers should be capability-detected: e.g. macOS `say` or a selected Linux speech executable/model. Persist voice/language/runtime and measured audio duration. If no speech tool is installed, keep cue text/captions and label the render silent; never silently synthesize or switch to cloud.
- Generated assets carry upstream storyboard/shot IDs, prompts/parameters, provider/model/workflow version, content hash, rights/license state, job/run ID, deterministic flag and evidence links. Nondeterministic outputs are not called reproducible.

### 7. Compile, QA, assemble and export

- A deterministic compiler turns a pinned storyboard revision plus available asset revisions into a `RenderPlan`. For LinkZag it emits validated scene files for individual shots/layers; for model providers it emits separate typed generation jobs; for audio it emits timed cues/jobs.
- `LinkZagShow` is a browser renderer for charts, diagrams, typography, captions and motion graphics; it is not a generative footage provider. Its default Flash mode uses Playwright `recordVideo` with Canvas ECharts for speed and fixed-rate MP4 output, but can drop frames on slow CPUs and is explicitly marked as a real-time preview, not deterministic. Full mode retains timestamp-seeked PNG capture with SVG charts for reproducible review/export. The Video Workspace and agent tool expose both modes; manifests record mode, chart backend and determinism.
- Implement actual QA evaluation (current QA records/tools persist reports only): missing media/evidence/audio, orphan claims, unsupported provider, incomplete/partial source coverage, invalid timings, gaps/overlaps, duration and dimension limits, codec/audio streams, caption alignment, license/rights and managed path/hash verification. Block export on policy/evidence/dependency blockers; warnings remain inspectable.
- Compile a Video edit timeline/EDL from persisted shot and asset revisions. FFmpeg assembly consumes that timeline, not the Storyboard JSON or raw VisualSpecs alone. Probe final output, compute hashes, write export manifest and lineage atomically. The final clip must remain traceable `export → EDL → render plan → shot/scene/assets → storyboard/narrative → NIP snapshot → event/claim evidence`.

## Common execution and security contracts

Introduce capability-specific adapters rather than a single generic “AI provider” switch:

- NIP extraction: `ClaimExtractionProvider`, entity-resolution suggestion provider.
- Media processing: `AsrProvider`, `VoiceGenerationProvider`, image/video generation providers.
- Visual rendering: `DiagramRenderer`/`LinkZagRenderer`.
- Assembly: deterministic timeline/FFmpeg compiler.

Every invocation should create a durable `DerivationRun`/job record with exact input IDs, revisions and hashes; schema/prompt/compiler version; provider/profile/model/workflow; local/remote and data-egress policy; consent binding; start/end/status; sampled/omitted coverage; resource estimate; output IDs/hashes; validation result; deterministic/reproducibility status; license/policy metadata; and safe error. Store secrets only in the host or an approved connector. The external agent receives typed tool responses, never DB access or provider credentials.

For RIGA claim work, NIP should bind the request to the exact consented provider/profile/model before any transcript is sent. Use a constrained extraction run with no shell, filesystem, web, MCP, subagent or memory tools; no prior chat history; structured schema; no RIGA-side canonical writes; and reliable cleanup of session history, journals, knowledge and worktree. NIP verifies quote/span and coverage, then commits accepted records. Current RIGA integration has a temporary session per transcript window, but not yet a sufficiently constrained, cleanup-proven extraction product mode.

For external agents, keep one DuckDB writer. The desktop’s NIP sidecar is loopback-bound with a process-scoped ephemeral port; do not start a second `nip-engine` against the same database, publish/tunnel the sidecar, or let an agent write tables. Provide an authenticated, scoped bridge or explicit single-owner standalone NIP process. Add list/get/readback for persisted storyboard/scene/shot/evidence revisions, capability/resource status and jobs before publishing a production skill.

## Current gaps by mode

| Gap | Impact | Required response |
|---|---|---|
| A loopback-only, environment-configured direct local NIP claim provider now exists; packaged provider settings, remote profiles and direct media-model adapters remain open. | Scenario 1 can begin NIP claim extraction without RIGA, but the self-contained desktop/media journey is still incomplete. | Add desktop settings/model readiness, then consent-bound remote profiles and direct Comfy speech/image/video adapters; keep every unavailable capability explicit. |
| Tauri bundles the NIP sidecar, not ComfyUI, model runtimes or weights. | “Self-contained AI desktop” is not yet true/offline. | Decide between managed optional runtime/model download and supported user-installed loopback runtime; publish per-capability offline status. |
| Entities/typed claim relations/entity temporal features are draft only. | Entity radar/graph/timeline cannot yet meet the requested semantics. | Implement doc 65 P0/P1 schema/quality gates before entity feature claims. |
| RIGA extraction uses a general autonomous run path and free-text JSON parsing. | Tool scope, privacy cleanup, exact provider binding and span correctness are not yet strong enough. | Build the constrained ephemeral extraction mode and negative tests before relying on it. |
| Current storyboard/render boundary is incomplete. | The browser flow creates only three fixed beats, and audio cues/evidence do not fully persist/read back. | Define Fina's native full-featured storyboard contract; persist/read back the plan, add evidence links to scene/shot, then compile an exact RenderPlan. |
| QA/timeline/export tools are persistence-only. | No real blocker evaluation or general EDL/export pipeline. | Implement evaluators/builders/producers before describing the editor as production-ready. |
| No Video TTS/image/video provider is wired; capability report is largely static. | Current video is silent; Comfy CLI availability is not app capability. | Add truthful capability discovery and one provider at a time; test licensed, loopback-only or approved remote execution. |
| External-agent surface is incomplete. | An agent cannot safely complete a Rehab-equivalent prompt-to-commentary journey through stable tools; current MCP configuration does not expose the complete NIP/Video workflow. | One-writer bridge, auth/scope, missing readback operations, a Fina commentary skill at least as capable as Rehab's skill/tool set, and tool-only E2E. |
| Resource admission and paths need hardening. | Concurrent agents can saturate CPU or submit invalid asset paths. | Bound concurrency/device usage, estimates and cancellation; validate managed paths/hashes/symlinks. |

## Prioritized delivery plan and gates

### P0 — Freeze shared contracts and functional capability baseline

1. Use Rehab's storyboard and the end-to-end `podcast-content-agent` → `tech-commentary-slideshow` workflow as a read-only functional checklist; Rehab is not a runtime or interoperability target.
2. Define Fina's native storyboard contract to cover the same user-facing capabilities and extend them with Fina evidence/production records. Approve the connected artifact flow: Storyboard Manifest → Compiled Render Plan → Video Edit Timeline/EDL.
3. Define `DerivationRun`, provider capability state, consent binding, deterministic/preview profiles and explicit ownership of NIP vs Video data.
4. Define MCP/API errors, pagination, idempotency, readback and job contracts. Document the single-writer sidecar boundary.

**Gate:** schema/API and functional-parity review; Fina-native fixtures cover the reference use cases; no UI-only source of truth, agent database writes or hidden provider fallback.

### P1 — Complete canonical NIP evidence and extraction

1. Harden publisher-transcript/local-ASR fetch and retention/cleanup paths.
2. Implement typed claim annotations, span validation, zero-claim and partial-coverage semantics, versioned runs and human review.
3. Implement entity/alias IDs and unresolved review queue; require measurable precision before scaling.
4. Add/extend bounded source adapters only after rights, retention, domain and SSRF review.

**Gate:** every claim exactly matches evidence; precision and entity resolution measured on reviewed samples; consent cannot be bypassed by provider re-resolution; reproducible as-of reads.

### P2 — Build explicit NIP projections

1. Build versioned claim/entity relations and evidence graph.
2. Build an event/claim NIP timeline with publication and known-at times.
3. Build coverage-aware descriptive Radar and entity feature snapshots; surface missing sources and unresolved entities.
4. Keep trade-signal research separate and do not label descriptive features as validated signals.

**Gate:** deterministic recompute, no point-in-time leakage, visible coverage, reviewed graph/entity precision.

### P3 — Make all three execution modes capability-equivalent

1. Add the NIP-owned direct provider port for local and consented remote LLMs; scenario 1 must pass with RIGA disabled.
2. Add a constrained RIGA adapter for scenario 2; scenario 2 must pass with direct provider disabled.
3. Add an authenticated external-agent bridge/tool suite and a `fina-commentary-video` skill for scenario 3. Its prompt-led sequence must cover the same source/research, commentary, storyboard, narration/visual, QA and assembly stages as Rehab, then extend them with Fina NIP evidence and review features.
4. Add resource admission, per-provider readiness, secret boundary, cancellation and provider provenance.

**Gate:** run equivalent prompt-driven fixture journeys through direct local/mock, consented remote, RIGA-constrained and external-agent plans; the external-agent path must achieve Rehab-baseline storyboard/production outcomes plus Fina lineage, with the same validation policy across modes.

### P4 — Implement Fina's native full-featured storyboard and compile it

1. Support Rehab's beat-deck concepts: ordered IDs, kinds, narration, on-screen/title/end content, quote/attribution/source, existing visual assets, visual hints/data, transitions, language, FPS and timing.
2. Extend that baseline with a backend-owned, revisioned `StoryboardManifest`: exact evidence refs, scene/shot revisions, multi-shot timing, audio cues, captions, asset/provider requirements, disclosures and review state.
3. Add get/list/readback and optimistic revision checks; add Fina-native fixtures for ordinary cards, quotes/evidence spans, charts, diagrams, existing b-roll and localization.
4. Add complete scene/shot evidence and audio-cue persistence; implement a deterministic compiler to a pinned `RenderPlan`, with render tools accepting plan ID/revision rather than in-memory VisualSpecs alone.

**Gate:** Fina-native fixtures demonstrate the baseline storyboard and production capabilities plus Fina extensions; an external agent can close/reopen the project, read back exact Fina revisions, and reproduce the same render plan hash.

### P5 — QA, assets, timeline and final export

1. Implement real deterministic QA evaluators and blocker policy.
2. Generate the Video edit timeline/EDL from saved shots and selected/generated assets.
3. Add LinkZag renderer profiles, bounded Comfy asset/TTS providers and approved remote video provider adapters as independent capabilities.
4. Assemble through FFmpeg, validate streams/timing/rights, and register export manifest/hash/lineage atomically.

**Gate:** fixture media export passes; invalid dependencies block; missing providers stay unavailable; slow CPU mode is bounded, cancellable, and accurately labeled.

### P6 — Desktop and agent acceptance matrix

1. Verify packaged Tauri install, first run, restart, data migration and offline behavior on each supported OS; opt-in model/runtime install remains separate from core app install.
2. Run equivalent end-to-end prompt journeys against the same fixture: (a) desktop with direct provider; (b) RIGA-constrained claim run; (c) external agent using only the documented Fina skill/tools. Confirm the third route reaches at least the Rehab commentary-video baseline plus Fina evidence/lineage output.
3. Include negative cases: no remote consent, model missing, ASR unavailable, zero claims, partial source coverage, failed cleanup, unavailable Veo/Comfy, slow CPU, missing audio, invalid asset license and interrupted job.
4. Review sample media for evidence fidelity, timing, audio/video sync, captions, disclosures and artifact lineage.

**Release gate:** a complete prompt/event-to-final-video journey is possible in each supported mode; the external-agent skill/tool set is a strict superset of Rehab's relevant commentary workflow; unsupported capabilities do not masquerade as output; every final file can be traced back to exact evidence and generation/render runs.

## Immediate next steps

1. **Implemented:** the Video Workspace lists retained claims for a linked event, shows claim text separately from exact transcript evidence, permits only exact-span-backed choices, and builds/persists from explicit selections only. With no eligible selection it does not substitute generic beats. Unit and browser journey verification pass.
2. **First Mode 1 provider slice:** a direct local loopback-only NIP claim route is implemented behind host configuration, independent of RIGA. Complete its Rust contract/security tests and retain no-fallback, exact-model readiness and exact Unicode-span validation; this environment-configured route is not yet a packaged provider settings/runtime experience.
3. Add a desktop settings flow for local provider selection/readiness, plus an explicit opt-in runtime/model installation story for supported platforms. Keep the local route usable without RIGA.
4. Add consent-bound remote model profiles only after provider/profile/model/operation identity, host-held credentials, content-egress disclosure, revocation and negative tests are bound end to end.
5. Expand the claim-driven draft into Fina's full storyboard → pinned RenderPlan → VideoEditTimeline/EDL path, with scene/shot/audio readback and complete review controls.
6. Wire Comfy TTS, image and video workflows as separately capability-detected direct providers, with real readiness, managed outputs, license/provenance and QA; retain explicit unavailable/silent states.
7. Preserve the Mode 3 external-agent route as a parity guardrail; broaden its verified fixture journey only when the same new Mode 1 operations are exposed through stable tools.

## Existing references

- Decommissioning Rehab reference (functional requirements only): `modules/rehab-video-maker/skills/podcast-content-agent/SKILL.md`, `modules/rehab-video-maker/skills/tech-commentary-slideshow/SKILL.md`, `modules/rehab-video-maker/skills/podcast-youtuber-agent/SKILL.md`, and their scripts/tests.
- [65 — entity, claims, features and signal research](./65-entity-claims-features-signal-research.md)
- [66 — Video Workspace alignment and implementation plan](./66-video-workspace-alignment-and-implementation-plan.md)
- [67 — Video Workspace testing plan](./67-video-workspace-testing-plan.md)
- [68 — Video Workspace handoff and measured transcript-to-video E2E](./68-video-workspace-handoff.md)
