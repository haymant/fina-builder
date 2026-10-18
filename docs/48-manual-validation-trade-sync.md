# 48 — Manual validation: every tile, against the live engine

**Goal:** a manual, engine-backed acceptance guide for **every tile** in the app.
Two axes:

1. **Trade propagation** — editing **Trade Economics (riga)** must be *watched*:
   every dependent tile re-prices against the edited trade and nothing crashes.
   This is the end-to-end check of the inline-`request` fix (docs/46 §7.1 / §8)
   that the vitest suite mocks.
2. **Per-tile behaviour** — for each tile, what it shows, which tool backs it, and
   what a trade edit vs a market edit must do to it (§4).

Two families of tiles are called out in detail because they are the ones a
reviewer touches first:
- **Trade Economics (riga)** — the input that drives everything (§2.2).
- **The Petri net tiles** — the net is now the single *source of truth* and the
  rest are *watchers* (§2.1).

Companion automation (already in CI):
- `src/features/riga/__tests__/tradeSync.test.tsx` — editing the trade (directly
  or via the instrument document) reaches **all 16 watching tools** with the new
  `request`.
- `src/features/riga/__tests__/fixtureRequestInjection.test.tsx` — request present
  on fixture tools, absent on `health`, once on `price_trade`.
- `src/features/riga/__tests__/netWatchers.test.tsx` — one net canvas across the
  net tiles; the layer switch drives the shared layer; the risk/explain watchers
  pin the selected transition.
- `crates/riga-mcp` — inline `request` ≡ on-disk fixture; a changed request
  *overrides* the fixture.

Manual run adds what a mock cannot: **real engine numbers changing**.

---

## 0. Setup

1. Desktop: `npm run tauri:dev:cuda` (or `npm run tauri:dev:cpu`). Browser:
   `npm run dev:all` (riga-mcp http + tac bridge + Vite). The engines must be
   current: `cargo build --release -p riga-mcp`
   (`--manifest-path modules/riga-flow/Cargo.toml`) and
   `cargo build --release --manifest-path modules/tac-engine/Cargo.toml`.
2. Top bar: **Trace → `full`**. (Pricing source is always `riga` now — the demo
   lane was retired, docs/49 §P4.)
3. Best starting point: **New dashboard → template → _riga-flow Lineage &
   Explainability_**. It already contains the net, the watchers, the trade/market
   editors and the explain surfaces.
4. Note the **run id** in each tile footer (`Provenance`) — it is the market
   snapshot id, derived from the market. It must be **stable across a trade edit**
   and **change across a market edit**.

---

## 1. Baseline

Record the headline number of every tile you are validating (PV / KI rate /
DV01 / …). Every tile must be **populated** — no error stripe, no "n/a" where a
number is expected. A tile that is empty at baseline is an engine/tool problem,
not a validation result.

---

## 2. Change the TRADE (the core test)

In **Trade Economics (riga)** → `Legs → Leg 1 → Put leg` → set
**Strike (× initial)** from `0.78` → **`0.60`** (a *lower* exercise: a **cheaper**
put leg and a **higher** total note PV; the knock-in probability is unchanged).

Expected, per tile:

| Tile | Tool | Expected |
|---|---|---|
| Trade Economics | `price_trade` | **total PV rises**; engine model unchanged; seed unchanged |
| Leg Attribution | `explain_pv_attribution` + `query_risk_net` | **Down-and-in put PV falls**, **Total PV rises**, **KI probability unchanged**, per-transition Δ/ν change |
| Statistics Summary | `get_branch_stats` `get_mc_diagnostics` `get_distributions` | PV, MC error, KI rate change together |
| Risk Net *(watcher)* | `query_risk_net` | the pinned transition's Δ/ν and the per-transition table change (§2.1) |
| Explain Net *(watcher)* | `get_ledger` | the pinned ledger row's populations / PV impact change (§2.1) |
| Transition Detail | `get_ledger` + stats | populations / Δ / ν change |
| Token Detail | `query_path_cube` + `execution_events` | the sampled tokens' `putPayoff` / PV change |
| Payoff Petri Net | `query_execution_net` | transition populations / firing probabilities change |
| PathCube Query | `query_path_cube` | see §4 — worst-percentile sample changes |
| Execution Tape | `execution_events` | KO/KI/maturity events change |
| Book Risk | `compute_book_risk` | per-notional PV & greeks change |
| Scenario Comparison | `scenario` | base / up / down PV change |
| Master Explain Waterfall | `valuation_explain` | base → current PV & residual change |
| Taylor Explain | `valuation_explain` | factor contributions, base→current PV & residual change (P&L Attribution was folded into this tile — it showed the same `pnl_explain` contributions without the base/current/residual) |
| Greeks Sanity | `validate_greeks` | flags may change |
| Stress Bands | `recommend_scenarios` | KI/KO band recommendations change |
| Economics Impact Summary | `trade_design` | base PV, coupon/put PV, KO/KI change |
| Sensitivity Tornado | `trade_design` | one-step PV impact ranking changes |
| Parameter Impact Matrix | `trade_design` | ΔPV / ΔKI / ΔKO per parameter changes |
| Branch Flow | `query_execution_net` | KO / survive / put / coupon populations change |

**Negative controls (must NOT change when the *trade* changes):**
- **Health & Run** (`health`) — version/features/seed are trade-independent.
- **Market Snapshot (riga)** (`get_market`) — as-of, spots, vols depend on the
  *market*, not the trade.
- **Market Explorer (riga)** — same reason.

**Pass criteria:** every tile in the table changes in the *expected direction*
(a lower strike ⇒ a **cheaper** down-and-in put ⇒ a **higher** total note PV, with
the KI probability unchanged), the negative controls do not change, and no tile
shows an error stripe. **Footer run ids stay stable** (only the trade changed,
not the market).

> **Ground truth (measured with `riga-cli --call riga-flow/price_trade`, 2026-10-19).**
> strike `0.60` → put `0.002713`, total PV `0.996124` · strike `0.78` → put
> `0.021093`, total `0.977744` · strike `0.90` → put `0.036312`, total `0.962525`;
> `ki_probability` `0.148267` for all three. A lower exercise makes the put
> **cheaper** and the note **more valuable**; KI is strike-independent. The note's
> total is `funding + coupon − put`, which is why it moves opposite to the put leg.

### 2.1 The Petri net — one source of truth, the rest are watchers

The workspace used to draw the *same* net three times (Payoff / Risk / Explain).
It no longer does. The layout is **1 diagram + 4 inspectors**:

| Tile | Role | Backed by |
|---|---|---|
| **Payoff Petri Net** | **source of truth** — the only net canvas | `query_execution_net` (+ `query_risk_net` / `get_ledger` for the active layer) |
| Risk Net | **watcher** (no canvas) | `query_risk_net` |
| Explain Net | **watcher** (no canvas) | `get_ledger` |
| Transition Detail | inspector for the **selected transition** | `get_ledger` + `get_branch_stats` + `query_risk_net` |
| Token Detail | inspector for the **selected place** | `execution_events` + `query_path_cube` |

**How to validate it:**

1. **One canvas.** In the *riga-flow Lineage* dashboard, exactly one tile draws
   the net (`Payoff Petri Net`). Risk Net and Explain Net draw **tables**, not a
   second graph. (If you see three graphs, the build is stale.)
2. **Layer switch.** The Payoff Petri Net header carries **Execution / Risk /
   Explain** chips. Clicking switches the **node tint**:
   - *Execution* → no tint; labels show `pct(probability) · pv`.
   - *Risk* → tint by signed Δ / ν; labels show `Δ … · ν …`.
   - *Explain* → tint by signed ledger `pv_impact`.
   The subtitle describes the active layer. The **graph shape never changes** —
   places/transitions come from `query_execution_net`; only the overlay may.
3. **Selection is shared and bidirectional.** Click a transition node (the blue
   boxes) in the net → it highlights, **Risk Net** pins that transition's Δ/ν,
   **Explain Net** pins its ledger row, and **Transition Detail** shows its
   populations/Δ/ν/reference formula. Click a **place** (the round marks) → **Token
   Detail** lists a bounded token sample. Conversely, click a **row** in the Risk
   Net or Explain Net table → the same transition becomes selected **and is
   highlighted on the net** (without the nodes losing any positions you dragged).
4. **Cross-tile consistency.** For the *same* selected transition, the numbers in
   Risk Net, Explain Net and Transition Detail must agree (Δ/ν from `query_risk_net`
   fall back to the ledger's, which are `0` — see the note below).
5. **Negative control.** Changing only the **Trace level** must not change any
   Δ/ν / DV01 / ρ on the net — trace affects detail, never pricing.

> **Δ/ν are attributed, not zero.** The engine's *ledger* entries hard-code
> `delta_impact = vega_impact = 0`. `query_risk_net` attributes per-transition Δ/ν
> by differencing each transition's PV impact across the CRN spot/vol bump pairs
> already priced for the per-asset Greeks (no extra valuation runs). Baseline
> (recorded fixture): `daily_global_ko` Δ `+0.0131` · ν `+0.5998`;
> `final_fixing_eki` (put) Δ `+0.00062` · ν `−0.1149`; `memory_coupon` Δ
> `−0.00066` · ν `−0.0331`. If you see `0.0000` on a node, the tile is talking to a
> stale `riga-mcp` binary — rebuild it (`cargo build --release -p riga-mcp`).

**Expected after a lower strike (0.78 → 0.60):**

| Element | Expectation |
|---|---|
| `final_fixing_eki` (down-and-in put) node/row | Δ impact **shrinks in magnitude**, ν impact **shrinks** (a cheaper put), the tint fades — the *sign* is unchanged |
| `daily_global_ko` / `memory_coupon` | change modestly (KO/coupon driven, not strike driven) |
| Risk Net `DV01` / `Correlation ρ` | change (a cheaper put carries less rate/correlation sensitivity) |
| Risk Net per-asset table | delta less negative; gamma and vega smaller in magnitude |
| Explain Net pinned row | populations before/after and PV impact change |
| Transition Detail | populations / Δ / ν for the pinned transition change |
| Token Detail | sampled `putPayoff` values fall (a cheaper put); the KI-hit proportion is **unchanged** (the KI barrier did not move) |

**Judging pass/fail:**
1. **All** Δ/ν labels, the per-transition table and the per-asset numbers must
   differ from baseline — that proves `query_risk_net` re-ran against the *edited*
   trade, not the on-disk fixture.
2. A transition's impact **sign must be stable** across the two runs; only the
   magnitude may change (it **shrinks** for the put when the strike is lowered).
   A sign flip on a *trade* edit is a red flag.
3. The **graph shape must not change**, and dragged node positions must survive
   the re-run (selection changes must not snap nodes back).

### 2.2 `Trade Economics (riga)` — the input tile itself

**What it shows.** The schema-driven editor for the canonical
`fina.instrument/v1` document: trade legs (put/coupon/funding), the market block,
and the simulation config, with import/paste and presets. `price_trade` is the
authority — a rejected field shows the engine's `{code,message}`; the UI never
invents a rule.

**Validate:**
1. Edit a field (e.g. **Strike**) → the tile's own PV updates, and every tile in
   §2 updates too.
2. **Presets**: apply a preset → the document and the PV change consistently.
3. **Import** a fixture (`1.json`, `termsheet1.md.json`, `termsheet1.json`) → the
   adapter badge shows (`Murex chunk` / `riga fixture` / `manual`) and the PV
   matches the fixture's expectation.
4. **Paste broken JSON** → the tile shows an import error and **keeps its last
   good values**; no other tile changes (the document is not replaced).
5. A field the engine rejects (e.g. an unsupported rail) → the engine's structured
   error is shown, and the tile does not silently "fix" it.

---

## 3. Change the MARKET (second axis)

In **Market Data (riga)** (lane **Instrument market** or **Lake**), raise both
**ATM vols** by ~5 vol points, or bump the **spots**.

Expected: every PV/risk tile re-prices; **Market Snapshot** spots/vols change;
**Market Explorer** changes; footer **run ids change**. Vega-driven tiles
(Bucket Vega, Greeks, Vol Surface) move more than delta-driven ones. This proves
the market axis is wired independently of the trade axis.

---

## 4. Per-tile manual validation guide (all 67 tiles)

Reading the tables: **Watch** = the number/element to record at baseline. **Trade
edit** / **Market edit** = what must happen to it. "—" means the tile does not
depend on that axis.

### 4.1 riga-flow — trade, structure & lineage

| Tile | Tool | Watch | Trade edit | Market edit |
|---|---|---|---|---|
| Trade Economics (riga) | `price_trade` | PV, model, seed | PV changes; model/seed stable | PV changes |
| Market Data (riga) | `price_trade` request | effective market JSON | — | spots/vols/corr change |
| Market Explorer (riga) | `get_market` | spots, ATM vols, ρ | **unchanged** (negative control) | **changed** |
| Vol Surface (riga) | instrument document | Dupire local-vol grid | **unchanged** (market-derived) | **changed** (surface rebuilds) |
| Payoff Petri Net | `query_execution_net` | graph shape, firing %, token counts | overlay + probabilities change; **shape stable** | probabilities change |
| Payoff Graph (riga) | `query_execution_net` | 8-transition product graph | unchanged (static topology) | unchanged |
| Data Lineage | `get_ledger` determinism | seed, as_of, market sha256 | unchanged (seed/as_of) | **sha256 changes** |
| PathCube Query | `query_path_cube` | worst-5% sample (`putPayoff`, `kiHit`) | `putPayoff` rises, KI share rises (fixed percentile) | sample changes |
| Execution Tape | `execution_events` | per-path KO/KI/maturity events | KO/KI mix changes | events change |
| Market Snapshot (riga) | `get_market`/`list_markets` | snapshot ids, as_of | **unchanged** | **changed** |
| Health & Run | `health` | version, features, seed | **unchanged** | **unchanged** |

### 4.2 riga-flow — cashflow & distribution

| Tile | Tool | Watch | Trade edit | Market edit |
|---|---|---|---|---|
| Cashflow Summary (riga) | `build_cashflows` | mean per-leg PV, sampled paths | put PV falls; funding/coupon legs drive the total up | curves/vols change |
| Cashflow Timeline (riga) | `build_cashflows` | expected coupon PV + paid prob per period | coupon/put legs shift | discounting shifts |
| Distribution Summary (riga) | `get_distributions` | worst-of deciles, KI rate, mean put | KI rate + mean put rise | distribution shifts |
| Payoff Histogram (riga) | `distributions_histogram` | PV histogram + percentiles | mean/percentiles shift | shift |
| Distribution Explorer (riga) | `distributions_histogram` | mean/median/std/P05/P95 | shifts | shifts |
| Selected Path (riga) | `query_path_cube` | worst-percentile sample + coupon-by-period | `putPayoff`/PV change | sample changes |

### 4.3 riga-flow — convergence / MC diagnostics (all `mc_convergence`)

| Tile | Tool | Watch | Trade edit | Market edit |
|---|---|---|---|---|
| PV Convergence (riga) | `mc_convergence` | PV vs path count + 95% CI band | **target PV moves** (band shape stable) | target moves |
| CI Shrinkage (riga) | `mc_convergence` | 95% CI width vs N | width curve unchanged (estimator property) | unchanged |
| Error vs Path Count | `mc_convergence` | observed SE vs 1/√N | unchanged | unchanged |
| KI Convergence (riga) | `mc_convergence` | KI prob vs N | **level rises** | level moves |
| KO Convergence (riga) | `mc_convergence` | KO prob vs N | level may move | level may move |
| Convergence Health (riga) | `mc_convergence` | final estimator quality + ladder | quality stable; value moves | value moves |
| Statistics Summary | `get_branch_stats`+`get_mc_diagnostics`+`get_distributions` | PV, MC error, KI rate, transition stats | all move together | all move |
| Percentile Convergence (riga) | `percentile_convergence` | terminal worst-of P05/P50/P95 vs N | bands move | bands move |
| Distribution Stability (riga) | `percentile_convergence` | P05–P95 bands across N | bands move | bands move |

> **Convergence tiles are estimator properties.** A trade/market edit moves the
> *level* (the target), not the *shape* of the shrinkage curve. If the CI width or
> the 1/√N fit changes materially, suspect the estimator, not the trade.

### 4.4 riga-flow — risk & scenario

| Tile | Tool | Watch | Trade edit | Market edit |
|---|---|---|---|---|
| Risk Summary (riga) | `risk_batch` | per-asset Δ/Γ/ν, DV01, ρ | magnitudes grow with the put | vega/ρ move more on a vol edit |
| Greeks Table (riga) | `risk_detailed` | Δ/Γ/ν + θ/ρ, cross-gamma | magnitudes change | change |
| Greeks Waterfall (riga) | `risk_detailed` | risk magnitude by factor | factor mix shifts toward the put | vol factor grows on a vol edit |
| Bucket Vega (riga) | `risk_detailed` | vega by factor | vega grows | **vega grows most on a vol edit** |
| Greeks Sanity | `validate_greeks` | severity flags | flags may change | flags may change |
| Scenario Comparison (riga) | `scenario` | base/up/down PV | all three move | all three move (larger vol moves) |
| Stress Bands | `recommend_scenarios` | KI/KO band recommendations | bands shift | bands shift |
| Book Risk | `compute_book_risk` + async task | per-notional PV & greeks, task id | PV/greeks change | change |
| Leg Attribution | `explain_pv_attribution` | PV by leg, PV/Δ/ν by transition | put leg + total rise | legs shift |
| Risk Net *(watcher)* | `query_risk_net` | pinned transition Δ/ν, per-transition table, per-asset Greeks | see §2.1 | vega/ρ-driven rows move more |

### 4.5 riga-flow — valuation & explain

| Tile | Tool | Watch | Trade edit | Market edit |
|---|---|---|---|---|
| Master Explain Waterfall (riga) | `valuation_explain` | base → market explain → residual → current PV | base/current move; residual stays small | explain drivers change |
| Taylor Explain (riga) | `valuation_explain` | Taylor contributions, base→current, residual | contributions change | factor contributions change |
| Explain Net *(watcher)* | `get_ledger` | pinned ledger row (populations, PV/Δ, condition, evidence) | row changes; **evidence refs stay meaningful** | row changes |
| Transition Detail | `get_ledger`+stats+`query_risk_net` | populations, PV/Δ/ν, condition, reference formula | numbers change; reference formula static | numbers change |
| Token Detail | `execution_events`+`query_path_cube` | tokens in place, sampled paths, replay | sample changes; replay round-trips | sample changes |

### 4.6 riga-flow — path & behaviour (`path_series` unless noted)

| Tile | Tool | Watch | Trade edit | Market edit |
|---|---|---|---|---|
| Path Timeline (riga) | `path_series` | selected-path worst-of + barriers | barriers/paths reflect the new strike/KI | paths change |
| Quantile Fan (riga) | `path_series` | P05–P95 worst-of envelope | envelope shifts | envelope shifts |
| Worst-of Evolution (riga) | `path_series` | median worst-of + P05/P95 | shifts | shifts |
| Barrier Crossings (riga) | `path_series` | below-KI / above-KO counts per step | crossings move with the KI barrier | crossings change |
| State Occupancy (riga) | `path_series` | above/below-KI + coupon-paid counts per step | occupancy moves | occupancy changes |
| Observation Schedule (riga) | `path_series` | steps + barrier hits per observation | hits change | hits change |
| Schedule Explorer (riga) | `path_series` | coupon-paid / below-KI counts per step | counts change | counts change |
| Branch Flow (riga) | `query_execution_net` | KO / survive / put / coupon populations | put/coupon populations grow | populations change |

### 4.7 riga-flow — governance & metadata

| Tile | Tool | Watch | Trade edit | Market edit |
|---|---|---|---|---|
| Governance Evidence | `export_governance_evidence` | assumptions, limitations, stress methodology, lineage | trade assumptions update | market lineage sha changes |
| Root Cause | `root_cause` | RCA finding, evidence refs, change log | finding/refs update | update |
| Regression Triage | `freeze_baseline`→`compare_corpus`→`triage_regression` | baseline id, comparison verdict | a trade edit is a *change* → triage reports it | likewise |
| Data Lineage | `get_ledger` determinism | determinism envelope + evidence refs graph | seed/as_of stable | market sha changes |

### 4.8 tac-engine — market data

These tiles read `tac-engine` (Alpaca + FRED + the local lake). They do **not**
price the trade; they feed the market block. TAC_LAKE_DIR / APCA_* must be set.

| Tile | Tool | Watch | Trade edit | Market/data edit |
|---|---|---|---|---|
| Market Data Workbench | fetch tools | source, effective market JSON | — | **changed** |
| Symbol Picker | `get_lake_symbols`, `get_lake_coverage` | symbol list, coverage | — | — |
| Bar Chart | `get_lake_bars` | OHLCV candles | — | — |
| TA / SP Panes | `get_lake_ta`, `get_lake_sp` | indicator panes | — | — |
| Correlation Matrix (tac) | `corr_matrix` | ρ heatmap + resolved pairs | — | — (its own data) |
| Vol Surface (tac) | `vol_surface` | strike × maturity grid (**2D/3D toggle**) | — | — |
| Yield Curve | `get_macro_bars` (FRED) | tenor pillars | — | — |
| FX Spot | `get_forex_latest_rates` | per-pair spot (not sent to riga-flow) | — | — |
| FX Vol | `get_lake_fx_vol` | realized FX vol + window matrix | — | — |
| Corporate Actions | `get_corporate_actions` | dividends/splits | — | — |
| Lake Coverage | `get_lake_coverage`, `get_lake_status`, `validate_lake_dataset` | windows + dataset verdict | — | — |
| Manipulation Editor | (pure selector) | manipulation rows + effective market | — | **changing a row changes the effective market**, and the mapped riga market |

> **tac-engine note.** These tiles auto-fetch once on first mount and never fall
> back to fake data: with no lake/keys they show their "market source not
> configured" empty state. The **Vol Surface (tac)** 3D view is drag-to-rotate and
> scroll-to-zoom; the maturities are Excel serials rendered as dates.

---

## 5. Negative / robustness checks

- Remove the **Trade Economics** and **Market Data** tiles from the dashboard
  (they are ordinary tiles now — no fixed strip). Restart nothing. The other
  tiles must keep working off the shared state (the request is composed from the
  stores, not from the panels being mounted).
- **Petri net:** drag a node, then change the selected transition from a watcher
  row — the dragged node must **keep its position** (selection must not rebuild
  the graph). "reset layout" restores the computed layout.
- **Trace level only** (off / sampled / full): no priced number changes anywhere
  (a tile that needs detail, e.g. Token Detail, shows a "trace off" empty state).
- Paste deliberately broken JSON into the Trade Economics `Paste` box → the tile
  shows an import error and every other tile keeps its last good values.
- Resize the window / re-layout the dashboard → no tile crashes (charts re-fit).

---

## 6. Automation inventory (what CI already proves)

| Concern | Test |
|---|---|
| Edit reaches all 16 watching tools (direct + via document) | `tradeSync.test.tsx` |
| Request injection per tool; `health` excluded | `fixtureRequestInjection.test.tsx` |
| Debounce / coalescing; market-only change re-runs | `rigaReactivity.test.tsx` |
| One net canvas; layer switch; watchers pin the selection | `netWatchers.test.tsx` |
| Engine inline `request` ≡ fixture; override works | `crates/riga-mcp` |
| Instrument store import/apply/patch syncs flat stores | `instrumentStore.test.ts` |
| Trade tile renders tabular form; nested → cards; collapses | `tradeEconomicsPanel.test.tsx` |
| Market lane toggle + JSON import | `marketDataPanel.test.tsx` |
| Every tile type renders without throwing | `TileRenderer.test.tsx` |
| tac heatmaps theme-aware; 3D surface finite/in-bounds; ramp | `tacHeatmaps.test.tsx` |
| Date heuristic (Excel/ISO/Unix/…) | `dates.test.ts` |
| oklch → sRGB chart bridge | `colors.test.ts` |
| Blank dashboard creation | `TemplateGallery.test.tsx` |

---

## 7. Desktop release validation (per platform)

The release workflow (`.github/workflows/release.yml`) publishes one GitHub
Release with these variants:

| Variant | Runner | Bundles |
|---|---|---|
| `linux-x86_64` | `ubuntu-24.04` | `.deb`, `.rpm`, AppImage |
| `linux-cuda-x86_64` | `ubuntu-22.04` + CUDA toolkit | `.deb` (NVIDIA only; needs `libcuda` + CUDA runtime) |
| `windows-x86_64` | `windows-2025` | `.msi`, `-setup.exe` (NSIS) |
| `macos-aarch64` | `macos-15` | `.dmg` (Metal, CPU fallback) |
| `macos-x86_64` | `macos-15-intel` | `.dmg` |
| `android-<abi>` | `ubuntu-22.04` + Android SDK/NDK | `.apk` per ABI (arm64/arm/x86/x86_64), signed with a disposable CI key |

Smoke-check each download on its platform:

1. **Linux (CPU):** install the `.deb` → launch → the *riga-flow Lineage*
   dashboard loads and `Health & Run` shows the engine version. `linux-cuda` is
   only for machines with an NVIDIA driver + CUDA runtime; its tiles must match
   the CPU build's numbers (the engine is deterministic).
2. **Windows:** run the `.msi`/setup → the same dashboard loads; the two engine
   sidecars (`riga-mcp.exe`, `tac-engine.exe`) are bundled next to the app.
3. **macOS:** open the `.dmg` (Gatekeeper warns on unsigned builds) → the Metal
   build runs on Apple Silicon and falls back to CPU elsewhere.
4. **Android:** sideload the APK for your ABI (`arm64` for phones, `x86_64` for an
   emulator). The mobile build is a **preview**: the desktop workspace/Git/shell,
   MCP stdio and the local GGUF runtime are not validated on mobile (see the
   release notes), so tiles that need the bundled engines show their empty state.
   The disposable CI signing key means you must uninstall an earlier preview
   before installing a new one.
