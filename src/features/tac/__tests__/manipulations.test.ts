// Manipulation selector (§6.6/§6.9): pure, covers every ManipulationType, keeps
// the raw fetch immutable, PSD-clamps correlation and warns on bad vol grids.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyManipulations, clampCorrelation, isPositiveDefinite, volSurfaceWarnings } from '../manipulations'
import { preloadTacMarket, resetTranscripts } from '../../../tests/mocks/transcripts'
import { useTacMarketStore } from '../../../store/tacMarketStore'
import type { TacCorrMatrix, TacMarketRaw } from '../types'

let raw: TacMarketRaw

beforeEach(() => {
  preloadTacMarket()
  raw = useTacMarketStore.getState().raw
})
afterEach(() => resetTranscripts())

describe('applyManipulations', () => {
  it('applies a relative spot manipulation without mutating the raw fetch', () => {
    const before = JSON.parse(JSON.stringify(raw.snapshots)) as typeof raw.snapshots
    const base = raw.snapshots.ADBE.price
    const effective = applyManipulations(raw, [{ type: 'spot', operation: 'relative', value: 0.1, target: '*' }])
    expect(effective.snapshots.ADBE.price).toBeCloseTo(base * 1.1, 6)
    expect(raw.snapshots).toEqual(before)
  })

  it('applies a target-scoped spot manipulation only to that name', () => {
    const adbe = raw.snapshots.ADBE.price
    const amzn = raw.snapshots.AMZN.price
    const effective = applyManipulations(raw, [{ type: 'spot', operation: 'absolute', value: 5, target: 'ADBE' }])
    expect(effective.snapshots.ADBE.price).toBeCloseTo(adbe + 5, 6)
    expect(effective.snapshots.AMZN.price).toBeCloseTo(amzn, 6)
  })

  it('applies a vol-surface ATM manipulation in basis points', () => {
    const baseline = raw.volSurfaces.ADBE.volatility[0]![0]!
    const effective = applyManipulations(raw, [{ type: 'volatility', operation: 'absolute', value: 100, target: 'ADBE', surfaceParameter: 'atm' }])
    expect(effective.volSurfaces.ADBE.volatility[0]![0]!).toBeCloseTo(baseline + 0.01, 6)
  })

  it('applies correlation, curve, dividend and FX manipulations', () => {
    const withActions = { ...raw, corporateActions: [{ symbol: 'AMZN', type: 'dividend', exDate: '2026-09-20', amount: 0.775 }] }
    const effective = applyManipulations(withActions, [
      { type: 'correlation', operation: 'set', value: 0.8, target: 'ADBE|AMZN' },
      { type: 'interest_rate', operation: 'parallel', value: 50 },
      { type: 'dividend', operation: 'relative', value: 0.5, target: 'AMZN' },
      { type: 'fx_spot', operation: 'relative', value: 0.02, target: 'EURUSD' },
      { type: 'fx_volatility', operation: 'absolute', value: 100, target: 'USDJPY' },
    ])
    expect(effective.correlations!.matrix[0]![1]).toBeCloseTo(0.8, 6)
    expect(effective.curve!.pillars[0]!.rate).toBeCloseTo(raw.curve!.pillars[0]!.rate + 0.005, 9)
    const dividend = effective.corporateActions.find((action) => action.symbol === 'AMZN' && action.type === 'dividend')!
    expect(dividend.amount).toBeCloseTo(0.775 * 1.5, 6)
    expect(effective.fx.EURUSD.rate).toBeCloseTo(raw.fx.EURUSD.rate * 1.02, 6)
    expect(effective.fxVol.USDJPY[0]!.realizedVol).toBeCloseTo(raw.fxVol.USDJPY[0]!.realizedVol + 0.01, 6)
  })

  it('returns the raw reference when there are no manipulations', () => {
    expect(applyManipulations(raw, [])).toBe(raw)
  })
})

describe('clampCorrelation', () => {
  it('keeps a corrupted matrix positive-definite and symmetric', () => {
    const clamped = clampCorrelation([
      [1, 1.4, -0.9],
      [1.4, 1, 0.5],
      [-0.9, 0.5, 1],
    ])
    expect(isPositiveDefinite(clamped)).toBe(true)
    expect(clamped[0]![1]).toBeCloseTo(clamped[1]![0]!, 12)
    expect(Math.abs(clamped[0]![1]!)).toBeLessThanOrEqual(1)
  })

  it('clamps a 2x2 correlation into (-1, 1) when a manipulation is applied', () => {
    const matrix: TacCorrMatrix = { legs: ['A', 'B'], matrix: [[1, 2], [2, 1]], pairs: [] }
    const effective = applyManipulations({ ...raw, correlations: matrix }, [
      { type: 'correlation', operation: 'set', value: 2, target: '*' },
    ])
    expect(Math.abs(effective.correlations!.matrix[0]![1]!)).toBeLessThanOrEqual(1)
    expect(isPositiveDefinite(effective.correlations!.matrix)).toBe(true)
  })
})

describe('volSurfaceWarnings', () => {
  it('flags a non-positive volatility', () => {
    const warnings = volSurfaceWarnings({ ...raw.volSurfaces.ADBE, volatility: [[0, 0.4], [0.4, 0.5]] })
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('flags a calendar-arbitrage risk', () => {
    const surface = raw.volSurfaces.ADBE
    const broken = { ...surface, volatility: surface.volatility.map((row, i) => row.map((v) => (i === surface.volatility.length - 1 ? 0.001 : v))) }
    expect(volSurfaceWarnings(broken).some((warning) => warning.includes('calendar'))).toBe(true)
  })
})
