---
name: riga-flow-dashboard
description: Explain every tile of the riga-flow Lineage & Explainability Workspace, and the tac-engine market-data workspace, by calling the MCP tools that populate them.
---

# riga-flow dashboard explainer

When the user is on the **riga-flow Lineage & Explainability Workspace** (or a
dashboard built from it) and asks what a tile shows or why a value is what it is,
read the tile from the **riga-flow MCP connector** — never compute or guess. Each
tile is fed by one or more tools; call the tool, then explain only what the result
contains.

The app now ships **67 tiles** in two lanes: **riga-flow** (55, the pricing/risk/
explain engine) and **tac-engine** (12, real market data). The demo lane was
retired (`docs/49 §P4`).

## The Petri net is the source of truth

The net is drawn **once**. Everything else is a *watcher* bound to the same
selection — do not explain Risk Net / Explain Net as separate graphs.

| Tile | Role | Backed by |
| --- | --- | --- |
| **Payoff Petri Net** | **source of truth** — the only net canvas, with an **Execution / Risk / Explain layer switch** | `query_execution_net` (+ `query_risk_net` for the Risk layer, `get_ledger` for the Explain layer) |
| Risk Net | **watcher** (table, no canvas): Δ/ν per transition for the selected node | `query_risk_net` |
| Explain Net | **watcher** (table, no canvas): ledger row for the selected transition | `get_ledger` |
| Transition Detail | inspector for the **selected transition** | `get_ledger` + `get_branch_stats` + `query_risk_net` + `query_execution_net` |
| Token Detail | inspector for the **selected place** | `query_path_cube` + `execution_events` + `replay_path` |

Clicking a node selects it everywhere; clicking a watcher row selects it too (and
highlights the node). The graph **shape** comes only from `query_execution_net` —
the layer changes the *tint*, never the topology.

## Tile → tool map

Every riga-flow tool is fixture-based and takes an optional `fixture_path` (pinned
`termsheet1` by default) **and** an optional inline `request`; call with `{}` for
the baseline, or pass the edited trade/market as `request`.

### riga-flow — trade, structure & lineage

| Tile | Tool(s) | What you're reading |
| --- | --- | --- |
| Trade Economics (riga) | `price_trade` | the worst-of Phoenix fields (`trade_id`, barriers, coupon, steps) and the priced PV |
| Market Data (riga) | `price_trade` | effective market: `spots[]`, `vols[]`, `dividend_yields[]`, scalar rate, 2×2 `correlation` |
| Market Explorer (riga) | `get_market` | spots, flat ATM vols, correlation |
| Vol Surface (riga) | `get_market` + the instrument document | the Dupire local-vol grid; market-derived, not trade-derived |
| Payoff Petri Net | `query_execution_net` | `places[{id,tokens}]`, `transitions[{population_before,population_after,probability,pv_impact}]`, `run_id` |
| Payoff Graph (riga) | `query_execution_net` | the 8-transition product graph (`payoff_graph`) — the execution net is its priced projection |
| Data Lineage | `get_ledger` | `determinism{seed,as_of,market_snapshot_id}`; evidence refs trade → market(sha256) → seed → transitions |
| PathCube Query | `query_path_cube {percentile}` | worst-percentile `sample: PathRecord[]` |
| Execution Tape | `execution_events {max_paths}` | bounded `tape[{path_id,events,pv}]` |
| Market Snapshot (riga) | `get_market` / `list_markets` | `snapshot_id`, spots, vols, correlation, rate |
| Health & Run | `health` | `status`, `version`, `git_sha`, `features.cpu_gbm/gpu/aad` |

### riga-flow — cashflow & distribution

| Tile | Tool(s) | What you're reading |
| --- | --- | --- |
| Cashflow Summary (riga) | `build_cashflows` | mean per-leg PV and sampled paths |
| Cashflow Timeline (riga) | `build_cashflows` | expected coupon PV and paid probability per period |
| Distribution Summary (riga) | `get_distributions` | `worst_final_deciles[10]`, `ki_rate`, `mean_put` |
| Payoff Histogram (riga) | `distributions_histogram` | PV distribution histogram + percentiles |
| Distribution Explorer (riga) | `distributions_histogram` | mean/median/std/P05/P95 per metric |
| Selected Path (riga) | `query_path_cube` | worst-percentile sample + coupon-by-period |

### riga-flow — convergence / MC diagnostics

| Tile | Tool(s) | What you're reading |
| --- | --- | --- |
| PV Convergence (riga) | `mc_convergence` | PV vs path count with a 95% CI band |
| CI Shrinkage (riga) | `mc_convergence` | 95% CI width vs path count |
| Error vs Path Count (riga) | `mc_convergence` | observed SE vs theoretical 1/√N |
| KI Convergence (riga) | `mc_convergence` | KI probability vs path count |
| KO Convergence (riga) | `mc_convergence` | KO probability vs path count |
| Convergence Health (riga) | `mc_convergence` | final estimator quality + the path ladder |
| Statistics Summary | `get_branch_stats` + `get_mc_diagnostics` + `get_distributions` | `TransitionStats[]`; `pv`, `mc_error`, `relative_se`; deciles/KI/mean-put |
| Percentile Convergence (riga) | `percentile_convergence` | terminal worst-of P05/P50/P95 vs path count |
| Distribution Stability (riga) | `percentile_convergence` | P05–P95 worst-of bands across path counts |

> Convergence tiles are **estimator properties**: a trade/market edit moves the
> *level*, not the *shape* of the shrinkage curve.

### riga-flow — risk & scenario

| Tile | Tool(s) | What you're reading |
| --- | --- | --- |
| Risk Summary (riga) | `risk_batch` | per-asset Δ/Γ/ν, `dv01`, `correlation_sensitivity` |
| Greeks Table (riga) | `risk_detailed` | per-asset Δ/Γ/ν + θ/ρ, cross-gamma |
| Greeks Waterfall (riga) | `risk_detailed` | risk magnitude by factor (spot/vol/rate/correlation/theta) |
| Bucket Vega (riga) | `risk_detailed` | vega by factor |
| Leg Attribution | `explain_pv_attribution` + `query_risk_net` | PV by leg and PV/Δ/ν by transition |
| Risk Net | `query_risk_net` | per-transition `pv_impact/delta_impact/vega_impact`; `per_asset[{asset_index,delta,gamma,vega}]`; `dv01`; `correlation_sensitivity` (watcher for the selected node) |
| Scenario Comparison (riga) | `scenario` | `rate_up_pv`/`rate_down_pv`/`correlation_up_pv`/`correlation_down_pv`, per-asset Greeks |
| Greeks Sanity | `validate_greeks` | `flags[{severity,message}]` |
| Stress Bands | `recommend_scenarios` | `recommendations[{spot_band,reason}]` |
| Book Risk | `compute_book_risk {notionals}` / `price_book_async` | `trades`, `pv`, `delta[]`, `gamma[]`, `vega[]`, `dv01`, `correlation_sensitivity` |

> The engine's **ledger** entries hard-code `delta_impact = vega_impact = 0`;
> `query_risk_net` attributes per-transition Δ/ν by differencing each transition's
> PV impact across the CRN spot/vol bump pairs. If those read `0.0000`, the binary
> is stale (`cargo build --release -p riga-mcp`).

### riga-flow — valuation & explain

| Tile | Tool(s) | What you're reading |
| --- | --- | --- |
| Master Explain Waterfall (riga) | `valuation_explain` | base PV → market explain → residual → current PV |
| Taylor Explain (riga) | `valuation_explain` | `base_pv`, `current_pv`, `predicted_dpv`, `residual`, `contributions[]` (the P&L Attribution view was folded in here) |
| Explain Net | `get_ledger` | `LedgerEntry[]`: `condition`, `population_before/after`, `pv/delta/vega_impact`, `evidence_refs` (watcher for the selected transition) |
| Transition Detail | `get_ledger` + `get_branch_stats` + `query_risk_net` | populations, firing probability, PV/Δ/ν impact, `transition_stats`, `evidence_refs`, **static** reference formula |
| Token Detail | `query_path_cube` + `execution_events` + `replay_path` | a bounded sample of `PathRecord`s per place; riga-flow returns **counts**, not token vectors |

### riga-flow — path & behaviour

| Tile | Tool(s) | What you're reading |
| --- | --- | --- |
| Path Timeline (riga) | `path_series` | selected-path worst-of over steps + barrier levels |
| Quantile Fan (riga) | `path_series` | population P05–P95 worst-of envelope |
| Worst-of Evolution (riga) | `path_series` | median worst-of with P05/P95 |
| Barrier Crossings (riga) | `path_series` | below-KI / above-KO counts per step |
| State Occupancy (riga) | `path_series` | above/below-KI and coupon-paid counts per step |
| Observation Schedule (riga) | `path_series` | steps + barrier hits per observation |
| Schedule Explorer (riga) | `path_series` | coupon-paid / below-KI counts per step |
| Branch Flow (riga) | `query_execution_net` | KO / survive / put / coupon populations |

### riga-flow — trade design & governance

| Tile | Tool(s) | What you're reading |
| --- | --- | --- |
| Economics Impact Summary (riga) | `trade_design` | base expected PV, coupon/put PV, KO/KI |
| Sensitivity Tornado (riga) | `trade_design` | trade parameters ranked by one-step PV impact |
| Parameter Impact Matrix (riga) | `trade_design` | ΔPV / ΔKI / ΔKO per trade parameter |
| Governance Evidence | `export_governance_evidence` | `assumptions[]`, `limitations[]`, `stress_methodology`, `lineage{sampled_paths[],evidence_refs[]}` |
| Root Cause | `root_cause` | `finding`, `evidence_refs[]`, `change_log` (baseline vs current) — Full trace level |
| Regression Triage | `freeze_baseline` → `compare_corpus` / `triage_regression` | `within_tolerance`, `exceptions[]`, `count` (needs a frozen baseline first) |

### tac-engine — market data (real data, not the engine)

| Tile | Tool(s) | What you're reading |
| --- | --- | --- |
| Market Data Workbench | `get_stock_snapshot(s)`, `vol_surface`, `corr_matrix`, `get_macro_bars`, `get_lake_bars` + the manipulation overlay | fetched market, its source/coverage, and the effective market mapped onto the riga-flow request |
| Symbol Picker | `get_lake_symbols` + `get_lake_coverage` | symbol master + lake cache coverage |
| Bar Chart | `get_lake_bars` | OHLCV candles |
| TA / SP Panes | `get_lake_ta` + `get_lake_sp` | technical + stochastic-process indicator panes |
| Correlation Matrix (tac) | `corr_matrix` (+ `corr_calc`) | ρ heatmap + resolved pairs (dark/light-adaptive ramp) |
| Vol Surface (tac) | `vol_surface` (+ `vol_surface_status`) | calibrated strike × maturity grid; **2D heatmap / 3D surface** toggle |
| Yield Curve | `get_macro_bars` (FRED DGS tenors) | discount-curve pillars |
| FX Spot | `get_forex_latest_rates` / `get_forex_rates` | per-pair FX spot (**not** sent to riga-flow — R-EXT-1) |
| FX Vol | `get_lake_fx_vol` | realized FX vol + window matrix |
| Corporate Actions | `get_corporate_actions` | dividends/splits feeding the dividend yield |
| Lake Coverage | `get_lake_coverage` + `get_lake_status` | loaded windows + dataset verdict |
| Manipulation Editor | (pure overlay, no tool) | manipulation rows + the effective-market JSON |

> tac tiles **never fall back to fake data**: with no lake/credentials they show a
> "market source not configured" empty state. `vol_surface` maturities are Excel
> serials rendered as dates (`23 Oct 26`).

## Trace level gates the path tiles

The title-bar selector sets the UI level **and** `SimulationConfig.trace_level`:

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
- The net is **one** canvas: do not describe Risk Net / Explain Net as separate
  graphs, and do not expect the graph shape to change with the layer.
- riga-flow is 2-factor and drives a fixture; if the trade/market controls were
  edited, the engine may reject a field — report the structured `{code,message}`
  rather than a local guess.
- FX/FX-vol are real tac-engine data but are **not** sent to riga-flow until
  R-EXT-1; full token vectors are an engine gap (R-EXT-2). Say so instead of
  approximating.
