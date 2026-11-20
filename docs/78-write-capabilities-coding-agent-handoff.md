# 78 — Trading 2ⁿd and R&D write-capabilities coding-agent handoff

## Mission

Continue work in `/home/ubuntu/fina-builder` by adding narrowly scoped, host-authorized write capabilities to the existing Trading 2ⁿd and R&D feature slices. Trading 2ⁿd must support safe order management through named TAC/book operations. R&D must support creation and management of experiments, runs, schedules, and the associated metadata/workflow objects that are already owned by the R&D service or fina-builder repository.

Preserve the existing React/Vite/Tauri/MCP/sidecar architecture. Do not rewrite the transport layer, import the TradeAC application, or create a renderer-side process/database boundary. The renderer may request named operations only; the host or named sidecar remains responsible for credentials, validation, persistence, and side effects.

## Verified baseline

- Repository: `/home/ubuntu/fina-builder`, branch `main`.
- Latest baseline includes read-only Trading 2ⁿd, R&D, and RiskCube slices, typed APIs, browser HTTP bridges, Tauri commands, host-boundary allowlists, structured errors, fixture-backed Playwright journeys, and deterministic Vitest coverage.
- Latest pushed commits include:
  - `bfcb833 fix: make desktop sidecar setup deterministic`
  - `225126f fix: handle empty rd tracking stores`
- Existing focused journeys:

```bash
npm run test:e2e:journey:trading2
npm run test:e2e:journey:rd
npm run test:e2e:journey:riskcube
```

- Existing relevant implementations include:
  - `src/api/rdApi.ts`
  - `src/api/riskcubeApi.ts`
  - `src/features/trading2/`
  - `src/features/rd/`
  - `scripts/rd-mcp-http.mjs`
  - `scripts/tac-qlib-mcp.mjs`
  - `src-tauri/src/mcp_commands.rs`
  - `src-tauri/src/mcp.rs`
  - `scripts/lib/mcpAllowlist.mjs`
  - `docs/75-tradeac-migration.md`
- The canonical TAC pin and required submodules must not be changed incidentally.
- RiskCube remains read-only and explicitly unavailable without an approved canonical OLAP/pricer sidecar. Do not add RiskCube writes in this task.

## Product scope

### Trading 2ⁿd order management

Add typed, named operations for the smallest useful order-management surface:

1. Create/submit an order.
2. Cancel an existing order.
3. Replace/amend an existing order only if the canonical TAC contract supports it; otherwise expose a clear unsupported capability state rather than emulating it.
4. Read the resulting order status and broker acknowledgement through the existing read API.
5. Do not add fill synchronization, round execution, or portfolio rebalancing unless the canonical service contract and ownership are documented first. These remain separate follow-up capabilities.

Every broker-impacting operation must display a confirmation containing the exact action, account/environment, instrument, side, quantity/notional, order type, limit/stop values, time-in-force, client/order identifier, and whether the request is live or paper. The confirmation must happen immediately before the host call, not merely when opening an order form.

### R&D writes

Add typed operations for the R&D capabilities actually supported by the tracked `modules/tac-qlib` service and/or the fina-owned metadata repository. Start with:

1. Create/update experiment metadata.
2. Create a run from a validated experiment configuration.
3. Record run status and retrieve run/result metadata.
4. Create, update, pause, resume, and disable schedules if the scheduler ownership and lifecycle are defined by the service.
5. Create/update notes, tags, lineage links, and other metadata only where the owning persistence boundary is explicit.
6. Do not copy MLflow artifacts, qlib model files, TradeAC records, broker credentials, or production lake data into the fina-builder repository.

Creating a run can have compute, data, or external-service side effects. Show a preflight summary and explicit confirmation before dispatch. Creating a schedule is a durable action: show cadence, timezone, target experiment/configuration, next-run behavior, owner, retry policy, and enabled/disabled state. Enabling or resuming a schedule requires a separate explicit confirmation from saving a disabled draft.

If a requested R&D operation is not backed by a canonical tool or persistence owner, implement an unavailable/unsupported state and document the gap. Do not fabricate a successful write in the browser fixture.

## Security and authority requirements

- Do not implement authentication or renderer-supplied roles as part of this task. Continue using the existing local capability/configuration model and make its limitations visible in the UI. Authentication remains a separate design item.
- The renderer must never choose an executable, subprocess command, database URL, tracking-store URI, filesystem path, SQL statement, arbitrary MCP tool, or arbitrary child-process environment.
- Add exact allowlist entries for every new tool and argument shape. Reject unknown tools and extra arguments.
- Validate broker order fields on the host boundary: symbol/instrument syntax, side, quantity/notional, decimal strings, order type, price/stop fields, time-in-force, account/environment, and bounded lengths/ranges. Preserve decimal strings; do not round through JavaScript floating point.
- Validate R&D experiment/run/schedule inputs on the host or owning service boundary. Reject arbitrary URI/path/tracking-store/database arguments from the renderer.
- Keep credentials and connection strings host-side only. Never put them in Vite variables, DTOs returned to the renderer, logs, fixtures, screenshots, or Playwright traces.
- Redact secrets and sensitive headers in structured errors and diagnostics.
- Use idempotency/request identifiers where the underlying service supports them. Never automatically retry a broker mutation after an ambiguous timeout unless the service provides a safe idempotency contract and the UI explains the state.
- Do not silently retry an order submission. Re-handshake/reconnect may be used for read-only MCP calls; mutation retry behavior must be explicit and contract-tested.
- Destructive or durable actions require confirmation and should be idempotent where possible. Cancellation must handle already-cancelled/not-found/already-filled states as structured domain outcomes, not generic success.
- Default tests must use fixtures, stubs, or a local fake sidecar. Never require Alpaca/broker credentials, live orders, MLflow, public feeds, remote embeddings, or production lake data.

## Architecture tasks

1. Inventory the actual canonical TAC/book and R&D tool names and schemas from the pinned sources. Record source file and commit SHA in `docs/75-tradeac-migration.md` or a focused ADR before wiring UI calls.
2. Extend the shared browser MCP allowlist validators with exact mutation tool names and schemas. Add negative tests for arbitrary tools, SQL, URI/path, tracking-store, unknown fields, invalid decimal values, and missing confirmation-bound metadata.
3. Extend `rd-mcp-http.mjs` and any Trading 2ⁿd bridge with normalized structured errors for validation, unavailable, timeout, conflict, not-found, already-completed, backend, and ambiguous-transport outcomes.
4. Add typed API methods and DTOs. Keep API methods responsible for transport/error decoding, not business calculations.
5. Add named Tauri commands and host validators for desktop mode. Preserve per-service environment construction and process ownership.
6. Add capability/setup state for missing credentials, missing sidecar, unsupported mutation, paper-only mode, disabled scheduler, and ambiguous result. Do not render a successful mutation from an unavailable backend.
7. Add confirmation components following existing workspace/theme conventions. The UI should make the pending operation and final outcome auditable without exposing secrets.
8. Keep feature state deterministic and reload-safe. After a successful mutation, refresh through the read API rather than trusting a client-side optimistic record.
9. Update README and migration documentation with operations, ownership, env vars, paper/live limitations, confirmation semantics, and unsupported states.

## Test requirements

### Unit and contract tests

Add or update tests for:

- Exact tool and argument allowlists.
- Host validation and rejection of renderer-controlled paths, URIs, SQL, tracking stores, credentials, and executables.
- Decimal-string preservation and numeric boundary validation.
- Confirmation payload rendering and refusal when required fields are absent.
- Successful mutation with a deterministic stub.
- Validation failure, unavailable backend, timeout, process exit, conflict, not-found, already-filled/already-cancelled, and ambiguous transport outcomes.
- No automatic duplicate broker submission after timeout.
- Idempotent R&D create/update behavior where supported.
- Schedule draft versus enabled/resumed state and explicit activation confirmation.
- Secret redaction in errors and logs.

### Playwright journeys

Extend deterministic fixture-backed journeys without live credentials:

1. Trading 2ⁿd: open order form → validate fields → review exact confirmation → confirm stubbed submit → refresh/read acknowledgement → cancel → confirm cancellation → show final status.
2. Trading 2ⁿd: reject invalid order and verify no mutation tool was called.
3. Trading 2ⁿd: simulate timeout/ambiguous result and verify no automatic resubmission plus clear recovery guidance.
4. R&D: create experiment draft → validate → confirm save → create run → confirm dispatch → inspect run/result state.
5. R&D: create disabled schedule → review cadence/timezone/target → save → separately enable with confirmation → pause/disable and verify state.
6. R&D: show unavailable/unsupported state when the named write tool or persistence owner is absent.

Fixtures must intercept named MCP/HTTP requests and assert exact method/tool/argument payloads. They must not use arbitrary mock endpoints that bypass the real boundary.

## Required validation commands

Run the relevant focused tests first, then the full frontend checks:

```bash
npm run test:run -- src/api src/features/trading2 src/features/rd
npm run test:e2e:journey:trading2
npm run test:e2e:journey:rd
npm run lint
npm run build
npm run test:run
git diff --check
```

If Rust sources change, use the repository-supported Rust toolchain and run the focused tests, formatter, and clippy checks. If Python sources change:

```bash
uv sync --project modules/tac-qlib --locked
uv run --project modules/tac-qlib --locked pytest
```

The sandbox may have an incompatible default Cargo version; record that limitation accurately rather than weakening the code or tests.

Before committing, verify:

```bash
git status --short
 git diff --check
```

## Non-goals

- No authentication system or renderer-provided role model.
- No migration of production broker orders, fills, MLflow records, lake data, RiskCube cells, or TradeAC records.
- No live broker calls in tests or development defaults.
- No arbitrary SQL, shell, MCP, URI, path, executable, or database selection from the renderer.
- No RiskCube mutation or canonical OLAP implementation.
- No hidden background scheduler. A saved schedule must have explicit ownership, lifecycle, timezone, retry, disable, and failure semantics; activation is explicit.
- No automatic retry of ambiguous broker mutations.
- No broad port of TradeAC server actions without a canonical fina-builder owner and source citation.

## Completion deliverables

1. Implemented typed APIs, bridges, host/Tauri commands, capability states, and confirmation UX for the supported write operations.
2. Exact allowlist and structured-error tests, including negative security cases.
3. Deterministic Vitest and Playwright coverage for success, empty/unavailable, validation, timeout, conflict, and confirmation paths.
4. Updated `README.md`, `docs/75-tradeac-migration.md`, and an ADR if ownership or scheduler semantics change.
5. Test evidence with exact commands and results.
6. One or more focused commits with Manus attribution trailers, pushed to `origin/main` only after the working tree is clean and all applicable checks are documented.

## Suggested commit sequence

- `feat: add named trading order mutation boundary`
- `feat: add r&d experiment and schedule writes`
- `test: cover write confirmations and mutation errors`
- `docs: document phase 5 and 6 write capabilities`

Do not claim live readiness merely because fixture journeys pass. Live/paper capability, credentials, broker environment, scheduler runtime, and operational ownership must remain explicit in the final documentation.
