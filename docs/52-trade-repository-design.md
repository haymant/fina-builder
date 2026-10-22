# 52 — Trade repository: design, lifecycle, storage and MCP contract

**Status:** IMPLEMENTED (v1) on branch `trade-repository`. Supersedes the *positions / booking*
parts of `docs/51-portfolio-risk-architecture.md` (§2.1 Positions context, §3.4, the
`position*` tables in §4.3.3, the `audit_event` table and the booking verbs in §6.1).
Everything downstream of a position snapshot (market data, valuation, sensitivities,
scenarios, P&L) stays as doc 51 describes; this document is the system of record that
feeds it.

**Code map.**

| Concern | Where |
| --- | --- |
| Domain core (validation, lifecycle state machine, bitemporal projection, positions, recon, import/export, entitlements) | `scripts/lib/trade-repo/core.mjs` |
| Storage port + adapters (SQLite default, PostgreSQL, memory) and portable migrations | `scripts/lib/trade-repo/store.mjs`, `scripts/lib/trade-repo/migrations/*.sql` |
| MCP tool catalog (JSON Schemas) | `scripts/lib/trade-repo/tools.mjs` (rendered in §9 below) |
| MCP server (Streamable-HTTP JSON-RPC, or `--stdio`) | `scripts/trade-repo-mcp-http.mjs` → `http://127.0.0.1:8792/mcp`, proxied by Vite at `/trade-repo/mcp` |
| Demo reference data + deterministic seed | `scripts/lib/trade-repo/reference.mjs`, `seed.mjs` |
| UI ("Trade Repository" workspace tab) | `src/features/trade-repository/**` — spec in `docs/53-trade-repository-ui-spec.md` |
| Unit tests | `scripts/lib/trade-repo/__tests__/core.test.mjs` (Vitest), `src/features/trade-repository/__tests__/*` |
| E2E | `playwright/` |

---

## 0. Why a separate trade repository

Doc 51 treats positions as "dated snapshots appended on every booking" and puts a generic
`fina_document_put` in front of them. That is the right shape for *computed* documents
(runs, sensitivity sets), but it is the wrong primary model for *trades*, which are a
business record with a regulated lifecycle. Industry trade repositories / trade-capture
systems (DTCC GTR, CME/REGIS-TR, internal booking systems à la Murex/Calypso, and the
ISDA CDM event model) converge on the same core ideas, which doc 51 either lacked or
left implicit:

1. **The unit of change is a lifecycle *event*, not a document revision.** NEW, AMEND,
   CANCEL, NOVATE, PARTIAL_TERMINATE, EXERCISE, MATURE, BOOK_TRANSFER each have
   preconditions, required data and downstream meaning (regulatory action type,
   risk impact, P&L "new trade" vs "amendment" attribution).
2. **Identity is regulatory, not just technical.** Every trade has a UTI (ISO 23897
   shape: reporting LEI + unique suffix, ≤ 52 chars), plus an internal `tradeId`, an
   `externalId` (venue/confirm id) and links to predecessor/successor trades for
   novations.
3. **Bitemporality is per trade event**, not per snapshot: *valid time* (when the change
   is economically effective) and *system/knowledge time* (when we recorded it) must be
   independently queryable to answer "what did we report on 5 March?" vs "what was true
   on 5 March as we know it today?".
4. **Writes are idempotent and concurrency-safe.** Booking channels retry; two users amend
   the same trade. Idempotency keys and optimistic concurrency (`expectedVersion`) are
   table stakes.
5. **Reconciliation and break management are first-class**, because the repository is only
   trusted if it agrees with confirmations and the regulator's copy.

---

## 1. Changes vs doc 51

| # | Doc 51 said | Problem | Doc 52 decision |
| --- | --- | --- | --- |
| C1 | Positions are dated snapshots; a new `fina.position-snapshot/v1` is appended per booking (§3.4) | Snapshots of *all* positions per booking are O(book) per write, lose *why* a position changed, and cannot express cancel vs amend vs novate | **Event-sourced trades.** The append-only `tr_trade_event` log is the source of truth. Positions and position snapshots are *projections* (`tr_position_query`, `tr_position_snapshot`). The doc-51 snapshot envelope is still produced, unchanged, as the booking→risk hand-off (C11). |
| C2 | `Position.status: 'open' \| 'closed' \| 'pending'` | Too coarse; no lifecycle semantics, no terminal states, no transitions | Trade status `LIVE \| CANCELLED \| TERMINATED \| EXERCISED \| MATURED \| NOVATED` with an explicit **state machine** (§3) enforced in the core and exposed by `tr_capabilities.transitions` and `tr_trade_get.allowedEvents`. |
| C3 | Edits create versions (I-2) with a content hash | Content hash cannot express *what kind* of change; no reason; no actor | Each event carries `eventType`, `amendKind` (ECONOMIC / NON_ECONOMIC), mandatory `reason` for amends/cancels, `actor`, `prevVersion`, field-level `changes[]`, and a monotonic per-trade `version`. A content hash of the economic fields (`contentHash`) is kept and becomes `instrumentVersion` in the risk feed. |
| C4 | `asOf` + `recordedAt` per *document* | Correct idea, wrong granularity | **Bitemporal per event**: `validFrom` (business effective date) + `recordedAt` (system time). Every read tool accepts `validAt` and `knownAt`. Resolution rule in §4. |
| C5 | Ids are `fina:<type>:<key>` URNs; trade id derived from a file name (G1) | No regulatory id; no external id; no link between novated trades | `tradeId` (`TR-000123`), **UTI** generated from the booking legal entity's LEI (`<LEI><FINA><10-digit>`; accepts a caller-supplied UTI), unique `externalId`, `novatedFrom`/`novatedTo` links. Lookups accept any of the three. |
| C6 | No idempotency | Retries double-book | `idempotencyKey` on every write tool; unique in storage; a replay returns the original result with `replayed: true`. Bulk import derives `import:<externalId>`. |
| C7 | No concurrency control | Lost updates | `expectedVersion` on amend/lifecycle → `CONFLICT` (retryable) when stale; break updates use `expectedUpdatedAt`. |
| C8 | `legalEntityId`, `counterpartyId` on the instrument; portfolio hierarchy `book/desk/fund/house` | Counterparty is a property of the **trade**, not the instrument; legal entity follows the **book** | Hierarchy **legal entity → desk → book**; the trade carries `bookId` + `counterpartyId`, `legalEntityId` is derived from the book (changes only via BOOK_TRANSFER). Parties have `kind` and `lei`. |
| C9 | Validation is per-template JSON Schema only | No business rules, no warnings, no cross-reference checks | Three layers: schema (tool `inputSchema`), business rules (dates order, product-specific required fields, reference integrity), and **warnings** (fat-finger notional, off-market rate) that do not block. `tr_trade_validate` exposes the same rules to the UI for live validation. |
| C10 | `audit_event` table for governance; no read API | Audit must be queryable and complete | Every write (trade events, imports, recon runs, break updates) writes an `tr_audit_event` row with actor, role, action, target and **correlationId** (also returned in every error). `tr_audit_query` with filters and cursor pagination. |
| C11 | Valuation runs reference a `positionSnapshotId` | OK, but nothing produced it | `tr_position_snapshot` emits exactly the doc-51 `fina.position-snapshot/v1` envelope (signed `quantity`, `instrumentVersion` = trade economic content hash, `links.trades = ["TR-…@v"]`) for a book, desk or legal entity at any bitemporal point. This is the **booking-to-risk linkage**. |
| C12 | Aggregation by portfolio only | Desks need ad-hoc aggregation | `tr_position_query` with arbitrary `groupBy` (book, product, underlying, currency, counterparty, legal entity), net/gross/long/short and drill-down trade ids. |
| C13 | No reconciliation | — | `tr_recon_run` matches an external report by UTI with tolerances → breaks `MISSING_IN_REPO`, `MISSING_IN_EXTERNAL`, `FIELD_MISMATCH`; break workflow `OPEN → INVESTIGATING → RESOLVED \| WAIVED` (comment required to close), assignment, comments, audit. |
| C14 | "No authentication service" | A repository without entitlements is not a repository | Role-based entitlements `viewer / trader / ops / admin`; traders are scoped to their books for writes and their desk for reads; ops/admin manage breaks. The MCP `context` is the seam for a real identity provider. |
| C15 | `fina_document_query { filter }` | Unspecified filter / paging | Uniform list contract: `filter` object with typed fields, `sort: [{field, dir}]`, `limit ≤ 500`, opaque `cursor` → `{items, total, nextCursor, asOf}`. |
| C16 | Errors `{code, message}` | No field paths, no retry hint, no trace id | `{code, message, details: [{code, path, message}], retryable, correlationId}` with a closed set of codes (§7). |
| C17 | — | No bulk path | `tr_bulk_import` (rows or CSV, ≤ 1000 rows, `dryRun`, `all-or-nothing` \| `best-effort`, per-row results) and `tr_export` (CSV / JSON of any query, bitemporal). |
| C18 | Store is Rust `BookStore` port, SQLite default, Postgres in prod (§4.3.6) | Kept | Same principle, implemented now as a Node storage port (`DATABASE_URL`: unset/`sqlite:` → SQLite file beside the engine data dir; `postgres://` → PostgreSQL). Schema is portable and migrations are shared (§6). The Rust `BookStore` remains the long-term target (§10). |
| C19 | Generic `fina_*` verbs for everything | Booking needs typed, lifecycle-specific verbs (agents and UIs must not hand-craft envelopes) | Trade capture uses the typed `tr_*` tools in §9; computed documents keep doc 51's generic verbs. |

Unchanged from doc 51: I-4 (explicit time, no implicit wall clock in the core — the clock
is injected), I-5 (money tagged with currency), I-6 (signed quantity in the risk feed; the
trade itself keeps `side` + positive `notional`, which is the market convention for trade
capture, and the projection derives the sign exactly once), I-10 (no synthetic data in the
UI: the blotter shows an explicit unavailable state when the server is down).

---

## 2. Domain model

```text
LegalEntity (party, LEI) ─┬─ Desk ── Book ──┐
                          │                 ├── Trade (tradeId, UTI, externalId)
Counterparty (party, LEI) ┴─────────────────┘        │ 1..n immutable
                                                      ▼
                                              TradeEvent v1..vn ── AuditEvent
                                                      │ projection
                       Positions (groupBy) ◀──────────┼──────────▶ fina.position-snapshot/v1 (doc 51)
                                                      │
              External report ──▶ ReconRun ──▶ ReconBreak (workflow)
```

**Trade (current state = latest event's `state`).** Economic fields: `productType`,
`side`, `notional`, `currency`, `underlying`, `price`, `fixedRate`, `strike`,
`optionType`, `quantity`, `tradeDate`, `effectiveDate`, `maturityDate`,
`counterpartyId`. Non-economic: `bookId`, `trader`, `venue`, `externalId`, `tags`,
`comment`. System: `tradeId`, `uti`, `version`, `status`, `legalEntityId`,
`lastEventType`, `lastEventId`, `validFrom`, `recordedAt`, `contentHash`,
`originalNotional`, `terminatedNotional`, `novatedTo`.

**TradeEvent (`fina.trade-event/v1`, immutable).** `eventId`, `tradeId`, `uti`,
`version`, `eventType`, `amendKind`, `validFrom`, `recordedAt`, `actor`,
`idempotencyKey`, `reason`, `prevVersion`, `related`, `changes[] {field, before,
after, economic}`, `state` (full post-event trade state — "snapshot-per-event" makes
as-of reads O(events of one trade) with no replay of field patches).

Products in v1: `IRS`, `FX_FORWARD`, `EQUITY_OPTION`, `CDS`, `PHOENIX_AUTOCALL` (the
latter maps to the riga `phoenix-worst-of@1` template of doc 51 §3.3).

## 3. Lifecycle state machine

| From \ event | AMEND | CANCEL | PARTIAL_TERMINATE | NOVATE | EXERCISE | MATURE | BOOK_TRANSFER |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **LIVE** | LIVE | CANCELLED | LIVE (notional ↓) | NOVATED + new LIVE trade | EXERCISED (options/autocalls only) | MATURED (effective ≥ maturity) | LIVE (book/LE changed) |
| CANCELLED, TERMINATED, EXERCISED, MATURED, NOVATED | — | — | — | — | — | — | — |

Rules: AMEND and CANCEL require a reason; amends to `bookId` are rejected
(`USE_LIFECYCLE`) — moving books is a BOOK_TRANSFER so risk and regulatory reporting
see the right event; PARTIAL_TERMINATE requires `0 < terminatedNotional < notional`
(full termination is a CANCEL/early termination by design); NOVATE requires a different
known counterparty and books a linked successor trade with a new UTI in the same
transaction; any effective date must be on/after `tradeDate`. Terminal states accept no
events (`INVALID_TRANSITION`). Economic vs non-economic amend classification is derived
from the changed fields, never from the caller.

## 4. Bitemporal semantics

For a trade and a query point `(validAt, knownAt)` the visible version is the event with
the greatest `(validFrom, version)` among events with `recordedAt ≤ knownAt` and
`validFrom ≤ validAt` (either bound omitted = unbounded). Hence:

* `knownAt` only → "what the repository said at that time" (regulatory replay);
* `validAt` only → "what is economically effective on that date, as we know it now"
  (back-dated corrections included);
* neither → current.

A trade booked after `knownAt` or effective after `validAt` is invisible (NOT_FOUND for a
single get). Lists and positions apply the same rule per trade. The UI enters
time-travel mode (read-only) whenever either bound is set.

## 5. Write path, idempotency and concurrency

```text
tools/call ─▶ entitlement check ─▶ idempotency lookup (replay → original result)
           ─▶ expectedVersion check (CONFLICT) ─▶ state-machine + validation
           ─▶ BEGIN; INSERT tr_trade_event; INSERT tr_audit_event; [successor trade]; COMMIT
           ─▶ reply (after the store flush)
```

The core keeps an in-memory projection rebuilt from the log at start-up (fast reads, no
ORM); every record is written through to the store inside one transaction per tool call
(SQLite) or an ordered write queue that is awaited before replying (PostgreSQL). The log
is append-only; break workflow rows are upserted but every change is also an audit event.

## 6. Storage

`DATABASE_URL` selects the adapter (`scripts/lib/trade-repo/store.mjs`):

| `DATABASE_URL` | Adapter | Notes |
| --- | --- | --- |
| unset | SQLite (`better-sqlite3`, WAL, FKs on) at `$TRADE_REPO_DATA_DIR/trade-repo.sqlite` (default `.trade-repo/` beside the engine) | Desktop default. In a packaged Tauri app point `TRADE_REPO_DATA_DIR` at the app-data dir. |
| `sqlite:/abs/path.sqlite` | SQLite at that path | |
| `postgres://…` / `postgresql://…` | PostgreSQL (`pg`, TLS for non-local hosts) | Verified against Supabase (see the test report). |
| `memory:` | In-memory | Unit tests. |

**Portable schema** (`migrations/0001_init.sql`, applied by both adapters and recorded in
`tr_schema_migration`): TEXT ids, ISO-8601 UTC timestamps as TEXT (lexicographically
ordered), JSON payloads as TEXT, BIGINT counters, `CHECK` enums, `ON CONFLICT … DO UPDATE`
upserts, no `AUTOINCREMENT`/`SERIAL`, no dialect-specific JSON operators. One deviation
is handled in code: SQLite strips `DEFERRABLE INITIALLY DEFERRED`.

| Table | Key | Purpose |
| --- | --- | --- |
| `tr_trade_event` | `event_id`; UQ `(trade_id, version)`, UQ `idempotency_key`, UQ `seq` | Immutable event log; typed columns for filtering + full `payload`. |
| `tr_audit_event` | `audit_id` | Append-only audit trail. |
| `tr_recon_run` | `run_id` | Reconciliation runs + summary. |
| `tr_recon_break` | `break_id`, FK `run_id` | Break workflow state (latest), history in audit. |
| `tr_schema_migration` | `version` | Applied migrations. |

Reference data (parties, desks, books, users) is static configuration in v1
(`reference.mjs`); see §10.

## 7. Error contract

Tool errors are MCP results with `isError: true` and `structuredContent`:

```json
{ "code": "VALIDATION_FAILED", "message": "2 validation error(s)",
  "details": [{ "code": "DATE_ORDER", "path": "maturityDate", "message": "maturityDate must be after tradeDate" }],
  "retryable": false, "correlationId": "cor-mgz1k2-8f3ab" }
```

| Code | Meaning | Retryable |
| --- | --- | --- |
| `VALIDATION_FAILED` | Schema/business rule violation; see `details[].path` | no |
| `NOT_FOUND` | Unknown trade/break or not visible at the as-of point | no |
| `CONFLICT` | Stale `expectedVersion` / `expectedUpdatedAt` | yes (re-read) |
| `INVALID_TRANSITION` | Event not allowed from the current status | no |
| `DUPLICATE` | `externalId` already booked | no |
| `NO_CHANGE` | Amendment changes nothing | no |
| `FORBIDDEN` | Entitlement check failed | no |
| `UNKNOWN_TOOL` / `INTERNAL` | Server-side | INTERNAL: yes |

Detail codes: `REQUIRED`, `ENUM`, `RANGE`, `FORMAT`, `DATE_ORDER`, `UNKNOWN_REF`,
`NOT_AMENDABLE`, `USE_LIFECYCLE`, `STALE_VERSION`, `DUPLICATE`; warnings `FAT_FINGER`,
`OFF_MARKET`.

## 8. Conventions

* **Context.** Every tool accepts `context: {actor, role, correlationId?}`. The server
  defaults to `TRADE_REPO_ACTOR` (admin) for local use; production must derive it from
  the authenticated session, not the caller.
* **Lists.** `filter` (typed, AND across fields, OR within arrays, `text` = contains on
  id/UTI/externalId/underlying/trader/counterparty/book), `sort[]`, `limit` (1–500),
  opaque base64 `cursor`; response `{items, total, nextCursor}`.
* **Dates** `YYYY-MM-DD` (business), timestamps ISO-8601 UTC (`…Z`).
* **Keys** camelCase on the wire (unlike riga-mcp, no snake conversion).

## 9. MCP tool catalog

Server `fina-trade-repo` 1.0.0, protocol `2025-11-25`; the catalog includes the following tools. The JSON Schemas below are generated from `scripts/lib/trade-repo/tools.mjs`.

| Tool | Purpose |
| --- | --- |
| `tr_capabilities` | Product types, lifecycle state machine, roles and limits supported by this repository. |
| `tr_reference_list` | Reference data: legal entities, counterparties, desks, books (hierarchy) and users/entitlements. |
| `tr_trade_validate` | Validate a trade without booking it. Returns errors and warnings (fat-finger, off-market). |
| `tr_trade_book` | Book a NEW trade. Idempotent on idempotencyKey; assigns tradeId and UTI; version 1. |
| `tr_trade_amend` | Amend a LIVE trade. Optimistic concurrency via expectedVersion; classifies the amend as ECONOMIC or NON_ECONOMIC; reason mandatory. |
| `tr_trade_lifecycle` | Apply a kernel or product-template lifecycle event. Phoenix `FIXING` captures observation number, levels, required source and timezone-qualified source timestamp, with optional evidence reference; derived coupon/knock-in/autocall/redemption events remain immutable. |
| `tr_fixing_due` | Read-only ops/admin queue of the next unresolved scheduled observation due on/before an explicit business date. Does not fetch or post market data. |
| `tr_fixings_bulk` | Preview or commit up to 500 distinct-trade Phoenix fixings with expected versions and per-row idempotency; `all-or-nothing` default or `best-effort`. |
| `tr_trade_get` | Get one trade, optionally bitemporally as of validAt (business date) and knownAt (system time). |
| `tr_trade_query` | Query trades with filters, multi-field sort and cursor pagination, optionally as of a point in (bi)time. |
| `tr_trade_history` | Immutable event history (all versions) of a trade with per-event field changes. |
| `tr_trade_diff` | Field-level diff between two versions of a trade (economic flag per field). |
| `tr_position_query` | Aggregate LIVE trades into positions (net/gross/long/short notional, trade count) by groupBy dimensions, as of a date. |
| `tr_position_snapshot` | Booking-to-risk linkage: emit a doc-51 fina.position-snapshot/v1 envelope for a book/desk/legal entity. |
| `tr_audit_query` | Append-only audit trail (who did what, when, with correlation id). |
| `tr_recon_run` | Reconcile an external report (e.g. regulator TR / counterparty) by UTI; creates breaks MISSING_IN_REPO, MISSING_IN_EXTERNAL, FIELD_MISMATCH. |
| `tr_recon_runs` | List reconciliation runs with summaries. |
| `tr_recon_breaks_query` | Query reconciliation breaks. |
| `tr_recon_break_update` | Break workflow: assign, comment, move OPEN -> INVESTIGATING -> RESOLVED\|WAIVED (comment required to close). |
| `tr_bulk_import` | Bulk import trades (rows as objects; use csv for CSV text). dryRun validates only; mode all-or-nothing \| best-effort. Idempotent per externalId. |
| `tr_export` | Export trades matching a query as CSV or JSON. |

### `tr_capabilities`

Product types, lifecycle state machine, roles and limits supported by this repository.

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  "required": [],
  "additionalProperties": false
}
```

### `tr_reference_list`

Reference data: legal entities, counterparties, desks, books (hierarchy) and users/entitlements.

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  "required": [],
  "additionalProperties": false
}
```

### `tr_trade_validate`

Validate a trade without booking it. Returns errors and warnings (fat-finger, off-market).

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "trade": {
      "type": "object",
      "required": [
        "productType",
        "side",
        "notional",
        "currency",
        "tradeDate",
        "maturityDate",
        "counterpartyId",
        "bookId"
      ],
      "properties": {
        "productType": {
          "enum": [
            "IRS",
            "FX_FORWARD",
            "EQUITY_OPTION",
            "CDS",
            "PHOENIX_AUTOCALL"
          ]
        },
        "side": {
          "enum": [
            "BUY",
            "SELL"
          ]
        },
        "notional": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "currency": {
          "type": "string",
          "pattern": "^[A-Z]{3}$"
        },
        "underlying": {
          "type": "string"
        },
        "price": {
          "type": "number"
        },
        "fixedRate": {
          "type": "number"
        },
        "strike": {
          "type": "number"
        },
        "optionType": {
          "enum": [
            "CALL",
            "PUT"
          ]
        },
        "quantity": {
          "type": "number"
        },
        "tradeDate": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "effectiveDate": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "maturityDate": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "counterpartyId": {
          "type": "string"
        },
        "bookId": {
          "type": "string"
        },
        "trader": {
          "type": "string"
        },
        "venue": {
          "type": "string"
        },
        "externalId": {
          "type": "string"
        },
        "uti": {
          "type": "string",
          "maxLength": 52
        },
        "tags": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          }
        },
        "comment": {
          "type": "string"
        }
      }
    }
  },
  "required": [
    "trade"
  ],
  "additionalProperties": false
}
```

### `tr_trade_book`

Book a NEW trade. Idempotent on idempotencyKey; assigns tradeId and UTI; version 1.

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "trade": {
      "type": "object",
      "required": [
        "productType",
        "side",
        "notional",
        "currency",
        "tradeDate",
        "maturityDate",
        "counterpartyId",
        "bookId"
      ],
      "properties": {
        "productType": {
          "enum": [
            "IRS",
            "FX_FORWARD",
            "EQUITY_OPTION",
            "CDS",
            "PHOENIX_AUTOCALL"
          ]
        },
        "side": {
          "enum": [
            "BUY",
            "SELL"
          ]
        },
        "notional": {
          "type": "number",
          "exclusiveMinimum": 0
        },
        "currency": {
          "type": "string",
          "pattern": "^[A-Z]{3}$"
        },
        "underlying": {
          "type": "string"
        },
        "price": {
          "type": "number"
        },
        "fixedRate": {
          "type": "number"
        },
        "strike": {
          "type": "number"
        },
        "optionType": {
          "enum": [
            "CALL",
            "PUT"
          ]
        },
        "quantity": {
          "type": "number"
        },
        "tradeDate": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "effectiveDate": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "maturityDate": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "counterpartyId": {
          "type": "string"
        },
        "bookId": {
          "type": "string"
        },
        "trader": {
          "type": "string"
        },
        "venue": {
          "type": "string"
        },
        "externalId": {
          "type": "string"
        },
        "uti": {
          "type": "string",
          "maxLength": 52
        },
        "tags": {
          "type": "object",
          "additionalProperties": {
            "type": "string"
          }
        },
        "comment": {
          "type": "string"
        }
      }
    },
    "idempotencyKey": {
      "type": "string",
      "maxLength": 128,
      "description": "Client-generated key; a replay returns the original result instead of a duplicate booking"
    },
    "dryRun": {
      "type": "boolean"
    }
  },
  "required": [
    "trade"
  ],
  "additionalProperties": false
}
```

### `tr_trade_amend`

Amend a LIVE trade. Optimistic concurrency via expectedVersion; classifies the amend as ECONOMIC or NON_ECONOMIC; reason mandatory.

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "tradeId": {
      "type": "string",
      "description": "tradeId, UTI or externalId"
    },
    "expectedVersion": {
      "type": "integer",
      "minimum": 1
    },
    "changes": {
      "type": "object"
    },
    "reason": {
      "type": "string",
      "minLength": 1
    },
    "validFrom": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
    },
    "idempotencyKey": {
      "type": "string",
      "maxLength": 128,
      "description": "Client-generated key; a replay returns the original result instead of a duplicate booking"
    }
  },
  "required": [
    "tradeId",
    "changes",
    "reason"
  ],
  "additionalProperties": false
}
```

### `tr_trade_lifecycle`

Apply a kernel or product-template lifecycle event. For Phoenix `FIXING`, params include `{n, levels, source, sourceObservedAt, evidenceRef?}`; source and ISO-8601 timestamp with timezone are required. The same lifecycle engine records the fixing and any derived coupon/knock-in/autocall/redemption events. Identical idempotent retries return the original event group; a reused key with a different payload is rejected.

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "tradeId": {
      "type": "string",
      "description": "tradeId, UTI or externalId"
    },
    "eventType": {
      "type": "string",
      "description": "Kernel event or lifecycle event declared by the trade's product template (e.g. Phoenix FIXING)"
    },
    "expectedVersion": {
      "type": "integer"
    },
    "effectiveDate": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
    },
    "reason": {
      "type": "string"
    },
    "idempotencyKey": {
      "type": "string",
      "maxLength": 128,
      "description": "Client-generated key; a replay returns the original result instead of a duplicate booking"
    },
    "params": {
      "type": "object"
    }
  },
  "required": [
    "tradeId",
    "eventType"
  ],
  "additionalProperties": false
}
```

### `tr_fixing_due`

Requires `asOfDate` (`YYYY-MM-DD`); optional `limit` is 1–500 and optional `bookIds` restricts the queue. Returns ops/admin-visible LIVE trades with the next pending product observation at/before `asOfDate`, expected version, observation/payment dates and required underlying symbols. It is a query, not an automation or market-data feed.

### `tr_fixings_bulk`

`rows` contains 1–500 rows with distinct `tradeId`s and required `expectedVersion`, `n`, `levels`, `source`, `sourceObservedAt` and row `idempotencyKey`; `evidenceRef` and `reason` are optional. `dryRun` defaults to true. `mode` is `all-or-nothing` (default) or `best-effort`. Preview returns per-row errors and derived event types. Any invalid row prevents every write in all-or-nothing commit mode; best-effort commits only valid rows. Only one pending observation per trade may appear in a batch.

### `tr_trade_get`

Get one trade, optionally bitemporally as of validAt (business date) and knownAt (system time).

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "tradeId": {
      "type": "string",
      "description": "tradeId, UTI or externalId"
    },
    "validAt": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "description": "Business (valid) date"
    },
    "knownAt": {
      "type": "string",
      "description": "ISO-8601 UTC timestamp (system/knowledge time)"
    }
  },
  "required": [
    "tradeId"
  ],
  "additionalProperties": false
}
```

### `tr_trade_query`

Query trades with filters, multi-field sort and cursor pagination, optionally as of a point in (bi)time.

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "filter": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string"
        },
        "bookIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "counterpartyIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "legalEntityIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "productTypes": {
          "type": "array",
          "items": {
            "enum": [
              "IRS",
              "FX_FORWARD",
              "EQUITY_OPTION",
              "CDS",
              "PHOENIX_AUTOCALL"
            ]
          }
        },
        "statuses": {
          "type": "array",
          "items": {
            "enum": [
              "LIVE",
              "CANCELLED",
              "TERMINATED",
              "EXERCISED",
              "MATURED",
              "NOVATED"
            ]
          }
        },
        "currencies": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "tradeDateFrom": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "tradeDateTo": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "maturityFrom": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "maturityTo": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        }
      }
    },
    "sort": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "field": {
            "type": "string"
          },
          "dir": {
            "enum": [
              "asc",
              "desc"
            ]
          }
        }
      }
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 500
    },
    "cursor": {
      "type": "string"
    },
    "validAt": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "description": "Business (valid) date"
    },
    "knownAt": {
      "type": "string",
      "description": "ISO-8601 UTC timestamp (system/knowledge time)"
    }
  },
  "required": [],
  "additionalProperties": false
}
```

### `tr_trade_history`

Immutable event history (all versions) of a trade with per-event field changes.

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "tradeId": {
      "type": "string",
      "description": "tradeId, UTI or externalId"
    },
    "knownAt": {
      "type": "string",
      "description": "ISO-8601 UTC timestamp (system/knowledge time)"
    }
  },
  "required": [
    "tradeId"
  ],
  "additionalProperties": false
}
```

### `tr_trade_diff`

Field-level diff between two versions of a trade (economic flag per field).

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "tradeId": {
      "type": "string",
      "description": "tradeId, UTI or externalId"
    },
    "fromVersion": {
      "type": "integer"
    },
    "toVersion": {
      "type": "integer"
    }
  },
  "required": [
    "tradeId",
    "fromVersion",
    "toVersion"
  ],
  "additionalProperties": false
}
```

### `tr_position_query`

Aggregate LIVE trades into positions (net/gross/long/short notional, trade count) by groupBy dimensions, as of a date.

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "groupBy": {
      "type": "array",
      "items": {
        "enum": [
          "bookId",
          "productType",
          "underlying",
          "currency",
          "counterpartyId",
          "legalEntityId"
        ]
      }
    },
    "filter": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string"
        },
        "bookIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "counterpartyIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "legalEntityIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "productTypes": {
          "type": "array",
          "items": {
            "enum": [
              "IRS",
              "FX_FORWARD",
              "EQUITY_OPTION",
              "CDS",
              "PHOENIX_AUTOCALL"
            ]
          }
        },
        "statuses": {
          "type": "array",
          "items": {
            "enum": [
              "LIVE",
              "CANCELLED",
              "TERMINATED",
              "EXERCISED",
              "MATURED",
              "NOVATED"
            ]
          }
        },
        "currencies": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "tradeDateFrom": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "tradeDateTo": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "maturityFrom": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "maturityTo": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        }
      }
    },
    "validAt": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "description": "Business (valid) date"
    },
    "knownAt": {
      "type": "string",
      "description": "ISO-8601 UTC timestamp (system/knowledge time)"
    }
  },
  "required": [],
  "additionalProperties": false
}
```

### `tr_position_snapshot`

Booking-to-risk linkage: emit a doc-51 fina.position-snapshot/v1 envelope for a book/desk/legal entity.

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "portfolioId": {
      "type": "string"
    },
    "validAt": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "description": "Business (valid) date"
    },
    "knownAt": {
      "type": "string",
      "description": "ISO-8601 UTC timestamp (system/knowledge time)"
    }
  },
  "required": [],
  "additionalProperties": false
}
```

### `tr_audit_query`

Append-only audit trail (who did what, when, with correlation id).

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "filter": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "action": {
          "type": "string"
        },
        "targetId": {
          "type": "string"
        },
        "from": {
          "type": "string",
          "description": "ISO-8601 UTC timestamp (system/knowledge time)"
        },
        "to": {
          "type": "string",
          "description": "ISO-8601 UTC timestamp (system/knowledge time)"
        }
      }
    },
    "limit": {
      "type": "integer",
      "maximum": 500
    },
    "cursor": {
      "type": "string"
    }
  },
  "required": [],
  "additionalProperties": false
}
```

### `tr_recon_run`

Reconcile an external report (e.g. regulator TR / counterparty) by UTI; creates breaks MISSING_IN_REPO, MISSING_IN_EXTERNAL, FIELD_MISMATCH.

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "source": {
      "type": "string"
    },
    "asOfDate": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
    },
    "records": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "uti"
        ]
      }
    },
    "tolerance": {
      "type": "object",
      "properties": {
        "notional": {
          "type": "number"
        }
      }
    }
  },
  "required": [
    "source",
    "records"
  ],
  "additionalProperties": false
}
```

### `tr_recon_runs`

List reconciliation runs with summaries.

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    }
  },
  "required": [],
  "additionalProperties": false
}
```

### `tr_recon_breaks_query`

Query reconciliation breaks.

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "filter": {
      "type": "object",
      "properties": {
        "runId": {
          "type": "string"
        },
        "statuses": {
          "type": "array",
          "items": {
            "enum": [
              "OPEN",
              "INVESTIGATING",
              "RESOLVED",
              "WAIVED"
            ]
          }
        },
        "types": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "limit": {
      "type": "integer"
    }
  },
  "required": [],
  "additionalProperties": false
}
```

### `tr_recon_break_update`

Break workflow: assign, comment, move OPEN -> INVESTIGATING -> RESOLVED|WAIVED (comment required to close).

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "breakId": {
      "type": "string"
    },
    "status": {
      "enum": [
        "OPEN",
        "INVESTIGATING",
        "RESOLVED",
        "WAIVED"
      ]
    },
    "assignee": {
      "type": [
        "string",
        "null"
      ]
    },
    "comment": {
      "type": "string"
    },
    "expectedUpdatedAt": {
      "type": "string",
      "description": "ISO-8601 UTC timestamp (system/knowledge time)"
    }
  },
  "required": [
    "breakId"
  ],
  "additionalProperties": false
}
```

### `tr_bulk_import`

Bulk import trades (rows as objects; use csv for CSV text). dryRun validates only; mode all-or-nothing | best-effort. Idempotent per externalId.

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "rows": {
      "type": "array",
      "items": {
        "type": "object"
      },
      "maxItems": 1000
    },
    "csv": {
      "type": "string"
    },
    "dryRun": {
      "type": "boolean"
    },
    "mode": {
      "enum": [
        "all-or-nothing",
        "best-effort"
      ]
    }
  },
  "required": [],
  "additionalProperties": false
}
```

### `tr_export`

Export trades matching a query as CSV or JSON.

```json
{
  "type": "object",
  "properties": {
    "context": {
      "type": "object",
      "properties": {
        "actor": {
          "type": "string"
        },
        "role": {
          "enum": [
            "viewer",
            "trader",
            "ops",
            "admin"
          ]
        },
        "correlationId": {
          "type": "string"
        }
      },
      "additionalProperties": false
    },
    "format": {
      "enum": [
        "csv",
        "json"
      ]
    },
    "filter": {
      "type": "object",
      "properties": {
        "text": {
          "type": "string"
        },
        "bookIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "counterpartyIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "legalEntityIds": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "productTypes": {
          "type": "array",
          "items": {
            "enum": [
              "IRS",
              "FX_FORWARD",
              "EQUITY_OPTION",
              "CDS",
              "PHOENIX_AUTOCALL"
            ]
          }
        },
        "statuses": {
          "type": "array",
          "items": {
            "enum": [
              "LIVE",
              "CANCELLED",
              "TERMINATED",
              "EXERCISED",
              "MATURED",
              "NOVATED"
            ]
          }
        },
        "currencies": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "tradeDateFrom": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "tradeDateTo": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "maturityFrom": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        },
        "maturityTo": {
          "type": "string",
          "pattern": "^\\d{4}-\\d{2}-\\d{2}$"
        }
      }
    },
    "validAt": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "description": "Business (valid) date"
    },
    "knownAt": {
      "type": "string",
      "description": "ISO-8601 UTC timestamp (system/knowledge time)"
    }
  },
  "required": [],
  "additionalProperties": false
}
```


**Outputs** (all tools return `structuredContent`; the text block carries the same JSON):

| Tool | Result |
| --- | --- |
| `tr_trade_book` | `{tradeId, version, eventId, warnings[], trade}` (or `{tradeId, version, eventId, replayed: true, trade}`; `dryRun` → `{dryRun, validation}`) |
| `tr_trade_amend` | `{tradeId, version, eventId, amendKind, changes[], warnings[], trade}` |
| `tr_trade_lifecycle` | `{tradeId, version, eventId, events: [{eventId, eventType, version, detail}], trade, replayed?, novatedTo?}` |
| `tr_fixing_due` | `{asOfDate, total, items: [{tradeId, version, bookId, n, observationCount, observationDate, paymentDate, levelsRequired}], truncated, reviewRequired}` |
| `tr_fixings_bulk` | `{dryRun, mode, total, valid, failed, committed, noWrites, results: [{row, tradeId, n, status, errors, events, eventIds?}]}` |
| `tr_trade_get` | `{trade, isLatest, latestVersion, allowedEvents[]}` |
| `tr_trade_query` | `{items: Trade[], total, nextCursor, asOf}` |
| `tr_trade_history` | `{tradeId, uti, events: TradeEvent[]}` |
| `tr_trade_diff` | `{tradeId, fromVersion, toVersion, changes[]}` |
| `tr_position_query` | `{groupBy, rows: [{key, netNotional, grossNotional, longNotional, shortNotional, tradeCount, tradeIds}], tradeCount, asOf}` |
| `tr_position_snapshot` | doc-51 envelope `{schema: 'fina.position-snapshot/v1', id, version, asOf, recordedAt, producer, links, payload}` |
| `tr_audit_query` | `{items: AuditEvent[], total, nextCursor}` |
| `tr_recon_run` | `ReconRun {runId, source, asOfDate, ranAt, actor, summary{external, internal, matched, breaks, byType}}` |
| `tr_recon_breaks_query` / `tr_recon_break_update` | `{items: Break[], total}` / `Break` |
| `tr_bulk_import` | `{dryRun, committed, failed, results: [{row, externalId, status, errors, warnings, tradeId?}]}` |
| `tr_export` | `{format, count, content}` |

## 10. Known gaps and next steps

* **Fixing corrections / restatements and maker-checker.** Fixing events are immutable and duplicate observations are rejected, but there is no correction request/approval flow, safe replay of dependent events or independent approval. Source name/time are captured, but no authorized market-data feed or retrievable evidence payload is integrated; see [doc 54](./54-trade-fixing-workflows.md).
* **Tauri packaging.** The server is a Node process. The desktop webview reaches it at
  `http://127.0.0.1:8792` (CORS enabled, `VITE_TRADE_REPO_MCP_URL` override), and SQLite
  lives beside it, but `src-tauri` does not yet spawn it as a sidecar (the riga/tac
  engines are spawned by `src-tauri/src/mcp.rs`). Next: bundle it as a sidecar (or port
  the core to a Rust crate behind doc 51's `BookStore` port and serve it from
  `riga_agent::install`), and register it with the chat's MCP registry so the assistant
  can book/query trades.
* **Reference data** is static; next is a `tr_reference_*` write API with versioned
  parties/books (doc 51 `portfolio_version`).
* **Projection scale.** The in-memory projection is fine for ~10⁵ events; beyond that,
  read from the typed `tr_trade_event` columns with a `tr_trade_current` materialized
  table.
* **Regulatory reporting** (EMIR/CFTC message generation, action types NEWT/MODI/TERM/
  CORR/EROR) maps 1:1 onto the event types but is not generated.
* **Authentication.** `context` is trusted from the caller in v1 (local, single-user).
* **Partial termination fees / cash flows** are recorded but not settled.
