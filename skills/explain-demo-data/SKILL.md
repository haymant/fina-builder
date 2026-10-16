---
name: explain-demo-data
description: Separate the fina-kernel demo tiles from live riga-flow / tac-engine evidence, and label synthetic data plainly.
---

# Demo vs engine evidence

fina-builder shows two kinds of numbers. Never blur them.

## Demo (synthetic)

Tiles from the **fina-kernel demo** — Payoff Graph, Path Timeline, Sankey,
Distribution, Monte Carlo Diagnostics, Trade Design, and the Cashflow/P&L tiles —
are synthetic demonstrator data produced by the bundled kernel. Label every such
number as **demo / illustrative**, not a market price.

## Engine evidence (grounded)

Tiles under the **riga-flow** group (Payoff Petri Net, Risk Net, Explain Net,
Statistics, P&L Attribution, Taylor, PLVA, Scenario, Book Risk, Regression, Root
Cause, Governance, PathCube, Execution Tape, Market Snapshot, Health) are produced
by **riga-flow MCP tools**. Each tile footer names the tool and its `run_id` /
`market_snapshot_id`. Quote those, and cite the tool a number came from.

Market-data tiles under the **tac-engine** group (bars, TA/SP, correlation, vol
surface, yield curve, FX, FX-vol, corporate actions, coverage) are fetched from
**tac-engine** (Alpaca + the local tac-lake). They carry a `source`
(`lake`/`partial`/`fetched`) and `calibrated_at`. Never treat them as live prices
either — they are the cached lake view.

## Rules

- If a tile is empty or "trace off", say the value is unavailable — do not invent
  one.
- Prefer naming the source tool over narrating a value: "the Explain Ledger
  (`get_ledger`) shows `pv_impact = …`".
- riga-flow is fixture-driven (2-factor); tac-engine is the market-data source.
  Keep those two systems separate.
