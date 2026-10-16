// Record a real MCP session from a vendored engine into a transcript JSON.
//
//   node scripts/record-transcripts.mjs riga
//   node scripts/record-transcripts.mjs tac
//
// The transcript shape is `{ engine, protocol, recordedAt, tools, ... }` where
// `tools[name]` is the tool's `structuredContent`. Argument values are derived
// from each tool's advertised `inputSchema` (so wire names are always exact);
// a few fields get sensible recording values. Tools that error are recorded
// under `errors[name]` and omitted from `tools`.

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStdioClient } from './lib/mcpStdio.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const CONFIG = {
  riga: {
    binary: resolve(root, 'modules/riga-flow/target/release/riga-mcp'),
    args: ['--transport', 'stdio'],
    out: 'src/features/riga/__tests__/fixtures/termsheet1.transcript.json',
    protocol: '2025-11-25',
    timeoutMs: 60_000,
  },
  tac: {
    binary: resolve(root, 'modules/tac-engine/target/release/tac-engine'),
    args: [],
    cwd: resolve(root, 'modules/tac-engine'),
    out: 'src/features/tac/__tests__/fixtures/tac-market.transcript.json',
    protocol: '2026-07-28',
    timeoutMs: 90_000,
    // Read-only market-data tools only. The recorder must never call a mutating
    // tool (place_order, close_*, cancel_*, watchlist writes, backfills).
    allow: [
      'get_lake_bars',
      'get_lake_ta',
      'get_lake_sp',
      'get_lake_features',
      'get_lake_symbols',
      'get_lake_coverage',
      'get_lake_calendar',
      'get_lake_status',
      'get_lake_watchlist',
      'get_lake_fx',
      'get_lake_fx_vol',
      'corr_matrix',
      'corr_calc',
      'get_correlations',
      'corr_benchmark',
      'vol_surface',
      'vol_surface_status',
      'rate_curve',
      'get_macro_symbols',
      'get_macro_bars',
      'get_macro_features',
      'get_corporate_actions',
      'get_stock_snapshot',
      'get_stock_snapshots',
      'get_stock_bars',
      'get_option_chain',
      'get_forex_latest_rates',
      'get_forex_rates',
      'get_news',
      'get_most_actives',
      'get_market_movers',
    ],
    // A representative overlay kept with the capture (the recorder never
    // applies it; it is inert data for the tests).
    manipulations: [
      { type: 'volatility', operation: 'absolute', value: 100, target: 'ADBE', surfaceParameter: 'atm' },
      { type: 'spot', operation: 'relative', value: 0.01, target: 'ADBE' },
    ],
    forbidden: ['place_order', 'close_position', 'cancel_order', 'put_watchlist', 'delete_watchlist'],
  },
}

// Values that must be meaningful for a real run.
const SPECIAL = {
  percentile: 0.05,
  max_paths: 8,
  max_sample: 16,
  spot_moves: [0.01, -0.01],
  vol_moves: [0.01, -0.01],
  rate_move: 0.0001,
  corr_move: 0.01,
  name: 'default',
  notionals: [10000, 10000],
  legs: 'ADBE,AMZN',
  underlying: 'ADBE',
  pair: 'EURUSD',
  currency: 'USD',
  symbol: 'ADBE',
  symbols: 'ADBE,AMZN',
  timeframe: '1d',
  type: 'dividend',
  types: 'dividend',
  leg_a: 'ADBE',
  leg_b: 'AMZN',
  window_days: 252,
  alpha: 0.4,
  currency_pairs: 'EURUSD,USDJPY',
}

function valueFor(key, prop) {
  const types = Array.isArray(prop?.type) ? prop.type : [prop?.type]
  const has = (t) => types.includes(t)
  if (key in SPECIAL) {
    const value = SPECIAL[key]
    // Coerce the recording value to the advertised schema type.
    if (Array.isArray(value) && has('string')) return value.join(',')
    if (typeof value === 'string' && has('array')) return value.split(',')
    return value
  }
  if (has('integer')) return key.includes('step') ? 1 : 0
  if (has('number')) return 0
  if (has('boolean')) return false
  if (has('array')) return []
  if (has('object')) return {}
  if (has('string')) return ''
  return null
}

function buildArgs(name, schema) {
  const args = {}
  const properties = schema?.properties ?? {}
  const required = new Set(schema?.required ?? [])
  for (const [key, prop] of Object.entries(properties)) {
    if (key === 'fixture_path' || key === 'fixturePath') continue
    // Only send a value for a required field or one we deliberately record;
    // optional fields left unset let the engine use its own defaults (a bare
    // empty-string date just breaks the lake query).
    if (!(key in SPECIAL) && !required.has(key)) continue
    const value = valueFor(key, prop)
    if (value !== null) args[key] = value
  }
  if (name === 'get_macro_bars' || name === 'get_macro_features') {
    args.symbols = 'FRED_DGS3MO,FRED_DGS1,FRED_DGS2,FRED_DGS5,FRED_DGS10,FRED_DGS30'
  }
  if (name === 'get_corporate_actions') {
    args.symbols = 'ADBE,AMZN'
    args.types = 'dividend'
    args.start = '2026-01-01'
    args.end = '2027-01-01'
  }
  // A valid `price_trade` request (riga-engine `PriceRequest`).
  if (name === 'price_trade') {
    args.request = {
      trade: {
        trade_id: 'termsheet1',
        initial_spots: [239.97, 260.0],
        maturity_years: 0.75,
        steps: 9,
        strike: 1.0,
        knock_in_barrier: 0.7,
        knock_out_barrier: 1.1,
        coupon_barrier: 0.1,
        coupon_rate: 0.009642,
        memory_coupon: true,
        coupon_periods: 9,
        fixed_first_coupon: true,
        call_start_step: 1,
      },
      market: {
        as_of: '2026-09-07',
        spots: [239.97, 260.0],
        vols: [0.467214, 0.355738],
        risk_free_rate: 0.041398,
        dividend_yields: [0.0, 0.002979],
        correlation: [
          [1.0, 0.4593248180905],
          [0.4593248180905, 1.0],
        ],
      },
      config: { paths: 30000, path_block_size: 4096, seed: 1729, trace_level: 'aggregated', variance_reduction: { kind: 'none' } },
      as_of: '2026-09-07',
    }
  }
  return args
}

const RANK = (name) => {
  if (name === 'generate_paths') return 0
  if (name === 'query_path_cube' || name === 'query_pathcube') return 1
  if (name === 'freeze_baseline') return 2
  if (name === 'get_path' || name === 'replay_path') return 5
  if (name === 'compare_corpus' || name === 'triage_regression' || name === 'root_cause') return 4
  return 3
}

function parsePayload(result) {
  if (result?.structuredContent !== undefined && result?.structuredContent !== null) return result.structuredContent
  const content = result?.content
  if (Array.isArray(content)) {
    const block = content.find((item) => item?.type === 'text' && typeof item.text === 'string')
    if (block) {
      try {
        return JSON.parse(block.text)
      } catch {
        return block.text
      }
    }
  }
  return content
}

async function main() {
  const engine = process.argv[2]
  const config = CONFIG[engine]
  if (!config) {
    console.error('usage: node scripts/record-transcripts.mjs riga|tac')
    process.exit(2)
  }

  const client = createStdioClient(config.binary, config.args, { cwd: config.cwd, timeoutMs: config.timeoutMs })
  const init = await client.initialize()
  const listed = await client.request('tools/list', {})
  const allowed = config.allow ? new Set(config.allow) : null
  const tools = (listed.tools ?? []).filter((tool) => !allowed || allowed.has(tool.name))
  console.log(`tools: ${tools.length}${allowed ? ` (read-only allowlist of ${listed.tools?.length ?? 0})` : ''}`)

  const outputs = {}
  const errors = {}
  const pathId = {}

  // Discover a real path id from generate_paths / query_path_cube before tools
  // that need one.
  const ordered = [...tools].sort((a, b) => RANK(a.name) - RANK(b.name))

  for (const tool of ordered) {
    const args = buildArgs(tool.name, tool.inputSchema)
    const props = tool.inputSchema?.properties ?? {}
    if (('path_id' in props || 'pathId' in props) && Number.isInteger(pathId.value)) {
      if ('path_id' in props) args.path_id = pathId.value
      if ('pathId' in props) args.pathId = pathId.value
    }
    try {
      const result = await client.request('tools/call', { name: tool.name, arguments: args })
      if (result?.isError) {
        errors[tool.name] = result.structuredContent ?? result.content
        console.error(`  ! ${tool.name}: isError ${JSON.stringify(result.structuredContent ?? '').slice(0, 160)}`)
        continue
      }
      const payload = parsePayload(result)
      outputs[tool.name] = payload
      if ((tool.name === 'generate_paths' || tool.name === 'query_path_cube' || tool.name === 'query_pathcube') && !Number.isInteger(pathId.value)) {
        const id = payload?.sample?.[0]?.identity?.path_id ?? payload?.paths?.[0]?.identity?.path_id
        if (Number.isInteger(id)) pathId.value = id
      }
      console.log(`  ok ${tool.name}`)
    } catch (error) {
      errors[tool.name] = String(error.message ?? error)
      console.error(`  ! ${tool.name}: ${error.message ?? error}`)
    }
  }

  const recordedAt = new Date().toISOString()
  const transcript = {
    engine,
    protocol: init.protocolVersion ?? config.protocol,
    serverInfo: init.serverInfo ?? null,
    recordedAt,
    tools: outputs,
    errors,
  }
  if (config.manipulations) transcript.manipulations = config.manipulations
  if (config.forbidden) transcript.forbidden = config.forbidden

  const outPath = resolve(root, config.out)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(transcript, null, 2))
  console.log(`\nwrote ${outPath}`)
  console.log(`captured ${Object.keys(outputs).length} tools, ${Object.keys(errors).length} errors`)
  console.log(`sha256(tools)=${createHash('sha256').update(JSON.stringify(outputs)).digest('hex')}`)
  if (Object.keys(errors).length) {
    console.log('errors:')
    for (const [name, error] of Object.entries(errors)) {
      console.log(`  ${name}: ${JSON.stringify(error).slice(0, 200)}`)
    }
  }
  client.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
