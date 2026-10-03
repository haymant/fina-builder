// The golden baseline the frontend tests assert against (§6.2): same witness as
// the Rust golden-parity tests.

import { describe, expect, it } from 'vitest'
import { golden } from '../mocks/goldenBundle'

describe('golden.json baseline', () => {
  it('has the expected shape', () => {
    const g = golden()
    expect(g.meta.sourceSeed).toBe(42)
    expect(g.simulationBundle.productName).toBeTruthy()
    expect(g.simulationBundle.underlyings).toEqual(['AAPL', 'MSFT', 'NVDA'])
    expect(g.trade.analytics.expectedPv).toBe(103.21)
    expect(g.risk.base.pv).toBe(154.03)
  })

  it('has 100 paths with 60 observations each', () => {
    const bundle = golden().simulationBundle
    expect(bundle.paths).toHaveLength(100)
    for (const path of bundle.paths) {
      expect(path.observations).toHaveLength(60)
      expect(path.dates).toHaveLength(60)
    }
  })

  it('reports the fictional 100,000-path population', () => {
    expect(golden().simulationBundle.branchStats.totalPaths).toBe(100000)
  })

  it('carries the cashflow and valuation sections the frontend consumes', () => {
    expect(golden().cashflow.rows).toHaveLength(60)
    expect(golden().cashflow.presentValue).toBe(94.89)
    expect(golden().valuation.taylor.predicted).toBe(1.6860000000000004)
  })
})