# Phase 3 retained-record inventory and ownership matrix

**Status:** Phase 3A implementation baseline accepted; remaining Phase 3 gates open
**Date:** 2026-11-20
**Reference:** `docs/75-tradeac-migration.md`
**Source repository:** TradeAC at the frozen reference commit; read-only
**Target repository:** fina-builder

This document is the Phase 3 pre-implementation inventory for retained TradeAC scheduler, rounds, R&D, and RiskCube records. It is an ownership decision aid, not a migration script. No TradeAC records are copied, imported, or backfilled by this inventory.

**Target-validation rule:** TradeAC schemas and actions below are source evidence only:
they identify records, identifiers, lifecycle behavior, and authoritative service
boundaries. They are not the target schema or compatibility contract. All implementation
decisions, DTOs, repository tests, migrations, and transport validation must follow
fina-builder's existing Node trade-repository design in `scripts/lib/trade-repo/`:
storage ports, SQLite/PostgreSQL adapters, memory fixtures, MCP tool JSON Schemas,
bounded queries, cursor pagination, immutable/auditable records, and fina-builder's
browser/Tauri transport boundaries. No TradeAC Drizzle table layout, Next.js action
contract, or TradeAC Postgres/pgvector assumption is to be reproduced.

## 1. Decision rules

The migration preserves service boundaries rather than reproducing TradeAC's Next.js/Drizzle runtime:

- **Fina-owned metadata** may use a new Node repository/storage port following `scripts/lib/trade-repo/store.mjs`, with disposable SQLite by default, PostgreSQL as an optional contract target, and an in-memory adapter for tests.
- **Engine-owned truth** stays behind a named MCP/service boundary. This includes TAC lake facts, qlib/MLflow runs and artifacts, broker order/fill truth, and RiskCube partitions/cells.
- **References are not copies.** A fina-owned row may store an opaque experiment/run/model/cube identifier and user-facing configuration, but it must not become a second source of truth for engine data.
- **No production migration is implied.** If a future import is approved, it must be an explicit, versioned, idempotent import with provenance and a separately reviewed retention policy.
- **Unsupported means explicit.** A feature remains unavailable until the authoritative service, runtime prerequisite, validation rules, and deterministic fixture are defined. A fabricated local cube, fake broker state, or copied qlib result is not an implementation.

## 2. Scheduler records

Source evidence: TradeAC `scheduler_jobs` and `scheduler_runs` from `drizzle/0001_models_and_scheduler.sql`, amended by `0002_even_mister_sinister.sql` and `0004_mature_pepper_potts.sql`; behavior in `src/server/scheduler-actions.ts` and `src/lib/scheduler/runner.ts`.

| Record | Source fields / identifiers | Authoritative owner | Proposed fina-builder destination | Backend and lifecycle | Migration / retention policy | Fixture and test strategy | Status / defer decision |
|---|---|---|---|---|---|---|---|
| Scheduler job configuration | `id`, `name`, `city`, `timezone`, `time`, `days`, `experiment_name`, `run_id`, optional `model_id`, `strategy`, `enabled`, last-run status/error, timestamps | **Fina-owned configuration** if fina-builder owns the local scheduler; referenced model/run remains engine-owned | New scheduler repository record, with opaque model/run references and validated schedule fields | Node storage port; SQLite default, PostgreSQL contract target, memory tests. Mutable configuration; retain while enabled or until user deletes it. Last-run fields are a derived operational summary, not audit truth. | Do not import TradeAC jobs. If a user recreates one, validate timezone, HH:MM, ISO weekdays, and reference-run/model requirements. Retain deleted-job audit only if a later audit requirement is approved. | Pure validation tests for days/time/timezone and reference selection; SQLite restart and migration-idempotency tests; PostgreSQL parity test when disposable PostgreSQL is available; unavailable scheduler-service test. | **Inventory baseline accepted; implementation not started.** Scheduler ownership and unattended execution/failure semantics require a fina-builder automation decision before persistence is added. |
| Scheduler run history | `id`, `job_id`, city/model/strategy snapshot, `title`, `session_id`, `status`, `error`, `source`, `triggered_at`, `created_at` | **Fina scheduler/orchestration metadata**, while the agent session, qlib run, broker orders, and round book remain authoritative elsewhere | Fina-owned run-attempt metadata linked by opaque job/session/round identifiers; never a substitute for qlib or broker status | Node repository; append a run attempt, then update status/error as orchestration learns it. Retain bounded operational history (proposed default: 90 days) only after product approval; preserve failures longer if required for support. | No backfill. New records must be idempotent by an execution-attempt key supplied by the scheduler. Do not store prompts, credentials, raw tool payloads, or full chat transcripts. | Deterministic fake clock and fake session-status provider; success/failed/started reconciliation; duplicate-trigger idempotency; timeout/process-exit and redacted-error tests. | **Deferred pending automation ownership.** A manual “run now” record can be designed separately from an unattended scheduler. |
| Scheduler-to-model reference | `model_id` FK plus `experiment_name` and `run_id` fallback; `strategy` workflow name | Fina-owned reference/configuration; referenced model and run are MLflow/qlib-owned | Store only validated opaque references and a strategy identifier; do not resolve or duplicate artifacts in the scheduler repository | Same scheduler repository; lifecycle follows job/run reference. | No import of existing registry IDs. Re-linking must be explicit and must not silently change a historical run snapshot. | Contract tests reject missing/ambiguous references; fixture uses synthetic IDs and no model files. | **Retained as metadata only.** Full model lookup remains an R&D MCP operation. |

## 3. Trading rounds and execution trail

Source evidence: TradeAC `trading_rounds`, `round_intents`, `round_decisions`, `round_orders`, and `fact_events` from `drizzle/0005_trading-round-book.sql`; typed behavior in `src/server/rounds-actions.ts`; round-book MCP ownership in `tac-qlib/book_server` and the scheduler integration in `src/lib/scheduler/runner.ts`.

The round book is an execution ledger, not a UI cache. Its rows are written and calculated by the book service and are linked to scheduler/R&D metadata. Fina-builder must not independently reimplement round calculations or reconcile broker state from stale local rows.

| Record | Source fields / identifiers | Authoritative owner | Proposed fina-builder destination | Backend and lifecycle | Migration / retention policy | Fixture and test strategy | Status / defer decision |
|---|---|---|---|---|---|---|---|
| Trading round window | `id`, `source`, target/signal dates, scheduler-run and R&D references, experiment/run/model references, strategy snapshot, sizing equity, status, locked intent, summary metrics, feedback note, timestamps | `book_server` round-book service for the round lifecycle; scheduler owns only creation request metadata | Read through book MCP. Fina may later store a local opaque `round_id` link for navigation/session continuity, not a duplicate round row | Authoritative book persistence as defined by tac-qlib/book service. Lifecycle: open → intent/decision/execution → settled/terminal, with explicit failure state | No TradeAC backfill. New rounds only through the named book MCP contract. Historical links, if needed, are imported as references with provenance and no reconstructed metrics. | Temporary SQLite/book fixture with one open, one partially filled, one settled, and one failed round; MCP contract tests for `round_list`/`round_get`; lifecycle and unavailable-service tests. | **Read boundary exists in the reference architecture; fina persistence is deferred.** Round-service schema/retention contract must be reviewed before adding local links. |
| Fact event | `id`, `round_id`, `kind`, optional symbol, JSON payload, source, timestamp; examples include signals, quotes, news, account/position evidence | `book_server`/authoritative data providers; append-only provenance belongs to the book service | No fina-owned copy. Display DTOs are fetched through book MCP; local caching is out of scope for the first slice | Book service append-only event storage. Retain according to execution/audit policy; never mutate as a UI convenience. | No production lake, quote, news, or broker evidence migration. Fixtures must be synthetic and clearly labeled. | Deterministic facts with source/effective timestamps; test ordering, repeated fetch, payload shape, and redaction of secret-bearing provider fields. | **Engine/service-owned; deferred for local persistence.** TAC lake and broker truth must not be collapsed into fact-event JSON in fina. |
| Versioned round intent | `id`, round/version, superseded intent, target portfolio JSON, raw strategy output JSON, reason, timestamp | Book service for versioning; strategy output is produced by qlib/R&D and retained as provenance | Read-only DTO from book MCP; no fina-owned intent table | Append-only/versioned in book service; superseded versions remain for audit and reconciliation | No migration. New intent creation only through book MCP after strategy and side-effect policy are approved. Never store raw production strategy output in a new fina database. | Fixture with versions 1 and 2, supersession, deterministic target rows, and malformed/oversized payload rejection at service boundary. | **Deferred.** Requires approved book write contract and explicit broker-impact confirmation policy. |
| Per-symbol decision | `id`, round/intent, symbol, side, quantity, order type, expected price, status, reason/detail, supersession, timestamps | Book service decision/gating logic; market and sentiment evidence remains provider-owned | Read through book MCP only | Mutable status plus supersession in book service; retain with the round for audit | No import or local recomputation. Any future write must use book service gates and preserve reason/detail. | Fixture covers placed, skipped, cancelled, superseded, and invalid decisions; verify deterministic funnel counts and no fabricated market values. | **Deferred with round writes.** UI can remain read-only once a typed transport exists. |
| Round order and fills | `id`, decision/round IDs, Alpaca order/client IDs, intended/filled quantities, average fill, status, supersession, timestamps | **Broker is authoritative for order/fill truth; book service is the execution projection** | No fina-owned order table. Store only an opaque UI/session link if required | Broker lifecycle is external and asynchronous; book service syncs it via `round_sync_fills`. Fina must not infer fills from stale projections. | No broker-order migration and no live credentials in CI. Reconciliation starts from current broker/book service state, not imported rows. | Stub broker plus book MCP fixture for accepted, partial, filled, cancelled, unmatched, and delayed fills; confirmation tests assert exact mutation payloads. | **Read-only/deferred.** Broker mutations and fill synchronization require explicit confirmation and a settled service contract. |
| Round funnel/metrics/reconcile | Derived counts and rollups: target/decided/placed/filled, turnover, slippage, cost, residuals, summary metrics | Book service calculation over round/book rows plus broker state | Fetch as derived DTO; never persist as independent fina truth | Recomputed on read or by book service; lifecycle follows the underlying round | No migration. Do not copy production rollups. | Golden fixture checks funnel, reconcile rows, numeric serialization, and stable empty/error behavior. | **Deferred with round service.** No local formulas in React or trade repository. |

## 4. R&D records and artifacts

Source evidence: `rd_experiments` from `drizzle/0000_dizzy_mister_fear.sql` plus session linkage in `0006_rd_experiments_session_id.sql`; `rd_models` from `0001_models_and_scheduler.sql`; read/action boundaries in `src/server/rd-actions.ts`, `experiments-actions.ts`, `models-actions.ts`, and `src/lib/tac-qlib/rd-mcp-client.ts`.

The important distinction is between trace metadata that TradeAC currently stores in Postgres and the actual MLflow/qlib run, model, result, blotter, lineage, and artifact stores. The latter remain authoritative at the R&D service and its configured tracking/artifact backends.

| Record | Source fields / identifiers | Authoritative owner | Proposed fina-builder destination | Backend and lifecycle | Migration / retention policy | Fixture and test strategy | Status / defer decision |
|---|---|---|---|---|---|---|---|
| Traced experiment metadata | `id`, experiment name, rationale/details/evaluation, optional embeddings, metrics, `evolved_from`, start/end, git branch, MLflow reference ID, session ID, mlruns directory, status, timestamps | R&D trace service/qlib workflow for semantic meaning and lifecycle; any Postgres row is service-owned trace metadata | Query through `rd_server`. If local search/navigation needs persistence, store only a fina-owned saved reference or view, not a replica of `rd_experiments` | qlib/MLflow tracking and artifact prerequisites remain authoritative; embeddings are optional capability. | Do not migrate existing rows or embedding vectors. A future explicit import must define provenance and whether it is a cache or an owned catalog. | Temporary fixture lake/mlruns database; trace start/finish, lineage, missing embedding, and deterministic lexical fallback. No remote embedding or production MLflow. | **Service-owned; no fina persistence planned in this phase.** Local semantic search is unavailable unless the R&D service supports it; lexical fallback belongs at the service boundary. |
| R&D run, input, model, result, blotter | Tool identifiers `experiment_id`, `run_id`, model tree/seed; `rd_exp_input`, `rd_exp_model`, `rd_exp_result`, `rd_exp_blotter`; artifact/model paths | qlib + MLflow tracking/artifact store behind `rd_server` | Typed DTOs only; retain opaque experiment/run IDs in UI state or optional saved views | Engine-owned run/artifact lifecycle; paths are not renderer-controlled and must not be persisted in logs | No record or artifact copy. A run may be re-read from the configured service; unavailable service is an explicit setup state. | Deterministic temporary parquet lake and local mlruns fixture; MCP tool contract tests and experiment → run → result journey. | **Read-only integration planned in Phase 6; persistence deferred.** No portable fina repository for qlib internals. |
| Experiment lineage and notes | `evolved_from` chain, lineage nodes/edges, hypothesis/evaluation notes, optional session linkage | R&D trace service for lineage; notes are R&D metadata written through `rd_server` | Typed read DTO; notes write only through R&D MCP after destructive/write policy review | Service-owned, append/update according to trace service; delete is destructive and must remain service-side | No migration or bulk delete. Explicit user action only; retain lineage references with source IDs. | Fixture with ancestor/descendant graph, cycle guard, note update, deletion refusal/confirmation, and missing parent behavior. | **Lineage read is planned; writes/deletes deferred.** TradeAC auth actions are not ported as fake auth. |
| Model registry entry | `id`, unique name, description, experiment name, run ID, model path, universe, label, default strategy, metrics, status, timestamps | **Fina-owned registry metadata** is a reasonable target; underlying model artifact/run remains MLflow/qlib-owned | New small fina-owned repository record, with unique name and opaque experiment/run references | Node storage-port pattern; SQLite default, PostgreSQL optional, memory fixture. Mutable status/description; references must remain stable for historical scheduler snapshots. | No import of TradeAC registry rows. User-created entries only. Deletion must check scheduler references or use explicit detach semantics. | SQLite/PostgreSQL contract tests, unique-name conflict, restart replay, invalid reference shape, scheduler link fixture, and lexical search fallback if search is added. | **Candidate for implementation after review.** This is the clearest R&D record that may be fina-owned, but it must not imply model ownership. |
| R&D scheduler/model link | Model registry reference plus experiment/run/strategy snapshot used by a job or round | Fina scheduler/configuration for the link; R&D service for referenced model/run | Store as a foreign/opaque reference in the fina-owned scheduler/registry repository; snapshot identifiers at run creation | Fina-owned link lifecycle; no model artifact persistence | No backfill. Historical links are created only by explicit user configuration. | Referential-integrity and immutable historical snapshot tests. | **Deferred until scheduler and registry repositories are approved.** |

## 5. RiskCube records and queries

Source evidence: TradeAC `fina-actions.ts` and `riskcube/cubes/_components/cube-sql.ts`. The current boundary calls `fina-pricer` tools for scenarios, versions, slices, storage status, partitions, and read-only OLAP queries over `riskcube_cells`. The cube dimensions/measures, aggregation, filters, measure grain/LOD, limits, and pivot semantics are not provided by the current TAC market-data engine.

| Record / operation | Source fields / identifiers | Authoritative owner | Proposed fina-builder destination | Backend and lifecycle | Migration / retention policy | Fixture and test strategy | Status / defer decision |
|---|---|---|---|---|---|---|---|
| Scenario configuration | Scenario ID/key/version/name/kind, materialization mode, market-data and trade-repository snapshot references, manipulations, request template, metadata | `fina-pricer` scenario service | Typed MCP DTO; no local duplicate. A saved user selection may later store only the scenario ID/key. | Canonical pricer persistence; lifecycle controlled by scenario service, including create/update/delete. | No scenario import or snapshot copy. Destructive operations remain unavailable until confirmation and service contract are approved. | Mock pricer with list/create/update/delete, invalid ID, timeout, and capability-unavailable responses; IDs are synthetic. | **Deferred pending canonical OLAP/pricer capability decision.** |
| Version | Version ID/key/name/metadata/created timestamp | `fina-pricer` | Typed DTO; optional saved-view reference only | Pricer-owned version lifecycle; immutable/versioned semantics must be confirmed from service contract. | No version backfill. Never treat a local timestamp or UI selection as a version. | Fixture with two versions and deterministic selection/error behavior. | **Deferred with RiskCube capability.** |
| Slice definition | Slice ID/key/name/kind, match-any, validated field/operator/value conditions, description, metadata, timestamps | `fina-pricer` slice service | Typed DTO; saved view may store a validated slice reference or a portable user selection only after schema approval | Pricer-owned definition and validation; conditions must not become arbitrary SQL. | No import. Local saved definitions require an allowlisted schema/version and explicit ownership decision. | Contract tests for allowed fields/operators, empty conditions, deterministic ordering, and delete/update errors. | **Deferred.** Do not persist slice JSON in the trade repository yet. |
| RiskCube partition | Version/scenario scope, keys, cell/instance counts, first/last timestamps, source (`parquet`/`memory`) | OLAP/pricer storage engine | Read-only partition DTO | Engine-owned materialized data; storage mode may be memory/local/S3 as reported by the engine | Never migrate or duplicate partitions/cells. Storage mode and bucket diagnostics must not expose credentials or raw URLs. | Mock partition catalog and capability-status fixtures; assert redaction and explicit unavailable state. | **Unsupported until engine is selected and package/runtime prerequisite documented.** |
| `riskcube_cells` and derived cube result | Dimensions including scenario/version/case/instrument/underlying/date/etc.; PV/price/sensitivity measures; rows/columns result | Canonical OLAP engine (`fina-pricer`/DuckDB or approved successor) | No fina-owned persistence; validated query DTO and tabular result only | Engine-owned parquet/memory/OLAP lifecycle; query is read-only and bounded | No data migration, no fabricated cells, no production snapshot in tests. | Deterministic tiny `riskcube_cells` fixture; golden SQL/pivot tests for dimensions, measures, aggregation, filters, LOD, row/cell limits, and rejection of non-SELECT input. | **Explicitly unsupported/deferred.** Current TAC engine is not a replacement; implement only after capability comparison and ADR. |
| Saved cube view / user selection | Proposed fina-owned fields: name, engine capability/version, scenario/version/slice references, row/pivot axes, measures, aggregation, filters, LOD, timestamps | **Potentially fina-owned UI metadata**, not cube data | Future small repository or safe local preference, subject to schema/versioning; never arbitrary SQL | SQLite/local preference for disposable UI state, or PostgreSQL if shared views are later required. Retain until user deletes; version config for reproducibility. | No migration of TradeAC saved views. Reject unknown dimensions/measures/operators and stale engine versions. | Pure config validation, canonical serialization, migration/idempotency, deterministic saved-view replay against fixture cube. | **Deferred.** Do not expose RiskCube navigation until the engine capability gate and query contract exist. |
| OLAP query | Constrained SELECT/WITH generated from allowlisted dimensions/measures/filters/LOD; partition scope | OLAP engine validates and executes; fina transport validates the closed request shape | No persisted query text by default; optional saved config only | Request-scoped; bounded timeout/row/cell limits; no arbitrary SQL from renderer | No query history migration. If audit is later required, store redacted config/hash, not credentials or raw sensitive data. | Builder unit tests plus backend rejection tests for DDL/DML, unknown identifiers, excessive limits, and injection-shaped values. | **Read-only contract design only.** Implementation waits on canonical engine decision. |

## 6. Cross-cutting ownership, security, and failure policy

| Concern | Inventory decision |
|---|---|
| Database boundary | Renderer code never opens SQLite/PostgreSQL and never receives `DATABASE_URL`. New fina-owned repositories follow the Node storage-port pattern and expose typed MCP/service operations. |
| Secrets | Broker keys, database URLs, embedding keys, Git credentials, MLflow credentials, and object-store credentials remain in host/app-data environment or service configuration. Do not persist them in record payloads, saved views, DTOs, or logs. Redact connection diagnostics. |
| IDs and references | Engine identifiers are opaque strings/numbers at the fina boundary. Do not infer ownership from a numeric ID or recreate foreign keys across service databases. |
| Time and numeric serialization | Use ISO-8601 UTC timestamps at transport boundaries; preserve decimal quantities/prices as strings where precision matters; test JSON/null/number serialization explicitly. |
| Retention | No global retention policy is approved by this inventory. Proposed bounded scheduler operational history and service-specific round/R&D/RiskCube retention require product/operations review. Deletion must not silently delete engine artifacts or broker evidence. |
| Failure behavior | Missing service, missing configured lake, missing broker credentials, unsupported OLAP capability, timeout, invalid configuration, and process exit are typed unavailable/error states. They are not empty-success responses and must not trigger writes. |
| Authentication | **Deferred for Phase 3 in both web and desktop modes.** TradeAC `requireUser()` is not copied as a fake auth layer, and renderer-supplied role/session context is not treated as a security boundary. The current scope is local capability/configuration behavior; broker-impacting operations remain unavailable or require the existing explicit confirmation design until a separate authentication/authorization decision is approved. |
| Audit | The existing trade repository's audit events are for the separate fina-owned trade domain. Do not put scheduler/round/R&D/RiskCube engine records into `tr_audit_event` without an explicit domain decision. |
| Migration gate | No persistence implementation, production import, or navigation exposure proceeds from this inventory alone. The next approval must settle: scheduler ownership, model registry ownership, book-service persistence contract, canonical OLAP/pricer capability, and retention. |

## 6.1 Proposed OLAP contract aligned with fina patterns

The recommended RiskCube design is a **typed semantic OLAP MCP service**, not renderer-generated SQL and not a second database inside the trade repository. It should combine the trade repository's operational contract discipline with the RIGA sensitivity/P&L report discipline:

| Design concern | Proposed contract |
|---|---|
| Service boundary | Named `riskcube`/OLAP MCP tools behind the existing browser HTTP bridge or Tauri-owned stdio process. The renderer calls typed tools and receives normalized DTOs; it never opens DuckDB/parquet and never submits arbitrary SQL. |
| Query shape | A closed request such as `{ scope, dimensions, measures, filters, aggregation, measureLod, sort, limit, cursor, timeoutMs }`. Dimensions, measures, aggregations, operators, and limits are advertised by a capability tool and validated again by the backend. |
| Fina trade-repository alignment | Follow fina-builder's existing `scripts/lib/trade-repo/tools.mjs`, `store.mjs`, migrations, and fixture conventions: JSON schemas with `additionalProperties: false`, bounded `limit`, opaque cursor pagination, deterministic multi-field sorting, explicit validation errors, correlation IDs, and `memory:`/SQLite fixture support where metadata is fina-owned. Use `asOf`/snapshot references rather than silently querying “latest” data. Do not reproduce TradeAC's Drizzle tables or server actions. |
| Data ownership | `riskcube_cells`, partitions, scenario materializations, and OLAP execution remain owned by the canonical `fina-pricer`/OLAP engine. The fina-owned storage-port may later hold only saved query/view definitions and user selections in separate tables; it must not hold cube cells or engine result caches by default. |
| Report envelope | Return a stable envelope modeled on RIGA reports: `schema`, `query`, `scope`, `columns`, `rows`, optional `totals`, `truncated`, `nextCursor`, `provenance`, `assumptions`, `limitations`, `lineage`, `warnings`, and `engineRunId`/`snapshotId` where supplied by the engine. Every displayed sensitivity/P&L value must be labeled as engine-reported or derived. |
| Numeric contract | Quantities, prices, PV, P&L, and sensitivities use decimal strings at the MCP boundary when precision matters; counts use bounded integers; missing measures are `null`; non-finite values are rejected. UI formatting may convert validated decimal strings for display only. |
| Time and reproducibility | Use ISO-8601 UTC timestamps and explicit scenario/version/snapshot scope. A repeated query against the same engine snapshot and canonicalized request must produce stable column order, row order, and numeric serialization. |
| Safety limits | Enforce single bounded requests, maximum dimensions/measures, maximum rows/cells, maximum query duration, and partition scope in the backend. Reject unknown identifiers, disallowed expressions, DDL/DML, multiple statements, and injection-shaped values. A leading `SELECT`/`WITH` check alone is insufficient. |
| Errors and unavailable state | Return typed validation, unavailable, timeout, capability, and engine-error results. Do not convert missing OLAP data into an empty successful report, and do not write saved views after a failed query. |
| Saved views | Persist only validated semantic configuration plus engine capability/schema version and opaque scenario/version/slice references. Store through the Node storage-port in a separate RiskCube metadata repository/table set if shared persistence is later approved; local view preferences may remain in safe UI storage. |
| Testing | Use a tiny deterministic `riskcube_cells` fixture at the engine boundary and golden tests for query normalization, grouping, filters, LOD, totals, pivots, pagination, truncation, provenance, decimal/null serialization, and rejection of unsafe requests. Add browser and desktop transport tests for the same DTOs. |

This contract is a proposed design baseline, not an OLAP implementation decision. The canonical `fina-pricer` capability, runtime prerequisite, and supported storage mode still require an ADR before RiskCube navigation or persistence is added.

## 6.2 Remaining actionable serialization and secret-handling gates

Authentication and renderer-supplied role handling are intentionally deferred for Phase 3 in both web and desktop modes. The following gates are still required because they protect local persistence, sidecar diagnostics, and engine boundaries independently of authentication:

| Gate | Current evidence | Required action before Phase 3 persistence/OLAP implementation |
|---|---|---|
| Secret source boundary | `DATABASE_URL` is consumed by Node-side storage; the tac-qlib launcher forwards an explicit runtime allowlist; the renderer APIs do not open databases or receive credentials. | Keep credentials in host/app-data environment or service configuration. New feature DTOs and saved-view schemas must reject secret-like fields rather than merely relying on callers not to send them. |
| Connection and error redaction | PostgreSQL `store.location` masks the password, and unsupported URL errors expose only the scheme. The trade-repository bridge logs startup location and raw internal errors. | Add a shared safe diagnostic/redaction rule before adding new repositories: mask URL userinfo, query parameters, authorization headers, broker/embedding/Git keys, and nested secret-like fields. Tests must assert raw values never appear in startup, connection, MCP, or serialization errors. |
| Persisted JSON safety | The existing trade repository uses `JSON.stringify`/`JSON.parse` for its domain payloads and does not provide a generic secret scrubber or non-finite-value guard. | Implemented for new Phase 3 boundaries in `scripts/lib/phase3-contracts/serialization.mjs`: typed safe JSON serialization rejects `BigInt`, functions, `undefined`, circular values, non-finite numbers, oversized payloads, and secret-like keys. Do not broaden the existing trade repository payload contract incidentally. |
| Decimal and integer wire types | Existing RIGA UI DTOs use JavaScript numbers for engine-reported analytics; the proposed OLAP contract now requires decimal strings where precision matters. | Implemented canonical decimal, safe-integer, integer-string, timestamp, and explicit-null assertions in `scripts/lib/phase3-contracts/serialization.mjs`; focused Vitest coverage rejects exponent notation, non-finite values, unsafe integers, ambiguous timestamps, and normalizes negative zero. Conversion to `number` remains presentation-only and must be bounded/finite. |
| Timestamp normalization | Existing trade-repository schemas document ISO-8601 UTC text and source code commonly emits `toISOString()`. | Validate timestamps at each new MCP boundary, normalize generated timestamps to UTC, reject ambiguous local timestamps, and test `null` versus omitted fields consistently across SQLite/PostgreSQL and engine fixtures. |
| Cross-adapter parity | SQLite and PostgreSQL storage adapters already replay JSON payloads and redact the visible PostgreSQL location; parity tests exist for the trade repository. | Add Phase 3 contract fixtures that round-trip the same safe DTO through memory, SQLite, PostgreSQL-when-available, browser HTTP, and desktop stdio paths. Assert identical normalized values and no secret leakage. |
| Sidecar environment diagnostics | The tac-qlib child receives only named runtime variables, including necessary secrets; child output is inherited by the launcher. | Do not print the child environment or command-line secrets. Redact setup failures and document which variables are required without echoing their values. Add a probe with sentinel secrets and assert logs remain clean. |
| OLAP query/report boundary | The proposed contract requires typed semantic requests and a RIGA-style report envelope. | Enforce schema/identifier allowlists, single bounded requests, cell/row/time limits, snapshot scope, decimal/null serialization, provenance, and rejection of unsafe expressions in the backend. A leading `SELECT`/`WITH` check alone is not sufficient. |

These are implementation and test gates, not an authentication project. They may proceed while web/desktop authentication remains deferred.

## 6.3 Explicit numeric wire types and decimal serialization

The OLAP service must not rely on JavaScript `number` to carry financial precision across MCP, HTTP, Tauri, storage, or report boundaries. Numeric meaning is declared by the report column descriptor; the row value follows the descriptor's wire type.

### 6.3.1 Wire types

| Wire type | JSON representation | Allowed range / grammar | Use |
|---|---|---|---|
| `decimal` | JSON string | Canonical `DecimalString`; no exponent notation, `NaN`, `Infinity`, or locale separators | PV, P&L, prices, quantities, rates, ratios, Greeks, sensitivities, costs, notionals, and other precision-bearing measures |
| `safe_integer` | JSON number | Integer in `[-9007199254740991, 9007199254740991]`; report-specific bounds may be narrower | Small bounded counts such as number of rows, paths, trades, or cells when the schema guarantees the bound |
| `integer_string` | JSON string | Optional leading `-`, ASCII decimal digits only; no exponent or separators | Database IDs, engine IDs, cursor sequence values, counts, or other integers that may exceed JavaScript's safe-integer range |
| `boolean` | JSON boolean | `true` or `false` only | Flags such as `truncated` or `is_stressed` |
| `timestamp` | JSON string | ISO-8601 UTC instant with `Z`, including milliseconds for generated values | `createdAt`, `evaluatedAt`, `asOf`, `firstAt`, `lastAt`, and provenance timestamps |
| `date` | JSON string | `YYYY-MM-DD` | Business dates and valuation dates; never use a local-time timestamp for a date-only field |
| `string` | JSON string | UTF-8 text with field-specific maximum length | Dimension values, currency codes, scenario keys, units, labels, and opaque references |
| `null` | JSON `null` | Explicit absence only | Missing/unavailable measure, not applicable value, or engine result intentionally not produced |

The report schema must declare the type for every returned column. A value must not change from `decimal` to JSON number merely because a fixture happens to contain an integer-looking value. Likewise, a missing measure must be `null`, not `0`, an empty string, or an omitted property.

### 6.3.2 Canonical `DecimalString`

`DecimalString` is a base-10 exact value serialized as a JSON string using this grammar:

```text
^-?(0|[1-9][0-9]*)(\.[0-9]+)?$
```

Serialization rules:

1. Use ASCII `-` and `.` only. Do not emit `+`, exponent notation (`1e-7`), commas, currency symbols, percent signs, or locale digits.
2. Use no leading zeroes in the integer part, except the single zero before a fractional part (`0.125`).
3. Do not emit negative zero. Values numerically equal to zero serialize as `"0"`.
4. Preserve exact producer precision; do not convert through binary floating point and do not round merely to fit the wire format.
5. For deterministic transport, remove insignificant trailing fractional zeroes (`"12.3400"` becomes `"12.34"`; `"12.000"` becomes `"12"`). If display scale matters, declare it separately as metadata rather than encoding it in the value.
6. Reject non-finite values, empty strings, whitespace-padded values, exponent notation, and values outside the producer's declared precision/range.
7. Arithmetic, aggregation, and rounding happen in the authoritative engine using decimal-aware operations. The transport layer validates and canonicalizes; it does not recompute financial values.

The canonicalization function must be idempotent: `canonicalize(canonicalize(x)) === canonicalize(x)`. Decimal equality is value-based after canonicalization, while report provenance may retain the engine's calculation precision and rounding policy.

### 6.3.3 Units, scale, and rounding

Every precision-bearing report column must include enough metadata to prevent unit ambiguity:

```json
{
  "key": "delta",
  "label": "Delta",
  "wireType": "decimal",
  "unit": "underlying_units",
  "currency": null,
  "displayScale": 6,
  "signConvention": "long_positive",
  "source": "engine_reported"
}
```

Required conventions:

- Monetary columns declare `unit: "currency_amount"` and a three-letter `currency`, for example `USD`; they do not embed the currency symbol in the value.
- Prices declare their quote unit and currency. A percentage-style measure declares whether its value is a fraction (`"0.0125"`) or percentage points (`"1.25"`) through an explicit `unit`; the wire value never carries `%`.
- Sensitivities declare their unit and sign convention. The report must distinguish engine-reported values from values derived by the UI.
- `displayScale` is presentation metadata only. It does not authorize rounding of the wire value.
- If the authoritative engine rounds a result, the report provenance must include the rounding mode and, where available, calculation scale. The transport must not silently apply a second rounding step.
- Aggregation must occur before serialization at the engine's declared precision. The client must not sum serialized display values.

### 6.3.4 Report examples

A sensitivity/P&L report should use typed columns and string decimals, for example:

```json
{
  "schema": "fina.risk-report/v1",
  "columns": [
    {"key":"scenario_key","wireType":"string","unit":"dimension"},
    {"key":"pv_amount","wireType":"decimal","unit":"currency_amount","currency":"USD","source":"engine_reported"},
    {"key":"delta","wireType":"decimal","unit":"underlying_units","source":"engine_reported"},
    {"key":"pnl","wireType":"decimal","unit":"currency_amount","currency":"USD","source":"derived_by_engine"},
    {"key":"path_count","wireType":"safe_integer","unit":"count"}
  ],
  "rows": [
    ["base", "1250000.125", "-430.5", "-1250.00", 10000],
    ["stress-up", null, "-512.25", "-8450.75", 10000]
  ],
  "provenance": {
    "snapshotId":"snap-2026-11-20T12:00:00Z",
    "evaluatedAt":"2026-11-20T12:00:03.125Z",
    "roundingMode":"engine-defined",
    "calculationPrecision":"engine-defined"
  }
}
```

The exact measure names and units remain engine-specific, but the wire rules are not. Contract tests are implemented in `scripts/lib/phase3-contracts/__tests__/serialization.test.mjs` and cover positive/negative values, zero and negative-zero normalization, very small and very large valid decimals, nulls, invalid exponents, non-finite values, unsafe integers, timestamp normalization, secret-key rejection, nested diagnostic redaction, and payload limits. SQLite/PostgreSQL/HTTP/stdio round-trip tests remain a follow-up gate for the repositories and transports that consume these helpers. TradeAC fixtures may provide source-shaped examples only; they are not target validation fixtures.

## 7. Phase 3A implementation record

Phase 3A was implemented in fina-builder without copying TradeAC schemas or migrating
production records. The accepted baseline consists of:

- `scripts/lib/phase3a/metadata-repository.mjs`: fina-owned model-registry metadata,
  validated scheduler configuration, and manual execution-attempt metadata with memory,
  SQLite, and optional PostgreSQL adapters. Model/run/artifact identifiers remain opaque
  references to qlib/MLflow-owned data.
- `scripts/lib/phase3a/book-contract.mjs` and `src/api/bookApi.ts`: a read-only,
  allowlisted `round_list`, `round_get`, `trail_query`, `trail_funnel`, and `round_metrics`
  contract with normalized decimals/timestamps and browser HTTP plus Tauri-owned stdio
  transports. Round writes, fill synchronization, order placement, and broker mutations
  are not exposed.
- `scripts/lib/phase3-contracts/serialization.mjs`: safe JSON, decimal, integer,
  timestamp, and nested diagnostic redaction gates used by the new boundaries.

Evidence recorded on 2026-11-20:

- Focused Phase 3A Vitest suite: `scripts/lib/phase3a/__tests__` plus
  `src/api/__tests__/bookApi.test.ts` — 3 files and 15 tests passed after the PostgreSQL
  adapter enhancement.
- `npm run build` passed after the Phase 3A implementation and final focused verification.
- Rust formatting passed for the touched Tauri files. Full workspace formatting remains
  subject to pre-existing differences in unrelated Rust files.
- PostgreSQL parity is an optional contract target. It is not claimed as live integration
  evidence unless a disposable PostgreSQL service is configured.

No production TradeAC rows, broker orders, MLflow records, qlib artifacts, lake data, or
RiskCube cells were imported or modified. Authentication and renderer-supplied roles are
deferred in both web and desktop modes. Unattended scheduling, RiskCube persistence, and
canonical OLAP/pricer selection remain outside Phase 3A.

## 8. Review checklist and next implementation gates

1. Confirm whether fina-builder owns recurring scheduler configuration and whether unattended execution is allowed in desktop/browser modes.
2. Approve the candidate fina-owned model registry and scheduler repository shape, including PostgreSQL/SQLite parity and deletion/reference behavior.
3. Confirm that round records remain solely book-service-owned and define the supported read/write MCP contract, including broker fill synchronization.
4. Compare the available `fina-pricer`/OLAP capability with the proposed typed semantic contract and RIGA report envelope. Record the canonical engine/runtime decision in an ADR before RiskCube implementation.
5. Define retention and audit requirements separately from schema portability.
6. After review, add repository migrations and contract fixtures only for records explicitly classified as fina-owned. Do not add migration code for engine-owned tables.

## 9. Source map

- TradeAC source inventory only: `tac-app/drizzle/0000_dizzy_mister_fear.sql`, `0001_models_and_scheduler.sql`, `0002_even_mister_sinister.sql`, `0004_mature_pepper_potts.sql`, `0005_trading-round-book.sql`, `0006_rd_experiments_session_id.sql`.
- TradeAC typed schema commentary and relations: `tac-app/src/db/schema.ts`.
- Scheduler lifecycle: `tac-app/src/server/scheduler-actions.ts`, `tac-app/src/lib/scheduler/runner.ts`.
- Round API boundary: `tac-app/src/server/rounds-actions.ts` and `tac-qlib/book_server` contract.
- R&D API boundary: `tac-app/src/server/rd-actions.ts`, `experiments-actions.ts`, `models-actions.ts`, and `src/lib/tac-qlib/rd-mcp-client.ts`.
- RiskCube boundary: `tac-app/src/server/fina-actions.ts` and `src/app/(main)/riskcube/cubes/_components/cube-sql.ts`.
- fina-builder target validation precedent: `scripts/lib/trade-repo/store.mjs`, `scripts/lib/trade-repo/tools.mjs`, `scripts/lib/trade-repo/migrations/`, `scripts/lib/trade-repo/__tests__/`, and the existing browser/Tauri MCP transports.
