# 51 — Portfolio risk architecture: canonical documents, relations, extension points

**Status:** PROPOSAL — for review before implementation. Nothing in this document is
implemented yet; it is the missing architecture decision that should precede the work.

**Scope.** Move `fina-builder` from "one instrument, one valuation, bump scenarios" to a
portfolio-risk workbench: reference data, positions, dated market data, valuation runs,
factor-keyed sensitivities, P&L attribution, scenarios and a risk matrix — each with a
canonical, versioned document schema and a single extensible composition model.

**Non-goals (for this proposal).** No pricing-math changes. No replacement of
`riga_engine::PriceRequest` or the 35 existing `riga-mcp` tools. No credit/counterparty
risk, XVA, regulatory capital or limit engine in phase 1. No database/authentication
service. Every number still comes from an engine; the UI never synthesises data.

**Relationship to existing docs.** `docs/46` made a single `fina.instrument/v1` document
drive the trade/market tiles; this document extends that idea into a *document family*
and separates the concerns `v1` currently conflates. `docs/49` retired `fina-kernel`;
this proposal keeps `riga-flow` as the pricing engine and `tac-engine` as the market-data
engine behind ports.

---

## 0. Executive summary

The current app has **one canonical object** (the instrument document) and **one
implicit book** (a `notionals: number[]` vector). A portfolio-risk system needs eight
objects and, more importantly, **stable identities that join them**:

| Concern | Canonical document | Identity that joins it |
| --- | --- | --- |
| What can be traded | `fina.instrument/v2` (terms only) | `instrumentId` + content version |
| What is held | `fina.position-snapshot/v1` | `positionId`, `portfolioId`, `asOf` |
| What the world looked like | `fina.market-data-set/v1` | `marketDataSetId`, per-object ids |
| What we computed | `fina.valuation-run/v1` | `runId` (content-addressed) |
| How value moves per factor | `fina.sensitivity-set/v1` | `runId` + `factorId` |
| What we feared | `fina.scenario-set/v1` | `scenarioId` + `factorId` |
| What happened / why | `fina.pnl-period/v1` | two `runId`s + `positionId` |
| The grid we report | `fina.risk-matrix/v1` | `runId`/`scenarioSetId` + dimensions |

The **spine is `factorId`**, not array position. Today risk factors are positional:
`MarketSnapshot.spots[i]`, `vols[i]`, and `BatchAssetGreeks.asset_index`
(`modules/riga-flow/crates/riga-core/src/lib.rs:38`,
`modules/riga-flow/crates/riga-risk/src/lib.rs:470`). That makes cross-trade
aggregation meaningless the moment two trades list their underlyings in a different
order. Everything below — market data, sensitivities, shocks, P&L attribution, the risk
matrix — keys on a canonical factor id with an explicit unit.

The **architecture is ports-and-adapters around immutable documents**:

```text
reference/position store ─┐
market data set ──────────┼─▶ valuation run ──▶ sensitivity set ──▶ risk matrix
scenario set ─────────────┘         │                    ▲
                                    └──▶ P&L period ─────┘
```

Engines (`riga-flow`, `tac-engine`, future ones) are adapters behind capability-declaring
ports. Product templates, factor classes, scenario kinds, measures and P&L attributors are
registries, so adding a product/factor/measure does not add a new tile or a new bespoke
MCP tool.

Persistence is **one portable relational schema** (§4.3): SQLite by default
(`DATABASE_URL`), PostgreSQL in production, with `document` as the append-only canonical
log and the typed tables as the queryable projection. The same `BookStore` port hides the
dialect, so moving from SQLite to PostgreSQL is a migration and configuration change.

**Ten decisions this document asks to lock** (details in §9):

1. `factorId` is mandatory and positional indices never cross a document boundary.
2. Split `fina.instrument/v1`; keep `v1` as a supported projection, add terms-only `v2`.
3. Positions are dated snapshots (bitemporal `asOf` + `recordedAt`), not mutable rows.
4. Computed results are immutable, content-addressed runs with full provenance.
5. Sensitivities, scenarios and P&L all reference the same factor set.
6. Results are stored long/tidy; matrices are explicit projections, not stored shapes.
7. P&L separates actual, explained and residual; residual is a tracked measure.
8. Business state moves from `localStorage` to a Rust-owned store; the webview only caches.
9. The MCP contract grows generic verbs (`fina_*`) alongside the existing typed tools.
10. Rust `schemars` is the schema source of truth; TS mirrors are generated or contract-tested.

---

## 1. Verified current state and the concrete gaps

### 1.1 What exists

| Fact | Evidence |
| --- | --- |
| One product: worst-of Phoenix autocall | `riga_core::PhoenixTrade` (`riga-core/src/lib.rs:58`) |
| Market is 2-factor and positional | `MarketSnapshot { as_of, spots: Vec<f64>, vols, risk_free_rate, dividend_yields, correlation: Vec<Vec<f64>> }` (`riga-core/src/lib.rs:38`) |
| Local vol grids are indexed by the same position | `LocalVolSpec { grids[] }`, `bump_volatility_request` in `riga-risk` |
| Instrument doc bundles terms + market + simulation | `InstrumentDocument` in `src/features/riga/instrument/schema.ts` |
| The UI maps arrays positionally into the engine | `toRequest()` in `src/features/riga/instrument/toRequest.ts` |
| Risk is central-FD CRN bumps of the *same* trade | `riga-risk/src/lib.rs` |
| "Book risk" is one report cloned per notional | `book_risk_json` (`riga-mcp/src/main.rs:2443`), `BookParams { notionals: Vec<f64> }` (`:215`) |
| Aggregation sums by array index | `aggregate_portfolio` (`riga-risk/src/lib.rs:694`) |
| Scenario tool is the same bump batch | `scenario`/`scenario_json` (`riga-mcp/src/main.rs:773`) |
| P&L explain is a Taylor projection from supplied moves | `pnl_explain` (`riga-risk/src/lib.rs:640`), `pl_explain_json` |
| Market data comes from `tac-engine` tools over a lake | `modules/tac-engine/src/lake_tools.rs` (asset master, watchlists, calendar, coverage, vol-surface cache) |
| Business state is in `localStorage` | `src/store/instrumentStore.ts` |
| Determinism metadata exists but is local to one price result | `DeterminismEnvelope` (`riga-core/src/lib.rs:31`) only inside `PriceResult` |

### 1.2 The gaps, stated precisely

**G1 — No identity for what is held.** A trade id is derived from a name/file name
(`doc.meta.name ?? doc.source.fileName ?? 'instrument'`), and a "book" is a vector of
notionals applied to one trade. There is no `positionId`, no side, no quantity kind, no
acquisition/trade date, no portfolio hierarchy, no relationship to an instrument version.

**G2 — No identity for the market.** `MarketSnapshot` has no symbols; symbols live in
`InstrumentMarket.symbols` in a *different* document. A valuation therefore cannot prove
which asset each spot belonged to, and two valuations cannot be compared factor by factor
unless the array order happens to match.

**G3 — No dated market-data object.** `as_of` is a string on the snapshot; curves,
surfaces, correlations and FX are fields of an instrument document, not addressable
objects with their own ids, sources and vintages. There is no `marketDataSetId` to bind a
run to, so results cannot be replayed or diffed for P&L.

**G4 — No provenance chain.** Risk results expose numbers, bumps and a seed, but not the
instrument version, market set, model config, engine version or run id. `DeterminismEnvelope`
covers one price, not a portfolio run.

**G5 — Sensitivities are not factor-keyed.** `BatchAssetGreeks` has `asset_index`;
`PortfolioRisk.delta` is `Vec<f64>`. Aggregating two trades with different underlying
order silently adds Apple delta to Microsoft delta. This is the single most important
correctness gap.

**G6 — No scenario catalogue.** `scenario` re-runs the central-FD batch;
`recommend_scenarios` returns KI/KO bands. There is no named historical/hypothetical
scenario, no shock on a canonical factor, no scenario set, and no result keyed by scenario.

**G7 — No risk matrix.** There is no object whose dimensions are (scenario ×
position/portfolio × measure) with an explicit aggregation policy. The existing
`RigaScenarioComparison` tile is a rendering, not a result model.

**G8 — P&L is hypothetical, not reconciled.** `pl_explain` computes
`delta·ds + ½γ·ds² + vega·dvol + dv01·dr + corr·dcorr` from caller-supplied moves. There
is no actual P&L between two dates, no carry/theta/FX/new-trade decomposition, and no
residual. Without a residual, model risk is invisible.

**G9 — The instrument document mixes concerns.** Terms, market data and simulation config
in one object means an instrument cannot be versioned independently of a market snapshot,
and a position cannot point at "the trade" without also freezing a market.

**G10 — Extensibility is by bespoke tool + bespoke tile.** 35 `riga-mcp` tools each carry
their own fixture/inline-request shape. Adding a product or a measure currently implies a
new Rust param struct, a new tool, a new hook, a new type mirror and a new tile. Nothing
declares engine capabilities, so the frontend cannot discover what is supported.

---

## 2. Domain model: bounded contexts and invariants

### 2.1 Contexts

| Context | Owns | Changes when | Does **not** own |
| --- | --- | --- | --- |
| **Reference data** | instrument templates, instrument versions, legal entities, calendars, portfolio hierarchy | a term sheet is booked or amended | prices, market data |
| **Positions** | dated holdings, quantity/side, portfolio membership | a trade/transfer/amendment is booked | valuation |
| **Market data** | curves, surfaces, spots, FX, fixings, correlations, vintages | a snapshot is captured | instruments |
| **Valuation** | immutable runs and per-position results | a run is requested | positions, market data |
| **Risk** | factor sets, sensitivities, scenarios, risk results/matrices | a risk run is requested | raw positions |
| **P&L** | period actuals, attribution, residual | a period closes or a revaluation occurs | risk measures |
| **Governance** | limits, baselines, approvals, audit trail | a policy changes | calculations |

Keeping these separate is what makes the system extensible: each context has one
document family, one store port and one set of adapters. A new market-data source changes
only market-data adapters; a new product changes only reference/valuation.

### 2.2 Invariants (enforce in Rust, test in contract tests)

- **I-1 — No positional factors.** No `fina.*` document stores a risk factor as an array
  index. Every exposure, shock and sensitivity carries `factorId`.
- **I-2 — Identity is explicit.** Every document has a stable `id`; every immutable
  document also has a content `version`. Edits create versions, never overwrite.
- **I-3 — Provenance is mandatory.** Every computed result lists the ids of every input
  and the producer `{name, version, build}`. No anonymous numbers.
- **I-4 — Time is explicit.** Every document carries `asOf` (valid time) and
  `recordedAt` (system time), both ISO-8601 with timezone. No code reads a wall clock
  implicitly (already true in the engine; must stay true in the store).
- **I-5 — Money is tagged.** PV, P&L and limits are `Money { amount, currency }`.
  Sensitivities carry a unit string (e.g. `PV/1.0 spot`, `PV/1bp`) and, when cash, a
  currency.
- **I-6 — Signs are explicit.** Long is positive, short negative; a position has one
  signed `quantity`. Aggregation never re-derives direction from a separate side flag.
- **I-7 — Long results, projected views.** Risk results are tidy rows. A matrix is a
  descriptor plus cells; it is not the storage shape.
- **I-8 — Actual = explained + residual.** Residual is a first-class, reported measure.
- **I-9 — Additive migration.** `fina.instrument/v1` remains readable and priceable
  throughout; new documents wrap it rather than break it.
- **I-10 — No synthetic data, no silent fallback.** Unsupported capabilities return an
  explicit `unsupported` error/flag; the UI shows unavailable, never a default.
- **I-11 — Currency conversion is a factor.** No implicit FX in aggregation; the run
  records the FX factor ids and rates used.
- **I-12 — One schema source of truth.** Rust types + `schemars` generate JSON Schema;
  TS mirrors are generated or verified by a contract test.

---

## 3. Canonical schema family

All documents share an envelope. Field names are camelCase on the wire (the existing
`riga-mcp` convention); Rust uses `serde(rename_all = "camelCase")`.

### 3.1 Envelope, ids and registry

```ts
export type SchemaId =
  | 'fina.instrument/v2'
  | 'fina.portfolio/v1'
  | 'fina.position-snapshot/v1'
  | 'fina.market-data-set/v1'
  | 'fina.factor-set/v1'
  | 'fina.valuation-run/v1'
  | 'fina.sensitivity-set/v1'
  | 'fina.scenario-set/v1'
  | 'fina.risk-result-set/v1'
  | 'fina.risk-matrix/v1'
  | 'fina.pnl-period/v1'

export interface DocumentEnvelope<T> {
  schema: SchemaId
  /** Stable logical id, e.g. `fina:portfolio:EQ-EMEA`. */
  id: string
  /** Content hash for immutable documents; monotonic revision for mutable ones. */
  version: string
  /** Valid time: the business date/time the content describes. */
  asOf: string
  /** System time: when this revision was recorded. */
  recordedAt: string
  producer: { name: string; version: string; build?: string }
  /** Cross-document links, validated on read. */
  links: Record<string, string | string[]>
  payload: T
}
```

Rules:

- Ids are opaque, stable, human-scannable URNs: `fina:<type>:<key>`. Never reuse an id for
  different content.
- Immutable documents set `version = 'sha256:<hex>'` over canonical JSON of `payload`.
  The existing `MarketSnapshot::snapshot_id()` is the pattern; generalise it.
- Mutable documents (portfolio definition, limits policy) keep a stable `id` and use a
  monotonic revision, with the previous revision retained by the store.
- `links` is the machine-readable relation graph (e.g. a valuation run links
  `positionSnapshot`, `marketDataSet`, `modelConfig`). It is validated, not free-form.

### 3.2 Factors — the join key

```ts
export type FactorClass = 'equity' | 'fx' | 'rate' | 'vol' | 'correlation' | 'credit' | 'commodity'

export type FactorQuote = 'price' | 'rate' | 'vol' | 'correlation' | 'fx' | 'spread'

export interface Factor {
  /** Canonical, stable, never positional. */
  factorId: string
  class: FactorClass
  /** The underlying/reference entity this factor belongs to. */
  underlyingId: string | null
  /** ISO currency the factor is quoted in, if any. */
  currency: string | null
  /** Tenor/expiry/strike bucket, when the class needs one. */
  bucket?: { kind: 'tenor' | 'expiry' | 'strike' | 'delta'; value: string } | null
  quote: FactorQuote
  /** Human/unit contract, e.g. `USD per share`, `decimal rate`, `vol points`. */
  unit: string
  /** The bump convention every consumer must use (sensitivity, scenario, P&L). */
  bump: { kind: 'relative' | 'absolute'; value: number }
  source?: { provider: string; objectId?: string }
}

export interface FactorSet {
  factors: Factor[]
  /** Correlation pairs are factors too; the matrix below is a convenience projection. */
  correlation: { factors: string[]; values: number[][] } | null
}
```

Factor id grammar (stable and readable):

```text
eq:AAPL:spot
eq:AAPL:vol:2027-06-18:ATM
eq:AAPL:vol:2027-06-18:strike:150
ir:USD:OIS:5Y
fx:EUR/USD:spot
corr:eq:AAPL|eq:MSFT:1Y
```

The `bump` lives **on the factor**, so a 1 % relative spot bump means the same thing to
the FD engine, a scenario shock and the P&L explain. This is how G5 is closed.

### 3.3 Instrument (terms only) — `fina.instrument/v2`

`fina.instrument/v1` stays as-is for compatibility. `v2` removes market data and
simulation config, adds identity and references.

```ts
export interface InstrumentV2 {
  instrumentId: string              // stable logical id
  instrumentVersion: string         // content hash of `terms`
  productTemplate: string           // e.g. 'phoenix-worst-of@1'
  displayName: string
  currency: string
  notional: number
  multiplier: number
  tradeDate: string
  expiryDate: string
  maturityDate: string | null
  legalEntityId: string | null
  counterpartyId: string | null
  underlyings: Array<{ underlyingId: string; symbol: string; factorId: string }>
  terms: Record<string, unknown>    // validated by the template's terms schema
  legs: InstrumentLegV2[]           // payoff legs; terms + linkage, no market data
  issues: InstrumentIssue[]
  source: InstrumentSource
  /** v1 documents remain importable through an adapter. */
  legacy?: { schema: 'fina.instrument/v1'; version: string }
}
```

Extension point: `productTemplate` names a registered `ProductTemplate` (§5.3). Its
`terms` are validated by a per-template JSON Schema; `riga_engine::PhoenixTrade` becomes
the first template's compiled form, not the universal shape. Do **not** generalise the
payoff graph in phase 1 — only the *seam* is defined.

### 3.4 Portfolio and positions — `fina.portfolio/v1`, `fina.position-snapshot/v1`

```ts
export interface Portfolio {
  portfolioId: string
  name: string
  parentPortfolioId: string | null   // hierarchy; roots are books/desks
  baseCurrency: string
  kind: 'book' | 'desk' | 'fund' | 'house'
  aggregation: {
    /** How PV/P&L roll up. Risk measures declare their own non-additive policy. */
    pv: 'sum'
    limits?: string[]                // ids of limit definitions
  }
  tags: Record<string, string>
}

export interface Position {
  positionId: string
  portfolioId: string
  instrumentId: string
  instrumentVersion: string
  /** Signed: long positive, short negative. */
  quantity: number
  quantityKind: 'units' | 'notional' | 'contracts'
  /** Trade/booking metadata that does not change the terms. */
  bookedAt: string
  tradeDate: string
  settlementDate: string | null
  fxFactorId: string | null          // instrument currency → portfolio currency
  status: 'open' | 'closed' | 'pending'
  tags: Record<string, string>
}

export interface PositionSnapshot {
  portfolioIds: string[]
  positions: Position[]
  /** Sum of position notional per currency, for reconciliation (not risk). */
  grossNotional: Money[]
}
```

Positions are **dated snapshots**: the store appends a new `fina.position-snapshot/v1`
on every booking/amendment. A "current position" is the latest snapshot by `asOf`.
`positionId` is stable across snapshots; `recordedAt` distinguishes corrections.

### 3.5 Market data set — `fina.market-data-set/v1`

```ts
export interface MarketDataSet {
  marketDataSetId: string
  /** The valuation/business date the set represents. */
  asOf: string
  /** The instant the set was captured/loaded. */
  capturedAt: string
  objects: {
    spots: SpotQuote[]
    curves: Curve[]
    surfaces: VolSurface[]
    fx: FxQuote[]
    fixings: Fixing[]
    correlations: CorrelationMatrix[]
  }
  factors: FactorSet
  /** Completeness/quality flags per factor; consumers decide whether to run. */
  quality: Array<{ factorId: string; status: 'ok' | 'stale' | 'missing' | 'fallback'; detail?: string }>
  sources: Array<{ provider: string; objectIds: string[] }>
}

export interface SpotQuote { objectId: string; factorId: string; value: number; currency: string; asOf: string; source: string }
export interface FxQuote   { objectId: string; factorId: string; value: number; base: string; quote: string; asOf: string; source: string }
export interface Fixing    { objectId: string; factorId: string; value: number; fixingDate: string; source: string }
export interface Curve {
  objectId: string
  curveId: string
  currency: string
  kind: 'ois' | 'sofr' | 'libor' | 'credit'
  dayCount: string
  interpolation: 'linear' | 'log-linear' | 'monotone-convex'
  asOf: string
  pillars: Array<{ date: string; tenor: string; rate: number }>
  factorIds: string[]
}
export interface VolSurface {
  objectId: string
  surfaceId: string
  underlyingId: string
  kind: 'implied' | 'local'
  asOf: string
  maturitiesYears: number[]
  strikes: number[]
  vols: number[][]
  factorIds: string[]              // one per (expiry, strike/delta) bucket
}
export interface CorrelationMatrix {
  objectId: string
  matrixId: string
  asOf: string
  factors: string[]
  values: number[][]
  factorIds: string[]
}
```

The set is content-addressed. `tac-engine` adapters produce it: lake asset master and
calendar for reference identity, bars/fixings for spots, vol-surface cache for surfaces,
FRED for rates, Yahoo/ECB/Alpaca for FX. Missing inputs are `quality: missing`, never
filled with zeros.

### 3.6 Valuation run — `fina.valuation-run/v1`

```ts
export interface ModelConfig {
  modelConfigId: string
  pricer: string                    // registry id, e.g. 'riga-flow.phoenix-mc@1'
  simulation: { paths: number; pathBlockSize: number; seed: number; varianceReduction: 'none' | 'halton' | 'sobol'; traceLevel: 'off' | 'aggregated' | 'sampled' | 'full' }
  calibration: Record<string, unknown>
  /** Numerical settings that affect reproducibility. */
  tolerances?: Record<string, number>
}

export interface PositionValuation {
  positionId: string
  instrumentId: string
  instrumentVersion: string
  pv: Money
  /** PV in portfolio currency after FX; both are recorded. */
  pvPortfolio: Money
  unitPv: Money
  deltaCurrency?: string
  mcError?: Money
  status: 'priced' | 'failed' | 'unsupported'
  error?: { code: string; message: string }
  /** Engine-specific evidence, kept opaque to the portfolio layer. */
  evidence?: Record<string, unknown>
}

export interface ValuationRun {
  runId: string                     // sha256(positionSnapshot, marketDataSet, modelConfig, engine build, asOf)
  asOf: string
  portfolioIds: string[]
  positionSnapshotId: string
  marketDataSetId: string
  modelConfig: ModelConfig
  baseCurrency: string
  positions: PositionValuation[]
  totals: { pv: Money; pvPortfolio: Money; priced: number; failed: number; unsupported: number }
  engine: { name: string; version: string; build: string }
  /** Determinism evidence: seed, market snapshot id, engine version. */
  determinism: { seed: number; marketSnapshotId: string; engineVersion: string }
}
```

`runId` is content-addressed, so a repeated request over the same inputs is a cache hit,
not a second set of numbers. The existing `price_trade` becomes the single-position
implementation behind the `PricerPort`.

### 3.7 Sensitivity set — `fina.sensitivity-set/v1`

```ts
export type Measure = 'delta' | 'gamma' | 'vega' | 'theta' | 'rho' | 'correlation' | 'fx-delta'

export interface Sensitivity {
  positionId: string
  factorId: string
  measure: Measure
  value: number
  /** e.g. `PV/1.0 spot`, `PV/1bp`, `PV/1.0 vol`. */
  unit: string
  currency: string | null
  /** How it was produced, so results are comparable. */
  method: 'analytic' | 'fd-crn' | 'fd-independent' | 'aad'
  bump: { kind: 'relative' | 'absolute'; value: number }
  /** Optional uncertainty (MC error upper bound). */
  error?: number
  /** Curvature/cross terms: the second factor of a cross-gamma. */
  crossFactorId?: string | null
}

export interface SensitivitySet {
  setId: string                     // sha256(runId, factorSetId, bump policy)
  runId: string
  factorSetId: string
  asOf: string
  baseCurrency: string
  sensitivities: Sensitivity[]
  /** Explicitly enumerate unsupported factor/measure pairs for this run. */
  unsupported: Array<{ factorId: string; measure: Measure; reason: string }>
}
```

Bucketed vega is expressed by bucket-specific `factorId`s (`...:vol:2027-06-18:strike:150`),
not by a separate array. Cross-gamma uses `crossFactorId`. Aggregation is
`(factorId, measure, unit)` — never `asset_index`.

### 3.8 Scenario set — `fina.scenario-set/v1`

```ts
export type ScenarioKind = 'historical' | 'hypothetical' | 'stress' | 'reverse-stress' | 'monte-carlo'

export interface FactorShock {
  factorId: string
  kind: 'absolute' | 'relative' | 'vol-points' | 'multiply'
  value: number
  /** For historical scenarios: the two market sets the move was observed between. */
  fromMarketDataSetId?: string
  toMarketDataSetId?: string
}

export interface Scenario {
  scenarioId: string
  name: string
  kind: ScenarioKind
  description?: string
  shocks: FactorShock[]
  /** For path-based/historical replay: ordered dates and per-factor paths. */
  horizon?: { start: string; end: string; steps: number }
  /** Generator provenance, so a Monte-Carlo scenario is reproducible. */
  generator?: { id: string; version: string; seed?: number }
  tags: string[]
}

export interface ScenarioSet {
  scenarioSetId: string
  name: string
  asOf: string
  baseMarketDataSetId: string | null
  scenarios: Scenario[]
}
```

Historical replay is *derived*: pick two market sets, compute factor moves, emit
`FactorShock`s with `from/to` provenance. Hypothetical/stress is authored. Monte-Carlo is
generated by a registered generator with a seed. All three become the same document, so
the risk runner has one code path.

### 3.9 Risk results and matrix — `fina.risk-result-set/v1`, `fina.risk-matrix/v1`

```ts
export type RiskMeasure =
  | 'pv' | 'pv-change' | 'pnl' | 'delta' | 'gamma' | 'vega' | 'dv01'
  | 'var' | 'expected-shortfall' | 'worst-case'

export interface RiskCell {
  scenarioId: string
  positionId: string | null         // null ⇒ already aggregated to portfolio
  portfolioId: string
  measure: RiskMeasure
  value: number
  unit: string
  currency: string | null
  /** For path scenarios: the step/date the cell refers to. */
  step?: number
  /** Optional contribution/share, computed only under an explicit policy. */
  contribution?: number
}

export interface RiskResultSet {
  riskRunId: string                 // sha256(runId, scenarioSetId, measure policy)
  runId: string
  scenarioSetId: string
  asOf: string
  baseCurrency: string
  cells: RiskCell[]
  /** Dimensions actually present; a matrix view validates against this. */
  dimensions: { scenarios: string[]; positions: string[]; portfolios: string[]; measures: RiskMeasure[] }
  /** Explicit non-additivity and aggregation policy. */
  policy: { measure: RiskMeasure; aggregation: 'sum' | 'none' | 'quantile'; confidence?: number; horizonDays?: number }[]
  unsupported: Array<{ scenarioId: string; positionId: string; reason: string }>
}

export interface RiskMatrix {
  matrixId: string
  riskRunId: string
  rows: 'scenario' | 'factor' | 'position'
  columns: 'position' | 'portfolio' | 'factor'
  measure: RiskMeasure
  currency: string
  /** Pivot produced from a RiskResultSet; cells are references, not duplicates. */
  cells: Array<{ rowKey: string; columnKey: string; value: number; unit: string }>
  totals?: { row?: Record<string, number>; column?: Record<string, number>; grand?: number }
}
```

Non-additivity is explicit: summing PV/P&L is valid; summing VaR is not. The policy says
which measure may be summed and how a portfolio cell was derived. A matrix is a *view*
over cells, so the same result set can drive a scenario table, a position heat map and a
factor decomposition without re-running anything.

### 3.10 P&L — `fina.pnl-period/v1`

```ts
export type PnlComponentKind =
  | 'factor' | 'theta' | 'carry' | 'roll' | 'fx' | 'new-trades' | 'closed-trades' | 'fees' | 'residual'

export interface PnlAttribution {
  positionId: string | null
  kind: PnlComponentKind
  factorId: string | null
  contribution: Money
  /** Which method produced it. */
  method: 'taylor' | 'full-reval' | 'carry-roll' | 'identity'
}

export interface PnlPeriod {
  pnlPeriodId: string
  portfolioId: string
  startRunId: string
  endRunId: string
  startAsOf: string
  endAsOf: string
  currency: string
  /** Actual = end PV - start PV - external flows. */
  actual: Money
  explained: Money
  residual: Money
  attribution: PnlAttribution[]
  /** Reconciliation identity check; a run is unhealthy if false. */
  reconciles: boolean
  /** Position-level rows, so a portfolio total can always be drilled into. */
  positions: Array<{
    positionId: string
    startPv: Money
    endPv: Money
    actual: Money
    explained: Money
    residual: Money
  }>
}
```

The identity is `explained + residual = actual`. Residual decomposes further (data,
timing, model, numerical) in a later phase; phase 1 only requires it to exist and be
reported. FX is a component, not an afterthought (I-11).

---

## 4. Relations and dataflow

### 4.1 Relation graph

```text
Portfolio 1 ── N Portfolio (parent)
Portfolio 1 ── N Position
Position  N ── 1 Instrument(version)
PositionSnapshot 1 ── N Position        (as-of; append-only)

MarketDataSet 1 ── N MarketObject       (curve/surface/spot/fx/fixing/corr)
MarketDataSet 1 ── 1 FactorSet

ValuationRun N ── 1 PositionSnapshot
ValuationRun N ── 1 MarketDataSet
ValuationRun N ── 1 ModelConfig
ValuationRun 1 ── N PositionValuation

SensitivitySet N ── 1 ValuationRun
SensitivitySet N ── 1 FactorSet
Sensitivity    N ── 1 Factor

ScenarioSet 1 ── N Scenario 1 ── N FactorShock ── 1 Factor

RiskResultSet N ── 1 ValuationRun
RiskResultSet N ── 1 ScenarioSet
RiskCell      N ── 1 Scenario, N ── 1 Position/Portfolio

PnlPeriod N ── 2 ValuationRun (start, end)
PnlAttribution N ── 1 PnlPeriod, N ── 1 Factor
```

Every arrow is a validated `links` entry, not an informal convention. Deleting or
superseding a document is a governance operation (append-only store), never a cascade.

### 4.2 Canonical pipeline

```text
                 ┌──────────────────────────────┐
reference data ─▶│ Instrument v2 (versioned)     │
                 └──────────────┬───────────────┘
                                │ booked as
                 ┌──────────────▼───────────────┐
                 │ Position snapshot (as-of)     │
                 └──────────────┬───────────────┘
                                │
market sources ─▶ MarketDataSet ─┼─▶ ValuationRun ──▶ SensitivitySet
(tac-engine/lake)                │        │                  │
                                 │        │                  │
scenario authoring ─▶ ScenarioSet┴────────┼──────────────────┤
                                          │                  │
                                          ▼                  ▼
                                    RiskResultSet ──────▶ RiskMatrix
                                          │
previous ValuationRun ────────────────────┴─▶ PnlPeriod (actual/explained/residual)
```

The important property: **one valuation run feeds sensitivities, scenarios and P&L**.
They cannot disagree about the base PV because they reference the same `runId`.

---

### 4.3 Relational schema (SQLite + PostgreSQL)

The canonical documents in §3 are the **contract**; this section is the **persistence
projection**. It is one logical schema with two physical dialects. SQLite is the default
(`DATABASE_URL` is set in `.env`; see rule 19 on the path form), PostgreSQL is the
production option. The repo already has `sqlx 0.8` with both drivers in
`modules/riga/crates/riga-server/Cargo.toml`; reuse it rather than adding a second ORM.
The existing `riga-server` secure store uses the same `DATABASE_URL` for its
`riga_settings` table; the tables below do not collide with it. On PostgreSQL, put them
in a dedicated `fina` schema; on SQLite, prefer a dedicated database file per environment.

**What is authoritative.**

- `document` is the append-only canonical-envelope log: schema id, logical id, version,
  `asOf`/`recordedAt`, producer, links and the canonical JSON payload. It is the audit and
  replay record and the forward-compatibility escape hatch.
- The typed tables below are the **queryable projection** of that payload. They are
  written in the **same transaction** as the `document` row, so they cannot drift.
- Reads that join/filter/aggregate use the typed tables. Reads that must reproduce a past
  result, or encounter a newer schema field, read `document`.
- `fina_store_rebuild` can reconstruct the typed projection from `document`; a CI job
  compares row counts and content hashes. High-volume children (`risk_cell`,
  `vol_surface_point`) are the documented exception: the document keeps the envelope and
  summary, and the cells are the system of record for that payload.

**Document → table projection.**

| Canonical document | Projection tables |
| --- | --- |
| `fina.instrument/v2` | `instrument`, `instrument_version`, `instrument_underlying` |
| `fina.portfolio/v1` | `portfolio`, `portfolio_version` |
| `fina.position-snapshot/v1` | `position_snapshot`, `position_snapshot_portfolio`, `position` |
| `fina.market-data-set/v1` | `market_data_set`, `market_set_object`, `market_object`, `market_data_quality`, `factor_set`, `factor_set_member`, `factor`, `spot_quote`, `fx_quote`, `fixing`, `curve`, `curve_pillar`, `vol_surface`, `vol_surface_point`, `correlation_matrix`, `correlation_pair` |
| `fina.valuation-run/v1` | `model_config`, `valuation_run`, `valuation_run_portfolio`, `position_valuation` |
| `fina.sensitivity-set/v1` | `sensitivity_set`, `sensitivity`, `sensitivity_unsupported` |
| `fina.scenario-set/v1` | `scenario_set`, `scenario`, `factor_shock` |
| `fina.risk-result-set/v1` | `risk_result_set`, `risk_cell`, `risk_cell_unsupported` |
| `fina.risk-matrix/v1` | `risk_matrix`, `risk_matrix_cell` |
| `fina.pnl-period/v1` | `pnl_period`, `pnl_position`, `pnl_attribution`, `external_flow` |
| governance (not a priced document) | `limit_definition`, `limit_break`, `audit_event` |

#### 4.3.1 Portable type system

Every column is expressed with a **logical type**; the migration generator emits the
dialect-specific type. Application code binds values, never interpolates SQL.

| Logical type | SQLite | PostgreSQL | Rules |
| --- | --- | --- | --- |
| `id` | `TEXT` | `TEXT` | App-generated URN/ULID/content hash. No `SERIAL`, `AUTOINCREMENT`, `UUID` or identity columns. |
| `text` | `TEXT` | `TEXT` | UTF-8, no length limit. |
| `int` | `INTEGER` | `BIGINT` | Counts, ordinals, steps, horizons. |
| `double` | `REAL` | `DOUBLE PRECISION` | Every computed value (PV, sensitivity, shock, rate). Documented float tolerance; no `NUMERIC`/`DECIMAL` because SQLite has no exact decimal type. |
| `bool` | `INTEGER` + `CHECK (c IN (0,1))` | `BOOLEAN` | Logical `bool`; generated per dialect. Never rely on `TRUE`/`1` equivalence in shared SQL. |
| `ts` | `TEXT` | `TIMESTAMPTZ` | UTC only, fixed-width ISO-8601 (`YYYY-MM-DDTHH:MM:SS.sssZ`). App supplies the value; no DB `now()` (I-4). SQLite text sorts chronologically at fixed width. |
| `json` | `TEXT` | `JSONB` | Canonical JSON (`serde_json` compact, stable key order). Treat as opaque in shared SQL; query via typed columns, not JSON path operators. |
| `enum` | `TEXT` + `CHECK (c IN (...))` | `TEXT` + `CHECK (c IN (...))` | No native `ENUM`; values are lower-kebab or snake_case and frozen per schema version. |

Money is always **two columns**: `*_amount DOUBLE` + `*_currency TEXT` (a `Money` value is
never a bare number). Seeds are `text` decimal strings because the engine uses `u64`,
which can exceed PostgreSQL `BIGINT`; they are never arithmetic inputs in SQL.

**Naming.** Tables and columns are `snake_case`; canonical document fields stay camelCase
only inside `json` payloads. Primary keys are `<entity>_id`; composite keys are declared
explicitly. Nullable columns never participate in a primary key or unique constraint —
use a surrogate id or a `COALESCE(...)` expression index instead.

#### 4.3.2 Complete ER diagram

Key columns only; every other column is defined in §4.3.3. `DOCUMENT`, `AUDIT_EVENT` and
`SCHEMA_MIGRATION` are intentionally unconnected: they are polymorphic/generic and carry
no foreign keys.

```mermaid
erDiagram
    %% ── Core, audit and schema ─────────────────────────────────────────────
    SCHEMA_MIGRATION {
        text version PK
        timestamptz applied_at
        text checksum
    }
    DOCUMENT {
        text document_id PK
        text schema_id
        text logical_id
        text version
    }
    AUDIT_EVENT {
        text event_id PK
        timestamptz occurred_at
        text logical_id
    }

    %% ── Reference data and positions ───────────────────────────────────────
    PARTY {
        text party_id PK
        text kind
        text parent_party_id
    }
    INSTRUMENT {
        text instrument_id PK
        text current_version
        text product_template
    }
    INSTRUMENT_VERSION {
        text instrument_id PK
        text version PK
        text content_hash
    }
    UNDERLYING {
        text underlying_id PK
        text symbol
        text primary_factor_id
    }
    INSTRUMENT_UNDERLYING {
        text instrument_id PK
        text underlying_id PK
        text factor_id
    }
    PORTFOLIO {
        text portfolio_id PK
    }
    PORTFOLIO_VERSION {
        text portfolio_id PK
        text version PK
        text parent_portfolio_id
        bool is_current
    }
    POSITION_SNAPSHOT {
        text position_snapshot_id PK
        timestamptz as_of
    }
    POSITION_SNAPSHOT_PORTFOLIO {
        text position_snapshot_id PK
        text portfolio_id PK
    }
    POSITION {
        text position_row_id PK
        text position_id
        text position_snapshot_id
        text portfolio_id
        text instrument_id
        text instrument_version
    }

    PARTY ||--o{ INSTRUMENT : "legal entity"
    PARTY ||--o{ INSTRUMENT : "counterparty"
    PARTY |o--o{ PARTY : "parent of"
    INSTRUMENT ||--o{ INSTRUMENT_VERSION : "versioned as"
    INSTRUMENT ||--o{ INSTRUMENT_UNDERLYING : "references"
    UNDERLYING ||--o{ INSTRUMENT_UNDERLYING : "referenced by"
    INSTRUMENT ||--o{ POSITION : "held as"
    INSTRUMENT_VERSION ||--o{ POSITION : "terms for"
    PORTFOLIO ||--o{ PORTFOLIO_VERSION : "versioned as"
    PORTFOLIO ||--o{ PORTFOLIO : "parent of"
    PORTFOLIO ||--o{ POSITION : "holds"
    POSITION_SNAPSHOT ||--o{ POSITION : "contains"
    POSITION_SNAPSHOT ||--o{ POSITION_SNAPSHOT_PORTFOLIO : "covers"
    PORTFOLIO ||--o{ POSITION_SNAPSHOT_PORTFOLIO : "covered in"

    %% ── Market data and factors ────────────────────────────────────────────
    FACTOR {
        text factor_id PK
        text class
        text underlying_id
        text currency
    }
    FACTOR_SET {
        text factor_set_id PK
        timestamptz as_of
    }
    FACTOR_SET_MEMBER {
        text factor_set_id PK
        text factor_id PK
    }
    MARKET_DATA_SET {
        text market_data_set_id PK
        text factor_set_id
        text content_hash
    }
    MARKET_SET_OBJECT {
        text market_data_set_id PK
        text object_id PK
    }
    MARKET_OBJECT {
        text object_id PK
        text object_type
        text factor_id
    }
    MARKET_DATA_QUALITY {
        text market_data_set_id PK
        text factor_id PK
        text status
    }
    SPOT_QUOTE {
        text object_id PK
        double value
        text currency
    }
    FX_QUOTE {
        text object_id PK
        double value
        text base_currency
        text quote_currency
    }
    FIXING {
        text object_id PK
        double value
        timestamptz fixing_date
    }
    CURVE {
        text object_id PK
        text curve_id
        text currency
    }
    CURVE_PILLAR {
        text object_id PK
        text tenor PK
        text factor_id
        double rate
    }
    VOL_SURFACE {
        text object_id PK
        text surface_id
        text underlying_id
    }
    VOL_SURFACE_POINT {
        text object_id PK
        int maturity_index PK
        int strike_index PK
        text factor_id
        double vol
    }
    CORRELATION_MATRIX {
        text object_id PK
        text matrix_id
    }
    CORRELATION_PAIR {
        text object_id PK
        text factor_a_id PK
        text factor_b_id PK
        double value
    }

    UNDERLYING |o--o{ FACTOR : "quoted by"
    FACTOR ||--o{ INSTRUMENT_UNDERLYING : "spot factor"
    FACTOR_SET ||--o{ FACTOR_SET_MEMBER : "contains"
    FACTOR ||--o{ FACTOR_SET_MEMBER : "member of"
    FACTOR_SET ||--o{ MARKET_DATA_SET : "universe for"
    MARKET_DATA_SET ||--o{ MARKET_SET_OBJECT : "contains"
    MARKET_OBJECT ||--o{ MARKET_SET_OBJECT : "in set"
    MARKET_DATA_SET ||--o{ MARKET_DATA_QUALITY : "quality of"
    FACTOR ||--o{ MARKET_DATA_QUALITY : "assessed"
    FACTOR |o--o{ MARKET_OBJECT : "quoted by"
    MARKET_OBJECT ||--o| SPOT_QUOTE : "spot detail"
    MARKET_OBJECT ||--o| FX_QUOTE : "fx detail"
    MARKET_OBJECT ||--o| FIXING : "fixing detail"
    MARKET_OBJECT ||--o| CURVE : "curve detail"
    CURVE ||--o{ CURVE_PILLAR : "pillars"
    FACTOR ||--o{ CURVE_PILLAR : "pillar factor"
    MARKET_OBJECT ||--o| VOL_SURFACE : "surface detail"
    VOL_SURFACE ||--o{ VOL_SURFACE_POINT : "points"
    FACTOR ||--o{ VOL_SURFACE_POINT : "bucket factor"
    UNDERLYING ||--o{ VOL_SURFACE : "surface for"
    MARKET_OBJECT ||--o| CORRELATION_MATRIX : "correlation detail"
    CORRELATION_MATRIX ||--o{ CORRELATION_PAIR : "pairs"
    FACTOR ||--o{ CORRELATION_PAIR : "factor A"
    FACTOR ||--o{ CORRELATION_PAIR : "factor B"

    %% ── Valuation ──────────────────────────────────────────────────────────
    MODEL_CONFIG {
        text model_config_id PK
        text pricer
        text content_hash
    }
    VALUATION_RUN {
        text run_id PK
        text position_snapshot_id
        text market_data_set_id
        text model_config_id
    }
    VALUATION_RUN_PORTFOLIO {
        text run_id PK
        text portfolio_id PK
    }
    POSITION_VALUATION {
        text run_id PK
        text position_row_id PK
        text status
    }

    POSITION_SNAPSHOT ||--o{ VALUATION_RUN : "valued in"
    MARKET_DATA_SET ||--o{ VALUATION_RUN : "market for"
    MODEL_CONFIG ||--o{ VALUATION_RUN : "model for"
    VALUATION_RUN ||--o{ VALUATION_RUN_PORTFOLIO : "covers"
    PORTFOLIO ||--o{ VALUATION_RUN_PORTFOLIO : "covered by"
    VALUATION_RUN ||--o{ POSITION_VALUATION : "produces"
    POSITION ||--o{ POSITION_VALUATION : "valued as"

    %% ── Sensitivities, scenarios and risk results ──────────────────────────
    SENSITIVITY_SET {
        text set_id PK
        text valuation_run_id
        text factor_set_id
    }
    SENSITIVITY {
        text sensitivity_id PK
        text set_id
        text position_row_id
        text factor_id
        text measure
    }
    SENSITIVITY_UNSUPPORTED {
        text set_id PK
        text factor_id PK
        text measure PK
    }
    SCENARIO_SET {
        text scenario_set_id PK
        text base_market_data_set_id
    }
    SCENARIO {
        text scenario_set_id PK
        text scenario_id PK
        text kind
    }
    FACTOR_SHOCK {
        text scenario_set_id PK
        text scenario_id PK
        int shock_index PK
        text factor_id
    }
    RISK_RESULT_SET {
        text risk_result_set_id PK
        text valuation_run_id
        text scenario_set_id
    }
    RISK_CELL {
        text risk_cell_id PK
        text risk_result_set_id
        text scenario_id
        text position_row_id
        text portfolio_id
        text measure
    }
    RISK_CELL_UNSUPPORTED {
        text risk_result_set_id PK
        text scenario_id PK
        text position_row_id PK
    }
    RISK_MATRIX {
        text matrix_id PK
        text risk_result_set_id
        text measure
    }
    RISK_MATRIX_CELL {
        text matrix_id PK
        text row_key PK
        text column_key PK
        double value
    }

    VALUATION_RUN ||--o{ SENSITIVITY_SET : "sensitised by"
    FACTOR_SET ||--o{ SENSITIVITY_SET : "factor universe"
    SENSITIVITY_SET ||--o{ SENSITIVITY : "contains"
    POSITION ||--o{ SENSITIVITY : "exposed by"
    FACTOR ||--o{ SENSITIVITY : "w.r.t."
    FACTOR ||--o{ SENSITIVITY : "cross factor"
    SENSITIVITY_SET ||--o{ SENSITIVITY_UNSUPPORTED : "reports"
    FACTOR ||--o{ SENSITIVITY_UNSUPPORTED : "unsupported"
    MARKET_DATA_SET |o--o{ SCENARIO_SET : "base for"
    SCENARIO_SET ||--o{ SCENARIO : "contains"
    SCENARIO ||--o{ FACTOR_SHOCK : "shocks"
    FACTOR ||--o{ FACTOR_SHOCK : "shocked"
    MARKET_DATA_SET |o--o{ FACTOR_SHOCK : "from"
    MARKET_DATA_SET |o--o{ FACTOR_SHOCK : "to"
    VALUATION_RUN ||--o{ RISK_RESULT_SET : "risk base"
    SCENARIO_SET ||--o{ RISK_RESULT_SET : "scenarios"
    RISK_RESULT_SET ||--o{ RISK_CELL : "contains"
    SCENARIO ||--o{ RISK_CELL : "in scenario"
    POSITION |o--o{ RISK_CELL : "position cell"
    PORTFOLIO ||--o{ RISK_CELL : "portfolio cell"
    RISK_RESULT_SET ||--o{ RISK_CELL_UNSUPPORTED : "reports"
    RISK_RESULT_SET ||--o{ RISK_MATRIX : "pivoted as"
    RISK_MATRIX ||--o{ RISK_MATRIX_CELL : "contains"

    %% ── P&L ────────────────────────────────────────────────────────────────
    PNL_PERIOD {
        text pnl_period_id PK
        text portfolio_id
        text start_run_id
        text end_run_id
        bool reconciles
    }
    PNL_POSITION {
        text pnl_period_id PK
        text position_id PK
    }
    PNL_ATTRIBUTION {
        text pnl_attribution_id PK
        text pnl_period_id
        text position_id
        text kind
        text factor_id
    }
    EXTERNAL_FLOW {
        text flow_id PK
        text pnl_period_id
        text position_id
        text kind
    }

    PORTFOLIO ||--o{ PNL_PERIOD : "reports"
    VALUATION_RUN ||--o{ PNL_PERIOD : "start run"
    VALUATION_RUN ||--o{ PNL_PERIOD : "end run"
    PNL_PERIOD ||--o{ PNL_POSITION : "contains"
    PNL_PERIOD ||--o{ PNL_ATTRIBUTION : "explained by"
    FACTOR |o--o{ PNL_ATTRIBUTION : "attributed to"
    PNL_PERIOD ||--o{ EXTERNAL_FLOW : "includes"

    %% ── Governance ─────────────────────────────────────────────────────────
    LIMIT_DEFINITION {
        text limit_id PK
        text portfolio_id
        text factor_id
        text measure
    }
    LIMIT_BREAK {
        text break_id PK
        text limit_id
        text risk_result_set_id
        text status
    }

    PORTFOLIO ||--o{ LIMIT_DEFINITION : "limited by"
    FACTOR |o--o{ LIMIT_DEFINITION : "limits"
    LIMIT_DEFINITION ||--o{ LIMIT_BREAK : "breached as"
    RISK_RESULT_SET ||--o{ LIMIT_BREAK : "observed in"
```

#### 4.3.3 Table definitions

##### Core, audit and schema

**`schema_migration`** — applied migration ledger (or use `_sqlx_migrations`; pick one).

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `version` | `text` | PK | Migration id, e.g. `0001_init`. |
| `checksum` | `text` |  | SHA-256 of the migration body; mismatch fails startup. |
| `applied_at` | `ts` |  | When the migration ran (app-supplied UTC). |

**`document`** — append-only canonical envelope log.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `document_id` | `id` | PK | `sha256(schema_id + logical_id + version + payload)`, `sha256:<hex>`; includes identity so equal payloads under different ids cannot collide. |
| `schema_id` | `text` | IX | e.g. `fina.valuation-run/v1`. |
| `logical_id` | `id` | IX | Stable document id (`runId`, `setId`, `portfolioId`, …). |
| `version` | `text` |  | Content hash for immutable docs; monotonic revision for mutable ones. |
| `as_of` | `ts` | IX | Valid/business time. |
| `recorded_at` | `ts` | IX | System time the row was written. |
| `producer` | `json` |  | `{name, version, build}`. |
| `links` | `json` |  | Validated cross-document references. |
| `payload` | `json` |  | Canonical document payload; may omit high-volume children (documented). |
| `content_hash` | `text` |  | SHA-256 over `payload`; unique with schema/logical/version. |

Constraints: `UNIQUE (schema_id, logical_id, version)`; index
`(schema_id, logical_id, recorded_at DESC)`.

**`audit_event`** — governance/action log, no foreign keys (actions may target any schema).

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `event_id` | `id` | PK | ULID. |
| `occurred_at` | `ts` | IX | When the action happened. |
| `actor` | `text` |  | User/service identity. |
| `action` | `text` |  | e.g. `book`, `amend`, `approve`, `limit.waive`. |
| `schema_id` | `text` |  | Target document schema, if any. |
| `logical_id` | `id` | IX | Target document id, if any. |
| `version` | `text` |  | Target version, if any. |
| `detail` | `json` |  | Before/after or approval detail. |

##### Reference data and positions

**`party`** — legal entities, counterparties, issuers.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `party_id` | `id` | PK | Stable id. |
| `name` | `text` |  | Legal/display name. |
| `kind` | `text` |  | `legal-entity`, `counterparty`, `issuer`, `broker`. |
| `lei` | `text` |  | Optional LEI. |
| `country` | `text` |  | ISO 3166-1 alpha-2. |
| `parent_party_id` | `id` | FK → `party.party_id` | Group hierarchy. |

**`instrument`** — stable identity and current pointer.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `instrument_id` | `id` | PK | Stable logical id. |
| `current_version` | `text` |  | Latest `instrument_version.version` (app-enforced). |
| `product_template` | `text` | IX | Registry id, e.g. `phoenix-worst-of@1`. |
| `display_name` | `text` |  | Human name. |
| `currency` | `text` |  | Instrument currency. |
| `notional` | `double` |  | Contract notional. |
| `multiplier` | `double` |  | Contract multiplier (≥ 0). |
| `trade_date` | `ts` |  | Trade date. |
| `expiry_date` | `ts` |  | Expiry. |
| `maturity_date` | `ts` |  | Optional settlement maturity. |
| `legal_entity_id` | `id` | FK → `party` | Booking entity. |
| `counterparty_id` | `id` | FK → `party` | Counterparty. |
| `status` | `text` | IX | `active`, `matured`, `cancelled`. |
| `created_at` | `ts` |  | First booking. |
| `updated_at` | `ts` |  | Last amendment. |

**`instrument_version`** — immutable terms; one row per content hash.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `instrument_id` | `id` | PK, FK → `instrument` | Owning instrument. |
| `version` | `text` | PK | Content hash of `terms` + `legs` + `underlyings`. |
| `product_template` | `text` |  | Template id at this version. |
| `terms` | `json` |  | Template-validated economic terms. |
| `legs` | `json` |  | Payoff legs (no market data). |
| `issues` | `json` |  | Import/validation issues. |
| `source` | `json` |  | Adapter, file name, raw hash. |
| `content_hash` | `text` | UQ | Same hash as `version`; kept for generic tooling. |
| `as_of` | `ts` |  | Term-sheet as-of. |
| `recorded_at` | `ts` |  | When the version was stored. |
| `producer` | `json` |  | Importer/engine identity. |

**`underlying`** — reference obligation behind a factor/surface.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `underlying_id` | `id` | PK | Stable id. |
| `symbol` | `text` | UQ | Canonical ticker/RIC. |
| `name` | `text` |  | Display name. |
| `asset_class` | `text` |  | `equity`, `fx`, `commodity`, `index`, `rate`. |
| `currency` | `text` |  | Quote currency. |
| `primary_factor_id` | `id` | FK → `factor` | Canonical spot factor. |

**`instrument_underlying`** — ordered underlyings and their spot factors.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `instrument_id` | `id` | PK, FK → `instrument` | Instrument. |
| `underlying_id` | `id` | PK, FK → `underlying` | Underlying. |
| `ordinal` | `int` | UQ | Position in the worst-of basket; stable for this version. |
| `factor_id` | `id` | FK → `factor` | Spot factor used by this instrument. |

Constraint: `UNIQUE (instrument_id, ordinal)`.

**`portfolio`** — stable identity only; attributes are versioned.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `portfolio_id` | `id` | PK | Stable id. |
| `created_at` | `ts` |  | First creation. |

**`portfolio_version`** — portfolio definition history.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `portfolio_id` | `id` | PK, FK → `portfolio` | Portfolio. |
| `version` | `text` | PK | Monotonic revision (`0001`, `0002`, …). |
| `name` | `text` |  | Display name. |
| `parent_portfolio_id` | `id` | FK → `portfolio` | Hierarchy; null for a root. |
| `kind` | `text` |  | `book`, `desk`, `fund`, `house`. |
| `base_currency` | `text` |  | Reporting currency. |
| `aggregation` | `json` |  | PV/P&L aggregation policy. |
| `tags` | `json` |  | Free-form tags. |
| `valid_from` | `ts` |  | Business effective time. |
| `recorded_at` | `ts` |  | System time. |
| `is_current` | `bool` | UQ* | Exactly one current row per portfolio. |

`*` Partial unique index `(portfolio_id) WHERE is_current` on PostgreSQL; on SQLite use a
partial index with `WHERE is_current = 1`. Both dialects support this.

**`position_snapshot`** — one immutable as-of holdings set.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `position_snapshot_id` | `id` | PK | Content hash of the ordered position set. |
| `as_of` | `ts` | IX | Business date/time. |
| `recorded_at` | `ts` |  | System time. |
| `producer` | `json` |  | Booking source/actor. |
| `content_hash` | `text` | UQ | Hash of the canonical snapshot. |

**`position_snapshot_portfolio`** — portfolios covered by a snapshot.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `position_snapshot_id` | `id` | PK, FK → `position_snapshot` | Snapshot. |
| `portfolio_id` | `id` | PK, FK → `portfolio` | Covered portfolio. |

**`position`** — one holdings row; stable logical id plus a row id for FK integrity.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `position_row_id` | `id` | PK | Row identity within the snapshot. |
| `position_id` | `id` | IX | Stable economic position id across snapshots. |
| `position_snapshot_id` | `id` | FK → `position_snapshot` | Owning snapshot. |
| `portfolio_id` | `id` | FK → `portfolio` | Holding portfolio. |
| `instrument_id` | `id` | FK → `instrument` | Instrument. |
| `instrument_version` | `text` | FK (composite) | Terms version priced. |
| `quantity` | `double` |  | Signed; long positive, short negative (I-6). |
| `quantity_kind` | `text` |  | `units`, `notional`, `contracts`. |
| `trade_date` | `ts` |  | Trade date. |
| `settlement_date` | `ts` |  | Optional settlement date. |
| `booked_at` | `ts` |  | Booking timestamp. |
| `fx_factor_id` | `id` | FK → `factor` | Instrument→portfolio currency factor, if any. |
| `status` | `text` | IX | `open`, `closed`, `pending`. |
| `tags` | `json` |  | Desk/strategy tags. |

Constraints: `UNIQUE (position_snapshot_id, position_id)`;
`FOREIGN KEY (instrument_id, instrument_version) REFERENCES instrument_version
(instrument_id, version)`; index `(portfolio_id, status)` and `(position_id)`.

##### Market data and factors

**`factor`** — canonical factor metadata; the join key for all risk.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `factor_id` | `id` | PK | `eq:AAPL:spot`, `ir:USD:OIS:5Y`, … |
| `class` | `text` | IX | `equity`, `fx`, `rate`, `vol`, `correlation`, `credit`, `commodity`. |
| `underlying_id` | `id` | FK → `underlying` | Underlying, when applicable. |
| `currency` | `text` |  | Quote currency, when applicable. |
| `bucket_kind` | `text` |  | `tenor`, `expiry`, `strike`, `delta`, or null. |
| `bucket_value` | `text` |  | Bucket label, e.g. `5Y`, `2027-06-18`, `150`. |
| `quote` | `text` |  | `price`, `rate`, `vol`, `correlation`, `fx`, `spread`. |
| `unit` | `text` |  | `USD/share`, `decimal rate`, `vol points`, … |
| `bump_kind` | `text` |  | `relative`, `absolute`. |
| `bump_value` | `double` |  | Default bump used by sensitivities and P&L. |
| `source_provider` | `text` |  | Provider hint, not a data value. |

**`factor_set`** / **`factor_set_member`** — the factor universe of a market set.

| Table | Column | Type | Key | Description |
| --- | --- | --- | --- | --- |
| `factor_set` | `factor_set_id` | `id` | PK | Content hash of the factor set. |
| `factor_set` | `as_of` | `ts` |  | Factor-set date. |
| `factor_set` | `recorded_at` | `ts` |  | System time. |
| `factor_set_member` | `factor_set_id` | `id` | PK, FK → `factor_set` | Set. |
| `factor_set_member` | `factor_id` | `id` | PK, FK → `factor` | Member factor. |

**`market_data_set`** — a curated, factor-keyed snapshot.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `market_data_set_id` | `id` | PK | Content hash of the set. |
| `as_of` | `ts` | IX | Business date/time. |
| `captured_at` | `ts` |  | When the source data was captured. |
| `factor_set_id` | `id` | FK → `factor_set` | Factor universe. |
| `producer` | `json` |  | Adapter identity/version. |
| `sources` | `json` |  | Providers and object ids. |
| `content_hash` | `text` | UQ | Hash of the canonical set. |
| `recorded_at` | `ts` |  | System time. |

**`market_set_object`** — many-to-many membership; market objects are reusable.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `market_data_set_id` | `id` | PK, FK → `market_data_set` | Set. |
| `object_id` | `id` | PK, FK → `market_object` | Object. |

**`market_object`** — common header for every market data object.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `object_id` | `id` | PK | Content hash of the object payload. |
| `object_type` | `text` | IX | `spot`, `fx`, `fixing`, `curve`, `surface`, `correlation`. |
| `factor_id` | `id` | FK → `factor` | Primary factor for single-factor objects; null for curves/surfaces/matrices. |
| `as_of` | `ts` | IX | Object as-of. |
| `source` | `text` |  | Provider/object reference. |
| `metadata` | `json` |  | Provider-specific metadata. |

**`market_data_quality`** — per-factor completeness status for a set.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `market_data_set_id` | `id` | PK, FK → `market_data_set` | Set. |
| `factor_id` | `id` | PK, FK → `factor` | Factor. |
| `status` | `text` |  | `ok`, `stale`, `missing`, `fallback`. |
| `detail` | `text` |  | Human-readable reason. |

**`spot_quote`** — 1:1 detail for a spot object.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `object_id` | `id` | PK, FK → `market_object` | Parent object. |
| `value` | `double` |  | Spot/price. |
| `currency` | `text` |  | Quote currency. |

**`fx_quote`** — 1:1 detail for an FX object.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `object_id` | `id` | PK, FK → `market_object` | Parent object. |
| `value` | `double` |  | Rate, quote units per base unit. |
| `base_currency` | `text` |  | Base currency. |
| `quote_currency` | `text` |  | Quote currency. |

**`fixing`** — 1:1 detail for an official fixing.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `object_id` | `id` | PK, FK → `market_object` | Parent object. |
| `value` | `double` |  | Fixing value. |
| `fixing_date` | `ts` |  | Fixing date. |

**`curve`** / **`curve_pillar`** — discount/forward/credit curves.

| Table | Column | Type | Key | Description |
| --- | --- | --- | --- | --- |
| `curve` | `object_id` | `id` | PK, FK → `market_object` | Parent object. |
| `curve` | `curve_id` | `text` | IX | Logical curve id. |
| `curve` | `currency` | `text` |  | Curve currency. |
| `curve` | `kind` | `text` |  | `ois`, `sofr`, `libor`, `credit`. |
| `curve` | `day_count` | `text` |  | e.g. `ACT/365F`. |
| `curve` | `interpolation` | `text` |  | `linear`, `log-linear`, `monotone-convex`. |
| `curve_pillar` | `object_id` | `id` | PK, FK → `curve` | Curve. |
| `curve_pillar` | `tenor` | `text` | PK | `1M`, `5Y`, … |
| `curve_pillar` | `pillar_date` | `ts` |  | Absolute pillar date. |
| `curve_pillar` | `rate` | `double` |  | Zero/par rate. |
| `curve_pillar` | `factor_id` | `id` | FK → `factor` | Canonical rate factor. |

**`vol_surface`** / **`vol_surface_point`** — implied/local vol grids.

| Table | Column | Type | Key | Description |
| --- | --- | --- | --- | --- |
| `vol_surface` | `object_id` | `id` | PK, FK → `market_object` | Parent object. |
| `vol_surface` | `surface_id` | `text` | IX | Logical surface id. |
| `vol_surface` | `underlying_id` | `id` | FK → `underlying` | Underlying. |
| `vol_surface` | `kind` | `text` |  | `implied`, `local`. |
| `vol_surface_point` | `object_id` | `id` | PK, FK → `vol_surface` | Surface. |
| `vol_surface_point` | `maturity_index` | `int` | PK | Grid row index (0-based); avoids a floating-point key. |
| `vol_surface_point` | `strike_index` | `int` | PK | Grid column index (0-based). |
| `vol_surface_point` | `maturity_years` | `double` |  | Tenor value for the row. |
| `vol_surface_point` | `strike` | `double` |  | Strike value for the column. |
| `vol_surface_point` | `vol` | `double` |  | Volatility. |
| `vol_surface_point` | `factor_id` | `id` | FK → `factor` | Bucketed vol factor. |

**`correlation_matrix`** / **`correlation_pair`** — symmetric correlation data.

| Table | Column | Type | Key | Description |
| --- | --- | --- | --- | --- |
| `correlation_matrix` | `object_id` | `id` | PK, FK → `market_object` | Parent object. |
| `correlation_matrix` | `matrix_id` | `text` | IX | Logical matrix id. |
| `correlation_matrix` | `as_of` | `ts` |  | Matrix as-of. |
| `correlation_pair` | `object_id` | `id` | PK, FK → `correlation_matrix` | Matrix. |
| `correlation_pair` | `factor_a_id` | `id` | PK, FK → `factor` | Canonical first factor. |
| `correlation_pair` | `factor_b_id` | `id` | PK, FK → `factor` | Canonical second factor. |
| `correlation_pair` | `value` | `double` |  | Correlation. |

Constraint: `CHECK (factor_a_id < factor_b_id)` so the pair is stored once, not twice.

##### Valuation

**`model_config`** — deterministic pricer configuration.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `model_config_id` | `id` | PK | Content hash. |
| `pricer` | `text` |  | Registry id, e.g. `riga-flow.phoenix-mc@1`. |
| `simulation` | `json` |  | Paths, block size, seed, variance reduction, trace. |
| `calibration` | `json` |  | Calibration settings. |
| `tolerances` | `json` |  | Numerical tolerances. |
| `content_hash` | `text` | UQ | Hash of the canonical config. |

**`valuation_run`** — immutable, provenance-complete run.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `run_id` | `id` | PK | Content hash of inputs + engine build. |
| `as_of` | `ts` | IX | Valuation date. |
| `position_snapshot_id` | `id` | FK → `position_snapshot` | Holdings. |
| `market_data_set_id` | `id` | FK → `market_data_set` | Market. |
| `model_config_id` | `id` | FK → `model_config` | Model. |
| `base_currency` | `text` |  | Reporting currency. |
| `engine_name` | `text` |  | e.g. `riga-flow`. |
| `engine_version` | `text` |  | Crate/package version. |
| `engine_build` | `text` |  | Build hash/target. |
| `seed` | `text` |  | `u64` as decimal text. |
| `market_snapshot_id` | `text` |  | Engine determinism envelope value. |
| `totals` | `json` |  | PV, priced/failed/unsupported counts. |
| `status` | `text` | IX | `complete`, `partial`, `failed`. |
| `recorded_at` | `ts` |  | System time. |

**`valuation_run_portfolio`** — reporting scope of a run.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `run_id` | `id` | PK, FK → `valuation_run` | Run. |
| `portfolio_id` | `id` | PK, FK → `portfolio` | Covered portfolio. |

**`position_valuation`** — one row per priced/failed position.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `run_id` | `id` | PK, FK → `valuation_run` | Run. |
| `position_row_id` | `id` | PK, FK → `position` | Holdings row. |
| `instrument_id` | `id` |  | Denormalised for query convenience. |
| `instrument_version` | `text` |  | Terms version priced. |
| `pv_amount` | `double` |  | PV in instrument currency. |
| `pv_currency` | `text` |  | Instrument currency. |
| `pv_portfolio_amount` | `double` |  | PV after FX. |
| `pv_portfolio_currency` | `text` |  | Portfolio currency. |
| `unit_pv_amount` | `double` |  | PV per unit. |
| `unit_pv_currency` | `text` |  | Unit PV currency. |
| `mc_error_amount` | `double` |  | Optional MC error. |
| `mc_error_currency` | `text` |  | MC error currency. |
| `status` | `text` | IX | `priced`, `failed`, `unsupported`. |
| `error_code` | `text` |  | Machine-readable error. |
| `error_message` | `text` |  | Human-readable error. |
| `evidence` | `json` |  | Engine-specific evidence (opaque). |

##### Risk

**`sensitivity_set`** — sensitivities for one run and bump policy.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `set_id` | `id` | PK | Content hash of run + factor set + policy. |
| `valuation_run_id` | `id` | FK → `valuation_run` | Base run. |
| `factor_set_id` | `id` | FK → `factor_set` | Factor universe. |
| `as_of` | `ts` |  | As-of of the run. |
| `base_currency` | `text` |  | Reporting currency. |
| `bump_policy` | `json` |  | Bump sizes/methods. |
| `recorded_at` | `ts` |  | System time. |

**`sensitivity`** — one factor/measure cell.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `sensitivity_id` | `id` | PK | Surrogate id (avoids nullable composite PKs). |
| `set_id` | `id` | FK → `sensitivity_set` | Set. |
| `position_row_id` | `id` | FK → `position` | Position. |
| `factor_id` | `id` | FK → `factor` | First factor. |
| `measure` | `text` |  | `delta`, `gamma`, `vega`, `theta`, `rho`, `correlation`, `fx-delta`. |
| `cross_factor_id` | `id` | FK → `factor` | Second factor for cross-gamma; null otherwise. |
| `value` | `double` |  | Sensitivity value. |
| `unit` | `text` |  | `PV/1.0 spot`, `PV/1bp`, … |
| `currency` | `text` |  | Cash currency, when applicable. |
| `method` | `text` |  | `analytic`, `fd-crn`, `fd-independent`, `aad`. |
| `bump_kind` | `text` |  | `relative`, `absolute`. |
| `bump_value` | `double` |  | Bump used. |
| `error` | `double` |  | Optional MC/error bound. |

Constraint: unique expression index on
`(set_id, position_row_id, factor_id, measure, COALESCE(cross_factor_id, ''))`.

**`sensitivity_unsupported`** — explicit gaps.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `set_id` | `id` | PK, FK → `sensitivity_set` | Set. |
| `factor_id` | `id` | PK, FK → `factor` | Factor. |
| `measure` | `text` | PK | Unsupported measure. |
| `reason` | `text` |  | Why it could not be produced. |

**`scenario_set`** — named, versioned collection of scenarios.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `scenario_set_id` | `id` | PK | Content hash. |
| `name` | `text` |  | Display name. |
| `as_of` | `ts` |  | Set as-of. |
| `base_market_data_set_id` | `id` | FK → `market_data_set` | Optional base for relative shocks. |
| `recorded_at` | `ts` |  | System time. |
| `content_hash` | `text` | UQ | Hash of the canonical set. |

**`scenario`** — one scenario definition.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `scenario_set_id` | `id` | PK, FK → `scenario_set` | Parent set. |
| `scenario_id` | `id` | PK | Stable id within the set. |
| `name` | `text` |  | Display name. |
| `kind` | `text` |  | `historical`, `hypothetical`, `stress`, `reverse-stress`, `monte-carlo`. |
| `description` | `text` |  | Narrative. |
| `horizon_start` | `ts` |  | Optional path start. |
| `horizon_end` | `ts` |  | Optional path end. |
| `horizon_steps` | `int` |  | Optional path steps. |
| `generator` | `json` |  | Generator id/version/seed. |
| `tags` | `json` |  | Free-form tags. |

**`factor_shock`** — one shock per scenario/factor/ordinal.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `scenario_set_id` | `id` | PK, FK → `scenario` | Parent set (composite FK). |
| `scenario_id` | `id` | PK, FK → `scenario` | Scenario. |
| `shock_index` | `int` | PK | Ordinal, allows repeated factors in a path. |
| `factor_id` | `id` | FK → `factor` | Shocked factor. |
| `kind` | `text` |  | `absolute`, `relative`, `vol-points`, `multiply`. |
| `value` | `double` |  | Shock size. |
| `from_market_data_set_id` | `id` | FK → `market_data_set` | Historical source, if any. |
| `to_market_data_set_id` | `id` | FK → `market_data_set` | Historical target, if any. |

**`risk_result_set`** — all cells for one run × scenario set.

Constraint: `UNIQUE (risk_result_set_id, scenario_set_id)` so `risk_cell` can enforce that
its denormalised `scenario_set_id` matches the result set.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `risk_result_set_id` | `id` | PK | Content hash. |
| `valuation_run_id` | `id` | FK → `valuation_run` | Base run. |
| `scenario_set_id` | `id` | FK → `scenario_set` | Scenarios. |
| `as_of` | `ts` |  | As-of. |
| `base_currency` | `text` |  | Reporting currency. |
| `policy` | `json` |  | Measure aggregation/non-additivity policy. |
| `dimensions` | `json` |  | Present scenarios/positions/portfolios/measures. |
| `recorded_at` | `ts` |  | System time. |

**`risk_cell`** — tidy result row; a matrix is a pivot of these.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `risk_cell_id` | `id` | PK | Surrogate id. |
| `risk_result_set_id` | `id` | FK → `risk_result_set` | Result set. |
| `scenario_set_id` | `id` | FK (composite) | Denormalised for scenario FK. |
| `scenario_id` | `id` | FK (composite) | Scenario. |
| `position_row_id` | `id` | FK → `position` | Null for portfolio-level cells. |
| `portfolio_id` | `id` | FK → `portfolio` | Aggregation portfolio. |
| `measure` | `text` |  | `pv`, `pv-change`, `pnl`, `delta`, `gamma`, `vega`, `dv01`, `var`, `expected-shortfall`, `worst-case`. |
| `step` | `int` |  | Path step/date index; 0 for point scenarios. |
| `value` | `double` |  | Measured value. |
| `unit` | `text` |  | Unit contract. |
| `currency` | `text` |  | Cash currency, when applicable. |
| `contribution` | `double` |  | Optional contribution/share. |

Constraints: `FOREIGN KEY (scenario_set_id, scenario_id) REFERENCES scenario
(scenario_set_id, scenario_id)`;
`FOREIGN KEY (risk_result_set_id, scenario_set_id) REFERENCES risk_result_set
(risk_result_set_id, scenario_set_id)`; unique expression index on
`(risk_result_set_id, scenario_id, COALESCE(position_row_id, ''), portfolio_id, measure, step)`.

**`risk_cell_unsupported`** — scenarios/positions that could not be evaluated.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `risk_result_set_id` | `id` | PK, FK → `risk_result_set` | Result set. |
| `scenario_id` | `id` | PK | Scenario. |
| `position_row_id` | `id` | PK | Position row; `''` for portfolio-level. |
| `reason` | `text` |  | Why it was not produced. |

**`risk_matrix`** — an explicit pivot, never the only stored form.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `matrix_id` | `id` | PK | Content hash of pivot descriptor. |
| `risk_result_set_id` | `id` | FK → `risk_result_set` | Source cells. |
| `rows_dim` | `text` |  | `scenario`, `factor`, `position`. |
| `columns_dim` | `text` |  | `position`, `portfolio`, `factor`. |
| `measure` | `text` |  | Measure being pivoted. |
| `currency` | `text` |  | Reporting currency. |
| `totals` | `json` |  | Row/column/grand totals. |
| `recorded_at` | `ts` |  | System time. |

**`risk_matrix_cell`** — pivoted values.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `matrix_id` | `id` | PK, FK → `risk_matrix` | Matrix. |
| `row_key` | `text` | PK | Scenario/factor/position key. |
| `column_key` | `text` | PK | Position/portfolio/factor key. |
| `value` | `double` |  | Pivoted value. |
| `unit` | `text` |  | Unit contract. |

##### P&L

**`pnl_period`** — actual/explained/residual for a portfolio period.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `pnl_period_id` | `id` | PK | Content hash. |
| `portfolio_id` | `id` | FK → `portfolio` | Portfolio. |
| `start_run_id` | `id` | FK → `valuation_run` | Opening run. |
| `end_run_id` | `id` | FK → `valuation_run` | Closing run. |
| `start_as_of` | `ts` |  | Opening as-of. |
| `end_as_of` | `ts` |  | Closing as-of. |
| `currency` | `text` |  | Reporting currency. |
| `actual_amount` | `double` |  | Actual P&L. |
| `explained_amount` | `double` |  | Sum of attributions. |
| `residual_amount` | `double` |  | Actual − explained. |
| `reconciles` | `bool` | IX | `abs(residual) <= tolerance`. |
| `recorded_at` | `ts` |  | System time. |

**`pnl_position`** — per-position reconciliation.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `pnl_period_id` | `id` | PK, FK → `pnl_period` | Period. |
| `position_id` | `id` | PK | Stable position id (spans snapshots). |
| `start_pv_amount` | `double` |  | Opening PV. |
| `end_pv_amount` | `double` |  | Closing PV. |
| `actual_amount` | `double` |  | Actual P&L. |
| `explained_amount` | `double` |  | Explained P&L. |
| `residual_amount` | `double` |  | Residual. |
| `currency` | `text` |  | Currency. |

**`pnl_attribution`** — explained components.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `pnl_attribution_id` | `id` | PK | Surrogate id. |
| `pnl_period_id` | `id` | FK → `pnl_period` | Period. |
| `position_id` | `id` |  | Null for a portfolio-level component. |
| `kind` | `text` |  | `factor`, `theta`, `carry`, `roll`, `fx`, `new-trades`, `closed-trades`, `fees`, `residual`. |
| `factor_id` | `id` | FK → `factor` | Factor for `kind = factor`. |
| `contribution_amount` | `double` |  | Contribution. |
| `contribution_currency` | `text` |  | Currency. |
| `method` | `text` |  | `taylor`, `full-reval`, `carry-roll`, `identity`. |

Constraint: unique expression index on
`(pnl_period_id, COALESCE(position_id, ''), kind, COALESCE(factor_id, ''), method)`.

**`external_flow`** — cash flows excluded from P&L.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `flow_id` | `id` | PK | ULID. |
| `pnl_period_id` | `id` | FK → `pnl_period` | Period. |
| `position_id` | `id` |  | Optional position. |
| `kind` | `text` |  | `deposit`, `withdrawal`, `coupon`, `fee`, `trade`. |
| `amount` | `double` |  | Signed amount. |
| `currency` | `text` |  | Currency. |
| `effective_date` | `ts` |  | Flow date. |

##### Governance

**`limit_definition`** — a limit rule, effective over a date range.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `limit_id` | `id` | PK | Stable id. |
| `portfolio_id` | `id` | FK → `portfolio` | Scope. |
| `factor_id` | `id` | FK → `factor` | Optional factor scope. |
| `measure` | `text` |  | Measured quantity. |
| `currency` | `text` |  | Limit currency. |
| `threshold` | `double` |  | Limit value. |
| `direction` | `text` |  | `max` or `min` (signed). |
| `policy` | `json` |  | Hard/soft, escalation, waiver rules. |
| `valid_from` | `ts` |  | Effective from. |
| `valid_to` | `ts` |  | Effective to; null = open. |
| `recorded_at` | `ts` |  | System time. |

**`limit_break`** — an observed breach.

| Column | Type | Key | Description |
| --- | --- | --- | --- |
| `break_id` | `id` | PK | ULID. |
| `limit_id` | `id` | FK → `limit_definition` | Breached limit. |
| `risk_result_set_id` | `id` | FK → `risk_result_set` | Evidence. |
| `observed_value` | `double` |  | Observed measure. |
| `threshold` | `double` |  | Threshold at breach time. |
| `currency` | `text` |  | Currency. |
| `breached_at` | `ts` | IX | Breach time. |
| `status` | `text` |  | `open`, `waived`, `closed`. |
| `detail` | `json` |  | Waiver/approval evidence. |

#### 4.3.4 Indexes, constraints and write path

**Non-negotiable constraints.**

- Every FK is declared and enforced. SQLite needs `PRAGMA foreign_keys = ON` on every
  connection; PostgreSQL enforces it by default.
- Composite FKs are used where the identity is composite:
  `position (instrument_id, instrument_version) → instrument_version`,
  `factor_shock (scenario_set_id, scenario_id) → scenario`,
  `risk_cell (scenario_set_id, scenario_id) → scenario`.
- `CHECK` constraints freeze enums and reject non-positive quantities/multipliers where
  the product contract requires it. Enum checks are generated per dialect.
- No nullable column in a PK or `UNIQUE`; use a surrogate id or a `COALESCE` expression
  index (supported by both SQLite ≥ 3.9 and PostgreSQL).
- Cross-row invariants that SQL cannot express are enforced by the write service and
  checked by the consistency job: a `risk_cell.position_row_id` must belong to the run's
  position snapshot; a `sensitivity.position_row_id` must belong to the sensitivity set's
  run; a `pnl_position.position_id` must exist in both `start_run_id` and `end_run_id`.
  Foreign keys guarantee row existence, not temporal membership.

**Minimum index set** (beyond PK/UQ):

| Table | Index | Why |
| --- | --- | --- |
| `document` | `(schema_id, logical_id, recorded_at DESC)` | Replay/history. |
| `instrument` | `(product_template)`, `(status)` | Catalog filters. |
| `position` | `(portfolio_id, status)`, `(position_id)`, `(position_snapshot_id)` | Book reads and drill-down. |
| `market_object` | `(object_type)`, `(factor_id)`, `(as_of)` | Factor resolution. |
| `valuation_run` | `(position_snapshot_id)`, `(market_data_set_id)`, `(as_of DESC)` | Run lookup. |
| `position_valuation` | `(run_id, status)` | Partial runs. |
| `sensitivity` | `(set_id, factor_id, measure)` | Factor aggregation. |
| `risk_cell` | `(risk_result_set_id, measure)`, `(portfolio_id, measure)` | Matrix queries. |
| `pnl_period` | `(portfolio_id, end_as_of DESC)` | Period history. |
| `pnl_attribution` | `(pnl_period_id, kind)` | Waterfall. |
| `limit_break` | `(status, breached_at DESC)` | Open breaches. |

**Write path.** One short transaction per document:

```text
BEGIN IMMEDIATE (SQLite) / BEGIN (PostgreSQL)
  INSERT document (canonical envelope + payload) ON CONFLICT DO NOTHING
  UPSERT parent rows (instrument/portfolio/… — mutable only)
  INSERT child rows (immutable versions, positions, cells, …)
  INSERT audit_event
COMMIT
```

Never hold a transaction open across an engine call. Value first (possibly slow), then
write the run and its cells in one transaction. If the process dies mid-write, the
transaction rolls back and the content-addressed id can simply be retried.

**Read path.** Query the typed tables for joins/aggregations. Fetch `document.payload`
only for replay, export or unknown schema fields. The UI never queries SQL directly; it
goes through the store port/IPC.

#### 4.3.5 SQLite ↔ PostgreSQL compatibility rules

The schema is portable, but the dialects are not identical. Follow these rules; each one
is a real difference that otherwise becomes a runtime bug.

1. **No auto-increment/uuid types.** All ids are application-generated `TEXT`. This also
   makes SQLite and PostgreSQL dumps comparable.
2. **Placeholder style.** SQLite uses `?`, PostgreSQL `$1`; use one repository per dialect
   (or `sqlx::QueryBuilder`) and never string-concatenate values.
3. **`ON CONFLICT` is portable**, including `excluded.*` (lowercase). Use it for
   idempotent document/child writes.
4. **`RETURNING` is supported by modern SQLite (≥ 3.35) and PostgreSQL**, but do not rely
   on it for correctness; ids are generated before the insert.
5. **Booleans differ.** Logical `bool` → `INTEGER CHECK (c IN (0,1))` on SQLite and
   `BOOLEAN` on PostgreSQL. Shared SQL must use bound parameters, not `= TRUE`/`= 1`.
6. **Timestamps differ in type, not semantics.** SQLite stores fixed-width UTC ISO-8601
   `TEXT`; PostgreSQL stores `TIMESTAMPTZ`. Bind timezone-aware UTC values everywhere.
   Never use `CURRENT_TIMESTAMP`; the application supplies `recorded_at`.
7. **JSON differs.** SQLite has `TEXT` + `json_extract`; PostgreSQL has `JSONB` + `->>`.
   Treat `json` as opaque in shared SQL. If JSON queries are needed, write them in the
   dialect-specific repository, or project the field into a typed column.
8. **No native arrays.** Repeated values are child tables (`curve_pillar`,
   `vol_surface_point`, `correlation_pair`, `factor_shock`), not arrays/JSON blobs.
9. **No native enums.** `TEXT` + `CHECK`; the check list is part of the schema version.
10. **`ILIKE` is PostgreSQL-only.** Use `LOWER(col) LIKE LOWER(?)` if case-insensitive
    search is needed, and canonicalise ids to lowercase.
11. **Date functions differ** (`strftime` vs `date_trunc`). Compute date buckets in the
    application or keep them dialect-specific.
12. **`GROUP_CONCAT` vs `STRING_AGG`.** Avoid aggregate-to-string in shared SQL.
13. **`NULLS LAST`** is supported by both modern engines, but avoid relying on implicit
    ordering; always specify `ORDER BY`.
14. **`CAST` spelling differs** (`REAL` vs `DOUBLE PRECISION`). Bind typed parameters
    instead of casting in SQL.
15. **`NUMERIC`/`DECIMAL` is not portable.** All computed values are `double`; if exact
    decimal accounting is later required, add an integer minor-units column rather than
    switching to `NUMERIC`.
16. **SQLite writes are serialised.** Enable `journal_mode=WAL`, `busy_timeout`, and
    `foreign_keys=ON`; use `BEGIN IMMEDIATE` for write transactions. PostgreSQL uses
    MVCC; keep transactions short and retry serialization failures.
17. **SQLite has no schemas/users.** Use one file per environment; PostgreSQL can use a
    dedicated schema (`fina`) and role. Keep table names unqualified in shared SQL.
18. **Migrations are per dialect.** Keep `migrations/sqlite/000N_*.sql` and
    `migrations/postgres/000N_*.sql` with the same version ids and checksums of the
    logical schema. CI compares `information_schema`/`PRAGMA table_info` and fails if the
    table/column sets diverge. `sqlx::migrate!` compiles each directory per binary.
19. **Connection URL gotcha.** In `sqlx`, `sqlite:///book.db` is the **absolute** path
    `/book.db`; a repo-local file is `sqlite://book.db` (or `sqlite:book.db`). The current
    `.env` uses three slashes, so verify whether that is intentional. PostgreSQL uses
    `postgres://user:pass@host/db`.
20. **Do not use `sqlx::Any`.** It hides type differences and loses compile-time checking;
    dispatch to `SqliteStore`/`PostgresStore` behind one `BookStore` trait instead.

**Example — the same logical table in both dialects.** `risk_cell` exercises the hard
cases: enum check, nullable FK, composite FK, float value and an expression unique index.

```sql
-- migrations/sqlite/0007_risk.sql
CREATE TABLE risk_cell (
  risk_cell_id       TEXT PRIMARY KEY,
  risk_result_set_id TEXT NOT NULL REFERENCES risk_result_set(risk_result_set_id),
  scenario_set_id    TEXT NOT NULL,
  scenario_id        TEXT NOT NULL,
  position_row_id    TEXT REFERENCES position(position_row_id),
  portfolio_id       TEXT NOT NULL REFERENCES portfolio(portfolio_id),
  measure            TEXT NOT NULL CHECK (measure IN (
                       'pv','pv-change','pnl','delta','gamma','vega','dv01',
                       'var','expected-shortfall','worst-case')),
  step               INTEGER NOT NULL DEFAULT 0,
  value              REAL NOT NULL,
  unit               TEXT NOT NULL,
  currency           TEXT,
  contribution       REAL,
  FOREIGN KEY (scenario_set_id, scenario_id)
    REFERENCES scenario(scenario_set_id, scenario_id),
  FOREIGN KEY (risk_result_set_id, scenario_set_id)
    REFERENCES risk_result_set(risk_result_set_id, scenario_set_id)
);
CREATE UNIQUE INDEX risk_cell_uq ON risk_cell (
  risk_result_set_id, scenario_id, COALESCE(position_row_id, ''),
  portfolio_id, measure, step
);
CREATE INDEX risk_cell_by_result ON risk_cell (risk_result_set_id, measure);
```

```sql
-- migrations/postgres/0007_risk.sql
CREATE TABLE risk_cell (
  risk_cell_id       TEXT PRIMARY KEY,
  risk_result_set_id TEXT NOT NULL REFERENCES risk_result_set(risk_result_set_id),
  scenario_set_id    TEXT NOT NULL,
  scenario_id        TEXT NOT NULL,
  position_row_id    TEXT REFERENCES position(position_row_id),
  portfolio_id       TEXT NOT NULL REFERENCES portfolio(portfolio_id),
  measure            TEXT NOT NULL CHECK (measure IN (
                       'pv','pv-change','pnl','delta','gamma','vega','dv01',
                       'var','expected-shortfall','worst-case')),
  step               BIGINT NOT NULL DEFAULT 0,
  value              DOUBLE PRECISION NOT NULL,
  unit               TEXT NOT NULL,
  currency           TEXT,
  contribution       DOUBLE PRECISION,
  FOREIGN KEY (scenario_set_id, scenario_id)
    REFERENCES scenario(scenario_set_id, scenario_id),
  FOREIGN KEY (risk_result_set_id, scenario_set_id)
    REFERENCES risk_result_set(risk_result_set_id, scenario_set_id)
);
CREATE UNIQUE INDEX risk_cell_uq ON risk_cell (
  risk_result_set_id, scenario_id, COALESCE(position_row_id, ''),
  portfolio_id, measure, step
);
CREATE INDEX risk_cell_by_result ON risk_cell (risk_result_set_id, measure);
```

Migration layout:

```text
migrations/
  sqlite/
    0001_core.sql
    0002_reference.sql
    0003_positions.sql
    0004_market.sql
    0005_valuation.sql
    0006_risk.sql
    0007_pnl.sql
    0008_governance.sql
  postgres/
    0001_core.sql
    ...                    # same version ids, same logical objects
```

CI parses both directories and asserts identical table/column/index *logical* sets; the
physical types are allowed to differ only as defined in §4.3.1.

#### 4.3.6 Store port and dialect seam

```rust
pub enum DatabaseUrl { Sqlite(String), Postgres(String) }

pub trait BookStore: Send + Sync {
    fn dialect(&self) -> Dialect;
    fn put_document(&self, doc: &DocumentEnvelope<serde_json::Value>) -> Result<()>;
    fn get_document(&self, id: &str) -> Result<Option<DocumentEnvelope<serde_json::Value>>>;
    fn put_snapshot(&self, snapshot: &PositionSnapshot) -> Result<()>;
    fn latest_snapshot(&self, portfolio: &str, as_of: &str) -> Result<Option<PositionSnapshot>>;
    fn put_run(&self, run: &ValuationRun) -> Result<()>;
    fn put_risk(&self, set: &RiskResultSet) -> Result<()>;
    fn put_pnl(&self, period: &PnlPeriod) -> Result<()>;
    // …
}
```

`SqliteStore` and `PostgresStore` share the SQL *shape* and differ only in: placeholder
style, bool binding, timestamp binding, JSON binding and migration directory. Keep those
four concerns in one small module; do not let dialect branches leak into the domain.

This keeps the promise from §5: the domain and application layers never know which
database is behind `BookStore`. Switching `DATABASE_URL` from SQLite to PostgreSQL is a
configuration change plus a migration run, not a rewrite.

---

## 5. Architecture: layers, ports, registries

### 5.1 Layers and dependency rule

```text
┌────────────────────────────────────────────────────────────────────┐
│ Surfaces:  riga-mcp tools · Tauri IPC · riga-cli · React UI        │
├────────────────────────────────────────────────────────────────────┤
│ Application: book service · valuation orchestrator ·               │
│              risk orchestrator · P&L service · governance          │
├────────────────────────────────────────────────────────────────────┤
│ Domain: canonical documents · invariants · pure projections        │
├────────────────────────────────────────────────────────────────────┤
│ Ports: ReferenceStore · PositionStore · MarketDataPort ·           │
│        PricerPort · RiskPort · ResultStore · ClockPort             │
├────────────────────────────────────────────────────────────────────┤
│ Adapters: riga-flow · tac-engine · lake/DuckDB · SQL store         │
│           (SQLite/PostgreSQL) · Parquet · Murex/CSV import         │
└────────────────────────────────────────────────────────────────────┘
```

Dependencies point **down only**. Domain documents know nothing about MCP, Tauri,
DuckDB or `riga_engine`. Adapters translate between canonical documents and engine
types. This is what makes the system testable without engines and replaceable without a
rewrite.

Concretely in the existing tree:

```text
modules/riga-flow/crates/
  riga-core/        existing primitives (keep; add canonical document module or new crate)
  riga-market/      existing curves/surfaces (add factor resolution, no identity break)
  riga-risk/        existing bump/measure engine (add factor-keyed outputs)
  riga-book/        NEW: documents, ids, stores ports, portfolio/position rules
  riga-riskrun/     NEW: valuation/sensitivity/scenario/pnl orchestration
  riga-mcp/         surfaces: generic fina_* verbs + existing typed tools
```

Avoid a crate per document. Two new crates are enough: one for **book/reference**
(documents + store ports) and one for **runs** (orchestration). If the team prefers one,
merge them, but keep the module boundary inside.

### 5.2 Ports (the seams that matter)

```rust
pub trait ReferenceStore {
    fn put_instrument(&self, doc: InstrumentV2) -> Result<DocumentId>;
    fn instrument(&self, id: &str, version: Option<&str>) -> Result<InstrumentV2>;
    fn put_portfolio(&self, doc: Portfolio) -> Result<Revision>;
    fn portfolio(&self, id: &str, as_of: &str) -> Result<Portfolio>;
}

pub trait PositionStore {
    fn append(&self, snapshot: PositionSnapshot) -> Result<DocumentId>;
    fn snapshot(&self, id: &str) -> Result<PositionSnapshot>;
    fn latest(&self, portfolio_id: &str, as_of: &str) -> Result<PositionSnapshot>;
}

pub trait MarketDataPort {
    fn build_set(&self, req: MarketDataRequest) -> Result<MarketDataSet>;
    fn set(&self, id: &str) -> Result<MarketDataSet>;
}

pub trait PricerPort {
    fn describe(&self) -> PricerCapabilities;
    fn price(&self, position: &Position, instrument: &InstrumentV2,
             market: &MarketDataSet, model: &ModelConfig) -> Result<PositionValuation>;
    fn sensitivities(&self, run: &ValuationRun, factors: &FactorSet,
                     policy: &BumpPolicy) -> Result<Vec<Sensitivity>>;
}

pub trait ScenarioSource {
    fn generate(&self, spec: &ScenarioSpec, base: &MarketDataSet) -> Result<Vec<Scenario>>;
}

pub trait RiskMeasurePort {
    fn id(&self) -> &'static str;
    fn evaluate(&self, cells: &[RiskCell], policy: &RiskPolicy) -> Result<RiskCell>;
}

pub trait PnlAttributor {
    fn id(&self) -> &'static str;
    fn attribute(&self, start: &ValuationRun, end: &ValuationRun,
                 factors: &FactorSet, flows: &[ExternalFlow]) -> Result<Vec<PnlAttribution>>;
}
```

`ClockPort` exists so `recordedAt` is injectable in tests; the default reads the system
clock only at the surface, never in the domain.

### 5.3 Registries and capability negotiation

Five registries, each a map from a string id to a trait object (Rust) or a typed factory
(TS). This is the main extensibility mechanism.

| Registry | Key | Adds |
| --- | --- | --- |
| `ProductTemplate` | `phoenix-worst-of@1` | terms JSON Schema, compiled terms, pricer binding |
| `FactorProvider` | `tac.lake@1`, `murex.import@1` | resolves factors from a source into a `MarketDataSet` |
| `ScenarioGenerator` | `historical@1`, `shock@1`, `monte-carlo@1` | turns a spec into `Scenario[]` |
| `RiskMeasure` | `pv@1`, `var@1`, `es@1` | evaluates/aggregates cells under a policy |
| `PnlAttributor` | `taylor@1`, `full-reval@1` | decomposes a period |

Every engine exposes a capability document:

```ts
export interface Capabilities {
  producer: { name: string; version: string; build: string }
  productTemplates: Array<{
    templateId: string
    termsSchema: string              // JSON Schema id/url
    factors: Array<{ class: FactorClass; required: boolean }>
    measures: Measure[]
    methods: Array<'analytic' | 'fd-crn' | 'fd-independent' | 'aad'>
    scenarioKinds: ScenarioKind[]
  }>
  transports: string[]
  limits: Record<string, string>      // documented limits, e.g. max positions
}
```

The application composes from capabilities, not from hardcoded tool names. A new product
template appears in the UI catalog automatically; if a pricer cannot handle a factor or
measure, the run reports `unsupported` instead of silently approximating (I-10).

### 5.4 Schema evolution

- Each schema has a version in its id (`/v1`, `/v2`). Additive fields are allowed within a
  version; breaking changes bump the version.
- A `SchemaRegistry` holds, per schema: JSON Schema, current version, and a chain of
  migrations `vN → vN+1`. Readers accept `current` and `current-1`; writers emit only
  `current`.
- Rust is the source of truth (`serde` + `schemars`). CI generates JSON Schema and either
  generates the TS types or fails if the hand-written mirror drifts. This replaces the
  current hand-mirrored `src/features/riga/types.ts` contract with an enforced one.
- Contract tests pin: every schema validates, every `links` target resolves, every
  `factorId` used by a result exists in the referenced `FactorSet`, and every
  `runId` recomputes from its inputs.

### 5.5 Why this is extensible (concrete tests of the design)

| Change | Without registries (today) | With this architecture |
| --- | --- | --- |
| Add a second product (e.g. reverse convertible) | new tool, new params, new hook, new tile | register template + terms schema + pricer binding |
| Add a rate factor to risk | change `MarketSnapshot`, bump arrays, new tile | add factor to `FactorSet`, market provider emits it |
| Add a scenario kind | new tool | register `ScenarioGenerator` |
| Add VaR/ES | new bespoke endpoint | register `RiskMeasure`, same result set |
| Add a market source | edit `tac-engine` | new `FactorProvider` adapter |
| Add a currency | implicit, easy to get wrong | add FX factor; policy enforces conversion |
| Add an attribution method | new `pl_explain` shape | register `PnlAttributor` |

---

## 6. Surface contracts (MCP and IPC)

### 6.1 Generic verbs, additive to the existing 35 tools

| Tool | Input | Output |
| --- | --- | --- |
| `fina_capabilities` | — | `Capabilities` |
| `fina_document_put` | envelope | `{ id, version }` |
| `fina_document_get` | `{ schema, id, version? , asOf? }` | envelope |
| `fina_document_query` | `{ schema, filter, asOf? }` | envelope summaries |
| `fina_market_set` | `{ asOf, portfolioId, factors?, sources? }` | `MarketDataSet` |
| `fina_value` | `{ positionSnapshotId, marketDataSetId, modelConfig }` | `ValuationRun` |
| `fina_sensitivities` | `{ runId, bumpPolicy }` | `SensitivitySet` |
| `fina_risk` | `{ runId, scenarioSetId, measures }` | `RiskResultSet` |
| `fina_risk_matrix` | `{ riskRunId, rows, columns, measure }` | `RiskMatrix` |
| `fina_pnl` | `{ portfolioId, startRunId, endRunId, flows }` | `PnlPeriod` |
| `fina_pnl_explain` | `{ pnlPeriodId, method }` | `PnlPeriod` with attribution |

These are **document-in/document-out**. They do not encode product-specific parameters, so
they do not grow with the number of products. The existing typed tools (`price_trade`,
`risk_batch`, …) remain as convenience wrappers and for backward compatibility; internally
they call the same orchestrators.

### 6.2 Error and partial-result contract

- Every result carries `status` per position/cell, not one global success flag.
- Errors use the existing `{ code, message }` shape (`RigaError`).
- Unsupported capabilities are data (`unsupported[]`), not exceptions, so a portfolio
  with one unsupported trade still values the rest.
- No tool returns a number without its `runId`/`setId` provenance.

### 6.3 UI contract

Tiles consume **documents**, not bespoke payloads. New tiles are generic viewers:
`SensitivityTable`, `ScenarioTable`, `RiskMatrixHeatmap`, `PnlWaterfall`, `PositionBook`.
A product or factor change updates data, not tile code. The existing `TileRenderer` switch
stays for legacy tiles; new portfolio tiles register in the catalog with document
selectors.

State ownership: the Rust store is authoritative. The webview keeps a cache keyed by
document id/version, not the business source of truth. This removes the current pattern
where `instrumentStore` persists the only copy in `localStorage`.

---

## 7. Storage, performance and reproducibility

### 7.1 Storage

- **One SQL schema, two dialects.** SQLite is the default (`DATABASE_URL` in `.env`) and
  PostgreSQL is the production target; confirm the SQLite path form with the gotcha in
  §4.3.5 rule 19. The complete relational schema, ER diagram, type mapping and portability
  rules are in §4.3. Use `sqlx` (already a dependency of `riga-server`) with a `BookStore`
  port and `SqliteStore`/`PostgresStore` adapters; do not introduce a second ORM.
- **Canonical log + typed projection.** `document` stores the canonical envelope and
  payload; the typed tables are the queryable projection, written in the same
  transaction. `document` is the replay/audit/forward-compatibility record, not a second
  source of truth.
- **Market lake**: `tac-engine`'s DuckDB/Parquet lake remains the source for raw
  bars/fixings/surfaces; `MarketDataSet` is the curated, factor-keyed snapshot used by
  risk and is persisted in SQL.
- **Large series** (path/PV distributions) stay in Parquet/Arrow keyed by `runId`; the SQL
  document holds a reference and summary statistics. Do not put million-row paths into
  `risk_cell`.
- **No business state in `localStorage`** beyond disposable UI layout/cache (I-8).

### 7.2 Performance and caching

- `runId`/`setId` are content hashes, so repeated requests are cache lookups.
- Portfolio valuation fans out per position; the engine supports batching. Start with
  bounded parallelism and an explicit `maxPositions` capability; do not silently drop.
- Sensitivity runs reuse the base valuation (CRN) rather than repricing the base for every
  factor. This matches `price_central_greeks` today.
- Progressive results: `fina_value` may return `partial` with per-position status; the
  UI shows progress rather than blocking on the slowest trade.
- Async task handling already exists (`price_book_async`, SEP-2663). Reuse it for
  portfolio runs; do not invent a second job mechanism.

### 7.3 Reproducibility

A run is reproducible iff these are recorded and unchanged: `positionSnapshotId`,
`marketDataSetId`, `modelConfig` (including seed and variance reduction),
`engine.version/build`, and the factor bump policy. The existing determinism envelope
(`seed`, `as_of`, `market_snapshot_id`) is a subset; extend it to the run level rather
than duplicating it.

---

## 8. Migration plan (additive, phase by phase)

Each phase is one reviewable change with an exit gate. No phase breaks the existing
tiles or the frozen tool surface.

### P0 — Conventions and contracts (no behaviour change)

- Add the `fina.*` document types + JSON Schema generation + ids/units/time conventions.
- Add `factorId` to the TS mirror and a contract test that every current market array has
  a factor mapping.
- Add a schema registry skeleton and a `fina_capabilities` stub.
- Add the §4.3 logical schema and generate the paired SQLite/PostgreSQL migrations; add a
  CI check that the two table/column sets match.
- **Gate:** existing 213 tests + golden transcript pass; schemas validate; both migration
  sets apply to an empty database; no runtime behaviour changes.

### P1 — Reference data and positions

- `riga-book`: instrument v2 (terms-only), portfolio hierarchy, position snapshots.
- `BookStore` with `SqliteStore` (default `DATABASE_URL`) and `PostgresStore`; Tauri IPC /
  MCP CRUD; import `fina.instrument/v1` through an adapter.
- UI: a read-only Position Book tile backed by the store.
- **Gate:** book a v1 instrument, create a portfolio, append two position snapshots, read
  the latest by `asOf`; round-trip equality and audit trail verified. The same test suite
  runs against SQLite and a disposable PostgreSQL instance (CI service container).

### P2 — Market data sets and factor mapping

- `tac-engine` adapter builds a `MarketDataSet` from the lake: asset master, calendar,
  bars/fixings, curves, vol-surface cache, FX.
- Factor mapping for the two current underlyings; quality flags for missing/stale.
- `fina_market_set` returns a content-addressed set; no zeros for missing inputs.
- **Gate:** two runs over the same `asOf` produce the same `marketDataSetId`; a missing
  series yields `quality: missing` and an explicit unsupported result downstream.

### P3 — Valuation runs with provenance

- `riga-riskrun` orchestrates `PricerPort` over a position snapshot; `price_trade` becomes
  the single-position adapter.
- `runId` content hash; per-position status; totals; determinism envelope.
- `fina_value`; async reuse of `price_book_async`.
- **Gate:** value a 2-position book where one is unsupported; the run succeeds partially,
  totals reconcile with priced positions, and replaying the same inputs hits the cache.

### P4 — Factor-keyed sensitivities and real aggregation

- Extend `riga-risk` outputs to `Sensitivity { factorId, measure, unit }`; add bucketed
  vega and cross-gamma via `crossFactorId`.
- Replace `aggregate_portfolio`'s index summation with factor-keyed aggregation; keep the
  old function as a single-trade helper if needed.
- `fina_sensitivities`; `RigaBookRisk` tile consumes the new set.
- **Gate:** two trades with reversed underlying order produce identical book delta/gamma/
  vega as the same trades in matching order. This is the regression test for G5.

### P5 — Scenarios and the risk matrix

- `ScenarioSet` authoring: hypothetical shocks, historical replay from two market sets,
  Monte-Carlo via a registered generator.
- `fina_risk` runs the set through the pricer with factor shocks; `fina_risk_matrix`
  pivots cells with an explicit policy.
- Tiles: scenario table + matrix heat map.
- **Gate:** a 3-scenario × 2-position matrix reproduces each cell by an independent full
  revaluation within tolerance; VaR/ES cells are marked non-additive in the policy.

### P6 — P&L and attribution

- `PnlPeriod` from two valuation runs; actual vs explained vs residual.
- Attributors: Taylor (reuse `pnl_explain`), full reval, carry/roll, FX, new/closed trades.
- Tiles: P&L waterfall + residual trend.
- **Gate:** `explained + residual = actual` for every position and the portfolio; a known
  market move explains P&L to a documented tolerance; residual is reported, not hidden.

### P7 — Governance and scale

- Limits per portfolio/factor, baseline/approval workflow, audit export.
- Performance: batching, async, cache eviction, Parquet series.
- **Gate:** a limit breach is reproducible from stored documents; an audit export
  reconstructs every reported number from ids alone.

---

## 9. Decisions to lock before coding

1. **Risk scope.** Start with market risk (delta/gamma/vega/theta/rho/corr, scenarios,
   P&L). Credit/counterparty/XVA later. *Recommendation: market risk first.*
2. **Currency.** Day-1 `Money` + FX factors, with portfolio-currency PV computed and both
   recorded. *Recommendation: yes; retrofitting currency is expensive.*
3. **Bitemporal depth.** `asOf` + `recordedAt` on every document from day 1; full
   as-known-at queries later. *Recommendation: timestamps day 1, query engine later.*
4. **Storage.** One portable relational schema: SQLite by default, PostgreSQL in
   production, `document` as append-only canonical log and typed tables as projection.
   *Recommendation: yes; no external database to operate in phase 1, no rewrite later.*
5. **Instrument split.** Add `fina.instrument/v2` (terms-only) and keep `v1` as a
   projection. *Recommendation: yes; do not mutate v1 semantics in place.*
6. **Product model.** Define the template seam now, keep Phoenix as the only compiled
   template. *Recommendation: do not build a general payoff DSL yet.*
7. **Tool surface.** Add generic `fina_*` verbs; keep the 35 typed tools. *Recommendation:
   additive, with typed tools delegating to the same orchestrators.*
8. **Result storage.** Long `RiskCell` rows + matrix projections. *Recommendation: yes;
   never store only the pivoted matrix.*
9. **P&L residual.** Report it from day 1 even if it is large. *Recommendation: yes; it is
   the model-risk signal.*
10. **Schema ownership.** Rust `schemars` → JSON Schema → generated TS. *Recommendation:
    yes; hand-mirroring is the current drift risk.*

Open questions for the product side (not blocking P0–P2):

- Is the first book single-currency equity worst-of only, or multi-currency from day 1?
- Which risk measures are required at go-live: sensitivities + scenarios only, or VaR/ES?
- Is a historical market-data history available in the lake for backtesting/replay, or
  must historical scenarios be authored?
- Who owns limits: risk management (hard blocks) or the desk (soft warnings)?

---

## 10. What this deliberately does **not** do

- It does not change pricing math or the `PriceRequest` hot path.
- It does not introduce a general product/payoff DSL; it defines the seam for one.
- It does not make the webview the system of record.
- It does not add a bespoke tool, hook and tile per product or measure.
- It does not invent market data; missing inputs are explicit.
- It does not collapse risk and P&L into one object; they share factors and runs, not
  semantics.

The test of the architecture is simple: **adding a product, a factor, a scenario kind or a
measure should add a registry entry and a document adapter — not a new cross-cutting
pipeline.**
