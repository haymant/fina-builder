// Adapter: the riga canonical fixture `termsheet1.json` (docs/46 §4.3).

import { businessDays, yearsFrom } from '../decoders'
import {
  EMPTY_SIMULATION,
  emptyMeta,
  emptyRails,
  INSTRUMENT_SCHEMA,
  type InstrumentCurve,
  type InstrumentDocument,
  type InstrumentLeg,
  type InstrumentMarket,
  type InstrumentSimulation,
  type InstrumentVolSurface,
  type UnmappedEntry,
} from '../schema'

/* eslint-disable @typescript-eslint/no-explicit-any */

function num(value: any): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** `'9M'` -> 0.75, `'1Y'` -> 1. */
export function tenorToYears(tenor: unknown): number | null {
  const text = String(tenor ?? '').trim().toUpperCase()
  const months = /^(\d+(?:\.\d+)?)M$/.exec(text)
  if (months) return Number(months[1]) / 12
  const years = /^(\d+(?:\.\d+)?)Y$/.exec(text)
  if (years) return Number(years[1])
  return null
}

function atmFromTenors(entries: any, targetYears: number): number | null {
  let best: number | null = null
  let bestDistance = Infinity
  for (const entry of entries ?? []) {
    const years = tenorToYears(entry?.tenor)
    const vol = num(entry?.atm_implied_vol)
    if (years === null || vol === null) continue
    const distance = Math.abs(years - targetYears)
    if (distance < bestDistance) {
      bestDistance = distance
      best = vol
    }
  }
  return best
}

function decodeCurve(md: any, asOf: string): InstrumentCurve | null {
  const curve = md?.discount_curve
  if (!curve?.points) return null
  const pillars = curve.points
    .map((point: any) => {
      const years = tenorToYears(point.tenor)
      const date =
        years === null
          ? String(point.tenor)
          : new Date(Date.parse(asOf) + years * 365 * 86_400_000).toISOString().slice(0, 10)
      return { date, rate: Number(point.zero_rate), tenor: String(point.tenor ?? '') || null }
    })
    .filter((p: { rate: number }) => Number.isFinite(p.rate))
  return {
    id: String(curve.index ?? 'USD Std Curve'),
    dayCount: String(curve.day_count ?? 'Actual/365'),
    asOf,
    pillars,
  }
}

function decodeLocalVol(md: any, symbols: string[], asOf: string): InstrumentVolSurface[] {
  const block = md?.local_vol_surfaces ?? {}
  return symbols
    .map((symbol): InstrumentVolSurface | null => {
      const surface = block[symbol]
      if (!surface) return null
      const maturitiesYears = (surface.maturities ?? [])
        .map((m: any) => yearsFrom(m, asOf))
        .filter((y: number) => Number.isFinite(y) && y > 0)
      if (maturitiesYears.length === 0) return null
      return {
        underlying: symbol,
        maturitiesYears,
        strikes: (surface.strikes ?? []).map(Number),
        vols: (surface.vols ?? []).map((row: any[]) => row.map(Number)),
        reference: null,
        rawRef: null,
      }
    })
    .filter((s): s is InstrumentVolSurface => s !== null)
}

function decodeSimulation(run: any): InstrumentSimulation {
  const vr = run?.variance_reduction
  return {
    ...EMPTY_SIMULATION,
    paths: num(run?.paths) ?? EMPTY_SIMULATION.paths,
    pathBlockSize: num(run?.path_block_size) ?? EMPTY_SIMULATION.pathBlockSize,
    seed: num(run?.seed) ?? EMPTY_SIMULATION.seed,
    traceLevel: (run?.trace_level as InstrumentSimulation['traceLevel']) ?? 'aggregated',
    aad: run?.aad === true,
    varianceReduction: vr && typeof vr === 'object' ? vr : { kind: 'none' },
  }
}

export function decodeRigaFixture(doc: any, fileName: string | null): InstrumentDocument {
  const te = doc.trade_economics ?? {}
  const md = doc.market_data ?? {}
  const assets: any[] = te.reference_assets ?? []
  const symbols: string[] = (te.basket ?? assets.map((a) => a.symbol)).map(String)
  const asOf = String(md.as_of ?? doc.as_of ?? '')
  const finalFixing = String(te.final_fixing_date ?? asOf)
  const maturityYears = Number.isFinite(Date.parse(finalFixing))
    ? (Date.parse(finalFixing) - Date.parse(asOf)) / (86_400_000 * 365)
    : 0
  const barriers = te.barriers ?? {}
  const coupon = te.coupon ?? {}
  // The engine's fixture loader prices only the observations that are still in the
  // future (`observation > as_of`); past periods are not engine input. Mirror that
  // here, so an imported fixture prices the same as `price_put` (coupon periods =
  // future observations, first coupon fixed only if the first *future* one is).
  const schedule: Array<{ observation?: string; coupon_type?: string }> = Array.isArray(te.schedule)
    ? te.schedule
    : []
  const futureCoupons = schedule.filter(
    (row) => typeof row.observation === 'string' && row.observation > asOf,
  )
  const callStart = String(te.callable?.period_start ?? '')

  const initialFixings = symbols.map(
    (symbol, index) => num(md.initial_fixings?.spots?.[symbol]) ?? num(assets[index]?.initial_spot) ?? NaN,
  )
  const spots = symbols.map(
    (symbol, index) => num(md.as_of_spots?.[symbol]) ?? initialFixings[index],
  )
  const vols = symbols.map(
    (symbol) => atmFromTenors(md.vol_surfaces?.[symbol], maturityYears) ?? 0.2,
  )
  const dividendYields = symbols.map(
    (symbol) => num(md.dividend_yields?.annual_continuous?.[symbol]) ?? 0,
  )
  const correlation = md.correlation_matrix?.values ?? [
    [1, 0.4],
    [0.4, 1],
  ]

  const market: InstrumentMarket = {
    asOf,
    symbols,
    initialFixings,
    spots,
    vols,
    dividendYields,
    correlation,
    discountCurve: decodeCurve(md, asOf),
    localVol: decodeLocalVol(md, symbols, asOf),
    raw: md,
  }

  const legs: InstrumentLeg[] = [
    {
      id: 'PUT',
      legId: 1,
      kind: 'put',
      pricedByEngine: true,
      extras: {},
      put: {
        initialSpots: initialFixings,
        strike: num(barriers.exercise?.level_pct) ?? 0,
        knockInBarrier: num(barriers.knock_in?.level_pct) ?? 0,
        knockInType: String(doc.model?.knock_in ?? 'EKI'),
        knockOutKind: (String(doc.model?.knock_out ?? 'global') as 'global' | 'local' | 'none'),
        knockOutBarrier: num(barriers.call?.level_pct),
        koLocked: [],
        koDates: [],
        couponBarrier: num(barriers.coupon?.level_pct),
        couponRate: num(coupon.rate_per_period),
        memoryCoupon: coupon.memory === true,
        couponPeriods: futureCoupons.length > 0 ? futureCoupons.length : (num(coupon.periods) ?? null),
        fixedFirstCoupon:
          futureCoupons.length > 0 ? futureCoupons[0]!.coupon_type === 'fixed' : coupon.period_1 === 'fixed',
        maturityYears,
        steps: Math.min(Math.max(businessDays(asOf, finalFixing), 1), 500),
        callStartStep: callStart !== '' && callStart <= asOf ? 0 : null,
        rails: emptyRails(),
      },
    },
  ]

  const unmapped: UnmappedEntry[] = ['expected', 'provenance', 'units', 'to_capture', 'notes', 'model', 'correlation'].map(
    (key) => ({
      sourcePath: `/${key}`,
      reason: 'fixture acceptance/metadata — not engine input',
      value: doc[key] ?? null,
    }),
  )

  return {
    schema: INSTRUMENT_SCHEMA,
    source: {
      kind: 'riga-fixture',
      adapter: 'riga-fixture@1',
      fileName,
      importedAt: null,
      rawHash: null,
    },
    meta: {
      ...emptyMeta(),
      name: String(te.trade_id ?? doc.fixture ?? 'termsheet1'),
      template: String(doc.fixture ?? 'termsheet1'),
      product: String(te.product ?? '') || null,
      currency: String(te.currency ?? doc.currency ?? 'USD'),
      notional: num(te.notional),
      multiplier: -1,
      systemDate: asOf,
      tradeDate: String(te.trade_date ?? '') || null,
      expiryDate: finalFixing,
      maturityDate: finalFixing,
      lastFixingDate: null,
    },
    legs,
    market,
    simulation: decodeSimulation(doc.run),
    issues: [],
    unmapped,
  }
}
