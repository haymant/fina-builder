# ADR-Phase3: Phase 3 ownership and lifecycle gate decisions

**Status:** Accepted for Phase 3A implementation
**Date:** 2026-11-20
**Owners:** fina-builder maintainers
**Scope:** TradeAC migration Phase 3
**References:** [`docs/75-tradeac-migration.md`](75-tradeac-migration.md), [`docs/76-phase3-record-inventory.md`](76-phase3-record-inventory.md)

**Acceptance record (2026-11-20):** The proposed defaults are accepted for Phase 3A implementation. The implementation is limited to fina-owned metadata, manual/local scheduler attempts, and a read-only book boundary. Unattended scheduling, broker mutations, authentication, RiskCube persistence, and production-data migration remain deferred.

## 1. Decision summary

This ADR proposes the four ownership and lifecycle decisions required before fina-builder adds Phase 3 persistence or exposes the deferred Trading 2ⁿd/R&D workflows:

1. **Scheduler:** fina-builder may own validated scheduler configuration and execution-attempt metadata, but the first implementation is manual/local and read-safe. Durable unattended execution is deferred until a separate runtime and operations decision defines durability, overlap, retry, cancellation, and shutdown semantics.
2. **Model registry:** fina-builder owns a small metadata registry and scheduler linkage. qlib/MLflow remain authoritative for experiments, runs, model artifacts, result data, lineage, and artifact lifecycle.
3. **Book service:** `tac-qlib.book_server` remains the authoritative round-book service. fina-builder consumes a typed read-only MCP contract first and does not create a duplicate round, fact, intent, decision, order, fill, or metric repository. Book writes and broker-impacting operations remain deferred.
4. **Retention:** fina-owned metadata follows explicit record-class policies. Scheduler attempts use bounded operational retention; model registry entries remain until explicit deletion subject to reference checks; round-book, broker, qlib/MLflow, lake, and RiskCube records retain the policies of their authoritative services. Fina deletion must not delete engine artifacts or broker evidence implicitly.

These are proposed design decisions, not a claim that the corresponding repositories, schedulers, or transports have already been implemented.

## 2. Context

Phase 3 requires fina-builder to distinguish configuration and references owned by fina-builder from truth owned by TAC, qlib/MLflow, the broker, the round-book service, or a future OLAP/pricer capability. TradeAC schemas and actions are source evidence only; they are not target schemas or compatibility contracts.

The target architecture is the existing fina-builder architecture:

```text
React/Vite renderer
  -> typed feature API
    -> browser HTTP MCP bridge or Tauri-owned stdio client
      -> named service or fina-owned Node repository
```

The renderer must not open databases, launch processes, select executables, receive credentials, submit arbitrary SQL, or infer authority from foreign IDs. New fina-owned persistence must follow the existing Node storage-port conventions: memory fixtures, disposable SQLite by default, optional PostgreSQL contract coverage, idempotent migrations, bounded queries, explicit validation, and redacted diagnostics.

The current repository contains no fina-owned scheduler or model-registry implementation. The qlib round book already has a write-capable Postgres-backed MCP service in `modules/tac-qlib/tac_qlib/book_server.py` and `book_db.py`. Its round tables and execution logic must therefore remain service-owned rather than being copied into the fina trade repository.

Authentication and renderer-supplied role handling remain intentionally deferred for Phase 3 in both web and desktop modes. This ADR does not introduce a fake `requireUser()` layer. Broker-impacting operations remain unavailable or require the existing explicit confirmation design until a separate authentication/authorization decision is approved.

## 3. Decision 1 — Scheduler ownership and execution scope

### 3.1 Decision

Fina-builder owns only scheduler configuration and orchestration metadata that are necessary for the fina-builder user experience. It does not automatically become the owner of qlib runs, model artifacts, round-book truth, broker orders, fills, or market-data facts.

The initial implementation may contain:

- validated schedule configuration;
- an opaque model-registry reference and optional experiment/run references;
- strategy identifier and immutable execution snapshot metadata;
- enabled/disabled state;
- manual “run now” requests;
- execution-attempt metadata such as attempt ID, job ID, trigger source, lifecycle status, timestamps, and redacted error summary.

The initial implementation must not claim to provide durable unattended scheduling. Renderer timers and React lifecycle effects are not an acceptable source of durable schedule truth.

Unattended execution is a follow-up decision. If it is required, it must be implemented by an explicitly selected application/runtime capability or a separately operated durable service, not by silently substituting a Manus ScheduleTask or Trigger for the product scheduler. Manus-level scheduling and condition triggers may be used for distinct Manus automation requests, but they do not define the Trading 2ⁿd application scheduler contract.

### 3.2 Required scheduler semantics before unattended execution

A later unattended scheduler ADR or amendment must define:

- execution runtime and process ownership in web and desktop modes;
- persistence and restart recovery;
- IANA timezone and daylight-saving behavior;
- missed-run policy;
- overlap policy, including whether concurrent runs are rejected, queued, or coalesced;
- idempotency key and duplicate-trigger behavior;
- retry/backoff and maximum attempt count;
- timeout, cancellation, and child-process cleanup;
- failure classification and redacted diagnostics;
- relationship between an execution attempt, qlib/MLflow run, book round, and broker side effect;
- retention and support access for attempt history;
- capability/unavailable behavior when qlib, book service, lake, credentials, or broker access is absent.

### 3.3 Consequences

Positive consequences:

- fina-builder can provide safe configuration and manual orchestration without inventing a second execution engine;
- scheduler records remain portable and testable through the existing Node storage-port pattern;
- run history does not masquerade as qlib/MLflow or broker truth;
- the product can keep scheduler and broker mutations unavailable while authentication is deferred.

Costs and risks:

- recurring unattended execution is not available in the first slice;
- a later durable scheduler may require a persistent runtime or external application service;
- scheduler attempts need reconciliation against authoritative services rather than assuming local status is final.

### 3.4 Initial data boundary

A future fina-owned scheduler repository may store fields equivalent to:

```text
scheduler_job
  id, name, timezone, time, weekdays, enabled,
  strategy_id, model_registry_id,
  optional opaque experiment_id/run_id,
  created_at, updated_at

scheduler_run_attempt
  id, scheduler_job_id, idempotency_key,
  trigger_source, status, started_at, finished_at,
  opaque session_id/round_id/run_id references,
  redacted error summary, immutable execution snapshot
```

It must not store raw prompts, credentials, database URLs, full chat transcripts, model files, broker orders, fills, lake data, or copied round-book facts.

## 4. Decision 2 — Model registry ownership

### 4.1 Decision

Fina-builder owns a small model-registry metadata catalog. The catalog is a reference and configuration service, not a model-artifact store and not an MLflow replacement.

Fina-owned metadata may include:

- stable registry entry ID;
- unique display name;
- description and status;
- strategy/default-strategy identifier;
- opaque experiment and run references;
- service-provided opaque artifact reference, when available;
- bounded metrics summary or display metadata;
- created/updated timestamps;
- scheduler references and immutable historical snapshots.

qlib/MLflow remain authoritative for:

- experiments and runs;
- model artifacts and artifact paths;
- result, blotter, and input data;
- lineage and run lifecycle;
- artifact retention and deletion;
- engine-specific metrics and provenance.

The registry must not accept renderer-controlled arbitrary filesystem paths, credentials, raw MLflow URLs, object-store URLs, or model contents. A service-owned artifact reference may be displayed only as an opaque reference or a redacted, validated descriptor.

### 4.2 Lifecycle rules

- Registry entries are user-created in fina-builder; TradeAC registry rows are not imported.
- A scheduler or round stores a reference to a registry entry plus an immutable snapshot of the identifiers needed to reproduce the historical association.
- Updating a registry description or current status must not rewrite historical scheduler-attempt or round snapshots.
- Deletion must fail when active scheduler references exist, or require an explicit detach operation with defined historical behavior.
- Deleting a fina registry entry must never delete the underlying qlib/MLflow experiment, run, model artifact, or lineage.
- Search is optional. If implemented before pgvector is available, use deterministic lexical search; do not add a semantic-vector dependency to SQLite.

### 4.3 Consequences

Positive consequences:

- the UI can provide stable model selection and scheduler linkage without claiming model ownership;
- the registry is small enough for portable SQLite/PostgreSQL repository tests;
- qlib/MLflow prerequisites remain explicit and engine-specific.

Costs and risks:

- registry metadata can become stale relative to MLflow/qlib and must expose unavailable or unresolved-reference states;
- the contract needs clear handling for deleted/renamed engine references;
- metrics shown in the registry must be labeled as sourced metadata, not recomputed fina values.

## 5. Decision 3 — Book-service boundary

### 5.1 Decision

`tac-qlib.book_server` is the authoritative owner of round-book lifecycle and execution-trail data. Fina-builder will not create a duplicate local repository for:

- round windows;
- fact events;
- versioned intents;
- per-symbol decisions;
- round orders or fills;
- funnel, reconciliation, or round metrics.

Fina-builder may own safe UI state or opaque references needed for navigation/session continuity, but those references are not a second round-book truth.

The first integration is a read-only typed MCP contract. The initial tool subset should be limited to operations equivalent to:

```text
round_list
round_get
trail_query
trail_funnel
round_metrics
```

The following remain deferred:

- round creation or update;
- fact recording;
- intent creation;
- decision recording;
- order linking;
- fill synchronization;
- broker order placement or cancellation;
- any action that changes the authoritative round or broker state.

### 5.2 Boundary requirements

The fina transport must:

- expose stable normalized DTOs rather than Python/Postgres row shapes;
- preserve engine and broker IDs as opaque references;
- serialize precision-bearing quantities, prices, P&L, turnover, and slippage as canonical decimal strings;
- use explicit `null` for missing measures;
- preserve ISO-8601 UTC timestamps;
- distinguish empty results from unavailable service, timeout, validation error, and process exit;
- redact database URLs, broker credentials, authorization values, and nested secret-like fields;
- avoid exposing model filesystem paths or raw connection diagnostics;
- support equivalent browser HTTP and desktop stdio contracts;
- keep renderer code unaware of `DATABASE_URL`, Postgres, Python launch details, and broker credentials.

The current book implementation uses Postgres and contains write-capable tools. Its service prerequisite and write surface must be represented as an explicit capability/setup state, not silently treated as an empty result. Any conversion of `Decimal` values to floating-point numbers inside the service boundary must be corrected or normalized before the values cross the fina typed boundary.

### 5.3 Consequences

Positive consequences:

- one authoritative round and execution trail remains in the book service;
- React does not reimplement round calculations, reconciliation, or fill inference;
- broker-impacting actions remain isolated behind a later confirmation and authorization decision;
- read-only UI work can proceed without migrating TradeAC records.

Costs and risks:

- the initial round UI depends on the book service and its Postgres/runtime prerequisite;
- browser and desktop transports require fixture parity testing;
- service schema and retention changes remain coordinated with the book-service owner.

## 6. Decision 4 — Retention and deletion policy

### 6.1 Decision

Retention is defined by ownership and record class. There is no single global fina-builder retention period for engine-owned truth.

| Record class | Owner | Initial policy | Deletion behavior |
|---|---|---|---|
| Scheduler configuration | fina-builder | Retain while enabled or until explicit user deletion; disabled records remain available for configuration history only if the product requires it | Delete only fina-owned configuration; never delete referenced engine records |
| Scheduler execution attempts | fina-builder orchestration metadata | Bounded operational history; initial proposal is 90 days, subject to product/operations approval | Purge only fina-owned attempt metadata after the approved window; retain redacted failure summaries only if support policy requires it |
| Model registry metadata | fina-builder | Retain until explicit user deletion, subject to active-reference checks | Block or explicitly detach active scheduler references; never delete qlib/MLflow artifacts |
| Round book and fact events | book service | Follow the book service's execution/audit policy | Fina-builder does not purge or mutate book records |
| Broker orders and fills | broker; book service provides projection | Follow broker and execution/audit policy | No fina deletion or inferred cleanup |
| qlib/MLflow experiments, runs, models, artifacts, lineage | qlib/MLflow and configured artifact stores | Follow their service and operations policy | No fina deletion or artifact copy |
| TAC lake data | TAC/lake owner | Follow lake retention policy | No fina migration or cleanup |
| RiskCube partitions/cells/materializations | canonical OLAP/pricer engine | Follow engine policy | No fina deletion or duplicate cache |
| Saved views and user selections | fina-builder, if later approved | Retain until user deletion; version configuration for reproducibility | Delete only validated fina-owned metadata |

The 90-day scheduler-attempt period is a proposed default, not a final operational commitment. Approval of this ADR should confirm whether support/audit requirements require a longer period or separate immutable audit storage.

### 6.2 Deletion invariants

- Deleting fina metadata never cascades into engine-owned or broker-owned records.
- No cleanup job may use a foreign ID to infer ownership in another service database.
- Failed deletion must be an explicit typed error and must not be reported as successful empty state.
- Any future import or cache must declare provenance, ownership, retention, and deletion semantics before implementation.
- Existing fina trade-repository audit events are not a catch-all audit store for scheduler, round, R&D, or RiskCube records.

### 6.3 Consequences

Positive consequences:

- ownership and deletion boundaries remain explicit;
- local development can use disposable SQLite metadata without touching production services;
- engine and broker audit policies are preserved.

Costs and risks:

- records may have different retention windows and operational owners;
- support tooling must distinguish missing local metadata from unavailable authoritative services;
- a later compliance or audit requirement may require an amendment and additional immutable storage.

## 7. Security and authentication constraints

This ADR does not implement authentication or renderer-supplied roles. Those concerns remain deferred for Phase 3 in both web and desktop modes.

The following constraints apply immediately:

- credentials stay in host/app-data environment or service configuration;
- renderers never receive database URLs, broker keys, MLflow credentials, Git credentials, object-store credentials, or embedding keys;
- feature DTOs and saved-view schemas reject secret-like fields;
- diagnostics redact URL userinfo, query parameters, authorization headers, and nested secret-like keys;
- broker-impacting operations remain unavailable or explicitly confirmed through the existing fina-builder design;
- no new operation may use local capability/configuration state as a substitute for a future authorization boundary.

## 8. Implementation sequence after approval

Approval of this ADR authorizes design and contract work, not production-record migration or broker actions. The recommended implementation order is:

1. Add the fina-owned metadata repository/storage-port skeleton with memory and SQLite adapters, idempotent migrations, and optional PostgreSQL contract coverage.
2. Implement model-registry metadata contracts and tests first.
3. Implement scheduler configuration and manual-run attempt metadata without unattended execution.
4. Implement the read-only book MCP DTO/transport boundary and browser/desktop fixture tests.
5. Add cross-adapter numeric, timestamp, redaction, and unavailable-state round-trip tests.
6. Reassess unattended scheduling only after runtime, restart, overlap, retry, cancellation, and retention semantics are approved.
7. Keep RiskCube deferred until its separate canonical OLAP/pricer capability ADR is approved.

## 9. Exit criteria for this ADR's implementation milestone

The Phase 3A milestone may be considered implemented only when:

- model-registry ownership and schema are represented by a fina-builder repository contract;
- scheduler configuration and manual execution-attempt semantics are tested;
- no unattended scheduler is claimed or created without the required runtime decision;
- read-only book DTOs and transports are defined and tested;
- book-service writes and broker mutations remain unavailable;
- memory/SQLite repository tests pass, with PostgreSQL tests passing when a disposable service is available;
- browser HTTP and desktop stdio paths return equivalent normalized values;
- decimal strings, timestamps, nulls, and secret redaction pass integration tests;
- deletion tests prove that engine-owned and broker-owned data cannot be removed by fina metadata operations;
- no TradeAC records, broker orders, MLflow records, lake data, or RiskCube cells are migrated;
- authentication and renderer-supplied roles remain explicitly deferred;
- the migration plan and Phase 3 inventory link to this ADR and state its approval status.

## 10. Open items requiring review

The following items are intentionally not decided by this draft:

- the concrete durable runtime for future unattended scheduling;
- whether scheduler execution should be application-native, persistent-service-backed, or delegated for a specific deployment;
- final scheduler-attempt retention period and support/audit requirements;
- the exact book-service schema version and service ownership/upgrade process;
- the canonical OLAP/pricer engine and RiskCube runtime prerequisite;
- authentication, authorization, and renderer-supplied role/session design;
- any broker mutation policy beyond the existing explicit-confirmation requirement.

Approval should be recorded by changing the status at the top of this document from **Proposed — review required** to **Accepted**, and by updating `docs/75-tradeac-migration.md` and `docs/76-phase3-record-inventory.md` with the approval date and any amended decisions.
