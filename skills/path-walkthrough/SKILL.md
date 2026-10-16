---
name: path-walkthrough
description: Walk one payoff path (or the worst-tail sample) using the riga-flow path tools.
---

# Path walkthrough

Explain a single payoff path, or the worst-tail sample, from riga-flow evidence.
Never reconstruct a path by hand — the engine returns the records.

## Tools

- `query_path_cube { percentile }` — the worst-percentile tail sample. Each entry
  is a `PathRecord`: `identity{path_id,rng_seed,sobol_index}`, `worst_final`,
  `knocked_out`, `ko_time`, `ki_hit`, `put_payoff`, `coupon_pv`,
  `coupon_by_period[]`, `funding`, `pv`.
- `execution_events { max_paths }` — a bounded event tape; each
  `{ path_id, events[{kind,t}|{kind,worst_final}], pv }` (kinds: `ko`,
  `knock_in`, `maturity_no_ki`).
- `get_path { path_id }` / `replay_path { path_id }` — one `PathRecord` by id.

These populate the **Token Detail**, **Execution Tape** and **PathCube Query**
tiles on the riga-flow dashboard.

## How to narrate a path

1. State `path_id`, `rng_seed` and (if present) `sobol_index` — the determinism key.
2. Give `worst_final` and whether `ki_hit` / `knocked_out` (and `ko_time`).
3. Report `put_payoff`, `coupon_pv`, `funding` and the resulting `pv` verbatim.
4. Only then interpret: which transition produced each leg (cross-reference the
   Explain Ledger via `get_ledger`).

## Limits

- riga-flow returns **counts** per place, not full token vectors (R-EXT-2): the
  token list is a bounded sample, so say "sampled".
- At trace level **Off** these tools are not called; the tiles show
  "trace off — aggregate only". Raise the level to Sampled/Full first.
- Do not present a single path as a population result, and do not treat these
  demo/`fixture` economics as a live market price.
