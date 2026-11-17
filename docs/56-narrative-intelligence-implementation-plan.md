# 56 — Narrative Intelligence Platform: implementation plan

**Status:** Phase 0 is closed under [doc 58](./58-narrative-intelligence-phase-0-decisions.md), with the media-worker boundary amended by [ADR 59](./59-comfyui-media-processing-architecture.md). The Phase 1 service foundation, consented podcast RSS subscription/discovery backend, typed ASR boundary, deterministic fake, local-file import, claims/evidence persistence, agent-native stdio/Streamable HTTP transport, Narrative Workspace/Claim Explorer, and verified DuckDB Parquet snapshot export/restore are implemented in `crates/nip-domain`, `crates/nip-store`, `crates/nip-engine` and `src/features/narrative/`. The optional ComfyUI adapter is implemented but remains live-runtime gated; no ComfyUI instance, model or device runtime was exercised. The NIP process-owned scheduler, rights-confirmed subscription/run-status UI, Phase 2 signal engine, Radar/Timeline, evidence-linked graph projection, and resource/extraction monitoring are implemented and locally validated. The optional ComfyUI adapter remains live-runtime gated, as does the configured RIGA provider bridge/consent. See the test-plan execution record in [doc 57](./57-narrative-intelligence-testing-plan.md) for verified scope.

The backend requires explicit user confirmation of source-access/retention rights before it persists a subscription or makes the initial HTTP request. It discovers RSS episode metadata, persists conditional-fetch validators and retry state, supports pause/resume/removal and due-feed refresh, and can process approved fixture enclosures through the injected local ASR port in test mode. The NIP process owns an app-lifetime scheduler that refreshes due feeds at startup and every six hours while the process is running; no external always-on scheduler or remote automation is claimed. No live feed, ComfyUI worker, ASR model, configured RIGA provider or production source is configured.

## 1. Baseline and implementation rules

Use the current `main` checkout verified at `5795ee464707bb55b55cc2c19f7b27f71f257df1`, including its pinned `riga`, `riga-flow` and `tac-engine` submodules. The root project is React 19/TypeScript plus a Tauri 2 Rust shell. Pricing and market data are owned by the RIGA/TAC engines, trade lifecycle by the Node MCP trade repository, and front-end workspace preferences by Zustand/localStorage. The new narrative domain is separate.

Follow these rules in every phase:

1. Keep the presentation layer transport-neutral. Domain validation, event persistence, source access, extraction orchestration and signal calculations do not belong in React or Tauri IPC command bodies.
2. Treat retained raw observations as immutable and all interpretations as versioned, reproducible derivations. A permitted purge is the documented exception and must remove content-bearing derivatives from active stores/exports/indexes. Every claim, narrative, metric, graph edge, topic candidate and eventual backtest output points to its exact source and derivation run.
3. Make absence, staleness, uncertainty and unsupported operations visible. Do not fabricate event content, market prices, baselines, vectors, scores or returns to fill a blank state.
4. Phase 1 is local-first: the only source connector is an individually approved podcast RSS feed; audio transcription remains local and may use the optional ComfyUI media worker defined in doc 59. ComfyUI does not own source policy, feed lifecycle, NIP records, retry state or purge decisions. Model-assisted text analysis follows the user's currently configured RIGA model, local or remote, with NIP-specific consent before remote transcript processing. Tests and the demo use a loopback synthetic feed/audio fixture and deterministic provider fakes, never uncontrolled external sources or public model endpoints.
5. Preserve all current structured-product, trade-repository, RIGA assistant and TAC market-data behavior. Existing product-engine tile and instrument contracts are not modified to accommodate narrative concepts.

## 2. Target architecture

```text
User-approved podcast RSS feeds / optional local-document fallback
                     │
                     ▼
      NIP source policy + RSS + ingestion service
          │ approved transient audio only
          ├───────────────────────┐
          │                       ▼
          │          optional local ComfyUI worker
          │          (versioned ASR/media workflow)
          │                       │ transcript result
          └───────────────────────┘
                     │
                     ▼
     DuckDB append-only canonical event ledger
                     │
            ┌────────┴────────┐
            ▼                 ▼
 versioned extraction   deterministic query and
 (configured RIGA model)  signal projections
            │                 │
            └────────┬────────┘
                     ▼
          claims / narratives / graph /
          metrics / ETF mappings / topics
                     │
          optional derived semantic index
                     ▼
  typed NIP API: Tauri IPC + same-origin HTTP
                     │
                     ▼
 src/features/narrative + NIP workspace views
```

The authoritative data path is the DuckDB ledger. Parquet files are created only by a controlled export/backup/rebuild workflow and include a manifest and checksums; they are not independently updated as a second truth store. The local ComfyUI worker executes media jobs only; it is not a source connector, scheduler, transcript/event ledger or rights/retention authority. Qdrant is excluded from Phase 1 and is not allowed to own source text or derived conclusions.

### 2.1 Rust domain and process boundary

Add a first-party Rust NIP service under `crates/` and include its packages in the root Cargo workspace without adding them to `src-tauri`'s transport code. Use small packages only where they establish clear ownership:

- `crates/nip-domain/` owns versioned serde schemas, stable IDs, timestamp validation, source and retention metadata, event/claim/narrative contracts, derivation-run manifests, metric definitions and closed error codes. It contains no DuckDB calls, network clients or Tauri imports.
- `crates/nip-store/` owns DuckDB schema migrations, transaction boundaries, immutable retained-record methods, policy-approved purge, replay queries, derived projections, backup/export/restore and test database creation. It exposes a narrow storage port to the service.
- `crates/nip-engine/` owns service orchestration, input validation, import/connector ports, deduplication, extraction-provider trait, signal calculation, graph rebuild, topic ranking, and the `nip-engine` executable. Its model-provider port resolves the same user-selected RIGA local/remote provider through a narrow typed host bridge; it does not own a duplicate provider credential store. It supports stdio/MCP for the desktop Tauri host and local HTTP/MCP for browser development and deterministic E2E.
- Add a typed `AsrProvider` port in `nip-engine`. The deterministic fake is mandatory for tests; an optional ComfyUI adapter is limited to the validated loopback endpoint `NIP_COMFYUI_URL`, a fixed workflow version, temporary NIP-owned audio staging and verified cleanup. The adapter returns transcript/language/timing data to NIP; it cannot create canonical records or receive RSS feed URLs, source approval data or provider secrets.
- `src-tauri/src/nip.rs` owns desktop process/command registration only: resolve and spawn the NIP engine using the existing safe process ownership pattern, pass the app-data directory and permitted settings, expose typed IPC wrappers, and shut down cleanly. It does not contain event or scoring logic.

In browser development and Playwright service tests, bind the HTTP transport to `127.0.0.1:8794` only. Expose `GET /health` for readiness and MCP at `/mcp`. Add the Vite same-origin proxy path `/nip/mcp` to `http://127.0.0.1:8794/mcp`; never expose the loopback service directly to the browser. Desktop mode uses the stdio transport and does not bind this port.

Before selecting exact DuckDB crate version/features, check compatibility with the pinned Rust toolchain and the existing bundled DuckDB version in `modules/tac-engine`. Do not link the NIP store to TAC's `TAC_LAKE_DIR` or write narrative data into the market lake. Keep the NIP DB at a separate per-user app-data path. There must be one serialized writer queue for NIP writes; parallel reads may proceed according to DuckDB's supported connection model. Document and test backup/restore around application shutdown and crash recovery.

### 2.2 Frontend organization

Create `src/features/narrative/` with:

- `types.ts` for generated or contract-tested DTOs and error envelopes;
- `api.ts` or a feature hook layer for NIP queries and user commands;
- `hooks/` for query state, filtering, pagination and cancellation;
- `components/` for the radar, time-series, evidence detail, graph, mapping editor and topic-review UI;
- `__tests__/` for component/contract tests.

Create `src/api/nipTransport.ts` as the only UI boundary to the service. Follow `src/api/rigaTransport.ts` and `src/api/tacTransport.ts`: separate Tauri IPC from same-origin HTTP, normalize MCP errors, set explicit timeouts, cancel stale requests, and show backend unavailability. Add the `/nip` prefix in `vite.config.ts` as a same-origin proxy to `127.0.0.1:8794`, rewriting `/nip/mcp` to `/mcp`, and add the required IPC commands to `src-tauri` and its capability manifest. Never enable a client-side service URL that bypasses the Vite same-origin proxy.

Integrate through a new Narrative Intelligence workspace location or a dedicated template family. The existing workspace catalog is coupled to `riga-flow` and TAC tiles; add a NIP-specific owner/group rather than placing narrative cards among pricing/market-data cards. Reuse shared `PanelCard`, `AsyncPanel`, `Chart`, theme tokens, table and dashboard layout components. Use ECharts for time series and XYFlow for the evidence-linked narrative graph only after defining their typed datasets. Keep graph code and state separate from the pricing Petri-net view. Use backend pagination/filters for records; never send the full corpus to the browser or persist it in localStorage.

### 2.3 Event schema and query model

Create explicit schema versions and migrations. Proposed core tables are:

- `raw_events`: `event_id`, `source_id`, optional `source_native_id`, `source_type`, `source_category`, `author`, `title`, `url_or_import_ref`, optional `published_at`, optional `source_updated_at`, `captured_at`, `ingested_at`, `content_hash`, `content_or_permitted_reference`, `retention_status`, `source_metadata_json`, and `schema_version`.
- `event_revisions`: source correction/retraction/supersession record with prior and replacement IDs, reason, effective time, recorded time, source reference and retention/deletion outcome. Never overwrite retained `raw_events.content` in place. A permitted purge is an explicit exception: remove source text and content-bearing derivatives from active stores, exports and indexes, retaining only policy-permitted tombstone metadata.
- `ingestion_runs`: source adapter/version, requested time range, start/end/error state, source cursor, record counts and idempotency keys. A partial fetch must not look like a fully successful interval.
- `entities`, `entity_aliases` and `entity_resolution_runs`: stable entity IDs, typed labels, versioned alias decisions, provenance and confidence.
- `claims` and `claim_evidence`: claim text/speaker/time/confidence/extraction-run reference and one or more event IDs with quote/span offsets where available.
- `narratives`, `narrative_membership` and `narrative_derivation_runs`: versioned clusters/labels and links to claims/events. Merge/split/rename generates a new derived version.
- `graph_edges`: versioned derived edge type, endpoints, confidence, supporting evidence IDs and graph-build run.
- `weekly_narrative_metrics` and `signal_history`: source counts, completed UTC-week IDs, coverage state, formula/version, `as_of` cutoff and quality flags. The initial signal release stores no scalar novelty or influence-weight score.
- `etf_mappings`: versioned manual theme/narrative-to-ticker association, author/reviewer, rationale/evidence and effective/known dates.
- `editorial_candidates`: versioned rank and transparent component values plus evidence references and human review status.

Use unique constraints or equivalent store-level enforcement for source-scoped idempotency. Prefer `(source_id, source_native_id)`; without a native ID use `(source_id, canonical_url)`, lower-casing scheme/host and removing only the fragment; for a local file without either use `(manual_import_scope, SHA-256 of exact file bytes)`, where the persistent scope identifies the original source rather than an import attempt. Same identity and hash is a no-op even if metadata differs; do not silently overwrite metadata, and require an explicit versioned correction. Changed hash under the same source identity creates a linked revision. Identical content from distinct sources remains distinct. Record the idempotency key type and prior event ID. Keep the four timestamps distinct: `published_at`, `source_updated_at`, `captured_at`, and `ingested_at`; the latter is the transaction-commit/known-at time. Store instants in UTC with timezone-aware ISO-8601 API values. Use half-open intervals and completed Monday 00:00 UTC weeks. Store extraction prompt/schema/provider/model versions outside or alongside each output so it can be reproduced or compared. Persist per-run counts and errors. Provide a typed, cursor-paginated query contract with explicit sort and time filters.

### 2.4 Parquet, recovery and search

Partition deterministic exports by `source_type`, `year`, `month` and optionally `day`. Each exported row retains the original event ID and all four timestamps. Export to a temporary file, validate row count/schema/hash, then atomically rename; record the export manifest only after all partitions pass. Restore imports verify all partitions before making them visible to the app. A source purge must also remove content-bearing rows from NIP-managed Parquet exports and any configured derived index. Startup recovery detects interrupted exports and uncommitted ingestion run state without discarding committed DuckDB events.

Phase 1 search is a text-and-metadata query against DuckDB with explicit time/source/entity/narrative filters, server-side pagination, and an indexed strategy selected by benchmark. Put an interface around semantic lookup. Do not add Qdrant just because the BRD names it. If keyword, time and relational filters fail representative analyst tasks, benchmark a local Qdrant instance as an optional index. Record embedding provider/model/version, dimensions, event content hash and indexed timestamp. Provide index rebuild, reconciliation and degraded-mode behavior. The NIP core must continue to work without Qdrant.

### 2.5 Environment-variable contract

Resolve configuration once at NIP process startup, validate it, then report only sanitized paths/schemes and enabled/disabled capability names in logs. Do not log database credentials, API keys, URL query tokens, or raw source content. Pass NIP-specific values only to the NIP child process; do not indiscriminately copy them into the RIGA, TAC or trade-repository process environments.

- `NIP_DATA_DIR` is the directory for the authoritative DuckDB database and NIP-local state. An explicit absolute path wins. In packaged Tauri mode, default to the platform's `fina-builder/NIP` application-data directory. In local development, use an ignored repository-local `.nip-data/` directory. Tests must always set it to a fresh path under `playwright/.data/`.
- `NIP_LAKE_DIR` is the directory for NIP Parquet snapshots/exports only. An explicit absolute path wins. Otherwise, when `TAC_LAKE_DIR` is present, default to `${TAC_LAKE_DIR}/nip/`; never change the value of `TAC_LAKE_DIR` to that child path. The existing `dev:http` launcher resolves an unset TAC root to the absolute workspace `.lake/`, so the NIP default in that mode is `.lake/nip/`. In packaged desktop mode without `TAC_LAKE_DIR`, default to `${NIP_DATA_DIR}/lake/`. Reject a resolved NIP lake path equal to the TAC root. Keep TAC's `market=*`, `features/` and root-level metadata untouched. When testing, set `NIP_LAKE_DIR` to a disposable child of the test directory explicitly.
- `NIP_DATABASE_URL` is the future-facing external configuration name for an optional NIP relational/control-plane store; Phase 1 does not require one and must leave it unset. It must not be confused with the existing parent-process `DATABASE_URL`, which the trade-repository service consumes. When a later approved relational feature starts NIP, map `NIP_DATABASE_URL` to `DATABASE_URL` only in the NIP child's environment; leave the trade repository's `DATABASE_URL` unchanged. Use a storage adapter and migrations separate from the DuckDB event ledger. Follow the repository's established URL convention (`sqlite:<absolute-path>` and `postgres://` or `postgresql://`) but claim only adapters that are implemented and integration-tested. SQLite is the first adapter only if a relational use case is approved; PostgreSQL is a later gate if multi-user or remote deployment requires it. Unsupported schemes fail clearly and never fall back to an unintended store.
- `VECTOR_DB_URL` is optional and is visible only to the NIP service. When absent, skip Qdrant startup and mark semantic search disabled; text/metadata search continues from DuckDB. When configured, validate the HTTP(S) endpoint and record a redacted host/status in diagnostics. Keep credentials in a separate `VECTOR_DB_API_KEY` secret, not in the URL. A missing collection, timeout, authentication failure or unavailable service must degrade semantic lookup without blocking import, event review, metric calculations or other DuckDB-backed workflows.
- `NIP_COMFYUI_URL` is optional and is visible only to the NIP service. It must point to the locally installed ComfyUI raw server API on `127.0.0.1`, `::1` or `localhost`; reject all non-loopback addresses, URL credentials, nonlocal redirects and DNS rebinding. If unset, mark the ComfyUI ASR adapter unavailable; do not use a hosted Comfy deployment or remote ASR. The host integration must pin/test the ComfyUI API and node revisions and sanitize endpoint diagnostics. Never expose this value to the browser or public dev-server forwarding.

For test and demo processes, set `NIP_DATA_DIR` and `NIP_LAKE_DIR` explicitly. Unless a specific integration test is testing the relational adapter, Qdrant or a local ComfyUI adapter, strip `NIP_DATABASE_URL`, `DATABASE_URL`, `VECTOR_DB_URL` and `NIP_COMFYUI_URL` from the NIP child environment. The existing Playwright environment may still set `DATABASE_URL` for the trade-repository test service; the NIP launcher must not inherit that value by accident.

## 3. Delivery sequence and implementation outputs

### Phase 0 — settle design decisions before coding — complete

Phase 0 is closed for the bounded local-first MVP design baseline. The governing record is [doc 58](./58-narrative-intelligence-phase-0-decisions.md); it supersedes the former open-question checklist in this section.

The settled choices are: a separate NIP workspace; one-time user subscription to individually reviewed podcast RSS feeds followed by automatic discovery/transcription while the app runs; transient audio download and local ASR; ComfyUI only as an optional local media-worker backend behind an NIP-owned typed port; optional local-file fallback; policy-permitted transcript retention and explicit purge behavior; canonical DuckDB with Parquet export/archive; `NIP_LAKE_DIR` beneath `TAC_LAKE_DIR` without changing the TAC root; exact four-field time semantics and source-scoped idempotency; model-assisted text analysis follows the user's configured RIGA local/remote model with NIP-specific remote-content consent; synthetic feed/audio and provider fixtures; and no additional source, relational DB, Qdrant, backtest or scale/performance claim. ADR 59 captures the media boundary. No feed, ComfyUI worker or model has been configured.

**Output:** decision record `docs/58-narrative-intelligence-phase-0-decisions.md` and superseding media-boundary amendment `docs/59-comfyui-media-processing-architecture.md`. Phase 1 may proceed within these records; any further expansion into a future-gated feature requires its own decision and implementation/test evidence.

### Phase 1 — service foundation and podcast-ingestion vertical slice

1. **Foundation slice implemented:** workspace crates, typed domain schema, configuration, versioned DuckDB migrations, test-only paths, health and capability JSON responses. This increment raises the store to schema v2 while retaining migration from v1; see doc 57 for the focused-test and verification record. Service-level health/capability tests pass, and the executable JSON smoke confirms schema version 2 plus only the RSS subscription capability enabled.
2. **Subscription approval and lifecycle backend implemented:** the service accepts a user-confirmed feed URL, show identity and rights statement; a missing confirmation causes neither a stored subscription nor a network request. It persists the approval timestamp and supports active, paused and removed states. No reviewed-feed catalog, preview/approval UI, or pre-enabled source exists; the application must present these details and capture confirmation before calling the service.
3. **RSS metadata discovery backend and desktop scheduler implemented:** subscription confirmation triggers an initial fetch; the NIP process now starts an in-process scheduler that runs a due-feed refresh immediately at app/service startup and every six hours while the process remains alive. The scheduler uses the existing due-feed operation, so only active subscriptions whose `next_poll_at` is due are fetched; it does not create a detached process or remote automation. The HTTP client has a 20-second timeout and a 4 MiB response-body limit, sends ETag/Last-Modified validators, handles 304, records safe error codes, honors longer `Retry-After`, and applies bounded retry backoff. RSS GUID or canonical episode URL is used for source-scoped idempotency; title, episode URL, enclosure URL and supported publication date are stored as metadata. Pause/resume/remove, due-refresh, and scheduler startup behavior are covered by tests/runtime smoke. Feed-error UI/run log, enclosure download, transcript creation, local ASR and automatic transcription remain separately gated. No public feed is used in tests.
4. **Typed ASR boundary implemented; live adapter remains gated:** `AsrProvider`, deterministic fake, bounded enclosure path, loopback-only `NIP_COMFYUI_URL` validation, fixed workflow submission, transcript/language/timing validation and cleanup scaffolding are implemented and tested. The `modules/comfy` submodule contains the Qwen3-ASR 0.6B UI/API workflow, but no ComfyUI instance, node, weights or MPS/Metal, CUDA, ROCm or CPU runtime has passed the required live smoke. Missing/incompatible ComfyUI remains unavailable/retryable; there is no remote fallback.
5. Local transcript/document import, source-scoped raw-event insert, event retrieval, filtering and cursor pagination are implemented for the fallback path. Retained event content remains immutable under normal operations; policy-approved purge/tombstone propagation remains a follow-up gate.
6. Parquet export/restore is implemented in `nip-store` as an atomic DuckDB `EXPORT DATABASE`/`IMPORT DATABASE` snapshot with a versioned manifest, file count, aggregate SHA-256 and event-count validation. The round-trip test restores a source-linked event and verifies its content hash. The MCP `export_parquet_snapshot` tool exposes export, while the explicit `nip-engine --restore-snapshot PATH` startup option imports a verified snapshot only into a new configured database and refuses overwrite.
7. Add a claim-extraction provider port that follows the model/provider currently selected in the existing RIGA settings, whether local or remote. Connect through a narrow typed RIGA host bridge; reuse its secure provider-profile/configuration boundary and never copy credentials into NIP config, environment variables or the frontend. Require NIP-specific consent before a selected remote model receives transcript text/excerpts, and bind that consent to the selected remote profile/model. Record provider kind/profile/model and prompt/schema version per derivation. If the configured provider is absent or unavailable, show extraction as unavailable; do not select a different local/remote fallback. Use deterministic fake local and remote provider adapters in tests/demo only.
8. Claim and narrative read/query operations and the Claim Explorer page are implemented. The workspace opens from a podcast transcript or fallback import and displays exact feed/episode reference, author/speaker, publication time, `captured_at`, `ingested_at`, quote/span, confidence, run version and evidence provenance. The same workspace now provides a rights-confirmed subscription form, initial-sync action, manual due-refresh control, next-poll/last-check status and safe feed-error visibility.
9. Agent-native stdio and Streamable HTTP/MCP endpoints, same-origin Vite proxy, typed frontend transport, development launch scripts, and the NIP process-owned startup/six-hour refresh scheduler are implemented. Tauri desktop process/IPC/sidecar integration and production packaging remain pending; they must not change RIGA/TAC sidecar resolution.

**Phase 1 exit condition (not yet met):** the backend and deterministic service journey cover approved fixture ingestion, local fake transcription, evidence-linked claims, restart-safe DuckDB persistence, Parquet round-trip with startup recovery, desktop-process startup/six-hour refresh orchestration, and a user-facing rights-confirmed subscription/run-status workspace. The remaining exit blockers are one validated local ASR runtime smoke and the configured RIGA provider/remote-consent bridge. The ComfyUI smoke remains separate and opt-in for synthetic or rights-cleared audio with pre-provisioned weights.

### Phase 2 — signal engine and discovery screens

1. Implement deterministic metrics from completed UTC calendar weeks with an explicit source-coverage manifest. This first signal release exposes velocity, diffusion and persistence as defined in docs 55/58; it has no scalar novelty or influence-weight score. Cover zero prior counts, incomplete coverage, quiet weeks and late-arriving observations.
2. Ship Radar and Timeline as backend-filtered views, with drill-down to event/claim evidence. Add an explicit “as of” label, freshness/coverage warnings and definitions for each visible score.
3. Add graph projection/rebuild after narrative membership and provenance are stable. **Implemented:** user-triggered `rebuild_narrative_graph` persists a versioned projection whose nodes and edges retain event evidence; the UI exposes the last successful graph and rebuild action. Nightly scheduling remains deferred until background-run lifecycle, error reporting, cancellation, and low-resource behavior are agreed.
4. Add one source beyond the approved podcast RSS workflow only after its source-specific access, retention, rate-limit and deletion review has been approved and its adapter passes isolated end-to-end tests.
5. Update workspace menus, test fixtures and `public/manus-routes.json` only if the app introduces actual routable web pages. The native desktop section itself does not require invented HTTP page routes.

**Exit condition:** the same event corpus and formula version produce deterministic metric rows; UI links from Radar/Timeline to underlying claims/events; an unavailable/paused feed or incomplete window is visible and does not become a zero-valued score.

### Phase 3 — manual ETF mapping and editorial review

1. Add manual ETF theme mapping with ticker validation, effective/known dates, rationale, evidence, author/reviewer and a revision history. Display market-data coverage separately from narrative relevance.
2. Add a human-review queue for evidence-linked editorial topic candidates. Keep the output as topic/title-angle candidates, not automatically authored content. Allow relevant/irrelevant/deferred with a reason and immutable review audit.
3. Add a market-data adapter only for data whose adjustment basis, total-return status, coverage, currency and historical corrections are verified. Until then, show “coverage unavailable” and do not calculate paper performance.
4. Add editorial content-outcome analysis only after CTR/retention inputs, channel identity, observation window and reporting policy are agreed.

**Exit condition:** users can edit/review a mapping or topic candidate and later reproduce which version/evidence generated it. No return or monetization claim is emitted without an approved outcome dataset.

### Phase 4 — optional semantic search and backtesting

The Phase 2 semantic index is implemented as an experimental, optional derived service boundary. Production semantic enablement remains a Phase 4 quality gate.

1. Re-evaluate Qdrant using measured Phase 1/2 search latency and task-level retrieval relevance. If approved, implement a local optional Qdrant service/index with event-level back-links, model/version manifest, deletion/retraction propagation, rebuild and reconciliation. Never make Qdrant required for opening or querying a stored event.
2. Design a separate backtest specification. Obtain aligned point-in-time ETF total-return prices and corporate actions; define universe/holdings/mapping snapshots, signal timing, execution price, costs, rebalance, benchmark, currency, missing-data behavior and evaluation protocol. Store run inputs and outputs with immutable IDs. Keep performance reporting disabled until coverage gates and OOS evaluation pass.
3. Consider Reddit, corporate filings/blogs, X/Twitter, Playwright automation, graph reasoning, multi-agent debate, forecasting and generated ETF theses in separate increments, each with access, audit, data-leakage and reproducibility decisions.

## 4. Project structure and ownership

The following paths are proposed additions, not current files:

```text
crates/
  nip-domain/                 versioned schemas, IDs, validation, errors, metric contracts
  nip-store/                  DuckDB migrations, append-only repository, export/restore
  nip-engine/                 service orchestration, adapters, extraction and signal logic,
                              stdio/HTTP executables
src-tauri/src/nip.rs          Tauri-owned child process and IPC bridge only
src/api/nipTransport.ts       browser HTTP and Tauri transport adapter
src/features/narrative/       NIP pages, typed hooks and evidence-linked components
playwright/pages/              NarrativePage page object and user actions
playwright/assertions/         narrative-domain visible outcome assertions
playwright/                    tagged NIP E2E and one paced demo spec
scripts/                       NIP dev/test service launch and benchmark helpers
playwright/.data/              ignored isolated E2E-only local store
playwright/recordings/         ignored WebM, audio, transcript and final demo MP4
  docs/55–58                    aligned requirements, implementation plan, test/demo plan, Phase 0 ADR
```

Do not place event-store logic under `src-tauri` because its role is a shell/adapter. Do not place narrative feature code under `src/features/riga` or `src/features/tac`. Do not put large event payloads in `src/store/` or localStorage. Do not add a first-party NIP service as a Git submodule; it belongs to this repository's Cargo workspace unless a separate repository ownership decision is made.

## 5. Cross-cutting implementation safeguards

- **Schema evolution:** version the canonical event, claim, narrative, metric and export formats. Migration is additive where possible; old event payloads remain readable. Include a migration test from an empty DB and from each supported previous schema.
- **Append-only audit with purge exception:** enforce immutability for retained source records through store APIs and tests. Corrections/retractions produce linked revisions/tombstones; a permitted source purge removes content-bearing source and derived records from active DuckDB, NIP-managed Parquet and any configured vector index, retaining only metadata allowed by policy. Derived outputs otherwise retain their original run and can be superseded without erasing history.
- **Secrets and privacy:** use the existing RIGA host-managed provider settings and secure profile store. Do not introduce duplicate NIP model credentials or put keys in Vite-exposed variables. Before the first NIP request through a remote profile/model, disclose the transcript text/excerpts sent and obtain profile-bound NIP consent; record the provider/model on the derivation. Keep episode audio local and never send it through the LLM path.
- **ComfyUI boundary:** ComfyUI is an optional local media executor, never a source or retention authority. Use a fixed versioned workflow and loopback endpoint only. Prove purge of temporary audio and content-bearing ComfyUI outputs/history on success, failure, timeout, cancellation and restart before enabling the adapter. Record workflow/node/model/runtime versions in NIP run provenance; do not log audio or transcript text.
- **Local data hygiene:** add `.nip-data/` to `.gitignore` before the development default is used; keep DuckDB, Parquet export and SQLite/PostgreSQL test data out of tracked source. Do not add environment files or credential-bearing URLs to the repository.
- **Unsupported and stale data:** every service method returns a typed error/state. UI components handle loading, empty, partial, stale, offline, unsupported and failed states separately. Do not map an unavailable source to a genuine zero mention count.
- **Operational limits:** cap import size, request page size, batch size and concurrent jobs. Respect cancellation and backpressure. Track run IDs and write counts so restart recovery does not duplicate rows.
- **No harmful spillover:** keep the NIP DuckDB path distinct from TAC's `.lake/` and the trade repository's SQLite/Postgres `DATABASE_URL`. Avoid changing the trade-repository capabilities or its backend lifecycle.
- **Documentation truth:** before announcing NIP as implemented, reconcile outdated pre-merge sections in `FEATURES.md` and update the current README feature inventory, data storage and known limitations. Label proposals as proposals and implementation evidence as implemented only after tests and code are present.

## 6. Future feature gates — do not silently bypass

The following are future-scope gates recorded in [doc 58](./58-narrative-intelligence-phase-0-decisions.md), not unresolved Phase 0 blockers. Before the relevant feature starts, obtain source-specific connector access/retention approval; a separate methodology and labeled review set before adding a novelty score; an approved relational use case and tested adapter before setting `NIP_DATABASE_URL`; an embedding/data-sharing decision and measured retrieval benefit before enabling Qdrant; benchmark hardware and representative data before making capacity claims; and an approved point-in-time total-return dataset and backtest protocol before reporting performance. Following the active RIGA model configuration and implementing NIP-specific consent for remote transcript processing are Phase 1 requirements, not later opt-ins. ETF mappings, editorial candidate ranking, automated scheduling and graph rebuild also remain their stated later-phase deliverables, not Phase 1 commitments.

## 7. Source-of-practice references

- [Root README](../README.md), [Tauri local assistant boundary](../AGENT-LOCAL.md), [Cargo workspace](../Cargo.toml) and [Vite proxies](../vite.config.ts) describe current process and UI integration practice.
- [Trade repository design](./52-trade-repository-design.md) and [trade fixing workflows](./54-trade-fixing-workflows.md) demonstrate append-only events, idempotent writes, source-time provenance, audit and explicit automation boundaries.
- [Portfolio risk proposal](./51-portfolio-risk-architecture.md) is an unimplemented proposal and is not treated as an existing NIP service.
- [Playwright README](../playwright/README.md), [demo skill](../playwright/skills/demo/SKILL.md), and [demo spec](../playwright/demo.spec.ts) define the current E2E and narration pattern.
- [Phase 0 decision record](./58-narrative-intelligence-phase-0-decisions.md) is the closed design baseline and source for future-feature gates.
- [ComfyUI boundary ADR](./59-comfyui-media-processing-architecture.md) defines the optional local worker and its integration gates. The user's [rehab-video-maker submodule declaration](https://raw.githubusercontent.com/rehabvid/rehab-video-maker/main/.gitmodules) points to [comfyui-flows](https://github.com/haymant/comfyui-flows). ComfyUI's [workflow basics](https://docs.comfy.org/basic-concepts/workflow), [API format](https://docs.comfy.org/development/api-development/workflow-api-format) and [self-hosted execution guidance](https://docs.comfy.org/development/run-workflows/overview) inform the adapter proposal; [Qwen3-ASR custom node](https://github.com/DarioFT/ComfyUI-Qwen3-ASR) and [0.6B model card](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) are candidate components, not runtime evidence.

## Phase 2 implementation status — verified 2026-11-17

The Phase 2 semantic slice is implemented behind the Phase 1 boundary. DuckDB remains the authoritative ledger and now stores model-versioned embedding manifests plus versioned narrative-cluster memberships. Qdrant is an optional derived index; it receives only event embeddings and provenance payloads and can be rebuilt from DuckDB. The embedding boundary is replaceable: `EmbeddingProvider` supports the deterministic test provider and an OpenAI-compatible local HTTP provider, with BGE-M3 metadata as the default model identity and explicit dimensions/revision in each manifest. Hybrid retrieval uses named dense and lexical sparse vectors. Narrative clustering is deterministic, versioned, and retains event membership evidence.

The implementation was validated against a task-local Qdrant 1.15.5 process on ports 6333/6334 with a deterministic local embedding HTTP fixture. The Streamable HTTP MCP protocol smoke initialized `nip-engine`, called `rebuild_semantic_index`, called `semantic_search`, called `rebuild_narrative_clusters`, and called `list_narrative_clusters`; the empty disposable ledger returned a ready manifest, an empty semantic result, and an empty persisted cluster projection. During validation, the adapter was corrected to use Qdrant `/points/query`, parse `result.points`, and treat an existing collection as idempotently ready. These fixes are covered by the Rust gate and the live smoke command recorded in doc 57.

## Embedding quality remains a future gate

Phase 2 implementation completion and Qdrant live-service validation do not constitute approval of semantic retrieval quality. The current benchmark uses a deterministic local embedding fixture to test ranking plumbing and evidence linkage. Before production semantic enablement, run the reviewed finance benchmark with the actual BGE-M3-compatible local provider, compare against lexical retrieval, record ranking and latency metrics, inspect false positives/negatives, and obtain an explicit quality sign-off. Until then, Qdrant remains an optional experimental derived index and DuckDB lexical search remains authoritative.


## Phase 2 signal-engine and discovery UI status — verified 2026-11-17
The first descriptive signal release is now implemented. `narrative_signal_snapshot` computes completed UTC Monday-to-Monday windows from DuckDB events with an explicit `as_of`, velocity counts/delta/percent change, source-category diffusion, observed persistence, first publication/ingestion times, evidence event IDs, formula version, run ID, and transparent data-quality flags. Missing source-completeness manifests remain `unknown`; undated observations are excluded from dated windows and surfaced as a flag. No novelty scalar, influence weighting, or investment score is produced.

The Narrative workspace now exposes Radar and Timeline views. Both render current/prior counts, delta per day, diffusion categories, persistence, coverage warnings, and clickable immutable event evidence. Radar ordering follows current count, distinct category count, then stable narrative ID. The signal calculation has a completed-week boundary regression test covering no-baseline percent changes and undated-event flags.

## Phase 3 implementation status — verified 2026-11-17
Phase 3 now provides a bounded manual research layer. Schema v7 adds immutable, versioned `nip_etf_mappings`, evidence-linked `nip_editorial_candidates`, and the Phase 2 graph projection records. ETF mappings require a dated rationale, author, effective/known timestamps, and retained event evidence; ticker syntax validation is separate from ticker existence, market-data coverage, and mapping validity. Editorial candidates retain narrative IDs, claim IDs, source-event IDs, transparent component values, derivation run, and human review audit fields. Supported review states are relevant, irrelevant, and deferred with a required reason.

Agent-native MCP tools expose listing/saving ETF mappings, replacing one editorial candidate derivation run, listing candidates, and recording human review. The Narrative workspace exposes ETF Themes and Editorial Planning views. No price series, return calculation, backtest, CTR estimate, novelty score, or investment recommendation is emitted. When coverage is unavailable, the UI explicitly states that backtesting is unavailable because point-in-time price/mapping data is incomplete.

The workspace also exposes the Phase 2 Operational Monitor for canonical ledger counts, extraction runs/provider/model provenance, graph-edge counts, scheduler cadence, semantic-index readiness, and safe warnings. Its populated, empty/loading, and degraded-warning states are covered by focused component tests and the real-service narrated journey.
