// Canonical instrument document — `fina.instrument/v1` (docs/46 §3).
//
// One edited, source-agnostic representation of a trade + its market, produced
// by an adapter from a Murex chunk (`1.json`, `termsheet1.md.json`) or the riga
// fixture (`termsheet1.json`), consumed by `toRequest()` -> riga_engine::PriceRequest.

export const INSTRUMENT_SCHEMA = 'fina.instrument/v1' as const
export type InstrumentSchemaId = typeof INSTRUMENT_SCHEMA

export type InstrumentAdapterId = 'murex-chunk@1' | 'riga-fixture@1' | 'manual'

export interface InstrumentSource {
  kind: 'murex-chunk' | 'riga-fixture' | 'manual'
  adapter: InstrumentAdapterId
  fileName: string | null
  importedAt: string | null
  rawHash: string | null
}

export interface InstrumentMeta {
  name: string | null
  template: string | null
  product: string | null
  currency: string | null
  notional: number | null
  multiplier: number | null
  systemDate: string | null
  tradeDate: string | null
  expiryDate: string | null
  maturityDate: string | null
  lastFixingDate: string | null
}

export type InstrumentLegKind = 'put' | 'coupon' | 'funding' | 'unknown'

export interface PhoenixRails {
  lowCallStrik: number | null
  PRUp: number | null
  strikeKI1: number | null
  PRKI1: number | null
  strikeKI2: number | null
  PRKI2: number | null
  KIBarrier: number | null
  maturBarrier: number | null
  capKI2: boolean | null
  floorKI2: boolean | null
  capUp: boolean | null
  floorUp: boolean | null
  PRNOKI1: number | null
  PRNOKI2: number | null
  /** The whole `knockInStar` object, unmodified. */
  raw: Record<string, unknown>
}

export interface PutTerms {
  initialSpots: number[]
  strike: number
  knockInBarrier: number
  knockInType: string
  knockOutKind: 'global' | 'local' | 'none'
  knockOutBarrier: number | null
  koLocked: boolean[]
  koDates: Array<string | null>
  couponBarrier: number | null
  couponRate: number | null
  memoryCoupon: boolean
  couponPeriods: number | null
  fixedFirstCoupon: boolean
  maturityYears: number
  steps: number
  callStartStep: number | null
  rails: PhoenixRails
}

export interface CouponTerms {
  ratePerPeriod: number | null
  periods: number | null
  memory: boolean
  quoteScale: number | null
  raw: Record<string, unknown>
}

export interface FundingTerms {
  notionalReturn: boolean
  returnRatio: number
  raw: Record<string, unknown>
}

export interface InstrumentLeg {
  id: string
  legId: number | null
  kind: InstrumentLegKind
  pricedByEngine: boolean
  put?: PutTerms
  coupon?: CouponTerms
  funding?: FundingTerms
  extras: Record<string, unknown>
}

export interface InstrumentCurvePillar {
  date: string
  rate: number
  tenor: string | null
}

export interface InstrumentCurve {
  id: string
  dayCount: string
  asOf: string | null
  pillars: InstrumentCurvePillar[]
}

export interface InstrumentVolSurface {
  underlying: string
  maturitiesYears: number[]
  strikes: number[]
  vols: number[][]
  reference: number | null
  rawRef: unknown
}

export interface InstrumentMarket {
  asOf: string
  symbols: string[]
  initialFixings: number[]
  spots: number[]
  vols: number[]
  dividendYields: number[]
  correlation: number[][]
  discountCurve: InstrumentCurve | null
  localVol: InstrumentVolSurface[]
  raw: Record<string, unknown>
}

export interface InstrumentSimulation {
  paths: number
  pathBlockSize: number
  seed: number
  traceLevel: 'off' | 'aggregated' | 'sampled' | 'full'
  aad: boolean
  varianceReduction: { kind: 'none' | 'halton' | 'sobol'; dimension?: number }
}

export interface InstrumentIssue {
  severity: 'info' | 'warn' | 'error'
  code: string
  path: string
  message: string
  sourcePath?: string
}

export interface UnmappedEntry {
  sourcePath: string
  reason: string
  value: unknown
}

export interface InstrumentDocument {
  schema: InstrumentSchemaId
  source: InstrumentSource
  meta: InstrumentMeta
  legs: InstrumentLeg[]
  market: InstrumentMarket
  simulation: InstrumentSimulation
  issues: InstrumentIssue[]
  unmapped: UnmappedEntry[]
}

export const EMPTY_SIMULATION: InstrumentSimulation = {
  paths: 30000,
  pathBlockSize: 4096,
  seed: 1729,
  traceLevel: 'aggregated',
  aad: false,
  varianceReduction: { kind: 'none' },
}

export function emptyMeta(): InstrumentMeta {
  return {
    name: null,
    template: null,
    product: null,
    currency: null,
    notional: null,
    multiplier: null,
    systemDate: null,
    tradeDate: null,
    expiryDate: null,
    maturityDate: null,
    lastFixingDate: null,
  }
}

export function emptyRails(): PhoenixRails {
  return {
    lowCallStrik: null,
    PRUp: null,
    strikeKI1: null,
    PRKI1: null,
    strikeKI2: null,
    PRKI2: null,
    KIBarrier: null,
    maturBarrier: null,
    capKI2: null,
    floorKI2: null,
    capUp: null,
    floorUp: null,
    PRNOKI1: null,
    PRNOKI2: null,
    raw: {},
  }
}
