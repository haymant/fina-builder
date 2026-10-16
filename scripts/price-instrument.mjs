#!/usr/bin/env node
// Price a structured-product leg from its trading-system JSON with the two
// live engines:
//
//   tac-engine  → market data (spots, vol surface, correlation, rate, divs)
//   riga-mcp    → price_trade (the worst-of down-and-in put leg)
//
//   node scripts/price-instrument.mjs <instrument.json> [--paths N] [--lane both|flat|local] [--json]
//
// The binariers resolve the same way as the app: the `RIGA_MCP_BIN` /
// `TAC_ENGINE_BIN` overrides, else the submodule default relative path
// (`modules/<dir>/target/release/<bin>`).
//
// The surface→grid conversion mirrors `src/features/tac/mapping.ts`
// (`surfaceToImpliedVolGrid`): maturities are Excel serials (or ISO dates)
// converted to years anchored at the valuation date, and strikes are made
// absolute against the calibration reference.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createStdioClient } from './lib/mcpStdio.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
const MS_PER_DAY = 86_400_000
const DAYS_PER_YEAR = 365

const isoFromSerial = (serial) =>
  new Date(EXCEL_EPOCH_MS + Number(serial) * MS_PER_DAY).toISOString().slice(0, 10)
const serialFromIso = (iso) => Math.round((Date.parse(iso) - EXCEL_EPOCH_MS) / MS_PER_DAY)
const isDate = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value))

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
  const inst = doc.instrument ?? doc
  const kiko = doc.KIKOSelect ?? {}
  const underlyings = inst.underlyings ?? []
  const symbols = (kiko.underlyingName ?? underlyings.map((u) => u.name)).map((name) =>
    String(name).replace(/\s+[A-Z]{2}$/, '').toUpperCase(),
  )
  const initialSpots = (kiko.referencePrice ?? underlyings.map((u) => u.spot)).map(Number)
  const quotedSpots = underlyings.map((u) => Number(u.spot))
  const asOf = isDate(doc.extractedSystemDate)
    ? doc.extractedSystemDate
    : isDate(inst.initialFixingDate)
      ? inst.initialFixingDate
      : isoFromSerial(doc.expiryDate)
  const finalFixing = isDate(inst.finalFixingDate)
    ? inst.finalFixingDate
    : isoFromSerial(doc.expiryDate)
  const koSerial = doc.globalKOStar?.obvDate?.[0] ?? doc.RGACCLKO?.endDate?.[0]
  const koStart = Number.isFinite(Number(koSerial)) ? isoFromSerial(koSerial) : asOf
  const steps = Math.min(Math.max(businessDays(asOf, finalFixing), 1), 500)
  const callStartStep = Math.min(businessDays(asOf, koStart), steps)

  return {
    name: doc.instrumentName ?? inst.name ?? 'instrument',
    template: doc.productTemplate ?? inst.classification?.productTemplate?.name ?? 'ELIFCN_KI',
    leg: doc.legName ?? inst.legName ?? 'PUT',
    notional: Number(inst.notional ?? doc.notional ?? 0),
    multiplier: Number(inst.multiplier ?? doc.multiplier ?? 1),
    currency: doc.paymentCurrency ?? inst.paymentCurrency ?? 'USD',
    symbols,
    initialSpots,
    quotedSpots,
    asOf,
    finalFixing,
    maturityYears: (Date.parse(finalFixing) - Date.parse(asOf)) / (MS_PER_DAY * DAYS_PER_YEAR),
    steps,
    callStartStep,
    strike: Number(doc.strike ?? doc.knockInStar?.strikeKI2 ?? kiko.maturBarrier),
    knockIn: Number(doc.knockInStar?.KIBarrier ?? kiko.maturBarrier),
    knockOut: doc.RGACCLKO?.gblBarPrice != null ? Number(doc.RGACCLKO.gblBarPrice) : null,
    coupon: null, // ELIFCN_KI here has accruRate/fixCoupon 0 — a pure put leg
  }
}

// ---------------------------------------------------------------------------
// tac-engine market fetch
// ---------------------------------------------------------------------------

async function tool(client, name, args = {}) {
  const reply = await client.request('tools/call', { name, arguments: args }, 120000)
  if (reply.isError) throw new Error(`${name}: ${JSON.stringify(reply.structuredContent ?? reply.content).slice(0, 200)}`)
  return reply.structuredContent ?? (reply.content?.[0]?.text ? JSON.parse(reply.content[0].text) : reply.content)
}

async function fetchMarket(tac, deal) {
  const notes = []
  const symbols = deal.symbols
  const join = symbols.join(',')

  // Spots: prefer the live snapshot, fall back to the instrument's mark.
  const spots = [...deal.quotedSpots]
  for (let i = 0; i < symbols.length; i++) {
    try {
      const snap = await tool(tac, 'get_stock_snapshot', { symbol: symbols[i] })
      const price = snap?.latestTrade?.p ?? snap?.dailyBar?.c
      if (Number.isFinite(price)) spots[i] = price
    } catch (error) {
      notes.push(`${symbols[i]} snapshot unavailable: ${error.message}`)
    }
  }

  // Correlation: the engine's matrix; else Pearson on lake returns.
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

  const riskFreeRate = await fetchRate(tac, deal, notes)

  // Dividends: sum the corporate-action feed as a continuous yield.
  const dividendYields = [0, 0]
  try {
    const ca = await tool(tac, 'get_corporate_actions', {
      symbols: join,
      types: 'dividend',
      start: deal.asOf,
      end: deal.finalFixing,
    })
    const rows = ca?.corporate_actions ?? ca?.actions ?? ca?.data ?? []
    for (let i = 0; i < symbols.length; i++) {
      const total = rows
        .filter((row) => String(row.symbol ?? row.ticker ?? '').toUpperCase() === symbols[i])
        .reduce((sum, row) => sum + Number(row.amount ?? row.rate ?? 0), 0)
      if (deal.initialSpots[i] > 0) dividendYields[i] = total / deal.initialSpots[i]
    }
  } catch (error) {
    notes.push(`dividends unavailable: ${error.message}`)
  }

  // Vol surfaces (calibrated around the deal expiry when supported).
  const volSurfaces = {}
  const dealExpiry = serialFromIso(deal.finalFixing)
  for (const symbol of symbols) {
    try {
      volSurfaces[symbol] = await tool(tac, 'vol_surface', { underlying: symbol, deal_expiry: dealExpiry })
    } catch (error) {
      notes.push(`${symbol} vol surface unavailable: ${error.message}`)
    }
  }

  return { spots, correlation, riskFreeRate, dividendYields, volSurfaces, notes }
}

async function fetchRate(tac, deal, notes) {
  try {
    const macro = await tool(tac, 'get_macro_bars', { symbols: 'FRED_DGS3MO,FRED_DGS6MO,FRED_DGS1' })
    const tenors = { FRED_DGS3MO: 0.25, FRED_DGS6MO: 0.5, FRED_DGS1: 1.0 }
    const pillars = Object.entries(tenors)
      .map(([symbol, years]) => {
        const series = macro?.bars?.[symbol] ?? []
        const last = series[series.length - 1]
        return last ? { years, rate: Number(last.c) / 100 } : null
      })
      .filter(Boolean)
      .sort((a, b) => a.years - b.years)
    if (pillars.length === 0) return 0.04
    const t = deal.maturityYears
    if (t <= pillars[0].years) return pillars[0].rate
    if (t >= pillars[pillars.length - 1].years) return pillars[pillars.length - 1].rate
    for (let i = 1; i < pillars.length; i++) {
      if (t <= pillars[i].years) {
        const a = pillars[i - 1]
        const b = pillars[i]
        const w = (t - a.years) / (b.years - a.years)
        return a.rate + w * (b.rate - a.rate)
      }
    }
    return pillars[0].rate
  } catch (error) {
    notes.push(`rate unavailable (${error.message}); defaulted to 4%`)
    return 0.04
  }
}

/** Pearson correlation of daily log-returns across 2 symbols. */
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
// Surface → Dupire grid (mirrors src/features/tac/mapping.ts)
// ---------------------------------------------------------------------------

function atmScalar(surface) {
  const front = surface?.volatility?.[0]
  if (!front?.length) return null
  const mid = front[Math.floor(front.length / 2)]
  return Number.isFinite(mid) ? mid : null
}

function surfaceToGrid(surface, asOf) {
  if (!surface?.strikes?.length || !surface?.maturities?.length) return null
  const relative = surface.strike_type === 'relative' && Number.isFinite(surface.reference)
  const rows = []
  for (let r = 0; r < Math.min(surface.volatility.length, surface.maturities.length); r++) {
    const m = surface.maturities[r]
    const ms = typeof m === 'number' ? EXCEL_EPOCH_MS + m * MS_PER_DAY : Date.parse(m)
    const years = (ms - Date.parse(asOf)) / (MS_PER_DAY * DAYS_PER_YEAR)
    const vols = surface.volatility[r]
    if (!Number.isFinite(years) || years <= 0 || !vols || vols.length !== surface.strikes.length) continue
    rows.push({ years, vols })
  }
  rows.sort((a, b) => a.years - b.years)
  const strikes = surface.strikes.map((k) => (relative ? k * surface.reference : k))
  const columns = surface.strikes.map((_, index) => index).sort((a, b) => strikes[a] - strikes[b])
  return {
    maturities_years: rows.map((row) => row.years),
    strikes: columns.map((index) => strikes[index]),
    vols: rows.map((row) => columns.map((index) => row.vols[index])),
  }
}

// ---------------------------------------------------------------------------
// Price
// ---------------------------------------------------------------------------

async function priceLane(riga, deal, market, lane) {
  const local = lane === 'local'
  const request = {
    trade: {
      trade_id: `${deal.name}_${deal.leg}`,
      initial_spots: deal.initialSpots,
      maturity_years: deal.maturityYears,
      steps: deal.steps,
      strike: deal.strike,
      knock_in_barrier: deal.knockIn,
      knock_out_barrier: deal.knockOut,
      coupon_barrier: null,
      coupon_rate: null,
      memory_coupon: false,
      coupon_periods: null,
      fixed_first_coupon: false,
      call_start_step: deal.callStartStep,
    },
    market: {
      as_of: deal.asOf,
      spots: market.spots,
      vols: market.vols,
      risk_free_rate: market.riskFreeRate,
      dividend_yields: market.dividendYields,
      correlation: market.correlation,
    },
    config: { paths: market.paths, path_block_size: 8192, seed: 1729, trace_level: 'off', variance_reduction: { kind: 'none' } },
    as_of: deal.asOf,
  }
  if (local) request.local_vol = { grids: market.grids }
  const reply = await tool(riga, 'price_trade', { request })
  return reply.result ?? reply
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    paths: { type: 'string', default: '200000' },
    lane: { type: 'string', default: 'both' },
    json: { type: 'boolean', default: false },
  },
})

const inputPath = positionals[0]
if (!inputPath) {
  console.error('usage: node scripts/price-instrument.mjs <instrument.json> [--paths N] [--lane both|flat|local] [--json]')
  process.exit(2)
}

const doc = JSON.parse(readFileSync(resolve(process.cwd(), inputPath), 'utf8'))
const deal = decodeDeal(doc)
if (deal.symbols.length !== 2) {
  console.error(`riga-flow is 2-factor; this instrument has ${deal.symbols.length} underlyings`)
  process.exit(2)
}

const rigaBin = process.env.RIGA_MCP_BIN ?? resolve(ROOT, 'modules/riga-flow/target/release/riga-mcp')
const tacBin = process.env.TAC_ENGINE_BIN ?? resolve(ROOT, 'modules/tac-engine/target/release/tac-engine')

const tac = createStdioClient(tacBin, [], { cwd: resolve(ROOT, 'modules/tac-engine') })
const riga = createStdioClient(rigaBin, ['--transport', 'stdio'])
try {
  await tac.initialize()
  await riga.initialize()

  const fetched = await fetchMarket(tac, deal)
  const grids = deal.symbols.map((symbol) => surfaceToGrid(fetched.volSurfaces[symbol], deal.asOf))
  const vols = deal.symbols.map((symbol) => atmScalar(fetched.volSurfaces[symbol]) ?? 0.2)
  const market = {
    ...fetched,
    vols,
    grids,
    paths: Math.max(1, Number(values.paths) || 200000),
  }

  const wantFlat = values.lane === 'both' || values.lane === 'flat'
  const wantLocal = (values.lane === 'both' || values.lane === 'local') && grids.every(Boolean)
  const lanes = []
  if (wantFlat) lanes.push(['flat GBM', await priceLane(riga, deal, market, 'flat')])
  if (wantLocal) lanes.push(['Dupire surface', await priceLane(riga, deal, market, 'local')])

  const payload = {
    instrument: deal,
    market: {
      spots: market.spots,
      vols: market.vols,
      correlation: market.correlation,
      riskFreeRate: market.riskFreeRate,
      dividendYields: market.dividendYields,
      gridShapes: grids.map((g) => (g ? [g.maturities_years.length, g.strikes.length] : null)),
      notes: market.notes,
    },
    lanes: Object.fromEntries(lanes.map(([label, result]) => [label, { pv: result.pv, put: result.legs?.down_and_in_put, result }])),
  }

  if (values.json) {
    console.log(JSON.stringify(payload, null, 2))
  } else {
    const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : '—')
    console.log(`${deal.name}  (${deal.template}, leg ${deal.leg}, multiplier ${deal.multiplier})`)
    console.log(`notional ${deal.notional} ${deal.currency}   as_of ${deal.asOf}   maturity ${deal.maturityYears.toFixed(6)}y   steps ${deal.steps}   KO from step ${deal.callStartStep}`)
    console.log(`strike ${deal.strike}   knock-in ${deal.knockIn}   knock-out ${deal.knockOut ?? '—'}`)
    console.log('')
    deal.symbols.forEach((symbol, i) => {
      console.log(`  ${symbol.padEnd(6)} init ${deal.initialSpots[i]} → spot ${market.spots[i]}   vol ${pct(market.vols[i])}   div ${pct(market.dividendYields[i])}   grid ${market.grids[i] ? `${market.grids[i].maturities_years.length}×${market.grids[i].strikes.length}` : '—'}`)
    })
    console.log(`  correlation ${market.correlation[0][1].toFixed(4)}   rate ${pct(market.riskFreeRate)}   paths ${market.paths}`)
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
  tac.close()
  riga.close()
}
