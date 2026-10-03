# PHASE 1 MIGRATION PROMPT — `fina-builder` PoC → Production (Rust Core + Hybrid Transports)

> **This file is an executable specification for a coding agent.** Every requirement below is
> deliberately unambiguous: exact file paths, exact function signatures, exact formulas, exact
> commands, and explicit acceptance criteria. Where a decision had to be made, the decision is
> stated with its rationale so it is not re-litigated mid-implementation.
>
> **Target repo:** `/home/data/git/haymant/fina-builder`
> **Reference architecture:** `duckle` (Tauri IPC + HTTP shim + shared Rust crates)
> **Testing:** Rust unit + adapter tests, Vitest unit + integration tests. **No Playwright.**

---

## 0. How to use this document

Work through **Phase 0 → Phase 6 in order**. Each phase lists:

- **Goal** — the one outcome that must be true when the phase ends.
- **Tasks** — concrete edits with target file paths.
- **Exit criteria** — commands that must pass. Do not advance until they do.
- **Commit** — the commit message to use when the phase is green.

Rules of engagement:

1. **Do not begin Phase 1 before Phase 0 exit criteria pass.** Phase 0 produces the parity
   baseline that every later phase is validated against.
2. **Never change a numeric formula to "improve" it.** The formulas are heuristic demo
   formulas. They are being *relocated*, not *repaired*. Numeric changes are Phase 2 scope and
   require a separate decision record. See §5 Invariant I-1.
3. **Never delete or rename a frontend tile** in Phase 1. 51 tiles must keep working.
4. If a requirement here conflicts with the code, **the code wins for behaviour and this
   document wins for structure** — then update this document in the same commit.
5. When a task is ambiguous, prefer the option that keeps the existing UI pixel-behaviour
   identical.

---

## 1. Mission

Convert `fina-builder` from a client-side prototype into a production-shaped application in
which **all domain/business logic lives in a single Rust crate (`fina-kernel`)**, exposed through
**thin transport adapters** (Tauri IPC for desktop, HTTP/REST for web, CLI for headless), with
the **same React frontend** running unchanged in browser and desktop modes.

The frontend must stop computing domain values. It becomes a rendering and interaction layer
over a transport-agnostic API.

**Definition of "done" for Phase 1:** the app renders the same dashboards, tiles, charts and
numbers it renders today; the numbers are produced by Rust; the Rust output is provably
identical to the pre-migration TypeScript output; and the whole system is covered by fast,
deterministic automated tests.

---

## 2. Ground truth — verified current repository state

Read this section as fact, not assumption. It was measured, not inferred.

### 2.1 Size and composition

| Metric | Value |
| --- | --- |
| Total TS/TSX lines under `src/` | **2,634** |
| TS files | 15 |
| TSX files | 30 |
| Rust logic lines in `src-tauri/src/` | **16** (`lib.rs` = 15, `main.rs` = 6; both shell-only) |
| `#[tauri::command]` functions | **0** |
| Automated tests | **0** |
| Tile types in `TileType` union | **51** |
| Catalog entries | **51** |
| Built-in dashboards | 6 |
| Role templates | 9 (8 role + `Executive Dashboard`) |
| Generated paths | 100 |
| Observations per path | 60 |
| Date range | `2024-01-15` → `2028-12-15` (monthly) |
| PRNG seed | `42` (mulberry32) |

> **Correction:** `FEATURE.ts.md` states "52 tile types". The measured value is **51**. Do not
> propagate the 52 figure into new code or docs.

### 2.2 Toolchain present in the environment

- `cargo 1.97.1`, `rustc 1.97.1` at `/home/zhaoli/.cargo/bin/`
- `node v24.19.0`, `npm 12.0.2`
- `npx tsx` resolves (v4.23.15) — required for Phase 0 fixture regeneration
- `src-tauri/target/` already contains a prior debug build, so Tauri deps are likely installed.
  **Verify** before assuming; see Phase 6.

### 2.3 Domain logic inventory — what must move to Rust

| # | TS source | LOC | Nature | Rust destination |
| --- | --- | --- | --- | --- |
| L1 | `src/mock-data/generatePaths.ts` | 820 | Deterministic path-synthesis engine + branch stats + distributions + node details | `fina-kernel::path_generator` |
| L2 | `src/mock-data/mcDiagnostics.ts` | 8 | Static convergence series | `fina-kernel::diagnostics` |
| L3 | `src/store/tradeEconomicsStore.ts` → `deriveTradeAnalytics` | 10 | Heuristic trade analytics | `fina-kernel::economics` |
| L4 | `src/features/pathcube/riskEngine.ts` → `computeRisk` | 4 | Heuristic Greeks/bucket vega/cross gamma | `fina-kernel::risk_engine` |
| L5 | `src/store/cashflowStore.ts` → `buildCashflows` + analytics | 9 | Cashflow schedule + PV + P&L | `fina-kernel::valuation::cashflow` |
| L6 | `src/store/valuationExplainStore.ts` → `useValuationExplain` | 10 | Taylor explain + PLVA | `fina-kernel::valuation::explain` |
| L7 | `src/store/explainLedgerStore.ts` → `useExplainLedger` | 9 | Explain ledger + reconciliation | `fina-kernel::valuation::explain` |
| L8 | `src/features/payoff-graph/data/graphLayout.ts` | 91 | Graph layout + edge/state resolution | **Stays in TS** (§9 O-3) |
| L9 | `src/features/payoff-graph/data/executionContexts.ts` | 3 | Pure projection over a path | `fina-kernel::lifecycle` (or keep TS — §9 O-4) |

### 2.4 What must **not** move to Rust in Phase 1

All of the following are presentation/UI state and stay in TypeScript unchanged:
dashboards & layouts, tile catalog, notebook (`dashboardDocsStore`), theme, tile rendering,
charts (ECharts/XYFlow/AG Grid), path-selection UI state, trade-economics and market-data
**input controls**, `localStorage` persistence.

### 2.5 localStorage keys (must keep working, unchanged)

| Key | Owner |
| --- | --- |
| `fina-workspace` | `explorerStore` (dashboards, layout, theme) |
| `fina-trade-economics` | `tradeEconomicsStore` |
| `fina-market-data` | `marketDataStore` |
| `fina-dashboard-docs` | `dashboardDocsStore` (notebook) |
| `fina-notebook-width` | notebook drawer UI |

**Invariant I-6:** no key is renamed, no value shape changes, no migration script is required.
A user upgrading from the PoC must keep their dashboards, notes and trade terms.

---

## 3. Corrections to the draft roadmap (read before planning)

The supplied draft roadmap contains claims and structure that are wrong or unsafe. This prompt
supersedes it. Do not reintroduce these points.

| Draft claim | Reality | Decision |
| --- | --- | --- |
| Phase 1 goals marked `✅` complete | Nothing is done. `src-tauri/src/` is a 16-line shell with zero domain logic and zero tests. | Treat all Phase 1 work as **not started**. |
| "`generatePaths.ts` logic" as if it were a pricing model | It is a *scenario-constrained path synthesiser*. It assigns each path one of 4 scenarios (`ko`, `alive_ki_cash`, `alive_ki_physical`, `alive_no_ki`) then **forces** the price series to satisfy that scenario's KO/KI constraints via clamping and injection. It is not calibrated, not GBM, not a pricer. | Port it as a **deterministic demo engine** and label it as such. Do not claim pricing capability. |
| Frontend moves to `frontend/` | Moving 45 files breaks `vite.config.ts`, `tsconfig.app.json` (`include: ["src"]`), `tauri.conf.json` (`frontendDist`), Tailwind content globs, and every relative import — for zero functional benefit. | **Keep the frontend at `src/`.** Explicit deviation from draft. |
| Crate dir `src-core/` | Name/dir mismatch; also `src/`-prefixed dirs collide conceptually with the frontend. | Use `crates/fina-kernel/`. |
| "Maintain 100% feature parity across all transports" | Only 2 transports ship in Phase 1 (Tauri + HTTP). CLI is a third. MCP is deferred. | "Parity" = **identical JSON for identical input** across the transports that ship, enforced by a test. Not 100% of app features. |
| "Frontend unit tests: 75% coverage of React components" | The domain-heavy tiles are thin wrappers; ECharts/XYFlow/AG Grid internals are untestable at unit level. Coverage % on this codebase is a misleading target. | Replace with **behavioural** targets: 100% of `fina-kernel` pure functions; explicit named tests per transport; a floor of 70% on `fina-kernel` and 60% on new frontend bridge/store code. Exclude `*.test.tsx` and chart wrappers from the denominator. |
| `totalPaths: 100_000` in branch stats | A **display-scale artifact**. Ratios are measured on 100 sample paths then scaled ×1000 to a fictional population. Confirmed: `koTriggered` etc. are `round(count/100 * 100_000)`. | **Preserve the number exactly** for UI parity, but add `samplePathCount: 100` and a `scaled: true` flag to the payload and document it. See §5 I-4. |
| `gamma` is a risk Greek | In `computeRisk`, `pvUp = base + 0.08`, `pvDown = base - 0.08` about a fixed base, so `pvUp - 2*base + pvDown ≡ 0` ⇒ **gamma is identically 0.00**. Confirmed in golden fixture. | Port verbatim. Do **not** "fix". Document as a known demo artifact in code comment + test. |
| Draft implies Trade Economics should drive paths | `BARRIERS` in `generatePaths.ts` (`ki 0.70, ko 1.00, coupon 0.75–1.00, rate 0.008`) **differs from** `DEFAULT_TRADE_ECONOMICS` (`ki 0.60, ko 1.00, coupon 0.70–1.20, rate 0.12`). Paths ignore trade inputs entirely. This is the documented inconsistency in `FEATURE.ts.md` §"Path and payoff example". | Preserve. Keep as **two separate constants**. Wire-up is Phase 2. Add a test asserting they are distinct. |

---

## 4. Target architecture

The layering rule, stated once:

> **Transport ≠ Business logic.** Every adapter is a thin, mechanical translation
> (deserialize → call `fina-kernel` → serialize). No adapter contains a formula, a branch on
> domain data, or a default value.

```
┌──────────────────────────────────────────────────────────────┐
│  React 19 + TS frontend — ONE codebase, unchanged location    │
│  src/  (browser build + Tauri build)                          │
└───────────────┬──────────────────────────────┬───────────────┘
                │                              │
      ┌─────────▼─────────┐          ┌─────────▼─────────┐
      │  Desktop mode     │          │  Web mode         │
      │  Tauri IPC        │          │  HTTP POST + SSE  │
      └─────────┬─────────┘          └─────────┬─────────┘
                │                              │
      ┌─────────▼─────────┐          ┌─────────▼─────────┐
      │ src-tauri         │          │ crates/fina-server│
      │ #[tauri::command] │          │ actix-web routes  │
      │ tauri Channel<T>  │          │ SSE stream        │
      └─────────┬─────────┘          └─────────┬─────────┘
                │            ┌─────────────────┘
                │            │
      ┌─────────▼────────────▼───────────────────────────────┐
      │  crates/fina-kernel  —  ALL business logic             │
      │  path_generator · risk_engine · valuation ·          │
      │  economics · diagnostics · types · error             │
      │  ZERO transport / UI / framework dependencies        │
      └─────────┬───────────────────────────────────────────┘
                │
      ┌─────────▼─────────┐        ┌──────────────────┐
      │ crates/fina-cli   │        │ crates/fina-mcp  │  Phase 2 (stub only)
      │ clap → core       │        │ JSON-RPC → core  │
      └───────────────────┘        └──────────────────┘
```

**`fina-kernel` dependency allowlist (hard constraint):** `serde`, `serde_json`, `thiserror`,
`chrono` (or `time`). Nothing else. No `tauri`, no `actix-web`, no `clap`, no `tokio`, no
`rand`, no `nalgebra`. CI must fail if this is violated (Phase 6 lint).

**Progress streaming:** core exposes callbacks (`impl FnMut(ProgressEvent)`), never channels.
Adapters bridge: Tauri → `tauri::ipc::Channel<ProgressEvent>`; HTTP → SSE `text/event-stream`;
CLI → stderr lines. This keeps core runtime-agnostic and unit-testable.

---

## 5. Non-negotiable invariants

These are checked by tests. If a test for an invariant does not exist, it is not done.

| ID | Invariant |
| --- | --- |
| **I-1** | For the fixed fixture inputs, every numeric output of `fina-kernel` equals `golden.json` **bit-for-bit** (IEEE-754 `f64` equality, same summation order). No tolerance on core values. |
| **I-2** | `generate_paths(SimulationConfig::demo())` is **pure and deterministic**: same input → identical bytes, forever, on any platform. Verified by hashing output twice and by a committed digest. |
| **I-3** | All JSON crossing any transport uses **camelCase** keys and is **byte-identical across Tauri, HTTP and CLI** for identical input. |
| **I-4** | `branchStats` keeps `totalPaths = 100_000` and all six scaled counts exactly as today, **and** additionally reports `samplePathCount: 100` and `scaled: true`. |
| **I-5** | `PathCube`, `FixingSchedule` and the other 9 payoff nodes keep their exact ids, labels and display strings. Graph/tile code depends on these strings. |
| **I-6** | The 5 `localStorage` keys and their value shapes are unchanged (§2.5). |
| **I-7** | All 51 tiles still render. A tile that needs backend data renders a defined loading state (§8.4) and then the identical value it renders today. |
| **I-8** | `fina-kernel` has no transport/UI dependencies (§4 allowlist). |

---

## 6. Repository layout (final)

```
fina-builder/
├── Cargo.toml                        # NEW workspace root
├── rust-toolchain.toml               # NEW: pin stable
├── .github/workflows/ci.yml          # NEW Phase 6
├── scripts/
│   └── generate-golden-fixture.ts    # NEW Phase 0 (already created — verify)
├── crates/
│   ├── fina-kernel/                    # NEW — business logic
│   │   ├── Cargo.toml
│   │   ├── src/
│   │   │   ├── lib.rs                # re-exports; no logic
│   │   │   ├── error.rs              # FinaError + code enum
│   │   │   ├── jsnum.rs              # js_round, js_to_fixed2/3/4
│   │   │   ├── rng.rs                # mulberry32
│   │   │   ├── types.rs              # ProductBarriers, SimulationPath, ...
│   │   │   ├── progress.rs           # ProgressEvent
│   │   │   ├── path_generator/
│   │   │   │   ├── mod.rs            # generate_paths()
│   │   │   │   ├── scenario.rs       # scenario assignment + performance series
│   │   │   │   ├── payoff.rs         # observations, payoff, attribution, traversal
│   │   │   │   ├── node_details.rs   # per-node explain snapshots
│   │   │   │   ├── stats.rs          # branch stats + distributions
│   │   │   │   └── tests.rs
│   │   │   ├── economics.rs          # derive_trade_analytics + presets
│   │   │   ├── risk_engine/
│   │   │   │   ├── mod.rs            # compute_risk
│   │   │   │   └── tests.rs
│   │   │   ├── diagnostics.rs        # MC convergence series
│   │   │   ├── valuation/
│   │   │   │   ├── mod.rs
│   │   │   │   ├── cashflow.rs
│   │   │   │   ├── explain.rs        # Taylor + PLVA
│   │   │   │   ├── ledger.rs         # explain ledger + reconciliation
│   │   │   │   └── tests.rs
│   │   │   └── lifecycle.rs          # execution events (if L9 moves)
│   │   └── tests/
│   │       ├── golden_parity.rs      # THE parity gate
│   │       └── fixtures/golden.json  # DONE — 3.1 MB baseline
│   ├── fina-server/                  # NEW — Actix-web adapter
│   ├── fina-cli/                     # NEW — clap adapter
│   └── fina-mcp/                     # NEW — stub only (Phase 2)
├── src/                              # UNCHANGED frontend location
├── src-tauri/                        # EXISTING — becomes a thin adapter
└── FEATURE.ts.md                     # renamed from FEATURE.md (DONE)
```

**Note:** `crates/fina-kernel/tests/fixtures/golden.json` is a committed binary-ish artifact.
Add to `.gitattributes` as `-diff` to avoid merge noise.

---

## 7. Phase breakdown

### Phase 0 — Parity baseline ✅ ALREADY COMPLETE, VERIFY IT

**Goal:** a committed golden capture of current TypeScript output, so every later phase is
provably non-regressive.

Tasks:
1. **Verify** `scripts/generate-golden-fixture.ts` exists and `crates/fina-kernel/tests/fixtures/golden.json` is present.
2. Re-run `npx tsx scripts/generate-golden-fixture.ts` and confirm `git diff` on the fixture is **empty** (determinism check — Invariant I-2).
3. Record the committed values in your Phase 1 notes:

   | Quantity | Golden value |
   | --- | --- |
   | `paths.length` | `100` |
   | `branchStats.totalPaths` | `100000` |
   | `distributions.totalPayoff.mean` | `115.62` |
   | `risk.pv` | `154.03` |
   | `risk.gamma` | `0` |
   | `cashflow.presentValue` | `94.89` |
   | `valuation.taylor.predicted` | `1.6860000000000004` |
   | `trade.analytics.expectedPv` | `103.21` |
   | `paths[0].dates[0]` / `[-1]` | `2024-01-15` / `2028-12-15` |

4. Add `crates/fina-kernel/tests/fixtures/golden.json -diff` handling to `.gitattributes`.

> ⚠️ `taylor.predicted = 1.6860000000000004` — the trailing `04` is real IEEE-754 behaviour, not
> noise. It must be reproduced exactly. This pins **summation order** (see §10 P-1).

**Exit criteria**
```bash
npx tsx scripts/generate-golden-fixture.ts
git diff --exit-code crates/fina-kernel/tests/fixtures/golden.json
```

**Commit:** `chore: capture golden parity fixture from TypeScript implementation`

---

### Phase 1 — `fina-kernel` crate skeleton + numerics

**Goal:** a compiling, dependency-clean `fina-kernel` with the JS-compatible numeric
primitives and the domain type system.

Tasks:

1. `Cargo.toml` (workspace root):
   ```toml
   [workspace]
   resolver = "2"
   members = ["crates/fina-kernel", "crates/fina-server", "crates/fina-cli", "crates/fina-mcp", "src-tauri"]
   [workspace.package]
   version = "0.1.0"
   edition = "2021"
   rust-version = "1.77"
   license = "MIT"
   [workspace.dependencies]
   serde = { version = "1.0", features = ["derive"] }
   serde_json = "1.0"
   thiserror = "2.0"
   chrono = { version = "0.4", default-features = false, features = ["std"] }
   ```

2. `rust-toolchain.toml`: `channel = "stable"`, `components = ["rustfmt", "clippy"]`.

3. `crates/fina-kernel/Cargo.toml`: deps exactly `serde`, `serde_json`, `thiserror`, `chrono` +
   `[dev-dependencies] serde_json`.

4. **`crates/fina-kernel/src/jsnum.rs`** — JS-semantics numeric helpers. This module is the
   single most important correctness file in the migration.

   ```rust
   /// Replicates JavaScript `Math.round`: rounds half toward +Infinity.
   /// MUST NOT use f64::round() — Rust rounds half away from zero, so
   /// Math.round(-2.5) == -2 but (-2.5f64).round() == -3.
   pub fn js_round(v: f64) -> f64;

   pub fn round4(v: f64) -> f64;   // js_round(v * 1e4) / 1e4
   pub fn round2(v: f64) -> f64;   // js_round(v * 1e2) / 1e2
   pub fn round3(v: f64) -> f64;   // js_round(v * 1e3) / 1e3
   pub fn round1(v: f64) -> f64;   // js_round(v * 1e1) / 1e1
   ```
   Reference JS semantics for the negative half case, all of which must hold:
   `js_round(2.5)=3, js_round(-2.5)=-2, js_round(1.5)=2, js_round(-1.5)=-1, js_round(0.5)=1`.

5. **`crates/fina-kernel/src/rng.rs`** — mulberry32, bit-exact with the TS:
   ```rust
   pub struct Mulberry32 { t: u32 }
   impl Mulberry32 {
       pub fn new(seed: u32) -> Self;
       pub fn next_u32(&mut self) -> u32;
       pub fn next_f64(&mut self) -> f64;  // next_u32() as f64 / 4_294_967_296.0
   }
   ```
   Body must use `wrapping_add`/`wrapping_mul`/`wrapping_shr` to mirror JS 32-bit semantics:
   ```rust
   self.t = self.t.wrapping_add(0x6D2B_79F5);
   let mut r = (self.t ^ (self.t >> 15)).wrapping_mul(1 | self.t);
   r ^= r.wrapping_add((r ^ (r >> 7)).wrapping_mul(61 | r));
   let r = r ^ (r >> 14);
   ```
   The TS consumes **4 RNG draws per path** in a fixed order (scenario pick, 3 initial spots).
   Draw order is part of the contract — a reordered draw changes every downstream number.

6. **`crates/fina-kernel/src/types.rs`** — mirror `src/features/shared/types.ts` exactly:
   `ProductBarriers`, `PathObservation`, `PathAttribution`, `SimulationPath`,
   `NodeDetailSnapshot`, `BranchStats`, `DistributionStats`, `SimulationBundle`.
   Add `#[serde(rename_all = "camelCase")]` to **every** struct and enum (Invariant I-3).
   `PayoffNodeId` → `#[serde(rename_all = "PascalCase")]` enum with all 12 variants
   (`PathCube`, `FixingSchedule`, `WorstOfPerformance`, `KnockInGate`, `GlobalKOGate`,
   `RangeAccrual`, `CouponStrip`, `MemoryCarry`, `DownAndInPut`, `Redemption`, `Discount`,
   `AggregatePV`) and `#[serde(other)]`-equivalent fallibility for unknown values.
   `settlementType` → `#[serde(rename_all = "lowercase")]` (`cash|physical|none`).
   Add to `BranchStats`: `sample_path_count: u32` and `scaled: bool` (Invariant I-4).

7. **`crates/fina-kernel/src/error.rs`**:
   ```rust
   #[derive(Debug, thiserror::Error)]
   pub enum FinaError {
       #[error("invalid barrier configuration: {0}")] InvalidBarriers(String),
       #[error("path index {index} out of range (bundle has {len})")] PathOutOfRange { index: usize, len: usize },
       #[error("unknown node id: {0}")] UnknownNode(String),
       #[error("invalid market state: {0}")] InvalidMarket(String),
       #[error("path generation failed: {0}")] Generation(String),
   }
   impl FinaError {
       pub fn code(&self) -> &'static str;  // "INVALID_BARRIERS", "PATH_OUT_OF_RANGE", ...
   }
   ```
   Codes are a **stable public contract** consumed by HTTP status mapping (§8.2) and MCP error
   codes. Changing a code string is a breaking change.

8. `crates/fina-kernel/src/progress.rs`: `ProgressEvent { phase: String, completed: u32, total: u32, message: String }`, `#[serde(rename_all = "camelCase")]`.

9. `crates/fina-kernel/src/lib.rs`: `#![forbid(unsafe_code)]`, `#![warn(missing_docs)]`, module
   declarations, and re-exports (`pub use types::*; pub use error::{FinaError, Result};`).

**Tests required in this phase** (`jsnum.rs`, `rng.rs`, `types.rs`):
- `js_round` negative-half cases per §7.1.4.
- `js_round` matches a table of 20 values cross-checked against Node (`node -e`).
- `round2(-0.001) == -0.0`; `round2(1.005) == 1.0` (float repr, not 1.01).
- Mulberry32 first 5 outputs for `seed=42` match Node exactly.
- `Mulberry32::new(42).next_u32()` sequence identical across two independent instances.
- Serde round-trip: every type `to_string()` → `from_str()` → `to_string()` is stable.
- `SimulationBundle` camelCase key check: assert serialized JSON contains `"worstOfPerformance"`,
  `"knockInTriggered"`, `"couponMemoryBalance"` and **not** `worst_of_performance`.
- `PayoffNodeId` serializes to `"GlobalKOGate"` exactly.

**Exit criteria**
```bash
cargo test -p fina-kernel
cargo clippy -p fina-kernel --all-targets -- -D warnings
cargo fmt --check -p fina-kernel
```

**Commit:** `feat(core): scaffold fina-kernel crate with JS-compatible numerics and domain types`

---

### Phase 2 — Port `path_generator` (L1)

**Goal:** `fina-kernel::path_generator::generate_paths` reproduces `golden.json.simulationBundle`
exactly. This is the largest and highest-risk phase.

#### 2.1 Public API

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulationConfig {
    pub seed: u32,                 // demo = 42
    pub path_count: usize,         // demo = 100
    pub observations: usize,       // demo = 60
    pub barriers: ProductBarriers, // the generatePaths.ts BARRIERS const
    pub start_date: String,        // "2024-01-15"
}

impl SimulationConfig {
    /// The exact fixture config that golden.json was captured with.
    pub fn demo() -> Self;
}

pub fn generate_paths(
    config: &SimulationConfig,
    mut on_progress: impl FnMut(ProgressEvent),
) -> Result<SimulationBundle>;
```

`generate_paths` **validates first**: `observations >= 1`, `path_count >= 1`,
`0 < ki_barrier`, `ki_barrier < ko_barrier`, `notional > 0`. On failure return
`FinaError::InvalidBarriers` — never panic.

#### 2.2 Port map — port these functions, in this order

| TS function | TS lines | Rust | Notes |
| --- | --- | --- | --- |
| `createRng` | 15–23 | `rng::Mulberry32` | Phase 1 |
| `assignScenarios` | 40–52 | `scenario::assign_scenarios` | Cutoffs `0.65 / 0.75 / 0.85`; **one RNG draw per path, consumed before any series draws** |
| `generateDates` | 58–63 | `path_generator::generate_dates` | `2024-01-15` + i months, `YYYY-MM-DD`. All 60 strings are in `golden.json` — assert equality. |
| `generatePerformanceSeries` | 69–255 | `scenario::generate_performance_series` | See §2.3 — the delicate one |
| `buildObservations` | 265–337 | `payoff::build_observations` | Memory-coupon accumulation + KO early-exit padding |
| `computePayoff` | 339–400 | `payoff::compute_payoff` | Attribution waterfall; `funding = -2`, `discounting = -1.5` initial |
| `refineAttribution` | 402–418 | `payoff::refine_attribution` | `funding = round2(-1.5 - r*1.5)`, `discounting = round2(-0.8 - r*1.2)`; **2 RNG draws** |
| `buildTraversal` | 420–466 | `payoff::build_traversal` | 3 fixed orderings by scenario |
| `buildNodeDetails` | 468–645 | `node_details::build_node_details` | Magic numbers → named consts (§2.4) |
| `computeDistribution` | 651–671 | `stats::compute_distribution` | Population stddev (`/n`, **not** `n-1`). Percentiles via `sorted[floor(q*(n-1))]`. |
| `buildBranchStats` | 673–694 | `stats::build_branch_stats` | ×1000 scaling + new fields (I-4) |
| `generateSimulationBundle` | 696–818 | `path_generator::generate_paths` | Orchestrator |

#### 2.3 `generatePerformanceSeries` — port with extreme care

This function is 190 lines of coupled clamping and event injection. Preserve **statement
order exactly**; the clamps are order-dependent.

Per-path RNG consumption order (contract):
1. `a = 1.0 + (rng() - 0.5) * 0.04`
2. `m = 1.0 + (rng() - 0.5) * 0.04`
3. `n = 1.0 + (rng() - 0.5) * 0.04`
4. `ko_event` draw **only if** `scenario == 'ko'`: `6 + floor(rng() * 40)`
5. `ki_event` draw **only if** `scenario` is `alive_ki_cash`/`alive_ki_physical`: `8 + floor(rng() * 40)`… 

   > ⚠️ Read the source again at port time: TS line 97 is `8 + Math.floor(rng() * 35)` — **35**, not 40.
   > Getting this wrong silently changes every KI path. Copy the literals; do not retype from memory.

6. Then per observation `t = 0..observations`: scenario-dependent drift/vol, event injection,
   step, clamp, record, crossing detection, KO freeze-and-break.

Critical behaviours that must survive the port:
- `if (!(scenario == 'ko' && koEvent === t))` — on the KO event step the per-name drift update is
  **skipped** for all three names (the injection is the whole move).
- KO freeze: after KO is detected at `t`, remaining indices are filled with the values at `t`,
  then `break`.
- Consistency enforcement block (TS 198–252): force a KO if missing (`forceAt = min(30, obs-1)`),
  cap alive paths below KO, force a KI if missing (`forceAt = min(25, obs-1)`), lift no-KI paths
  above KI. This block runs **after** the main loop and mutates `aapl/msft/nvda/worstOf`.
- Values are stored via `round4` — so `worstOf` stored values may differ slightly from the
  in-memory `w` used for crossing tests. **Replicate this**: crossing tests in the TS use the
  unrounded local `w`; stored arrays use the rounded value. Preserve the distinction.
- `BARRIERS` used inside is the **`generatePaths.ts` const**, not `DEFAULT_TRADE_ECONOMICS`.

#### 2.4 `buildNodeDetails` — extract magic numbers to named constants

The TS embeds these literals. Define them as `pub const` in `node_details.rs` with the source
line in the doc comment, so a future reader can trace them:

| Const | Value | Used by nodes |
| --- | --- | --- |
| `COND_EXP_PATHCUBE` | `96.0` | `PathCube`, `FixingSchedule`, `WorstOfPerformance` |
| `COND_EXP_KI_TRUE` / `COND_EXP_KI_FALSE` | `89.5` / `104.2` | `KnockInGate` |
| `COND_EXP_KO_TRUE` / `COND_EXP_KO_FALSE` | `108.4` / `91.2` | `GlobalKOGate` |
| `COND_EXP_RANGE` | `98.1` | `RangeAccrual` |
| `COND_EXP_COUPON` | `97.5` | `CouponStrip` |
| `COND_EXP_MEMORY` | `97.8` | `MemoryCarry` |
| `COND_EXP_PUT` | `89.5` | `DownAndInPut` |
| `COND_EXP_REDEMPTION` / `COND_EXP_DISCOUNT` / `COND_EXP_AGGREGATE` | `96.0` | `Redemption`, `Discount`, `AggregatePV` |
| `PROB_COUPON` / `PROB_MEMORY` | `0.82` / `0.61` | `CouponStrip`, `MemoryCarry` |
| `NODE_DETAIL_SELECTED_INDEX` | `30` | `selectedW` lookup (`min(len-1, 30)`) |
| `FUNDING_BASE` / `DISCOUNTING_BASE` | `-2.0` / `-1.5` | `computePayoff` attribution |

All `nodeDetails` string fields are compared by the golden test — do not retype them.

**Tests required in this phase:**

1. **Golden parity (§6).** `crates/fina-kernel/tests/golden_parity.rs`:
   ```rust
   let golden: Value = serde_json::from_str(include_str!("fixtures/golden.json")).unwrap();
   let cfg = SimulationConfig::demo();
   let got = generate_paths(&cfg, |_| {}).unwrap();
   let got_v = serde_json::to_value(&got).unwrap();
   assert_eq!(got_v, golden["simulationBundle"]);
   ```
   This single assertion is the phase's definition of done. On mismatch, **diff the JSON** — do
   not loosen the assertion.
2. Determinism: generate twice, `assert_eq!(to_string(), to_string())`.
3. **Cross-language determinism:** assert a committed SHA-256 of the canonical serialization.
   Compute the digest once the test passes, then hard-code it. This catches accidental drift even
   if `golden.json` is later regenerated carelessly.
4. Invariant consistency per path (replaces the TS `console.warn` block, which must become
   `Err`, not a warning):
   - `knockedOut ⇒ ∃ w ≥ ko_barrier`
   - `knock_in_triggered ⇒ ∃ w ≤ ki_barrier`
   - `¬knock_in_triggered ∧ ¬knocked_out ⇒ ¬∃ w ≤ ki_barrier`
5. `assign_scenarios` distribution over the 100 paths equals `golden` counts exactly.
6. Scenario mix: KO paths have traversal **without** `KnockInGate`/`DownAndInPut`; alive-KI paths
   include `DownAndInPut`; alive-no-KI paths include `KnockInGate` but exclude `DownAndInPut`.
7. `generate_dates` returns exactly the 60 strings from `golden.paths[0].dates`, first and last
   included.
8. Each path has `observations.len() == 60`, `worst_of_performance.len() == 60`,
   `coupon_memory_balance.len() == 60`.
9. KO paths: `observations` after the KO index are frozen copies with `coupon_accrued == 0.0`,
   `knock_in_at_date == false`, `knock_out_at_date == false`.
10. `compute_distribution` on a known vector: mean/median/stddev/p05/p95 match hand-computed
    values; even-length median is the average of the two middle values.
11. `build_branch_stats`: the six counts equal the golden values **and**
    `sample_path_count == 100 && scaled == true` (I-4).
12. Validation: `generate_paths` with `ki_barrier >= ko_barrier` returns
    `InvalidBarriers`, not a panic.
13. Progress callback fires; `completed` is monotonically non-decreasing and ends at `path_count`.

**Exit criteria**
```bash
cargo test -p fina-kernel --test golden_parity
cargo test -p fina-kernel
cargo clippy -p fina-kernel --all-targets -- -D warnings
```

**Commit:** `feat(core): port deterministic path generator with golden parity guarantee`

---

### Phase 3 — Port `economics`, `risk_engine`, `diagnostics` (L2–L4)

**Goal:** the three heuristic analytics modules exist in `fina-kernel`, parity-verified.

#### 3.1 `economics` — port of `deriveTradeAnalytics`

```rust
pub fn derive_trade_analytics(e: &TradeEconomics) -> TradeAnalytics;
```

`TradeEconomics` mirrors `src/store/tradeEconomicsStore.ts`:
`strike, knock_in_barrier, knock_out_barrier, coupon_lower_barrier, coupon_upper_barrier,
coupon_rate, memory_coupon_enabled, physical_settlement_enabled, maturity_years, notional`
(all `#[serde(rename_all = "camelCase")]`).

`DEFAULT_TRADE_ECONOMICS` and `TRADE_PRESETS` (6 presets: `Base Case`, `Defensive Phoenix`,
`Aggressive Yield`, `Deep Barrier`, `High Coupon`, `Capital Protected`) also move to
`fina-kernel::economics` so the CLI/HTTP can expose them. The **frontend keeps its own copy** for
form defaults and `localStorage`; both must be asserted equal by test (see test 5).

Formulas — implement exactly:

```
ki_probability = clamp(22.1 + (ki_barrier - 0.6) * 62 + (strike - 1) * 12, 4, 55)   // round1
ko_probability = clamp(65 - (ko_barrier - 1.0) * 42 - (ki_barrier - 0.6) * 8, 25, 85) // round1
coupon_pv      = 11.6 * (coupon_rate / 0.12) * (memory ? 1.05 : 0.9) * (maturity_years / 5.0)  // round2
put_pv         = 7.2 + (ki_barrier - 0.6) * 34 + (strike - 1) * 18                 // round2
redemption     = notional * (physical ? 1.0 : 0.985)                               // round2
expected_pv    = redemption + coupon_pv - put_pv - (ko_barrier - 1.0) * 12 - ki_probability * 0.08  // round2
ci_width       = 0.43 * sqrt(100000.0 / 100000.0)                                  // round2 → always 0.43
```

`ki_probability` uses the **rounded** value inside `expected_pv` (the TS rounds it into the
returned object but computes `expected_pv` from the unrounded local). Read TS lines 21–28 at
port time and match whichever the source does — the golden test will catch a mistake.

#### 3.2 `risk_engine` — port of `computeRisk`

```rust
pub fn compute_risk(
    trade: &TradeEconomics,
    market: &MarketSnapshot,
) -> Result<RiskState>;
```

`MarketSnapshot { underlyings: Vec<Underlying>, fx_pairs: Vec<FXPair>, correlations: Vec<Vec<f64>>, vol: VolParams }`
mirroring `marketDataStore.ts`. Note this is the **shape the frontend already holds** — the
frontend sends its local state to the backend; the backend does not own market data in Phase 1.

Formulas — implement exactly:

```
spot   = mean(underlyings[].spot)
base   = notional * (1 + coupon_rate * maturity_years)
       - notional * 0.06
       - (knock_in_barrier - 0.6) * notional * 0.3
       + (spot - 242.0) * 0.08
ds     = 1.0
pv_up  = base + ds * 0.08
pv_dn  = base - ds * 0.08
vega_raw = notional * maturity_years * 0.35
fx     = fx_pairs[0].spot

pv      = round2(base)
delta   = round2((pv_up - pv_dn) / (2.0 * ds) * 1000.0)      // evaluates to 80.00
gamma   = round2((pv_up - 2.0 * base + pv_dn) / (ds * ds) * 1000.0)  // IDENTICALLY 0.00
vega    = round2(vega_raw)
theta   = round2(-notional * 0.012)
rho     = round2(notional * 0.004)
fx_delta= round2(fx * 12.0)

bucket_vegas = ["1M","3M","6M","1Y","2Y","5Y"].map(|b, i| BucketVega { bucket: b, value: round2(vega_raw * exp(-i as f64 / 3.0)) })
cross_gamma  = underlyings[1..].map(|u, i| CrossGamma { pair: format!("{}/{}", underlyings[0].symbol, u.symbol), value: round3(correlations[0][i + 1] * 0.18) })
```

Two traps, both mandatory:
- `bucket_vegas` multiplies **`vega_raw`** (pre-rounding), not the rounded `vega`.
- `cross_gamma` uses **3** decimals (`round3`), unlike every other field.

Add a doc comment on `gamma` recording that it is structurally always `0.00` because `pv_up`
and `pv_dn` are symmetric about `base` — a deliberate demo artifact (§3, draft corrections),
**not** a bug to fix in Phase 1.

Validation: `fx_pairs` must be non-empty (else `InvalidMarket`); `underlyings` non-empty;
`correlations` square with `len == underlyings.len()`.

#### 3.3 `diagnostics` — port of `mcDiagnostics`

Static, but move it so the CLI/HTTP/MCP can serve the series without the frontend:

```rust
pub fn mc_diagnostics() -> Vec<MCPoint>;      // 10 points, path counts [1000 … 1_000_000]
pub fn mc_efficiency() -> Vec<MCEfficiency>;  // 4 rows
pub fn final_mc() -> MCPoint;
```
`se = round3(0.22 * sqrt(100000.0 / paths))`, `lower = round2(pv - 1.96*se)`,
`upper = round2(pv + 1.96*se)`, `p05 = round2(72 - 8/sqrt(i+1))`, `p95 = round2(116 - 5/sqrt(i+1))`.
`pv`, `ki`, `ko` arrays are literal constants — copy them verbatim.

Every label here (`1000`…`1000000` paths) is an **illustrative** series, not a simulation that
ran. Doc-comment it as such (mirrors `FEATURE.ts.md`).

**Tests required in this phase:**
1. Golden parity for `mc`, `trade.defaults`, `trade.analytics`, `risk.base`.
2. `compute_risk` with the demo market → `pv == 154.03`, `gamma == 0.00`, `delta == 80.00`.
3. `compute_risk` **monotonicity/dependence**: changing `spot` by +1 moves `pv` by exactly
   `0.08`; changing `fx_pairs[0].spot` changes only `fx_delta` and `pv` not at all.
4. `bucket_vegas` uses unrounded vega: assert `bucket_vegas[0].value == round2(vega_raw)` and
   that it is **not** equal to `round2(round2(vega_raw))` when they differ (i.e. write the test
   so it would fail if someone used the rounded value — pick a `notional`/`maturity` where the
   two differ).
5. `cross_gamma` has exactly 3 decimals: assert `value == 0.18 * correlations[0][1]` rounded to 3
   and that serializing gives e.g. `0.099` (3 dp preserved, not `0.1`).
6. `derive_trade_analytics` golden `expected_pv == 103.21`; each of the 6 presets produces the
   documented value (assert against a table you transcribe from the source, not from the frontend).
7. Rust `DEFAULT_TRADE_ECONOMICS` serializes to JSON equal to the frontend's
   `DEFAULT_TRADE_ECONOMICS` (compare via the golden fixture's `trade.defaults`).
8. `ki_probability` clamps at both ends: `ki_barrier = 0.0` → `4.0`; `ki_barrier = 2.0` → `55.0`.
9. `mc_diagnostics()` has 10 points, ascending path counts, and `se` strictly decreasing.
10. `compute_risk` with empty `fx_pairs` → `Err(InvalidMarket)`.

**Exit criteria**
```bash
cargo test -p fina-kernel
```

**Commit:** `feat(core): port trade economics, risk engine and MC diagnostics with parity tests`

---

### Phase 4 — Port `valuation` (L5–L7)

**Goal:** cashflows, Taylor explain, PLVA, explain ledger and reconciliation in `fina-kernel`.

#### 4.1 `cashflow`

```rust
pub fn build_cashflows(path: &SimulationPath, trade: &TradeEconomics) -> Vec<Cashflow>;
pub fn cashflow_analytics(path: &SimulationPath, trade: &TradeEconomics) -> CashflowAnalytics;
```

Per observation `i` in `0..path.dates.len()`:

```
final        = (i == path.dates.len() - 1)
amount       = if final { trade.notional }
               else { round2(trade.notional * trade.coupon_rate / 12.0 * if path.observations[i].coupon_accrued > 0.0 { 1.0 } else { 0.0 }) }
df           = round4(1.0 / (1.04f64).powf((i + 1) as f64 / 12.0))
present_value= round2(amount * df)          // uses the ROUNDED df
type         = if final { if physical { PhysicalDelivery } else { Redemption } } else { Coupon }
probability  = if final { 0.98 } else { 0.85 }
realized     = i < 2
id           = format!("cf-{i}")
```

> The `coupon_rate / 12.0` treats `coupon_rate` as **annual**; `DEFAULT_TRADE_ECONOMICS.coupon_rate`
> is `0.12`. Meanwhile `generatePaths.ts` uses a **monthly** `0.008` against `notional 100`.
> These are different conventions in different modules. Do not unify them in Phase 1.

Analytics:
```
gross_cashflow = Σ amount
present_value  = Σ present_value
realized       = Σ amount where realized
future         = gross_cashflow - realized
carry          = realized * 0.02 + trade.coupon_rate * trade.notional
mtm            = present_value - trade.notional
realized_pnl   = realized - trade.notional * 0.02
unrealized_pnl = mtm
mtm_pnl        = mtm
carry_pnl      = carry
total_pnl      = mtm + carry
```

#### 4.2 `explain` (Taylor + PLVA)

```rust
pub fn valuation_explain(cash: &CashflowAnalytics, market: &MarketSnapshot) -> ValuationExplain;
```

```
previous_pv = cash.present_value - 1.8
taylor = { delta:   underlyings[0].spot * 0.006,
           gamma:   0.42,
           vega:    vol.atm_vol * 1.2,
           fx:      fx_pairs[0].spot * 0.2,
           rates:   -0.18,
           correlation: 0.24,
           dividend:    -0.11,
           theta:   -0.35,
           predicted: 0.0,   // filled below
           residual:  0.12 }
taylor.predicted = delta + gamma + vega + fx + rates + correlation + dividend + theta   // ORDER MATTERS
```

> ⚠️ `predicted` must sum in exactly the order written. Summing in any other order changes the
> last bits and breaks `1.6860000000000004` → golden failure. See §10 P-1.

`residual` (`0.12`) is **not** included in `predicted`. Preserve that.

PLVA is a fixed 4-row literal table:
```
Volatility Calibration    24.1 → 24.8   +0.8
Correlation Calibration   0.62 → 0.65   +0.3
Funding Curve Update       4.1 → 4.2    -0.2
Reserve Update             1.2 → 1.3    +0.1
plva_pnl = Σ contribution = 1.0
```

State:
```
market_explained_pnl = taylor.predicted
current_pv           = cash.present_value
total_pnl            = current_pv - previous_pv
residual_pnl         = current_pv - previous_pv - market_explained_pnl - plva_pnl
```

#### 4.3 `ledger`

```rust
pub fn explain_ledger(explain: &ValuationExplain, cash: &CashflowAnalytics, as_of: &str) -> ExplainLedger;
```

`as_of` is injected (not `SystemTime::now()`) to keep the function pure and testable — the
frontend passes today's date. Entries, in order:

| id | source | category | sub | contribution |
| --- | --- | --- | --- | --- |
| `market-delta` | market | `spot` | `delta` | `taylor.delta` |
| `market-gamma` | market | `spot` | `gamma` | `taylor.gamma` |
| `market-vega` | market | `volatility` | `vega` | `taylor.vega` |
| `market-theta` | market | `time` | `theta` | `taylor.theta` |
| `plva-<Category>` (×4) | plva | category | — | `contribution` |
| `cashflow-coupon` | cashflow | `coupon` | — | `cash.realized` |
| `valuation-discounting` | valuation | `discounting` | — | `cash.present_value - cash.gross_cashflow` |

IDs use the category **with spaces preserved** (`plva-Volatility Calibration`) to match the TS
exactly — a changing detail that the golden test will catch.

Reconciliation:
```
total_market   = Σ contributions where source == market
total_plva     = Σ where source == plva
total_cashflow = Σ where source == cashflow
total_valuation= Σ where source == valuation
total_risk     = Σ where source == risk          // always 0.0 — no risk entries exist
explained      = total_market + total_plva + total_cashflow + total_valuation + total_risk
actual_pnl     = explain.state.total_pnl
residual       = actual_pnl - explained
```

Doc-comment `total_risk == 0.0` and `explained` omitting `taylor.residual` — both are
faithful to the prototype and both look like bugs. Label them, do not "repair" them.

**Tests required in this phase:**
1. Golden parity for `cashflow` (rows, `grossCashflow`, `presentValue`, `realized`) and
   `valuation`. Assert `cashflow.presentValue == 94.89` and
   `taylor.predicted == 1.6860000000000004` **exactly** (no epsilon).
2. Summation-order regression: a test that sums `taylor` fields in a deliberately wrong order and
   asserts the result **differs** — proving the golden assertion has teeth.
3. `df` monotonic decreasing; `df[0] == round4(1/1.04)`; `present_value == round2(amount * df)`
   with the **rounded** `df` (construct a case where rounded vs unrounded `df` differ and assert).
4. Exactly 2 realized cashflows (`i < 2`); final cashflow `probability == 0.98` and
   `type ∈ {physical_delivery, redemption}` per `physical_settlement_enabled`.
5. `carry_pnl == realized * 0.02 + coupon_rate * notional`.
6. `total_pnl == mtm_pnl + carry_pnl`.
7. Ledger has exactly 10 entries; ids and ordering match the table above.
8. `total_risk == 0.0` and `explained == total_market + total_plva + total_cashflow + total_valuation`.
9. `residual == actual_pnl - explained` recomputed independently in the test.
10. `explain_ledger` is pure: same `as_of` → byte-identical JSON; different `as_of` → only
    `timestamp` differs.
11. `build_cashflows` on a KO path (short `dates` vs full `observations`) does not panic and
    returns `dates.len()` entries.

**Exit criteria**
```bash
cargo test -p fina-kernel
```

**Commit:** `feat(core): port cashflow, valuation explain and explain ledger with parity tests`

---

### Phase 5 — Transport adapters + frontend rewiring

**Goal:** three working adapters over one core, and a frontend that no longer computes domain
values. This is the largest phase; split it into **5a (CLI) → 5b (HTTP) → 5c (Tauri) → 5d (frontend)**.

#### 5.0 The wire contract (single source of truth)

Define once in `fina-kernel` and reuse verbatim in every adapter:

```rust
// crates/fina-kernel/src/api.rs
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct GeneratePathsRequest { pub config: SimulationConfig }

#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct ComputeRiskRequest { pub trade: TradeEconomics, pub market: MarketSnapshot }

#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct CashflowRequest { pub trade: TradeEconomics, pub path_index: usize }

#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub struct ExplainRequest { pub trade: TradeEconomics, pub market: MarketSnapshot, pub path_index: usize, pub as_of: String }
```

Command surface (identical names across Tauri, HTTP and CLI — **I-3**):

| Command | Request | Response |
| --- | --- | --- |
| `generate_paths` | `GeneratePathsRequest` | `SimulationBundle` |
| `get_path` | `{ path_index }` | `SimulationPath` |
| `get_branch_stats` | — | `BranchStats` |
| `get_distributions` | — | `SimulationDistributions` |
| `compute_trade_analytics` | `{ trade }` | `TradeAnalytics` |
| `compute_risk` | `ComputeRiskRequest` | `RiskState` |
| `get_mc_diagnostics` | — | `{ points, efficiency, final }` |
| `build_cashflows` | `CashflowRequest` | `{ cashflows, analytics }` |
| `valuation_explain` | `ExplainRequest` | `ValuationExplain` |
| `explain_ledger` | `ExplainRequest` | `ExplainLedger` |
| `execution_events` | `{ path_index }` | `Vec<ExecutionEvent>` |
| `health` | — | `{ version, core_version }` |

All responses are the **core types serialized directly** — adapters must not introduce
wrapper objects. An adapter that reshapes data breaks I-3 and is a defect.

Error shape on the wire, identical for all three transports:
```json
{ "code": "PATH_OUT_OF_RANGE", "message": "path index 500 out of range (bundle has 100)" }
```

#### 5a — `crates/fina-cli`

- `crates/fina-cli/Cargo.toml`: `fina-kernel` (path), `clap` (derive), `serde_json`.
- `[[bin]] name = "fina-cli"`.
- Subcommands mirroring the command table: `fina-cli generate-paths [--seed N --paths N --out FILE]`,
  `compute-risk --trade FILE --market FILE`, `mc-diagnostics`, `cashflows --path N --trade FILE`,
  `explain --path N --trade FILE --market FILE --as-of DATE`, `health`.
- Rules: `--out` writes pretty JSON to a file; without it, stdout. **Logs and NDJSON progress
  go to stderr** so stdout stays a valid JSON document (pipeable to `jq`). Non-zero exit on
  `Err`, error JSON on stderr.
- `clap` subcommand names are kebab-case; they map 1:1 to the snake_case command names. Add a test
  asserting the mapping table is complete and unique (prevents a new core command being forgotten).

#### 5b — `crates/fina-server`

- `crates/fina-server/Cargo.toml`: `fina-kernel`, `actix-web` 4, `actix-cors`, `serde_json`, `tokio` (rt, macros), `env_logger`, `log`.
- Binary `fina-server`. `GET /health`, `GET /api/version`.
- `POST /api/cmd/{command}` — a single dispatcher, mirroring duckle's `web-shim` design so the
  frontend shim stays trivial. Body = the request type; response = the response type or the error
  shape.
- `POST /api/stream/{command}` → `text/event-stream`; each SSE `data:` frame is one
  `ProgressEvent` serialized as JSON; ends with a final frame carrying the result. Core's callback
  drives the sender; **no business logic in the handler**.
- Status mapping (§8.2 table). Add CORS for the Vite origin.
- `--port` (default `8787`), `--host` (default `127.0.0.1`).

#### 5c — `src-tauri` becomes a thin adapter

- `src-tauri/Cargo.toml`: add `fina-kernel = { path = "../../crates/fina-kernel" }`; keep `tauri`,
  `tauri-plugin-log`, `serde`, `serde_json`. Rename the lib from `app_lib` to `fina_tauri`
  (update `main.rs`).
- `src-tauri/src/commands/mod.rs` + one file per domain (`path_generator.rs`, `risk_engine.rs`,
  `valuation.rs`, `economics.rs`, `diagnostics.rs`). Each command is **3 lines**:
  ```rust
  #[tauri::command]
  pub fn compute_risk(req: ComputeRiskRequest) -> Result<RiskState, FinaError> {
      Ok(fina_core::risk_engine::compute_risk(&req.trade, &req.market)?)
  }
  ```
  **Zero formulas. Zero defaults. Zero branching on domain values.** A reviewer should be able to
  confirm each command is a pure pass-through.
- Register all commands in `tauri::Builder::default().invoke_handler(tauri::generate_handler![...])`.
- Streaming: `generate_paths` takes `on_event: Channel<ProgressEvent>` and forwards
  `on_progress(|e| { let _ = on_event.send(e); })`.
- Keep `src-tauri/tauri.conf.json`, `capabilities/default.json`, icons and `build.rs` as-is
  except for the frontend path (unchanged, since the frontend stays in `src/`).

#### 5d — Frontend rewiring

1. **New `src/api/` layer.** One transport-agnostic interface, two implementations:

   ```
   src/api/types.ts        # hand-written TS mirrors of fina-kernel types (camelCase)
   src/api/transport.ts    # interface FinaTransport { call<T>(cmd, req): Promise<T>; stream(...): AsyncIterable<ProgressEvent> }
   src/api/tauriTransport.ts   # uses invoke() from @tauri-apps/api/core + Channel
   src/api/httpTransport.ts   # POST /api/cmd/{cmd}; SSE via fetch + ReadableStream
   src/api/index.ts        # detectTauri() → pick transport; export `fina` singleton
   ```

   Detection: `'__TAURI_INTERNALS__' in window` (Tauri v2), with an explicit override via
   `VITE_FINA_TRANSPORT=tauri|http` for tests and for forcing a mode. **Detection must be
   overridable** or the integration tests cannot exercise both transports.

2. **`src/store/simulationStore.ts` (new).** Replaces the module-level
   `simulationBundle` singleton from `generatePaths.ts`:
   ```ts
   type SimulationState = {
     status: 'idle' | 'loading' | 'ready' | 'error';
     bundle: SimulationBundle | null;
     error: string | null;
     selectedPathIndex: number;
     load: () => Promise<void>;
     nextPath: (d: 1 | -1) => void;
     randomPath: () => void;
     selectPath: (i: number) => void;
   };
   ```
   `load()` is idempotent (no duplicate in-flight call), called once from `App.tsx` on mount.
   Selection helpers must handle `bundle === null` safely (return early, no throw).

3. **Rewire consumers.** Every import of `generatePaths`, `mcDiagnostics`, `computeRisk`,
   `buildCashflows`, `deriveTradeAnalytics`, `useValuationExplain`, `useExplainLedger` is replaced
   by a store/hook read. Specifically:
   - `src/store/explorerStore.ts` — remove the `simulationBundle` import; read paths from
     `simulationStore`. Keep all `localStorage` behavior byte-identical (I-6). The
     `restoredDashboards` merge logic and the module-level `const saved = …` load must keep working
     in SSR-less jsdom.
   - `src/store/cashflowStore.ts` — becomes a thin selector over the backend
     `CashflowAnalytics`; **delete** the local `buildCashflows` implementation.
   - `src/store/valuationExplainStore.ts` / `explainLedgerStore.ts` — keep only UI selection state
     (`selectedCategory`, `selectedEntryId`, `selectedSource`); move data to selectors fed by the
     backend.
   - `src/features/pathcube/riskEngine.ts` — **delete**. Replace imports with a `useRisk()` hook.
   - `src/store/tradeEconomicsStore.ts` — keep inputs, `localStorage`, presets and
     `economicsSnapshot()`; **delete** `deriveTradeAnalytics` and use the backend.

4. **New hooks** in `src/hooks/`: `useSimulation.ts`, `useRiskEngine.ts`,
   `useValuationExplain.ts`, `useCashflows.ts`, `useExplainLedger.ts`, `useMcDiagnostics.ts`.
   Each returns `{ data, status, error, refresh }` with `status: 'idle'|'loading'|'ready'|'error'`.

5. **Loading/error UX.** Tiles depending on backend data must not crash while loading. Render
   the existing `PanelCard`/`StatsBadge` primitives with a skeleton or a compact error strip
   carrying the error `code` and `message`. Add a top-level banner when `status === 'error'` with
   a **Retry** button calling `simulationStore.load()`.

6. **Delete** `src/mock-data/generatePaths.ts` and `src/mock-data/mcDiagnostics.ts` only **after**
   all imports are migrated and the build is green. Keep `scripts/generate-golden-fixture.ts`
   working by pointing it at a **pinned git ref** of the old code — see §11 note.

**Exit criteria**
```bash
cargo test --workspace
npm run build          # tsc -b && vite build, no errors
npm run lint
npm run test:run
```

**Commit (one per sub-phase):**
- `feat(cli): add fina-cli adapter over fina-kernel`
- `feat(server): add actix-web adapter with cmd dispatch and SSE`
- `feat(tauri): route commands through fina-kernel`
- `refactor(frontend): consume domain data via transport abstraction`

---

### Phase 6 — Test suites, coverage, CI

**Goal:** the test strategy from §8 is implemented and enforced in CI.

#### 6.1 Rust

- Unit tests already live in `crates/fina-kernel/src/**/tests.rs` (co-located, `#[cfg(test)]`).
  Move to `tests/` submodules only if a file exceeds ~600 lines; do not create both.
- **Adapter tests** — one per adapter, testing **serialization and dispatch only**, never formulas:
  - `crates/fina-cli/tests/cli.rs`: spawn the binary (`env!("CARGO_BIN_EXE_fina-cli")`) against a
    `tempfile` fixture; assert exit code, stdout-is-valid-JSON, and stderr progress lines.
  - `crates/fina-server/tests/http.rs`: `actix_web::test` for status mapping, error shape,
    `POST /api/cmd/*` dispatch, 404 on unknown command, 400 on malformed body.
  - `src-tauri/src/commands/tests.rs`: assert each command is a pass-through by calling the
    **inner core function** and comparing to the command's output; assert error serialization.
- **Cross-transport parity test** — the important one:
  `crates/fina-server/tests/parity.rs` builds the demo request, calls the core function directly,
  calls the HTTP endpoint in-process, and asserts the two JSON values are **identical**. Assert
  the same for the CLI's stdout. This is the mechanical enforcement of I-3.
- `crates/fina-kernel/tests/golden_parity.rs` — already in Phase 2.
- Coverage: `cargo llvm-cov` (or `cargo-tarpaulin`). Gate at **≥ 70%** lines for `fina-kernel`
  and **≥ 85%** for the three adapter crates (adapters are thin, so this is achievable and
  meaningful). Exclude `tests/` from the denominator.

#### 6.2 Frontend (Vitest, **no Playwright**)

Add devDependencies: `vitest`, `@vitest/coverage-v8`, `@vitest/ui`, `jsdom`,
`@testing-library/react`, `@testing-library/jest-dom`, `@testing-library/user-event`, `msw`.

`vitest.config.ts` — merge into the existing `vite.config.ts` via `defineConfig` from `vitest/config`
so the React + Tailwind plugins are shared:
```ts
test: {
  environment: 'jsdom',
  globals: true,
  setupFiles: ['./src/tests/setup.ts'],
  include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  coverage: { provider: 'v8', reporter: ['text', 'json'], exclude: ['src/tests/**', '**/*.tsx'] },
}
```

`src/tests/setup.ts`: `cleanup()` in `afterEach`; stub `window.matchMedia`; stub
`ResizeObserver`; stub `IntersectionObserver`; clear `localStorage` in `beforeEach`; stub
`crypto.randomUUID`.

`src/tests/mocks/`:
- `tauriMock.ts` — replaces `@tauri-apps/api/core` via `resolve.alias`; exports a spyable
  `invoke` and a `Channel` stub. **Also assert the unmocked-command failure**: an unknown command
  must throw, so a missing mock fails loudly instead of silently returning `undefined`.
- `httpMock.ts` — MSW `setupServer` intercepting `POST /api/cmd/:command`, with a default handler
  that **throws** for un-stubbed commands.
- `goldenBundle.ts` — loads `crates/fina-kernel/tests/fixtures/golden.json` (import with
  `?raw` + `JSON.parse`, or read via `node:fs` in the test env) so frontend tests assert against
  the same baseline as Rust.

Test files:

| File | Covers |
| --- | --- |
| `src/tests/__tests__/goldenBundle.test.ts` | `golden.json` shape; 100 paths; 60 obs; `totalPaths === 100000`; `samplePathCount === 100` |
| `src/api/__tests__/tauriTransport.test.ts` | invoke called with the right command + camelCase payload; error propagation; `Channel` streaming |
| `src/api/__tests__/httpTransport.test.ts` | POST to `/api/cmd/{cmd}`; JSON body; non-2xx → error carrying `code`/`message`; SSE frames → `ProgressEvent` stream |
| `src/api/__tests__/transportParity.test.ts` | **Same request through Tauri mock and MSW returns identical objects** (frontend mirror of Rust I-3 test) |
| `src/store/__tests__/simulationStore.test.ts` | initial `idle`; `load()` → `ready`; idempotent double-`load`; error → `error` + `error` string; `nextPath` wraps at both ends; `randomPath` stays in range; `selectPath` resets date index (parity with current `explorerStore` behavior) |
| `src/store/__tests__/explorerStore.test.ts` | `localStorage` round-trip under key `fina-workspace`; dashboard create/rename/duplicate/delete guards (`delete` refuses when 1 remains — parity with current code); restored dashboards merge with built-ins |
| `src/store/__tests__/tradeEconomicsStore.test.ts` | preset application; reset; `fina-trade-economics` persistence; **`deriveTradeAnalytics` no longer imported** (guard against regression) |
| `src/hooks/__tests__/*.test.tsx` | each hook's `idle→loading→ready` and `error` transitions |
| `src/features/tiles/__tests__/TileRenderer.test.tsx` | **all 51 tile types render** without throwing (table-driven over `TILE_CATALOG`) — direct enforcement of I-7 |
| `src/tests/__tests__/integration.test.tsx` | full flow: load bundle → select path → select node → request cashflows → request explain → assert rendered values equal `golden.json` |

Gate coverage at **≥ 60%** on `src/api/**`, `src/store/**`, `src/hooks/**` (excluding `.tsx`
chart components and `src/tests/**`).

#### 6.3 CI (`.github/workflows/ci.yml`)

Jobs, each with a timeout, ordered cheapest-first:
1. `frontend` — `npm ci`, `npm run lint`, `npm run build`, `npm run test:run`
2. `core` — `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test -p fina-kernel`
3. `adapters` — `cargo test -p fina-cli -p fina-server`, `cargo build -p fina-tauri --no-default-features` (compile check without bundling the frontend)
4. `coverage` — `cargo llvm-cov` + `npm run test:coverage`, upload artifacts, enforce gates
5. `dependency-hygiene` — assert `crates/fina-kernel/Cargo.toml` lists only the §4 allowlist

Add to `package.json`:
```json
"test": "vitest",
"test:run": "vitest run",
"test:ui": "vitest --ui",
"test:coverage": "vitest run --coverage",
"tauri": "tauri",
"tauri:dev": "tauri dev",
"tauri:build": "tauri build",
"backend:dev": "cargo run -p fina-server",
"backend:test": "cargo test --workspace"
```

**Exit criteria:** all five CI jobs green locally; `npm run test:run` < 20 s;
`cargo test --workspace` < 60 s.

**Commit:** `test: add vitest suites, adapter tests and CI pipeline`

---

## 8. Testing strategy (normative)

### 8.1 The pyramid

| Layer | Share | What it tests | Transport used | Runs in |
| --- | --- | --- | --- | --- |
| **Core unit** | ~70% | Every pure function: numerics, RNG, formulas, aggregations | none | ms |
| **Adapter** | ~20% | Serialization, dispatch, status/error mapping, CLI exit codes | real (in-process / spawned) | 10s of ms |
| **Integration** | ~10% | Cross-transport byte parity; frontend↔transport contract | mocked transport | s |

**Golden rule:** never test a formula through a transport. Test the formula in core; test the
transport's ability to move the value.

### 8.2 Error mapping (normative)

| `FinaError::code()` | HTTP status | JSON-RPC code (Phase 2) |
| --- | --- | --- |
| `INVALID_BARRIERS` | 400 | `-32602` |
| `INVALID_MARKET` | 400 | `-32602` |
| `PATH_OUT_OF_RANGE` | 404 | `-32602` |
| `UNKNOWN_NODE` | 400 | `-32602` |
| `GENERATION` | 500 | `-32603` |

Tauri has no status codes: it serializes `Err(FinaError)` and the frontend reconstructs the
same `{ code, message }`. Add a test per row asserting the mapping.

### 8.3 Golden fixture protocol

- `golden.json` is committed and **never hand-edited**.
- Regenerate only via `npx tsx scripts/generate-golden-fixture.ts`, and only against the pinned
  pre-migration ref (§11).
- Any intentional numeric change requires: regenerate, and a `BREAKING`-marked commit whose
  message states the before/after value and the business reason.
- CI runs `cargo test -p fina-kernel --test golden_parity` and fails on any diff.

### 8.4 Frontend/backend contract states

Because the backend is now async, every data-dependent tile must handle four states. Tests
must cover all four for at least one representative tile:
`loading` (skeleton), `ready` (value), `error` (code + message + retry), `empty`
(e.g. `bundle === null`, `paths.length === 0`).

---

## 9. Out of scope for Phase 1 (explicitly forbidden)

| # | Forbidden | Why |
| --- | --- | --- |
| O-1 | Playwright / any E2E browser test | Explicitly excluded by the request |
| O-2 | Live market data, calibration services, external APIs | No network dependency in core |
| O-3 | Moving `graphLayout.ts` to Rust | It builds `@xyflow/react` nodes/edges — a UI concern. Keep in TS. Only the **state resolution** (`resolveState`, edge-on-path test) is arguably domain logic; leave it in TS to avoid churn |
| O-4 | `executionContexts.ts` | 3 lines of pure projection; port only if it falls out of Phase 4 naturally. Not required |
| O-5 | Database / persistence beyond `localStorage` | Phase 2 |
| O-6 | Auth, multi-user, shared dashboards | Phase 2 |
| O-7 | A **real** MCP server | Phase 2. Create `crates/fina-mcp` as a stub crate that prints a "not implemented in Phase 1" message, so the workspace member exists and the architecture is visible |
| O-8 | Production pricing, calibrated MC, revaluation engine | Phase 2 |
| O-9 | Wiring Trade Economics to regenerate paths | Phase 2 (see §3 corrections) |
| O-10 | Fixing `gamma ≡ 0`, `total_risk ≡ 0`, the 1000× branch-stat scaling, or the two divergent barrier conventions | Document, don't repair |
| O-11 | Moving the frontend to `frontend/` | §3 |
| O-12 | Changing tile copy, adding tiles, removing tiles | 51 in, 51 out |

---

## 10. Pitfalls — ranked by expected damage

**P-1 — Summation order changes IEEE-754 results.**
`taylor.predicted` must be `1.6860000000000004`. Summing the same 8 doubles in a different
order, or letting Rust/LLVM reassociate (it does not by default, but `f64::mul_add`/FMA or a
future `-C target-feature=+fma` would), changes the last bits. Fix: sum left-to-right in the
documented order; write the "wrong order must differ" regression test (§7 Phase 4 test 2); do not
add `fast-math`-style flags.

**P-2 — `f64::round()` ≠ `Math.round()`.**
Rust rounds half **away from zero**; JS rounds half **toward +∞**. For negative halves
(`funding`, `discounting`, `put_value` — all negative) the results differ by 1. Use `js_round`
everywhere. Add `js_round(-2.5) == -2.0` as a test.

**P-3 — Wrong RNG draw count or order.**
The TS makes exactly **4 draws** in `assignScenarios`/`generatePerformanceSeries` per path
(1 scenario + 3 initial spots), then 1–2 more for event dates, then per-observation draws, then
2 in `refineAttribution`. Adding, removing or reordering one draw shifts every subsequent
number for every path. Fix: port the draw sites one at a time and re-run the golden test after
**each** function port, not once at the end.

**P-4 — `38` vs `35` style literal transcription errors.**
`generatePerformanceSeries` mixes `rng()*40` (KO event) and `rng()*35` (KI event), `min(30, …)`
(KO force) and `min(25, …)` (KI force), drift `0.004/0.003/0.001`, vol `0.03/0.025/0.04`. A
single mistyped literal is invisible until the golden test fails with thousands of differing
lines. Fix: copy-paste literals; never retype from memory.

**P-5 — Rounded vs unrounded intermediate values.**
Crossing tests use the **unrounded** local `w`; stored arrays hold `round4(w)`. `present_value`
uses the **rounded** `df`. `bucket_vegas` uses the **unrounded** `vega`. Mixing these up
produces off-by-0.0001 errors that look like noise. Fix: name the variables to reflect which is
which (`w_raw` vs `worst_of_stored`, `df_rounded`, `vega_raw`).

**P-6 — Adapter layer starts accumulating logic.**
The moment a `#[tauri::command]` contains a formula, a default, or an `if` on domain data, I-3
and the test pyramid break and the CLI/MCP silently diverge. Fix: adapter tests assert each
command equals the core call. Review rule: an adapter file longer than ~40 lines per command is
a smell.

**P-7 — Async migration breaks `explorerStore`'s module-level singleton.**
`simulationBundle` is currently computed at import time and `const initialPath = simulationBundle.paths[0]!`
runs at module load. With an async backend, `paths[0]` may be `undefined`. Every
`simulationBundle.paths.find(...)`/`[0]!` access must become a null-safe store read. Fix: audit
every non-null assertion in `explorerStore.ts` and its consumers.

**P-8 — Forgetting the two divergent barrier conventions.**
`BARRIERS` (paths) ≠ `DEFAULT_TRADE_ECONOMICS` (UI). Merging them silently changes path results.
Fix: separate constants, separate tests, cross-reference doc comments.

**P-9 — `msft` drift asymmetry.**
The TS uses `drift * 0.9` for MSFT and `drift * 1.1`, `vol * 1.2` for NVDA. "Symmetry" fixes
change every path. Preserve verbatim.

**P-10 — Deleting the mock modules before imports are migrated.**
`generatePaths.ts` is imported by `explorerStore` and transitively by everything. Delete last,
verify with `grep -rn "mock-data" src/` returning nothing.

**P-11 — `golden.json` is 3.1 MB.**
Do not `JSON.parse` it into snapshot files, and do not let Vitest try to collect coverage from
it. Read it with `?raw` + `JSON.parse` (Node) or `node:fs` (jsdom). Mark `-diff` in
`.gitattributes`.

**P-12 — Coverage theatre.**
The draft's "75% of React components" is unachievable and meaningless here (ECharts wrappers).
Gate on the modules that hold logic (§7 Phase 6) and exclude chart wrappers from the denominator.

---

## 11. Definition of Done

Phase 1 is complete **only** when every box is checked.

**Correctness**
- [ ] `cargo test -p fina-kernel --test golden_parity` passes; `golden.json` unmodified since Phase 0.
- [ ] Determinism test passes; committed SHA-256 digest test passes.
- [ ] Core generates byte-identical JSON on repeat runs.
- [ ] `bundle` rendered in the app is the Rust bundle (verifiable: break a Rust value on
      purpose and see the UI change; then revert).

**Architecture**
- [ ] `crates/fina-kernel/Cargo.toml` lists only `serde`, `serde_json`, `thiserror`, `chrono`.
- [ ] No formula, default, or domain branch exists in any adapter file.
- [ ] Tauri, HTTP and CLI return identical JSON for an identical request (test-enforced).
- [ ] `crates/fina-mcp` exists as a documented stub.

**Behavior preservation**
- [ ] All 51 tiles render (test-enforced).
- [ ] All 6 built-in dashboards and all 9 role templates still create correctly.
- [ ] Theme toggle, path selection, next/prev/random all work.
- [ ] Trade Economics panel: all fields editable, all 6 presets, reset.
- [ ] Market Data panel: spot/FX/vol/correlation edits and all 8 shock buttons.
- [ ] Notebook: create, edit, search, pin, duplicate, delete.
- [ ] Existing `localStorage` data loads without loss (I-6).

**Quality**
- [ ] `cargo fmt --check` clean; `cargo clippy -- -D warnings` clean.
- [ ] `npm run lint`, `npm run build`, `npm run test:run` clean.
- [ ] Coverage gates met (`fina-kernel` ≥ 70%, adapters ≥ 85%, frontend logic ≥ 60%).
- [ ] `npm run test:run` < 20 s; `cargo test --workspace` < 60 s.
- [ ] No Playwright dependency anywhere.

**Documentation**
- [ ] `README.md` updated: architecture diagram, new commands, transport modes, how to run the
      server and CLI, test commands.
- [ ] `FEATURE.ts.md` **retained** as the TS-era inventory, with a header note: "Superseded for
      domain logic by `fina-kernel` as of Phase 1; retained to document the pre-migration
      TypeScript baseline." Do **not** delete it — it is the traceability record and the
      golden-fixture provenance.
- [ ] New `docs/ARCHITECTURE.md` with the layering rule, command table, error mapping, and the
      §10 pitfall list.
- [ ] Every place a demo artifact was preserved rather than fixed (O-10) has a code comment.

**Process**
- [ ] One commit per phase/sub-phase, each green.
- [ ] `git log` shows no commit that mixes a refactor with a numeric change.

> **Note on `generate-golden-fixture.ts`:** once `src/mock-data/generatePaths.ts` is deleted in
> 5d, the script can no longer import it. Before deleting, either (a) leave the script and pin it
> to a git ref via `git show <ref>:src/mock-data/generatePaths.ts`, or (b) keep the pre-migration
> TS files under `fixtures/legacy-ts/` excluded from the Vite build and `oxlint`. Option (b) is
> recommended — it keeps the fixture reproducible without git archaeology. Record the choice in
> the Phase 1 notes.

---

## 12. Reference: verified golden values

Use these as smoke checks while porting. Any deviation is a bug until proven otherwise.

| Quantity | Value |
| --- | --- |
| `paths.length` | `100` |
| `observations` per path | `60` |
| `paths[0].dates[0]` | `2024-01-15` |
| `paths[0].dates[59]` | `2028-12-15` |
| `paths[0].traversal` | `PathCube, FixingSchedule, WorstOfPerformance, GlobalKOGate, CouponStrip, MemoryCarry, Redemption, Discount, AggregatePV` |
| `branchStats.totalPaths` | `100000` |
| `distributions.totalPayoff.mean` | `115.62` |
| `risk.pv` | `154.03` |
| `risk.gamma` | `0` |
| `risk.delta` | `80` (structural constant, §3.2) |
| `cashflow.presentValue` | `94.89` |
| `valuation.taylor.predicted` | `1.6860000000000004` |
| `trade.analytics.expectedPv` | `103.21` |
| `trade.analytics.ciWidth` | `0.43` (structural constant) |
| `nodeDetails` keys per path | 12 |

---

## 13. Agent operating instructions

1. **Read before writing.** For each port, open the TS source and the corresponding section of
   this document side by side. Do not port from memory or from this document's formula summary
   alone — the summary can drift from the source; the source is authoritative for behaviour.
2. **Re-run the golden test after every single function port**, not at the end of the phase. The
   failure diff tells you exactly which function diverged.
3. **Never weaken an assertion to make a test pass.** If parity fails, the Rust is wrong. If you
   are certain the Rust is right and the golden is wrong, that is a Phase-2 decision requiring
   explicit sign-off — stop and report.
4. **Report blockers precisely.** If a formula is ambiguous, quote the TS line numbers and your
   two readings, and state which you chose and why. Do not guess silently.
5. **Keep commits atomic and green.** Never leave the workspace in a non-building state at a
   phase boundary.
6. **Prefer clarity over cleverness** in `fina-kernel`. This is audited financial-demo code; a
   reviewer must be able to trace any number back to a TS line.
7. **When a phase's exit criteria pass, say so explicitly** and list the command output summary
   before moving on.