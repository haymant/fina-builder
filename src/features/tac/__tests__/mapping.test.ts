// tac-engine → riga-flow surface mapping (§6.3): the Dupire local-vol grid
// path. tac-engine maturities are Excel serials and its strikes may be
// relative; riga-flow wants absolute strikes and tenors in years anchored at
// the valuation date.

import { beforeEach, describe, expect, it } from 'vitest'
import {
  effectiveRigaMarket,
  localVolGridsFromTac,
  maturityYears,
  surfaceToImpliedVolGrid,
  tacSymbols,
} from '../mapping'
import type { TacMarketRaw, TacVolSurface } from '../types'
import { EMPTY_TAC_RAW, useTacMarketStore } from '../../../store/tacMarketStore'
import { useRigaMarketStore } from '../../../store/rigaMarketStore'
import { composeRigaRequest } from '../../../store/rigaRequestStore'

const AS_OF = '2026-09-07'
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
const serial = (iso: string) => (Date.parse(iso) - EXCEL_EPOCH_MS) / 86_400_000

function surface(overrides: Partial<TacVolSurface> = {}): TacVolSurface {
  return {
    underlying: 'ADBE',
    strikeType: 'absolute',
    reference: 250,
    maturities: [serial('2026-10-04'), serial('2026-11-04')],
    strikes: [200, 250, 300],
    volatility: [
      [0.5, 0.45, 0.48],
      [0.52, 0.47, 0.5],
    ],
    ...overrides,
  }
}

beforeEach(() => {
  useRigaMarketStore.getState().resetMarket()
  useTacMarketStore.setState({ raw: EMPTY_TAC_RAW, manipulations: [] })
})

describe('maturityYears', () => {
  it('converts an ISO date to years from asOf (the fixture convention)', () => {
    expect(maturityYears('2026-10-04', AS_OF)).toBeCloseTo(27 / 365, 10)
  })

  it('converts an Excel serial date to years from asOf', () => {
    expect(maturityYears(serial('2026-10-04'), AS_OF)).toBeCloseTo(27 / 365, 10)
  })

  it('rejects a maturity at or before asOf, and unparseable input', () => {
    expect(maturityYears('2026-09-07', AS_OF)).toBeNull()
    expect(maturityYears('2026-01-01', AS_OF)).toBeNull()
    expect(maturityYears('not-a-date', AS_OF)).toBeNull()
    expect(maturityYears('2026-10-04', 'also-not-a-date')).toBeNull()
  })
})

describe('surfaceToImpliedVolGrid', () => {
  it('converts serial maturities to years and keeps absolute strikes', () => {
    const grid = surfaceToImpliedVolGrid(surface(), AS_OF)!
    expect(grid).not.toBeNull()
    expect(grid.maturitiesYears[0]).toBeCloseTo(27 / 365, 10)
    expect(grid.maturitiesYears[1]).toBeCloseTo(58 / 365, 10)
    expect(grid.strikes).toEqual([200, 250, 300])
    expect(grid.vols).toEqual([
      [0.5, 0.45, 0.48],
      [0.52, 0.47, 0.5],
    ])
  })

  it('strikes a relative surface against its reference', () => {
    const grid = surfaceToImpliedVolGrid(
      surface({ strikeType: 'relative', reference: 200, strikes: [0.9, 1, 1.2] }),
      AS_OF,
    )!
    expect(grid.strikes).toEqual([180, 200, 240])
  })

  it('sorts and de-duplicates both axes (riga-flow requires strict increase)', () => {
    const grid = surfaceToImpliedVolGrid(
      surface({
        maturities: [serial('2026-11-04'), serial('2026-10-04'), serial('2026-10-04')],
        strikes: [300, 200, 200, 250],
        volatility: [
          [0.5, 0.4, 0.4, 0.45],
          [0.6, 0.5, 0.5, 0.55],
          [0.61, 0.51, 0.51, 0.56],
        ],
      }),
      AS_OF,
    )!
    expect(grid.maturitiesYears).toHaveLength(2)
    expect(grid.strikes).toEqual([200, 250, 300])
    // The 2026-10-04 rows are kept once, with the 200 column de-duplicated.
    expect(grid.vols[0]).toEqual([0.5, 0.55, 0.6])
    expect(grid.vols[1]).toEqual([0.4, 0.45, 0.5])
  })

  it('returns null when there is no usable grid', () => {
    expect(surfaceToImpliedVolGrid(undefined, AS_OF)).toBeNull()
    expect(surfaceToImpliedVolGrid(surface({ strikes: [] }), AS_OF)).toBeNull()
    expect(surfaceToImpliedVolGrid(surface({ maturities: [] }), AS_OF)).toBeNull()
    expect(
      surfaceToImpliedVolGrid(surface({ maturities: [serial('2026-01-01')] }), AS_OF),
    ).toBeNull()
  })
})

describe('localVolGridsFromTac', () => {
  const raw: TacMarketRaw = {
    ...EMPTY_TAC_RAW,
    snapshots: {
      ADBE: { symbol: 'ADBE', price: 250, asOf: AS_OF },
      AMZN: { symbol: 'AMZN', price: 260, asOf: AS_OF },
    },
    volSurfaces: {
      ADBE: surface(),
      AMZN: surface({ underlying: 'AMZN', reference: 260, strikes: [210, 260, 310] }),
    },
  }

  it('aligns one grid per factor in pricing order', () => {
    expect(tacSymbols(raw)).toEqual(['ADBE', 'AMZN'])
    const grids = localVolGridsFromTac(raw, AS_OF)!
    expect(grids).toHaveLength(2)
    expect(grids[0]!.strikes).toEqual([200, 250, 300])
    expect(grids[1]!.strikes).toEqual([210, 260, 310])
  })

  it('returns null unless every factor has a usable surface', () => {
    const missing = { ...raw, volSurfaces: { ADBE: raw.volSurfaces.ADBE! } }
    expect(localVolGridsFromTac(missing, AS_OF)).toBeNull()
    expect(localVolGridsFromTac(EMPTY_TAC_RAW, AS_OF)).toBeNull()
  })
})

describe('composeRigaRequest local-vol wiring', () => {
  const raw: TacMarketRaw = {
    ...EMPTY_TAC_RAW,
    snapshots: {
      ADBE: { symbol: 'ADBE', price: 250, asOf: AS_OF },
      AMZN: { symbol: 'AMZN', price: 260, asOf: AS_OF },
    },
    volSurfaces: {
      ADBE: surface(),
      AMZN: surface({ underlying: 'AMZN', reference: 260, strikes: [210, 260, 310] }),
    },
  }

  it('sends the surface grids when the toggle is on', () => {
    useTacMarketStore.setState({ raw, manipulations: [] })
    useRigaMarketStore.getState().setUseSurfaceLocalVol(true)
    const request = composeRigaRequest()
    expect(request.localVol?.grids).toHaveLength(2)
    expect(request.localVol?.grids?.[0]?.maturitiesYears[0]).toBeCloseTo(27 / 365, 10)
    // The scalar path stays populated as the fallback lane.
    expect(request.market.vols.every((v) => v > 0)).toBe(true)
  })

  it('falls back to the flat scalar when the toggle is off', () => {
    useTacMarketStore.setState({ raw, manipulations: [] })
    useRigaMarketStore.getState().setUseSurfaceLocalVol(false)
    expect(composeRigaRequest().localVol).toBeNull()
  })

  it('sends the surface grids even when only the front maturity would be used otherwise', () => {
    // effectiveRigaMarket still writes the ATM scalar; the grid is additive.
    useTacMarketStore.setState({ raw, manipulations: [] })
    const effective = useTacMarketStore.getState().raw
    const market = effectiveRigaMarket(useRigaMarketStore.getState().market, effective)
    expect(market.vols[0]).toBeGreaterThan(0)
  })
})
