# 56 — Narrative Intelligence Platform: implementation plan

**Status:** Implementation plan only. Phase 0 is closed for the local-first MVP design baseline by [doc 58](./58-narrative-intelligence-phase-0-decisions.md). No feature code has been written. The aligned requirements baseline is [doc 55](./55-narrative-intelligence-aligned-brd.md); the user-journey and narrated demonstration test plan is [doc 57](./57-narrative-intelligence-testing-plan.md).

## 1. Baseline and implementation rules

Use the current `main` checkout verified at `5795ee464707bb55b55cc2c19f7b27f71f257df1`, including its pinned `riga`, `riga-flow` and `tac-engine` submodules. The root project is React 19/TypeScript plus a Tauri 2 Rust shell. Pricing and market data are owned by the RIGA/TAC engines, trade lifecycle by the Node MCP trade repository, and front-end workspace preferences by Zustand/localStorage. The new narrative domain is separate.

Follow these rules in every phase:

1. Keep the presentation layer transport-neutral. Domain validation, event persistence, source access, extraction orchestration and signal calculations do not belong in React or Tauri IPC command bodies.
2. Treat retained raw observations as immutable and all interpretations as versioned, reproducible derivations. A permitted purge is the documented exception and must remove content-bearing derivatives from active stores/exports/indexes. Every claim, narrative, metric, graph edge, topic candidate and eventual backtest output points to its exact source and derivation run.
3. Make absence, staleness, uncertainty and unsupported operations visible. Do not fabricate event content, market prices, baselines, vectors, scores or returns to fill a blank state.
4. Phase 1 is local-first: the only source connector is an individually approved podcast RSS feed; audio transcription remains local. Model-assisted text analysis follows the user's currently configured RIGA model, local or remote, with NIP-specific consent before remote transcript processing. Tests and the demo use a loopback synthetic feed/audio fixture and deterministic local/remote provider fakes, never uncontrolled external sources or public model endpoints.
5. Preserve all current structured-product, trade-repository, RIGA assistant and TAC market-data behavior. Existing product-engine tile and instrument contracts are not modified to accommodate narrative concepts.

## 2. Target architecture

```text
User-approved podcast RSS feeds / optional local-document fallback
                     │
                     ▼
         NIP ingestion + validation service
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

The authoritative data path is the DuckDB ledger. Parquet files are created only by a controlled export/backup/rebuild workflow and include a manifest and checksums; they are not independently updated as a second truth store. Qdrant is excluded from Phase 1 and is not allowed to own source text or derived conclusions.

### 2.1 Rust domain and process boundary

Add a first-party Rust NIP service under `crates/` and include its packages in the root Cargo workspace without adding them to `src-tauri`'s transport code. Use small packages only where they establish clear ownership:

- `crates/nip-domain/` owns versioned serde schemas, stable IDs, timestamp validation, source and retention metadata, event/claim/narrative contracts, derivation-run manifests, metric definitions and closed error codes. It contains no DuckDB calls, network clients or Tauri imports.
- `crates/nip-store/` owns DuckDB schema migrations, transaction boundaries, immutable retained-record methods, policy-approved purge, replay queries, derived projections, backup/export/restore and test database creation. It exposes a narrow storage port to the service.
- `crates/nip-engine/` owns service orchestration, input validation, import/connector ports, deduplication, extraction-provider trait, signal calculation, graph rebuild, topic ranking, and the `nip-engine` executable. Its model-provider port resolves the same user-selected RIGA local/remote provider through a narrow typed host bridge; it does not own a duplicate provider credential store. It supports stdio/MCP for the desktop Tauri host and local HTTP/MCP for browser development and deterministic E2E.
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

For test and demo processes, set `NIP_DATA_DIR` and `NIP_LAKE_DIR` explicitly. Unless a specific integration test is testing the relational adapter or Qdrant, strip `NIP_DATABASE_URL`, `DATABASE_URL` and `VECTOR_DB_URL` from the NIP child environment. The existing Playwright environment may still set `DATABASE_URL` for the trade-repository test service; the NIP launcher must not inherit that value by accident.

## 3. Delivery sequence and implementation outputs

### Phase 0 — settle design decisions before coding — complete

Phase 0 is closed for the bounded local-first MVP design baseline. The governing record is [doc 58](./58-narrative-intelligence-phase-0-decisions.md); it supersedes the former open-question checklist in this section.

The settled choices are: a separate NIP workspace; one-time user subscription to individually reviewed podcast RSS feeds followed by automatic discovery/transcription while the app runs; transient audio download and local ASR; optional local-file fallback; policy-permitted transcript retention and explicit purge behavior; canonical DuckDB with Parquet export/archive; `NIP_LAKE_DIR` defaulting beneath `TAC_LAKE_DIR` without changing the TAC root; exact four-field time semantics and source-scoped idempotency; model-assisted text analysis follows the user's configured RIGA local/remote model with NIP-specific remote-content consent; synthetic feed/audio and model-provider fixtures; and no additional source, relational DB, Qdrant, backtest or scale/performance claim. No feed or service has been configured by closing this phase.

**Output:** decision record `docs/58-narrative-intelligence-phase-0-decisions.md`. Phase 1 may begin within the entry scope in that record; any expansion into a future-gated feature requires its own decision and implementation/test evidence.

### Phase 1 — service foundation and podcast-ingestion vertical slice

1. Add workspace crates, NIP engine executable, typed domain schema, error envelope, configuration and versioned DuckDB migrations. Add test-only DB paths and a documented app-data location. Add health and capability discovery responses.
2. Add an RSS-feed subscription catalog/configuration. No feed is pre-enabled. A user explicitly selects a reviewed feed or confirms a feed URL once; show the feed identity, retention/access status and local processing behavior before enabling automatic discovery/transcription. Provide pause/remove controls and store the feed URL only in NIP-owned configuration.
3. Perform an initial sync immediately when a user confirms a subscription, then refresh subscribed feeds at app start and every six hours while the app is open. Honor longer server `Retry-After` delays, bounded backoff and conditional HTTP validators; do not require a per-episode file-import action or add an always-on service in this phase. Parse RSS item GUID, episode URL, enclosure, title and `pubDate`; use source-scoped idempotency and record feed errors/partial runs. Download allowed enclosures into a temporary job directory, transcribe through a local ASR provider, and commit the source-linked transcript. Delete temporary audio on success, failure or cancellation; a retry downloads it again. Never use remote ASR as an automatic fallback. In test mode only, allow a short injected polling interval/clock so scheduled discovery can be tested deterministically; production cadence remains six hours.
4. Add a local ASR provider port and validate at least one supported, packaged CPU-capable path for the project's desktop targets before promising availability. The referenced repository's MLX Whisper path is a behavioral example, not an assumed cross-platform dependency. If the local model/provider is missing, report the episode as pending/unavailable and preserve a retry path.
5. Keep validated local transcript/document import as a secondary fallback for user-owned material or a feed without a usable enclosure. Implement source-scoped raw-event insert, event retrieval, filtering and cursor pagination for both paths. Preserve retained transcript content as immutable; support policy-approved purge/tombstone behavior.
6. Implement Parquet export/restore with manifests and checksums. Add crash/reopen/rebuild and purge-propagation tests before storing user data.
7. Add a claim-extraction provider port that follows the model/provider currently selected in the existing RIGA settings, whether local or remote. Connect through a narrow typed RIGA host bridge; reuse its secure provider-profile/configuration boundary and never copy credentials into NIP config, environment variables or the frontend. Require NIP-specific consent before a selected remote model receives transcript text/excerpts, and bind that consent to the selected remote profile/model. Record provider kind/profile/model and prompt/schema version per derivation. If the configured provider is absent or unavailable, show extraction as unavailable; do not select a different local/remote fallback. Use deterministic fake local and remote provider adapters in tests/demo only.
8. Add claim and narrative read/query operations and a Claim Explorer page. It opens from a podcast transcript or fallback import and displays exact feed/episode reference, author/speaker, publication time, `captured_at`, `ingested_at`, quote/span, confidence, run version and any failed/unavailable state.
9. Add local HTTP/MCP development endpoint and Tauri stdio/IPC wrapper. Extend existing dev scripts and app-data process lifecycle. Add packaging/sidecar integration for the desktop target without changing RIGA/TAC sidecar resolution. Generate or contract-test TypeScript DTOs and expose only supported NIP operations via typed API.

**Exit condition:** in an isolated local-feed test, a user subscribes once to a permitted podcast feed; NIP discovers a new episode, fetches its fixture enclosure, transcribes it through the local ASR test adapter, stores one source-linked transcript, and displays evidence-linked claims. Repeating feed refresh does not duplicate the event. Temporary audio is removed, the retained transcript survives restart, and a verified Parquet snapshot can be exported/restored. Tests and demo use a loopback RSS/audio fixture and never contact a real feed.

### Phase 2 — signal engine and discovery screens

1. Implement deterministic metrics from completed UTC calendar weeks with an explicit source-coverage manifest. This first signal release exposes velocity, diffusion and persistence as defined in docs 55/58; it has no scalar novelty or influence-weight score. Cover zero prior counts, incomplete coverage, quiet weeks and late-arriving observations.
2. Ship Radar and Timeline as backend-filtered views, with drill-down to event/claim evidence. Add an explicit “as of” label, freshness/coverage warnings and definitions for each visible score.
3. Add graph projection/rebuild after narrative membership and provenance are stable. The initial rebuild is user-triggered; schedule nightly only after a background-run lifecycle, error reporting, cancellation and low-resource behavior are agreed.
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
