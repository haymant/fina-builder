---
name: tradeac-rd
description: Use the named tac-qlib R&D MCP operations for reference-run inspection, trace lineage, training, prediction, strategy targets, backtests, and artifact verification. Use as the R&D companion to tac-algo-trade.
---

# TradeAC R&D named-operation contract

Use the registered `tac-qlib-rd` MCP server. Do not open MLflow files, inspect Python source, query SQLite/DuckDB directly, spawn a hand-written MCP client, or search for sidecar ports while the named tools are available.

## Operation map

- Preflight: `rd_status`; inspect reference configuration with `rd_exp_input` using the exact supplied `run_id` and `experiment_id` when available.
- Lineage: `rd_trace_start` must use the new experiment name, never the reference experiment name.
- Train: `rd_train`; preserve the copied model/dataset/feature/label/strategy and explicit dates. The result contains `run_id` and `model_path` when complete.
- Predict: `rd_predict` with the returned `model_path` or run id; use the target date as the test window and persist the returned prediction path.
- Strategy: `rd_strategy_targets` for the saved TopkDropout contract, with explicit `account`, `risk_degree`, `topk`, `n_drop`, `prices`, and `risk_limits`; use live account equity, not the default account.
- Analysis: `rd_backtest` only when requested or required by the saved workflow, with every cost, benchmark, strategy parameter, account, and limit explicit.
- Readback: `rd_exp_get_run`, `rd_exp_result`, `rd_exp_model`, and `rd_exp_blotter` only for requested verification and summary.

## Failure behavior

Return typed failures concisely: `tool_unavailable`, `reference_run_not_found`, `training_failed`, `prediction_failed`, `strategy_incompatible`, or `artifact_missing`. Do not compensate by exploring repository code. Source inspection is an exceptional recovery step only after the exact operation and its contract have been verified unavailable or incompatible.

Never fabricate scores, metrics, artifacts, dates, or signals. Never expose tracking URIs, API keys, or other secrets in prompts, logs, or summaries.
