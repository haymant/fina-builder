# Structured Product Payoff Explorer

**Debugging Monte Carlo Paths Like Source Code**

A desktop visualization tool for explainable Monte Carlo payoff traversal on a Worst-Of Phoenix Autocall (AAPL / MSFT / NVDA). Mock data only — not a pricing engine.

## Stack

- Tauri 2 · React 19 · TypeScript · Vite
- Tailwind CSS · Lucide React · Zustand
- @xyflow/react · Apache ECharts · AG Grid Community

## Quick start

```bash
npm install

# Web UI (Vite) — works immediately
npm run dev

# Desktop (Tauri) — requires platform WebView deps
npm run tauri:dev
```

### Linux system deps (Tauri)

```bash
# Debian/Ubuntu
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
  libglib2.0-dev
```

Production build:

```bash
npm run build          # frontend only
npm run tauri:build    # desktop bundle
```

## What you get

| Panel | Role |
| --- | --- |
| Payoff Graph | XYFlow traversal of path-cube → PV nodes |
| Path Timeline | Worst-of performance with KI / KO / coupon barriers |
| Node Details | Decision rule, probability, conditional expectation |
| Branch Sankey | Population KO / Alive / KI settlement tree |
| Attribution | Waterfall of Par / Coupon / Put / Funding / DF |
| Distribution | Histograms with selected-path marker |

Selecting a path synchronizes graph highlight, timeline, sankey, attribution, and distribution marker.

## Mock data consistency

Deterministic seed (`42`). Flags match the plotted path:

- `knockedOut=true` ⇒ worst-of crosses the KO barrier
- `knockInTriggered=true` ⇒ worst-of crosses the KI barrier
- Alive / no-KI paths stay above KI and below KO

## Architecture

```
src/
  features/
    payoff-graph/
    path-inspector/
    branch-statistics/
    attribution/
    distribution/
    shared/
  store/
  mock-data/
```

## Out of scope

Pricing models, market data, calibration, databases, auth, remote APIs.
