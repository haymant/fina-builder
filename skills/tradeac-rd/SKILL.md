---
name: tradeac-rd
description: Use for thesis-driven Qlib workflow YAML authoring in fina-builder, bounded-schema validation and lake preflight, user-confirmed experiment dispatch, or named TradeAC R&D MCP operations for reference runs, training, prediction, strategies, backtests, and artifact verification.
---

# TradeAC R&D workflows

Choose the right path for the request:

- **Author or thesis-adjust a new bounded YAML workflow in fina-builder:** follow [Bounded YAML workflow](#bounded-yaml-workflow-in-fina-builder). The normative schema is [`schema/workflow-yaml.schema.json`](schema/workflow-yaml.schema.json). For feature examples and availability caveats, read [`references/feature-candidates.md`](references/feature-candidates.md).
- **Inspect or operate on existing named R&D runs:** use the registered `tac-qlib-rd` MCP server and follow [Named-operation map](#named-operation-map). Do not substitute these reference-run operations for creating/dispatching a new YAML workflow.

## Bounded YAML workflow in fina-builder

Use this path when the user wants to design, revise, validate, or run a Qlib experiment from a declarative YAML workflow.

1. **Translate the investment thesis.** Convert the user's investment thesis or research idea into a falsifiable prediction target, an aligned label horizon, point-in-time features, an explicit universe/date window, and any requested portfolio assumptions. If asked to propose a thesis, state a concise testable hypothesis and assumptions. Do not promise returns. Ask only for critical missing choices that cannot be reasonably assumed.
2. **Author a complete workflow.** Use the bundled JSON Schema as the structural authority and its property descriptions to configure the YAML. Preserve the user's existing settings unless the thesis requires a change. Use only approved class/module pairs, processors, fields, and records. Do not add `qlib_init`, `lake_root`, provider paths/URIs, credentials, Python/Jinja, custom modules, or extra keys. Keep dates valid, chronological, non-overlapping, within the handler range, and keep fit/backtest dates within the documented segments.
3. **Select available features.** Consult `references/feature-candidates.md` for common TA periods and implemented SP field examples. Candidate names are not proof of current lake availability. The YAML only selects persisted feature columns; it does not compute them. Check actual availability for the market, universe, and date range. If columns are missing, use the appropriate TAC Engine feature workflow and persist them before revalidating. Avoid target leakage and future data.
4. **Validate and preflight.** In fina-builder open **R&D → Experiments → + YAML**, paste the complete document, and choose **Validate & preflight**. Review the returned model, universe, train/validation/test ranges, config fingerprint, and per-segment lake rows/date coverage. Resolve schema errors or missing coverage before proceeding. Do not claim an experiment has run merely because YAML validation passed.
5. **Handle missing lake data separately.** Lake population is not automatic. If the editor offers **Populate missing lake data**, review its symbols/date range and obtain the user's explicit confirmation before starting it. The action persists requested bars/features and then revalidates the unchanged YAML; it is separate from experiment dispatch.
6. **Dispatch only after explicit confirmation.** Once the current YAML has passed preflight, present the exact experiment name, model, market/universe, date segments, seed/thread profile, config SHA-256, and data-coverage summary. Obtain the user's explicit approval for that exact run. Then use the editor's **Dispatch workflow** action and accept its final confirmation. Do not dispatch based on a general request to draft YAML, a thesis, or a successful preflight alone.
7. **Verify readback.** After dispatch, report that the asynchronous worker was submitted, not that it succeeded. Refresh Experiments/Runs and inspect the persisted run status/results before reporting metrics or artifacts. Never fabricate run IDs, scores, data coverage, or outputs.

## Repository-local and copied-prompt use

When working in the repository, read `schema/workflow-yaml.schema.json` and `references/feature-candidates.md` from this skill directory before authoring; use the repository's `src/features/rd/workflowYamlTemplate.ts` only for the starter example if needed. The backend validator remains the executable authority, while the JSON Schema is its documented, machine-readable contract.

The R&D Notebook displays this exact `SKILL.md`. Its resource links expose the starter YAML, schema, and feature-candidate reference. **Copy prompt and context** embeds the complete skill and all three resources, so an external coding agent can use the copied message without repository access or resolving relative links. Treat those embedded sections as the referenced files; if any are missing, ask for them rather than guessing the bounded format.

Without access to fina-builder's R&D UI, return the complete YAML plus concise validation/preflight and dispatch instructions; do not imply that you dispatched it. With UI access, follow the explicit validation, lake-population, and dispatch confirmations above.

## Named-operation map

Use the registered `tac-qlib-rd` MCP server for existing/reference-run workflows. Do not open MLflow files, inspect Python source, query SQLite/DuckDB directly, spawn a hand-written MCP client, or search for sidecar ports while the named tools are available.

- **Preflight:** `rd_status`; inspect reference configuration with `rd_exp_input` using the exact supplied `run_id` and `experiment_id` when available.
- **Lineage:** `rd_trace_start` must use the new experiment name, never the reference experiment name.
- **Train:** `rd_train`; preserve the copied model/dataset/feature/label/strategy and explicit dates. The result contains `run_id` and `model_path` when complete.
- **Predict:** `rd_predict` with the returned `model_path` or run id; use the target date as the test window and persist the returned prediction path.
- **Strategy:** `rd_strategy_targets` for the saved TopkDropout contract, with explicit `account`, `risk_degree`, `topk`, `n_drop`, `prices`, and `risk_limits`; use live account equity, not the default account.
- **Analysis:** `rd_backtest` only when requested or required by the saved workflow, with every cost, benchmark, strategy parameter, account, and limit explicit.
- **Readback:** `rd_exp_get_run`, `rd_exp_result`, `rd_exp_model`, and `rd_exp_blotter` only for requested verification and summary.

## Failure behavior

Return typed failures concisely: `tool_unavailable`, `reference_run_not_found`, `training_failed`, `prediction_failed`, `strategy_incompatible`, or `artifact_missing`. Do not compensate by exploring repository code. Source inspection is an exceptional recovery step only after the exact operation and its contract have been verified unavailable or incompatible.

Never fabricate scores, metrics, artifacts, dates, or signals. Never expose tracking URIs, API keys, or other secrets in prompts, logs, or summaries.
