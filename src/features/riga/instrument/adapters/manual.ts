// A blank `fina.instrument/v1` document seeded from the pinned termsheet1
// economics, so the trade tile is never empty (docs/46 §4.4).

import {
  EMPTY_SIMULATION,
  emptyMeta,
  emptyRails,
  INSTRUMENT_SCHEMA,
  type InstrumentDocument,
} from '../schema'

export function blankDocument(fileName: string | null = null): InstrumentDocument {
  const asOf = '2026-09-07'
  return {
    schema: INSTRUMENT_SCHEMA,
    source: { kind: 'manual', adapter: 'manual', fileName, importedAt: null, rawHash: null },
    meta: {
      ...emptyMeta(),
      name: 'instrument',
      template: 'ELIFCN_KI',
      currency: 'USD',
      notional: 10000,
      multiplier: -1,
      systemDate: asOf,
    },
    legs: [
      {
        id: 'PUT',
        legId: 1,
        kind: 'put',
        pricedByEngine: true,
        extras: {},
        put: {
          initialSpots: [239.97, 260],
          strike: 0.78,
          knockInBarrier: 0.7,
          knockInType: 'EKI',
          knockOutKind: 'global',
          knockOutBarrier: 1.1,
          koLocked: [],
          koDates: [],
          couponBarrier: 0.1,
          couponRate: 0.009642,
          memoryCoupon: true,
          couponPeriods: 9,
          fixedFirstCoupon: true,
          maturityYears: 0.75,
          steps: 9,
          callStartStep: 1,
          rails: emptyRails(),
        },
      },
    ],
    market: {
      asOf,
      symbols: ['ADBE', 'AMZN'],
      initialFixings: [239.97, 260],
      spots: [239.97, 260],
      vols: [0.45, 0.45],
      dividendYields: [0, 0.002979],
      correlation: [
        [1, 0.4593248180905],
        [0.4593248180905, 1],
      ],
      discountCurve: null,
      localVol: [],
      raw: {},
    },
    simulation: { ...EMPTY_SIMULATION },
    issues: [],
    unmapped: [],
  }
}
