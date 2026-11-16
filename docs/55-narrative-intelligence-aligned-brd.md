# 55 — Narrative Intelligence Platform: BRD review and aligned requirements

**Status:** Proposed product requirements, aligned to the latest `fina-builder` repository. This document does not authorize implementation, source-provider accounts, paid services, or publication. The implementation plan is [doc 56](./56-narrative-intelligence-implementation-plan.md); user-journey, regression, and narrated-demo verification is [doc 57](./57-narrative-intelligence-testing-plan.md).

**Review baseline:** `haymant/fina-builder`, branch `main`, commit `5795ee464707bb55b55cc2c19f7b27f71f257df1` (2026-10-22), fetched and verified fast-forward current on 2026-11-16. Pinned submodules initialized at `modules/riga` `a0073f9f360b86b29d6081025a1f0a065303eff2`, `modules/riga-flow` `2a90c08a21b58863a4189273e0cfc22f492703f7`, and `modules/tac-engine` `89fb0c89e19e72c05131f8b1022016a9098e254f`. No product code has been changed for this review.

**Phase 0:** Design baseline, including the amended podcast RSS/local-ASR source workflow, is recorded in [doc 58](./58-narrative-intelligence-phase-0-decisions.md), with the media-worker boundary superseded only as documented in [doc 59](./59-comfyui-media-processing-architecture.md). Changes beyond that boundary require a further decision record before scope expands.

## 1. Product decision and compatibility boundary

The BRD describes a new product capability, not a small extension of an existing narrative feature. The current application is a React 19/TypeScript analytical workbench in a Tauri 2 shell. It presents `riga-flow` product-pricing tools, `tac-engine` market-data tools, local dashboards and a separate trade-repository workspace. The source-observation, claim, narrative, ETF-theme, and editorial-research pipeline in the BRD does not exist in the current app.

Build Narrative Intelligence as a **separate bounded workspace and backend service** inside the existing application. Preserve the existing structured-product dashboards, trade repository, RIGA assistant and their current data contracts. Do not rename the existing product, replace its start screen, or move narrative records into the trade-repository schema as part of the first delivery. Any product-wide rename or retirement of the pricing explorer requires a separate explicit product decision.

Reuse established patterns where they fit: catalogued dashboard tiles and templates, `PanelCard`/`AsyncPanel` loading and failure states, shared ECharts wrappers, XYFlow interaction patterns, typed MCP transports, Tauri-owned process boundaries, isolated browser fixtures, and the trade repository's append-only event, provenance, idempotency and audit practices. Reuse means applying patterns and components; it does not mean treating pricing graphs, instrument schemas, localStorage, or trade lifecycle events as narrative-domain models.

## 2. Purpose, users and product boundaries

The platform helps an analyst discover and inspect emerging information narratives. Its first responsibility is to show **what was observed, when it was observed, where it came from, and which evidence supports each derived claim or narrative**. It calculates descriptive measures of attention and spread. It must distinguish measured observations from generated interpretation.

The primary initial user is a single desktop research analyst reviewing a locally stored corpus. Editorial topic discovery is a secondary use of the same evidence. ETF-theme associations are a manually maintained research hypothesis, not an automated recommendation. Paper performance is an experimental evaluation of historical signals and is not a trade instruction, official valuation, or risk measure.

The platform is not a sentiment-only product, a generic RAG chat front end, a source of verified investment advice, a live trading system, or a guarantee of discovery lead time or excess return. The existing README already positions `fina-builder` as a demonstrator rather than a production pricing or risk system; NIP must carry an equally explicit data and investment-use disclosure until its data and evaluation gates are met.

## 3. Aligned technical requirements

### 3.1 Application and service integration

1. Keep the existing Tauri 2 desktop shell and React 19/TypeScript frontend. Implement NIP-specific data operations in a Rust-owned service boundary, not in React components and not in the RIGA pricing engine.
2. Expose typed request/response contracts through the same supported surfaces as the app: Tauri IPC for desktop and a same-origin HTTP/MCP route for browser development and E2E. The browser must not spawn processes or call private engine ports directly.
3. Put NIP feature code under a separate frontend namespace such as `src/features/narrative/` and expose it as a clearly named workspace location or NIP-specific dashboard/template family. Preserve the existing pricing dashboard and trade-repository navigation.
4. Keep the existing RIGA/TAC engines as optional adapters. They provide potentially reusable market-data access and user-configured model/provider capabilities, but their current contracts are not a narrative store, an ETF backtester, or proof of live source access. Confirm the pinned engine APIs before depending on them.

### 3.2 Storage, truth and derived indexes

1. The **logical source of truth** is one append-only event ledger, owned by the NIP service and stored in a local DuckDB database file. A committed retained observation is immutable. Updates to a source, corrected metadata, withdrawn content or a corrected extraction are recorded as new revision, supersession or retraction events with references to the prior record; they do not silently edit the old observation. A policy-permitted purge is the explicit exception described in §4.1.
2. DuckDB is the authority for event identity, source metadata, retained content permitted by source terms, provenance, and derivation-run manifests. Derived entities, claims, narrative clusters, graph edges, daily metrics, ETF mappings and paper-portfolio outputs are versioned projections that can be rebuilt from the ledger and their explicitly versioned inputs.
3. Parquet is used for partitioned export, backup, exchange and analytical snapshots. It is **not a second independently writable system of record**. An export contains a manifest with schema version, export time, event range, record counts and checksums. Import/restore validates the manifest before use.
4. Qdrant is not a source of truth. It is a deferred, optional semantic-search index only. If introduced, every indexed point must carry the canonical DuckDB event/claim/narrative reference plus index-model and source-version metadata. It must be rebuildable and reconciled against the authoritative ledger.
5. Local persistent data must live under a user-visible application-data directory for packaged desktop use. Automated tests must use explicit disposable NIP directories and must never point at the user's real NIP data, TAC market partitions/root metadata, trade-repository store, or production credentials. Local development may place NIP Parquet exports under the dedicated `$TAC_LAKE_DIR/nip/` child, but must not write NIP files into the TAC root or market-data partitions.
6. Do not describe the current `localStorage` stores as capable of holding the BRD's 10–50 GB corpus. `localStorage` remains suitable only for workspace layout, filters, selection, and small UI preferences.
7. `NIP_DATA_DIR` selects the canonical DuckDB store directory. It defaults to the NIP application-data directory in the packaged desktop app and to an ignored development/test directory in local workflows. Keep this DuckDB store separate from the Parquet lake directory.
8. `NIP_LAKE_DIR` selects the NIP Parquet export/archive directory. When it is not set and `TAC_LAKE_DIR` is available, default to `$TAC_LAKE_DIR/nip/`; never set `TAC_LAKE_DIR` itself to the NIP subdirectory. The existing TAC lake remains rooted at `TAC_LAKE_DIR` and retains its own root-level metadata and market partitions. In packaged desktop mode without `TAC_LAKE_DIR`, use an NIP-specific application-data lake path. An explicit `NIP_LAKE_DIR` override takes precedence. This path contains Parquet exports, not the canonical DuckDB database.
9. `NIP_DATABASE_URL` is a future-facing, optional relational-store setting for relational control-plane records only. The current app already uses `DATABASE_URL` for the separate trade-repository process (see the [trade-repository URL adapter](../scripts/lib/trade-repo/store.mjs)), so the shared launcher must not route one generic URL to both services. In the full app, configure NIP with `NIP_DATABASE_URL` and pass it only to the NIP process as its process-scoped `DATABASE_URL`. Do not store canonical raw observations in this second database. If no relational feature requires it, leave it unset and keep the NIP MVP on its DuckDB store.
10. `VECTOR_DB_URL` is an optional Qdrant endpoint used only by the deferred semantic-search index. If it is unset, semantic search is disabled and the core app continues with DuckDB-backed filters/search. If configured, expose the endpoint only to the NIP process, keep any API key in a separate secret variable, and show an unavailable/degraded state when Qdrant cannot be reached. Qdrant remains rebuildable and never becomes canonical truth.

### 3.3 Network, source and LLM behavior

“Offline capable” means that, after the database and required local model/index are available, a user can review and analyze already-ingested data without a network connection. It does not mean that remote podcast/Reddit collection, remote market-data backfill, or remote LLM calls work offline. The UI must show each capability's network/provider state and must not replace missing data with fabricated values.

The first source workflow is a one-time user subscription to an individually reviewed podcast RSS feed. On successful subscription, NIP performs an initial feed sync immediately, then refreshes at app start and every six hours while the app is running, honoring longer server `Retry-After` delays and bounded backoff. It discovers new episodes, downloads permitted audio enclosures temporarily, transcribes with local ASR, and ingests the source-linked transcript without a per-episode file-import step. The user can pause or remove each feed. Public RSS access is not itself permission to download, process or retain content: enable a feed only after its terms, access method, retention/deletion behavior, rate limits and attribution are reviewed and the user confirms authority to process it. Local-file import remains an optional fallback for user-owned material or unsupported feeds. Apple Podcasts' in-app transcript is not a public transcript API; do not scrape platform transcripts or bypass paywalls. Reddit is conditional on then-current access rules. Corporate reports/blogs, X/Twitter and other connectors remain later-phase scope; do not use Playwright to evade provider restrictions.

Run audio transcription and model-assisted text extraction in backend services through typed provider interfaces. Keep podcast ASR local as specified in Decision 2; under ADR 59, a local ComfyUI worker is an optional ASR/media executor, not a hard NIP dependency or product lifecycle owner. For claim/narrative extraction, follow the provider and model the user currently configured for the RIGA assistant, whether local or remote; do not impose a local-only default, create a second conflicting NIP model setting, or silently fall back to another provider. Resolve the selection through a secure typed bridge to the existing RIGA provider boundary, not through frontend credentials or copied API keys. Before NIP sends transcript text/excerpts to a configured remote model, require one NIP-specific consent for that provider/model selection, state what content will leave the device, and allow consent revocation. A declined/unavailable provider produces a visible pending/unavailable state, not an empty-success result. Store provider/model/prompt version with each derivation, but never keys or raw source text in diagnostics, repository files or generated demo artifacts. Tests use deterministic local/remote provider fakes and make no public model requests.

### 3.4 Local media worker boundary

1. NIP owns source approval, RSS polling, eligible-episode selection, enclosure validation/download policy, retries and episode state, source identity, canonical transcript ingestion, provenance, retention and purge. A media graph cannot authorize source access or determine whether a transcript may be retained.
2. A local ComfyUI service may execute a fixed, versioned ASR workflow via a typed NIP adapter. The endpoint is optional, explicitly configured as `NIP_COMFYUI_URL`, and restricted to loopback; it is not exposed through the browser, public preview or an unauthenticated LAN bind. When it is missing or incompatible, transcription is visibly pending/unavailable and retryable; no remote ASR fallback occurs.
3. NIP stages only approved, validated audio temporarily, submits no feed/source URL or credentials, validates the returned transcript/language/timing, and commits accepted output in NIP storage. NIP must verify deletion of staged audio and content-bearing ComfyUI output/history after success and every terminal failure/cancel/restart path before enabling the adapter.
4. The first candidate is the optional Qwen3-ASR 0.6B UI/API workflow in the separate `comfyui-flows` checkout. It requires its own ComfyUI custom node, Python dependencies and model weights; its static workflow tests do not prove runtime compatibility, ASR quality, supported-platform performance or NIP integration. Playwright uses a deterministic fake; a local ComfyUI/model smoke is separate and opt-in.

## 4. Data and behavioral requirements

### 4.1 Observation and evidence model

Every raw observation has a stable `event_id`, source identity, canonical `source_type`, source URL or local import reference, author/speaker if known, title, exact retained content or a lawful content reference, a content hash, and source/licensing/retention metadata. Keep four distinct time fields: optional source-provided `published_at`; optional source-provided `source_updated_at`; UTC `captured_at` for when NIP first captures the bytes; and UTC `ingested_at` for the canonical DuckDB commit time when the record becomes queryable. Store instants with timezone awareness and calculate in UTC; API output is ISO-8601 with `Z` or an explicit offset. Missing `published_at` remains missing and is excluded from dated-window metrics; never infer it from the machine clock or filesystem modification time. The UI labels the time it displays.

Retained event content is immutable under ordinary updates. A user or source-policy purge is an explicit exception: remove source text and content-bearing derived records from the active DuckDB store, NIP-managed Parquet exports and any configured vector index. Keep only the event ID, purge time and minimal reason/reference metadata permitted by policy; remove even those fields if the applicable policy requires it. A user-created export outside NIP cannot be recalled, so the export action must disclose that it may contain source content.

Each claim must link to one or more event IDs and to a quote/span within the evidence when the source format permits. It stores speaker/author, claim text, extraction confidence, extraction-run ID, model/provider identifier, prompt/schema version, and extraction time. A narrative is a derived label/cluster over claims or event mentions, not an entity. Every narrative membership and cluster rename/merge/split is versioned and traceable to the algorithm/run that produced it. Entities use stable IDs, typed names and aliases; entity-resolution changes are versioned and auditable.

Deduplication is source-scoped and idempotent. Prefer `(source_id, source_native_id)`; otherwise use `(source_id, canonical_url)` with only scheme/host case normalized and fragments removed; local imports without either use `(manual_import_scope, SHA-256 of exact file bytes)`, where the persistent scope identifies the original source, not an import attempt. The same source identity and content hash is a no-op even if metadata differs; metadata is not silently overwritten and requires an explicit versioned correction. Changed content under the same identity creates a linked revision, not an overwrite. Identical text from different sources remains distinct. Record the selected idempotency key and prior event ID. A point-in-time query excludes records with `ingested_at` later than its `as_of` cutoff, even when `published_at` is earlier.

### 4.2 Descriptive narrative signals

Signals are derived records, never primary truth. Each signal output stores the narrative and input-window identifiers, exact cut-off time, formula/version, counts, source-category taxonomy version, baseline coverage, data-quality flags, and computation run ID.

- **Windowing and coverage:** use completed UTC calendar weeks from Monday 00:00 to the next Monday 00:00, with half-open boundaries. A metric is comparable only when the configured source-coverage manifest is complete for the relevant windows. Manual imports without a completeness manifest show observed counts with `unknown` or `partial` coverage rather than treating missing observations as zero.
- **Velocity:** show current- and prior-week counts, mentions per day, delta mentions per day and percent change only when the prior count is positive. With a zero prior count, percent change is null and the UI says “no comparable baseline.” Default Radar order is current-week count descending, then distinct source-category count descending, then stable narrative ID; velocity delta is a separate sort, not a ratio-based dominance ranking.
- **Novelty:** the initial signal release has no scalar novelty score. Show `first_published_at` (earliest included non-null `published_at`) and `first_ingested_at` (earliest included `ingested_at` known by the selected `as_of`), available historical range and raw prior-period counts. These describe the corpus and system knowledge, not novelty. If all included evidence is undated, `first_published_at` is null. Add a score only after its method and a human-reviewed labeled set are approved.
- **Diffusion:** show distinct source-category count and raw mention count per category. Version-1 categories are `podcast`, `news`, `corporate`, `community` and `other`; multiple feeds in one category count as one category. There is no source-authority weight.
- **Persistence:** show consecutive complete UTC weeks with at least one mention. A complete zero-mention week ends the run; an incomplete/unknown-coverage week produces a coverage warning rather than asserting that the narrative stopped.
- **Influence weighting:** no speaker/source influence weighting is used in Phase 1. Do not encode subjective authority through hidden defaults.

The radar and ranking must expose these definitions and evidence on demand. Scores are research aids, not probability of return, price targets or validated predictive forecasts.

### 4.3 Graph, ETF themes and editorial topics

The narrative graph is a derived view built from versioned entity/narrative/claim relations. It includes edge type, supporting evidence references, confidence, derivation run and last-built time. Rebuilds may produce a new graph version; they never mutate source events. Nightly rebuild is a scheduling target only after reliability and data-size tests; an explicit user-triggered rebuild is the initial safe behavior.

ETF mappings are manual knowledge records in the initial scope. Each mapping records theme/narrative ID, ticker, rationale, evidence references, author/reviewer, version, effective dates, known-at time and any exclusions. The interface distinguishes an unreviewed association from an approved research mapping. Ticker existence, market-data coverage and mapping validity are separate statuses. Do not turn a narrative score into a trade recommendation.

Editorial Alpha returns ranked topic candidates, not finished articles or claims of likely CTR. Each candidate links to the supporting narratives, claims and source events; each shipped ranking component is visible and versioned. A novelty component is not available until its separate method gate is approved. A human can mark a candidate relevant, irrelevant or deferred with a reason. Monetization/CTR estimation is deferred until a documented channel-outcome dataset exists.

### 4.4 Paper portfolio and backtesting gate

The BRD's weekly top-10 equal-weight paper portfolio is not an MVP dependency and is not available from current pricing or trade-position features. Do not implement or present historical performance until all of the following are specified and tested: aligned ETF total-return history; dividends, splits, distributions and other corporate actions; delisted/survivorship-aware coverage where applicable; point-in-time theme-to-ETF mappings and any point-in-time holdings used for exposure attribution; signal publication cut-off and next-executable-price convention; trading calendar and currency; rebalance/tie-break/cash rules; transaction fees, bid–ask spread, slippage and turnover; benchmark data on the same dates, currency and total-return convention; and a reproducible evaluation window.

If the gate is unmet, the UI says “Backtest unavailable: required point-in-time price/mapping data is incomplete” and provides the specific missing items. It must not show a placeholder equity curve or assume zero transaction costs. “Outperform ACWI by more than 2% annualized” is an aspirational research hypothesis, not an acceptance criterion or current performance claim. Any later evaluation requires an out-of-sample/walk-forward protocol, parameter and cost sensitivity, and disclosure of sample size and uncertainty.

## 5. Scope and delivery phases

### Phase 0 — product and data decisions

**Complete.** The bounded decisions are recorded in [doc 58](./58-narrative-intelligence-phase-0-decisions.md), as amended narrowly by [doc 59](./59-comfyui-media-processing-architecture.md): NIP is a separate workspace; individually approved podcast RSS subscriptions with local ASR are the primary ingest path; ComfyUI is only an optional local inference executor; local file import is only a fallback; NIP owns source lifecycle, retention/deletion and purge; DuckDB is canonical and Parquet is export/archive; four timestamps and source-scoped idempotency are defined; signal outputs and synthetic fixtures are fixed; and each feed's source-specific approval plus additional sources, remote models, relational DB, Qdrant and scale/performance claims remain gated. No feed, ComfyUI worker or model has been configured.

### Phase 1 — auditable podcast research slice

Implement the NIP service boundary and local append-only event store with the policy-permitted purge exception in §4.1. Deliver a user-configured podcast-feed subscription, automatic RSS episode discovery, temporary enclosure download, local ASR behind the typed provider port (with optional ComfyUI adapter only after ADR 59's acceptance gates), source-linked transcript ingestion, event search/filtering, and evidence-linked claims/narratives with a Claim Explorer. A local transcript/document import remains a fallback, not the routine source workflow. The user subscribes once; NIP processes new eligible episodes automatically while the app is running. The user can restart the app and see the same retained records and provenance. No show is pre-enabled. Initial fixture/demo data is synthetic, labeled, and never represented as live source data. Playwright tests use deterministic fakes; ComfyUI runtime validation is a separate opt-in smoke test.

### Phase 2 — narrative measures and discovery UI

Implement the first descriptive signal release and a Narrative Radar/Timeline backed by NIP records. It includes velocity, diffusion and persistence under the definitions in §4.2; it has no scalar novelty or influence-weight score. Add a novelty score only after its methodology gate is approved. Add a derived graph view after the provenance/data contract is stable. Add any source beyond individually approved podcast feeds only after its source-specific access review and end-to-end tests.

### Phase 3 — manual ETF themes and editorial planning

Add versioned manual theme-to-ETF mappings, market-data coverage indication, and evidence-linked topic candidates for human review. Keep this separated from performance claims and existing structured-product valuation tiles.

### Phase 4 — conditional research extensions

Consider Qdrant semantic lookup only if benchmarked text/time/relational search does not satisfy real workloads. Consider backtesting only after the data-quality gate in §4.4. Consider Reddit, corporate, X/Twitter, browser automation, forecasting, graph reasoning, multi-agent debate and LLM-generated ETF theses only through separate policy and quality gates. Do not bundle all BRD V2 items into Phase 1.

## 6. Non-functional targets and their acceptance meaning

The BRD's targets—100M events, 10–50 GB, under 10 seconds startup, under 500 ms search and under 2 seconds narrative ranking—are retained as **measured capacity goals**, not presumed MVP results. Define the benchmark machine, database size, event-content distribution, warm/cold-cache condition, query filters, percentile, concurrent read/write pattern and index state. Report p50 and p95; state the accepted hardware/runtime boundary. No requirement is met by a synthetic microbenchmark alone. If targets fail, publish measured limits and profile before optimizing. For an initial release, correctness, restart/recovery, clear unavailable states and traceable evidence take precedence over an unverified 100M-event claim.

## 7. Success measures and claim discipline

MVP product quality is demonstrated by reproducible ingestion, no duplicate observations on retry, complete evidence links for extracted claims, stable recomputation of derived metrics from the same inputs, transparent missing/baseline states, and usable analyst discovery journeys. Measure extraction quality on a human-reviewed labeled set (precision/recall and confidence calibration by entity/claim/narrative class). Track source coverage and ingestion lag separately from narrative attention.

Lead-time discovery of 7–30 days and annualized excess return above 2% are evaluation hypotheses. Define an external mainstream-coverage timestamp dataset and point-in-time signal cutoff before evaluating lead time. Define the backtest gate and preregistered evaluation window before evaluating return. An attractive dashboard, a plausible story, an in-sample backtest or a generated LLM explanation is not proof of either hypothesis.

## 8. Repository references

- [Project README](../README.md): current application surfaces, development commands, tile extension points and validation commands.
- [Local RIGA assistant boundary](../AGENT-LOCAL.md): process ownership, provider and secrets cautions, and desktop-only assistant scope.
- [Feature inventory](../FEATURES.md): read cautiously; it contains historical pre-merge sections as well as current inventory.
- [Trade repository design](./52-trade-repository-design.md): implemented append-only trade-event, idempotency, provenance and storage-adapter patterns; not a narrative store.
- [Trade repository UI specification](./53-trade-repository-ui-spec.md): existing workspace/UI organization.
- [Trade fixing workflows](./54-trade-fixing-workflows.md): implemented source/time provenance and clear automation/correction boundaries.
- [Phase 0 decision record](./58-narrative-intelligence-phase-0-decisions.md): closed local-first design baseline and explicit future gates.
- [ComfyUI media-processing boundary](./59-comfyui-media-processing-architecture.md): optional local ASR/media worker, NIP-owned lifecycle/retention, runtime acceptance gates and companion workflow references.
- [Portfolio-risk architecture proposal](./51-portfolio-risk-architecture.md): a proposal, not an implemented ETF/backtest capability.
- [Playwright test guide](../playwright/README.md) and [demo production skill](../playwright/skills/demo/SKILL.md): canonical E2E taxonomy, video capture, narration and review steps.
- [Commentary-video reference repository](https://github.com/rehabvid/rehab-video-maker): the requested reference for evidence-linked, narrated technical commentary production.
