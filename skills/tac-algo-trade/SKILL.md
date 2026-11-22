---
name: tac-algo-trade
description: Execute a complete TAC paper-account algorithm-trade run from an explicit reference MLflow run, round id, target date, training window, strategy configuration, and guardrails. Use when a prompt says to retrain a reference run, generate signals, derive holdings, apply quote/news gates, and place or verify paper orders.
---

# TAC algorithm-trade fast path

Treat a prompt containing a reference `experiment_name` + `run_id`, a new experiment name, and a `round_id`/`target_date` as an **execution request**, not a repository-research request.

## Mandatory routing

1. Load this skill, then load `tradeac-rd`, `tradeac-lake`, and `tradeac-alpaca` by workspace-root skill ids. Do not search `/`, host-specific paths, source code, MCP registries, ports, databases, or `.env` files to find skills.
2. Freeze every explicit value before the first mutating call: reference experiment/run, new experiment, round id, target date, training window, universe, features/label, strategy class/kwargs, account-equity rule, buying-power rule, guardrails, and paper-account mode. Never replace an explicit value with a default.
3. Bounded preflight only: verify the named MCP tools; call `rd_status`, `get_lake_status`/`get_lake_coverage`, and `get_account`; verify the reference run with `rd_exp_input`. Do not use read/glob/grep/bash unless a named operation is unavailable or returns a typed failure.
4. If lake/calendar data is stale, use named TAC operations only: `backfill_lake_calendar`, then `get_lake_bars` with `lazy=true` and `quiet=true` through the latest completed trading day. Poll named job-status tools. Never fabricate dates or market data.
5. Read the reference configuration from `rd_exp_input`. Copy model, dataset, features, label, universe, strategy class/kwargs, benchmark, costs, `topk`, `n_drop`, `risk_degree`, and risk limits. Get live equity only from `get_account`; cap buys at returned buying power.
6. Run exactly this sequence, reporting only these checkpoints: `preflight complete` → `reference config loaded` → `training started` → `prediction complete` → `orders evaluated` → `verification complete`.
   - `rd_trace_start` with the **new** experiment name and supplied lineage.
   - `rd_train` with the copied configuration, exact new experiment name, four-year window ending on the latest completed trading day, and no valid/test segment unless explicitly requested. Use `wait=false` only when required; poll named run-read operations until terminal.
   - `rd_predict` with returned `model_path` (or returned run id), same training window, and target signal date.
   - Use `rd_strategy_targets` for a TopkDropout reference strategy, passing copied strategy parameters, live equity, prices/quotes, and risk limits. Use `rd_backtest` only when the workflow explicitly requires a backtest artifact; never use its defaults. For another strategy, follow the saved reference contract; never invent sizing rules.
   - Before orders call `get_account` and `list_positions`, then fetch usable quotes/snapshots and news with TAC named tools. Reject missing, stale, halted, or illiquid quotes and record each rejection.
   - Cancel BUY when sentiment <= -2 and SELL when sentiment >= +2, recording exactly `cancelled: sentiment conflict`. Never fabricate sentiment; unavailable news means skip.
   - Compute deltas against current positions. Never sell a symbol not held; skip approximately-zero deltas. Place only surviving paper orders via `place_order`, using strategy-approved whole-share quantities/notional and deterministic client ids where supported.
   - Verify with `list_orders` and `list_positions`.
7. Summarize only observed values: date, reference run, new run id/model path, window, score count/top names, per-symbol sentiment, orders, cancellations, skips, and verification. Never print credentials or credential-bearing URLs.

## Exceptional recovery only

Enter source/skill/MCP investigation only after a typed failure such as `skill_not_found`, `tool_unavailable`, `reference_run_not_found`, `lake_stale`, `strategy_incompatible`, or `contract_mismatch`. Inspect only the named contract or reference configuration needed to recover, with at most three targeted reads. If still unverified, stop with the exact failure and do not place orders.

A missing legacy path such as `tac-qlib/skills/tac-algo-trade/SKILL.md` resolves to this canonical workspace-root skill; it is never a reason for filesystem-wide search.
