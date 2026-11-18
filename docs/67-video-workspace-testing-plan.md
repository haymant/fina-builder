# 67 — FinA Builder Video Workspace: implementation test plan

**Status:** Proposed verification plan, aligned to docs 55–65 and the corrected implementation plan in doc 66. It distinguishes deterministic CI checks from opt-in local ComfyUI/model tests and packaged-desktop checks.

## 1. Test principles

1. Test the production control plane before testing expensive generation. A project, storyboard, shot list, asset lineage, QA report and timeline must work with fixture evidence and mock media.
2. Treat NIP DuckDB as the authoritative source for source events, claims and evidence. Video records are versioned projections/production records and must never silently mutate an event or claim.
3. Use only synthetic or rights-cleared fixture text, audio, images and video in CI and narrated demos. No public feed, remote model, provider credential or commercial asset is used by default.
4. Every interpretation and generated narration must be traceable to event/claim evidence. Tests fail if a scene or shot has no evidence reference unless it is explicitly marked as non-evidence production material.
5. Test unsupported, unavailable, partial, stale, cancelled and failed states as first-class outcomes. An unavailable provider must not become a fake success.
6. Keep large media outside Git and DuckDB. Tests use disposable `playwright/.data/` or temporary media roots and verify cleanup.

## 2. Requirements-to-test matrix

| Requirement | Acceptance evidence |
|---|---|
| Native Video Workspace | Tauri/browser navigation tests open Video Workspace without changing existing dashboard, trade or Narrative routes. |
| Project → Episode → Narrative → Scenes → Shots | Rust domain/store round-trip plus UI journey creates and reopens the hierarchy after service restart. |
| Evidence-first narrative | Every scene/shot narration record contains event/claim IDs; UI opens the source evidence. Negative test rejects orphaned generated narration. |
| Reusable assets | Asset registry supports reuse by ID, content hash and lineage; deletion is blocked when referenced by a shot/timeline. |
| Provider abstraction | Mock provider and LinkZag renderer pass contract tests; Comfy adapter is tested with a fake loopback/CLI server; frontend never calls a provider directly. |
| Reproducibility | Manifest includes prompt, model, parameters, workflow/version, pack commit, upstream IDs, content hashes, timestamps and provider limitations. |
| Async generation | Start returns a job ID; progress, retry, cancel, failure and restart recovery are observable; no request blocks the NIP service. |
| QA | Invalid dependency, duration, missing media, bad stream and evidence coverage are reported with severity and block export when required. |
| Assembly | Timeline JSON, LinkZag scene/segment manifest, EDL and FFmpeg plan are deterministic for the same inputs; fixture export produces valid PNG/MP4/WebM/MOV or a clear unsupported-format error. |
| Local Comfy support | Optional live smoke proves one small image/video/TTS/ASR path only on a pre-provisioned loopback ComfyUI; no default CI dependency. |
| License/policy | H3 attribution/model license state is retained; publishing/export is blocked when required policy metadata is absent. |

## 3. Rust unit and integration tests

### 3.1 Domain validation

Add tests for:

- project title/language/platform/target-duration validation;
- scene half-open timing and non-negative durations;
- shot duration within scene bounds;
- stable IDs and revision increments;
- evidence references to existing event/claim IDs;
- explicit `draft`, `ready`, `blocked`, `running`, `succeeded`, `failed`, `cancelled` states;
- unsupported provider/capability represented as `unavailable`, not successful output;
- no raw transcript duplication in Video records when an event reference is sufficient.

### 3.2 DuckDB persistence

Use a disposable database and test:

- migration from the current schema and from an empty database;
- migration from the current NIP schema version 10 through the coordinated Video migration, including reopen and Parquet/restore checks;
- project/episode/narrative/storyboard/scene/shot round-trip;
- immutable revision behavior and optimistic conflict detection;
- evidence-link validation and point-in-time/as-of preservation;
- asset metadata, relative media path and content hash persistence;
- workflow registry versioning and provider capability lookup;
- job reports, progress events, cancellation and restart recovery;
- QA reports and timeline manifests;
- deletion/refusal rules for referenced assets and projects;
- Parquet/export manifest behavior if video metadata is included in a controlled snapshot;
- no writes to TAC root or market partitions and no use of the trade repository `DATABASE_URL`.

### 3.3 Provider contract tests

Define one shared contract suite and run it against `MockProvider`, `LinkZagRenderer` and the Comfy adapter:

- accepts validated requests and returns a job/output manifest;
- rejects missing prompt, unsupported capability, invalid dimensions or excessive duration;
- records model/provider/workflow/parameters and upstream hashes;
- never receives provider secrets from the request;
- never receives an RSS URL or unapproved source locator;
- returns bounded, typed errors for unavailable server, missing workflow, timeout, cancellation and malformed output;
- output paths remain inside the managed job media root;
- retry is idempotent or creates a new explicit attempt ID;
- cleanup runs on success, failure, timeout, cancellation and process restart.
- provider child processes are cancellable, bounded by the resource policy, and do not block the single DuckDB writer.

For `LinkZagRenderer`, additionally verify:

- generated YAML/JSON/Markdown scenes pass the pinned submodule schema;
- local scene assets are resolved without network requests;
- `data-linkzag-ready` is reached before capture;
- repeated capture of the same scene/time/options produces byte-identical PNGs on the same machine;
- transparent `item` scenes use WebM/MOV or an explicit MP4 matte, never silent alpha loss;
- `segment.json` checksum, dimensions, duration, formats and ffprobe metadata agree with imported assets when using `segment`; `capture`, `render` and `video` use and validate their own documented output/ffprobe metadata;
- Mermaid, ECharts, XYFlow, Markdown, code and image items remain deterministic for the supported subset;
- renderer process failures, readiness timeouts and malformed manifests become typed job failures.

For the legacy `modules/rehab-video-maker`, do not run its scripts as fina-builder product tests. Instead, port and unit-test the concepts relevant to native contracts: measured narration duration, frame-grid quantization, caption bounds, per-shot avatar budgets, source/attribution fields, review-sheet findings and AI-avatar disclosure.

### 3.4 Media and QA tests

With tiny fixture media:

- inspect audio/video streams through `ffprobe`;
- detect missing files, unsupported MIME, invalid duration, resolution mismatch, absent audio and corrupt containers;
- detect timeline gaps/overlaps and subtitle timing outside the clip range;
- validate deterministic chart render specifications and source signal references;
- create a fixture MP4 through FFmpeg and verify the output hash/metadata;
- reject a render plan containing unresolved asset or evidence dependencies;
- verify safe media URL/path traversal protection;
- validate imported LinkZag `segment.json` manifests and reject an output whose scene checksum or ffprobe data does not match;
- verify a VRM/GLB asset import records hash, consent/license state and model metadata without requiring the legacy module.

## 4. Frontend component tests

Use Vitest and Testing Library under `src/features/video/__tests__/`.

1. Project list renders loading, empty, populated, stale and service-unavailable states.
2. Project creation validates required title, platform, audience and target length.
3. Episode evidence picker lists retained NIP events and claims with source/time labels.
4. Storyboard editor adds/reorders scenes and refuses invalid overlapping timings.
5. Shot planner displays narration, visual intent, evidence, asset requirements and provider capability state.
6. Asset library shows preview, hash, lineage, model/workflow, license state and dependency count.
7. Provider panel distinguishes mock, Comfy unavailable, Comfy ready, unsupported and failed states.
8. Job monitor shows progress, elapsed time, cancellation, retry, output artifacts and safe error detail without transcript leakage.
9. QA panel renders blocking versus advisory findings and links each evidence finding back to the source event/claim.
10. Timeline panel displays gaps, missing assets, audio/video durations, EDL/FFmpeg plan and export readiness.
11. LinkZag-backed diagram/scene output displays format, transparency, checksum, duration and renderer readiness.
12. No-provider and no-Comfy states provide a next action rather than a dead generation button.
13. Existing Narrative, trade and dashboard component tests remain unchanged and pass.

## 5. MCP and transport tests

Test every `video_*` tool through the same typed Streamable HTTP and stdio conventions used by NIP:

- initialize/session negotiation;
- structured success and typed error envelopes;
- list/get consistency after mutations;
- long-running job start/status/cancel;
- same-origin Vite proxy path `/nip/mcp`;
- Tauri IPC bridge uses process-scoped NIP configuration;
- browser code cannot reach a private Comfy port directly;
- provider secrets never appear in tool output or diagnostics;
- repeated calls do not duplicate projects, assets or jobs without a new revision/attempt.

## 6. Playwright journeys

All journeys use deterministic fixtures and disposable directories.

### Journey V — evidence to storyboard

1. Open Video Workspace from the app menu.
2. Create a project from a retained fixture event.
3. Select two claims and verify source evidence/time labels.
4. Save a three-scene storyboard and four-shot plan.
5. Reopen the project and confirm the same revisions and evidence links.
6. Navigate from a scene/shot back to the immutable event and Claim Explorer.

### Journey V2 — mock production

1. Start a mock asset generation job from a shot.
2. Observe queued/running/progress/succeeded states.
3. Inspect asset lineage and reusable asset selection.
4. Cancel a second job and verify cleanup.
5. Run QA; show a warning for an advisory issue and a blocker for missing media.
6. Fix the dependency and rebuild the deterministic timeline/EDL/FFmpeg plan.
7. Export a fixture MP4 and verify it is playable and linked to the project revision.

### Journey V2a — deterministic LinkZag segment

1. Turn an NIP signal/chart specification into a local LinkZag scene.
2. Preview the scene through the bounded renderer adapter.
3. Capture a still and a short segment with a fixed time/FPS/format.
4. Verify the command-appropriate manifest (`segment.json` for a package, frame manifest for capture, or still/ffprobe metadata for render/video), scene checksum, media metadata and evidence links.
5. Repeat the capture and verify deterministic output or a documented OS-font tolerance.
6. Select a transparent overlay and verify WebM/MOV output or explicit MP4 matte guidance.

### Journey V3 — unavailable and recovery states

1. Run with no ComfyUI endpoint and verify the UI says local generation is unavailable.
2. Run with a fake Comfy endpoint that reports missing nodes/model and verify actionable blockers.
3. Stop the fake provider during a job; verify failure, cleanup and retry.
4. Restart NIP and verify project/job/artifact metadata survives without duplicate output.

### Journey V4 — source policy boundary

1. Attempt to create a Video Episode without a source event or rights-permitted source; verify refusal.
2. Link a permitted fixture event and proceed.
3. Verify no provider request occurs for a blocked source.
4. Verify raw source text and credentials are absent from logs, screenshots and artifact manifests.

### Journey V5 — optional avatar asset boundary

1. Import a user-selected `.vrm`/`.glb` asset from a managed path.
2. Require explicit owner/consent and license metadata before using it in a shot.
3. Show the avatar provider as unavailable when no approved native adapter is installed.
4. If a future adapter is enabled, render only a short fixture shot, record model/runtime/seed metadata, run identity/stream/timing QA, and show AI-avatar disclosure.
5. Confirm the journey never invokes `modules/rehab-video-maker` scripts and never copies private avatar files into Git.

### Narrated demo

The narrated demo should show the shortest meaningful path: Narrative evidence → Video project → storyboard → shot plan → mock asset → QA finding → deterministic timeline/export readiness. It must label fixture/mock output and must not present a generated financial statement as verified fact. A separate opt-in recording may demonstrate local Comfy readiness; it must include platform, model, workflow, license and duration disclosure.

## 7. LinkZag submodule smoke

Run the renderer smoke against the pinned `modules/linkZagShow` commit in a disposable output root:

```bash
git -C modules/linkZagShow rev-parse HEAD
cd modules/linkZagShow
npm ci
npm run typecheck
npm run test
npm run build
npm run segment -- --scene content/scenes/agentic-coding.yaml --format png,mp4 --out /tmp/linkzag-smoke
ffprobe -v error /tmp/linkzag-smoke/agentic-coding.mp4
```

The fina-builder adapter must invoke this contract without importing the submodule's React packages into the parent bundle. The smoke is required for the LinkZag adapter gate but uses the submodule's own tests for renderer correctness.

## 8. Opt-in local ComfyUI smoke

Run only on a machine with ComfyUI Desktop, models and custom nodes pre-provisioned. Keep the server on loopback.

Required checks:

- `bash modules/comfy/scripts/setup_desktop.sh --check` reports the expected device/backend;
- `python3 modules/comfy/scripts/render.py --dry-run ...` produces the expected patched API graph;
- one small `t2i` or low-memory video fixture succeeds;
- one local `tts` or `asr` smoke succeeds if speech is enabled;
- generated files are imported into the managed artifact registry with hashes and pack commit;
- failure/cancellation cleanup is verified;
- H3 attribution and model-license metadata are retained;
- runtime duration, memory/device and output properties are recorded without claiming a cross-platform SLA.
- the provider job can be cancelled without leaving a child process or temporary media behind.

Platform matrix: Apple Silicon/MPS, NVIDIA/CUDA, AMD/ROCm where the installed ComfyUI build supports it, and CPU only for reduced/speech/image checks. CPU H3 video hours-long behavior is a documented limitation, not a CI timeout to hide.

## 9. Release gates

### V0 foundation gate

All Rust domain/store/transport tests, frontend tests, existing NIP journeys and evidence-to-storyboard Journey V pass. No live model required.

### V1 planning gate

Asset lineage, workflow registry, job state, QA report, deterministic LinkZag scene/segment exports and timeline exports pass with mock providers. Restart and path-safety tests pass.

### V2 deterministic media and local generation gate

The LinkZag submodule smoke and adapter contract pass. If local Comfy is enabled, its opt-in smoke passes on the target platform; missing prerequisites remain visibly unavailable; cleanup and license metadata pass. No cloud provider is implied.

### V3 export gate

Fixture MP4/EDL/FFmpeg output passes `ffprobe`; blocking QA findings prevent export; narrated demo is reviewed; source/evidence links remain inspectable from every production artifact.

## 10. Commands

Baseline before Video Workspace changes:

```bash
export PATH=/usr/local/rustup/toolchains/1.97.1-x86_64-unknown-linux-gnu/bin:$PATH
export RUSTC=/usr/local/rustup/toolchains/1.97.1-x86_64-unknown-linux-gnu/bin/rustc
cargo fmt --all -- --check
cargo test -p nip-domain -p nip-store -p nip-engine
cargo clippy -p nip-domain -p nip-store -p nip-engine --all-targets -- -D warnings
npm run build
npm run test:run -- src/features/narrative src/features/workspace
PLAYWRIGHT_NIP=on npm run test:e2e:journey:narrative
```

After Video Workspace implementation, add focused commands such as:

```bash
npm run test:run -- src/features/video
npx playwright test playwright/video-workspace.spec.ts
npm --prefix modules/linkZagShow run test:all
VIDEO_COMFY_SMOKE=1 npx playwright test playwright/video-workspace-comfy.spec.ts
```

The last command must be opt-in and must fail clearly when prerequisites are absent; it must never silently downgrade to a fake provider.
