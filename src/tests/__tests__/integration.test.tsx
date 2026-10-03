// Integration flow (§6.2): load the bundle, select a path, then request
// cashflows and the valuation explain — the values must equal the committed
// golden baseline, byte-for-byte as parsed objects. This exercises the same
// journey the UI makes, one layer below full tile rendering.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fina } from '../../api'
import { useSimulationStore } from '../../store/simulationStore'
import { useExplorerStore } from '../../store/explorerStore'
import { server } from '../../tests/mocks/httpMock'
import { golden } from '../../tests/mocks/goldenBundle'
import type { TradeEconomics } from '../../api/types'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

const TRADE: TradeEconomics = {
  strike: 1,
  knockInBarrier: 0.6,
  knockOutBarrier: 1,
  couponLowerBarrier: 0.7,
  couponUpperBarrier: 1.2,
  couponRate: 0.12,
  memoryCouponEnabled: true,
  physicalSettlementEnabled: true,
  maturityYears: 5,
  notional: 100,
}

describe('integration: bundle → path → cashflows → explain', () => {
  it('loads the bundle, selects a path, then serves golden values end to end', async () => {
    // 1. Load the bundle exactly as App does on mount.
    await useSimulationStore.getState().load()
    const bundle = useSimulationStore.getState().bundle
    expect(bundle?.paths).toHaveLength(100)

    // 2. Select path 1 (the fixture's cashflow path) via the explorer store.
    const target = bundle!.paths.find((p) => p.pathIndex === 1)!
    useExplorerStore.getState().setSelectedPathId(target.id)
    expect(useExplorerStore.getState().selectedPathId).toBe(target.id)

    // 3. get_path round-trips the same object the bundle carried.
    const path = await fina.call('get_path', { pathIndex: 1 })
    expect(path).toEqual(target)

    // 4. Cashflows round-trip the golden-derived wire envelope.
    const cash = (await fina.call('build_cashflows', {
      trade: TRADE,
      pathIndex: 1,
    })) as { cashflows: unknown[]; analytics: { presentValue: number } }
    expect(cash.cashflows).toHaveLength(60)
    expect(cash.analytics.presentValue).toBe(golden().cashflow.presentValue)

    // 5. Valuation explain equals the golden capture (previousPV/currentPV
    //    and the Taylor sum), with the documented state object.
    const valuation = (await fina.call('valuation_explain', {
      trade: TRADE,
      market: { underlyings: [], fxPairs: [], correlations: [], vol: { atmVol: 0.24, skew: 0, curvature: 0, termSlope: 0 } },
      pathIndex: 1,
      asOf: '2026-01-15',
    })) as { previousPV: number; taylor: { predicted: number }; state: { totalPnL: number } }
    expect(valuation.previousPV).toBe(golden().valuation.previousPV)
    expect(valuation.taylor.predicted).toBe(1.6860000000000004)
    expect(valuation.state.totalPnL).toBe(1.7999999999999972)
  })
})