// Adapter: Murex trading-system chunk (`1.json`, `termsheet1.md.json`).
// See docs/46 §4.2 for the mapping table.

import {
  atmVol,
  businessDays,
  decodeDeal,
  fileMarketBlock,
  isoFromSerial,
  marketFromFile,
  normaliseSurface,
  stripMarket,
  surfaceToGrid,
  yearsFrom,
  type Surface,
} from '../decoders'
import {
  EMPTY_SIMULATION,
  emptyMeta,
  emptyRails,
  INSTRUMENT_SCHEMA,
  type CouponTerms,
  type FundingTerms,
  type InstrumentCurve,
  type InstrumentDocument,
  type InstrumentIssue,
  type InstrumentLeg,
  type InstrumentLegKind,
  type InstrumentMarket,
  type InstrumentSimulation,
  type InstrumentVolSurface,
  type PhoenixRails,
  type PutTerms,
  type UnmappedEntry,
} from '../schema'

/* eslint-disable @typescript-eslint/no-explicit-any */

function num(value: any): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}
function bool(value: any): boolean | null {
  return typeof value === 'boolean' ? value : null
}
function putKind(legName: unknown): InstrumentLegKind {
  const name = String(legName ?? '').toUpperCase()
  if (name.includes('PUT')) return 'put'
  if (name.includes('COUPON')) return 'coupon'
  if (name.includes('FUND')) return 'funding'
  return 'unknown'
}

function jsonPointerOfUnsupportedRails(rails: PhoenixRails): InstrumentIssue[] {
  const issues: InstrumentIssue[] = []
  const nonDefault = (label: string, value: unknown, expected: unknown) => {
    if (value !== expected && value !== null) {
      issues.push({
        severity: 'warn',
        code: 'engine.unsupported_rail',
        path: `/legs/*/put/rails/${label}`,
        message: `${label}=${String(value)} is not modelled by riga-engine (expected ${String(expected)})`,
      })
    }
  }
  nonDefault('PRUp', rails.PRUp, 0)
  nonDefault('PRKI1', rails.PRKI1, 0)
  nonDefault('capKI2', rails.capKI2, false)
  nonDefault('floorKI2', rails.floorKI2, false)
  nonDefault('PRNOKI1', rails.PRNOKI1, 0)
  nonDefault('PRNOKI2', rails.PRNOKI2, 0)
  // `PRKI2` is the KI participation. In the captured Murex product the *active*
  // leg encodes it as `-1` (unit magnitude; the investor-side sign is applied by
  // the engine's `funding + coupon − put` aggregate) and `0` marks it inactive.
  // riga-engine models a unit (100%) participation only, so any other magnitude
  // (e.g. a real 50% participation) must surface rather than be silently priced
  // at 100%. See docs/46 §14.1 (payoff normalisation — resolved 2026-10-18).
  const prki2 = rails.PRKI2
  if (prki2 !== null && Math.abs(prki2) !== 0 && Math.abs(prki2) !== 1) {
    issues.push({
      severity: 'warn',
      code: 'engine.unsupported_rail',
      path: '/legs/*/put/rails/PRKI2',
      message: `PRKI2=${prki2} is a non-unit KI participation; riga-engine models a unit (100%) participation only`,
    })
  }
  return issues
}

function decodePut(
  deal: any,
  kiko: any,
  asOf: string,
  expiryIso: string,
  meta: InstrumentDocument['meta'],
): PutTerms {
  const knockInStar = deal.knockInStar ?? {}
  const rails: PhoenixRails = {
    ...emptyRails(),
    lowCallStrik: num(knockInStar.lowCallStrik),
    PRUp: num(knockInStar.PRUp),
    strikeKI1: num(knockInStar.strikeKI1),
    PRKI1: num(knockInStar.PRKI1),
    strikeKI2: num(knockInStar.strikeKI2),
    PRKI2: num(knockInStar.PRKI2),
    KIBarrier: num(knockInStar.KIBarrier),
    maturBarrier: num(knockInStar.maturBarrier),
    capKI2: bool(knockInStar.capKI2),
    floorKI2: bool(knockInStar.floorKI2),
    capUp: bool(knockInStar.capUp),
    floorUp: bool(knockInStar.floorUp),
    PRNOKI1: num(knockInStar.PRNOKI1),
    PRNOKI2: num(knockInStar.PRNOKI2),
    raw: knockInStar,
  }
  const globalKO = kiko.globalKO === true
  const localKO = kiko.localKO === true
  const koDates = (kiko.GKODate ?? []).map((serial: any) =>
    Number(serial) > 0 ? isoFromSerial(serial) : null,
  )
  const expiry = meta.expiryDate ?? expiryIso
  return {
    initialSpots: (kiko.referencePrice ?? []).map(Number),
    strike: num(deal.strike) ?? num(rails.strikeKI2) ?? 0,
    knockInBarrier: num(rails.KIBarrier) ?? num(kiko.maturBarrier) ?? 0,
    knockInType: String(kiko.knockInType ?? 'EKI'),
    knockOutKind: globalKO ? 'global' : localKO ? 'local' : 'none',
    knockOutBarrier: deal.RGACCLKO?.gblBarPrice != null ? Number(deal.RGACCLKO.gblBarPrice) : null,
    koLocked: (kiko.GKOLocked ?? []).map(Boolean),
    koDates,
    couponBarrier: null,
    couponRate: null,
    memoryCoupon: false,
    couponPeriods: null,
    fixedFirstCoupon: false,
    maturityYears: Number.isFinite(Date.parse(expiry))
      ? (Date.parse(expiry) - Date.parse(asOf)) / (86_400_000 * 365)
      : 0,
    steps: Math.min(Math.max(businessDays(asOf, expiry), 1), 500),
    callStartStep: null,
    rails,
  }
}

function decodeCoupon(deal: any, asOf: string): CouponTerms {
  const rg = deal.RGACCLKO ?? {}
  const periods = (rg.accruRate ?? []).filter((rate: any) => Number(rate) > 0).length
  return {
    ratePerPeriod: (rg.accruRate ?? []).map(Number).find((r: number) => r > 0) ?? null,
    periods: periods || null,
    memory: true,
    quoteScale: 10,
    raw: { RGACCLKO: rg, RGACCDate: deal.RGACCDate ?? null, asOf },
  }
}

function decodeFunding(deal: any): FundingTerms {
  const kiko = deal.KIKOSelect ?? {}
  return {
    notionalReturn: kiko.notionalReturn === true,
    returnRatio: num(kiko.returnRatio) ?? 1,
    raw: { notionalReturn: kiko.notionalReturn, returnRatio: kiko.returnRatio },
  }
}

function decodeCurve(md: any, asOf: string): InstrumentCurve | null {
  const curve = md?.discCurves?.[0] ?? md?.estCurves?.[0]
  if (!curve) return null
  const pillars = (curve.curve ?? [])
    .map((point: any) => ({
      date: Number.isFinite(Number(point.date)) ? isoFromSerial(point.date) : String(point.date),
      rate: Number(point.rate),
      tenor: null,
    }))
    .filter((p: { rate: number }) => Number.isFinite(p.rate))
    .sort((a: { date: string }, b: { date: string }) => Date.parse(a.date) - Date.parse(b.date))
  return {
    id: String(curve._id ?? curve.id ?? curve.name ?? 'curve'),
    dayCount: String(curve.dayCount ?? curve.day_count ?? 'Actual/365'),
    asOf,
    pillars,
  }
}

function gridToSurface(
  symbol: string,
  grid: ReturnType<typeof surfaceToGrid>,
  surface: Surface | undefined,
): InstrumentVolSurface | null {
  if (!grid) return null
  return {
    underlying: symbol,
    maturitiesYears: grid.maturities_years,
    strikes: grid.strikes,
    vols: grid.vols,
    reference: surface ? Number(surface.reference) : null,
    rawRef: surface?.strikeType ?? null,
  }
}

function decodeSimulation(md: any): InstrumentSimulation {
  const mc = md?.MCPara ?? {}
  const vr = mc.varianceReduction ?? mc.variance_reduction
  return {
    ...EMPTY_SIMULATION,
    paths: num(mc.numPaths ?? mc.num_paths) ?? EMPTY_SIMULATION.paths,
    pathBlockSize: num(mc.pathBlockSize ?? mc.blockSize) ?? EMPTY_SIMULATION.pathBlockSize,
    seed: num(mc.seed) ?? EMPTY_SIMULATION.seed,
    aad: mc.aad === true,
    varianceReduction: vr && typeof vr === 'object' ? vr : { kind: 'none' },
  }
}

export function decodeMurexChunk(doc: any, fileName: string | null): InstrumentDocument {
  const jobs: any[] = doc?.Chunk?.Jobs ?? []
  const deal = decodeDeal(doc)
  const primaryJob = jobs[0]
  const primaryDeal = primaryJob?.commonData?.dealData ?? doc
  const md = fileMarketBlock(doc) ?? {}
  const meta = {
    ...emptyMeta(),
    name: deal.name,
    template: deal.template,
    product: String(primaryDeal?.instrument?.product ?? primaryDeal?.productName ?? '') || null,
    currency: deal.currency,
    notional: deal.notional,
    multiplier: deal.multiplier,
    systemDate: String(primaryDeal?.extractedSystemDate ?? '') || null,
    tradeDate: Number.isFinite(Number(primaryDeal?.KIKOSelect?.initialFixDate))
      ? isoFromSerial(primaryDeal.KIKOSelect.initialFixDate)
      : null,
    expiryDate: Number.isFinite(Number(primaryDeal?.expiryDate))
      ? isoFromSerial(primaryDeal.expiryDate)
      : null,
    maturityDate: Number.isFinite(Number(primaryDeal?.maturityDate))
      ? isoFromSerial(primaryDeal.maturityDate)
      : null,
    lastFixingDate:
      Number(primaryDeal?.lastFixingDate) > 0 ? isoFromSerial(primaryDeal.lastFixingDate) : null,
  }

  const issues: InstrumentIssue[] = []
  const legs: InstrumentLeg[] = jobs.map((job, index) => {
    const jd = job?.commonData?.dealData ?? {}
    const kind = putKind(jd.legName)
    const leg: InstrumentLeg = {
      id: String(jd.legName ?? `leg${index}`),
      legId: num(jd.legId),
      kind,
      pricedByEngine: kind === 'put',
      extras: {
        notional: jd.notional ?? null,
        multiplier: jd.multiplier ?? null,
        paymentCurrency: jd.paymentCurrency ?? null,
        productTemplate: jd.productTemplate ?? null,
        instrumentName: jd.instrumentName ?? null,
      },
    }
    if (kind === 'put') {
      leg.put = decodePut(jd, jd.KIKOSelect ?? {}, deal.asOf, deal.finalFixing, meta)
      issues.push(...jsonPointerOfUnsupportedRails(leg.put.rails))
    } else if (kind === 'coupon') {
      leg.coupon = decodeCoupon(jd, deal.asOf)
    } else if (kind === 'funding') {
      leg.funding = decodeFunding(jd)
    }
    return leg
  })

  if (!legs.some((l) => l.kind === 'put')) {
    issues.push({
      severity: 'error',
      code: 'engine.no_put_leg',
      path: '/legs',
      message: 'no PUT leg found; riga-engine prices the put leg only',
    })
  }
  if (!md || Object.keys(md).length === 0) {
    issues.push({
      severity: 'error',
      code: 'market.missing',
      path: '/market',
      message: 'no marketData block in the chunk',
    })
  }

  const fileMarket = marketFromFile(doc, deal)
  const symbols = deal.symbols
  const equityById: Map<string, any> = new Map(
    (md.equity ?? []).map((e: any): [string, any] => [stripMarket(e._id), e]),
  )
  const surfaces: Map<string, Surface> = new Map(
    (md.eqVol ?? []).map(
      (e: any): [string, Surface] => [stripMarket(e._id), normaliseSurface(e)],
    ),
  )
  const localVol = symbols
    .map((symbol: string) =>
      gridToSurface(symbol, surfaceToGrid(surfaces.get(symbol) ?? null, deal.asOf), surfaces.get(symbol)),
    )
    .filter((s: InstrumentVolSurface | null): s is InstrumentVolSurface => s !== null)

  const maturityYears = fileMarket ? yearsFrom(deal.finalFixing, fileMarket.asOf) : 0
  const market: InstrumentMarket = {
    asOf: fileMarket?.asOf ?? deal.asOf,
    symbols,
    initialFixings: deal.initialSpots,
    spots: fileMarket?.spots ?? symbols.map((s: string) => num(equityById.get(s)?.spot) ?? NaN),
    vols:
      fileMarket?.vols ??
      symbols.map(
        (s: string) => (surfaces.get(s) && atmVol(surfaces.get(s), deal.asOf, maturityYears)) ?? 0.2,
      ),
    dividendYields: fileMarket?.dividendYields ?? symbols.map(() => 0),
    correlation: fileMarket?.correlation ?? [
      [1, 0.4],
      [0.4, 1],
    ],
    discountCurve: decodeCurve(md, fileMarket?.asOf ?? deal.asOf),
    localVol,
    raw: md,
  }

  const unmapped: UnmappedEntry[] = [
    { sourcePath: '/Chunk/finaRef*', reason: 'provenance metadata', value: null },
    { sourcePath: '/Chunk/Jobs/*/Tasks', reason: 'solver task log', value: null },
  ]
  for (const note of fileMarket?.notes ?? []) {
    issues.push({ severity: 'info', code: 'market.note', path: '/market', message: note })
  }

  return {
    schema: INSTRUMENT_SCHEMA,
    source: {
      kind: 'murex-chunk',
      adapter: 'murex-chunk@1',
      fileName,
      importedAt: null,
      rawHash: null,
    },
    meta,
    legs,
    market,
    simulation: decodeSimulation(md),
    issues,
    unmapped,
  }
}
