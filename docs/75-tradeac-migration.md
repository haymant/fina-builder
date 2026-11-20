# TradeAC → fina-builder: Executable Implementation and Test Plan

**Status:** Proposed  
**Target repository:** `haymant/fina-builder`  
**Reference repository:** `haymant/tradeac` — frozen reference; do not modify unless explicitly authorized  
**Migration style:** Selective feature migration into fina-builder’s existing React/Vite + Tauri application. Do not merge the two repository roots or bring over TradeAC’s Next.js runtime.

---

## 1. Goals and scope

### In scope

Migrate the following TradeAC feature sets, as represented in its left navigation:

1. **Trading 2nd** — first priority. Port this feature set only; do not port the legacy `trading` area.
2. **R&D** — experiments, models, results, lineage, and related workflows.
3. **Risk Cube** — cubes, scenarios, slices, and versions.

Use fina-builder’s existing React, TypeScript, Vite, Tailwind, Tauri v2, Rust, test, and release conventions. Reuse its existing RIGA assistant and TAC engine integration where practical.

### Explicitly out of scope

- TradeAC’s legacy **Trading** area. It is obsolete and replaced by **Trading 2nd**.
- TradeAC’s **agent/OpenCode** UI, server, and related integration. The existing **RIGA** assistant is the replacement and remains fina-builder’s assistant.
- TradeAC authentication and user-management migration for this work.
- Migration of existing TradeAC database records.
- Importing unrelated Next.js admin-template pages or deploying a second web application inside fina-builder.

### Required outcomes

- One TAC engine source and one pinned `modules/tac-engine` submodule revision.
- Each runnable Python module has an independent `uv`-managed environment and lockfile; no shared/root Python environment.
- Database schema and persistence work with both PostgreSQL and SQLite, selected by `DATABASE_URL`.
- The migrated features use fina-builder’s frontend and Tauri IPC patterns. The renderer does not spawn processes or connect directly to the database.
- TradeAC remains available as an unchanged source reference until explicitly released from that role.

---

## 2. Current-state evidence and migration boundaries

The plan is grounded in the repositories’ current structure:

- TradeAC is a Next.js 16 App Router app in `tac-app/`. Its UI includes Trading 2nd, R&D, and Risk Cube routes. Its `src/server/*-actions.ts` files use Next server actions, authentication checks, Drizzle/Postgres, and MCP clients.
- TradeAC has Git submodules for `qlib`, `FinA`, and `tac-engine`; `tac-qlib/` is a Python package that starts R&D/book MCP servers.
- The TradeAC Python launchers currently find a shared workspace root and use its `.venv` or a bare `python`. This must be replaced with deterministic module-local `uv` environments.
- fina-builder already has a Vite React app, Tauri v2 shell, Rust-owned MCP subprocesses, `modules/` engine submodules, typed transport patterns, frontend tests, and desktop release workflows.
- The repositories pin `tac-engine` at different gitlink revisions in the inspected snapshot:
  - fina-builder: `89fb0c89e19e72c05131f8b1022016a9098e254f`
  - TradeAC: `c876902c8ea74500437903702cf27431077e694b`
- TradeAC’s schema uses PostgreSQL-specific features including `pgTable`, `jsonb`, `vector(384)`, and Postgres migrations. It cannot be made SQLite-compatible merely by changing the connection string.

### Source snapshot

Record the frozen TradeAC source commit before implementation. The inspected TradeAC source files were at commit `478849f923cf68b53e180250ad444a11a2255b57`; fina-builder files were inspected at `cc40430ea9f7bdd2d08b94036593769f7eea7ea1`. Reconfirm and record the actual commit IDs at migration start.

---

## 3. Target architecture

```text
src/
  features/
    trading2/                 Trading 2nd UI and feature state
    rd/                       R&D UI and feature state
    riskcube/                 Risk Cube UI and feature state
  api/
    trading2Transport.ts      Typed Tauri command wrappers
    rdTransport.ts
    riskcubeTransport.ts
src-tauri/src/
  tradeac/                    Tauri commands and feature services
  db/                         DATABASE_URL selection, repositories, migrations
modules/
  tac-engine/                 The single merged/pinned TAC engine submodule
  qlib/                       Pinned qlib source, if required by tac-qlib
  tac-qlib/                   Python package and its own uv project/lock


  ```markdown name=docs/tradeac-migration-plan.md
# TradeAC → fina-builder: Executable Implementation and Test Plan

**Status:** Proposed  
**Target repository:** `haymant/fina-builder`  
**Reference repository:** `haymant/tradeac` — frozen reference; do not modify unless explicitly authorized  
**Migration style:** Selective feature migration into fina-builder’s existing React/Vite + Tauri application. Do not merge the two repository roots or bring over TradeAC’s Next.js runtime.

---

## 1. Goals and scope

### In scope

Migrate the following TradeAC feature sets, as represented in its left navigation:

1. **Trading 2nd** — first priority. Port this feature set only; do not port the legacy `trading` area.
2. **R&D** — experiments, models, results, lineage, and related workflows.
3. **Risk Cube** — cubes, scenarios, slices, and versions.

Use fina-builder’s existing React, TypeScript, Vite, Tailwind, Tauri v2, Rust, test, and release conventions. Reuse its existing RIGA assistant and TAC engine integration where practical.

### Explicitly out of scope

- TradeAC’s legacy **Trading** area. It is obsolete and replaced by **Trading 2nd**.
- TradeAC’s **agent/OpenCode** UI, server, and related integration. The existing **RIGA** assistant is the replacement and remains fina-builder’s assistant.
- TradeAC authentication and user-management migration for this work.
- Migration of existing TradeAC database records.
- Importing unrelated Next.js admin-template pages or deploying a second web application inside fina-builder.

### Required outcomes

- One TAC engine source and one pinned `modules/tac-engine` submodule revision.
- Each runnable Python module has an independent `uv`-managed environment and lockfile; no shared/root Python environment.
- Database schema and persistence work with both PostgreSQL and SQLite, selected by `DATABASE_URL`.
- The migrated features use fina-builder’s frontend and Tauri IPC patterns. The renderer does not spawn processes or connect directly to the database.
- TradeAC remains available as an unchanged source reference until explicitly released from that role.

---

## 2. Current-state evidence and migration boundaries

The plan is grounded in the repositories’ current structure:

- TradeAC is a Next.js 16 App Router app in `tac-app/`. Its UI includes Trading 2nd, R&D, and Risk Cube routes. Its `src/server/*-actions.ts` files use Next server actions, authentication checks, Drizzle/Postgres, and MCP clients.
- TradeAC has Git submodules for `qlib`, `FinA`, and `tac-engine`; `tac-qlib/` is a Python package that starts R&D/book MCP servers.
- The TradeAC Python launchers currently find a shared workspace root and use its `.venv` or a bare `python`. This must be replaced with deterministic module-local `uv` environments.
- fina-builder already has a Vite React app, Tauri v2 shell, Rust-owned MCP subprocesses, `modules/` engine submodules, typed transport patterns, frontend tests, and desktop release workflows.
- The repositories pin `tac-engine` at different gitlink revisions in the inspected snapshot:
  - fina-builder: `89fb0c89e19e72c05131f8b1022016a9098e254f`
  - TradeAC: `c876902c8ea74500437903702cf27431077e694b`
- TradeAC’s schema uses PostgreSQL-specific features including `pgTable`, `jsonb`, `vector(384)`, and Postgres migrations. It cannot be made SQLite-compatible merely by changing the connection string.

### Source snapshot

Record the frozen TradeAC source commit before implementation. The inspected TradeAC source files were at commit `478849f923cf68b53e180250ad444a11a2255b57`; fina-builder files were inspected at `cc40430ea9f7bdd2d08b94036593769f7eea7ea1`. Reconfirm and record the actual commit IDs at migration start.

---

## 3. Target architecture

```text
src/
  features/
    trading2/                 Trading 2nd UI and feature state
    rd/                       R&D UI and feature state
    riskcube/                 Risk Cube UI and feature state
  api/
    trading2Transport.ts      Typed Tauri command wrappers
    rdTransport.ts
    riskcubeTransport.ts
src-tauri/src/
  tradeac/                    Tauri commands and feature services
  db/                         DATABASE_URL selection, repositories, migrations
modules/
  tac-engine/                 The single merged/pinned TAC engine submodule
  qlib/                       Pinned qlib source, if required by tac-qlib
  tac-qlib/                   Python package and its own uv project/lock
```

Adapt names to fina-builder’s existing module and naming conventions during implementation. Do not create a second top-level UI shell or replace fina-builder’s `App.tsx`.

### Runtime boundaries

- **React webview:** renders UI, owns view state, calls typed Tauri transports.
- **Tauri/Rust:** owns subprocess lifecycle, MCP stdio clients, filesystem access, database access, validation, and error mapping.
- **TAC engine:** remains a standalone Rust workspace under `modules/tac-engine`; the root Cargo workspace continues to exclude standalone module workspaces.
- **Python:** R&D Python MCP processes run from the `uv` environment owned by the relevant Python module. Tauri resolves that module’s interpreter and starts the MCP process.
- **Database:** Tauri commands call a repository/service layer; no database URL or raw DB connection is exposed to the webview.
- **RIGA:** stays as fina-builder’s assistant. Do not migrate TradeAC’s agent implementation.

---

## 4. Implementation phases and exit criteria

Every phase is a separate reviewable PR or commit series. Do not proceed past a phase’s exit criteria while its required tests are failing.

### Phase 0 — Freeze references and capture baselines

#### Tasks

1. Confirm the TradeAC default branch and record its current commit SHA in this document or the migration tracking issue.
2. Make no writes, commits, dependency updates, or cleanup changes to `haymant/tradeac`.
3. Configure the team workflow so migration changes are made only in fina-builder. If branch protections are available, prohibit direct pushes to TradeAC’s reference branch.
4. Save the current fina-builder baseline:
   - Frontend test/build/lint results.
   - Rust workspace test and formatting results.
   - Current TAC engine pin.
5. Inventory exact route/component/action dependencies for Trading 2nd, R&D, and Risk Cube. Record shared components, packages, DB tables, MCP tools, environment variables, and Python entry points.
6. Mark the legacy TradeAC `trading` and `agent` features excluded in the inventory.

#### Commands

```bash
git clone https://github.com/haymant/fina-builder.git
git clone https://github.com/haymant/tradeac.git tradeac-reference

git -C tradeac-reference rev-parse HEAD
git -C tradeac-reference status --short

cd fina-builder
npm ci
npm run test:run
npm run build
npm run lint
cargo test --workspace
cargo fmt --all -- --check
```

If the reference clone is intentionally kept local, make it read-only in the migration workspace and do not add it as a working submodule.

#### Exit criteria

- TradeAC reference commit SHA and fina-builder baseline commit SHA are recorded.
- TradeAC working tree is clean, and no migration work is committed there.
- A feature dependency inventory exists for Trading 2nd, R&D, and Risk Cube.
- Baseline commands pass, or pre-existing failures are documented and distinguished from migration failures.

---

### Phase 1 — Reconcile TAC engine versions

#### Tasks

1. Initialize fina-builder’s existing TAC engine submodule and verify its current gitlink.
2. Fetch the TradeAC-pinned revision into the same submodule repository if reachable.
3. Compare the two revisions, identify their common ancestor, inspect the complete diff, and run tests against both.
4. Select a single canonical revision:
   - If one revision is an ancestor of the other and the later revision contains the needed changes, pin the later revision after tests pass.
   - If both contain unique changes, merge those changes in the `haymant/tac-engine` repository first, run its tests, then update fina-builder’s submodule gitlink to the resulting merge commit.
   - Do not copy one submodule’s files over the other or maintain two TAC engine checkouts.
5. Confirm the migrated Trading 2nd, R&D, and Risk Cube workflows use tools present in the canonical TAC engine.
6. Update fina-builder’s sidecar build, CI, docs, and tests only if the canonical pin or build requirements require it.

#### Commands

From the fina-builder checkout:

```bash
git submodule update --init modules/tac-engine

git -C modules/tac-engine rev-parse HEAD
git -C modules/tac-engine fetch origin --tags

# These are the inspected snapshot pins; verify they still match Phase 0.
git -C modules/tac-engine cat-file -e \
  89fb0c89e19e72c05131f8b1022016a9098e254f^{commit}
git -C modules/tac-engine cat-file -e \
  c876902c8ea74500437903702cf27431077e694b^{commit}

git -C modules/tac-engine merge-base \
  89fb0c89e19e72c05131f8b1022016a9098e254f \
  c876902c8ea74500437903702cf27431077e694b

git -C modules/tac-engine diff --stat \
  89fb0c89e19e72c05131f8b1022016a9098e254f \
  c876902c8ea74500437903702cf27431077e694b

git -C modules/tac-engine diff \
  89fb0c89e19e72c05131f8b1022016a9098e254f \
  c876902c8ea74500437903702cf27431077e694b
```

After selecting or merging a canonical TAC engine revision:

```bash
cargo test --manifest-path modules/tac-engine/Cargo.toml
cargo fmt --manifest-path modules/tac-engine/Cargo.toml --all -- --check
cargo clippy --manifest-path modules/tac-engine/Cargo.toml --all-targets -- -D warnings

git submodule status modules/tac-engine
npm run mcp:sidecar:tac
npm run smoke
```

If a referenced object is absent after fetching, locate the corresponding commit in the TAC engine’s upstream repository before proceeding. Do not interpret a missing local object as evidence that the two versions are identical.

#### Exit criteria

- Diff between the two inspected pins has been reviewed and the differences are classified.
- All unique required changes exist in one canonical TAC engine commit.
- TAC engine tests pass at that commit.
- fina-builder has one `modules/tac-engine` gitlink; no duplicate TAC engine directory or binary is introduced.
- The selected commit SHA and rationale are recorded.

---

### Phase 2 — Create independent `uv` Python module environments

#### Tasks

1. Inventory every Python MCP entry point required by the in-scope features. At minimum, verify whether `tac_qlib.rd_server` and `tac_qlib.book_server` are required for the selected R&D and Trading 2nd workflows.
2. Give each runnable Python module its own project metadata, lockfile, and environment under its module directory:
   - `modules/tac-qlib/pyproject.toml`
   - `modules/tac-qlib/uv.lock`
   - `modules/tac-qlib/.venv/` (ignored)
3. Pin supported Python and dependency versions. Pin the qlib source revision. If qlib is a source submodule rather than a runnable module, install it as a pinned local source dependency into `tac-qlib`’s environment; do not share the environment with another Python module.
4. Remove runtime dependence on a root `.venv`, ambient `python`, `pip`, or implicit `PYTHONPATH` discovery.
5. Add a fina-builder script/helper that:
   - Checks for `uv`.
   - Creates/synchronizes the target module environment with its lockfile.
   - Resolves the module’s exact interpreter path.
   - Starts the server with an explicit working directory and a narrowly scoped environment.
   - Returns an actionable error if the environment is missing or out of date.
6. Add setup docs for development and packaged-app expectations. Do not claim Python is bundled until a distributable runtime/sidecar strategy is implemented and tested.

#### Commands

From the fina-builder root, after adding the module project:

```bash
uv --version
uv sync --project modules/tac-qlib --locked
uv run --project modules/tac-qlib --locked \
  python -m tac_qlib.rd_server --help
uv run --project modules/tac-qlib --locked \
  python -m tac_qlib.book_server --help
```

If an entry point does not support `--help`, replace that check with a deterministic import or `--version` smoke command that does not require broker credentials or a populated lake.

For a second runnable Python module, use the same commands with that module’s own `--project` path and `uv.lock`; never reuse the `tac-qlib/.venv`.

#### Exit criteria

- Each in-scope Python server has an explicit, documented module owner and interpreter path.
- Each runnable module has an independent lockfile and environment.
- `uv sync --locked` succeeds from a clean checkout.
- Python smoke tests run without relying on a root `.venv` or user-installed packages.
- Missing `uv`, Python, lockfile, or dependencies produce a clear actionable failure.
- CI can install and run the Python module’s tests from a clean environment.

---

### Phase 3 — Implement PostgreSQL/SQLite persistence

#### Design decision

Use a Rust persistence layer owned by Tauri, selected from `DATABASE_URL`. This keeps database credentials and database operations out of the webview and avoids depending on Next.js server actions or a Node server in the desktop app.

Use SQLx with runtime query APIs and versioned SQL migrations. Maintain separate, tested migration directories for PostgreSQL and SQLite where syntax or types differ. Do not attempt to express Postgres-only `vector` columns as portable SQLite columns.

#### Tasks

1. Inventory all tables and queries needed by the in-scope feature sets. Start with the TradeAC schema and actions, but exclude auth tables and tables used only by excluded features.
2. Create a schema compatibility matrix for every retained field:
   - Primary-key and foreign-key behavior.
   - JSON document representation.
   - Numeric precision/serialization.
   - Date and timestamp representation.
   - Indexes, uniqueness, defaults, and nullability.
   - Vector/embedding behavior.
3. Define consistent Rust domain types and repository interfaces independent of SQL dialect.
4. Implement a database factory that parses `DATABASE_URL` and accepts only supported schemes:
   - `postgres://...` or `postgresql://...` → PostgreSQL.
   - `sqlite://...` → SQLite.
   - Missing or unsupported URL → a clear startup/configuration error when a DB-backed feature is first used.
5. Implement idempotent migrations for both dialects. For SQLite, enable foreign keys and use portable JSON text or SQLite JSON support as appropriate. For PostgreSQL, use JSONB where useful.
6. Replace TradeAC Postgres-only semantic vector search with an explicit capability:
   - PostgreSQL may use vector search only if pgvector is available and the feature is separately enabled.
   - SQLite must provide deterministic text search and must not require pgvector.
   - Missing pgvector must not prevent ordinary R&D records from loading or saving.
7. Port the required read/write operations from TradeAC server actions into repositories and typed Tauri commands.
8. Do not migrate existing database data. Test against fresh disposable databases only.

#### Configuration examples

```bash
# SQLite (local desktop default for development/tests)
export DATABASE_URL="sqlite://./.data/fina-builder.db"

# PostgreSQL (for shared/remote database use)
export DATABASE_URL="postgres://fina:password@127.0.0.1:5432/fina_builder"
```

Do not commit credentials. SQLite path creation and PostgreSQL schema initialization must be documented. The app must not silently fall back from an invalid PostgreSQL URL to SQLite.

#### Commands

The exact Rust package name may be adjusted to match fina-builder’s crate layout:

```bash
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings

DATABASE_URL="sqlite://./.data/test.db" cargo test --workspace
DATABASE_URL="postgres://fina:fina@127.0.0.1:5432/fina_test" \
  cargo test --workspace
```

CI must provision a disposable PostgreSQL service and use a temporary SQLite file. Tests must not point at developer or production databases.

#### Exit criteria

- Fresh SQLite and PostgreSQL databases both migrate successfully.
- Repository contract tests pass against both dialects.
- CRUD, relationships, uniqueness, JSON serialization, and timestamps behave consistently.
- SQLite startup and tests do not require pgvector.
- PostgreSQL-only vector search is capability-gated; fallback behavior is tested.
- No webview code opens a database connection or receives `DATABASE_URL`.
- Existing TradeAC records are not copied or migrated.

---

### Phase 4 — Build the Tauri feature transport and navigation

#### Tasks

1. Add typed Rust/Tauri command modules for the in-scope features. Commands should accept validated DTOs and return stable result/error shapes.
2. Reuse fina-builder’s Rust-owned MCP runtime and TAC engine resolution for TAC calls. Add Python MCP process management for `tac-qlib` using the `uv`-resolved interpreter.
3. Use Tauri async/runtime facilities so long-running MCP calls do not block the UI. Add request timeouts, process-exit handling, cancellation where the UI needs it, and safe reset/reconnect behavior.
4. Add typed frontend transport files under `src/api/`. Keep command names, DTOs, error handling, and serialization tested.
5. Add the three feature entries to fina-builder’s left navigation:
   - Trading 2nd
   - R&D
   - Risk Cube
6. Do not add TradeAC’s agent/OpenCode entry. Keep fina-builder’s RIGA entry and assistant behavior intact.
7. Do not add the obsolete TradeAC Trading entry.
8. Ensure navigation to unavailable Python-backed features shows a useful setup status and does not crash the rest of the app.

#### Exit criteria

- Frontend invokes only named, typed commands; it cannot choose an arbitrary executable, path, working directory, or environment.
- Tauri owns all MCP/Python child processes and shuts them down on application exit.
- Existing RIGA, TAC, and NIP behavior remains operational.
- Left navigation displays only the in-scope migrated features plus fina-builder’s existing entries.
- Unit tests cover success, validation failure, timeout, missing binary/interpreter, and child process exit.

---

### Phase 5 — Port Trading 2nd

#### Source and destination

Use only TradeAC’s **Trading 2nd** routes/components and dependencies. Expected source areas include `tac-app/src/app/(main)/trading/` and the associated feature components/actions; confirm exact files in the Phase 0 inventory. Do not copy the legacy `trading` implementation or routes.

Implement under `src/features/trading2/`.

#### Tasks

1. Port the user-facing pages/components into fina-builder’s React/Vite component model. Remove Next-only APIs, server components, server actions, metadata, and routing assumptions.
2. Reuse fina-builder’s existing Tauri/TAC transport and UI primitives. Use its Tailwind version, theme tokens, React patterns, state conventions, and test utilities.
3. Port the selected Trading 2nd workflows and only their required TAC MCP calls.
4. Send reads and mutations through typed Tauri commands. Validate mutation inputs in Rust as well as in the UI.
5. Require explicit user confirmation for broker-impacting actions such as order placement/cancellation. Tests must use mocks/fixtures; do not place live orders in CI.
6. Define unavailable/unauthorized credential behavior even though app-level authentication is deferred: no configured broker credentials means a clear disabled/error state, not fake data.
7. Preserve meaningful TradeAC behavior and terminology while adapting layout/navigation to fina-builder.

#### Tests and exit criteria

- Component tests cover loading, success, empty, error, and mutation-confirmation states.
- Transport tests assert exact MCP tool names and argument shapes.
- Rust tests cover request validation and error mapping.
- Browser E2E covers the primary read-only workflow and confirms mutation cancellation/confirmation paths using stubs.
- No live broker credentials or live orders are needed for tests.
- Legacy TradeAC Trading pages/actions are absent from fina-builder.

---

### Phase 6 — Port R&D

#### Source and destination

Use TradeAC’s R&D pages/actions, `tac-qlib` services, and required data schema. Expected source areas include `tac-app/src/app/(main)/rd/`, `rd-actions.ts`, `experiments-actions.ts`, `rounds-actions.ts` only where an in-scope R&D view needs them, and `tac-qlib/`.

Implement the UI under `src/features/rd/`, Python package under `modules/tac-qlib/`, and persistence in the Tauri database service.

#### Tasks

1. Port the selected experiment/model/result/lineage workflows. Maintain the feature inventory as the source of truth for what is included.
2. Replace Next server actions with Tauri transport calls and repository/MCP operations.
3. Ensure calculations and qlib workflows remain in the Python/Rust service that owns them; do not duplicate domain calculations in React.
4. Run R&D Python MCP servers from the `uv` environment established in Phase 2.
5. Implement PostgreSQL and SQLite persistence for selected records. Keep schema differences behind repositories.
6. Provide stable user-facing errors when the qlib module, `uv` environment, data lake, or required engine is unavailable.
7. Do not implement TradeAC authentication, OpenCode integration, or user/session authorization as part of this phase.

#### Tests and exit criteria

- Python unit/integration tests cover the selected data providers, workflows, and MCP server contracts using temporary fixtures.
- Tests do not require Alpaca credentials, a production lake, or a remote embedding API.
- Tauri tests cover subprocess resolution, startup failure, timeout, restart, and shutdown.
- PostgreSQL and SQLite repository contract suites both pass.
- E2E covers one representative R&D flow end to end using deterministic local fixtures.

---

### Phase 7 — Port Risk Cube

#### Source and destination

Use TradeAC’s `riskcube` feature only. The inspected route structure includes `cubes`, `scenarios`, `slice`, and `versions`. Confirm their exact dependencies and persistence requirements during Phase 0.

Implement under `src/features/riskcube/`.

#### Tasks

1. Port the Risk Cube navigation pages and shared components to fina-builder’s existing UI stack.
2. Replace server actions with typed Tauri calls.
3. Keep cube/scenario calculations in their existing authoritative engine/service; do not recreate formulas in the UI.
4. Persist required records through the cross-database repositories.
5. Gate optional feature behavior based on actual backend capability instead of returning fabricated or placeholder risk data.
6. Keep Risk Cube terminology distinct from fina-builder’s existing payoff/risk displays and avoid duplicate menu entries.

#### Tests and exit criteria

- Unit tests cover cube/scenario selection, slicing, version selection, and UI empty/loading/error states.
- Backend contract tests cover input validation and output DTO compatibility.
- PostgreSQL and SQLite persistence tests pass.
- E2E covers a representative Risk Cube workflow with deterministic fixtures.
- No TradeAC legacy Trading or agent UI is included.

---

### Phase 8 — Integration, packaging, and release readiness

#### Tasks

1. Run the entire fina-builder frontend, Rust, Python, submodule, and E2E test suites.
2. Add CI jobs for:
   - Current pinned TAC engine tests.
   - `uv sync --locked` and Python tests for each in-scope runnable module.
   - SQLite repository tests.
   - PostgreSQL repository tests with a disposable service.
   - Existing fina-builder frontend/Rust coverage and production-mock guards.
3. Update Tauri dev/build scripts to build or resolve the canonical TAC engine and report the Python environment requirement accurately.
4. Test sidecar and Python path resolution in both developer checkouts and packaged app builds. If Python cannot yet be reliably packaged, document it as a runtime prerequisite and fail fast with setup instructions.
5. Update fina-builder README and feature docs. Document:
   - The migrated feature sets and excluded legacy features.
   - `DATABASE_URL` PostgreSQL/SQLite configuration.
   - `uv` installation and per-module sync commands.
   - Data lake and engine requirements.
   - Current desktop packaging limitations.
6. Verify TradeAC remains unchanged and that all imported behavior can be traced to the recorded reference commit.

#### Final commands

```bash
git submodule update --init --recursive

npm ci
npm run lint
npm run test:run
npm run build
npm run test:e2e

cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

cargo test --manifest-path modules/tac-engine/Cargo.toml
uv sync --project modules/tac-qlib --locked
uv run --project modules/tac-qlib --locked pytest
```

Run the database suites independently against both backends using disposable databases:

```bash
DATABASE_URL="sqlite://./.data/test.db" cargo test --workspace

DATABASE_URL="postgres://fina:fina@127.0.0.1:5432/fina_test" \
  cargo test --workspace
```

Run the actual Tauri development and bundle builds on each supported CI platform:

```bash
npm run tauri:dev
npm run tauri:build
```

#### Final exit criteria

- All required commands pass on a clean checkout with recursively initialized submodules.
- Trading 2nd, R&D, and Risk Cube are reachable from fina-builder’s left navigation and have tested primary workflows.
- Legacy TradeAC Trading and TradeAC agent/OpenCode are not ported.
- RIGA remains the assistant.
- Both database backends pass the same repository behavior contract.
- Python dependencies are pinned and managed independently with `uv`.
- Exactly one canonical TAC engine revision is referenced by fina-builder.
- A packaged build either runs its required Python-backed features or clearly reports the documented missing runtime prerequisite.
- No TradeAC data migration has occurred.
- `haymant/tradeac` remains unchanged and frozen as the source reference.

---

## 5. Cross-cutting test requirements

### Frontend

- Vitest tests for every new transport and feature state.
- Test loading, success, empty, validation error, backend unavailable, and timeout states.
- Do not use production Tauri mocks in production builds; retain fina-builder’s production mock guard.
- Playwright E2E must use deterministic stubs/fixtures unless a test is explicitly an opt-in local integration test.

### Rust/Tauri

- Unit tests for command argument validation, environment construction, process resolution, errors, database selection, and repository behavior.
- Do not test by starting a real broker order or connecting to a production database.
- Verify process cleanup and cancellation for MCP/Python children.

### Python/qlib

- `uv.lock` is committed for each runnable module.
- CI uses `uv sync --locked`; no unpinned dependency resolution during tests.
- Use temporary lake/data directories and deterministic fixtures.
- Tests must run without API keys or public services.

### Database

- Run repository contract tests against fresh SQLite and PostgreSQL databases.
- Verify migration idempotency, foreign keys, uniqueness, nullability, JSON encoding, numeric behavior, and timestamps on both backends.
- Confirm SQLite works without pgvector installed.
- Verify invalid/missing URLs return explicit configuration errors and never silently switch database backends.

### Security and operational behavior

- No database URL, broker secret, or arbitrary shell capability is exposed to the webview.
- Tauri commands are narrow and validate input on the Rust side.
- Broker mutations require explicit confirmation and have no live-order CI tests.
- Logs redact secrets and do not write credentials or raw connection URLs.

---

## 6. Change-control rules

1. All migration commits go to `haymant/fina-builder`.
2. Do not commit any change to `haymant/tradeac` unless the owner explicitly requests unfreezing it.
3. Record the TradeAC source commit and selected TAC engine commit in migration documentation.
4. Do not add a duplicate `tac-engine` submodule or import the entire TradeAC repository as a submodule.
5. Do not migrate data or auth as an incidental part of a feature port.
6. Do not add a feature to the left navigation until its primary workflow, error states, and backend requirements have tests.
7. Any scope change—especially unfreezing TradeAC, adding auth, or bringing legacy Trading/agent features back—requires explicit approval.
```