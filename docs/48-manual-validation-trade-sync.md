# 48 — Manual validation: does the trade economics propagate to the tiles?

**Goal:** confirm that editing the **Trade Economics (riga)** tile is *watched* —
every tile that depends on it re-prices against the edited trade, and nothing
crashes. This is the end-to-end check of the inline-`request` fix (docs/46 §7.1 /
§8) that the vitest suite mocks.

Companion automation (already in CI):
- `src/features/riga/__tests__/tradeSync.test.tsx` — editing the trade (directly
  or via the instrument document) reaches **all 16 watching tools** with the new
  `request`.
- `src/features/riga/__tests__/fixtureRequestInjection.test.tsx` — request present
  on fixture tools, absent on `health`, once on `price_trade`.
- `crates/riga-mcp` — inline `request` ≡ on-disk fixture; a changed request
  *overrides* the fixture.

Manual run adds what a mock cannot: **real engine numbers changing**.

---

## 0. Setup

1. `npm run tauri:dev:cuda` (or `npm run dev:all` + the two engines), with the
   rebuilt `riga-mcp` (`cargo build --release -p riga-mcp`).
2. Top bar: **Pricing source → `riga`**, **Trace → `full`**.
3. Add tiles: `Add tile` → group **riga-flow**. Place at least:
   `Trade Economics (riga)`, `Market Data (riga)`, `Leg Attribution`,
   `Statistics Summary`, `Risk Net`, `Explain Net`, `Transition Detail`,
   `PathCube Query`, `Book Risk`, `Scenario Comparison`, `Health & Run`.
   (Or create a dashboard from the *riga-flow Lineage* template.)
4. Note the **run id** in each tile footer (`Provenance`) — it is the market
   snapshot id, derived from the market.

## 1. Baseline

In every tile, record the headline number (PV / KI rate / etc.). All should be
populated (no error stripes) because the request now reaches every tool.

## 2. Change the TRADE (the core test)

In **Trade Economics (riga)** → `Legs → Leg 1 → Put leg` → set
**Strike (× initial)** from `0.78` → **`0.60`** (a deep-ITM put: bigger payoff).

Expected, per tile:

| Tile | Tool | Expected |
|---|---|---|
| Trade Economics | `price_trade` | **PV rises**; engine model unchanged; seed unchanged |
| Leg Attribution | `explain_pv_attribution` | **Down-and-in put PV rises**, **Total PV rises**, **KI probability rises** |
| Statistics Summary | `get_branch_stats` `get_mc_diagnostics` `get_distributions` | PV, MC error, KI rate change together |
| Risk Net | `query_risk_net` | per-transition signed risk changes |
| Explain Net | `get_ledger` | ledger rows' PV impact changes |
| Transition Detail | `get_ledger` + stats | populations / Δ / ν change |
| Payoff Petri Net | `get_branch_stats` | transition populations / firing probabilities change |
| PathCube Query | `query_path_cube` | see §4 — worst-percentile sample changes |
| Execution Tape | `execution_events` | KO/KI/maturity events change |
| Book Risk | `compute_book_risk` | per-notional PV & greeks change |
| Scenario Comparison | `scenario` | base / up / down PV change |
| P&L Attribution | `pl_explain` | contributions change |
| Taylor Explain | `valuation_explain` | base→current PV & residual change |
| Greeks Sanity | `validate_greeks` | flags may change |
| Stress Bands | `recommend_scenarios` | KI/KO band recommendations change |

**Negative controls (must NOT change when the *trade* changes):**
- **Health & Run** (`health`) — version/features/seed are trade-independent.
- **Market Snapshot (riga)** (`get_market`) — as-of, spots, vols depend on the
  *market*, not the trade.

**Pass criteria:** every tile in the table changes in the *expected direction*
(a deeper strike ⇒ larger down-and-in put ⇒ larger total PV and higher KI
probability), the negative controls do not change, and no tile shows an error
stripe. Footer run ids stay stable (only the trade changed, not the market).

### 2.1 `Risk Net` (`query_risk_net`) — detailed validation

**What the tile shows.** A React-Flow graph of the **execution net** (from
`query_execution_net`), where each transition node is labelled
`Δ <deltaImpact> · ν <vegaImpact>` and **tinted by the signed delta impact**
(green = +, red = −, opacity ∝ |Δ| / max|Δ|). Footer KPIs: **DV01** and
**Correlation ρ**. Footer table: **per-asset** `Delta / Gamma / Vega`, one row per
underlying. Engine transition ids mapped to the drawn nodes:
`daily_global_ko` (KO gate), `final_fixing_eki` (**down-and-in put**),
`memory_coupon`.

**Where the numbers come from.** `query_risk_net` returns
`transitions[] = { id, pv_impact, delta_impact, vega_impact }` (the put leg's
Explain-Ledger entries) + `per_asset[] = { asset_index, delta, gamma, vega }`
(central-FD risk batch) + `dv01` + `correlation_sensitivity`.

**Procedure.** Baseline → set **Strike 0.78 → 0.60** (deeper ITM put) → wait for
the re-run.

**Expected change, per element:**

| Element | Expectation after a deeper strike |
|---|---|
| `final_fixing_eki` (down-and-in put) node | Δ impact **grows in magnitude**, ν impact **grows**, the label digits change, the tint intensifies |
| `daily_global_ko` / `memory_coupon` nodes | Δ/ν change modestly (they're KO/coupon driven, not strike driven) |
| `DV01` KPI | changes (a bigger put carries more rate sensitivity) |
| `Correlation ρ` KPI | changes (worst-of correlation sensitivity grows with the put) |
| per-asset table | delta more negative, gamma and vega larger in magnitude |

**Judging pass/fail:**
1. **All** Δ/ν node labels and the per-asset numbers must differ from baseline —
   that is what proves `query_risk_net` re-ran against the *edited* trade (not the
   on-disk fixture).
2. A node's impact **sign must be stable** across the two runs; only the
   magnitude should grow. A sign flip on a *trade* edit is a red flag (it means
   a different quantity is being charted, not a larger one).
3. The **graph shape must not change** — places/transitions come from
   `query_execution_net`, which is a separate tool call; only the overlay may
   change. If nodes move, something else broke.
4. Click `final_fixing_eki` → it becomes selected → the **Transition Detail** tile
   shows PV / Δ / ν for the *same* transition. The two tiles must agree (cross-tile
   consistency, same `request`).

**Negative controls.**
- **Trace level only** (off / sampled / full): **no** Δ/ν/DV01/ρ change — trace
  affects detail, never pricing.
- **Market-only change** (raise vols): vega, vega-impact and correlation ρ move
  more than delta (delta is spot-driven).

## 3. Change the MARKET (second axis)

In **Market Data (riga)** (lane **Instrument market** or **Lake**), raise both
**ATM vols** by ~5 vol points, or bump the **spots**. Expected: every PV/risk tile
re-prices; **Market Snapshot** spots/vols change; footer run ids change. This
proves the market axis is wired independently of the trade axis.

## 4. PathCube tile — specific criteria

The `PathCube Query` tile calls `query_path_cube` with a fixed **percentile**
(default `0.05`, "worst 5%"), so it always shows the same *slice*, never a random
one. To validate it watches the trade:

1. Baseline: the tile shows the worst-5% sample — per-path `worstFinal`,
   `knockedOut`, `kiHit`, `putPayoff`.
2. Set **Strike = 0.60** (from §2) and wait for the re-run.
3. **Expect:** the sample's `putPayoff` values rise and the KI-hit proportion
   rises; the number of returned paths is unchanged (the control, not the trade,
   sets it).
4. **Expect NOT to change:** the percentile selector value (`0.05`) and the tile's
   error/empty state. Changing **Trace level** alone must not change any priced
   number (only how much detail is returned).

## 5. Negative / robustness checks

- Remove the **Trade Economics** and **Market Data** tiles from the dashboard
  (they are ordinary tiles now — no fixed strip). Restart nothing. The other
  tiles must keep working off the shared state (the request is composed from the
  stores, not from the panels being mounted).
- With the tiles removed, change the source to `demo` and back to `riga`; no tile
  should crash.
- Paste deliberately broken JSON into the Trade Economics `Paste` box → the tile
  shows an import error and every other tile keeps its last good values (the
  document is not replaced).

## 6. Automation inventory (what CI already proves)

| Concern | Test |
|---|---|
| Edit reaches all 16 watching tools (direct + via document) | `tradeSync.test.tsx` |
| Request injection per tool; `health` excluded | `fixtureRequestInjection.test.tsx` |
| Debounce / coalescing; market-only change re-runs | `rigaReactivity.test.tsx` |
| Engine inline `request` ≡ fixture; override works | `crates/riga-mcp` |
| Instrument store import/apply/patch syncs flat stores | `instrumentStore.test.ts` |
| Trade tile renders tabular form; nested → cards; collapses | `tradeEconomicsPanel.test.tsx` |
| Market lane toggle + JSON import | `marketDataPanel.test.tsx` |
| Every tile type renders without throwing | `TileRenderer.test.tsx` |
| Blank dashboard creation | `TemplateGallery.test.tsx` |
