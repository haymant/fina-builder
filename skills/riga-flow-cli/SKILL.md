---
name: riga-flow-cli
description: Drive the riga-flow and tac-engine MCP tools from the terminal with riga-cli (TUI or headless) and present the results as markdown tables.
---

# riga-flow CLI analytics (`riga-cli`)

`riga-cli` (`modules/riga/crates/riga-cli`) is a terminal client for the **same
`riga-server` IPC runtime the desktop app uses**. It discovers the MCP servers
from the workspace `.mcp.json` (`riga-flow` → `modules/riga-flow/target/release/riga-mcp`,
`tac-engine` → `modules/tac-engine/target/release/tac-engine`) and the skills from
`skills/<name>/SKILL.md`. It computes nothing: every number is an engine tool result.

## Start it

Run it **from the repository root** — the workspace is the process working
directory, so `.mcp.json` and `skills/` must resolve there.

```bash
# one-time: the engines the CLI connects to
cargo build --release --manifest-path modules/riga-flow/Cargo.toml
cargo build --release --manifest-path modules/tac-engine/Cargo.toml
# the CLI
cargo build -p riga-cli --manifest-path modules/riga/Cargo.toml

./modules/riga/target/debug/riga-cli --tools   # check: 42 (riga-flow) + 75 (tac-engine)
./modules/riga/target/debug/riga-cli --tui     # the terminal UI
```

Two modes:

- **Headless (no model)** — deterministic; calls one tool and prints markdown:
  `--tools`, `--call`, `--catalog`, `--health`.
- **Agent (TUI chat)** — configure a provider once (`/settings`, then `/model`) so a
  model can call the MCP tools. `/mcp`, `/tools`, `/skills` browse the catalogue; at
  startup the CLI preflights the engines and warns on stderr if one is unreachable.

`/skills` in the TUI inserts a prompt prefix, so a request reads
`Use the <skill> skill: …`.

## Which skill pairs with which question

| Question | Skill | Tools it drives |
| --- | --- | --- |
| **risk** (DV01/ρ, per-asset Δ/Γ/ν, per-transition Δ/ν, scenarios, Greek sanity) | **`risk-summary`** | `risk_batch`, `risk_detailed`, `query_risk_net`, `scenario`, `validate_greeks`, `recommend_scenarios` |
| anything tile-shaped / the whole surface | `riga-flow-dashboard` | all 42 riga-flow tools + the tac tiles |
| PV legs and the coupon timeline | `cashflow-explain` | `explain_pv_attribution`, `price_put`, `build_cashflows`, `get_branch_stats`, `get_ledger` |
| one path / the worst-tail sample | `path-walkthrough` | `query_path_cube`, `execution_events`, `replay_path`, `get_ledger` |
| real market data (lake/Alpaca/FRED) | `tac-market-workbench` | `corr_matrix`, `vol_surface`, `get_lake_bars`, `get_macro_bars`, `get_forex_*` |
| demo vs live data labelling | `explain-demo-data` | `get_ledger`, `get_market` |

## Headless commands (no model required)

```bash
# what can the engines do?
riga-cli --tools                     # markdown: server, state, tools
riga-cli --tools --json              # McpToolStatus[]

# call any tool: <server>/<tool>
riga-cli --call riga-flow/price_put
riga-cli --call riga-flow/risk_batch
riga-cli --call riga-flow/query_risk_net
riga-cli --call riga-flow/get_ledger
riga-cli --call riga-flow/health --json

# adjust the trade/market and re-price INLINE (the on-disk fixture is never edited)
riga-cli --call riga-flow/price_trade --set trade.strike=0.60
riga-cli --call riga-flow/query_execution_net --set trade.strike=0.60
riga-cli --call riga-flow/price_trade --template my-request.json \
         --set market.vols[0]=0.48 --set market.correlation[0][1]=0.30
```

Flags: `--call <server>/<tool>`, `--input <json|@file>`, `--template <file>` (default:
the embedded worst-of Phoenix baseline `templates/termsheet1.request.json`),
`--set path=value` (repeatable; dot paths and `[index]`, e.g. `trade.strike=0.6`,
`market.vols[0]=0.48`, `market.correlation[0][1]=0.3`), `--json`, `--tools`,
`--catalog`, `--health`, `--list-sessions`, `--create-session <title>`,
`--workspace <dir>`, `--plain`, `--tui`.

With no `--template`/`--set` a fixture tool prices the **pinned `termsheet1`
fixture**; with a template/`--set` the composed `PriceRequest` is injected as the
tool's `request` field, so every tool prices the *same* edited trade.

## Sample prompts (TUI chat)

**Pricing**
- `Use the riga-flow-dashboard skill: price termsheet1 and show the total PV, the leg breakdown (funding / coupon / down-and-in put) and the KI probability as a table.`
- `Use the cashflow-explain skill: break the PV into its legs and explain the memory-coupon timeline by period.`

**Risk**
- `Use the risk-summary skill: report DV01, correlation sensitivity and the per-asset Δ/Γ/ν for termsheet1.`
- `Use the risk-summary skill: how do Δ, ν and PV change for the final_fixing_eki (down-and-in put) transition versus daily_global_ko? Switch the net to the Risk layer to show the tint.`
- `Use the risk-summary skill: bump rates and correlation up/down and tabulate the scenario PVs.`
- `Use the risk-summary skill: are the Greeks sane? List any validate_greeks flags with their severity.`

**Path / distribution**
- `Use the path-walkthrough skill: walk the worst-5% path — its KO/KI state, put payoff and PV — and name the evidence refs.`
- `Use the riga-flow-dashboard skill: show the worst-of deciles, the KI rate and the mean put, then the PV convergence band.`

**Market context**
- `Use the tac-market-workbench skill: what correlation and vol surface does the lake have for ADBE/AMZN, and which tools fetched them?`

**Explain / governance**
- `Use the riga-flow-dashboard skill: reconcile the ledger residual for termsheet1 and list the evidence refs for daily_global_ko.`
- `Use the riga-flow-dashboard skill: freeze a baseline, triage any regression, and summarise the RCA finding.`

## Grounding rules

- Cite the `run_id` / `market_snapshot_id` from the tool result; never re-derive a number.
- A lower `trade.strike` is a **cheaper** down-and-in put and a **higher** total note
  PV (`total = funding + coupon − put`); `ki_probability` is strike-independent.
- The engine is the authority: a rejected field returns a structured error — report it,
  do not "fix" it locally.
- Data lineage: `--set`/`--template` never modify `modules/riga-flow/docs/fixture/*`.

## Not yet

`--report <pack>` (batched markdown per tile-equivalent: pricing / risk / explain /
convergence / distributions / path / execution) is planned in `docs/50-cli.md` **P5**;
until it lands, run the tools with `--call` (or ask the agent) one at a time.
