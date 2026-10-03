/**
 * ONE-OFF golden-fixture generator.
 *
 * Runs the *actual* TypeScript domain logic (as it existed at the start of the
 * Rust migration) and serialises the result to JSON. The Rust port of
 * `fina-kernel` must reproduce these bytes exactly (see FEATURE parity rules).
 *
 * The domain modules it imports were deleted from `src/` when the frontend was
 * rewired to the kernel (Phase 5d), so they are re-materialised here from the
 * pinned ref `48da206` — the last commit that still had them. Regenerating the
 * fixture therefore reproduces the exact captured baseline, deliberately:
 * the golden file is a *witness*, not a moving target.
 *
 *   git show 48da206:src/<path> > scripts/golden-src/<path>
 *
 * Usage:
 *   npx tsx scripts/generate-golden-fixture.ts
 *
 * Output: crates/fina-kernel/tests/fixtures/golden.json
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { simulationBundle } from './golden-src/mock-data/generatePaths'
import { mcDiagnostics, mcEfficiency, finalMC } from './golden-src/mock-data/mcDiagnostics'
import { DEFAULT_TRADE_ECONOMICS, deriveTradeAnalytics } from './golden-src/store/tradeEconomicsStore'
import { useTradeEconomicsStore } from './golden-src/store/tradeEconomicsStore'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '../crates/fina-kernel/tests/fixtures/golden.json')

// ---- risk engine (needs market data shape) -------------------------------
const { computeRisk } = await import('./golden-src/features/pathcube/riskEngine')
const { useMarketDataStore } = await import('./golden-src/store/marketDataStore')

// ---- cashflows -----------------------------------------------------------
// buildCashflows depends on a selected path + trade inputs. Re-implement the
// *invocation* here only; the logic itself is imported from the store.
const { buildCashflows } = await import('./golden-src/store/cashflowStore')

const marketState = useMarketDataStore.getState()
const trade = useTradeEconomicsStore.getState()

const path0 = simulationBundle.paths[0]!
const cashflows = buildCashflows(path0, trade)
const grossCashflow = cashflows.reduce((s, c) => s + c.amount, 0)
const presentValue = cashflows.reduce((s, c) => s + c.presentValue, 0)
const realized = cashflows.filter((c) => c.realized).reduce((s, c) => s + c.amount, 0)

const risk = computeRisk(trade, marketState)
const tradeAnalytics = deriveTradeAnalytics(trade)

// ---- valuation explain (pure formulas, re-expressed deterministically) ---
// valuationExplainStore derives from React hooks; reproduce the exact same
// arithmetic in isolation using the same inputs so the golden value is stable.
const taylor = {
  delta: (marketState.underlyings[0]?.spot ?? 100) * 0.006,
  gamma: 0.42,
  vega: marketState.vol.atmVol * 1.2,
  fx: (marketState.fxPairs[0]?.spot ?? 1) * 0.2,
  rates: -0.18,
  correlation: 0.24,
  dividend: -0.11,
  theta: -0.35,
  predicted: 0,
  residual: 0.12,
}
taylor.predicted =
  taylor.delta + taylor.gamma + taylor.vega + taylor.fx + taylor.rates + taylor.correlation + taylor.dividend + taylor.theta

const plva = [
  { category: 'Volatility Calibration', oldValue: 24.1, newValue: 24.8, contribution: 0.8 },
  { category: 'Correlation Calibration', oldValue: 0.62, newValue: 0.65, contribution: 0.3 },
  { category: 'Funding Curve Update', oldValue: 4.1, newValue: 4.2, contribution: -0.2 },
  { category: 'Reserve Update', oldValue: 1.2, newValue: 1.3, contribution: 0.1 },
]
const plvaPnL = plva.reduce((s, x) => s + x.contribution, 0)
const previousPV = presentValue - 1.8
const currentPV = presentValue

const fixture = {
  meta: {
    generatedBy: 'scripts/generate-golden-fixture.ts',
    sourceSeed: 42,
    note: 'Golden baseline captured from the pre-migration TypeScript implementation. Rust must match.',
  },
  simulationBundle,
  mc: { mcDiagnostics, mcEfficiency, finalMC },
  trade: {
    defaults: DEFAULT_TRADE_ECONOMICS,
    analytics: tradeAnalytics,
  },
  risk: { base: risk },
  cashflow: { pathIndex: path0.pathIndex, rows: cashflows, grossCashflow, presentValue, realized },
  valuation: { previousPV, currentPV, taylor, plva, plvaPnL },
}

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify(fixture, null, 2) + '\n', 'utf8')

// Console sanity summary
const s = JSON.parse(JSON.stringify(fixture))
console.log('Wrote', out)
console.log('paths:', s.simulationBundle.paths.length)
console.log('branchStats.totalPaths:', s.simulationBundle.branchStats.totalPaths)
console.log('totalPayoff mean:', s.simulationBundle.distributions.totalPayoff.mean)
console.log('risk.pv:', s.risk.base.pv, 'gamma:', s.risk.base.gamma)
console.log('cashflow.presentValue:', s.cashflow.presentValue)
console.log('valuation.taylor.predicted:', s.valuation.taylor.predicted)
console.log('trade.analytics.expectedPv:', s.trade.analytics.expectedPv)