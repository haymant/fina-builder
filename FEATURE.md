# Implemented Features and Scope

This document records what is present in the repository code, not the full product vision or all 11 prompt summaries. It is intended to help developers and reviewers distinguish working prototype behavior from illustrative data, mock calculations, and unimplemented production capabilities.

## Business rationale

The prototype explores whether structured-product analysis can be made easier to inspect by bringing payoff-path traversal, trade controls, risk views, cashflows, and valuation explanations into a single configurable workspace. Its intended business value is a shared visual surface for discussing product behavior and analytical workflows across structuring, trading, quant development/validation, and product control. The present implementation is a demonstrator for those workflows, not a source of executable prices, official valuations, or production risk measures.

## Application and developer-facing behavior

- **Web and desktop shell:** Vite serves a React 19 / TypeScript app; Tauri 2 wraps that frontend as a desktop app. The Rust entry points only configure/run the Tauri shell and debug logging. No domain calculation or network API is implemented in Rust.
- **Client-side state:** Zustand stores application selections and controls. Dashboard/layout/theme state, market values, trade economics, and dashboard notebook content are saved in browser `localStorage` under separate `fina-*` keys. This is local to the browser profile/device; there is no account or server synchronization.
- **Workspace composition:** responsive, draggable/resizable tile layouts; dashboard selection, creation from template, rename, duplication, deletion, and saved layouts. Tile removal and dashboard deletion use browser confirmation dialogs.
- **Built-in dashboards:** Payoff Explorer, PathCube Analytics, Risk Diagnostics, Monte Carlo Diagnostics, Trade Design, and Market & Risk.
- **Role templates:** Trade Structuring Workspace, Trader Workspace, Model Validation Workspace, Cashflow Workspace, Desk Quant Workspace, Market Risk Workspace, Product Control Workspace, P&L Explain Workspace, and Executive Dashboard. Templates seed a dashboard with a set of tile types and usage text.
- **Tile library:** the catalog currently registers 52 tile types. It includes the path/payoff views, distribution and PathCube analytics, MC diagnostic charts, trade design, market/risk controls, event lifecycle, cashflow/P&L, and valuation-explain/ledger views described below.
- **Theme and path selection:** dark/light theme toggle; selection of one of 100 sample paths, next/previous/random path actions, and linked selection state shared by path-related views.

## Path and payoff example

`src/mock-data/generatePaths.ts` creates a deterministic (`seed = 42`) synthetic example for a Worst-of Phoenix Autocall on AAPL, MSFT, and NVDA. The bundle contains 100 generated paths with 60 monthly observations beginning in January 2024. Synthetic path scenarios are constructed to illustrate knock-out, knock-in, and alive/no-knock-in cases. Payoff-graph traversal and node details are built from those examples.

The payoff explorer provides:

- An XYFlow graph of payoff-processing nodes, with path-specific traversal/state highlighting.
- A 60-point worst-of performance timeline with KI/KO and coupon-range context.
- Node details for the selected event/decision.
- Branch population Sankey, selected-path attribution waterfall, and payoff/distribution charts.
- Synchronized path selection across the applicable views.

The generated paths use hard-coded example terms in `generatePaths.ts`; they are not produced by a live pricing model. Changes to the Trade Economics controls do **not** regenerate or rerun the path sample. Where a path chart reads barriers from the controls, the display may change while the underlying generated event flags/path data remain fixed.

## Trade design and market controls

- **Trade Economics panel:** editable strike, KI/KO and coupon barriers, coupon rate, maturity, notional, memory-coupon and physical-settlement flags; preset scenarios and reset. State is persisted locally.
- **Trade design tiles:** summary, economics impact summary, sensitivity tornado, and parameter impact matrix.
- **Market Data panel:** synthetic spots and historical OHLC series for AAPL/MSFT/NVDA; editable mock volatility parameters, FX pairs, and correlation values; spot/vol/correlation/FX shock controls.
- **Market/risk tiles:** risk summary and Greeks, bucket vega, spot explorer, mock volatility surface, correlation matrix, FX explorer, Greeks waterfall, and scenario comparison.

These are demonstration inputs and simplified formula-based outputs. `deriveTradeAnalytics` and `computeRisk` use compact heuristic formulas; the historical series and FX/market defaults are generated or seeded sample values. They do not constitute calibrated valuation, a full Greeks engine, live market data, or a validated scenario revaluation. A market or trade change updates applicable derived views but does not trigger a Monte Carlo run.

## PathCube and Monte Carlo displays

- **Path population views:** quantile fan, state occupancy, barrier-crossing timeline/heatmap, worst-of evolution/percentile view, and selected path's population position.
- **Diagnostic views:** summary, PV convergence, confidence-interval shrinkage, error versus path count, percentile convergence, KI/KO probability convergence, distribution stability, simulation efficiency, and convergence-health indicator.

PathCube summaries are calculated or displayed from the small generated sample or chart-specific data. The MC diagnostic series are defined in `src/mock-data/mcDiagnostics.ts`; labels such as 100,000 or 1,000,000 paths are illustrative diagnostic points, not a simulation currently executed by the app. The convergence status and efficiency displays are not a validation certificate or a result of running a production MC engine.

## Lifecycle, cashflow, and valuation explanations

- **Execution/lifecycle tiles:** schedule explorer, observation explorer, execution-state inspector, and lifecycle overview. Dates and observations are shown from the synthetic path example; the schedule is not generated by an exchange/business-day calendar service.
- **Cashflow/P&L tiles:** cashflow summary, timeline and detail, plus P&L summary and timeline. `cashflowStore.ts` derives an illustrative stream using the selected path and trade inputs, applies a fixed 4% discount assumption, and assigns demonstration probability/realized flags.
- **Valuation-explain tiles:** valuation summary, master explain waterfall, Taylor Explain, and PLVA.
- **Explain ledger tiles:** table, selected-entry explorer, and reconciliation summary.

Taylor values and PLVA categories in `valuationExplainStore.ts` are largely fixed/simple formula examples. Ledger entries are assembled from those values and illustrative cashflow analytics; reconciliation arithmetic displays the resulting residual, but the sources are not a production, fully reconciled valuation pipeline. The names and visualizations demonstrate an explainability workflow; they do not establish that all displayed amounts reconcile to a real trade valuation.

## Dashboard notebook

The dashboard notebook displays usage/workflow guidance and supports local notes with Markdown rendering/editing, search, pinning, duplication, and deletion. Content is persisted in `localStorage` per dashboard. Template usage text is shipped in the source. Although the product prompt summary mentions import/export and wiki links, these functions are not implemented in the inspected code; the notebook is not a collaborative knowledge base.

## Explicitly not implemented

The repository does not contain:

- A production payoff/pricing model, calibrated stochastic simulation, or revaluation engine.
- Live market data, curves/calibration services, persistent backend/database, authentication, or remote APIs.
- Production cashflow/legal settlement processing or business-day calendar integration.
- Production Greeks, risk aggregation, model governance/validation evidence, or certified P&L/PLVA reconciliation.
- Shared/collaborative dashboards or notebook synchronization, nor notebook import/export.
- Automated unit, integration, or end-to-end test suites.

Treat all prices, sensitivities, convergence labels, probabilities, and explain amounts as prototype/demo values. Do not use them for trading, valuation sign-off, risk limits, settlement, or other operational decisions.

## Implementation landmarks

| Area | Main files |
| --- | --- |
| App shell | `src/App.tsx`, `src/main.tsx`, `src-tauri/src/` |
| Dashboard and tile types/catalog | `src/features/dashboards/types.ts`, `src/features/dashboards/catalog.ts` |
| Workspace and tile dispatch | `src/features/workspace/components/Workspace.tsx`, `src/features/tiles/components/TileRenderer.tsx` |
| Path simulation fixture | `src/mock-data/generatePaths.ts` |
| Diagnostic fixture | `src/mock-data/mcDiagnostics.ts` |
| Trade / market state | `src/store/tradeEconomicsStore.ts`, `src/store/marketDataStore.ts` |
| Risk and valuation examples | `src/features/pathcube/riskEngine.ts`, `src/store/valuationExplainStore.ts`, `src/store/explainLedgerStore.ts` |
| Cashflows and notebook | `src/store/cashflowStore.ts`, `src/store/dashboardDocsStore.ts`, `src/features/workspace/components/NotebookDrawer.tsx` |
