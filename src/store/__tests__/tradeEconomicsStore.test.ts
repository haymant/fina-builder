// tradeEconomicsStore contract (§6.2): presets apply, reset works,
// `fina-trade-economics` persists, and — critically — `deriveTradeAnalytics`
// must NOT be imported (the frontend computes nothing; it fetches the
// analytics through `useTradeAnalytics`).

import { beforeEach, describe, expect, it } from 'vitest'
import { useTradeEconomicsStore, TRADE_PRESETS } from '../tradeEconomicsStore'

describe('tradeEconomicsStore', () => {
  beforeEach(() => {
    localStorage.clear()
    useTradeEconomicsStore.getState().resetEconomics()
  })

  it('applies presets', () => {
    useTradeEconomicsStore.getState().applyPreset('Deep Barrier')
    const s = useTradeEconomicsStore.getState()
    expect(s.knockInBarrier).toBe(0.4)
    expect(s.knockOutBarrier).toBe(1.15)
    expect(s.couponRate).toBe(0.08)
  })

  it('reset returns to the default trade', () => {
    useTradeEconomicsStore.getState().applyPreset('Capital Protected')
    useTradeEconomicsStore.getState().resetEconomics()
    const s = useTradeEconomicsStore.getState()
    expect(s.knockInBarrier).toBe(TRADE_PRESETS['Base Case'].knockInBarrier)
    expect(s.notional).toBe(100)
    expect(s.physicalSettlementEnabled).toBe(true)
  })

  it('persists the trade terms under fina-trade-economics', () => {
    useTradeEconomicsStore.getState().updateEconomics({ couponRate: 0.18, knockInBarrier: 0.7 })
    const saved = JSON.parse(localStorage.getItem('fina-trade-economics') ?? '{}') as Record<string, unknown>
    expect(saved.couponRate).toBe(0.18)
    expect(saved.knockInBarrier).toBe(0.7)
  })

  it('does not re-export deriveTradeAnalytics (frontend computes nothing)', async () => {
    const mod = await import('../tradeEconomicsStore')
    expect('deriveTradeAnalytics' in mod).toBe(false)
  })
})