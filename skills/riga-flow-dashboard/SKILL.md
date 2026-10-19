---
name: riga-flow-dashboard
description: Explain any tile by calling the MCP tools that feed it — the code-derived tile-to-tool map for the riga-flow and tac-engine workspaces.
---

# riga-flow dashboard explainer

When the user asks about a tile — what it shows, why a value is what it is, or to
analyse it — **call the tool that feeds that tile** and explain only what the
result contains. Never compute or guess.

**Rule of thumb:** find the tile in the map below → call its tool(s) with `{}` (the
pinned `termsheet1` fixture) or with the user's live trade/market as the `request`
param → quote the fields named in the *Read* column, citing `run_id` /
`market_snapshot_id`.

The app ships **67 tiles** in two lanes: **riga-flow** (55, the pricing/risk/explain
engine) and **tac-engine** (12, real market data). The demo lane was retired
(`docs/49 §P4`). This map is derived from the tile components' hooks, so it stays
in step with the code.

Every riga-flow tool is fixture-based and takes an optional `fixture_path` (pinned
`termsheet1` by default) **and** an optional inline `request`; call with `{}` for
the baseline, or pass the edited trade/market as `request`.

## The Petri net is the source of truth

The net is drawn **once**. Everything else is a *watcher* bound to the same
selection — do not explain Risk Net / Explain Net as separate graphs.

| Tile | Role | Tools to call |
| --- | --- | --- |
| **Payoff Petri Net** | **source of truth** — the only net canvas, with an **Execution / Risk / Explain layer switch** | `query_execution_net`; add `query_risk_net` for the Risk layer, `get_ledger` for the Explain layer |
| Risk Net | **watcher** (table, no canvas): Δ/ν per transition for the selected node | `query_risk_net` |
| Explain Net | **watcher** (table, no canvas): ledger row for the selected transition | `get_ledger` |
| Transition Detail | inspector for the **selected transition** | `get_ledger` + `get_branch_stats` + `query_risk_net` + `query_execution_net` |
| Token Detail | inspector for the **selected place** | `query_execution_net` + `query_path_cube` + `execution_events` (+ `replay_path` on demand) |

Clicking a node selects it everywhere; clicking a watcher row selects it too (and
highlights the node). The graph **shape** comes only from `query_execution_net` —
the layer changes the *tint*, never the topology.

## riga-flow — trade, structure & lineage

| Tile | Tool(s) | Read |
| --- | --- | --- |
| Trade Economics (riga) | `price_trade` | the worst-of Phoenix fields (`trade_id`, barriers, coupon, steps) and the priced PV |
| Market Data (riga) | **no tool** (a pure editor over the composed request) | its spots/vols/correlation/rate feed `price_trade` and every fixture tool via `request` |
| Market Explorer (riga) | `get_market` | spots, flat ATM vols, correlation |
| Vol Surface (riga) | `get_market` + the instrument document | the Dupire local-vol grid (market-derived) |
| Payoff Petri Net | `query_execution_net` (+ `query_risk_net` / `get_ledger` per layer) | `places[{id,tokens}]`, `transitions[{population_before,population_after,probability,pv_impact}]`, `run_id` |
| Payoff Graph (riga) | `query_execution_net` | the 8-transition product graph (`payoff_graph`); the execution net is its priced projection |
| Data Lineage | `get_ledger` | `determinism{seed,as_of,market_snapshot_id}`; evidence refs trade → market(sha256) → seed → transitions |
| PathCube Query | `query_path_cube` (`{percentile}`) | worst-percentile `sample: PathRecord[]` |
| Execution Tape | `execution_events` (`{max_paths}`) | bounded `tape[{path_id,events,pv}]` |
| Market Snapshot (riga) | `list_markets` → `get_market` | `snapshot_id`, spots, vols, correlation, rate |
| Health & Run | `health` | `status`, `version`, `git_sha`, `features.cpu_gbm/gpu/aad` |

## riga-flow — cashflow & distribution

| Tile | Tool(s) | Read |
| --- | --- | --- |
| Cashflow Summary (riga) | `build_cashflows` | mean per-leg PV and sampled paths |
| Cashflow Timeline (riga) | `build_cashflows` | expected coupon PV and paid probability per period |
| Distribution Summary (riga) | `get_distributions` | `worst_final_deciles[10]`, `ki_rate`, `mean_put` |
| Payoff Histogram (riga) | `distributions_histogram` | PV histogram + percentiles |
| Distribution Explorer (riga) | `distributions_histogram` | mean/median/std/P05/P95 per metric |
| Selected Path (riga) | `query_path_cube` | worst-percentile sample + coupon-by-period |

## riga-flow — convergence / MC diagnostics

| Tile | Tool(s) | Read |
| --- | --- | --- |
| PV Convergence (riga) | `mc_convergence` | PV vs path count with a 95% CI band |
| CI Shrinkage (riga) | `mc_convergence` | 95% CI width vs path count |
| Error vs Path Count (riga) | `mc_convergence` | observed SE vs theoretical 1/√N |
| KI Convergence (riga) | `mc_convergence` | KI probability vs path count |
| KO Convergence (riga) | `mc_convergence` | KO probability vs path count |
| Convergence Health (riga) | `mc_convergence` | final estimator quality + the path ladder |
| Statistics Summary | `get_branch_stats` + `get_distributions` + `get_mc_diagnostics` | `TransitionStats[]`; `pv`, `mc_error`, `relative_se`; deciles/KI/mean-put |
| Percentile Convergence (riga) | `percentile_convergence` | terminal worst-of P05/P50/P95 vs path count |
| Distribution Stability (riga) | `percentile_convergence` | P05–P95 worst-of bands across path counts |

> Convergence tiles are **estimator properties**: a trade/market edit moves the
> *level*, not the *shape* of the shrinkage curve.

## riga-flow — risk & scenario

| Tile | Tool(s) | Read |
| --- | --- | --- |
| Risk Summary (riga) | `risk_batch` | per-asset Δ/Γ/ν, `dv01`, `correlation_sensitivity` |
| Greeks Table (riga) | `risk_detailed` | per-asset Δ/Γ/ν + θ/ρ, cross-gamma |
| Greeks Waterfall (riga) | `risk_detailed` | risk magnitude by factor (spot/vol/rate/correlation/theta) |
| Bucket Vega (riga) | `risk_detailed` | vega by factor |
| Leg Attribution | `explain_pv_attribution` + `query_risk_net` | PV by leg and PV/Δ/ν by transition |
| Risk Net | `query_risk_net` | per-transition `pv_impact/delta_impact/vega_impact`; `per_asset[]`; `dv01`; `correlation_sensitivity` (watcher) |
| Scenario Comparison (riga) | `scenario` | rate/correlation up/down PVs + per-asset Greeks |
| Greeks Sanity | `validate_greeks` | `flags[{severity,message}]` |
| Stress Bands | `recommend_scenarios` | `recommendations[{spot_band,reason}]` |
| Book Risk | `compute_book_risk` (`{notionals}`) (or `price_book_async`) | `trades`, `pv`, `delta[]`, `gamma[]`, `vega[]`, `dv01`, `correlation_sensitivity` |

> The engine's **ledger** entries hard-code `delta_impact = vega_impact = 0`;
> `query_risk_net` attributes per-transition Δ/ν by differencing each transition's
> PV impact across the CRN spot/vol bump pairs. If those read `0.0000`, the binary
> is stale (`cargo build --release -p riga-mcp`).

## riga-flow — valuation & explain

| Tile | Tool(s) | Read |
| --- | --- | --- |
| Master Explain Waterfall (riga) | `valuation_explain` | base PV → market explain → residual → current PV |
| Taylor Explain (riga) | `valuation_explain` | `base_pv`, `current_pv`, `predicted_dpv`, `residual`, `contributions[]` (P&L Attribution was folded in here) |
| Explain Net | `get_ledger` | `LedgerEntry[]`: `condition`, `population_before/after`, `pv/delta/vega_impact`, `evidence_refs` (watcher) |
| Transition Detail | `get_ledger` + `get_branch_stats` + `query_risk_net` + `query_execution_net` | populations, firing probability, PV/Δ/ν, `transition_stats`, `evidence_refs`, **static** reference formula |
| Token Detail | `query_execution_net` + `query_path_cube` + `execution_events` (+ `replay_path`) | a bounded sample of `PathRecord`s per place; riga-flow returns **counts**, not token vectors |

## riga-flow — path & behaviour (all `path_series`)

| Tile | Tool(s) | Read |
| --- | --- | --- |
| Path Timeline (riga) | `path_series` | `series[]` (selected path `worst_of` per step) + `barriers` |
| Quantile Fan (riga) | `path_series` | `bands[]` P05–P95 worst-of envelope |
| Worst-of Evolution (riga) | `path_series` | `bands[]` median with P05/P95 |
| Barrier Crossings (riga) | `path_series` | `crossings[]` below-KI / above-KO counts per step |
| State Occupancy (riga) | `path_series` | `states[]` above/below-KI + coupon-paid counts per step |
| Observation Schedule (riga) | `path_series` | `steps` + `crossings[]`/`states[]` per observation |
| Schedule Explorer (riga) | `path_series` | `states[]` coupon-paid / below-KI counts per step |
| Branch Flow (riga) | `query_execution_net` | `transitions[]` populations mapped onto the **Phoenix payoff decision tree** P01–P08 |

**`path_series` semantics worth quoting.** `barriers` carries
`{knock_in, knock_out, coupon, strike}` (the tiles draw all four as reference
lines). **t = 0 is a single point**: every path starts at its initial spot, so all
bands are exactly `1.0` at `years: 0`; the last step is maturity. If the fan
starts from a spread, the engine binary is stale.

**Branch Flow is the payoff decision tree** (`PheonixPayoff.md`, Diagram 2):
`Paths → KO (the trade's P01/P02/P03/P04 variant) | No KO → maturity → KI (P07,
below the maturity barrier) | No-KI (P08)`. The coupon leg is **additive** on every
branch (`FinalPayoff = CouponLeg + OptionLeg + ReturnRatio`), not a competing flow.
Branches the trade cannot reach are named, not invented: `P05` when
`rails.lowCallStrik` is disabled (`≥ 900`), `P06` when
`rails.maturBarrier > knockInBarrier` (every KI path is below it).

## riga-flow — trade design & governance

| Tile | Tool(s) | Read |
| --- | --- | --- |
| Economics Impact Summary (riga) | `trade_design` | base expected PV, coupon/put PV, KO/KI |
| Sensitivity Tornado (riga) | `trade_design` | trade parameters ranked by one-step PV impact |
| Parameter Impact Matrix (riga) | `trade_design` | ΔPV / ΔKI / ΔKO per trade parameter |
| Governance Evidence | `export_governance_evidence` | `assumptions[]`, `limitations[]`, `stress_methodology`, `lineage{}` |
| Root Cause | `root_cause` | `finding`, `evidence_refs[]`, `change_log` — Full trace |
| Regression Triage | `freeze_baseline` → `compare_corpus` / `triage_regression` | `within_tolerance`, `exceptions[]`, `count` |

## tac-engine — market data (real data; never faked)

| Tile | Tool(s) | Read |
| --- | --- | --- |
| Market Data Workbench | `get_stock_snapshot`, `vol_surface`, `corr_matrix`, `get_macro_bars`, `get_lake_bars` + the manipulation overlay | fetched market, source/coverage, effective market mapped onto the riga-flow request |
| Symbol Picker | `get_lake_symbols` + `get_lake_coverage` | symbol master + lake coverage |
| Bar Chart | `get_lake_bars` | OHLCV candles |
| TA / SP Panes | `get_lake_ta` + `get_lake_sp` | technical + stochastic-process panes |
| Correlation Matrix (tac) | `corr_matrix` | ρ heatmap + resolved pairs |
| Vol Surface (tac) | `vol_surface` | calibrated strike × maturity grid (**2D / 3D** toggle) |
| Yield Curve | `get_macro_bars` (FRED DGS tenors) | discount-curve pillars |
| FX Spot | `get_forex_latest_rates` | per-pair FX spot (**not** sent to riga-flow — R-EXT-1) |
| FX Vol | `get_lake_fx_vol` | realized FX vol + window matrix |
| Corporate Actions | `get_corporate_actions` | dividends/splits feeding the dividend yield |
| Lake Coverage | `get_lake_coverage` (+ `get_lake_status`) | loaded windows + dataset verdict |
| Manipulation Editor | **no tool** (pure overlay) | manipulation rows + the effective-market JSON |

> tac tiles show a "market source not configured" empty state without a lake/keys —
> they never fall back to fake data. `vol_surface` maturities are Excel serials
> rendered as dates.

## How to analyse a tile (recipe)

1. **Identify** the tile in the map → its tool(s).
2. **Call** the primary tool with `{}` (baseline). If the user edited the trade or
   market, pass the composed `request` instead (see the `riga-flow-cli` skill for
   `--set`/`--template`).
3. **Read** the fields named in *Read*; quote units, and the `run_id` /
   `market_snapshot_id`.
4. **Cross-check** when the user asks "why":
   - a transition's numbers → `get_ledger` + `query_risk_net` + `get_branch_stats`
   - PV vs risk → `price_trade` vs `risk_batch`
   - distribution vs convergence → `get_distributions` vs `mc_convergence`
   - market context → `get_market` / `list_markets` (+ tac tools for real data)
5. **Say what is not exposed** rather than approximating: full token vectors
   (R-EXT-2), FX into riga-flow (R-EXT-1), per-payoff P01–P08 populations (the
   Branch Flow derives the reachable ones from the execution net).

## Trace level gates the path tiles

- **Off** — aggregate only; `query_path_cube`, `execution_events`, `pl_explain`,
  `valuation_explain`, `root_cause`, `export_governance_evidence` are not called and
  their tiles show "trace off — aggregate only".
- **Sampled** — path tools are bounded (`max_sample`/`max_paths`).
- **Full** — Root Cause and Governance Evidence populate.

If a path tile is empty, check the trace level before inventing data.

## Rules

- Ground every number in a tool result; cite the `run_id` / `market_snapshot_id`.
- Never re-derive a formula: the "formula (static)" text in Transition Detail is
  reference copy, not a computed value.
- The net is **one** canvas: Risk Net / Explain Net are watchers, and the graph
  shape never changes with the layer.
- riga-flow is 2-factor and fixture-driven; an edited field the engine rejects must
  be reported as the structured `{code,message}` — never "fixed" locally.
- FX/FX-vol are real tac-engine data but are **not** sent to riga-flow until
  R-EXT-1; full token vectors are an engine gap (R-EXT-2).
