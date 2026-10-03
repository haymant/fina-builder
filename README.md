# Fina Builder — Structured Product Payoff Explorer

A React/TypeScript analytical-workbench prototype for inspecting synthetic Worst-of Phoenix Autocall paths and assembling role-oriented dashboards. The same frontend runs in a browser during development and inside a Tauri 2 desktop shell.

> **Scope:** this repository is a UI and analytics prototype, not a production pricing or risk system. The data and many calculations are deterministic or illustrative; read [FEATURE.md](./FEATURE.md) for the implementation inventory and limitations.

## Business rationale

Structured-product analysis spans trade terms, path-dependent payoff events, risk, cashflows, and valuation explanations. This prototype brings those views into one configurable workspace so developers, quants, traders, validators, and product-control users can inspect linked examples and discuss model behavior. The business context is intentionally brief here; [FEATURE.md](./FEATURE.md) describes what the code actually implements rather than treating the original product vision as delivered functionality.

## Technology

- **UI:** React 19, TypeScript 6, Vite 8
- **Desktop wrapper:** Tauri 2 (Rust shell; no product-specific Rust commands or pricing backend)
- **State:** Zustand; browser `localStorage` for selected workspace, dashboard layouts, controls, and notebook content
- **Charts and layout:** Apache ECharts, XYFlow, AG Grid Community, `react-grid-layout`
- **Styling and icons:** Tailwind CSS 4, project CSS, Lucide React

## Requirements

- Node.js and npm (the repository includes `package-lock.json`)
- For desktop builds, Rust/Cargo and the platform prerequisites for Tauri 2
- On Debian/Ubuntu, install the WebKitGTK, GTK, and other Tauri build dependencies required for your distribution before running the desktop commands. The browser-based Vite workflow does not require Rust or those native dependencies.

## Get started

```bash
npm ci

# Start the browser-based development server
npm run dev

# Type-check and create a production frontend bundle
npm run build

# Run the configured linter
npm run lint
```

To run or package the desktop app (requires Tauri/Rust platform dependencies):

```bash
npm run tauri:dev
npm run tauri:build
```

`npm run preview` serves the built frontend locally. Vite's default development URL is `http://localhost:5173` (also configured as the Tauri development URL).

## Repository map

```text
src/
  App.tsx                         App composition and theme provider
  features/
    dashboards/                   Dashboard/tile types and tile catalog
    tiles/                        Tile type → view dispatch
    workspace/                    Workspace shell, panels, notebook, galleries
    payoff-graph/                 Payoff graph nodes and graph layout
    path-inspector/               Selected-path timeline and node details
    pathcube/                     Analytics tiles and illustrative risk formulas
    attribution/                  Path attribution waterfall
    branch-statistics/            Branch Sankey
    distribution/                 Payoff/distribution charts
    themes/                       Theme provider and design tokens
    shared/                       Shared UI and domain types
  mock-data/                      Seeded paths and static MC diagnostic series
  store/                          Zustand state and derived analytics
src-tauri/
  src/                            Minimal Tauri application shell
```

## Where to make common changes

- **Add or rename a dashboard tile:** update `src/features/dashboards/types.ts` and `src/features/dashboards/catalog.ts`, implement or update the view under `src/features/`, then connect the type in `src/features/tiles/components/TileRenderer.tsx`.
- **Change the path example:** inspect `src/mock-data/generatePaths.ts`. It builds the fixed-seed sample bundle consumed by the path explorer and related charts.
- **Change workspace state or behavior:** inspect the relevant Zustand store in `src/store/` and its consuming components. Workspace/dashboard state is in `explorerStore.ts`; trade and market controls are in `tradeEconomicsStore.ts` and `marketDataStore.ts`.
- **Change the app shell:** `src/App.tsx`, `src/main.tsx`, and `src-tauri/`.

The app is client-side: there is no application API/server, database, authentication, external market-data feed, or production Monte Carlo engine in this repository. Details and caveats are in [FEATURE.md](./FEATURE.md).

## Validation

There is no automated test suite configured in the repository at present. Use `npm run build` for TypeScript and Vite validation and `npm run lint` for Oxlint checks. Desktop packaging additionally requires the native Tauri toolchain and operating-system dependencies.
