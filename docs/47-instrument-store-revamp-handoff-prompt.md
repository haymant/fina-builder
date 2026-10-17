# 47 — Coding hand-off prompt: instrument-store revamp

> **Status: IMPLEMENTED.** This prompt was executed on `main`; see
> `docs/46-instrument-store-revamp-plan.md` §15 for the commits, evidence and the
> corrections discovered during implementation. Kept here as the historical
> dispatch prompt.

Copy the block below into the coding agent's first message. It is self-contained;
`docs/46-instrument-store-revamp-plan.md` is the full design if more detail is
needed.

---

## HAND-OFF PROMPT (copy from here)

You are implementing the **instrument-store revamp** of the `fina-builder`
repo (`/home/data/git/haymant/fina-builder`) — a Tauri + Vite + React/TypeScript
desk that prices a worst-of Phoenix autocall through the `riga-flow` engine
(`modules/riga-flow`, a git submodule; `riga-mcp` is its MCP server).

### Goal (what "done" looks like)

1. A single canonical instrument document, `fina.instrument/v1`, owned by one
   store (`useInstrumentStore`), drives every trade-economics and market-data
   tile. Import/paste instrument JSON (`1.json`, `termsheet1.md.json`) and market
   JSON (`1.json`) and edit the whole thing with `src/components/deep-form`.
2. Every riga tile stays in sync: edit the document and every tile's numbers
   follow. Today they do not — see below.
3. The repo builds again (`npx tsc -b` is currently broken by an untracked
   component kit).

### Read first (mandatory)

- `docs/46-instrument-store-revamp-plan.md` — the full design, schema, adapter
  tables, phase plan, and acceptance tests. **Implement it; do not redesign it.**
- `src/features/riga/hooks.ts`, `src/store/rigaRequestStore.ts`,
  `src/store/rigaTradeStore.ts`, `src/store/rigaMarketStore.ts`,
  `src/features/riga/types.ts`, `src/features/riga/components/RigaTradeEconomicsPanel.tsx`,
  `src/features/riga/components/RigaMarketDataPanel.tsx`.
- `src/components/deep-form/` (the editor: `README.md`, `deep-form.tsx`,
  `context.tsx`, `hooks/use-deep-form.ts`, `types.ts`).
- `modules/riga-flow/crates/riga-mcp/src/main.rs` (param structs L55–160; handlers
  L166–620; `resolve` L993; `TOOL_SCHEMA_SHA256` L1822; frozen test L1826).
- `modules/riga-flow/crates/riga-engine/src/fixture.rs` (`LoadedFixture` L8).
- `scripts/price-instrument.mjs` (the decoders to lift).

### The bug you are fixing

`price_trade` is the only riga-mcp tool that accepts an inline `request`
(`PriceTradeParams { request: Value }`). The other **33** fixture tools take
`{ fixture_path }` (or nothing) and price
`modules/riga-flow/docs/fixture/termsheet1.json` from disk. The UI already
re-fires every tile on each edit, but they re-price that fixture — so the tiles
look desynced. Fix by adding an optional `request` to every fixture tool.

### Decisions already made — do not re-litigate

- **Sync fix = engine change.** Add `request: Option<Value>` to every fixture
  tool, falling back to `fixture_path`/default. Do **not** use temp fixture files.
- **One store, flat types derived.** `useInstrumentStore` owns the nested
  document; `RigaPhoenixTrade`/`RigaMarketSnapshot` become selectors
  (`tradeFromDocument`/`marketFromDocument`). `rigaTradeStore`/`rigaMarketStore`
  become thin write-through projections that keep their public hook names.
- **Schema = `fina.instrument/v1` + adapters** (`murexChunk@1`, `rigaFixture@1`,
  `manual`), shared by the app and `scripts/price-instrument.mjs`.
- **Adopt the whole untracked component kit** (`src/components/deep-form`,
  `src/components/data-grid`, `src/components/ui/*`, `date-range-picker.tsx`,
  `simple-icon.tsx`): add the `@` alias, `src/lib/utils.ts`, and the full
  dependency set; commit it.
- **Do NOT touch the PUT payoff arithmetic** in `note.rs`. Payoff normalisation is
  parked pending evidence. No priced number may change.

### Execute in this order (each phase = its own commit, tests green)

**P0 — Make the tree build and commit the kit.**
- Add alias `@` → `./src` in `vite.config.ts` (`resolve.alias`) and
  `paths: { "@/*": ["./src/*"] }` + `baseUrl: "."` in `tsconfig.app.json`.
- Create `src/lib/utils.ts` exporting `cn` (`clsx` + `tailwind-merge`).
- Add to `package.json`: `zod tailwind-merge class-variance-authority radix-ui
  @base-ui/react @shadcn/react @tanstack/react-table date-fns react-day-picker
  recharts cmdk sonner input-otp react-resizable-panels @dnd-kit/core
  @dnd-kit/sortable`. Commit `package.json` + `package-lock.json`.
- Gate: `npx tsc -b` == 0, `npm run build` == 0, `npx vitest run` green. Commit
  `src/components/**`, `src/lib/utils.ts`, config, deps.

**P1 — Canonical schema + adapters + `toRequest`.**
- New `src/features/riga/instrument/`: `schema.ts`, `adapters/{detect,murexChunk,rigaFixture,manual}.ts`,
  `toRequest.ts`, `validate.ts`, `selectors.ts`, `ui.ts`.
- Lift the pure decoders (`decodeDeal`, `normaliseSurface`, curve/ATM helpers) out
  of `scripts/price-instrument.mjs` into `adapters/murexChunk.ts`; re-point the
  script at `decodeMurexChunk` + `toRequest`.
- Constraint: these modules use **relative imports only** (no `@/`) and no
  non-erasable syntax, so Node's type-stripping can import them.
- Gate: capture `node scripts/price-instrument.mjs 1.json --json` and
  `… termsheet1.json --json` **before** the change; assert byte-identical after.
  Add adapter tests (`termsheet1.md.json` → PUT/COUPON/FUNDING; `1.json` → 1 PUT).

**P2 — `useInstrumentStore` + shims + request composition.**
- New `src/store/instrumentStore.ts` (state + `importText`/`importMarketText`/
  `applyDocument`/`applyMarket`/`setMarketSource`/`updateSimulation`/`reset`;
  new key `fina-instrument`; never persist the raw import).
- `applyDocument` re-imposes `source`/`unmapped` and recomputes `issues` via
  `validateDocument`.
- Repoint `rigaRequestStore.composeRigaRequest` at `toRequest(document)`; overlay
  the tac lake market only when `marketSource === 'lake'`.
- Convert `rigaTradeStore`/`rigaMarketStore` to write-through projections keeping
  their hook names. Old `localStorage` keys stay readable.
- Gate: store tests; changing the document changes the request key.

**P3 — Engine `request` param (riga-flow submodule).**
- `fixture.rs`: `Default` for `FixtureExpected`; `LoadedFixture::from_request`.
- `main.rs`: `resolve_fixture(&Option<Value>, &Option<String>)`; add
  `#[serde(default)] request: Option<Value>` to `PricePutParams`, `RiskBatchParams`,
  `ReplayPathParams`, `PathCubeParams`, `GetPathParams`, `PnlExplainParams`,
  `BookParams`, `CorpusParams`, `TapeParams`; rewrite all 33 handlers to resolve
  via `resolve_fixture`; forward `request` in `compute_risk`; handle the
  `price_book_async` task path; `price_put` with an inline request returns
  `{ result, fixture: "inline", fixture_acceptance: null }`.
- **Do not use `serde(flatten)`** (conflicts with `deny_unknown_fields`).
- Bump `TOOL_SCHEMA_SHA256` in the same commit.
- Gate: `cargo test -p riga-mcp -- --test-threads=1`; new
  `inline_request_matches_fixture` test (inline ≡ fixture for the deterministic
  tools listed in the plan §10.1). Commit the submodule and record the new SHA in
  `fina-builder`.

**P4 — UI.**
- `RigaTradeEconomicsPanel.tsx`: replace the registry grid with `<DeepForm>`
  bound to the document (`value={doc}`, `onChange={(next, ev) => applyDocument(next, ev)}`,
  schema/layout/fieldHints from `instrument/ui.ts`), header Import / Paste / Reset,
  an `issues[]` panel, and a read-only `tradeFromDocument` summary. Keep
  `useRigaTradePrice` (`price_trade`) as the sole validity authority.
- `RigaMarketDataPanel.tsx`: `source: document | lake` toggle; document lane =
  `DeepForm` over `doc.market` + Import/Paste market JSON; lake lane = existing
  tac editors. Add `sources` to `marketDataTypes.ts`.

**P5 — Request injection + reactivity.**
- `hooks.ts`: add `TOOLS_WITH_REQUEST` and inject `{ ...args, request }` in
  `useRigaTool`; pass `request` in the direct `callTool` sites (`replayRigaPath`,
  `freezeRigaBaseline`, `priceBookAsync`).
- Extend `src/features/riga/__tests__/rigaReactivity.test.tsx`: edit the document,
  assert the latest `get_ledger`/`risk_batch` mock call carries the new `request`.

**P6 — Docs + cleanup.** Update `docs/`, add the legacy-key migration note, open
scoped PRs.

### Definition of done

- `npx tsc -b` and `npm run build` exit 0.
- `npx vitest run` green; `cargo test -p riga-mcp -- --test-threads=1` green.
- `scripts/price-instrument.mjs --json` byte-identical to pre-refactor for
  `1.json` and `termsheet1.json`.
- Editing the document in the running app changes the numbers in every riga tile
  (smoke-tested with `npm run tauri:dev:cuda`).
- No change to `note.rs`; no priced number moves.

### Hard constraints

- Never stage `.env` or secrets. `.draft/` and `.env*` stay ignored.
- Do not change legacy `localStorage` keys (`fina-riga-trade`,
  `fina-riga-market`, `fina-tac-market`, …); add `fina-instrument`.
- Engine, not UI, is the validity authority — surface the structured
  `{code,message}`, never invent a UI-local rule.
- Treat initial fixings (`initspot` / `referencePrice` / `initial_fixings`) as
  P0, never as a mark; the mark is `marketData.equity[].spot`.
- `riga-flow` is a submodule: commit inside it and update the pointer in
  `fina-builder`.
- CUDA is required for `npm run tauri:dev:cuda`; engines resolve at the default
  submodule path.

### Report back

After each phase, report: files changed, the exact verification commands run, and
their output. Flag anything in the plan that turned out wrong rather than working
around it silently.

## (end of hand-off prompt)
