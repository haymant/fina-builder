# Video Workspace takeover handoff

## Scope

This handoff continues the Video Workspace implementation in `fina-builder`. The product is a native bounded production domain, not a generic canvas. The intended flow is:

`Project -> Episode -> Narrative -> Storyboard -> Scenes -> Shots -> Assets -> QA -> Assembly -> Export`

NIP events, transcripts, claims, and evidence remain canonical. Video records are projections with lineage back to those records. `modules/comfy` is the execution boundary for optional local ASR/TTS/image/video workflows. `modules/linkZagShow` is invoked through a process-isolated adapter; its React packages are not imported into the parent bundle. `modules/rehab-video-maker` is a legacy/native-only reference boundary and must not be used as the Video runtime.

Doc 65 (`entity-claims-features-signal-research.md`) is intentionally future work. Do not make it a prerequisite for Video V0/V1 and do not duplicate its future entity/feature tables in the Video migration.

## Completed in this handoff

### Durable Video jobs

- Added typed `VideoJob` state with `queued`, `running`, `succeeded`, `failed`, and `cancelled` lifecycle states.
- Persisted progress, cancellation request, resource estimate, visual-spec input payload, output manifest, safe error, retry/recovery timestamps, and input revision.
- `render_video_linkzag` now queues a job and returns immediately.
- Added MCP surfaces for `video_job_status`, `list_video_jobs`, `cancel_video_job`, and `retry_video_job`.
- LinkZag child processes are cooperatively polled and killed on cancellation.
- Retry creates a new auditable job attempt while retaining the original failed/cancelled attempt.
- Startup recovery marks active jobs left by a process restart as failed with the safe message `job interrupted by service restart`.

### Retention

- Added `Store::cleanup_video_jobs(before)` to delete old terminal `succeeded`, `failed`, and `cancelled` records while preserving active jobs.
- Startup applies retention automatically. The default is 30 days and is configurable with `NIP_VIDEO_JOB_RETENTION_DAYS`, clamped to 1–3650 days.
- Output assets remain separately registered; cleanup removes old job metadata, not lineage-bearing assets.

### UI recovery experience

- The Video Workspace shows an in-context job banner with status, durable progress, job ID, and cancellation state.
- Active jobs expose `Cancel`.
- Failed/cancelled jobs expose `Retry job`.
- Success imports the registered asset and shows the asset ID in the banner and asset library.
- Error messages are actionable and distinguish renderer failure, cancellation, retry failure, and unknown/pending state.

### Integration and demo coverage

- Added a DuckDB restart simulation that closes and reopens the database while a job is `running`, then verifies recovery preserves progress, input revision, and safe failure state.
- Added a fixture-backed Playwright journey in `playwright/video-workspace-demo.spec.ts` that covers:
  1. podcast episode discovery;
  2. transcript commit;
  3. event search;
  4. claim extraction and claim listing;
  5. Video project creation;
  6. episode creation;
  7. canonical evidence linking;
  8. three-scene storyboard and shot persistence;
  9. asynchronous LinkZag job polling;
  10. deterministic asset registration.
- Added `@demo-video-workspace`, `@journey-video-production`, and `@feature-video-workspace` classifications.
- Captured and narrated the passing journey. Final artifact:
  - `playwright/recordings/video-workspace/video-workspace-demo.mp4`
  - H.264, 1280x720, AAC stereo, 25.20 seconds, non-silent narration.

### Typed visual specs and export manifests

- Added schema migration 0012 for versioned visual specs, source lineage, export manifests, manifest files, and manifest evidence.
- Added typed `VideoVisualSpec`, bounded visual templates/payloads, chart points, and source kinds in `nip-domain`.
- Added typed `VideoExportManifest` and export-file records with deterministic/reproducibility metadata.
- Added immutable DuckDB persistence, revision guards, canonical event/claim validation, and round-trip retrieval for both record families.
- Added MCP and browser API surfaces for save/get/list operations.
- Updated the Video Workspace render action to persist the canonical `VideoVisualSpec` before queuing the LinkZag execution job.

## Verification already completed

- `cargo fmt --all`
- `cargo test -p nip-domain -p nip-store -p nip-engine`
  - `nip-domain`: 3 tests passed.
  - `nip-engine`: 63 tests passed plus 3 binary tests.
  - `nip-store`: 21 tests passed, including restart recovery, retention cleanup, and VisualSpec/export-manifest round trips.
- `npm run build`
- `npm run test:run -- src/features/video src/features/workspace`
  - 11 frontend tests passed.
- `npx playwright test playwright/video-workspace-demo.spec.ts --project=chromium --reporter=list`
  - 1 passed.
- `npm run test:e2e:demo -- --grep @demo-video-workspace`
  - 1 passed and recorded.
- `ffprobe` confirms final demo streams: H.264 1280x720 video and AAC two-channel audio.

The Playwright web server logs may show `ECONNREFUSED 127.0.0.1:8788` for the unrelated RIGA proxy because this fixture journey deliberately stubs NIP and does not require RIGA. Do not report those warnings as Video failures.

## Remaining work from docs/66 and docs/67

### V1 planning gate gaps

The current foundation has project/episode/storyboard/scene/shot records, asset/workflow registry, evidence linkage, LinkZag adapter, and asynchronous jobs. Complete the remaining planning/export surface:

- [x] Add the versioned typed `VideoVisualSpec` contract and keep arbitrary LinkZag scene JSON non-canonical.
- Bind signal-snapshot and transcript-span source production to their NIP projections, and enforce approved-claim semantics when those upstream records are available.
- Add the scene/shot editor rather than the current three-scene planning scaffold.
- Add explicit lineage navigation from scene/shot/asset back to event and Claim Explorer.
- [x] Add typed export-manifest persistence with file and evidence-lineage records.
- Implement the actual storyboard JSON, shot list, asset requirements, LinkZag scene-file, and timeline JSON producers using those manifests.
- Add resource monitoring UI beyond the current job banner where required by the V1 plan.
- Add the V1 browser journey that reopens a project and proves revisions/evidence survive navigation.

### V2 deterministic media and local generation

- Harden the isolated LinkZag adapter for PNG, MP4, WebM, and transparent overlays.
- Validate command-appropriate manifests: `segment.json` for packaged segments, frame manifests for capture, and still/ffprobe metadata for direct render/video commands.
- Add deterministic commentary templates for evidence cards, quote cards, kinetic text, chart transitions, captions, and scene transitions.
- Run the pinned LinkZag submodule smoke from `docs/67` with `npm ci`, typecheck, tests, build, segment render, and ffprobe.
- Add `ComfyPackProvider` only for capabilities supported by the current pack and only when local runtime/model readiness is proven.
- Add local-only capability detection, model/license disclosure, platform/device status, and low-memory warnings.
- Keep deterministic mock execution as the default test provider.
- Add failure/cancellation cleanup and managed media URL playback coverage.
- Add V2/V2a Playwright journeys for mock production and deterministic LinkZag repeatability.

### V3 QA, assembly, and export

- Add deterministic QA reports and severity model.
- Add blocker/advisory behavior for missing media, unsupported capabilities, evidence gaps, and invalid shot plans.
- Build EDL/timeline/FFmpeg assembly planning and optional fixture MP4 export.
- Add subtitle/audio alignment and gap/missing-media checks.
- Add the V3 browser journey proving blockers prevent export, dependencies can be fixed, and the resulting artifact retains project revision and evidence lineage.
- Extend the narrated demo from the current evidence-to-render flow to include QA findings and export readiness.

### Other required journeys from docs/67

- V3 unavailable/recovery: no Comfy endpoint, missing nodes/model, provider stopped during a job, retry, cleanup, restart, and no duplicate artifacts.
- V4 source policy boundary: refuse episode creation without permitted source evidence/rights, prove no provider request occurs, and verify secrets/raw source text do not enter logs or manifests.
- V5 optional avatar boundary: only if the separately gated native avatar adapter is enabled; never invoke `modules/rehab-video-maker` scripts and never commit private avatar files.

## Suggested next sequence

1. Preserve the completed job/recovery, typed VisualSpec, and export-manifest contracts.
2. Add store and MCP methods for QA reports, timeline/EDL plans, and artifact lineage queries.
3. Expand the Video UI into editor, QA, assembly, and export panels with explicit capability states.
4. Add the LinkZag output-matrix smoke and repeatability test.
5. Add opt-in Comfy tests only on a provisioned target and retain the deterministic mock path.
6. Complete V2/V3 Playwright journeys and update the narrated demo.
7. Re-run all Rust/frontend/Playwright gates, then update docs/66 and docs/67 with measured status.

## Do not regress

- Do not put NIP canonical event or claim text into a media-only table.
- Do not add provider credentials to the frontend.
- Do not silently fall back from an unavailable model/provider while labeling output as generated.
- Do not claim deterministic/reproducible output for nondeterministic providers.
- Do not make a live Comfy installation or model download a default dependency.
- Do not turn the Video Workspace into a generic node/canvas editor.
- Do not commit ignored recordings, narration clips, test-results, `.venv-tts`, or private media artifacts.
