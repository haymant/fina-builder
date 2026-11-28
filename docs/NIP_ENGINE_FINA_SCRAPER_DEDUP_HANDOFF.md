# Handoff: Deduplicate responsibility overlap between nip-engine and fina-scraper

> **Superseded as an implementation target.** This handoff describes the earlier split-owner model in which fina-scraper remains authoritative for its sources and Parquet while NIP owns separate workflows. The clarified target is now **NIP as the single product and canonical data authority, with fina-scraper as an embedded acquisition worker**. Do not follow the old ownership rules or acceptance criteria below as the final design. Keep this file only as historical context for current schemas and compatibility risks; use [`NIP_SINGLE_AUTHORITY_ARCHITECTURE.md`](NIP_SINGLE_AUTHORITY_ARCHITECTURE.md) for the current target and phase-gated execution instructions.

## Assignment

Clarify and implement the responsibility boundary between `fina-scraper` and `nip-engine`/`nip-store`. The goal is one coherent narrative source and evidence experience in FinA Builder without maintaining two competing registries, pollers, and overlapping claim/entity paths in the UI.

Do **not** interpret this assignment as “delete DuckDB” or “move every record into one database.” First identify duplicated capabilities and write paths, then remove or route only the overlaps. Keep each system’s unique responsibilities and preserve existing user data. Treat any physical data migration, copying, or deletion as a separate change requiring explicit user authorization.

The implementation should give the product one logical ownership model and one UI-facing narrative data facade. It is acceptable for those services to use different physical storage formats behind that facade: fina-scraper’s append-only Parquet lake and nip-engine’s transactional DuckDB are not inherently a problem when they own distinct domains.

## Repository baseline

The relevant changes are on `main` as of the storage unification merge: fina-builder commit `fbd20b0` and fina-scraper submodule commit `0cb4b75` (or later). Start by fetching the current default branch and recursively updating submodules. Confirm the working tree is clean or make a clearly scoped worktree; do not reset, clean, or absorb unrelated edits. There may be unrelated `modules/riga` edits in an inherited checkout; leave them out of this task.

The storage contract is documented in [`STORAGE_MAP.md`](STORAGE_MAP.md). The path unification made one configured root, `NIP_LAKE_DIR`, with `NIP_DATA_DIR` derived as `<lake>/_nip`. It did **not** unify the underlying stores: scraper Parquet and SQLite live at the lake root, while nip-engine’s `nip.duckdb` and NIP-owned runtime artifacts live under `_nip/`.

The current code explicitly says Parquet rows are not automatically imported into DuckDB events. Therefore, do not claim that all overlapping concepts are already duplicated rows. The confirmed problem is overlapping responsibility and UI/API routing; verify actual write paths before changing persistence.

## Current responsibility inventory

### fina-scraper

fina-scraper owns configured automated source acquisition: site YAML, schedules, fetching, extraction/ASR for configured sites, deduplication, and scrape/backload run state. Its structured evidence is append-only Parquet under the lake root. Core outputs include:

- `items`: versioned source documents with stable item IDs, source URL, body, content hash, publication/ingestion/validity times, availability mode, and run ID.
- `entities`: entity mentions, canonical IDs/tickers, sentiment, confidence, extraction tier/model, review status, and time fields.
- `claims`: source/item-linked subject–predicate–object claims, evidence spans, sentiment, source ID, extraction tier/review status, and point-in-time fields.
- `edges`, `prices`, and `backtests`, plus narrative feature exports and associated run metadata.

Operational/configuration state is also stored outside Parquet: `_config/sites/`, `_schedules/`, `_runs/`, `_backloads/`, `_state/state.sqlite`, `_transcripts/`, `_theses/`, and `_exports/`. The configured source YAML is the owner for feeds that fina-scraper polls. See [`modules/fina-scraper/crates/fina-scraper/src/lake.rs`](../modules/fina-scraper/crates/fina-scraper/src/lake.rs), [`mcp.rs`](../modules/fina-scraper/crates/fina-scraper/src/mcp.rs), [`docs/IMPLEMENTATION_PLAN.md`](../modules/fina-scraper/docs/IMPLEMENTATION_PLAN.md), and [`docs/FINA_INTEGRATION.md`](../modules/fina-scraper/docs/FINA_INTEGRATION.md).

### nip-engine and nip-store

nip-store is much larger than a scraper-output database. Its DuckDB schema is versioned (current schema version 20) and persists distinct narrative and product workflows, including:

- NIP source registry rows, retained event records and ingestion runs.
- Podcast subscriptions, discovered episode metadata, publisher/local transcription records, and associated jobs/artifacts.
- Claims and event evidence links, including verbatim quote and offset validation against a retained event transcript.
- Provider consent/audit records, editorial review audit, ETF mappings, candidate analyses, narrative clusters/graph projections, and semantic-index manifests.
- Thesis, transcript, and backtest-evidence workflows.
- The video workspace: projects, project/episode revisions, evidence links, narratives, storyboards, scenes, shots, assets and lineage, workflows/jobs, visual specs, exports, QA reports, audio cues, and EDL/timeline records.

Inspect [`crates/nip-store/src/lib.rs`](../crates/nip-store/src/lib.rs), [`crates/nip-store/migrations/`](../crates/nip-store/migrations/), [`crates/nip-domain/`](../crates/nip-domain/), and [`crates/nip-engine/src/`](../crates/nip-engine/src/). Do not remove this store wholesale: fina-scraper has no replacement for the retained-event workflow or the versioned video-production state.

### Where the overlap appears today

The overlap is most visible in source ownership and adjacent narrative-evidence concepts:

- The NIP database has `nip_sources` and podcast subscription/episode state. fina-scraper has its own source YAML, schedules, run state, and Parquet `items`. A matching podcast feed can consequently appear in both registries even though the recent integration makes scraper YAML authoritative for polling that feed.
- The systems both expose claims/entities/graph-like results. Scraper claims are tied to `item_id` and carry source-centric financial evidence and point-in-time metadata. NIP claims are tied to retained `event_id` records and `nip_claim_evidence`, where exact quote spans and offsets are validated against the transcript. Similar labels do not make the records interchangeable.
- The scraper writes transcript/commentary artifacts beneath `_transcripts/`; nip-engine stores retained podcast transcript/event records and maintains transcription jobs. These are adjacent but not necessarily duplicate artifacts. Map their exact producers and readers before consolidating them.
- The Sources surface currently combines two registries and scraper inventory. Its code states “Two registries, one view”; owner badges and action routing are present because the backends have different managers. Some panels call scraper directly while NIP event, claim, and video flows call nip-engine.

Relevant UI/API entry points are [`src/features/narrative/api.ts`](../src/features/narrative/api.ts), [`src/features/narrative/scraperApi.ts`](../src/features/narrative/scraperApi.ts), [`NarrativeWorkspace.tsx`](../src/features/narrative/components/NarrativeWorkspace.tsx), [`SourcesView.tsx`](../src/features/narrative/components/SourcesView.tsx), [`SchedulesView.tsx`](../src/features/narrative/components/SchedulesView.tsx), [`EntitiesView.tsx`](../src/features/narrative/components/EntitiesView.tsx), and [`RadarView.tsx`](../src/features/narrative/components/RadarView.tsx). Follow their callers into `src-tauri/src/mcp_commands.rs`, `src-tauri/src/nip_http.rs`, and the scraper transport before changing interfaces.

## Required target boundary

Make the owner of each write explicit and singular. UI aggregation must not silently become a second write path.

1. **fina-scraper is authoritative for scraper-managed external sources.** It owns the configured source/site definition, schedule, polling and backload, dedup/run records, and immutable source evidence it extracts (`items`, entities, claims, edges, and related Parquet outputs). A source configured in scraper YAML must not acquire a second independently editable polling schedule in nip-engine.
2. **nip-engine is authoritative for NIP-native retained events and application workflow state.** It owns explicitly retained/imported NIP events for non-scraper workflows, event retention/revisions, NIP-specific consent/audit, event-linked claim annotations where those claims are produced against retained NIP transcripts, and the transactional state required by the video workspace and other NIP application workflows.
3. **Podcast ownership is by feed, not by whether a podcast-shaped record exists in both systems.** For a feed URL that matches a scraper-owned site after canonical normalization, scraper owns automated discovery/polling/transcript ingestion. Existing compatible NIP DuckDB records remain readable and unchanged; matching subscriptions must not cause a second fetch/transcription and must not be silently removed. Non-matching NIP-owned workflows continue to work.
4. **Do not collapse claim models by name alone.** Keep scraper claims anchored to scraper `item_id` and NIP claims anchored to NIP `event_id` unless an explicit, lossless evidence-reference contract is implemented. Preserve exact quote/offset validation, source lineage, extraction tier/review status, availability mode, and as-of semantics. A shared read model can normalize their presentation without copying either record.
5. **One UI-facing facade, owner-aware adapters behind it.** Narrative components should call one typed repository/facade rather than independently composing `narrativeApi` and `scraperApi`. Keep transport clients as backend adapters if useful. The facade must return an explicit owner/origin discriminator and route mutations to exactly one owner. It should not make both stores writable for the same source or evidence item.
6. **Use namespaced, typed references across stores.** Do not create cross-database foreign keys or assume `source_id`, `claim_id`, URL, or title alone is globally unique. For any unified result, carry the origin (for example `scraper_item` versus `nip_event`), native ID, source identity, and relevant content hash/provenance. Deduplicate only on a documented deterministic identity rule; never merge two records just because titles or URLs look similar.
7. **Keep Parquet as an append-only evidence record.** UI aggregation or DuckDB query support must not rewrite scraper Parquet, collapse version rows, or discard the Hive/run partition and point-in-time model. If a query engine uses Parquet directly, that is a read path, not authority to duplicate/alter its records.

A candidate typed reference for a future unified evidence view is a discriminated union, not a new universal ID that erases origin:

```ts
type EvidenceRef =
  | { origin: 'scraper_item'; siteId: string; itemId: string; contentHash: string }
  | { origin: 'nip_event'; sourceId: string; eventId: string; contentHash: string }
```

Adjust the fields to the actual contracts; do not add the type mechanically unless a caller needs it. Its purpose is to prevent accidental cross-store joins and to preserve lineage in video/evidence workflows.

## Recommended staged implementation

### Phase 0 — Baseline inventory and call graph

Before editing, enumerate for each overlapping object (source, feed/subscription, episode, transcript, event/item, entity, claim, graph, schedule) its authoritative writer, persisted schema, stable identity, readers, user actions, and compatibility requirements. Trace all writes, including import/export tools and Tauri wrappers. Confirm whether any production path copies scraper Parquet content into `nip_events` or `nip_claims`; existing documentation says no automatic Parquet import, but this must be verified against the current code. Record actual APIs and tests, not assumptions.

Deliver a concise data-ownership map with one owner per logical write domain and a list of legacy/read-only paths. Identify source-ID collision behavior and source-rights authority before changing UI actions.

### Phase 1 — Establish the application-facing contract

Add a small typed narrative repository/facade at the UI service boundary. Move component-level backend choice into that facade. Add explicit owner/origin metadata to source/evidence DTOs and make unsupported operations return an owner-aware result instead of guessing.

The facade should be read-first. It can aggregate source lists and evidence search from both owners while retaining provenance. Do not add a sync daemon, copy rows between Parquet and DuckDB, or make the facade another persistent store. Preserve the two sidecar APIs as adapters until migration evidence shows a backend endpoint can safely be retired.

### Phase 2 — Make source ownership singular

Treat the scraper site ID/config as authoritative for scraper-managed sites. Continue showing NIP-native sources, but represent them as a different owner in the shared catalog. Ensure the owner label is present in every action context and that source IDs cannot collide silently.

For scraper-owned sources, route schedule, trigger, pause/resume, and status operations only to fina-scraper. For NIP-native sources, route NIP-specific retention and state operations only to nip-engine. If an operation is unavailable for one owner, disable or explain it; do not call both systems as a fallback.

Keep the canonical-feed matching logic and add regression tests around normalization. Existing DuckDB subscription/event data must be readable and remain untouched during this phase.

### Phase 3 — Unify evidence reads without duplicate persistence

Create one API shape for browsing/searching events and source evidence. The facade can combine NIP retained events with scraper items, but each row must keep its origin, source, native ID, timestamps, content hash, availability mode, and tier/review metadata. Results from scraper queries must preserve `as_of`, `published_at`, `ingested_at`, `valid_from`/`valid_to`, and live/reconstructed rules.

Define claim/entity adapters explicitly. Do not flatten away scraper `item_id` or NIP `event_id`; do not falsely label a scraper claim as a retained NIP claim. If video storyboards later cite scraper items, add a typed evidence reference and validate it through the correct owner. Maintain current video gates and event quote checks until an intentional, separately tested change exists.

### Phase 4 — Deprecate duplicate feature paths

Once all callers use the facade and the sole writer is clear, mark duplicate NIP source/schedule/podcast operations for scraper-owned feeds as deprecated or read-only. Do not remove compatibility reads while active data may depend on them. Remove an endpoint or table only after repository-wide call-site analysis, a compatibility plan, and passing tests demonstrate that no unique NIP workflow uses it.

### Phase 5 — Consider physical retirement separately

Do not make deletion of DuckDB or bulk migration a deliverable of the first deduplication change. Retiring `nip-store` would require replacement for retained-event identity/evidence, rights/consent audit, workflow revisions, and the extensive video schema. If the user later chooses that project, produce a separate migration design with explicit source/target schema mapping, dry-run inventory, hashes/counts, backup, rollback, and human approval. Preserve old data by default.

## Compatibility and safety constraints

- Do not migrate, move, copy, rewrite, or delete existing narrative data as part of this task. Use fixtures and temporary test databases only. Any future data conversion requires separate explicit approval.
- Keep `NIP_LAKE_DIR` as the sole configured narrative root; `NIP_DATA_DIR` remains derived as `<lake>/_nip`. Keep `TAC_LAKE_DIR` separate.
- Unknown non-empty lake roots must still fail closed; valid existing fina-scraper roots must be reused without rewriting user files. Do not touch retired `NIP`, `.nip-data`, or other legacy paths automatically.
- Keep Reuters disabled and unprobed. Use no production provider credentials; do not print, copy, or store secrets.
- Preserve source-rights gates and consent/audit behavior. Do not turn scraped feed registration into proof of user rights confirmation, or vice versa. Resolve which store is authoritative for each permission before consolidating controls.
- Preserve item/event identity, content hashes, dedup behavior, original-source ownership badges, version history, and evidence lineage.
- Preserve `availability_mode`, publication/ingestion/validity timestamps, point-in-time `as_of` behavior, T-1 reconstruction behavior, and the rule that reconstructed data is not silently treated as live.
- Preserve thesis/extraction tiers, review status, thesis/backtest/video gates, and video QA/lineage checks.
- Preserve F3 desktop timer semantics. Do not change scheduling cadence, execution ownership, or timer behavior as an incidental result of UI unification.
- Preserve the read-only behavior for matching existing NIP podcast rows. Do not trigger duplicate podcast fetches or transcription for scraper-owned feeds.
- Do not commit or push unless the user explicitly asks for it. Avoid broad cleanup commands; the sandbox has had very low disk headroom.

## Acceptance criteria

The change is complete only when all of the following are demonstrated:

1. A checked-in ownership map names one authoritative writer for each logical source, feed, schedule, item/event, claim/evidence, and workflow domain. Every overlap is either removed or explicitly classified as a read-only compatibility projection.
2. Narrative UI components use one typed facade/repository. Backend adapters remain owner-specific, and every source/evidence row exposes its owner and stable native reference.
3. A scraper-managed source has one editable configuration/schedule and only one polling/transcription owner. A matching NIP subscription does not refresh twice and existing NIP data is neither rewritten nor deleted. Non-matching NIP-owned feeds keep their existing behavior.
4. There are tests for source-ID collisions, canonical feed URL matching, correct owner routing for every source action, and sidecar-unavailable behavior. These prove the UI does not fall back to making duplicate writes.
5. Scraper evidence queries preserve as-of and point-in-time semantics, T-1/reconstruction modes, source/run lineage, extraction tiers, and review statuses. NIP quote validation remains exact against the retained event transcript.
6. No new automatic Parquet-to-DuckDB row copy or lossy shared-table rewrite is introduced. Existing database files remain openable without an unapproved destructive migration.
7. Existing video project/episode/storyboard/scene/shot/asset/lineage/export/QA flows continue to resolve their original project and evidence references and pass their tests.
8. Source rights, provider consent, thesis gates, F3 timer behavior, and TAC/NIP lake separation are unchanged and covered by targeted regression checks.
9. Documentation explains which system owns each type of data, why the physical stores remain distinct, how the UI facade routes, and how a future separately approved data migration would work.

## Verification plan and known baseline

Use serial Rust build/test commands when disk is constrained. Recheck free space before rebuilding; prior sandbox headroom was low. Suggested targeted commands from the repository root are:

```bash
npm run test:control-plane
npm run test:run
CARGO_BUILD_JOBS=1 cargo test -p nip-store
CARGO_BUILD_JOBS=1 cargo test -p nip-engine --lib
(cd modules/fina-scraper && CARGO_BUILD_JOBS=1 cargo test -p fina-scraper --lib)
(cd modules/fina-scraper && ./scripts/e2e.sh)
npm run test:e2e:journey:narrative-setup
npm run test:e2e:journey:narrative-evidence
```

The full scraper E2E gate did **not** complete successfully in the prior work. Individual storage, phase6c, phase7, phase8, phase9, and schedule persistence tests passed, but a retry of the official full gate was interrupted by low disk. Do not report the full gate as passed unless it is rerun end-to-end.

Previously, builder Vitest reported 84 files / 522 passed / 1 skipped, and `npm run build` passed. nip-engine’s library suite reported 128 passed; focused config tests reported 19 passed. The Tauri-specific build remained unverified because of `rmcp` dependency resolution. The narrative Playwright setup reported 1 pass and 4 failures, and the NIP-backed evidence journey was not reached. Re-run the relevant tests against the final implementation and report exact commands and counts; do not use these earlier passes to claim newly changed integration flows are covered.

## Final report expected from the coding agent

Return a concise change report that states:

- The final authoritative owner for every overlapping responsibility.
- Which UI/API call paths were consolidated and which backend-specific adapters remain.
- Whether any write path or schema changed; list migrations and explain why they are non-destructive.
- How old source/feed/event/claim/video records remain readable and what was deliberately not migrated.
- Exact tests run, counts, failures, and all unverified gates.
- Any open product decision that blocks deleting a legacy NIP source/claim/transcript table.

Do not claim “one store” unless the implementation actually has one physical canonical store. Prefer the accurate statement “one logical ownership model and one UI facade over owner-specific stores” when Parquet and DuckDB remain separate.

## Repository entry points

- [`docs/STORAGE_MAP.md`](STORAGE_MAP.md) — unified root, current file layout, existing ownership notes.
- [`crates/nip-store/src/lib.rs`](../crates/nip-store/src/lib.rs) and [`crates/nip-store/migrations/`](../crates/nip-store/migrations/) — DuckDB implementation and schema evolution.
- [`crates/nip-domain/`](../crates/nip-domain/) and [`crates/nip-engine/src/`](../crates/nip-engine/src/) — domain contracts and MCP/business workflows.
- [`modules/fina-scraper/crates/fina-scraper/src/lake.rs`](../modules/fina-scraper/crates/fina-scraper/src/lake.rs) — Parquet schemas, append/load/query behavior, and lake records.
- [`modules/fina-scraper/crates/fina-scraper/src/mcp.rs`](../modules/fina-scraper/crates/fina-scraper/src/mcp.rs) and [`mcp_tools.rs`](../modules/fina-scraper/crates/fina-scraper/src/mcp_tools.rs) — tool surface and source/schedule/query behavior.
- [`modules/fina-scraper/docs/FINA_INTEGRATION.md`](../modules/fina-scraper/docs/FINA_INTEGRATION.md) — explicit scraper-to-FinA transcript/export contract.
- [`src/features/narrative/api.ts`](../src/features/narrative/api.ts), [`scraperApi.ts`](../src/features/narrative/scraperApi.ts), and [`components/NarrativeWorkspace.tsx`](../src/features/narrative/components/NarrativeWorkspace.tsx) — UI-facing service adapters and orchestration.
- [`src-tauri/src/mcp_commands.rs`](../src-tauri/src/mcp_commands.rs) and [`src-tauri/src/nip_http.rs`](../src-tauri/src/nip_http.rs) — desktop tool registration, startup, and path wiring.
