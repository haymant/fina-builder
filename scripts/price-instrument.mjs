#!/usr/bin/env node
// Price a structured-product leg from its trading-system JSON with the two
// live engines:
//
//   tac-engine  → market data (spots, vol surface, correlation, rate, divs)
//   riga-mcp    → price_trade (the worst-of down-and-in put leg)
//
//   node scripts/price-instrument.mjs <instrument.json> [--market auto|file|lake]
//                                      [--paths N] [--lane both|flat|local] [--json]
//
// `--market auto` (default) uses the instrument's own `marketData` block when
// present (Murex `commonData.marketData`: equity spots + dividends, corr,
// eqVol grid, disc curve, evaluationDate) and only falls back to `tac-engine`
// (`--market lake`) when it is not.
//
// The engines resolve the same way as the app: the `RIGA_MCP_BIN` /
// `TAC_ENGINE_BIN` overrides, else the submodule default relative path
// (`modules/<dir>/target/release/<bin>`).
//
// The surface→grid conversion mirrors `src/features/tac/mapping.ts`
// (`surfaceToImpliedVolGrid`): maturities are Excel serials (or ISO dates)
// converted to years anchored at the valuation date, strikes are made absolute
// against the calibration reference, and both axes are sorted/de-duplicated.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createStdioClient } from './lib/mcpStdio.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
const MS_PER_DAY = 86_400_000
const DAYS_PER_YEAR = 365
const AXIS_EPSILON = 1e-9

const isoFromSerial = (serial) =>
  new Date(EXCEL_EPOCH_MS + Number(serial) * MS_PER_DAY).toISOString().slice(0, 10)
const serialFromIso = (iso) => Math.round((Date.parse(iso) - EXCEL_EPOCH_MS) / MS_PER_DAY)
const isDate = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value))
const stripMarket = (name) => String(name ?? '').trim().replace(/\s+[A-Z]{2}$/, '').toUpperCase()
const yearsFrom = (maturity, asOf) => {
  const ms = typeof maturity === 'number' ? EXCEL_EPOCH_MS + maturity * MS_PER_DAY : Date.parse(maturity)
  return Number.isNaN(ms) ? NaN : (ms - Date.parse(asOf)) / (MS_PER_DAY * DAYS_PER_YEAR)
}

function businessDays(fromIso, toIso) {
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

function decodeDeal(doc) {
  // The instrument block sits under Chunk.Jobs[0].commonData.dealData; tolerate
  // the bare form used by earlier extracts.
  const root = doc?.Chunk?.Jobs?.[0]?.commonData?.dealData ?? doc
  const inst = root.instrument ?? root
  const kiko = root.KIKOSelect ?? {}
  const underlyings = inst.underlyings ?? []
  const symbols = (kiko.underlyingName ?? underlyings.map((u) => u.name)).map(stripMarket)
  // `initspot` is the initial spot / reference price, **not** a current mark;
  // the current mark only exists in `marketData.equity`.
  const initialSpots = (kiko.referencePrice ?? underlyings.map((u) => u.initspot ?? u.spot)).map(Number)
  const asOf = isDate(root.extractedSystemDate)
    ? root.extractedSystemDate
    : isDate(inst.initialFixingDate)
      ? inst.initialFixingDate
      : isoFromSerial(root.expiryDate)
  const finalFixing = isDate(inst.finalFixingDate) ? inst.finalFixingDate : isoFromSerial(root.expiryDate)
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

/** `{ maturities, strikes, volatility (fractions), reference, strikeType }`. */
function normaliseSurface(raw) {
  if (raw?.maturities) {
    return { maturities: raw.maturities, strikes: raw.strikes.map(Number), volatility: raw.volatility, reference: Number(raw.reference), strikeType: raw.strike_type }
  }
  // Murex eqVol: `maturity` / `strike` / `vol` (percent points) / `Reference`.
  return {
    maturities: (raw.maturity ?? []).map(Number),
    strikes: (raw.strike ?? []).map(Number),
    volatility: (raw.vol ?? []).map((row) => row.map((v) => Number(v) / 100)),
    reference: Number(raw.Reference),
    strikeType: raw.strike_type,
  }
}

/** Mirrors `surfaceToImpliedVolGrid` (src/features/tac/mapping.ts). */
function surfaceToGrid(surface, asOf) {
  if (!surface || surface.strikes.length === 0 || surface.maturities.length === 0) return null
  const relative = surface.strikeType === 'relative' && Number.isFinite(surface.reference)
  const columns = surface.strikes
    .map((strike, index) => ({ strike: relative ? strike * surface.reference : strike, index }))
    .filter((entry) => Number.isFinite(entry.strike) && entry.strike > 0)
    .sort((a, b) => a.strike - b.strike)
  const ordered = []
  for (const entry of columns) {
    const last = ordered[ordered.length - 1]
    if (last && entry.strike <= last.strike + AXIS_EPSILON) continue
    ordered.push(entry)
  }
  if (ordered.length === 0) return null

  const rows = []
  for (let r = 0; r < Math.min(surface.volatility.length, surface.maturities.length); r++) {
    const years = yearsFrom(surface.maturities[r], asOf)
    const vols = surface.volatility[r]
    if (!Number.isFinite(years) || years <= 0 || !vols || vols.length !== surface.strikes.length) continue
    rows.push({ years, vols })
  }
  rows.sort((a, b) => a.years - b.years)
  const kept = []
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
function atmVol(surface, asOf, targetYears) {
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

function fileMarketBlock(doc) {
  return (
    doc?.Chunk?.Jobs?.[0]?.commonData?.marketData ??
    doc?.commonData?.marketData ??
    doc?.marketData ??
    null
  )
}

function marketFromFile(doc, deal) {
  const md = fileMarketBlock(doc)
  if (!md) return null
  const asOf = Number.isFinite(Number(md.evaluationDate)) ? isoFromSerial(md.evaluationDate) : deal.asOf
  const finalSerial = serialFromIso(deal.finalFixing)
  const asOfSerial = serialFromIso(asOf)
  const maturityYears = (Date.parse(deal.finalFixing) - Date.parse(asOf)) / (MS_PER_DAY * DAYS_PER_YEAR)

  const equity = new Map((md.equity ?? []).map((entry) => [stripMarket(entry._id), entry]))
  const surfaces = new Map((md.eqVol ?? []).map((entry) => [stripMarket(entry._id), normaliseSurface(entry)]))

  const missing = []
  const spots = deal.symbols.map((symbol, index) => {
    const entry = equity.get(symbol)
    if (!entry) {
      missing.push(`${symbol}: no equity mark; used the initial fixing`)
      return deal.initialSpots[index]
    }
    return Number(entry.spot)
  })
  const dividendYields = deal.symbols.map((symbol, index) => {
    const entry = equity.get(symbol)
    const spot = spots[index]
    if (!entry || !(spot > 0)) return 0
    const total = (entry.dividend ?? [])
      .filter((row) => Number(row.exDate) > asOfSerial && Number(row.exDate) <= finalSerial)
      .reduce((sum, row) => sum + Number(row.div ?? 0), 0)
    return total / spot
  })

  const curve = md.discCurves?.[0] ?? md.estCurves?.[0]
  const riskFreeRate = rateFromCurve(curve, asOf, maturityYears) ?? 0.04

  const rho = md.corr?.[0]?.correlation?.[0]?.correlation
  const correlation = Number.isFinite(Number(rho))
    ? [[1, Number(rho)], [Number(rho), 1]]
    : [[1, 0.4], [0.4, 1]]

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

function rateFromCurve(curve, asOf, targetYears) {
  const pillars = (curve?.curve ?? [])
    .map((point) => ({ years: yearsFrom(Number(point.date), asOf), rate: Number(point.rate) }))
    .filter((point) => Number.isFinite(point.years) && Number.isFinite(point.rate))
    .sort((a, b) => a.years - b.years)
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

// ---------------------------------------------------------------------------
// Market from tac-engine (the lake lane)
// ---------------------------------------------------------------------------

async function tool(client, name, args = {}) {
  const reply = await client.request('tools/call', { name, arguments: args }, 120000)
  if (reply.isError) throw new Error(`${name}: ${JSON.stringify(reply.structuredContent ?? reply.content).slice(0, 200)}`)
  return reply.structuredContent ?? (reply.content?.[0]?.text ? JSON.parse(reply.content[0].text) : reply.content)
}

async function marketFromLake(tac, deal) {
  const notes = []
  const symbols = deal.symbols
  const join = symbols.join(',')
  const asOf = deal.asOf
  const maturityYears = (Date.parse(deal.finalFixing) - Date.parse(asOf)) / (MS_PER_DAY * DAYS_PER_YEAR)

  const spots = deal.symbols.map(() => Number.NaN)
  for (let i = 0; i < symbols.length; i++) {
    try {
      const snap = await tool(tac, 'get_stock_snapshot', { symbol: symbols[i] })
      const price = snap?.latestTrade?.p ?? snap?.dailyBar?.c
      if (Number.isFinite(price)) spots[i] = price
      else notes.push(`${symbols[i]} snapshot carried no price`)
    } catch (error) {
      notes.push(`${symbols[i]} snapshot unavailable: ${error.message}`)
    }
  }
  for (let i = 0; i < symbols.length; i++) {
    if (!Number.isFinite(spots[i])) {
      spots[i] = deal.initialSpots[i]
      notes.push(`${symbols[i]}: no current spot — priced at the initial fixing ${spots[i]}`)
    }
  }

  let correlation = null
  try {
    const cm = await tool(tac, 'corr_matrix', { legs: join, window_days: 252 })
    if (cm?.matrix?.length === 2) correlation = cm.matrix
  } catch {
    try {
      await tool(tac, 'get_lake_bars', { symbols: join, timeframe: '1d', lazy: true }).catch(() => {})
      const bars = await tool(tac, 'get_lake_bars', { symbols: join, timeframe: '1d' })
      correlation = pearson(symbols, bars)
      if (correlation) notes.push('correlation from lake returns (corr_matrix had too little history)')
    } catch (error) {
      notes.push(`correlation unavailable (${error.message}); defaulted to 0.4`)
    }
  }
  if (!correlation) correlation = [[1, 0.4], [0.4, 1]]

  const riskFreeRate = await lakeRate(tac, maturityYears, notes)
  const dividendYields = [0, 0]

  const surfaces = {}
  const dealExpiry = serialFromIso(deal.finalFixing)
  for (const symbol of symbols) {
    try {
      surfaces[symbol] = normaliseSurface(await tool(tac, 'vol_surface', { underlying: symbol, deal_expiry: dealExpiry }))
    } catch (error) {
      notes.push(`${symbol} vol surface unavailable: ${error.message}`)
    }
  }
  const grids = symbols.map((symbol) => surfaceToGrid(surfaces[symbol], asOf))
  const vols = symbols.map((symbol) => (surfaces[symbol] && atmVol(surfaces[symbol], asOf, maturityYears)) ?? 0.2)

  return { provenance: 'tac-engine (lake)', asOf, spots, vols, correlation, riskFreeRate, dividendYields, grids, notes }
}

async function lakeRate(tac, maturityYears, notes) {
  try {
    const macro = await tool(tac, 'get_macro_bars', { symbols: 'FRED_DGS3MO,FRED_DGS6MO,FRED_DGS1' })
    const tenors = { FRED_DGS3MO: 0.25, FRED_DGS6MO: 0.5, FRED_DGS1: 1.0 }
    return rateFromPillars(
      Object.entries(tenors)
        .map(([symbol, years]) => {
          const series = macro?.bars?.[symbol] ?? []
          const last = series[series.length - 1]
          return last ? { years, rate: Number(last.c) / 100 } : null
        })
        .filter(Boolean),
      maturityYears,
    )
  } catch (error) {
    notes.push(`rate unavailable (${error.message}); defaulted to 4%`)
    return 0.04
  }
}

function rateFromPillars(pillars, targetYears) {
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

function pearson(symbols, bars) {
  const closes = (symbol) => (bars?.bars?.[symbol] ?? []).map((bar) => Number(bar.c))
  const a = closes(symbols[0])
  const b = closes(symbols[1])
  const n = Math.min(a.length, b.length)
  if (n < 3) return null
  const ra = []
  const rb = []
  for (let i = 1; i < n; i++) {
    if (a[i - 1] > 0 && b[i - 1] > 0) {
      ra.push(Math.log(a[i] / a[i - 1]))
      rb.push(Math.log(b[i] / b[i - 1]))
    }
  }
  const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length
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
  return Number.isFinite(rho) ? [[1, rho], [rho, 1]] : null
}

// ---------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------

async function priceLane(riga, deal, market, lane) {
  const maturityYears = (Date.parse(deal.finalFixing) - Date.parse(market.asOf)) / (MS_PER_DAY * DAYS_PER_YEAR)
  const steps = Math.min(Math.max(businessDays(market.asOf, deal.finalFixing), 1), 500)
  const callStartStep = Math.min(businessDays(market.asOf, deal.koStart), steps)
  const request = {
    trade: {
      trade_id: `${deal.name}_${deal.leg}`,
      initial_spots: deal.initialSpots,
      maturity_years: maturityYears,
      steps,
      strike: deal.strike,
      knock_in_barrier: deal.knockIn,
      knock_out_barrier: deal.knockOut,
      coupon_barrier: null,
      coupon_rate: null,
      memory_coupon: false,
      coupon_periods: null,
      fixed_first_coupon: false,
      call_start_step: callStartStep,
    },
    market: {
      as_of: market.asOf,
      spots: market.spots,
      vols: market.vols,
      risk_free_rate: market.riskFreeRate,
      dividend_yields: market.dividendYields,
      correlation: market.correlation,
    },
    config: { paths: market.paths, path_block_size: 8192, seed: 1729, trace_level: 'off', variance_reduction: { kind: 'none' } },
    as_of: market.asOf,
  }
  if (lane === 'local') request.local_vol = { grids: market.grids }
  const reply = await tool(riga, 'price_trade', { request })
  return reply.result ?? reply
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    market: { type: 'string', default: 'auto' },
    paths: { type: 'string', default: '200000' },
    lane: { type: 'string', default: 'both' },
    json: { type: 'boolean', default: false },
  },
})

const inputPath = positionals[0]
if (!inputPath) {
  console.error('usage: node scripts/price-instrument.mjs <instrument.json> [--market auto|file|lake] [--paths N] [--lane both|flat|local] [--json]')
  process.exit(2)
}

const doc = JSON.parse(readFileSync(resolve(process.cwd(), inputPath), 'utf8'))
const deal = decodeDeal(doc)
if (deal.symbols.length !== 2) {
  console.error(`riga-flow is 2-factor; this instrument has ${deal.symbols.length} underlyings`)
  process.exit(2)
}

const useFile = values.market === 'file' || (values.market === 'auto' && fileMarketBlock(doc) != null)
const rigaBin = process.env.RIGA_MCP_BIN ?? resolve(ROOT, 'modules/riga-flow/target/release/riga-mcp')
const tacBin = process.env.TAC_ENGINE_BIN ?? resolve(ROOT, 'modules/tac-engine/target/release/tac-engine')

let tac = null
const riga = createStdioClient(rigaBin, ['--transport', 'stdio'])
try {
  await riga.initialize()
  let market
  if (useFile) {
    market = marketFromFile(doc, deal)
    if (!market) {
      console.error(`--market ${values.market}: no marketData block in ${inputPath}`)
      process.exit(2)
    }
  } else {
    tac = createStdioClient(tacBin, [], { cwd: resolve(ROOT, 'modules/tac-engine') })
    await tac.initialize()
    market = await marketFromLake(tac, deal)
  }
  market.paths = Math.max(1, Number(values.paths) || 200000)

  const wantFlat = values.lane === 'both' || values.lane === 'flat'
  const wantLocal = (values.lane === 'both' || values.lane === 'local') && market.grids.every(Boolean)
  const lanes = []
  if (wantFlat) lanes.push(['flat GBM', await priceLane(riga, deal, market, 'flat')])
  if (wantLocal) lanes.push(['Dupire surface', await priceLane(riga, deal, market, 'local')])

  const maturityYears = (Date.parse(deal.finalFixing) - Date.parse(market.asOf)) / (MS_PER_DAY * DAYS_PER_YEAR)
  if (values.json) {
    console.log(JSON.stringify({
      instrument: deal,
      market: { provenance: market.provenance, asOf: market.asOf, spots: market.spots, vols: market.vols, correlation: market.correlation, riskFreeRate: market.riskFreeRate, dividendYields: market.dividendYields, gridShapes: market.grids.map((g) => (g ? [g.maturities_years.length, g.strikes.length] : null)), notes: market.notes },
      lanes: Object.fromEntries(lanes.map(([label, result]) => [label, { pv: result.pv, put: result.legs?.down_and_in_put, legs: result.legs }])),
    }, null, 2))
  } else {
    const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(3)}%` : '—')
    console.log(`${deal.name}  (${deal.template}, leg ${deal.leg}, multiplier ${deal.multiplier})`)
    console.log(`notional ${deal.notional} ${deal.currency}   as_of ${market.asOf}   maturity ${maturityYears.toFixed(6)}y   market ${market.provenance}`)
    console.log(`strike ${deal.strike}   knock-in ${deal.knockIn}   knock-out ${deal.knockOut ?? '—'}`)
    console.log('')
    deal.symbols.forEach((symbol, i) => {
      console.log(`  ${symbol.padEnd(6)} init ${deal.initialSpots[i]} → spot ${market.spots[i]}   vol ${pct(market.vols[i])}   div ${pct(market.dividendYields[i])}   grid ${market.grids[i] ? `${market.grids[i].maturities_years.length}×${market.grids[i].strikes.length}` : '—'}`)
    })
    console.log(`  correlation ${market.correlation[0][1].toFixed(5)}   rate ${pct(market.riskFreeRate)}   paths ${market.paths}`)
    market.notes.forEach((note) => console.log(`  note: ${note}`))
    console.log('')
    console.log('lane             PV          put leg     signed value (× notional)')
    for (const [label, result] of lanes) {
      const put = result.legs?.down_and_in_put ?? 0
      console.log(
        `${label.padEnd(15)} ${result.pv.toFixed(6)}   ${put.toFixed(6)}   ${(put * deal.notional * deal.multiplier).toFixed(2)} ${deal.currency}`,
      )
    }
  }
} finally {
  tac?.close()
  riga.close()
}
