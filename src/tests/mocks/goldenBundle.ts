// The committed golden baseline, loaded through Vite's `?raw` so the frontend
// tests assert against the same witness the Rust golden-parity tests use
// (FEATURES.md §6.2).

import goldenRaw from '../../../crates/fina-kernel/tests/fixtures/golden.json?raw'
import type { SimulationBundle, TradeAnalytics, RiskState } from '../../api/types'

interface Golden {
  meta: { sourceSeed: number; generatedBy: string; note: string }
  simulationBundle: SimulationBundle
  mc: {
    mcDiagnostics: Array<{
      paths: number
      pv: number
      se: number
      lower: number
      upper: number
      p05: number
      p50: number
      p95: number
      ki: number
      ko: number
    }>
    mcEfficiency: Array<Record<string, unknown>>
    finalMC: Record<string, unknown>
  }
  trade: { defaults: unknown; analytics: TradeAnalytics }
  risk: { base: RiskState }
  cashflow: {
    pathIndex: number
    rows: unknown[]
    grossCashflow: number
    presentValue: number
    realized: number
  }
  valuation: { previousPV: number; currentPV: number; plvaPnL: number; taylor: Record<string, unknown> }
}

let cached: Golden | null = null
export function golden(): Golden {
  cached ??= JSON.parse(goldenRaw) as Golden
  return cached
}