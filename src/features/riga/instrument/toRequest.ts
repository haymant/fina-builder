// `fina.instrument/v1` -> riga_engine::PriceRequest (docs/46 §5).

import type { RigaPhoenixTrade, RigaPriceRequest, RigaMarketSnapshot, RigaSimulationConfig } from '../types'
import type { InstrumentCurve, InstrumentDocument } from './schema'

export class InstrumentError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'InstrumentError'
    this.code = code
  }
}

/** Interpolated zero rate at `years`, anchored at the curve's pillars. */
export function rateAt(curve: InstrumentCurve | null, years: number): number {
  if (!curve || curve.pillars.length === 0) return 0
  const asOfMs = curve.asOf ? Date.parse(curve.asOf) : Date.parse(curve.pillars[0].date)
  const pillars = curve.pillars
    .map((p) => ({ years: (Date.parse(p.date) - asOfMs) / (86_400_000 * 365), rate: p.rate }))
    .sort((a, b) => a.years - b.years)
  if (years <= pillars[0].years) return pillars[0].rate
  for (let i = 1; i < pillars.length; i++) {
    if (years <= pillars[i].years) {
      const a = pillars[i - 1]
      const b = pillars[i]
      const w = (years - a.years) / (b.years - a.years)
      return a.rate + w * (b.rate - a.rate)
    }
  }
  return pillars[pillars.length - 1].rate
}

export function toRequest(doc: InstrumentDocument): RigaPriceRequest {
  const put = doc.legs.find((leg) => leg.kind === 'put' && leg.put)?.put
  if (!put) throw new InstrumentError('engine.no_put_leg', 'the document has no put leg')

  const trade: RigaPhoenixTrade = {
    tradeId: doc.meta.name ?? doc.source.fileName ?? 'instrument',
    initialSpots: put.initialSpots,
    maturityYears: put.maturityYears,
    steps: put.steps,
    strike: put.strike,
    knockInBarrier: put.knockInBarrier,
    knockOutBarrier: put.knockOutBarrier,
    couponBarrier: put.couponBarrier,
    couponRate: put.couponRate,
    memoryCoupon: put.memoryCoupon,
    couponPeriods: put.couponPeriods,
    fixedFirstCoupon: put.fixedFirstCoupon,
    callStartStep: put.callStartStep,
  }
  const market: RigaMarketSnapshot = {
    asOf: doc.market.asOf,
    spots: doc.market.spots,
    vols: doc.market.vols,
    riskFreeRate: rateAt(doc.market.discountCurve, put.maturityYears),
    dividendYields: doc.market.dividendYields,
    correlation: doc.market.correlation,
  }
  const config: RigaSimulationConfig = {
    paths: doc.simulation.paths,
    pathBlockSize: doc.simulation.pathBlockSize,
    seed: doc.simulation.seed,
    traceLevel: doc.simulation.traceLevel,
    varianceReduction: doc.simulation.varianceReduction,
  }
  const localVol = doc.market.localVol.length
    ? {
        grids: doc.market.localVol.map((surface) => ({
          maturitiesYears: surface.maturitiesYears,
          strikes: surface.strikes,
          vols: surface.vols,
        })),
      }
    : undefined

  return { trade, market, config, asOf: doc.market.asOf, localVol }
}
