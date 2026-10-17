# 46 — Instrument-store revamp: detailed design & execution plan

**Status:** PLAN — approved for implementation. Supersedes the `.draft/RevampPlan1.md`
sketch (which stays local/untracked). The dispatchable prompt is
[`47-instrument-store-revamp-handoff-prompt.md`](./47-instrument-store-revamp-handoff-prompt.md).

**Scope:** the `fina-builder` Tauri/Vite app and one additive change in the
`riga-flow` submodule (`riga-mcp`). One central instrument store drives every
trade-economics and market-data tile; instrument JSON (`termsheet1.json`,
`termsheet1.md.json`) and market JSON (`1.json`) can be imported/pasted and
edited with the `src/components/deep-form` editor.

**Explicit non-goal:** the PUT payoff arithmetic in
`modules/riga-flow/crates/riga-engine/src/note.rs` is **not** touched. The
normalisation question (`PRKI2 × (WPS/StrikeKI2 − 1)`) is parked pending
decisive legacy evidence. Nothing in this plan changes a priced number.

---

## 0. Executive summary

1. **The tiles desync because the engine, not the UI, ignores the live request.**
   `price_trade` is the only tool that accepts an inline `request`. The other 33
   fixture tools take `{ fixture_path }` (or nothing) and price
   `modules/riga-flow/docs/fixture/termsheet1.json` from disk. The UI already
   re-fires every tile on each edit (`rigaRequestStore` key subscription); they
   just re-price the on-disk fixture. **Fix: add an optional `request` to every
   fixture tool**, so the engine prices what the tiles show.
2. **One store, flat types derived.** A new `useInstrumentStore` owns a single
   canonical `fina.instrument/v1` document (trade + market + simulation).
   `RigaPhoenixTrade` / `RigaMarketSnapshot` become pure selectors. The old
   `rigaTradeStore` / `rigaMarketStore` become thin, write-through projections so
   the ~15 existing tiles keep their call sites and drift becomes impossible.
3. **One canonical schema + adapters.** `fina.instrument/v1` is produced by a
   `murexChunk` adapter (`1.json`, `termsheet1.md.json`), a `rigaFixture` adapter
   (`termsheet1.json`) and a `manual` adapter (blank document / deep-form edits).
   The same module is reused by `scripts/price-instrument.mjs`, so the CLI and the
   app cannot diverge.
4. **The trade tile becomes a deep-form editor** over the document, with
   import / paste / reset and an `issues[]` surface. The market tile gains a
   `source: document | lake` toggle plus market-JSON import/paste.
5. **Build prerequisite.** The untracked component kit (`src/components/deep-form`,
   `src/components/data-grid`, `src/components/ui/*`, `date-range-picker.tsx`,
   `simple-icon.tsx`) currently breaks `tsc -b`: it uses a `@/` alias that is not
   configured, `src/lib/utils.ts` does not exist, and 15 packages are missing.
   Decision: **adopt the whole kit** — add the alias + `cn` + the full dependency
   set and commit it (Phase P0).

---

## 1. Problem statement and diagnosis (verified)

### 1.1 Root cause

Every riga tool handler in `modules/riga-flow/crates/riga-mcp/src/main.rs` loads
the fixture from disk:

```rust
// every handler except health/price_trade
let path = self.resolve(&p.fixture_path);           // -> self.default_fixture_path
match load_fixture(&path).and_then(|fx| f(&fx)) { … }
```

- `PriceTradeParams { request: Value }` (main.rs L55) — the **only** inline path.
- All others: `{ fixture_path: Option<String> }` or no relevant params, defaulting
  to `docs/fixture/termsheet1.json` (`RigaMcp::new(default_fixture_path())`).

The UI's reactivity is already correct: `rigaRequestStore.composeRigaRequest()`
(L16) recomputes the request, the stable key `JSON.stringify(request)` (L42)
changes, and every `useRigaTool` re-runs. But for 33 of 35 tools the call carries
no request, so the returned numbers are the fixture's, not the edited trade's.

### 1.2 Confirmed tool inventory (35 frozen names)

Source of truth: `tool_surface_is_frozen` (main.rs L1826) + `TOOL_SCHEMA_SHA256`
(L1822) + the `#[tool_router] impl` (L166–620).

| # | Tool | Param struct | Needs `request` |
|---:|---|---|:--:|
| 1 | `health` | — | no |
| 2 | `price_trade` | `PriceTradeParams` (`request` already) | yes (present) |
| 3 | `price_put` | `PricePutParams` | yes |
| 4 | `explain_pv_attribution` | `PricePutParams` | yes |
| 5 | `replay_path` | `ReplayPathParams` | yes |
| 6 | `query_path_cube` | `PathCubeParams` | yes |
| 7 | `query_pathcube` | `PathCubeParams` | yes |
| 8 | `risk_batch` | `RiskBatchParams` | yes |
| 9 | `list_markets` | `PricePutParams` | yes |
| 10 | `get_market` | `PricePutParams` | yes |
| 11 | `generate_paths` | `PricePutParams` | yes |
| 12 | `get_path` | `GetPathParams` | yes |
| 13 | `get_branch_stats` | `PricePutParams` | yes |
| 14 | `get_distributions` | `PricePutParams` | yes |
| 15 | `get_mc_diagnostics` | `PricePutParams` | yes |
| 16 | `build_cashflows` | `PricePutParams` | yes |
| 17 | `execution_events` | `TapeParams` | yes |
| 18 | `compute_risk` | `PricePutParams` (alias → `risk_batch`) | yes |
| 19 | `compute_book_risk` | `BookParams` | yes |
| 20 | `price_book` | `BookParams` | yes |
| 21 | `price_book_async` | `BookParams` | yes |
| 22 | `pl_explain` | `PnlExplainParams` | yes |
| 23 | `get_ledger` | `PricePutParams` | yes |
| 24 | `query_execution_net` | `PricePutParams` | yes |
| 25 | `query_risk_net` | `PricePutParams` | yes |
| 26 | `validate_greeks` | `PricePutParams` | yes |
| 27 | `recommend_scenarios` | `PricePutParams` | yes |
| 28 | `root_cause` | `PricePutParams` | yes |
| 29 | `export_governance_evidence` | `PricePutParams` | yes |
| 30 | `freeze_baseline` | `CorpusParams` | yes |
| 31 | `compare_corpus` | `CorpusParams` | yes |
| 32 | `triage_regression` | `CorpusParams` | yes |
| 33 | `estimate_aad_greeks` | `PricePutParams` (ignored body) | yes (harmless) |
| 34 | `valuation_explain` | `PnlExplainParams` | yes |
| 35 | `scenario` | `PricePutParams` | yes |

`compute_risk` forwards `p.fixture_path` into `RiskBatchParams` (L405) and must
forward `p.request` too. `price_book_async` has a second path in
`call_tool` (main.rs ~L858) that reads `self.default_fixture_path` and builds a
task; it must read the request as well.

Resources (`resource_list` / `read_resource_value` / `resource_text`, L873–922)
are a separate surface and stay fixture-only. Documented, out of scope.

---

## 2. Target architecture

```
                 import/paste JSON (1.json, termsheet1.md.json, termsheet1.json)
                        │
                        ▼
        ┌───────────────────────────────────────────────┐
        │  detectAdapter → murexChunk | rigaFixture | manual
        └───────────────────────────────────────────────┘
                        │ InstrumentDocument (fina.instrument/v1)
                        ▼
        ┌───────────────────────────────────────────────┐
        │  useInstrumentStore  (single source of truth)  │
        │  document · marketSource · import/apply/reset  │
        └───────────────────────────────────────────────┘
             │ selectors                     │ projections (write-through)
             ▼                               ▼
   tradeFromDocument/marketFromDocument   useRigaTradeStore
   toRequest(doc) → RigaPriceRequest      useRigaMarketStore  (shims)
             │
             ▼
   rigaRequestStore.composeRigaRequest()  → stable key
             │
             ▼
   useRigaTool(tool, …)  ── injects { request } for TOOLS_WITH_REQUEST
             │
             ▼
   riga-mcp  resolve_fixture(request|fixture_path)  → every tile follows the doc
```

---

## 3. Canonical document — `fina.instrument/v1`

New module `src/features/riga/instrument/`.

### 3.1 `schema.ts`

```ts
export const INSTRUMENT_SCHEMA = 'fina.instrument/v1' as const
export type InstrumentSchemaId = typeof INSTRUMENT_SCHEMA

export interface InstrumentDocument {
  schema: InstrumentSchemaId
  source: InstrumentSource
  meta: InstrumentMeta
  legs: InstrumentLeg[]
  market: InstrumentMarket
  simulation: InstrumentSimulation
  /** Adapter findings — never silently dropped, always shown. */
  issues: InstrumentIssue[]
  /** Source paths deliberately not mapped, carried verbatim for inspection. */
  unmapped: UnmappedEntry[]
}

export interface InstrumentSource {
  kind: 'murex-chunk' | 'riga-fixture' | 'manual'
  adapter: 'murex-chunk@1' | 'riga-fixture@1' | 'manual'
  fileName: string | null
  importedAt: string | null      // ISO; UI-only, never sent to the engine
  rawHash: string | null         // sha256 hex of the raw import text
}

export interface InstrumentMeta {
  name: string | null            // dealData.instrumentName / fixture name
  template: string | null        // dealData.productTemplate (e.g. ELIFCN_KI)
  product: string | null         // instrument.product
  currency: string | null        // dealData.paymentCurrency
  notional: number | null
  multiplier: number | null
  systemDate: string | null      // ISO; extractedSystemDate ?? systemDate
  tradeDate: string | null       // ISO; initialFixingDate / initial_fixings date
  expiryDate: string | null      // ISO
  maturityDate: string | null    // ISO
  lastFixingDate: string | null  // ISO (0 serial ⇒ null)
}

export type InstrumentLegKind = 'put' | 'coupon' | 'funding' | 'unknown'

export interface InstrumentLeg {
  id: string                     // legName ("PUT"/"COUPON"/"FUNDING") or "leg{n}"
  legId: number | null
  kind: InstrumentLegKind
  /** riga-engine prices the put leg only; exactly one leg is true. */
  pricedByEngine: boolean
  put?: PutTerms
  coupon?: CouponTerms
  funding?: FundingTerms
  extras: Record<string, unknown>   // the whole dealData minus mapped keys
}

export interface PutTerms {
  initialSpots: number[]         // P0, per factor — NOT the spot mark
  strike: number                 // engine `strike` (fraction of initial)
  knockInBarrier: number         // KIBarrier
  knockInType: string            // "EKI" | "AKI" | …
  knockOutKind: 'global' | 'local' | 'none'
  knockOutBarrier: number | null
  koLocked: boolean[]            // GKOLocked
  koDates: Array<string | null>  // GKODate serial → ISO (0 ⇒ null)
  couponBarrier: number | null
  couponRate: number | null
  memoryCoupon: boolean
  couponPeriods: number | null
  fixedFirstCoupon: boolean
  maturityYears: number          // (expiryDate − asOf) / 365
  steps: number                  // observation dates (adapter derives or carries)
  callStartStep: number | null
  rails: PhoenixRails            // knockInStar verbatim + named fields
}

export interface PhoenixRails {
  choice: string
  lowCallStrik: number
  strikeUp: number; PRUp: number
  capUp: boolean; capUpVal: number; floorUp: boolean; floorUpVal: number
  strikeKI1: number; capKI1: boolean; capKI1Val: number; floorKI1: boolean; floorKI1Val: number; PRKI1: number
  strikeKI2: number; capKI2: boolean; capKI2Val: number; floorKI2: boolean; floorKI2Val: number; PRKI2: number
  strike1NOKI: number; strike2NOKI: number
  capForNOKI: boolean; capValNOKI: number; floorForNOKI: boolean; flrValNOKI: number; PRNOKI1: number; PRNOKI2: number
  KIBarrier: number
  maturBarrier: number
  obvDate: number[]; paymentDate: number[]
  knockIn: boolean
  raw: Record<string, unknown>   // the entire knockInStar object, unmodified
}

export interface CouponTerms {
  accrualRate: number[]          // RGACCLKO.accruRate
  accrualDates: number[]         // RGACCDate
  lowRange: number
  upRange: number
  gblBarPrice: number | null
  startDate: number[]; endDate: number[]
  fixCoupon: number[]
  raw: Record<string, unknown>
}

export interface FundingTerms {
  notionalReturn: boolean        // KIKOSelect.notionalReturn
  returnRatio: number            // KIKOSelect.returnRatio
  raw: Record<string, unknown>
}

export interface InstrumentMarket {
  asOf: string                   // ISO evaluation date; never the wall clock
  symbols: string[]
  initialFixings: number[]       // P0 per factor (may equal spots when unpinned)
  spots: number[]                // current marks
  vols: number[]                 // flat ATM (derived from the surface at the ATM strike)
  dividendYields: number[]
  correlation: number[][]
  discountCurve: InstrumentCurve | null
  localVol: InstrumentVolSurface[]   // one Dupire grid per factor (may be empty)
  raw: Record<string, unknown>   // the entire marketData block, verbatim
}

export interface InstrumentCurve {
  id: string
  dayCount: string
  asOf: string | null
  pillars: Array<{ date: string; rate: number; tenor: string | null }>
}

export interface InstrumentVolSurface {
  underlying: string
  maturitiesYears: number[]
  strikes: number[]
  vols: number[][]               // [nMaturity][nStrike], vol fractions
  reference: number | null       // calibration reference (absolute strike anchor)
  rawRef: unknown
}

export interface InstrumentSimulation {
  paths: number
  pathBlockSize: number
  seed: number
  traceLevel: RigaTraceLevel
  aad: boolean
  varianceReduction: RigaSimulationConfig['varianceReduction']
}

export interface InstrumentIssue {
  severity: 'info' | 'warn' | 'error'
  code: string                   // e.g. 'engine.unsupported_rail', 'market.missing_curve'
  path: string                   // JSON pointer into THIS document
  message: string
  sourcePath?: string            // JSON pointer into the raw import
}

export interface UnmappedEntry {
  sourcePath: string             // JSON pointer in the raw import
  reason: string
  value: unknown
}
```

### 3.2 Conventions

- **JSON pointers** everywhere (deep-form uses them).
- **Dates are ISO `YYYY-MM-DD`** in the document; Excel serials are converted at
  the adapter boundary. `0` serial ⇒ `null`.
- **`initialFixings` is P0**, never a mark. `spots` is the mark. The UI must
  label them "Initial fixing" / "Spot (mark)" and never conflate them.
- **`raw` / `extras` / `unmapped`** carry the source verbatim; the engine never
  reads them.
- All adapters must be **pure** (no I/O, no `node:` imports) and must not use the
  `@/` alias (see §9.1) so `scripts/price-instrument.mjs` can import them.

---

## 4. Adapters

`src/features/riga/instrument/adapters/`

### 4.1 `detectAdapter(raw) → AdapterId | null`

```
raw?.Chunk?.Jobs   instanceof Array                      → 'murex-chunk@1'
raw?.trade_economics && raw?.market_data                 → 'riga-fixture@1'
otherwise                                                → null (manual / error)
```

`importText` then dispatches to `decodeMurexChunk(raw)` or `decodeRigaFixture(raw)`.

### 4.2 `murexChunk.ts` — the Murex dialect (`1.json`, `termsheet1.md.json`)

Source paths are lifted from `scripts/price-instrument.mjs` `decodeDeal` (L62)
and `marketFromFile` (L195). The PUT leg is the priced leg; its job's
`marketData` is the market.

| Document field | Source path |
|---|---|
| `meta.name` | `Chunk.Jobs[i].commonData.dealData.instrumentName` |
| `meta.template` | `…dealData.productTemplate` |
| `meta.currency` | `…dealData.paymentCurrency` |
| `meta.notional` | `…dealData.notional` |
| `meta.multiplier` | `…dealData.multiplier` |
| `meta.systemDate` | `…dealData.extractedSystemDate ?? …dealData.systemDate` |
| `meta.tradeDate` | `…dealData.KIKOSelect.initialFixDate` (serial→ISO) |
| `meta.expiryDate` | `…dealData.expiryDate` (serial→ISO) |
| `meta.maturityDate` | `…dealData.maturityDate` (serial→ISO) |
| `meta.lastFixingDate` | `…dealData.lastFixingDate` (0 ⇒ null) |
| `legs[].id`/`legId`/`kind` | `…dealData.legName` / `…dealData.legId` |
| `put.initialSpots` | `…dealData.KIKOSelect.referencePrice[]` |
| `put.strike` | `…dealData.strike` |
| `put.knockInBarrier` / `knockInType` | `…dealData.knockInStar.KIBarrier` / `…KIKOSelect.knockInType` |
| `put.knockOutKind` | `…KIKOSelect.globalKO ? 'global' : 'local'` (both false ⇒ `'none'`) |
| `put.koLocked` / `koDates` | `…KIKOSelect.GKOLocked[]` / `…KIKOSelect.GKODate[]` |
| `put.rails` | `…dealData.knockInStar` (verbatim `raw` + named fields) |
| `coupon` | `…dealData.RGACCLKO`, `…dealData.RGACCDate` |
| `funding` | `…dealData.KIKOSelect.notionalReturn`, `…returnRatio` |
| `market.asOf` | `…commonData.marketData.evaluationDate` (serial→ISO) |
| `market.symbols` | `…marketData.equity[].name` (fallback `…dealData.KIKOSelect.underlying[]`) |
| `market.spots` | `…marketData.equity[].spot` |
| `market.dividendYields` | `…marketData.equity[].divYield` |
| `market.correlation` | `…marketData.corr[].matrix` |
| `market.discountCurve` | `…marketData.discCurves[]` (pick the USD standard curve) |
| `market.localVol` | `…marketData.eqVol[]` (`normaliseSurface`) |
| `market.vols` | ATM read of each `eqVol` surface |
| `simulation.paths` | `…marketData.MCPara.numPaths` |
| `simulation.seed` | `…marketData.MCPara.seed` (default 1729 when absent) |

**Issues to raise** (examples, not exhaustive):
- `knockInStar.PRUp !== 0` or `capKI2/floorKI2/PRKI1/PRNOKI*` non-default ⇒
  `engine.unsupported_rail` (the engine models a subset).
- `marketData` absent on the priced job ⇒ `market.missing` (error).
- `lastFixingDate` in the past ⇒ `info` lifecycle note.

**Unmapped**: `Jobs[i].Tasks[]`, `_id`, `_class`, `EQDPosition`, `addInfo`,
`docCreatedOn/UpdatedOn`, `createdDatetime/updatedDatetime`, and every `marketData`
sub-block not otherwise mapped.

### 4.3 `rigaFixture.ts` — `termsheet1.json`

| Document field | Source path |
|---|---|
| `meta.name` | `fixture` |
| `put.*` | `trade_economics.*` (already engine-shaped) |
| `market.asOf` | `market_data.as_of` |
| `market.initialFixings` | `market_data.initial_fixings` |
| `market.spots` | `market_data.initial_fixings` (the fixture has no separate mark) |
| `market.correlation` | `market_data.correlation.matrix` |
| `market.dividendYields` | `market_data.dividend_yields` |
| `market.discountCurve` | `market_data.discount_curve` |
| `market.localVol` | `market_data.local_vol_surfaces` |
| `market.vols` | ATM read of `market_data.vol_surfaces` |
| `simulation.*` | `run.*` |
| `unmapped` | `expected`, `provenance`, `model`, `human_readable_twin`, `authoritative_spec`, `purpose`, `source`, … |

`expected` / `provenance` are acceptance metadata, **not** engine input; they go
to `unmapped` (display-only). This preserves the fixture as the golden anchor.

### 4.4 `manual.ts`

`blankDocument()` returns a `fina.instrument/v1` with the current `termsheet1.json`
shape as defaults (so the tile is never empty) and `source.kind = 'manual'`.

---

## 5. `toRequest(doc) → RigaPriceRequest`

`src/features/riga/instrument/toRequest.ts` — pure, engine-faithful:

```ts
export function toRequest(doc: InstrumentDocument): RigaPriceRequest {
  const put = doc.legs.find((l) => l.kind === 'put' && l.put)?.put
  if (!put) throw new InstrumentError('engine.no_put_leg', 'the document has no put leg')
  return {
    trade: {
      tradeId: doc.meta.name ?? doc.source.fileName ?? 'instrument',
      initialSpots: put.initialSpots,
      maturityYears: put.maturityYears,
      steps: put.steps,
      strike: put.strike,
      knockInBarrier: put.knockInBarrier,
      knockOutBarrier: put.knockOutBarrier,
      couponBarrier: put.couponBarrier,
      couponRate: put.couponRate,
      memoryCoupon: put.memoryCoupon,
      couponPeriods: put.couponPeriods,
      fixedFirstCoupon: put.fixedFirstCoupon,
      callStartStep: put.callStartStep,
    },
    market: {
      asOf: doc.market.asOf,
      spots: doc.market.spots,
      vols: doc.market.vols,
      riskFreeRate: rateAt(doc.market.discountCurve, put.maturityYears),
      dividendYields: doc.market.dividendYields,
      correlation: doc.market.correlation,
    },
    config: {
      paths: doc.simulation.paths,
      pathBlockSize: doc.simulation.pathBlockSize,
      seed: doc.simulation.seed,
      traceLevel: doc.simulation.traceLevel,
      varianceReduction: doc.simulation.varianceReduction,
    },
    asOf: doc.market.asOf,
    localVol: doc.market.localVol.length ? { grids: doc.market.localVol.map(toGrid) } : undefined,
  }
}
```

- `riskFreeRate` = interpolated zero from `discountCurve` at `maturityYears`
  (fallback: `discountCurve.pillars[0].rate`, then `0`).
- `toGrid(surface)` ⇒ `RigaImpliedVolGrid` (already the engine's shape).
- **Byte-parity requirement:** `toRequest(decodeMurexChunk(1.json))` must equal
  the request `scripts/price-instrument.mjs` produced **before** the refactor.
  Pin with a golden test (§8 P1).

---

## 6. Central store — `useInstrumentStore`

`src/store/instrumentStore.ts`

```ts
export type MarketSource = 'document' | 'lake'

export interface ImportOutcome {
  ok: boolean
  adapter?: InstrumentSource['adapter']
  issues: InstrumentIssue[]
  error?: string
}

interface InstrumentState {
  document: InstrumentDocument
  marketSource: MarketSource
  /** Lake/manual local-vol toggle (only read when marketSource === 'lake'). */
  useSurfaceLocalVol: boolean
  /** Manual Dupire grid (lake lane); the document lane uses document.market.localVol. */
  manualLocalVol: RigaImpliedVolGrid | null
  lastImport: ImportOutcome | null

  importText: (text: string, fileName?: string) => ImportOutcome
  importMarketText: (text: string, fileName?: string) => ImportOutcome   // replaces document.market only
  applyDocument: (next: DeepFormValue, event?: DeepFormChangeEvent) => void
  applyMarket: (next: DeepFormValue, event?: DeepFormChangeEvent) => void
  setMarketSource: (s: MarketSource) => void
  updateSimulation: (patch: Partial<InstrumentSimulation>) => void
  setUseSurfaceLocalVol: (v: boolean) => void
  setManualLocalVol: (g: RigaImpliedVolGrid | null) => void
  reset: () => void
}
```

**Persistence:** a new key `fina-instrument` (do not touch the legacy keys
`fina-riga-trade` / `fina-riga-market`; keep them loadable for one release).
`importText` is **not** persisted verbatim (documents can be large); persist the
document and `source.rawHash`, not the raw text.

**`applyDocument`** must be defensive:

```ts
function normalise(next: DeepFormValue, prev: InstrumentDocument): InstrumentDocument {
  const doc = next as InstrumentDocument
  return {
    ...doc,
    schema: INSTRUMENT_SCHEMA,
    source: prev.source,                 // provenance is not user-editable
    unmapped: prev.unmapped,             // source provenance
    issues: validateDocument(doc),        // recompute findings on every edit
  }
}
```

`validateDocument` is pure and produces the `issues[]` the tile shows.

### 6.1 Selectors (pure)

`src/features/riga/instrument/selectors.ts`

```ts
export function tradeFromDocument(doc): RigaPhoenixTrade
export function marketFromDocument(doc): RigaMarketSnapshot
export function simulationFromDocument(doc): RigaSimulationConfig
export function localVolGridsFromDocument(doc): RigaImpliedVolGrid[] | null
```

### 6.2 Legacy shims (no drift)

- `src/store/rigaTradeStore.ts` → `useRigaTradeStore(selector)` now selects over a
  projection of `useInstrumentStore`; `updateTrade(patch)` maps a flat field to the
  document pointer and calls `applyDocument`. The public hook name and signature
  are unchanged, so `RigaTradeEconomicsPanel` / `rigaRequestStore` / tests keep
  compiling.
- `src/store/rigaMarketStore.ts` → same pattern for `market` / `simulation`;
  keeps `localVol` / `useSurfaceLocalVol` as the lake-lane fields (now backed by
  the instrument store).
- Both files carry a header: **"PROJECTION — write through `useInstrumentStore`."**

### 6.3 Request composition

`src/store/rigaRequestStore.ts`:

```ts
export function composeRigaRequest(): RigaPriceRequest {
  const score = useInstrumentStore.getState()
  const base = toRequest(score.document)                       // document lane (default)
  if (score.marketSource === 'lake') {
    const tac = useTacMarketStore.getState()
    const effective = applyManipulations(tac.raw, tac.manipulations)
    base.market = effectiveRigaMarket(base.market, effective)  // overlay lake data
    const grids = score.useSurfaceLocalVol
      ? localVolGridsFromTac(effective)
      : score.manualLocalVol ? [score.manualLocalVol, score.manualLocalVol] : null
    base.localVol = grids ? { grids } : base.localVol
  }
  base.config.traceLevel = currentTraceLevel()
  return base
}
```

The `key` stays `JSON.stringify(request)`; the subscription (module-scope, L70)
now also subscribes to `useInstrumentStore`.

---

## 7. Frontend wiring (tiles follow the request)

### 7.1 Inject `request` for every fixture tool

`src/features/riga/hooks.ts`:

```ts
/** Every tool whose param struct now carries an optional `request`. */
const TOOLS_WITH_REQUEST = new Set<string>([
  'price_put','explain_pv_attribution','replay_path','query_path_cube','query_pathcube',
  'risk_batch','list_markets','get_market','generate_paths','get_path','get_branch_stats',
  'get_distributions','get_mc_diagnostics','build_cashflows','execution_events','compute_risk',
  'compute_book_risk','price_book','price_book_async','pl_explain','get_ledger',
  'query_execution_net','query_risk_net','validate_greeks','recommend_scenarios','root_cause',
  'export_governance_evidence','freeze_baseline','compare_corpus','triage_regression',
  'estimate_aad_greeks','valuation_explain','scenario',
])

function useRigaTool<T>(tool, buildArgs, options = {}) {
  const key = useRigaRequestStore((s) => s.key)
  const request = useRigaRequestStore((s) => s.request)
  const level = useObservabilityStore((s) => s.level)
  …
  riga.callTool<T>(tool, TOOLS_WITH_REQUEST.has(tool) ? { ...toObject(buildArgs()), request } : buildArgs())
}
```

Direct `callTool` sites must also pass `request`:

- `replayRigaPath` (hooks.ts L146)
- `freezeRigaBaseline` (L227)
- `priceBookAsync` (L236)

`health` is excluded (no params). `price_trade` already sends `{ request }`.

### 7.2 Trade tile — `RigaTradeEconomicsPanel.tsx`

Replace the `PRODUCT_TYPES` field grid with the deep-form editor:

```tsx
const doc = useInstrumentStore((s) => s.document)
const applyDocument = useInstrumentStore((s) => s.applyDocument)
const importText = useInstrumentStore((s) => s.importText)

<DeepForm
  value={doc as unknown as DeepFormValue}
  onChange={(next, event) => applyDocument(next, event)}
  schema={INSTRUMENT_JSON_SCHEMA}
  layout={INSTRUMENT_LAYOUT}          // groups: Identity, Underlyings, Barriers,
  fieldHints={INSTRUMENT_FIELD_HINTS} //   Payoff rails, Coupon, Funding, Market,
  defaultExpandedDepth={2}            //   Simulation, Provenance(ro), Issues(ro)
  title="Instrument"
  description={doc.source.adapter}
  headerActions={<InstrumentImportActions />}   // Import file · Paste · Reset
/>
```

- Keep `useRigaTradePrice` (`price_trade`) as the authority panel; it now follows
  the document. Invalid combinations still surface the engine's `{code,message}`;
  never add a UI-local validity rule.
- Render `doc.issues[]` (severity chip + pointer + message) and the derived
  `tradeFromDocument(doc)` summary read-only.
- `INSTRUMENT_JSON_SCHEMA`, `INSTRUMENT_LAYOUT`, `INSTRUMENT_FIELD_HINTS` are
  hand-written in `src/features/riga/instrument/ui.ts` (no new schema-gen dep).
  Use `x-unit`/`x-display-scale` so rates/vols/correlations render as percentages.

### 7.3 Market tile — `RigaMarketDataPanel.tsx`

- Header toggle `source: document | lake`
  (`useInstrumentStore.setMarketSource`).
- **document** lane: a second `DeepForm` bound to `doc.market`
  (`onChange={(next, ev) => applyMarket(next, ev)}`), plus Import / Paste market
  JSON (`importMarketText`, supports `1.json`), plus a read-only summary
  (asOf, symbols, initial fixings vs spots, corr, curve pillars, surfaces count).
- **lake** lane: the existing tac-backed editors (`useTacMarketStore`,
  `applyManipulations`, `volSurfaceWarnings`, `effectiveRigaMarket`,
  `localVolGridsFromTac`) unchanged, plus the local-vol toggle.
- The registry `src/features/riga/marketDataTypes.ts` gains
  `sources: Array<'document' | 'lake' | 'manual'>` per entry so the panel can
  badge where each field came from.

### 7.4 Other tiles

No tile code changes: they call `useRigaX()` hooks, which now inject `request`.
The `RigaMarketSnapshotTile` (`useRigaMarket` → `get_market`) will finally show
the document's market.

---

## 8. Engine change (riga-flow submodule)

`modules/riga-flow/crates/riga-engine/src/fixture.rs`:

```rust
#[derive(Debug, Clone, Default)]
pub struct FixtureExpected { /* … */ }   // add Default

impl LoadedFixture {
    /// Wrap an inline `PriceRequest` (no on-disk fixture). Provenance/acceptance
    /// are absent, so derived fields are neutral and `expected` is Default.
    pub fn from_request(request: PriceRequest) -> Self {
        let engine_model = if request.local_vol.is_some() {
            "dupire_local_vol_inline".to_string()
        } else {
            "gbm_flat_atm_proxy_inline".to_string()
        };
        Self {
            name: request.trade.trade_id.clone(),
            request,
            expected: FixtureExpected::default(),
            market_provenance: "inline request".into(),
            market_is_pinned: false,
            market_quality_note: "Inline request (no pinned fixture)".into(),
            source_model: engine_model.clone(),
            engine_model,
        }
    }
}
```

`modules/riga-flow/crates/riga-mcp/src/main.rs`:

```rust
/// Resolve the fixture a tool prices: an inline `request` when supplied, else
/// the on-disk fixture (explicit `fixture_path`, else the default).
fn resolve_fixture(
    &self,
    request: &Option<Value>,
    fixture_path: &Option<String>,
) -> Result<riga_engine::fixture::LoadedFixture, ToolError> {
    if let Some(value) = request {
        let request: riga_engine::PriceRequest = serde_json::from_value(value.clone())
            .map_err(|e| ToolError::new("request_parse", e.to_string()))?;
        return Ok(riga_engine::fixture::LoadedFixture::from_request(request));
    }
    load_fixture(&self.resolve(fixture_path))
}
```

Then, uniformly:

```rust
let fx = match self.resolve_fixture(&p.request, &p.fixture_path) {
    Ok(fx) => fx, Err(e) => return structured_error(e.code, e.message),
};
match price_put_leg(&fx.request) …          // helpers already take &LoadedFixture
```

Param structs — add to each (`#[serde(deny_unknown_fields)]` accepts declared
fields; **do not** use `#[serde(flatten)]`, which conflicts with
`deny_unknown_fields`):

```rust
    /// Optional inline PriceRequest. When present it overrides `fixture_path`.
    #[serde(default)]
    request: Option<Value>,
```

- `PricePutParams` (covers 20 tools), `RiskBatchParams`, `ReplayPathParams`,
  `PathCubeParams`, `GetPathParams`, `PnlExplainParams`, `BookParams`,
  `CorpusParams`, `TapeParams`.
- `PriceTradeParams` keeps `request: Value` (already required).
- `compute_risk` forwards `request: p.request`.
- `price_book_async` task branch (main.rs ~L858): capture `p.request` and pass it
  into `run_book_task` (change its signature from `PathBuf` to `LoadedFixture`,
  resolving before spawn). Also handle `price_book_async` when it arrives as a
  resource/provider call (`call_tool` path) — resolve there too.
- `price_put` with an inline request returns
  `{ "result": …, "fixture": "inline", "fixture_acceptance": null }`; from disk it
  is unchanged. `useRigaPrice` (the connect test) never sends a request, so the
  acceptance round-trip is untouched.
- **Bump `TOOL_SCHEMA_SHA256`** (main.rs L1822) in the same commit — the added
  optional field changes the advertised input schemas. Compute by running the
  frozen test and copying the printed digest.

**Deliberately out of scope:** resources (`riga://…`), prompts, the payload
arithmetic in `note.rs`.

---

## 9. Build integration (Phase P0)

_Do this first: `npx tsc -b` is currently red because of the untracked kit._

### 9.1 `@` alias

- `vite.config.ts` `resolve.alias`: add `{ find: /^@\//, replacement: `${rootSrc}/` }`
  where `rootSrc = new URL('./src', import.meta.url).pathname`.
- `tsconfig.app.json` `compilerOptions`: add
  `"baseUrl": "."`, `"paths": { "@/*": ["./src/*"] }`.

**Constraint:** `src/features/riga/instrument/**` must use **relative** imports
only (no `@/`), because `scripts/price-instrument.mjs` imports it under Node's
type-stripping, which does not resolve tsconfig `paths`.

### 9.2 `src/lib/utils.ts` (new)

```ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

### 9.3 Dependencies (add to `package.json`)

```
zod tailwind-merge class-variance-authority
radix-ui @base-ui/react @shadcn/react @tanstack/react-table
date-fns react-day-picker recharts cmdk sonner input-otp
react-resizable-panels @dnd-kit/core @dnd-kit/sortable
```

`clsx` and `lucide-react` are already present. Pin to the versions npm resolves
(current majors) and commit `package.json` + `package-lock.json`.

### 9.4 Exit criteria for P0

- `npx tsc -b` exits 0.
- `npm run build` exits 0.
- `npx vitest run` green (the kit's own tests included).
- Commit the kit (`src/components/**`, `src/lib/utils.ts`, config, deps).
- `.gitignore` keeps ignoring `.draft` and `.env*`.

---

## 10. Execution plan (phases)

Dependencies: `P1 → P2 → {P3, P4}`; `P0` first; `P0` and `P1` are disjoint and
can run in parallel. Every phase ends with its own green tests and a scoped
commit.

| Phase | Deliverable | Depends on | Exit criteria |
|---|---|---|---|
| **P0** | Build integration + kit committed | — | `tsc -b`, `npm run build`, `vitest` all green; kit committed |
| **P1** | `fina.instrument/v1` schema + `murexChunk`/`rigaFixture`/`manual` adapters + `toRequest` + `validateDocument`; re-point `scripts/price-instrument.mjs` | — | adapter tests; CLI `--json` byte-identical to pre-refactor for `1.json` and `termsheet1.json` |
| **P2** | `useInstrumentStore` + selectors + legacy shims + `composeRigaRequest` repointed | P1 | store tests; `rigaRequestStore` key changes when the doc changes |
| **P3** | Engine `request` param on 33 tools + `LoadedFixture::from_request` + `resolve_fixture` + SHA bump | P0 | `cargo test -p riga-mcp` incl. inline-vs-fixture equivalence; SHA updated |
| **P4** | UI: deep-form trade tile + import/paste/issues; market tile source toggle + import/paste | P0, P2 | component tests; manual smoke in `npm run tauri:dev:cuda` |
| **P5** | `useRigaTool` `request` injection + direct call sites; reactivity tests | P1, P3 | `rigaReactivity.test.tsx`: edit → every fixture tile receives the new `request` |
| **P6** | Docs, provenance badges, cleanup, PRs | P0–P5 | docs updated; legacy-key migration note; PRs merged |

### 10.1 Task detail — the critical path

**P1**
1. `instrument/schema.ts`, `instrument/adapters/{detect,murexChunk,rigaFixture,manual}.ts`,
   `instrument/toRequest.ts`, `instrument/validate.ts`.
2. Lift `decodeDeal`/`normaliseSurface`/`marketFromFile`(pure parts) out of
   `scripts/price-instrument.mjs` into `murexChunk.ts`; keep the lake/stdio parts
   in the script.
3. `scripts/price-instrument.mjs` becomes:
   `const raw = JSON.parse(text); const doc = decodeMurexChunk(raw); const request = toRequest(doc)`.
   Import via relative `.ts` specifiers (Node ≥ 23.6 strips types; repo runs Node 24).
4. Golden test: capture `node scripts/price-instrument.mjs 1.json --json` and
   `… termsheet1.json --json` **before** the change; assert byte-identical after.

**P3**
1. `fixture.rs`: `Default` on `FixtureExpected`, `LoadedFixture::from_request`.
2. `main.rs`: `resolve_fixture`, add `request` to 8 structs, rewrite 33 handlers,
   forward in `compute_risk`, handle `price_book_async` task path, bump SHA.
3. Test `inline_request_matches_fixture`: for each fixture tool, build the fixture's
   `request` value (from `load_fixture(...).request`), call the tool twice (fixture
   vs inline) and assert equal `structuredContent` for the deterministic tools
   (`get_ledger`, `explain_pv_attribution`, `query_execution_net`, `query_risk_net`,
   `risk_batch`, `scenario`, `validate_greeks`, `get_branch_stats`,
   `get_distributions`, `get_mc_diagnostics`, `build_cashflows`, `pl_explain`,
   `valuation_explain`, `recommend_scenarios`, `root_cause`,
   `export_governance_evidence`, `compare_corpus`, `triage_regression`).
   Note: `freeze_baseline` is stateful (skip equality, assert non-error).

**P5**
Extend `src/features/riga/__tests__/rigaReactivity.test.tsx`: mock
`riga.callTool`, edit `document.legs[0].put.strike`, advance debounce, assert the
latest `get_ledger`/`risk_batch` mock call carries
`args.request.trade.strike === newValue`.

---

## 11. Acceptance tests

| Layer | Test | Command |
|---|---|---|
| Adapters | `termsheet1.md.json` → PUT/COUPON/FUNDING legs; `1.json` → 1 PUT leg; issues raised for unsupported rails | `npx vitest run src/features/riga/instrument` |
| CLI parity | `toRequest(decodeMurexChunk(x))` ≡ pre-refactor `price-instrument --json` | same |
| Store | `importText` both docs; `applyDocument` recomputes `issues`; `tradeFromDocument` round-trips | `npx vitest run src/store` |
| Engine | inline `request` ≡ fixture path for 18 deterministic tools | `cargo test -p riga-mcp -- --test-threads=1` |
| Engine contract | `tool_surface_is_frozen` passes with the bumped SHA | same |
| Reactivity | doc edit → every fixture tool receives the new request | `npx vitest run src/features/riga` |
| Build | typecheck + bundle | `npx tsc -b && npm run build` |
| Smoke | trade tile edits reprice all tiles; market paste updates the snapshot; import `1.json` then `termsheet1.md.json` | `npm run tauri:dev:cuda` |

**Cross-document acceptance:** `1.json` and `termsheet1.md.json` both decode to a
valid `fina.instrument/v1` and both produce a `price_trade` call that returns a
structured result (not `{code,message}`). This proves the adapter handles two
Murex dialects plus the riga fixture with one schema.

---

## 12. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Engine SHA bump breaks CI | high (expected) | Bump `TOOL_SCHEMA_SHA256` in the same P3 commit; run `cargo test -p riga-mcp -- --test-threads=1` |
| `serde(flatten)` + `deny_unknown_fields` | n/a | Declare `request` explicitly on each struct; never flatten |
| Node type-stripping can't import the shared `.ts` | low (Node 24) | Relative `.ts` specifiers, no `@/`, no non-erasable syntax (`erasableSyntaxOnly` already on); fallback is `tsx`/esbuild only if a CI Node < 23.6 appears |
| Adapter drifts from the legacy decoder (CLI numbers move) | medium | Golden byte-identical test captured before the refactor |
| Deep-form edits the derived `issues`/`source` | medium | `applyDocument` re-imposes `source`/`unmapped` and recomputes `issues`; layout marks them read-only |
| Large documents in `localStorage` | medium | Persist the normalised document only, never the raw import; cap at ~2 MB with a warning |
| `price_book_async` task path misses `request` | medium | Explicit P3 task + test that books follow the request |
| Kit upgrade drags Tailwind/Radix versions | medium | P0 is isolated in its own commit; `tsc -b` + `vitest` gate it |
| Legacy `localStorage` keys | low | New `fina-instrument` key; old keys stay readable for one release |

---

## 13. Rollback

- **P0** — revert the kit commit (config + deps + untracked sources).
- **P1/P2/P4/P5** — frontend only; revert the commits. `rigaRequestStore` keeps
  working if `composeRigaRequest` is reverted to read `rigaTradeStore`.
- **P3** — the engine change is additive (`request: Option<Value>`). Reverting it
  restores fixture-priced behaviour; no schema is removed.
- No `note.rs` change, so no priced number is affected by any rollback.

---

## 14. Open items (tracked, not blocking this plan)

1. **Payoff normalisation** — `termsheet1.md.json` PV 0.020329 → 0.026063
   (+23.4% on the normalised basis); pinned anchor 0.02112 and
   `termsheet1-put-reconciliation.md:135` (~0.02113) sit on the un-normalised
   basis. Parked pending decisive legacy evidence (`1.json` with one input
   bumped + legacy PV; a later reval; the vol snapshot behind the 0.069+ quote;
   a case with nonzero `PRKI2`/`capKI2`/`floorKI2`).
2. **KO branch** — `1.json` `GKOLocked=[false,false]` ⇒ P03 global KO;
   `termsheet1` `GKOLocked=[true,false]` ⇒ P01 global memory KO. Carried in
   `put.koLocked`/`koDates`; no engine branch change.
3. **Resources** (`riga://…`) stay fixture-bound; revisit only if a resource
   consumer needs the live request.
