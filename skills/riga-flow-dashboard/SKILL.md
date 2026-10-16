---
name: riga-flow-dashboard
description: Explain every tile of the riga-flow Lineage & Explainability Workspace by calling the riga-flow MCP tools that populate it.
---

# riga-flow dashboard explainer

When the user is on the **riga-flow Lineage & Explainability Workspace** dashboard
and asks what a tile shows or why a value is what it is, read the tile from the
**riga-flow MCP connector** — do not compute or guess. Each tile is fed by one or
more tools; call the tool, then explain only what the result contains.

## Tile → tool map

Every riga-flow tool is fixture-based and takes an optional `fixture_path`
(pinned `termsheet1` by default), so call it with `{}`.

| Tile | Tool(s) | What you're reading |
| --- | --- | --- |
| Health & Run | `health` | `status`, `version`, `git_sha`, `features.cpu_gbm/gpu/aad` |
| Trade Economics | `price_trade` | the worst-of Phoenix fields (`trade_id`, barriers, coupon, steps) |
| Market Data | `price_trade` | effective market: `spots[]`, `vols[]`, `dividend_yields[]`, scalar rate, 2×2 `correlation` |
| Payoff Petri Net | `query_execution_net` | `places[{id,tokens}]`, `transitions[{population_before,population_after,probability,pv_impact}]`, `run_id` |
| Transition Detail | `query_execution_net` + `get_branch_stats` + `query_risk_net` + `get_ledger` | populations, firing probability, PV/Δ/ν impact, `transition_stats`, `evidence_refs`, **static** reference formula |
| Token Detail | `query_path_cube {percentile}` + `execution_events {max_paths}` + `replay_path {path_id}` | a bounded sample of `PathRecord`s per place; riga-flow returns **counts**, not token vectors |
| Risk Net | `query_risk_net` | per-transition `pv_impact/delta_impact/vega_impact`; `per_asset[{asset_index,delta,gamma,vega}]`; `dv01`; `correlation_sensitivity` |
| Explain Net | `get_ledger` | `LedgerEntry[]`: `condition`, `population_before/after`, `pv/delta/vega_impact`, `evidence_refs` |
| Data Lineage | `get_ledger` | `determinism{seed,as_of,market_snapshot_id}`; evidence graph trade → market(sha256) → seed → transitions |
| Statistics | `get_branch_stats` + `get_mc_diagnostics` + `get_distributions` | `TransitionStats[]`; `pv`,`mc_error`,`relative_se`; `worst_final_deciles[10]`,`ki_rate`,`mean_put` |
| P&L Attribution | `pl_explain {spot_moves,vol_moves,rate_move,corr_move}` | `contributions[{factor,contribution}]`, `total` (factors `spot[i]`, `vol[i]`, `rate`, `correlation`) |
| Taylor Explain | `valuation_explain {spot_moves,…}` | `base_pv`,`current_pv`,`predicted_dpv`,`residual`,`contributions[]` |
| PLVA Explain | `valuation_explain` | valuation adjustment base → current that the Taylor/market terms do not explain |
| Scenario Comparison | `scenario` | `rate_up_pv`/`rate_down_pv`/`correlation_up_pv`/`correlation_down_pv`, per-asset Greeks |
| Book Risk | `compute_book_risk {notionals}` (or async `price_book_async`) | `trades`, `pv`, `delta[]`, `gamma[]`, `vega[]`, `dv01`, `correlation_sensitivity` |
| Regression Triage | `freeze_baseline` → `compare_corpus` / `triage_regression` | `within_tolerance`, `exceptions[]`, `count` (needs a frozen baseline first) |
| Root Cause | `root_cause` | `finding`, `evidence_refs[]`, `change_log` (baseline vs current) — Full trace level |
| Governance Evidence | `export_governance_evidence` | `assumptions[]`, `limitations[]`, `stress_methodology`, `lineage{sampled_paths[],evidence_refs[]}` |
| PathCube Query | `query_path_cube {percentile}` | worst-percentile `sample: PathRecord[]` |
| Execution Tape | `execution_events {max_paths}` | bounded `tape[{path_id,events,pv}]` |
| Market Snapshot | `get_market` / `list_markets` | `snapshot_id`, spots, vols, correlation, rate |
| Greeks Sanity | `validate_greeks` | `flags[{severity,message}]` |
| Stress Bands | `recommend_scenarios` | `recommendations[{spot_band,reason}]` |

## Trace level gates path tiles

The title-bar selector sets the UI level **and** `SimulationConfig.trace_level`:

- **Off** — aggregate only; `query_path_cube`, `execution_events`, `pl_explain`,
  `valuation_explain`, `root_cause`, `export_governance_evidence` are not called
  and their tiles show "trace off — aggregate only".
- **Sampled** — path tools are bounded (`max_sample`/`max_paths`).
- **Full** — Root Cause and Governance Evidence populate.

If a path tile is empty, first check the trace level rather than inventing data.

## Rules

- Ground every number in a tool result; cite the `run_id` / `market_snapshot_id`.
- Never re-derive a formula: the "formula (static)" text in Transition Detail is
  reference copy, not a computed value.
- riga-flow is 2-factor and drives a fixture; if the trade/market controls were
  edited, the engine may reject a field — report the structured `{code,message}`.
- FX/FX-vol and full token vectors are engine gaps (R-EXT-1/R-EXT-2); say so
  instead of approximating.
