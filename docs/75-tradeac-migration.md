# TradeAC → fina-builder: Main Feature Migration Plan

**Status:** In progress — architecture-aligned revision
**Target:** `haymant/fina-builder`
**Reference:** `haymant/tradeac` (read-only; do not modify)
**Migration style:** selective feature migration into fina-builder’s existing React/Vite + Tauri application. Do not merge repository roots and do not embed TradeAC’s Next.js runtime.

**Execution status (2026-11-20):** Phases 1 and 2 are complete, and the first Phase 4/5 Trading 2ⁿᵈ
read-only vertical slice is integrated. Account, positions, orders, news, and watchlist
now have typed APIs, normalized DTOs, explicit loading/empty/error/unavailable states,
persisted navigation, menu-bar/command-palette access, and lazy workspace rendering. The
TradeAC-derived `tac-qlib`
package now lives under `modules/tac-qlib/` with a committed `uv.lock`, ignored module-local
`.venv`, explicit `rd`/`book` stdio launchers, and lake-dependent tests that skip clearly when
`TAC_LAKE_DIR` is not configured. Focused Trading 2ⁿᵈ API tests pass (including news and
watchlist normalization), the full Vitest suite passes, and the production build succeeds.
A live bridge probe against a temporary empty lake returned an empty watchlist successfully;
the news tool correctly reported unavailable because no Alpaca credentials were configured.
The selected TAC pin builds and passes its Rust suite (60 passed, 0 failed), and the live
RIGA/TAC smoke workflow passed. Phase 2 validation also passed locked `uv` synchronization,
the `tac_qlib` import, module-local RD/book launcher setup, and the persistent
`npm run test:tac-qlib:lake` harness: both lake-provider and contrib smoke scripts pass
against a temporary deterministic parquet lake, which is removed after each run. No
credentials were needed or exposed. Phase 3A persistence/data ownership is implemented
for fina-owned metadata and the read-only book boundary; unattended scheduling, broker
mutations, R&D artifact ownership, and RiskCube remain staged work and are not claimed
complete. The accepted gate decisions are recorded in
[`docs/77-phase3-gate-decisions-adr.md`](77-phase3-gate-decisions-adr.md). Remaining
Phase 3 work is canonical OLAP/pricer selection, service-specific retention review,
and later R&D/Trading 2ⁿd workflow integration. The initial Phase 3 ownership and
lifecycle matrix is recorded in
[`docs/76-phase3-record-inventory.md`](76-phase3-record-inventory.md); it is a review
artifact only and does not add persistence or migrate records.

This document is the implementation plan and the source-of-truth boundary for migrating the main TradeAC feature groups. It was rewritten after inspecting both repositories at the frozen snapshots recorded below. Any implementation that contradicts the target architecture or the non-goals in this document requires an explicit decision update before coding.

---

## 1. Verified source snapshots

| Repository | Commit | Relevant submodule pins |
|---|---|---|
| `fina-builder` | `ebf4ecbc475d27b5816bdb7f1684bec0e36878ce` | `modules/tac-engine` = `89fb0c89e19e72c05131f8b1022016a9098e254f` |
| `tradeac` | `478849f923cf68b53e180250ad444a11a2255b57` | `tac-engine` = `c876902c8ea74500437903702cf27431077e694b`; `qlib` = `d5379c520f66a39953bad76234a7019a72796fd0`; `FinA` = `786243b5cda503c82c61906667a6ce3f14470827` |

The snapshots were cloned recursively. Reconfirm these SHAs at implementation start and record any intentional source revision change in this document.

### Evidence summary

TradeAC is a Next.js 16 App Router application in `tac-app/`. Its server actions use authentication guards, Drizzle/PostgreSQL, and MCP clients. Its Python package is `tac-qlib/`, with `rd_server.py` and `book_server.py`; the launch path currently resolves a workspace-level Python environment through `getVenvPython()` and sets `PYTHONPATH` to the package.

The TradeAC sidebar has four relevant feature groups:

- **Trading 2ⁿᵈ**: `/dashboard/alpaca`, `/dashboard/positions`, `/dashboard/orders`, `/dashboard/scheduler`, `/dashboard/rounds`, `/dashboard/news`, `/dashboard/watchlist`, `/dashboard/macro`, and `/dashboard/calendar`.
- **R&D**: `/rd`, `/rd/input`, `/rd/result`, `/rd/model`, `/rd/models`, `/rd/blotter`, `/rd/graph`, and `/rd/lineage`.
- **RiskCube**: `/riskcube/scenarios`, `/riskcube/versions`, `/riskcube/slice`, and `/riskcube/cubes`.
- The separate **Trading** group contains RFQs, quotes, trades, instruments, and positions. It is not Trading 2ⁿᵈ and is excluded unless separately approved.

RiskCube’s cube designer builds constrained SQL over `riskcube_cells`, then calls TradeAC’s `finaOlapQuery` server action. Its dimensions and measures are defined in `riskcube/cubes/_components/cube-sql.ts`; the implementation depends on the `fina-pricer`/OLAP capability, not merely on the market-data `tac-engine`.

fina-builder is currently a React 19 + TypeScript + Vite frontend at `src/`, a thin Tauri v2 shell at `src-tauri/`, Rust-owned stdio MCP engines for desktop, HTTP MCP bridges for browser development, and a Node MCP trade repository with SQLite/PostgreSQL adapters under `scripts/lib/trade-repo/`. Its app-level navigation is a persisted `Location` union in `src/features/workspace/navigation.ts`, rendered by `Workspace.tsx`; it is not file-system routing.

---

## 2. Goals and scope

### 2.1 In scope

Migrate the main workflows of the following TradeAC groups, in this order:

1. **Trading 2ⁿᵈ** — read-only market/account/position/order views first, then scheduler and rounds workflows, with explicit confirmation for broker mutations.
2. **R&D** — experiment/run inspection, input/model/result views, model registry, blotter, Git graph, and lineage, backed by `tac-qlib` MCP services and portable persistence where required.
3. **RiskCube** — scenario/version/slice/cube workflows, preserving the existing OLAP query semantics and making the engine capability explicit rather than fabricating risk data.

Use fina-builder’s existing:

- React/Vite/TypeScript build and `src/` layout;
- Tailwind v4 theme tokens, shared primitives, lazy feature views, error boundaries, and Zustand conventions;
- `Location`-based workspace navigation and command/menu-bar access;
- generic MCP transport shape and snake_case/camelCase boundary normalization;
- Rust-owned Tauri process lifecycle for desktop;
- Node HTTP bridges for browser development;
- `modules/` submodule conventions and sidecar scripts;
- Vitest, Playwright, Rust, smoke, lint, and release workflows.

### 2.2 Explicitly out of scope

- TradeAC’s separate legacy **Trading** group: RFQs, quotes, trades, instruments, and its positions page.
- TradeAC’s OpenCode/Agent UI, OpenCode server, authentication, and user-management migration. RIGA remains fina-builder’s assistant.
- Copying the Next.js app, App Router, server actions, `next/navigation`, server components, metadata, or a second web application.
- Migrating existing TradeAC database records, MLflow records, broker orders, or production lake data.
- Adding live broker credentials, live order placement, remote embedding requirements, or public-service dependencies to CI.
- Treating TradeAC’s demo data, synthetic market data, or illustrative risk values as production valuations.
- Creating a second `tac-engine` checkout or silently replacing fina-builder’s existing TAC pin.

### 2.3 Required outcomes

- One canonical TAC engine source and one pinned `modules/tac-engine` gitlink.
- No renderer code opens a database, launches a child process, chooses an executable, or receives secrets.
- Every migrated backend operation has a typed feature API and deterministic unavailable/error behavior.
- Every Python module used at runtime has its own `pyproject.toml`, committed `uv.lock`, ignored `.venv`, explicit interpreter resolution, and a clean-checkout smoke test.
- Existing fina-builder pricing, market-data, trade repository, Narrative, Video, RIGA assistant, tests, and release commands continue to work.
- TradeAC remains unchanged and usable as a frozen source reference.

---

## 3. Target architecture

```text
React/Vite renderer (src/)
  ├─ Workspace + persisted Location navigation
  ├─ features/trading2, features/rd, features/riskcube
  ├─ typed feature APIs and transport adapters
  └─ Zustand UI state / localStorage for view preferences only
          │
          ├─ browser: same-origin HTTP MCP paths through Vite
          └─ desktop: Tauri invoke → Rust-owned MCP stdio clients
                          │
                 feature MCP services / repositories
                   ├─ existing riga-mcp and tac-engine
                   ├─ existing Node trade-repository MCP
                   ├─ tac-qlib RD/book MCP processes
                   └─ OLAP/risk-cube engine capability
```

### 3.1 Frontend boundary

Keep the application at `src/`. Add feature folders such as:

```text
src/features/trading2/
src/features/rd/
src/features/riskcube/
src/api/trading2Api.ts
src/api/rdApi.ts
src/api/riskcubeApi.ts
```

These names are organizational only; they do not create routes. Add `Location` variants and view renderers to `Workspace.tsx`, update the command palette/menu bar, validate persisted locations on load, and lazy-load each feature so a failed optional backend does not take down the existing dashboards.

Feature APIs must call a named transport/service. They must not import Node modules, `pg`, `better-sqlite3`, Python launch code, or arbitrary Tauri commands. Keep pure SQL/pivot generation in a tested feature module only when the query is a constrained, non-user-arbitrary query; backend-side validation must still enforce allowed dimensions, measures, aggregations, filters, row limits, and timeouts.

### 3.2 Runtime boundary

The desktop shell owns child-process lifecycle, stdio MCP clients, environment construction, cleanup, cancellation, and error mapping. Browser mode uses explicit Node HTTP bridges and Vite proxy paths, as fina-builder already does for RIGA, TAC, and the trade repository.

Use the existing MCP result contract: structured content is unwrapped at the transport boundary, tool errors become typed feature errors, and camelCase/snake_case conversion occurs in the transport rather than in every component.

Do not introduce a Rust SQLx database layer merely because TradeAC used Next server actions. fina-builder’s implemented persistence precedent is the Node storage port in `scripts/lib/trade-repo/store.mjs`, with SQLite default, PostgreSQL support, migrations, and an in-memory test adapter. Reuse or extend that pattern for new persisted records unless an engine already owns the data. If a future Rust-owned database is chosen, it requires a separate ADR and must not be mixed with the Node adapter for the same tables.

### 3.3 Engine ownership

- **Market/account/order data:** use the canonical fina-builder `modules/tac-engine` MCP surface. Reconcile the two TAC pins before importing any tool contract.
- **R&D:** use `tac_qlib.rd_server` and `tac_qlib.book_server` as explicit MCP services. Do not duplicate qlib calculations in React or in a thin transport.
- **RiskCube:** first establish the authoritative OLAP engine contract. TradeAC’s implementation calls `fina-pricer`’s `olap_query` and `risk_cube_partitions`; the current fina-builder `tac-engine` is not automatically a replacement. Choose one canonical implementation after a capability comparison: a supported `fina-pricer` submodule/capability, an explicitly ported engine service, or a reduced feature slice with a documented unsupported state. Do not implement a fake in-memory cube to make the UI appear complete.
- **RIGA:** remains the assistant and agent surface. Do not migrate OpenCode.

### 3.4 Secrets and side effects

Credentials remain in host/app-data `.env` or the configured runtime environment. Never persist `DATABASE_URL`, broker keys, embedding keys, Git credentials, or raw connection URLs in renderer state or logs. Broker mutations require a server-side validation boundary plus an explicit confirmation UI; CI must use fixtures and mocked tools only.

---

## 4. Implementation phases

Each phase is independently reviewable. Do not add a navigation entry until its primary workflow and unavailable/error states are tested.

### Phase 0 — Freeze references and baseline fina-builder

1. Record the source SHAs in §1 and verify both reference trees are clean.
2. Inventory exact TradeAC pages, components, server actions, MCP tools, schemas, environment variables, and data files for each in-scope group.
3. Classify each dependency as: reuse existing fina-builder capability; add a new MCP service; port a pure frontend projection; or defer as unsupported.
4. Run the current fina-builder baseline:

```bash
git submodule update --init --recursive
npm ci
npm run lint
npm run test:run
npm run build
cargo fmt --all -- --check
cargo test --workspace
```

5. Run the browser stack after the pinned Rust toolchain and engine prerequisites are installed:

```bash
npm run dev:http -- --public
npm run smoke -- --web
```

**Exit criteria:** a dependency matrix exists; excluded Trading/OpenCode/auth features are marked; baseline failures are recorded separately from migration failures; TradeAC remains untouched.

### Phase 1 — Reconcile TAC engine capability and pin

1. Fetch the TradeAC-pinned TAC object into the existing `modules/tac-engine` repository.
2. Compare `89fb0c8…` and `c876902…`: common ancestor, full diff, tool list, schemas, tests, and build requirements.
3. Select one canonical commit. If unique functionality must be combined, merge it in the upstream TAC repository first; do not copy files between submodules.
4. Verify the required Trading 2ⁿᵈ tools exist: account, positions, orders, news, quotes/history, streams, scheduler inputs, and any round execution dependencies.
5. Update fina-builder’s sidecar/build docs only if the selected canonical revision requires it.

**Canonical decision (2026-11-20):** retain fina-builder’s
`89fb0c89e19e72c05131f8b1022016a9098e254f` as the canonical TAC revision. TradeAC’s pin,
`c876902c8ea74500437903702cf27431077e694b`, is its direct ancestor; fina-builder adds the
`e2ff3d1` SVI volatility-surface/lake-market-data changes and the `89fb0c8` Yahoo fallback
without Alpaca credentials. The selected revision preserves the TradeAC account, positions,
orders, news, and lake-watchlist tool surface while providing the credential-free local
development behavior required by fina-builder. No files were copied between TAC checkouts,
and `modules/tac-engine` remains the sole TAC gitlink.

**Phase 1 validation (2026-11-20):** the selected revision compiled successfully;
`cargo test --manifest-path modules/tac-engine/Cargo.toml` passed with 60 tests passed and
0 failed; and `npm run smoke` passed the live RIGA/TAC MCP round-trip (`SMOKE OK`).

**Exit criteria:** one TAC gitlink; selected SHA and rationale recorded; engine tests/build pass; existing `npm run smoke` remains green; no duplicate engine directory or binary.

### Phase 2 — Establish deterministic Python module ownership

1. Copy only the required `tac-qlib` package and support files into an approved fina-builder module location, preferably `modules/tac-qlib/`.
2. Create a module-local `pyproject.toml`, committed `uv.lock`, ignored `.venv`, and tests. Pin the supported Python version and qlib revision.
3. Replace workspace-root discovery, ambient `python`, root `.venv`, and implicit `PYTHONPATH` with an explicit resolver:

```text
modules/tac-qlib/.venv/bin/python -m tac_qlib.rd_server
modules/tac-qlib/.venv/bin/python -m tac_qlib.book_server
```

4. Add a Node launcher/bridge that checks `uv`, synchronizes with `uv sync --locked`, resolves the interpreter, sets a narrow environment, uses the module as `cwd`, and reports actionable setup errors.
5. Keep RD and book servers as separate named services even if they share package source. If a second runnable Python module appears, it gets its own project and lockfile.

Validation:

```bash
uv sync --project modules/tac-qlib --locked
uv run --project modules/tac-qlib --locked python -c 'import tac_qlib'
uv run --project modules/tac-qlib --locked python -m tac_qlib.rd_server --help
uv run --project modules/tac-qlib --locked python -m tac_qlib.book_server --help
```

**Exit criteria:** clean-checkout sync works; no root `.venv` or ambient interpreter is used; child processes terminate on shutdown; smoke tests need no credentials, remote embeddings, broker, or populated production lake.

**Phase 2 completion record (2026-11-20):** `scripts/tac-qlib-mcp.mjs` now checks for
`uv`, runs `uv sync --project modules/tac-qlib --locked`, resolves only the module-local
`.venv/bin/python`, uses `modules/tac-qlib` as `cwd`, and passes an explicit runtime
allowlist instead of the arbitrary parent environment. The RD and book services remain
separate named launch targets. `uv sync --locked`, `import tac_qlib`, the module-local
launcher probes, and `npm run test:tac-qlib:lake` passed. The lake harness creates no
production data and requires no credentials; its direct smoke scripts reported
`ALL LAKE PROVIDER CHECKS PASSED` and `ALL CONTRIB CHECKS PASSED`.

### Phase 3 — Define persistence and data ownership

Produce a schema matrix before porting actions. For every retained TradeAC table or record, state its owner, lifecycle, backend, migration, and test fixture.

**Next milestone requirements:**

1. Inventory every retained Trading 2ⁿᵈ scheduler/round, R&D traceability/model/run, and
   RiskCube configuration record before adding persistence or porting server actions.
2. For each record, document the authoritative owner, lifecycle, backend, migration policy,
   retention, failure behavior, and deterministic fixture. Explicitly classify records as
   fina-owned metadata, TAC lake data, qlib/MLflow artifacts, trade-repository data, or
   OLAP-engine data.
3. Reuse the existing Node trade-repository storage-port pattern for fina-owned operational
   records and user preferences, with SQLite as the disposable default and PostgreSQL as an
   optional contract target.
4. Keep qlib, MLflow, lake, and RiskCube data owned by their authoritative services; persist
   only references, configuration, saved views, and user selections in fina-builder where
   needed. Do not migrate TradeAC records or copy production lake data.
5. If fina-owned R&D metadata is required, implement portable SQLite/PostgreSQL repository
   contracts, idempotent migrations, constraints, serialization tests, and deterministic
   lexical-search fallback when pgvector is unavailable.
6. Keep all database URLs and credentials outside renderer state and logs, reject invalid
   configuration explicitly, and test the setup/unavailable path without external services.

**Phase 3 inventory status (2026-11-20):** Phase 3A foundations implemented. The scheduler, round-book, R&D,
and RiskCube records are inventoried with source fields, ownership classification,
proposed backend, lifecycle/retention, migration policy, fixtures, and explicit
defer/unsupported decisions in [`docs/76-phase3-record-inventory.md`](76-phase3-record-inventory.md).
No production-record migration may begin. Phase 3A adds only fina-owned metadata
repositories and read-only book transport contracts after the ownership matrix and
authoritative service boundaries were reviewed.

**Phase 4/7 RiskCube evidence (2026-11-20):** the first RiskCube read-only vertical slice is
implemented behind a typed semantic API and a named `riskcube` MCP boundary. It discovers
capabilities and partitions, selects a bounded scope, runs an allowlisted `olap_query`, and
renders decimal wire values without converting them through binary floating point. The lazy
workspace has capability/setup, loading, validation, backend, timeout, not-found, and empty
states. Browser coverage is fixture-backed and deterministic: `npm run test:e2e:journey:riskcube`
passes the partition → scope → cube → slice journey. The fixture intercepts only `/riskcube/mcp`;
it does not represent production OLAP data.

The browser and Tauri host boundaries accept only the three named read-only RiskCube tools and
reject arbitrary SQL, URI, path, tracking-store, mutation, or executable arguments. R&D has the
same exact-argument read-only protection. API tests cover missing-backend, timeout, validation,
not-found, backend, and credential-redaction classification; pure browser-validator tests and
Tauri validator unit tests cover the host rejection paths. No canonical OLAP/pricer engine has
been selected, no RiskCube sidecar is bundled, and no RiskCube cells, partitions, or production
records are persisted or migrated. Production remains explicitly unavailable until
`RISK_CUBE_MCP_BIN` names an approved canonical sidecar.

- Use the existing trade-repository storage-port pattern for small fina-owned operational records and user preferences.
- Keep qlib/MLflow/lake records owned by their authoritative service; do not silently copy them into a second database.
- Keep RiskCube partitions/cells owned by the selected OLAP engine; persist only cube configuration, saved views, and user-level selections in fina-builder if needed.
- If R&D traceability/model/scheduler records must be persisted in fina-builder, implement a portable repository with SQLite and PostgreSQL contract tests. Treat pgvector semantic search as optional capability: PostgreSQL+pgvector may enable it; SQLite must fall back to deterministic lexical search.
- Do not claim full PostgreSQL/SQLite parity for MLflow or qlib internals unless their own stores support it. Fina-owned metadata may be portable; engine-owned artifacts retain their engine prerequisites.

**Exit criteria:** no renderer-visible DB URL; fresh disposable SQLite tests pass; PostgreSQL tests run only when a disposable service is available; invalid configuration fails explicitly; no TradeAC data is migrated.

### Phase 4 — Add feature transports and navigation

**Read-only Trading 2ⁿd slice status (2026-11-20):** implemented. The existing typed TAC
API, lazy workspace route, menu/command-palette navigation, browser proxy, and named Tauri
TAC commands are now covered by a deterministic Playwright journey in
`playwright/trading2-read-only.spec.ts`. The journey intercepts only the browser MCP boundary
with synthetic JSON-RPC fixtures; it uses no Alpaca credentials, broker state, or production
data. It verifies account/positions/orders/news rendering, the explicit read-only message,
Trading 2ⁿd navigation, and location persistence after reload. Run it with
`npm run test:e2e:journey:trading2`.

**R&D transport and YAML-authoring status (2026-11-22):** the initial experiment → run → result
workspace remains fixture-tested, and the typed `rdApi`, browser `/rd` MCP bridge, and named
Tauri `rd_mcp_*` commands now also expose bounded workflow validation and submission. The
Experiments card's **+ YAML** editor requires server-side schema validation and persisted-lake
preflight, then shows the experiment, model, universe, date segments, determinism settings and
config fingerprint before immediate confirmation. The validator prevents fit-window leakage past
the training segment and bounds optional portfolio analysis to the test segment. The service
injects provider/tracking settings, stages normalized YAML privately, and uses its existing
isolated Qlib subprocess runner; renderer inputs cannot choose paths, providers, tracking URIs,
executables or credentials. The R&D Notebook
button now opens an isolated R&D notebook with a copyable external-agent prompt and starter YAML,
so YAML authoring can proceed when RIGA is unavailable. qlib/MLflow records and artifacts remain
sidecar-owned. Browser tests use synthetic JSON-RPC fixtures and need no lake, MLflow service,
credentials or production artifacts; `playwright/rd-read-only.spec.ts` continues to cover the
read-only experiment → run → result browsing journey.

The Trading 2ⁿd, R&D browsing, and initial RiskCube transport/navigation slices are complete.
The bounded R&D YAML workflow is the exception to read-only browsing: it is a narrowly allowlisted,
confirmed write through the qlib service. Broker mutations, cancellation, durable scheduling,
authentication, RiskCube editing, and RiskCube persistence remain intentionally unavailable.

1. Add typed APIs for Trading 2ⁿᵈ, R&D, and RiskCube. Each API exposes stable DTOs and a closed error shape.
2. Add desktop Tauri commands only for named service operations and MCP process controls. Add corresponding browser HTTP bridges and Vite proxy entries.
3. Add `Location` variants for the three workspaces, or a single feature location with validated subviews where that better matches the existing menu-bar model. Persist only safe view identifiers.
4. Reuse existing `Workspace` lazy loading, `ViewLoadBoundary`, theme tokens, `PanelCard`, tables, charts, and responsive layout conventions.
5. Return explicit capability/setup states for missing TAC, qlib, OLAP engine, data lake, credentials, or optional embedding provider.

**Exit criteria:** the existing dashboards, trade repository, Narrative, Video, and RIGA paths are unchanged; transports have unit tests for success, validation, timeout, missing backend, and process exit; no arbitrary executable or path is selectable from the renderer.

### Phase 5 — Migrate Trading 2ⁿᵈ

Port from TradeAC’s `/dashboard/*` pages, not from the legacy `/trading/*` group. Suggested slices:

1. Account, positions, orders, news, watchlist, macro, and calendar read-only views.
2. Scheduler configuration and run history, using fina-builder’s automation conventions if scheduling is retained. Do not create an unattended scheduler without explicit ownership, lifecycle, and failure semantics.
3. Rounds: facts, target intents, decisions, orders, fills, funnel, and reconciliation. Keep round calculations in `book_server`/authoritative services.
4. Broker mutations only after read paths are stable: order placement/cancellation, fill synchronization, and any round execution action. Confirmation must show the exact operation and target; test with stubs.

Map TradeAC’s server actions to named TAC/book MCP tools. Do not port `requireUser()` as a fake auth layer. Until authentication is separately designed, use the existing local capability/configuration model and clearly label broker actions as unavailable when credentials are absent.

**Exit criteria:** component tests cover loading/success/empty/error/unavailable/mutation confirmation; MCP contract tests assert exact tool names and arguments; deterministic Playwright coverage covers read-only Trading 2ⁿᵈ and cancellation paths; no live orders or production credentials are used.

### Phase 6 — Migrate R&D

Port the selected R&D views and their existing MCP contracts:

- experiment list/detail and traced experiment search;
- input, model, result, blotter, notes, Git graph, and lineage;
- model registry only if its persistence owner and lifecycle are defined;
- bounded Qlib workflow YAML authoring/validation/dispatch, including explicit confirmation and
  service-owned provider, lake, and MLflow settings; this is the RIGA-optional experiment path.

Replace server actions with typed `rdApi` calls. The UI renders DTOs and does not calculate qlib metrics. Use local deterministic fixtures for experiment/run/model/result responses. For delete or destructive operations, require explicit confirmation and test idempotency/error behavior.

**Exit criteria:** RD MCP server starts from module-local `uv`; Python tests cover provider, YAML
schema and tool contracts with temporary fixtures; frontend tests cover all view states and exact
workflow confirmation; one end-to-end local-fixture journey covers experiment → run selection →
result/model/lineage; no remote embedding or MLflow service is required for the default test suite.

### Phase 7 — Migrate RiskCube

First implement the engine capability gate and a small read-only vertical slice:

1. Discover partitions/versions/scenarios.
2. Load a selected scope.
3. Run a validated cube query.
4. Render the tabular/pivot result.

Then add scenario editing, version selection, slices, saved cube configuration, and the full designer. Port the semantics of `cube-sql.ts`: dimensions, measures, aggregation, filters, measure grain/LOD, cell limits, and pivot transform. The preferred boundary is a typed semantic OLAP request modeled on the trade repository's bounded filters/sorts/cursors and a RIGA-style report envelope carrying schema, scope, provenance, assumptions, limitations, lineage, warnings, and engine/snapshot identifiers. Keep all SQL identifier and expression allowlists backend-controlled; never execute arbitrary SQL supplied by the renderer.

Do not migrate RiskCube as a generic `src/features/riskcube` mock over current TAC market data. If the selected OLAP engine is unavailable in browser or desktop packaging, the UI must show a capability/setup state and the plan must state the supported runtime prerequisite.

**Exit criteria:** cube results are sourced from the canonical OLAP service; scenario/version/slice selection is tested; query limits and invalid dimensions are rejected; saved views are deterministic; one Playwright workflow covers partition → scope → cube → slice; no fabricated risk numbers are displayed.

### Phase 8 — Integration, packaging, and release readiness

1. Add CI jobs for the canonical TAC pin, Python `uv sync --locked`, Python tests, feature transport tests, SQLite repository tests, and optional PostgreSQL contract tests.
2. Test developer checkout and packaged desktop resolution for every child process. If Python or the OLAP engine cannot be bundled, document it as a runtime prerequisite and fail fast with setup instructions.
3. Update README, feature docs, and this plan with actual capabilities, env vars, ports, data ownership, and unsupported states.
4. Run the complete suite:

```bash
npm ci
npm run lint
npm run test:run
npm run build
npm run test:e2e
npm run smoke -- --web
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo test --manifest-path modules/tac-engine/Cargo.toml
uv sync --project modules/tac-qlib --locked
uv run --project modules/tac-qlib --locked pytest
npm run tauri:build
```

**Final exit criteria:** all required commands pass on a clean recursive checkout; Trading 2ⁿᵈ, R&D, and RiskCube primary workflows are reachable through fina-builder navigation; legacy Trading and OpenCode are absent; RIGA remains the assistant; one canonical TAC revision is used; no TradeAC records or credentials were migrated; packaged runtime prerequisites are either satisfied or reported clearly.

---

## 5. Feature mapping and test matrix

| TradeAC surface | fina-builder destination | Primary backend | Initial test |
|---|---|---|---|
| Trading 2ⁿᵈ account/positions/orders | `features/trading2` | `tac-engine` | transport + read-only E2E |
| Trading 2ⁿᵈ scheduler/rounds | `features/trading2` | `book_server` + scheduler service | fixture contract + confirmation E2E |
| News/watchlist/macro/calendar | `features/trading2` | `tac-engine` | loading/empty/error component tests |
| R&D experiment/model/result | `features/rd` | `rd_server` + R&D repository | Python MCP + Vitest |
| R&D blotter/lineage/Git graph | `features/rd` | `rd_server`/repository | deterministic fixture E2E |
| RiskCube scenarios/versions/slices/cubes | `features/riskcube` | canonical OLAP engine | query contract + pivot tests |

### Cross-cutting requirements

**Frontend:** every new API has tests for loading, success, empty, unavailable, validation, timeout, and backend error. Keep production mocks out of `dist/` and use existing guard patterns.

**Rust/Tauri:** test command validation, environment construction, process resolution, MCP errors, cleanup, timeout, and reset/reconnect behavior. Do not put business formulas in Tauri command bodies.

**Python:** commit `uv.lock` for every runnable module; use temporary lake/data directories; tests must not require Alpaca, MLflow, public feeds, or remote embedding APIs.

**Persistence:** test migration idempotency, foreign keys, uniqueness, JSON/numeric/timestamp serialization, and invalid URL behavior. Test lexical fallback when pgvector is absent.

**Security:** do not expose secrets, database URLs, arbitrary shell access, arbitrary SQL, or arbitrary child-process configuration to the webview. Redact credentials in logs. Require explicit confirmation for broker-impacting actions.

---

## 6. Change-control rules

1. Make all migration changes in `fina-builder` only.
2. Keep `tradeac` read-only and frozen as the source reference.
3. Record every imported behavior against the source file and commit SHA.
4. Do not add a duplicate TAC engine checkout or import the entire TradeAC repository as a submodule.
5. Do not port legacy Trading or OpenCode by accident; scope additions require an explicit update here.
6. Do not migrate data, auth, or production credentials as incidental work.
7. Do not expose a feature in navigation until its primary workflow, setup state, and failure states have tests.
8. Prefer existing fina-builder transport, MCP, storage, theme, navigation, and test conventions over introducing a parallel framework.
9. Any change to database ownership, OLAP engine choice, Python packaging, or broker side-effect policy requires an ADR or an update to this document before implementation.


## 7. Write-capability slice (2026-11-20)

The first write slice is implemented in `fina-builder` only. Trading 2ⁿd uses the canonical TAC tools `place_order`, `get_order`, and `cancel_order` from the pinned `modules/tac-engine` source (`89fb0c89e19e72c05131f8b1022016a9098e254f`; definitions in `src/server.rs` and `src/params.rs`). The browser bridge and Tauri host enforce exact mutation argument allowlists and bounded order validation. The UI performs immediate exact-action confirmation and refreshes the acknowledgement through `list_orders`/`get_order`; it does not retry ambiguous mutations.

R&D uses the tracked `modules/tac-qlib` service tools `rd_trace_start`, `rd_trace_get`,
`rd_trace_list`, `rd_train`, `rd_validate_workflow`, and `rd_run_workflow` (registration in
`tac_qlib/trace.py` and `tac_qlib/rd_server.py`). The YAML tools accept only a bounded,
declarative subset and reject renderer paths, providers, tracking URIs, database URLs, custom
modules, and credentials. Validation and data preflight are non-run operations; workflow dispatch
requires immediate confirmation and records a reproducibility fingerprint/profile in MLflow.
RIGA is optional for this workflow because the R&D Notebook provides a copyable prompt/starter YAML
for external agents. qlib/MLflow remain the owners of run records and artifacts. Schedule writes
remain unsupported because no canonical scheduler owner/lifecycle has been selected; no fake
schedule success is rendered. TradeAC remains an unchanged read-only reference.
