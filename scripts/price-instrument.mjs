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
// The Murex deal/market decoders live in
// `src/features/riga/instrument/decoders.ts`, shared with the app (docs/46 §4),
// and are imported here under Node's TypeScript type-stripping (Node >= 23.6).
//
// The engines resolve the same way as the app: the `RIGA_MCP_BIN` /
// `TAC_ENGINE_BIN` overrides, else the submodule default relative path
// (`modules/<dir>/target/release/<bin>`).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createStdioClient } from './lib/mcpStdio.mjs'
import {
  DAYS_PER_YEAR,
  MS_PER_DAY,
  atmVol,
  businessDays,
  decodeDeal,
  fileMarketBlock,
  marketFromFile,
  normaliseSurface,
  pearson,
  rateFromPillars,
  serialFromIso,
  stripMarket,
  surfaceToGrid,
} from '../src/features/riga/instrument/decoders.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function tool(client, name, args = {}) {
  const reply = await client.request('tools/call', { name, arguments: args }, 120000)
  if (reply.isError)
    throw new Error(
      `${name}: ${JSON.stringify(reply.structuredContent ?? reply.content).slice(0, 200)}`,
    )
  return (
    reply.structuredContent ??
    (reply.content?.[0]?.text ? JSON.parse(reply.content[0].text) : reply.content)
  )
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
  if (!correlation)
    correlation = [
      [1, 0.4],
      [0.4, 1],
    ]

  const riskFreeRate = await lakeRate(tac, maturityYears, notes)
  const dividendYields = [0, 0]

  const surfaces = {}
  const dealExpiry = serialFromIso(deal.finalFixing)
  for (const symbol of symbols) {
    try {
      surfaces[symbol] = normaliseSurface(
        await tool(tac, 'vol_surface', { underlying: symbol, deal_expiry: dealExpiry }),
      )
    } catch (error) {
      notes.push(`${symbol} vol surface unavailable: ${error.message}`)
    }
  }
  const grids = symbols.map((symbol) => surfaceToGrid(surfaces[symbol], asOf))
  const vols = symbols.map(
    (symbol) => (surfaces[symbol] && atmVol(surfaces[symbol], asOf, maturityYears)) ?? 0.2,
  )

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
    'no-call': { type: 'boolean', default: false },
    vol: { type: 'string' },
    strike: { type: 'string' },
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

  // Reconciliation overrides (default to the instrument's own spec).
  const priced = { ...deal }
  const overrides = []
  if (values.strike !== undefined) {
    priced.strike = Number(values.strike)
    overrides.push(`strike ${priced.strike}`)
  }
  if (values['no-call']) {
    priced.knockOut = null
    overrides.push('no autocall (KO disabled)')
  }
  if (values.vol) {
    market.vols = values.vol.split(',').map(Number)
    market.grids = market.grids.map(() => null)
    overrides.push(`vol ${market.vols.join(' / ')} (surface grid disabled)`)
  }

  const wantFlat = values.lane === 'both' || values.lane === 'flat'
  const wantLocal = (values.lane === 'both' || values.lane === 'local') && market.grids.every(Boolean)
  const lanes = []
  if (wantFlat) lanes.push(['flat GBM', await priceLane(riga, priced, market, 'flat')])
  if (wantLocal) lanes.push(['Dupire surface', await priceLane(riga, priced, market, 'local')])

  const maturityYears = (Date.parse(priced.finalFixing) - Date.parse(market.asOf)) / (MS_PER_DAY * DAYS_PER_YEAR)
  if (values.json) {
    console.log(JSON.stringify({
      instrument: priced,
      market: { provenance: market.provenance, asOf: market.asOf, spots: market.spots, vols: market.vols, correlation: market.correlation, riskFreeRate: market.riskFreeRate, dividendYields: market.dividendYields, gridShapes: market.grids.map((g) => (g ? [g.maturities_years.length, g.strikes.length] : null)), notes: market.notes },
      overrides,
      lanes: Object.fromEntries(lanes.map(([label, result]) => [label, { pv: result.pv, put: result.legs?.down_and_in_put, legs: result.legs }])),
    }, null, 2))
  } else {
    const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(3)}%` : '—')
    console.log(`${priced.name}  (${priced.template}, leg ${priced.leg}, multiplier ${priced.multiplier})`)
    console.log(`notional ${priced.notional} ${priced.currency}   as_of ${market.asOf}   maturity ${maturityYears.toFixed(6)}y   market ${market.provenance}`)
    console.log(`strike ${priced.strike}   knock-in ${priced.knockIn}   knock-out ${priced.knockOut ?? '— (no autocall)'}`)
    if (overrides.length) console.log(`overrides: ${overrides.join('; ')}`)
    console.log('')
    priced.symbols.forEach((symbol, i) => {
      console.log(`  ${symbol.padEnd(6)} init ${priced.initialSpots[i]} → spot ${market.spots[i]}   vol ${pct(market.vols[i])}   div ${pct(market.dividendYields[i])}   grid ${market.grids[i] ? `${market.grids[i].maturities_years.length}×${market.grids[i].strikes.length}` : '—'}`)
    })
    console.log(`  correlation ${market.correlation[0][1].toFixed(5)}   rate ${pct(market.riskFreeRate)}   paths ${market.paths}`)
    market.notes.forEach((note) => console.log(`  note: ${note}`))
    console.log('')
    console.log('lane             PV          put leg     signed value (× notional)')
    for (const [label, result] of lanes) {
      const put = result.legs?.down_and_in_put ?? 0
      console.log(
        `${label.padEnd(15)} ${result.pv.toFixed(6)}   ${put.toFixed(6)}   ${(put * priced.notional * priced.multiplier).toFixed(2)} ${priced.currency}`,
      )
    }
  }
} finally {
  tac?.close()
  riga.close()
}
