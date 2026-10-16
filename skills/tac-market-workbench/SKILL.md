---
name: tac-market-workbench
description: Explain the Market Data Workbench (tac-engine) tiles and which tac-engine MCP tools fetch and manipulate them.
---

# tac-engine market workbench

The **Market Data Workbench (tac-engine)** dashboard fetches market data from the
**tac-engine** MCP connector and lets the user overlay manipulations. Explain a
tile by naming the tool that produced it and the `source`/`calibrated_at` it
carries — never re-derive a number.

## Tile → tool map

| Tile | Tool(s) | What you're reading |
| --- | --- | --- |
| Symbol Picker | `get_lake_symbols`, `get_lake_coverage` | symbol master + cached windows |
| Bar Chart | `get_lake_bars {symbols,timeframe,lazy}` | OHLCV; `source ∈ lake/partial/fetched` |
| TA / SP Panes | `get_lake_ta`, `get_lake_sp` (or `get_lake_features`) | indicator and stochastic-process features |
| Correlation Matrix | `corr_matrix` (primary), `corr_calc`, `get_correlations` | resolved pairwise correlation (never 0) |
| Vol Surface | `vol_surface`, `vol_surface_status` | calibrated strike × maturity grid (`model=svi/eSSVI`, `calibrated_at`); 10-min cache |
| Yield Curve | `get_macro_bars` (FRED `DGS` tenors) | discount-curve pillars |
| FX Spot | `get_forex_latest_rates`, `get_forex_rates` | per-pair spot/forwards — **not sent to riga-flow** |
| FX Vol | `get_lake_fx_vol` | realized FX vol (implied `fx_vol_surface` is not shipped) |
| Corporate Actions | `get_corporate_actions` | dividends/splits feeding `dividend_yields[]` |
| Lake Coverage | `get_lake_coverage`, `get_lake_status`, `validate_lake_dataset` | loaded windows + verdict |
| Manipulation Editor | — | in-memory overlays: `spot, volatility, correlation, interest_rate, dividend, fx_spot, fx_volatility` |
| Market Data Workbench | (composes the above) | fetch → manipulate → map into the riga-flow request |

## Rules

- The workbench **fetches then manipulates**; manipulations are in-memory overlays
  and never write the lake. No mutating tool (`place_order`, `close_*`,
  `cancel_*`, watchlist writes) is ever called.
- Correlation stays positive-definite; a vol-surface manipulation warns on
  arbitrage. Ratio strikes are relative to the deal's **initial fixing**.
- FX / FX-vol are real tac-engine data but are **not priced by riga-flow** until
  R-EXT-1 — say "not sent to riga-flow" rather than implying they affect the PV.
- Secrets (`TAC_LAKE_DIR`, `APCA_*`, `FRED_API_KEY`) never appear in chat; if the
  tiles are empty, the market source is not configured — say so, do not invent data.
