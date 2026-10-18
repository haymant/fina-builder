// Pure decoders for the Murex trading-system dialect (`1.json`,
// `termsheet1.md.json`). Lifted verbatim from `scripts/price-instrument.mjs` so
// the CLI and the app share one implementation (docs/46 §4). No I/O, no node
// imports, no `@/` alias — `scripts/price-instrument.mjs` imports this module
// under Node's TypeScript type-stripping (Node >= 23.6; the repo runs Node 24).

/* eslint-disable @typescript-eslint/no-explicit-any */

import { EXCEL_EPOCH_MS, MS_PER_DAY, toIsoDate } from '../../../lib/dates.ts'

export { EXCEL_EPOCH_MS, MS_PER_DAY }
export const DAYS_PER_YEAR = 365
export const AXIS_EPSILON = 1e-9

/** Excel/Murex serial → `YYYY-MM-DD`; ISO and other shapes via the heuristic. */
export const isoFromSerial = (serial: any): string =>
  toIsoDate(serial) ??
  new Date(EXCEL_EPOCH_MS + Number(serial) * MS_PER_DAY).toISOString().slice(0, 10)
export const serialFromIso = (iso: string): number =>
  Math.round((Date.parse(iso) - EXCEL_EPOCH_MS) / MS_PER_DAY)
export const isDate = (value: unknown): value is string =>
  typeof value === 'string' && toIsoDate(value) !== null
export const stripMarket = (name: unknown): string =>
  String(name ?? '')
    .trim()
    .replace(/\s+[A-Z]{2}$/, '')
    .toUpperCase()
export const yearsFrom = (maturity: number | string, asOf: string): number => {
  const iso = toIsoDate(maturity)
  if (!iso) return NaN
  return (Date.parse(iso) - Date.parse(asOf)) / (MS_PER_DAY * DAYS_PER_YEAR)
}

export function businessDays(fromIso: string, toIso: string): number {
  const start = Date.parse(fromIso)
  const end = Date.parse(toIso)
  let count = 0
  for (let t = start + MS_PER_DAY; t <= end; t += MS_PER_DAY) {
    const day = new Date(t).getUTCDay()
    if (day !== 0 && day !== 6) count++
  }
  return count
}

// ---------------------------------------------------------------------------
// Deal decoding (the ELIFCN_KI / KIKO-note family this repo prices)
// ---------------------------------------------------------------------------

export interface Deal {
  name: string
  template: string
  leg: string
  notional: number
  multiplier: number
  currency: string
  symbols: string[]
  initialSpots: number[]
  asOf: string
  finalFixing: string
  koStart: string
  strike: number
  knockIn: number
  knockOut: number | null
  coupon: null
}

export function decodeDeal(doc: any): Deal {
  // The instrument block sits under Chunk.Jobs[0].commonData.dealData; tolerate
  // the bare form used by earlier extracts.
  const root = doc?.Chunk?.Jobs?.[0]?.commonData?.dealData ?? doc
  const inst = root.instrument ?? root
  const kiko = root.KIKOSelect ?? {}
  const underlyings = inst.underlyings ?? []
  const symbols = (kiko.underlyingName ?? underlyings.map((u: any) => u.name)).map(stripMarket)
  // `initspot` is the initial spot / reference price, **not** a current mark;
  // the current mark only exists in `marketData.equity`.
  const initialSpots = (
    kiko.referencePrice ?? underlyings.map((u: any) => u.initspot ?? u.spot)
  ).map(Number)
  const asOf = isDate(root.extractedSystemDate)
    ? root.extractedSystemDate
    : isDate(inst.initialFixingDate)
      ? inst.initialFixingDate
      : isoFromSerial(root.expiryDate)
  const finalFixing = isDate(inst.finalFixingDate)
    ? inst.finalFixingDate
    : isoFromSerial(root.expiryDate)
  const koSerial = root.globalKOStar?.obvDate?.[0] ?? root.RGACCLKO?.endDate?.[0]

  return {
    name: root.instrumentName ?? inst.name ?? 'instrument',
    template: root.productTemplate ?? inst.classification?.productTemplate?.name ?? 'ELIFCN_KI',
    leg: root.legName ?? inst.legName ?? 'PUT',
    notional: Number(inst.notional ?? root.notional ?? 0),
    multiplier: Number(inst.multiplier ?? root.multiplier ?? 1),
    currency: root.paymentCurrency ?? inst.paymentCurrency ?? 'USD',
    symbols,
    initialSpots,
    asOf,
    finalFixing,
    koStart: Number.isFinite(Number(koSerial)) ? isoFromSerial(koSerial) : asOf,
    strike: Number(root.strike ?? root.knockInStar?.strikeKI2 ?? kiko.maturBarrier),
    knockIn: Number(root.knockInStar?.KIBarrier ?? kiko.maturBarrier),
    knockOut: root.RGACCLKO?.gblBarPrice != null ? Number(root.RGACCLKO.gblBarPrice) : null,
    coupon: null, // ELIFCN_KI here has accruRate/fixCoupon 0 — a pure put leg
  }
}

// ---------------------------------------------------------------------------
// Surface model — one shape for both sources, then the shared grid/ATM reads
// ---------------------------------------------------------------------------

export interface Surface {
  maturities: any[]
  strikes: number[]
  volatility: number[][]
  reference: number
  strikeType: unknown
}

export interface Grid {
  maturities_years: number[]
  strikes: number[]
  vols: number[][]
}

/** `{ maturities, strikes, volatility (fractions), reference, strikeType }`. */
export function normaliseSurface(raw: any): Surface {
  if (raw?.maturities) {
    return {
      maturities: raw.maturities,
      strikes: raw.strikes.map(Number),
      volatility: raw.volatility,
      reference: Number(raw.reference),
      strikeType: raw.strike_type,
    }
  }
  // Murex eqVol: `maturity` / `strike` / `vol` (percent points) / `Reference`.
  return {
    maturities: (raw.maturity ?? []).map(Number),
    strikes: (raw.strike ?? []).map(Number),
    volatility: (raw.vol ?? []).map((row: any[]) => row.map((v) => Number(v) / 100)),
    reference: Number(raw.Reference),
    strikeType: raw.strike_type,
  }
}

/** Mirrors `surfaceToImpliedVolGrid` (src/features/tac/mapping.ts). */
export function surfaceToGrid(surface: Surface | null | undefined, asOf: string): Grid | null {
  if (!surface || surface.strikes.length === 0 || surface.maturities.length === 0) return null
  const relative = surface.strikeType === 'relative' && Number.isFinite(surface.reference)
  const columns = surface.strikes
    .map((strike, index) => ({ strike: relative ? strike * surface.reference : strike, index }))
    .filter((entry) => Number.isFinite(entry.strike) && entry.strike > 0)
    .sort((a, b) => a.strike - b.strike)
  const ordered: Array<{ strike: number; index: number }> = []
  for (const entry of columns) {
    const last = ordered[ordered.length - 1]
    if (last && entry.strike <= last.strike + AXIS_EPSILON) continue
    ordered.push(entry)
  }
  if (ordered.length === 0) return null

  const rows: Array<{ years: number; vols: number[] }> = []
  for (let r = 0; r < Math.min(surface.volatility.length, surface.maturities.length); r++) {
    const years = yearsFrom(surface.maturities[r], asOf)
    const vols = surface.volatility[r]
    if (!Number.isFinite(years) || years <= 0 || !vols || vols.length !== surface.strikes.length)
      continue
    rows.push({ years, vols })
  }
  rows.sort((a, b) => a.years - b.years)
  const kept: Array<{ years: number; vols: number[] }> = []
  for (const row of rows) {
    const last = kept[kept.length - 1]
    if (last && row.years <= last.years + AXIS_EPSILON) continue
    kept.push(row)
  }
  if (kept.length === 0) return null
  return {
    maturities_years: kept.map((row) => row.years),
    strikes: ordered.map((entry) => entry.strike),
    vols: kept.map((row) => ordered.map((entry) => row.vols[entry.index])),
  }
}

/** ATM read at the maturity nearest `targetYears`, struck nearest the reference. */
export function atmVol(
  surface: Surface | null | undefined,
  asOf: string,
  targetYears: number,
): number | null {
  if (!surface || surface.volatility.length === 0) return null
  let ci = 0
  let best = Infinity
  surface.strikes.forEach((strike, index) => {
    const distance = Math.abs(strike - surface.reference)
    if (distance < best) {
      best = distance
      ci = index
    }
  })
  let ri = 0
  let bestYears = Infinity
  surface.maturities.forEach((maturity, index) => {
    const distance = Math.abs(yearsFrom(maturity, asOf) - targetYears)
    if (distance < bestYears) {
      bestYears = distance
      ri = index
    }
  })
  const value = surface.volatility[ri]?.[ci]
  return Number.isFinite(value) ? value : null
}

// ---------------------------------------------------------------------------
// Market from the instrument's own `marketData` block (Murex)
// ---------------------------------------------------------------------------

export function fileMarketBlock(doc: any): any {
  return (
    doc?.Chunk?.Jobs?.[0]?.commonData?.marketData ??
    doc?.commonData?.marketData ??
    doc?.marketData ??
    null
  )
}

export interface FileMarket {
  provenance: string
  asOf: string
  spots: number[]
  vols: number[]
  correlation: number[][]
  riskFreeRate: number
  dividendYields: number[]
  grids: Array<Grid | null>
  notes: string[]
}

export function marketFromFile(doc: any, deal: Deal): FileMarket | null {
  const md = fileMarketBlock(doc)
  if (!md) return null
  const asOf = Number.isFinite(Number(md.evaluationDate))
    ? isoFromSerial(md.evaluationDate)
    : deal.asOf
  const finalSerial = serialFromIso(deal.finalFixing)
  const asOfSerial = serialFromIso(asOf)
  const maturityYears =
    (Date.parse(deal.finalFixing) - Date.parse(asOf)) / (MS_PER_DAY * DAYS_PER_YEAR)

  const equity: Map<string, any> = new Map(
    (md.equity ?? []).map((entry: any): [string, any] => [stripMarket(entry._id), entry]),
  )
  const surfaces: Map<string, Surface> = new Map(
    (md.eqVol ?? []).map(
      (entry: any): [string, Surface] => [stripMarket(entry._id), normaliseSurface(entry)],
    ),
  )

  const missing: string[] = []
  const spots = deal.symbols.map((symbol, index) => {
    const entry: any = equity.get(symbol)
    if (!entry) {
      missing.push(`${symbol}: no equity mark; used the initial fixing`)
      return deal.initialSpots[index]
    }
    return Number(entry.spot)
  })
  const dividendYields = deal.symbols.map((symbol, index) => {
    const entry: any = equity.get(symbol)
    const spot = spots[index]
    if (!entry || !(spot > 0)) return 0
    const total = (entry.dividend ?? [])
      .filter((row: any) => Number(row.exDate) > asOfSerial && Number(row.exDate) <= finalSerial)
      .reduce((sum: number, row: any) => sum + Number(row.div ?? 0), 0)
    return total / spot
  })

  const curve = md.discCurves?.[0] ?? md.estCurves?.[0]
  const riskFreeRate = rateFromCurve(curve, asOf, maturityYears) ?? 0.04

  const rho = md.corr?.[0]?.correlation?.[0]?.correlation
  const correlation = Number.isFinite(Number(rho))
    ? [
        [1, Number(rho)],
        [Number(rho), 1],
      ]
    : [
        [1, 0.4],
        [0.4, 1],
      ]

  const grids = deal.symbols.map((symbol) => {
    const surface = surfaces.get(symbol)
    if (!surface) {
      missing.push(`${symbol}: no eqVol surface`)
      return null
    }
    return surfaceToGrid(surface, asOf)
  })
  const vols = deal.symbols.map((symbol) => {
    const surface = surfaces.get(symbol)
    return (surface && atmVol(surface, asOf, maturityYears)) ?? 0.2
  })

  return {
    provenance: `file (1.json marketData, eval ${asOf})`,
    asOf,
    spots,
    vols,
    correlation,
    riskFreeRate,
    dividendYields,
    grids,
    notes: missing.length ? missing.map((note) => `marketData: ${note}`) : [],
  }
}

export function rateFromCurve(curve: any, asOf: string, targetYears: number): number | null {
  const pillars = (curve?.curve ?? [])
    .map((point: any) => ({ years: yearsFrom(Number(point.date), asOf), rate: Number(point.rate) }))
    .filter((point: { years: number; rate: number }) => Number.isFinite(point.years) && Number.isFinite(point.rate))
    .sort((a: { years: number }, b: { years: number }) => a.years - b.years)
  if (pillars.length === 0) return null
  if (targetYears <= pillars[0].years) return pillars[0].rate
  for (let i = 1; i < pillars.length; i++) {
    if (targetYears <= pillars[i].years) {
      const a = pillars[i - 1]
      const b = pillars[i]
      const w = (targetYears - a.years) / (b.years - a.years)
      return a.rate + w * (b.rate - a.rate)
    }
  }
  return pillars[pillars.length - 1].rate
}

export function rateFromPillars(
  pillars: Array<{ years: number; rate: number }>,
  targetYears: number,
): number {
  const sorted = [...pillars].sort((a, b) => a.years - b.years)
  if (sorted.length === 0) return 0.04
  if (targetYears <= sorted[0].years) return sorted[0].rate
  for (let i = 1; i < sorted.length; i++) {
    if (targetYears <= sorted[i].years) {
      const a = sorted[i - 1]
      const b = sorted[i]
      const w = (targetYears - a.years) / (b.years - a.years)
      return a.rate + w * (b.rate - a.rate)
    }
  }
  return sorted[sorted.length - 1].rate
}

export function pearson(symbols: string[], bars: any): number[][] | null {
  const closes = (symbol: string) => (bars?.bars?.[symbol] ?? []).map((bar: any) => Number(bar.c))
  const a = closes(symbols[0])
  const b = closes(symbols[1])
  const n = Math.min(a.length, b.length)
  if (n < 3) return null
  const ra: number[] = []
  const rb: number[] = []
  for (let i = 1; i < n; i++) {
    if (a[i - 1] > 0 && b[i - 1] > 0) {
      ra.push(Math.log(a[i] / a[i - 1]))
      rb.push(Math.log(b[i] / b[i - 1]))
    }
  }
  const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length
  const ma = mean(ra)
  const mb = mean(rb)
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < ra.length; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb)
    va += (ra[i] - ma) ** 2
    vb += (rb[i] - mb) ** 2
  }
  const rho = cov / Math.sqrt(va * vb)
  return Number.isFinite(rho)
    ? [
        [1, rho],
        [rho, 1],
      ]
    : null
}
