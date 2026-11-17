# 57 — Narrative Intelligence Platform: user-journey testing and narrated demo plan

**Status:** This document remains the plan for complete user-visible NIP journeys and a narrated Playwright demonstration. Backend tests for the service foundation and RSS subscription/discovery increment are implemented and recorded below. The full app UI journey and host-scheduler integration remain future work; the initial Narrative workspace and Claim Explorer are implemented, while Playwright NIP journeys/demo remain future work. The backend now covers bounded enclosure download, ASR provider/fake/adapter boundaries, schema-v4 transcript/claim persistence, local import/search, evidence-linked deterministic claims and service orchestration. The separate ComfyUI ASR workflow/CLI now has static coverage for MPS/Metal, CUDA, ROCm and CPU selection, but no live device runtime has been validated; this document does not claim runtime ASR or NIP integration exists.

## 1. Test objective and release boundary

Prove that an analyst can subscribe once to a permitted podcast feed, have NIP discover and locally transcribe eligible episodes without per-episode file imports, then move from the source-linked transcript to evidence-backed narrative signals. Verify source provenance, processing/retention limits, and safe review of later ETF-theme/editorial associations. Prove that retained records and versioned derivations survive restart, retry, export/restore and reprocessing, while temporary episode audio is purged.

The user-visible test paths must use real application navigation and actions. Assertions must check what the user can see and inspect, not only service responses. Any performance or investment-backtest acceptance is separately gated; a passing browser journey does not establish predictive power or market outperformance.

Phase 1's planned vertical slice covers one-time RSS subscription, automatic feed discovery, transient enclosure download, local ASR, deterministic claim extraction in automated tests, and claim/evidence review. The currently implemented backend increment covers consented feed subscription/lifecycle, RSS episode metadata discovery, bounded enclosure retrieval, injected fake/provider transcription, transcript persistence, local event import/search, deterministic claims and evidence persistence; full claims workflow, configured-provider consent, and scheduling remain pending. Local transcript/file import is a separately planned fallback, not the primary journey. Phase 2 adds the signal engine, Narrative Radar/Timeline, and a graph only when those features ship. Manual ETF mappings and Editorial Alpha are added in Phase 3. Paper portfolio/backtesting is a later gated extension. Tests for a deferred feature must not be counted as coverage of an implemented feature.

## 2. Test data, environments and service isolation

### 2.1 Deterministic corpus

Create one clearly labeled, synthetic-only fixture corpus at `src/features/narrative/data/fixtures/` or an equivalent test-owned directory. It contains no real personal, private, paywalled or restricted transcript text. Its metadata includes source type/category, source ID, optional source-native ID, source URL or `fixture://` reference, author/speaker, title, optional `published_at`, optional `source_updated_at`, `captured_at`, `ingested_at`, and content hash.

Use the fixed `nip-fixture-v1` corpus from doc 58. It includes a local synthetic RSS feed with stable episode GUIDs and fixture audio enclosures, plus at least three source categories, two narratives, records in two adjacent complete UTC weeks, a zero-prior-baseline narrative, one late-ingested older publication, one undated observation, an identical retry case, and one claim supported by two event IDs. A deterministic fake `AsrProvider` maps fixture audio to a reviewed transcript; all ordinary unit/service/Playwright tests use this fake. A separate opt-in runtime smoke may use the ComfyUI adapter and a synthetic/rights-cleared short speech fixture on each claimed device class: MPS/Metal, CUDA, ROCm and CPU as applicable to the release hardware matrix. Include an explicit source-coverage manifest so tests can distinguish a complete synthetic interval from incomplete coverage. Expected transcript, counts, categories and metric values are stored as reviewed fixture oracles, never recalculated by the implementation under test.

Use the exact same fixture names and expected record IDs in unit, service-contract, UI and demo tests. Label all rendered demo content “Illustrative test corpus” or an equally prominent marker. Never describe fixture-derived scores as live or validated signals.

### 2.2 Isolated storage and network policy

- Every Rust store test creates a fresh DuckDB file or in-memory database and removes it after test completion. Tests do not open the user app-data database, `.lake/`, `.trade-repo/`, or any provider's production account. Service-backed E2E must set both `NIP_DATA_DIR` (canonical DuckDB store) and `NIP_LAKE_DIR` (Parquet export directory) explicitly to separate paths inside a disposable `playwright/.data/<run-id>/` root.
- The Playwright UI suite uses the existing default mock/stub approach for fast isolated UI checks. The NIP route fixture returns deterministic responses and asserts request shape, sorting, pagination and error handling.
- NIP service-integration tests run against a dedicated test process on `127.0.0.1:8794` and a disposable DuckDB directory such as `playwright/.data/nip/`. Add a test-only reset/seed mechanism that refuses to run unless `NIP_TEST_MODE=1` and the resolved `NIP_DATA_DIR` is inside the repository's ignored test-data directory. `NIP_LAKE_DIR` must be a separate child path for Parquet exports. Playwright's NIP test configuration must start the service with `reuseExistingServer: false` and wait for `GET http://127.0.0.1:8794/health` before opening the browser. Never expose a reset endpoint in packaged production.
- For parallel Playwright UI tests, each test uses its own deterministic API fixture. For tests sharing a real NIP service, run a dedicated serial suite with one worker and reset the test database before each journey. Do not allow tests to race on one stateful database.
- Automated tests block external network access, including real podcast/Reddit calls, remote ASR/LLM providers and public market-data feeds. Permit only test-owned loopback RSS/audio fixtures and loopback mock endpoints. Core extraction uses deterministic fake ASR and local/remote claim-model providers that return reviewed, schema-valid outputs. The separate ComfyUI smoke is opt-in, requires an explicitly started loopback-only worker, compatible pinned node/runtime and pre-provisioned local model weights, and never downloads weights or contacts public model/audio providers; if prerequisites are missing, mark it blocked/not run rather than an application-test failure. Use only synthetic/rights-cleared audio and prove staging/history purge. In the mocked remote-provider journey, verify the configured provider/model is selected, the consent screen identifies transcript text/excerpts being sent, no request is issued before consent, and changing/revoking the provider-bound consent blocks later calls. Never call a public model endpoint in automated tests or demos.
- In `NIP_TEST_MODE=1` only, configure `NIP_TEST_POLL_INTERVAL_MS=1000` for the service-backed subscription journey. The service's injected scheduler (not Playwright's browser clock) must drive automatic polling. The fixture harness can publish a second episode to the loopback feed, and Playwright waits with retrying assertions for its ingestion status; do not use a fixed sleep to simulate the poll. Production always uses the six-hour interval from doc 58.
- The demo uses a fresh disposable NIP test database, a loopback fixture feed, synthetic enclosure audio and deterministic local-ASR/claim providers; no live connector is configured. It must fail or be marked blocked if it attempts any non-loopback source or provider endpoint. The proposed NIP test configuration is enabled only when `PLAYWRIGHT_NIP=on`; it launches the local HTTP service on port 8794 with `NIP_TEST_MODE=1` and the supplied `NIP_DATA_DIR` and `NIP_LAKE_DIR`, and waits for `/health`. The test fixture must assert both resolved paths are beneath the repo's ignored `playwright/.data/` directory and do not alias one another or the TAC root before resetting/seeding or exporting data.

## 3. Test layers and ownership

### 3.1 Rust domain and persistence tests

`crates/nip-domain` tests validate IDs, ISO-8601 timezone offsets, source/evidence references, schema version rules, hash normalization and closed error codes. Property tests cover malformed Unicode, empty content, duplicate IDs, missing timestamps, content hashes and page cursor ordering.

`crates/nip-store` tests cover append-only inserts, uniqueness/idempotency, correction/retraction references, transactional ingestion, restart/reopen, migrations, date-range queries, pagination, export/restore manifests, row counts/checksums, and deterministic derived-projection rebuild. A forced error between ingestion steps must leave either a fully committed record/run or an explicit failed run with no partial visible event. A repeated request with the same key and payload returns the original outcome; reuse of that key with a different payload returns a conflict and writes no duplicate event.

`crates/nip-engine` tests currently use a fake feed client for service behavior and a loopback HTTP fixture for validator handling. Implemented coverage verifies explicit consent before fetch/storage, initial sync, RSS parsing, idempotent discovery, retry timing, pause/resume/removal, and the due-feed operation. Coverage now includes bounded enclosure download, MIME rejection, deterministic ASR, loopback-only ComfyUI configuration, malformed output handling, atomic transcript commit, retryable provider states and transcript idempotency; configured-provider extraction and metrics remain future coverage; deterministic local claim extraction and Claim Explorer rendering are covered. Rebuilding a projection from the same event IDs, extraction version and metric version remains future coverage.

The focused test gate is `cargo test -p nip-domain -p nip-store -p nip-engine`. Verify stable non-empty IDs and error-code serialization; distinct publication/capture/commit times; local, packaged and explicit path resolution; TAC-root alias rejection; `NIP_TEST_MODE` path confinement; migration upgrade/reopen and future-schema rejection; isolated temporary stores; approval and lifecycle state; RSS parsing, idempotent episode storage, retry timing and loopback HTTP validators; and health/capability responses that report only implemented features. Store tests use unique temporary directories and must not touch `.lake/`, `.nip-data/`, user app data, public feeds or provider endpoints. **Execution record (2026-11-16):** the focused command passed with 32 tests (7 store and 25 engine/config/podcast; domain tests are included in the workspace gate), including schema-v1 upgrade and reopen, explicit consent, initial/due refresh, pause/resume/removal, RSS parsing, source-scoped idempotency, `Retry-After`, and loopback ETag/304 handling. Scoped formatting and `cargo clippy -p nip-domain -p nip-store -p nip-engine --all-targets -- -D warnings` passed. With a disposable `NIP_TEST_MODE` data/lake path, `cargo run -p nip-engine -- --health` returned `readiness: ready` and `schema_version: 4`; `--capabilities` confirmed `podcast_rss_subscriptions: true` and transcription, extraction, Parquet export and semantic search disabled. No Playwright UI journey or narrated NIP demo exists yet.

### 3.2 TypeScript/UI tests

Vitest tests cover DTO decoding, HTTP/Tauri transport selection, request cancellation, API error normalization, empty/partial/stale/offline states, table/filter behavior and chart input normalization. Component tests assert accessible headings, status labels, evidence links, timestamps and metric definitions. Keep calculations in Rust as the authority; TypeScript tests may validate formatting and transport mappings, not create a second signal formula implementation.

### 3.3 Playwright E2E classification

Every E2E case gets at least one `@journey-*` tag and one `@feature-*` tag from `playwright/support/tags.ts`. Add tags only when their behavior is genuinely exercised. Add `@priority-p0|p1|p2` for triage, `@requires-nip` for a live local NIP service, and `@demo` plus a single specific `@demo-narrative-research` tag only to the deterministic recording journey.

Add canonical tag entries for at least these journey labels: `@journey-narrative-ingestion`, `@journey-narrative-evidence-review`, `@journey-narrative-discovery`, `@journey-narrative-theme-mapping`, and `@journey-narrative-editorial-review`. Add features `@feature-narrative-events`, `@feature-narrative-claims`, `@feature-narrative-signals`, `@feature-narrative-graph`, `@feature-etf-themes`, `@feature-editorial-alpha`, and only after approval/implementation `@feature-paper-portfolio`. Add dependency tag `@requires-nip` and demo tag `@demo-narrative-research`.

Create `playwright/pages/NarrativePage.ts` for accessible user actions and `playwright/assertions/narrative.assertions.ts` for domain outcome checks. Keep test files as readable arrange/act/assert stories. Prefer role, label and test-ID locators where accessibility labels are not sufficient. Ordinary E2E cases must not add fixed sleeps; only the dedicated demo spec uses explicit capture holds.

After implementation, add these proposed commands to `package.json`:

```bash
npm run test:e2e:journey:narrative       # ingestion, evidence and discovery slice
npm run test:e2e:journey:narrative-mapping  # ETF-theme mapping and review slice
npm run test:e2e:demo -- --grep @demo-narrative-research
```

The first two are convenience scripts around `playwright test --grep ...`; the last uses the existing `test:e2e:demo` runner, which sets `PLAYWRIGHT_VIDEO=on`. Use `--list` first to confirm the selected tags before executing a large or service-dependent slice. A skipped `@requires-nip` test is not a pass; reports must preserve passed, failed, skipped, timed-out and interrupted statuses.

## 4. End-user journeys and explicit expected outcomes

### Journey A — Start NIP and understand source availability

**Starting state:** a new disposable NIP data directory with no events. Network connectivity is disabled for the test.

1. The user opens the application and selects “Narrative Intelligence” from the workspace navigation. Existing pricing dashboards and Trade Repository remain available from their current navigation.
2. The empty workspace says no podcast feeds are subscribed. It offers **Add podcast feed** and a clearly secondary local-file fallback. With network disabled, it explains that feed setup/refresh is unavailable while offline; it does not imply that a feed was tried.
3. The user opens source/provider status. The screen distinguishes local database readiness, per-feed approval/subscription/sync state, local ASR availability, the RIGA-selected model/provider, whether it is local or remote, NIP remote-content consent status and optional semantic-index availability. If a remote model is selected but the app is offline or NIP consent has not been granted, model analysis is marked unavailable/blocked; the status must not imply that the corpus is complete or that an unconfigured connector ran.
4. The user returns to the source screen without losing workspace context.

**Pass condition:** the correct empty/offline states appear, no zero-valued ranking or made-up event is shown, and existing dashboards/trade pages still open.

### Journey B — Subscribe once and automatically transcribe podcast episodes

**Starting state:** fresh test DB; the loopback fixture server exposes one reviewed synthetic RSS feed, one valid synthetic audio enclosure and a deterministic local-ASR test adapter. External network access is blocked.

1. The user opens **Add podcast feed**, selects a reviewed catalog entry or enters the fixture RSS URL, and inspects a preview with show identity, exact feed URL, terms/access status, expected local processing and audio/transcript retention behavior. The feed remains disabled if its access/retention status is unknown. Before subscribing, the user confirms they are permitted to fetch, process and retain this source. No feed request or record is made before confirmation.
2. The user confirms the one-time subscription. NIP performs an initial sync immediately. The screen identifies the feed as subscribed and shows the episode's RSS GUID, title, episode URL, enclosure, available publication time and processing state. It does not ask the user to select or import an episode file.
3. NIP downloads the synthetic enclosure to its temporary job directory, calls the typed `AsrProvider` (a deterministic fake in this journey), and commits one source-linked transcript. The UI shows the completed run, stable event ID, content hash, `captured_at`, `ingested_at`, source attribution, ASR/provider status and `published_at` distinctly. A remote-ASR request is not made. This does not imply the ComfyUI adapter is configured or integrated.
4. The user opens the transcript event and confirms it links to the episode/feed, with the exact transcript and permitted metadata. The test verifies the downloaded audio is deleted after transcription and is not included in Parquet export. ComfyUI output/history deletion is verified only in the separate adapter smoke.
5. The user refreshes the feed again. The UI reports no new item/idempotent replay; event count and mention count remain unchanged. A changed item under the same GUID creates a linked revision rather than overwriting retained content.
6. The fixture server adds a second episode. The service's test-only one-second poll interval causes NIP to discover and transcribe it automatically while the app remains open, with no per-episode import action. Pausing the subscription prevents the next poll; removing it stops later requests. Reopening the app triggers a sync of still-subscribed feeds.

**Pass condition:** one confirmation enables the feed; the initial and later episodes are discovered and passed through the fake provider without manual file import; retry does not double-count; NIP-staged audio is purged; feed pause/removal and failure states are visible; external network stays blocked. The separate ComfyUI smoke, when explicitly run, additionally proves worker result validation and cleanup; it is not a Playwright release dependency.

### Journey B2 — Use the local-file fallback for unsupported user-owned content

**Starting state:** fresh test DB; a permitted transcript fixture is available locally and the RSS fixture contains an unsupported item without an eligible enclosure.

1. The user opens the explicitly secondary local-file fallback, selects the transcript and reviews detected format, source/author metadata, publication time and missing fields. Before confirmation, the UI states that content will be copied to local NIP storage and asks the user to confirm processing/retention rights.
2. The user confirms. The record appears once with its import reference, content hash, `captured_at` and `ingested_at`. Repeating the same import in the same source scope is idempotent; changed bytes create a linked revision, and identical content from a distinct source remains separate.
3. The unsupported RSS episode remains visibly skipped/unsupported with a reason. NIP does not fabricate a transcript or repeatedly prompt the user for a file import as part of the primary feed workflow.
4. The user selects an invalid local file with missing required content. Validation identifies the field before commit and event count remains unchanged.

**Pass condition:** fallback works only after confirmation; repeated import does not double-count; unsupported feed items are transparent; the primary RSS route is not replaced by routine per-episode file import.

### Journey C — Extract claims/narratives and review evidence

**Starting state:** Journey B has committed a fixture podcast transcript. Parameterize the test RIGA configuration for two deterministic cases: a fake local model and a loopback remote-model mock. The remote case starts without NIP consent. Neither case contacts a public provider.

1. The user opens the event and chooses **Extract claims and narratives**. The UI resolves and displays the RIGA-configured provider, local/remote mode, selected model and stored text that will be processed. If the configured provider is remote, NIP shows a one-time consent prompt tied to that provider/model, explaining that transcript text/excerpts and the prompt will leave the device; no request is sent before consent. If consent is declined or revoked, extraction remains blocked and no provider request is issued. A local model uses the same configured selection without remote-content consent. NIP never silently switches to a different model.
2. In the remote case, the user grants consent, then starts extraction; in the local case, the user starts extraction without a remote-consent prompt. A run indicator shows progress and run ID. On completion, the UI lists extracted entities, claims, narrative assignments, confidence, provider/model and extraction version. The run manifest records the exact selection used even if the user's RIGA configuration changes later.
3. The user selects a claim. The evidence panel jumps to the original source span, shows the speaker/author and the appropriate source time when available, and identifies the event ID. If span offsets are unsupported by that source format, the UI says so rather than highlighting unrelated text.
4. The user opens the narrative detail. It displays member claims/events and the derivation run/version. A narrative title is visibly a derived cluster label, not a raw source quotation unless the title is explicitly quoted and attributed.
5. The user reruns extraction with a newer test schema/prompt version. The first output remains in history; the new output is linked as a superseding derivation. Raw event ID, content and content hash are unchanged.
6. The user opens a claim with no valid evidence link or low confidence in a negative fixture. The UI labels it as incomplete/low-confidence and does not mark it as verified.

**Pass condition:** every displayed interpretation drills to immutable evidence; NIP follows the RIGA-configured local or remote model; a remote request is blocked before NIP-specific consent and allowed only through the selected provider/model afterward; no fallback occurs; version changes do not overwrite raw observations or past extraction output; low-confidence output remains visibly qualified.

### Journey D — Search, filter and inspect Narrative Radar (Phase 2)

**Starting state:** `nip-fixture-v1` contains the two adjacent complete UTC weeks, several categories, a complete synthetic coverage manifest and the zero-prior baseline case.

1. The user opens **Narrative Radar**. The page displays an explicit UTC “as of” cutoff, selected completed-week window, source-coverage status, and definitions for velocity, diffusion and persistence. Novelty is shown only as `first_published_at`, `first_ingested_at`, historical range and raw prior counts; no scalar novelty or influence-weight score appears in the initial signal release.
2. The user filters to a date interval and one source category. Counts, rankings and result rows update from backend data. A cleared filter restores the full fixture count.
3. The user sorts by velocity and opens the first narrative. The detail includes raw counts for both windows, formula version, source categories and supporting claim/event links.
4. The user opens the narrative with zero mentions in the comparison window. The UI displays “no comparable baseline,” null percent change and current/prior counts; it does not show infinity, divide-by-zero, or an unqualified ratio-based top score.
5. The user opens a narrative with limited prior history. The UI shows `first_published_at`, `first_ingested_at`, available historical range and raw prior counts without a scalar novelty score or an implied complete baseline.
6. The user selects a source that failed ingestion or is stale in the test fixture. The UI reports partial/stale coverage separately from a true zero mentions result.

**Pass condition:** every score is reproducible from visible windows/version inputs; the UI does not hide data-quality or denominator exceptions; links lead to evidence.

### Journey E — Follow narrative history on Timeline (Phase 2)

**Starting state:** same corpus; at least two completed weekly intervals.

1. The user opens a narrative and selects **Timeline**.
2. The chart displays only the requested metric and its unit, the selected date range, completed/incomplete windows, and separate source-category series. Hover/focus reveals exact date, raw count, category and data-quality status.
3. The user narrows the date range and hides one category. The series and counts update without changing event data.
4. The user selects a point and opens its evidence list. Every item links to a committed event and claim at or before the selected cutoff.
5. The user selects an `as_of` cutoff before a late-arriving fixture event's `ingested_at`. That event is not included in “known by then” results. Moving the cutoff forward makes it visible and labels its older `published_at` and later `captured_at`/`ingested_at` values.

**Pass condition:** point-in-time behavior uses recorded knowledge time; charts and drill-down agree with the service response and do not leak future-ingested observations into past results.

### Journey F — Explore the narrative graph (after Phase 2 graph release)

**Starting state:** a graph version has been successfully built from fixture events.

1. The user opens **Narrative Graph** from a narrative/evidence detail.
2. The graph names the graph-build version and time. Nodes distinguish entities from narratives. Edge styling/type distinguishes entity association, claim support and narrative membership.
3. The user selects a node. The side panel shows supporting event/claim IDs, evidence, confidence and derivation run.
4. The user applies an entity/source filter; irrelevant nodes and edges are removed without changing the graph version.
5. A graph rebuild is started while a test fixture contains a failed derivation. The UI retains the last successful graph, identifies the failed new run, and does not present a partially built graph as complete.

**Pass condition:** every edge has evidence and a derivation version; a failed rebuild does not corrupt or silently replace the last successful graph.

### Journey G — Maintain an ETF theme mapping (Phase 3)

**Starting state:** a narrative has supporting evidence; a test ETF ticker has metadata but no historical total-return dataset.

1. The user opens **ETF Themes** and chooses a narrative/theme. The view shows current mapping status and available market-data coverage, not a performance claim.
2. The user adds a mapping by selecting an ETF ticker, entering a rationale, linking evidence and setting effective-from and known-at dates. The UI validates required fields and rejects unknown symbols or invalid date order.
3. The user saves. The mapping appears with version, author, effective date and evidence reference.
4. The user edits the rationale or ticker. The app creates a new mapping revision and leaves the prior revision visible in history.
5. The user attempts to open a backtest for this mapping without aligned point-in-time total-return inputs. The page displays the specific missing requirements and keeps performance output disabled. It does not substitute zero costs, current holdings or a price-only series.

**Pass condition:** mapping edits are versioned/audited; the data coverage status is explicit; a backtest is blocked for the defined missing prerequisites.

### Journey H — Review Editorial Alpha candidates (Phase 3)

**Starting state:** a fixture topic candidate links to two narratives and multiple claims. The novelty component is present only in a separately approved later release after its methodology and labeled review set pass the novelty gate; it is not a Phase 1 score.

1. The user opens **Editorial Alpha** and selects a time range/source scope.
2. Candidate rows show topic angle, the ranking components actually approved and shipped, evidence count, freshness and derivation version. If a novelty method has not passed its gate, no novelty component or proxy score appears. The page states that it ranks topics, not finished content or expected CTR.
3. The user opens a candidate and follows the linked narrative, claim and source chain.
4. The user marks the candidate relevant, irrelevant or deferred and supplies a reason for the decision. The action is stored as a review event; the original candidate remains unchanged.
5. The user reopens the candidate and sees the review state, reviewer and decision time.

**Pass condition:** topic rank factors are inspectable and reproducible; review does not rewrite candidate provenance; no CTR/monetization prediction appears without outcome data.

### Journey I — Gated paper portfolio (future only)

This journey is not a release gate until doc 55 §4.4's data-quality and evaluation requirements are satisfied and a separate backtest specification is approved. After that gate, the user must be able to select an as-of date, eligible mapping version, signal cutoff, rebalance schedule, execution convention, transaction-cost assumptions and benchmark. The run preview lists data coverage, excluded tickers/date ranges and point-in-time mapping versions before start. The output exposes holdings and transactions per rebalance, portfolio and benchmark total-return series, costs, drawdown/volatility/Sharpe/Sortino/hit-rate/information-ratio definitions, and complete run provenance. A user can rerun the same immutable inputs and obtain identical results. Any missing corporate-action/history/mapping input blocks the run; it is not silently replaced.

## 5. Cross-cutting negative, error and boundary tests

1. **Feed/source/time validation:** malformed RSS/XML, missing or unstable item GUID, duplicate GUID, missing/unsupported enclosure, invalid content type, oversized/redirecting audio URL, stale feed cursor, rate-limit response, failed download, malformed transcript, missing source identity, malformed or timezone-free supplied `published_at`/`source_updated_at`, invalid `captured_at`/`ingested_at`, empty/oversized content, malformed encoding and invalid canonical URL. Verify clear per-episode/feed state and no partial event write; absent `published_at` remains undated. Production feed fetches must reject non-HTTP(S), loopback, private and link-local destinations (including redirected destinations); only test mode may reach its allowlisted loopback fixture server.
2. **Immutability and purge:** attempted in-place source edit is rejected by the domain API; correction, source withdrawal and extraction rerun create linked revision/retraction/derivation records. A permitted purge removes source text and content-bearing derivatives from active DuckDB, NIP-managed Parquet and any configured vector index. Verify only policy-permitted tombstone/reference fields remain, and remove even those when policy requires it. Verify the export action warns that user-created copies outside NIP cannot be recalled by an NIP purge.
3. **Idempotency/concurrency:** retry the same RSS item/refresh and local import; replay key with changed payload; replay identical content with changed metadata; concurrent duplicate feed polls; stale expected version on manual mapping update. Confirm no double count, no silent metadata overwrite, no lost update and typed conflict states.
4. **Extraction failure:** unavailable configured local or remote model, provider-bridge failure, remote consent declined/revoked, request timeout, malformed JSON, schema validation failure, partial extraction and cancelled run. Each leaves the retained raw event intact and produces an explicit run status; no empty successful extraction is recorded. Assert that the selected provider is never silently replaced and that the remote mock receives no transcript before consent.
5. **Signal boundaries:** zero prior/current weekly count; complete versus incomplete coverage manifest; limited history; undated event; late arrival; UTC Monday boundary; missing week; duplicate source identity; changed content under one identity; identical content from separate sources; source-category rename. Verify no novelty scalar, no influence weighting, explicit coverage state, and reviewed fixture-oracle outputs.
6. **Graph boundaries:** no edges, isolated node, duplicated relation, unsupported relation kind, missing evidence, low-confidence edge, failed build, cancelled rebuild and stale prior version.
7. **ETF/backtest boundaries:** invalid/unknown ticker; expired mapping; mapping effective after signal cutoff; conflicting mapping revisions; price-only vs total-return series mismatch; corporate action missing; delisted ticker absent; currency/calendar mismatch; benchmark gaps; zero/negative/invalid transaction cost; empty rebalance set. Unsupported data blocks calculation with a specific reason.
8. **Privacy/network:** verify secrets are not exposed through DOM, HTTP response, console, error report, event payload, export, screenshot, trace or MP4. In the automated Phase 1 suite, allow only test-owned loopback RSS/audio fixtures and deterministic/fake providers; assert no request reaches a public feed, remote ASR, public LLM endpoint or market-data source. Verify the remote mock receives only the consented transcript text/excerpts and prompt, never episode audio or API keys. Assert temporary audio is absent from retained stores/exports after every terminal run state.
9. **Regression:** existing dashboard setup, pricer dashboards with live `riga-mcp`, trade navigation, trade lifecycle/fixing capture, and desktop RIGA assistant tests still behave as before. NIP tests must not change test fixtures or routes for unrelated domains.
10. **Environment/storage routing:** verify `NIP_DATA_DIR` and `NIP_LAKE_DIR` resolve to different locations; explicit `NIP_LAKE_DIR` wins; the fallback is `$TAC_LAKE_DIR/nip/` when the TAC root is supplied; packaged fallback is inside NIP app data; and the resolved NIP lake is rejected if it equals the TAC root. Confirm TAC market partitions/root metadata remain unchanged. Phase 1 leaves `NIP_DATABASE_URL` unset and does not require a relational DB. If a later approved adapter is shipped, prove the launcher gives the trade repository and NIP child only their own URLs; run SQLite/PostgreSQL tests only for adapters actually implemented. With `VECTOR_DB_URL` absent, no Qdrant request is made and semantic search is labeled disabled. Qdrant startup, failure and reconciliation tests run only after that optional adapter is approved and implemented; assert credentials never appear in logs or test artifacts.
11. **Optional ComfyUI adapter smoke (not ordinary CI/Playwright):** test only against the explicitly configured loopback `NIP_COMFYUI_URL`; reject hostnames/IPs that resolve off-loopback, embedded credentials, redirects and arbitrary workflows. Confirm health/capability states separately for reachable worker, missing node, missing weights, unsupported version/device and busy/unavailable worker. Execute only the pinned workflow against synthetic/rights-cleared audio and pre-provisioned weights on each claimed device class (MPS/Metal, CUDA, ROCm and CPU), recording the device, precision, ComfyUI version, node revision, model revision, runtime, latency and memory. Static workflow-pack support is not a substitute for a live smoke. Assert reviewed transcript/language/timestamp behavior; inject malformed/empty output, duplicate submission, timeout, cancellation, worker restart/crash and cleanup errors; assert no partial transcript is committed and retries remain safe. Prove NIP staging and ComfyUI input/output/history content are removed after success and each terminal failure/restart. If cleanup cannot be established on any claimed target, adapter acceptance is blocked for that target. Never expose this unauthenticated service via Vite, LAN or public preview.

## 6. Performance, scale, recovery and quality gates

Do not use a small UI fixture to claim the 100M-event target. Keep a versioned benchmark generator separate from E2E seed data. Record hardware, OS, Rust build profile, DuckDB/Parquet versions, record-size distribution, database size, source categories, index state, warm/cold cache, concurrency, and exact command/query. Measure import throughput and peak memory; cold/warm startup; text/time/source-filter search p50/p95; narrative ranking p50/p95 by corpus/window; graph build time; DB and export size; and restore/rebuild duration. Run 1M, 10M and 100M checkpoints before asserting scale; if any level is infeasible, record the measured limit and bottleneck rather than changing the acceptance definition after seeing results.

Acceptance interpretation:

- Startup `<10 s` means time from service process start to health/capability-ready with an existing database at the benchmark size; separate cold first-create/migration time.
- Search `<500 ms` and ranking `<2 s` require named query/run fixtures and p95 results at the agreed corpus size, index state and hardware; they do not cover first-time full-corpus ingest or model generation.
- 10–50 GB describes the measured local data/index footprint with documented compression and export duplication. Report DuckDB file and optional index separately; avoid double-counting backup copies.
- A projection rebuild, database reopen, export and restore must match canonical event counts, IDs and content hashes. Derived projection checks compare normalized records and run versions. A Qdrant index, if later approved, must pass a canonical-ID reconciliation gate.

Run destructive/recovery cases only against a disposable test database. Simulate process termination during a batch/export, restart, inspect health, run consistency checks, and verify the last committed event set is intact and any uncommitted run is explicitly marked failed/interrupted. Back up before testing upgrade migrations.

## 7. Narrated Playwright demonstration workflow

The demonstration is a test artifact, not a substitute for the full E2E suite. Follow `playwright/README.md` and `playwright/skills/demo/SKILL.md`; the production style is also informed by the user's [rehab-video-maker repository](https://github.com/rehabvid/rehab-video-maker), particularly its technical-commentary preference for a clear thesis, evidence-linked visuals, measured narration and human review.

### 7.1 Select and prove one flow

Use one focused deterministic NIP journey, not the full suite. The recommended first demo is **subscribe once → watch automatic episode discovery/transcription through the fake provider → inspect transcript provenance → inspect evidence → open Radar/Timeline → inspect the manual mapping/backtest gate**, trimmed to features actually delivered in that release. The walkthrough must visibly establish that subsequent episodes do not need per-episode file imports, while showing that the feed is a synthetic fixture, the transcript provider is a test fake, and audio is transient. Do not imply ComfyUI is configured or integrated. Use native Playwright tags in `playwright/support/tags.ts`: `@demo`, `@demo-narrative-research`, one relevant `@journey-*`, and its actual `@feature-*` tags. Use `@requires-nip` only when the local NIP service is used.

Before recording, preview exact inventory and run the selected test without video once:

```bash
npx playwright test --grep '@demo-narrative-research' --list
npx playwright test --grep '@demo-narrative-research' --reporter=list
```

The exact tests must pass. The recording run uses the local deterministic service and fixture corpus, not the default mocked NIP route, because the demo should show the real NIP storage/API path. The service must point only at the disposable test directory and must report its mode in logs. After adding the conditional NIP `webServer` configuration, run the capture like this:

```bash
env -u DATABASE_URL -u NIP_DATABASE_URL -u VECTOR_DB_URL \
PLAYWRIGHT_NIP=on \
NIP_TEST_MODE=1 \
NIP_TEST_POLL_INTERVAL_MS=1000 \
NIP_DATA_DIR="$PWD/playwright/.data/nip-demo" \
NIP_LAKE_DIR="$PWD/playwright/.data/nip-demo/lake" \
npm run test:e2e:demo -- --grep @demo-narrative-research
```

The Playwright NIP configuration must create these directories, seed/reset only the test DuckDB database using the test-only fixture mechanism, and wait for `GET http://127.0.0.1:8794/health`; the browser calls the service only through Vite's `/nip/mcp` proxy. The NIP launcher must not inherit the trade repository's `DATABASE_URL`; if a relational adapter is explicitly under test, pass its disposable test URL through `NIP_DATABASE_URL` and map it only into the NIP child process. `VECTOR_DB_URL` is unset for this demo, so semantic search must display its disabled state rather than attempting a remote Qdrant call. If an engine-dependent step is unavailable, fix the environment or choose a backend-independent demo; do not record a failure state and narrate it as a successful feature.

### 7.2 Record the browser flow

Install dependencies only if not present:

```bash
npm ci
npx playwright install chromium
npx playwright install ffmpeg
```

The project config already specifies 1280×720 video. Keep that explicit size. Use the existing recording runner, which sets `PLAYWRIGHT_VIDEO=on`:

```bash
npm run test:e2e:demo -- --grep @demo-narrative-research
```

Do not pass `--video=on`. The raw WebM should be written under `playwright/test-results/`. Copy the successful test recording to the ignored release work directory `playwright/recordings/narrative-intelligence/`. Record only a passing attempt; if the flow changes or a run fails, do not keep that capture as the final demo.

Use named `test.step` labels for every user-visible step. Add explicit `page.waitForTimeout` holds only in the dedicated demo spec and only long enough to read the current visual; ordinary E2E tests remain free of fixed sleeps. Keep the demo journey to a useful, readable walkthrough rather than recording every setting. It must show the source provenance, one evidence drill-down, one signal definition/baseline and one clear limitation or unavailable state.

### 7.3 Draft and synthesize narration

Review the captured WebM first at the opening, each state transition, and the ending. Draft one concise narration cue per visible state/step. The spoken line must describe only what is on screen at that time and must not claim the fixture is live, the signal predictive, or the ETF association investment advice. Use exact factual labels visible in the UI. A suitable first cue outline is:

```text
# One cue per line; keep these claims consistent with the captured screen.
This walkthrough uses an illustrative local test corpus in Narrative Intelligence.
One feed subscription lets NIP discover episodes and pass them through a deterministic test transcription provider without repeated file imports.
Episode audio is temporary; the retained transcript keeps its source reference, timestamps, and content hash.
Claims and narrative labels are derived outputs; each one links back to its evidence.
The radar compares completed UTC weeks and marks an incomplete coverage baseline clearly.
The timeline distinguishes publication, capture, and ingestion time; ingestion time controls what was known by a cutoff.
This ETF mapping is a dated research hypothesis, not a recommendation or validated backtest.
```

The cue file is an example to be edited against the actual recording. Store the final cue file at `playwright/recordings/narrative-intelligence/cues.txt`. The repository's default narrator is Andrew (`en-US-AndrewNeural`); use one narrator consistently and do not clone or imitate an identifiable person's voice. To synthesize clips:

```bash
npm run demo:narrate -- \
  --voice andrew \
  --script playwright/recordings/narrative-intelligence/cues.txt \
  --out playwright/recordings/narrative-intelligence/narration
```

The command writes one `cue-NN.mp3` per non-comment cue and `narration.json` with measured durations. `edge-tts` is the project's current narrator dependency and requires network access; do not make narration synthesis a dependency of the offline functional test suite. If `edge-tts` is not already available, install it as documented in the demo skill and point `EDGE_TTS_BIN` at its executable. If voice synthesis cannot run, retain the raw successful WebM and mark the narrated export blocked rather than substituting an unreviewed voice or claiming narration exists.

### 7.4 Synchronize, export and inspect

Use actual action timestamps from the recording and measured clip durations from `narration.json` to place each narration cue. If a cue overlaps a transition or outlasts its screen state, shorten the wording or update the demo-only capture hold and recapture. Do not speed speech until it is hard to understand. Leave short natural gaps and no music unless separately requested.

Set the paths to the successful recording and generated cue clips. Obtain the recorded duration from the video itself:

```bash
VIDEO=playwright/recordings/narrative-intelligence/demo.webm
NARRATION=playwright/recordings/narrative-intelligence/narration
DURATION=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$VIDEO")
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height -show_entries format=duration -of json "$VIDEO"
```

Build the WAV master first. Replace `5200` below with cue 2's measured start time in milliseconds from the screen recording; use each cue's actual start time, not a guessed equal spacing. For every additional cue, add an `-i` input, an `[N:a]adelay=... [cN]` filter, include `[cN]` in the `amix` input list, and set `inputs` to the number of cues. The `apad,atrim` tail makes the WAV end at the recorded duration even when the final speech ends early.

```bash
ffmpeg -y \
  -i "$NARRATION/cue-01.mp3" \
  -i "$NARRATION/cue-02.mp3" \
  -filter_complex \
  "[0:a]adelay=0:all=1[c0];[1:a]adelay=5200:all=1[c1];[c0][c1]amix=inputs=2:duration=longest:normalize=0,apad,atrim=duration=${DURATION}[aout]" \
  -map "[aout]" -ar 48000 -ac 2 -c:a pcm_s16le \
  playwright/recordings/narrative-intelligence/narration-master.wav

ffprobe -v error -show_entries stream=codec_name,sample_rate,channels,duration -show_entries format=duration -of json \
  playwright/recordings/narrative-intelligence/narration-master.wav
```

Listen through the WAV master and correct cue timing before muxing. Then create MP4 in a separate command. Do not use `-shortest`: use the probed video duration as the explicit `-t` so the audio master cannot truncate the screen recording.

```bash
ffmpeg -y -i "$VIDEO" \
  -i playwright/recordings/narrative-intelligence/narration-master.wav \
  -map 0:v:0 -map 1:a:0 -t "$DURATION" \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 192k -movflags +faststart \
  playwright/recordings/narrative-intelligence/final.mp4
```

For more than two cues, extend the same filter graph as described above; do not place independently delayed narration inputs directly into the video mux. This two-stage procedure avoids the invalid timestamps caused by directly mixing multiple delayed narration inputs into a `-shortest` video mux.

The final named deliverable is `playwright/recordings/narrative-intelligence/final.mp4`; all WebM, audio clips, WAV master, cue script, transcript, logs and reports remain in Git-ignored `playwright/recordings/` or `playwright/test-results/`. Verify the final MP4 with `ffprobe`: it must contain exactly one video stream and one narration audio stream; video is H.264 at 1280×720; audio is AAC; duration matches the reviewed screen flow within one frame; audio is not silent and does not clip. Example inspection command:

```bash
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height,sample_rate,channels,duration -show_entries format=duration -of json \
  playwright/recordings/narrative-intelligence/final.mp4
```

Transcribe the MP4 and compare transcript text and cue ordering with the cue file. Review frames at the first frame, every narrated transition, and the last frame; listen to the entire final mix for timing, intelligibility, clipping, abrupt endings and audio/video sync. Use `manus-analyze-video` or equivalent timestamped frame checks if available. The Playwright exit code is authoritative for the test; speech-to-text or visual review does not turn a failed Playwright test into a pass.

Do not upload or publish the recording as part of this plan. Publishing is a separate action requiring explicit user request and confirmation of the exact artifact/visibility.

## 8. Release report contents

For each test run, record the branch/commit, toolchain versions, exact commands, test tags, final pass/fail/skip/timed-out/interrupted counts, database fixture version, service mode, and any live-dependency tags. Keep the raw JSON/trace/video in ignored directories. For the demo, record the captured test name, WebM/MP4 paths, narrator key, cue file, ffprobe properties, transcription result and reviewer name/date. The report must distinguish “UI test passed with a stub” from “service integration passed against a local DuckDB test store.”

Before declaring a release ready, run the existing project checks as relevant (`npm run test:run`, `npm run build`, `npm run lint`, `npm run test:e2e`, `cargo test --workspace`) plus the new NIP crate and focused journey tests. Run current pricer and trade-fixing journeys as regression checks. Do not claim success for unexecuted commands or skipped service-backed tests.

## 9. Repository references

- [Playwright suite guide](../playwright/README.md), [current config](../playwright.config.ts), [tag vocabulary](../playwright/support/tags.ts), [demo spec](../playwright/demo.spec.ts), and [demo production skill](../playwright/skills/demo/SKILL.md) define the established testing and narration behavior.
- [Trade fixing workflow](./54-trade-fixing-workflows.md) provides a user-journey pattern with provenance and safe bulk operations.
- [TAC lake skill](../modules/tac-engine/skills/tradeac-lake/SKILL.md) and [dev:http launcher](../scripts/dev-http.mjs) define the current TAC root and local default; [trade-repository URL adapter](../scripts/lib/trade-repo/store.mjs) defines existing `DATABASE_URL` SQLite/PostgreSQL conventions.
- [Aligned BRD](./55-narrative-intelligence-aligned-brd.md) defines data/claim/metric semantics; [implementation plan](./56-narrative-intelligence-implementation-plan.md) defines system boundaries and sequence.
- [User's commentary-video reference](https://github.com/rehabvid/rehab-video-maker) informs the narrated technical-demo style and RSS discovery/local-ASR workflow; the repository's Playwright demo skill is the source for concrete capture/export mechanics used here, and doc 58 links to the specific podcast workflow files.

**Phase 0 baseline:** Settled by [doc 58](./58-narrative-intelligence-phase-0-decisions.md). These are planned checks for those decisions, not evidence that NIP features are implemented.

## Latest verified run

- Rust gate: `cargo fmt --all && cargo test -p nip-domain -p nip-store -p nip-engine` — passed (3 domain, 7 store, 25 engine tests).
- Frontend gate: `npm run build && npx tsc --noEmit --pretty false` — passed.
- Real service journey: `PLAYWRIGHT_NIP=on npm run test:e2e:demo -- --grep @demo-narrative-research` — 1 passed. The journey used the real NIP Streamable HTTP server, disposable DuckDB, loopback RSS/audio fixture, deterministic ASR, canonical event search, and deterministic claim extraction; it did not stub NIP responses.
- Narrated artifact: `playwright/recordings/narrative-intelligence/final.mp4`, 1280×720, 18.48 seconds, one H.264 video stream and one AAC mono narration stream at 48 kHz. Speech-to-text recovered the four cues in order.
- Known non-blocking harness noise: the Vite proxy logs a connection-refused warning for the optional RIGA HTTP port when that unrelated service is not started; the NIP journey itself passes against its required service and fixture dependencies.

### Phase 2 live-service verification — 2026-11-17

- Rust gate: `cargo fmt --all && cargo test -p nip-domain -p nip-store -p nip-engine` — passed (3 domain, 7 store, 27 engine tests); strict clippy for the three NIP crates also passed.
- Frontend gate: `npm run build && npm run test:run -- src/features/narrative/__tests__ src/features/workspace/__tests__` — passed (10 tests across 3 files).
- Live dependency: task-local Qdrant 1.15.5 on `127.0.0.1:6333/6334` with a deterministic OpenAI-compatible embedding fixture on `127.0.0.1:8788`; no public provider or external corpus was used.
- Protocol smoke: a disposable `NIP_TEST_MODE=1` DuckDB store and NIP Streamable HTTP MCP server initialized successfully; `rebuild_semantic_index`, `semantic_search`, `rebuild_narrative_clusters`, and `list_narrative_clusters` all completed successfully. The empty ledger returned a `ready` model-versioned manifest, an empty semantic result, and an empty persisted cluster projection; Qdrant reported a green derived collection.
- Compatibility fixes discovered by the live test: use Qdrant `/points/query`, parse `result.points`, and make collection initialization idempotent when the derived collection already exists. These are now in `crates/nip-engine/src/semantic.rs`.
- Parquet snapshot gate: `parquet_snapshot_round_trip_preserves_events_and_manifest` passed. The test exports the complete DuckDB database through DuckDB's Parquet database export, writes a versioned manifest with file count/content digest/event count, restores into a new database, and verifies the retained event and content hash. `export_parquet_snapshot` is exposed through the agent-native MCP tool; restore remains a controlled store operation until host recovery integration is added.
- Protocol smoke: a fresh disposable NIP Streamable HTTP service successfully called `export_parquet_snapshot` and returned format `nip-duckdb-export-parquet-v1`, event count `0`, and 14 exported database files.
- Desktop scheduler smoke: a freshly built NIP HTTP process emitted `nip_refresh_cycle_completed` during startup with `failed: 0` and `next_cycle_in_seconds: 21600` (six hours). The disposable process and its test data were then removed; no external or persistent scheduler was created.
- Subscription/recovery slice: `npm run build` passed and the focused Narrative/Workspace suite passed all 10 tests after adding the rights-confirmed subscription form, manual due-refresh action, next-poll/last-check/error presentation, and corrected semantic-mode reload dependency. The Rust all-target gate and strict Clippy passed after adding the explicit `--restore-snapshot PATH` startup recovery option; restore remains overwrite-safe because the store rejects an existing target database.
- Scope note: the live smoke validates the vector-store/MCP protocol boundary and persistence path. The narrated user-visible artifact remains the Phase 1/UX recording at `playwright/recordings/narrative-intelligence/final.mp4`; no new recording was claimed for this backend-only smoke.

### Populated financial retrieval benchmark — 2026-11-17

The reproducible benchmark runner is `scripts/benchmark-nip-semantic.mjs`, with the corpus in `benchmarks/nip-financial-corpus.json` and the npm entry point `npm run benchmark:nip:semantic`. It imported 15 exact excerpts from five public SEC Form 10-K filings covering banking, cloud/AI infrastructure, semiconductors, energy, and industrial equipment. Twelve finance-specific queries were evaluated against explicit relevance judgments at k=5 using Recall@5, Precision@5, MRR, and nDCG@5.

With the deterministic local embedding fixture used for integration testing, the Qdrant hybrid ranker achieved Recall@5 **100.0%**, Precision@5 **25.0%**, MRR **0.806**, and nDCG@5 **0.855**. A token-overlap lexical baseline achieved Recall@5 **100.0%**, Precision@5 **25.0%**, MRR **1.000**, and nDCG@5 **0.993**. The hybrid ranker therefore surfaced every judged relevant document in the top five, but its ordering was weaker than the lexical baseline on queries such as refining margins, dealer rental demand, and energy-transition policy. This is a retrieval-regression/integration result, not evidence of BGE-M3 quality: the run used an 8-dimensional deterministic provider fixture. A production BGE-M3 endpoint must be benchmarked separately before making semantic-quality claims.

Raw results and the readable report are stored in `artifacts/benchmark/nip-financial-retrieval.json` and `artifacts/benchmark/nip-financial-retrieval.md`. The SEC filing URLs used for the corpus are recorded in both artifacts, and every imported event retained its source URL and source-native benchmark ID.


### Phase 2 signal engine and discovery UI — 2026-11-17
- Signal regression: `signal_snapshot_uses_completed_utc_weeks_and_transparent_quality_flags` passed. It verifies Monday 00:00 UTC boundaries, prior/current counts, null percent change when the prior count is zero, exclusion of undated observations, and explicit `coverage_manifest_missing`.
- Live MCP smoke: a fresh disposable `NIP_TEST_MODE=1` Streamable HTTP service accepted `narrative_signal_snapshot` with `as_of=2026-11-17T12:00:00Z` and returned `formula_version=nip-signals-v1`, `coverage=unknown`, `current_week_start=2026-11-09T00:00:00Z`, and an empty signal list for the empty ledger.
- UI gate: production build and focused Narrative/Workspace tests passed (10 tests). Radar and Timeline are evidence-linked views; selecting an event ID returns to the immutable event detail panel.
- Quality boundary: the current signal response correctly reports unknown coverage because no source-completeness manifest is configured. It must not be interpreted as evidence that zero observed mentions means zero real-world mentions.

### Phase 2 narrated discovery journey — 2026-11-17
- `PLAYWRIGHT_NIP=on npm run test:e2e:demo -- --grep @demo-narrative-research` passed (1 test). The real service-backed journey now covers approved fixture ingestion, event provenance, Radar, Timeline, coverage warning, and evidence-linked Claim Explorer.
- Narrated recording refreshed at `playwright/recordings/narrative-intelligence/final.mp4` and `playwright/recordings/narrative-research/narrative-intelligence-demo.mp4`. `ffprobe` confirms one H.264 1280x720 video stream and one AAC 48 kHz mono audio stream, both 18.48 seconds.
- The optional RIGA proxy emitted the known connection-refused warning because that unrelated service was not started; the NIP journey itself passed against its required disposable service and fixture dependencies.

### Phase 3 manual themes and editorial review — 2026-11-17
- Schema gate: fresh/reopened DuckDB migration checks and future-schema rejection pass with supported schema version 6.
- Backend gate: strict Clippy for `nip-domain`, `nip-store`, and `nip-engine` passed; focused health, UTC signal, schema, and migration tests passed.
- Frontend gate: production build and focused Narrative/Workspace tests passed (10 tests). ETF Themes and Editorial Planning views are coverage-aware and keep backtest/CTR outputs disabled.
- Live MCP CRUD smoke: a disposable Streamable HTTP service imported one synthetic evidence event, saved and listed a version-1 `TLT` mapping with `market_data_coverage=unavailable`, replaced one editorial candidate derivation run, recorded a `deferred` review with reason/reviewer/time, and listed the persisted review result. The mapping and candidate both retained the synthetic event ID.
- Scope boundary: no public market-data feed, ticker master, total-return series, paper portfolio, backtest, monetization estimate, or investment recommendation was introduced. These remain gated until the point-in-time data and evaluation ADR is approved.

### Phase 2 operator journey and graph projection — 2026-11-17
- Backend gate: schema v7 graph migration, 3 domain tests, 8 store tests, 28 engine tests, and strict Clippy passed. The graph projection is persisted in DuckDB and rebuilt through `rebuild_narrative_graph`; every graph edge retains source event IDs and derivation run metadata.
- Agent observability: `nip_resource_status` reports canonical ledger size/counts, extraction run count, cluster/graph counts, scheduler ownership/cadence, semantic-index state/model, and safe warnings. `nip_extraction_status` reports extraction state, latest provider/model/prompt/run, evidence-linked claim count, and missing-evidence warnings.
- Frontend gate: `npm run build && npm run test:run -- src/features/narrative/__tests__ src/features/workspace/__tests__` passed (10 tests). The Narrative Workspace now presents an Operational Monitor and a Graph view with explicit rebuild and event-evidence drill-down.
- Narrated real-service journey: `PLAYWRIGHT_NIP=on PLAYWRIGHT_NIP_STARTUP_TIMEOUT=600000 npm run test:e2e:demo -- --grep @demo-narrative-research` passed (1 test, 30.0 seconds). The flow used the real NIP Streamable HTTP server and disposable DuckDB, showed resource/extraction state, opened the versioned graph, followed an evidence edge back to the immutable event, and continued through Radar, Timeline, and Claim Explorer.
- Recording: `playwright/recordings/narrative-intelligence/final.mp4` and `playwright/recordings/narrative-research/narrative-intelligence-demo.mp4` are 1280×720 H.264/AAC recordings of the passing journey, 18.48 seconds. The optional RIGA proxy connection-refused warning remains non-blocking because RIGA is not required by this deterministic local journey.
- Startup note: the NIP Playwright web-server timeout is configurable with `PLAYWRIGHT_NIP_STARTUP_TIMEOUT`; the default is 600 seconds to tolerate a cold bundled-DuckDB compile without changing browser test timeouts.

### Phase 3 UI and operational-monitor verification — 2026-11-17
- Component/build gate: `npm run build && npm run test:run -- src/features/narrative/__tests__/NarrativeWorkspace.test.tsx src/features/workspace/__tests__` passed. The focused suite now has 13 passing tests, including populated, empty/unavailable, warning, and loading states for `OperationalMonitor`.
- Real-service UI journey: `PLAYWRIGHT_NIP=on PLAYWRIGHT_NIP_STARTUP_TIMEOUT=600000 npm run test:e2e:demo -- --grep @demo-narrative-research` passed (1 test, 36.2 seconds). The journey verified resource/extraction monitoring, agent- and UI-triggered graph rebuild, evidence navigation, ETF Themes empty-state boundaries, Editorial Planning review boundary, Radar/Timeline, and Claim Explorer against disposable DuckDB and the real Streamable HTTP NIP service.
- The passing recording remains `playwright/recordings/narrative-intelligence/final.mp4`, a 1280×720 H.264/AAC artifact. The only logged non-blocking warning was the optional RIGA proxy connection refusal; the deterministic NIP journey does not require RIGA.
