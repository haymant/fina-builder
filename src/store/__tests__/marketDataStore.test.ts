// marketDataStore contract (§6.2): market inputs persist under
// `fina-market-data`, shocks move the selected factor, and volatility /
// correlation updates keep within bounds. This store is INPUT state only —
// no domain math — and feeds the `useRiskEngine` / `useValuationExplain` hooks.

import { beforeEach, describe, expect, it } from 'vitest'
import { useMarketDataStore } from '../marketDataStore'

beforeEach(() => {
  localStorage.clear()
  // Back to the built-in initial market.
  useMarketDataStore.setState({
    underlyings: [
      { symbol: 'AAPL', spot: 185, baselineSpot: 185, dividendYield: 0.005, currency: 'USD', historicalPrices: [] },
      { symbol: 'MSFT', spot: 420, baselineSpot: 420, dividendYield: 0.007, currency: 'USD', historicalPrices: [] },
      { symbol: 'NVDA', spot: 122, baselineSpot: 122, dividendYield: 0.001, currency: 'USD', historicalPrices: [] },
    ],
    fxPairs: [
      { pair: 'USDSGD', spot: 1.34, baselineSpot: 1.34, volatility: 0.07 },
      { pair: 'EURUSD', spot: 1.08, baselineSpot: 1.08, volatility: 0.09 },
      { pair: 'USDJPY', spot: 151.2, baselineSpot: 151.2, volatility: 0.11 },
    ],
    correlations: [[1, 0.55, 0.48], [0.55, 1, 0.62], [0.48, 0.62, 1]],
    vol: { atmVol: 0.24, skew: -0.18, curvature: 0.12, termSlope: 0.015 },
    selectedUnderlying: 'AAPL',
    selectedFX: 'USDSGD',
  })
})

describe('marketDataStore', () => {
  it('moves the selected spot under a shock and persists it', () => {
    useMarketDataStore.getState().applyShock('spotUp')
    const aapl = useMarketDataStore.getState().underlyings[0]!
    expect(aapl.spot).toBe(185 * 1.05)
    const saved = JSON.parse(localStorage.getItem('fina-market-data') ?? '{}') as { underlyings: Array<{ symbol: string; spot: number }> }
    expect(saved.underlyings.find((u) => u.symbol === 'AAPL')?.spot).toBe(185 * 1.05)
  })

  it('applies fx, vol and correlation shocks in their own dimensions', () => {
    useMarketDataStore.getState().applyShock('fxUp')
    expect(useMarketDataStore.getState().fxPairs[0]!.spot).toBe(1.34 * 1.02)

    useMarketDataStore.getState().applyShock('volUp')
    expect(useMarketDataStore.getState().vol.atmVol).toBe(0.25)

    useMarketDataStore.getState().applyShock('corrUp')
    expect(useMarketDataStore.getState().correlations[0]![1]!).toBeGreaterThan(0.55)
  })

  it('updateVol / updateCorrelation mutate and keep symmetry', () => {
    useMarketDataStore.getState().updateVol({ skew: -0.2 })
    expect(useMarketDataStore.getState().vol.skew).toBe(-0.2)

    useMarketDataStore.getState().updateCorrelation(0, 2, 0.3)
    const c = useMarketDataStore.getState().correlations
    expect(c[0]![2]).toBe(0.3)
    expect(c[2]![0]).toBe(0.3) // correlation matrix must stay symmetric
  })

  it('selectUnderlying / selectFX track the shock target', () => {
    useMarketDataStore.getState().selectUnderlying('MSFT')
    useMarketDataStore.getState().applyShock('spotDown')
    expect(useMarketDataStore.getState().underlyings[1]!.spot).toBe(420 * 0.95)
    expect(useMarketDataStore.getState().underlyings[0]!.spot).toBe(185)
  })
})