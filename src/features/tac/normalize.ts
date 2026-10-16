// tac-engine response normalisers.
//
// The live engine returns nested, sometimes loosely-typed payloads (Alpaca
// snapshots, `{bars: {SYMBOL: [...]}}`, `{features: [...]}` rows). These pure
// helpers map them onto the shapes the market-data tiles read. They are total:
// a payload the engine changes underneath us degrades to empty, never a throw.

import type {
  TacBar,
  TacBarsResponse,
  TacCorporateAction,
  TacCorrMatrix,
  TacCoverageRow,
  TacCurve,
  TacFxRate,
  TacFxVolRow,
  TacLakeSource,
  TacSnapshot,
  TacSpSeries,
  TacTaSeries,
  TacVolSurface,
} from './types'

type Json = Record<string, unknown>

function asObject(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asNumber(value: unknown, fallback = NaN): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

const FRED_TENOR: Record<string, string> = {
  FRED_DGS3MO: '3M',
  FRED_DGS6MO: '6M',
  FRED_DGS1: '1Y',
  FRED_DGS2: '2Y',
  FRED_DGS3: '3Y',
  FRED_DGS5: '5Y',
  FRED_DGS7: '7Y',
  FRED_DGS10: '10Y',
  FRED_DGS20: '20Y',
  FRED_DGS30: '30Y',
}

/** `get_lake_bars` → one entry per requested symbol. */
export function toBars(payload: unknown): Record<string, TacBarsResponse> {
  const root = asObject(payload)
  const bars = asObject(root.bars)
  const source = asObject(root.source)
  const out: Record<string, TacBarsResponse> = {}
  for (const [symbol, rows] of Object.entries(bars)) {
    const list = asArray(rows).map((row) => {
      const bar = asObject(row)
      return {
        t: asString(bar.t ?? bar.date),
        o: asNumber(bar.o),
        h: asNumber(bar.h),
        l: asNumber(bar.l),
        c: asNumber(bar.c),
        v: asNumber(bar.v, 0),
      } satisfies TacBar
    })
    out[symbol] = {
      symbol,
      source: (asString(source[symbol], 'lake') as TacLakeSource) || 'lake',
      bars: list,
      summary: list.length ? { count: list.length, start: list[0]!.t, end: list[list.length - 1]!.t } : undefined,
    }
  }
  // A single-symbol response that was not keyed.
  if (Object.keys(out).length === 0 && Array.isArray(payload)) {
    out.symbol = { source: 'fetched', bars: asArray(payload) as TacBar[] }
  }
  return out
}

/** `get_stock_snapshot` — Alpaca snapshot → `{symbol, price, asOf}`. */
export function toSnapshot(symbol: string, payload: unknown): TacSnapshot {
  const root = asObject(payload)
  const trade = asObject(root.latestTrade)
  const daily = asObject(root.dailyBar)
  const quote = asObject(root.latestQuote)
  const price = asNumber(trade.p, asNumber(daily.c, asNumber(quote.ap)))
  return { symbol, price, asOf: asString(trade.t ?? daily.t ?? quote.t) }
}

/** `corr_matrix` → `{legs, matrix, pairs[]}` (pairs arrive as `{rows:[...]}`). */
export function toCorrelations(payload: unknown): TacCorrMatrix | undefined {
  const root = asObject(payload)
  const legs = asArray(root.legs).map((leg) => asString(leg))
  const matrix = asArray(root.matrix).map((row) => asArray(row).map((value) => asNumber(value)))
  if (legs.length === 0 || matrix.length === 0) return undefined
  const pairContainer = asObject(root.pairs)
  const rows = asArray(pairContainer.rows ?? root.pairs).map((row) => {
    const pair = asObject(row)
    return {
      legA: asString(pair.leg_a ?? pair.legA),
      legB: asString(pair.leg_b ?? pair.legB),
      rho0: asNumber(pair.rho0),
      rho: asNumber(pair.rho),
    }
  })
  return { legs, matrix, pairs: rows }
}

/** `vol_surface` → the `TacVolSurface` grid (already camelisable). */
export function toVolSurface(payload: unknown): TacVolSurface | undefined {
  const root = asObject(payload)
  const underlying = asString(root.underlying)
  const strikes = asArray(root.strikes ?? root.grid_strikes).map((s) => asNumber(s))
  const maturities = asArray(root.maturities).map((m) => (typeof m === 'number' ? m : asString(m)))
  const volatility = asArray(root.volatility ?? root.grid).map((row) => asArray(row).map((v) => asNumber(v)))
  if (!underlying || strikes.length === 0 || volatility.length === 0) return undefined
  return {
    underlying,
    strikeType: asString(root.strike_type, 'absolute'),
    reference: asNumber(root.reference, strikes[Math.floor(strikes.length / 2)]!),
    maturities,
    strikes,
    volatility,
    model: asString(root.model),
    calibratedAt: asString(root.calibrated_at),
    source: asString(root.source, 'lake'),
    stale: root.stale === true,
    arbitrage: Array.isArray(root.arbitrage) ? root.arbitrage.map((note) => String(note)) : undefined,
  }
}

/** `get_macro_bars` (FRED tenors) → a discount curve with pillars. */
export function toCurve(payload: unknown, currency = 'USD'): TacCurve | undefined {
  const root = asObject(payload)
  const bars = asObject(root.bars)
  const pillars: TacCurve['pillars'] = []
  for (const [symbol, rows] of Object.entries(bars)) {
    const list = asArray(rows)
    const last = asObject(list[list.length - 1])
    const rate = asNumber(last.c)
    if (!Number.isFinite(rate)) continue
    pillars.push({ date: asString(last.date ?? last.t), tenor: FRED_TENOR[symbol] ?? symbol.replace(/^FRED_/, ''), rate: rate / 100 })
  }
  if (pillars.length === 0) return undefined
  return { id: currency, dayCount: 'ACT/365', pillars }
}

/** `get_forex_latest_rates` → per-pair rates (mid). */
export function toFxRates(payload: unknown): TacFxRate[] {
  const root = asObject(payload)
  const rates = asObject(root.rates)
  return Object.entries(rates).map(([pair, value]) => {
    const rate = asObject(value)
    return {
      pair: pair.replace('/', ''),
      bid: asNumber(rate.bid),
      ask: asNumber(rate.ask),
      rate: asNumber(rate.mid, asNumber(rate.bid)),
      asOf: asString(rate.timestamp),
    }
  })
}

/** `get_lake_fx_vol` realized vol → rows per pair/window. */
export function toFxVol(payload: unknown): TacFxVolRow[] {
  const root = asObject(payload)
  const features = asArray(root.features)
  const rows: TacFxVolRow[] = []
  for (const feature of features) {
    const row = asObject(feature)
    const pair = asString(row.symbol)
    if (!pair) continue
    const rv20 = asNumber(row.rv20_ann)
    const rv60 = asNumber(row.rv60_ann)
    if (Number.isFinite(rv20)) rows.push({ pair, windowDays: 20, realizedVol: rv20, asOf: asString(row.t) })
    if (Number.isFinite(rv60)) rows.push({ pair, windowDays: 60, realizedVol: rv60, asOf: asString(row.t) })
  }
  return rows
}

/** `get_lake_coverage` → `{symbol, timeframe, start, end, rows}`. */
export function toCoverage(payload: unknown): TacCoverageRow[] {
  const root = asObject(payload)
  return asArray(root.coverage ?? payload).map((row) => {
    const entry = asObject(row)
    return {
      symbol: asString(entry.symbol),
      timeframe: asString(entry.timeframe),
      start: asString(entry.first_t ?? entry.start),
      end: asString(entry.last_t ?? entry.end),
      rows: asNumber(entry.num_bars ?? entry.rows, 0),
    }
  })
}

function featuresToSeries(payload: unknown, key: 'indicators' | 'features'): Record<string, unknown> | undefined {
  const root = asObject(payload)
  const features = asArray(root.features)
  if (features.length === 0) return undefined
  const rows = features.map((feature) => asObject(feature))
  if (key === 'indicators') {
    const indicators: Record<string, Array<number | null>> = {}
    for (const column of Object.keys(rows[0]!)) {
      if (column === 'market' || column === 'symbol' || column === 'timeframe' || column === 't') continue
      const series = rows.map((row) => (typeof row[column] === 'number' ? (row[column] as number) : null))
      if (series.some((value) => value !== null)) indicators[column] = series
    }
    return indicators
  }
  return { ...rows[rows.length - 1] }
}

export function toTaSeries(symbol: string, payload: unknown): TacTaSeries | undefined {
  const indicators = featuresToSeries(payload, 'indicators')
  if (!indicators) return undefined
  return { symbol, indicators: indicators as TacTaSeries['indicators'] }
}

export function toSpSeries(symbol: string, payload: unknown): TacSpSeries | undefined {
  const features = featuresToSeries(payload, 'features')
  if (!features) return undefined
  const numeric: Record<string, number> = {}
  for (const [key, value] of Object.entries(features)) {
    if (typeof value === 'number') numeric[key] = value
  }
  return { symbol, features: numeric }
}

/** `get_lake_fx` → bar series per pair (reuses the bars normaliser). */
export function toFxBars(payload: unknown): Record<string, TacBarsResponse> {
  return toBars(payload)
}

/** `get_corporate_actions` → dividend/split rows. */
export function toCorporateActions(payload: unknown): TacCorporateAction[] {
  const root = asObject(payload)
  const rows = asArray(root.corporate_actions ?? root.actions ?? root.data ?? payload)
  return rows.map((row) => {
    const entry = asObject(row)
    return {
      symbol: asString(entry.symbol ?? entry.ticker),
      type: asString(entry.type ?? entry.ca_type ?? entry.event_type, 'dividend').toLowerCase(),
      exDate: asString(entry.ex_date ?? entry.exDate),
      amount: asNumber(entry.amount ?? entry.rate, 0),
      currency: asString(entry.currency),
    }
  })
}
