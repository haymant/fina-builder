---
name: risk-summary
description: Summarise riga-flow risk from risk_batch / query_risk_net / scenario evidence (not production greeks).
---

# Risk summary

Summarise the risk the **riga-flow dashboard** shows, grounded in the risk tools.

## Tools

- `risk_batch` → `base_pv`, `scenario_count`, `pv_mc_error`, `dv01`,
  `correlation_sensitivity`, and `assets[{asset_index,delta,gamma,vega,delta_mc_error,vega_mc_error}]`.
- `query_risk_net` → per-transition `pv_impact/delta_impact/vega_impact` plus
  `per_asset` and `dv01` (this is what the **Risk Net** tile renders).
- `scenario` → `rate_up_pv`/`rate_down_pv`/`correlation_up_pv`/`correlation_down_pv`
  (the **Scenario Comparison** tile).
- `get_mc_diagnostics` → `pv`, `mc_error`, `relative_se` — report the estimator
  uncertainty next to any risk number.
- `validate_greeks` → `flags[{severity,message}]`; mention any `error`/`warning`
  before quoting a greek.

## How to present

1. Lead with `pv` and its `mc_error` / `relative_se`.
2. Give per-asset `delta`, `gamma`, `vega` and the `dv01` / `correlation_sensitivity`.
3. Contrast `rate_up_pv` vs `rate_down_pv` and correlation up/down.
4. Attribute concentration to transitions with `query_risk_net` (Risk Net) and,
   when asked "why", to the Explain Ledger (`get_ledger`).

## Cautions

- Under the Dupire local-vol model `vega` is a **local-vol surface** shift
  (sticky-strike), not a flat-vol bump — say so.
- These are the engine's finite-difference/CRN estimates with MC error bounds, not
  book greeks from a production system. Do not present them as trading advice.
- If `validate_greeks` flags a greek whose size is below its MC error, say the
  figure is not resolvable rather than reporting it as signal.
