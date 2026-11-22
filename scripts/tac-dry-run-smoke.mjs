#!/usr/bin/env node
import { resolve } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStdioClient } from './lib/mcpStdio.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = resolve(root, 'fixtures/tac-dry-run.json')
const binary = process.env.TAC_ENGINE_BIN ?? resolve(root, 'modules/tac-engine/target/release/tac-engine')
const env = { ...process.env, TAC_DRY_RUN_FIXTURE: fixture, TAC_LAKE_DIR: process.env.TAC_LAKE_DIR ?? resolve(root, 'lake') }
const child = createStdioClient(binary, [], { cwd: root, env })

function call(name, args = {}) {
  return child.request('tools/call', { name, arguments: args })
}
function text(result) {
  const value = result?.content?.find((item) => item.type === 'text')?.text
  return value ? JSON.parse(value) : result
}

try {
  await child.initialize()
  const catalog = await child.request('tools/list', {})
  const names = new Set((catalog?.tools ?? []).map((tool) => tool.name))
  for (const required of ['get_account', 'list_positions', 'list_orders', 'get_stock_snapshot', 'get_news', 'place_order']) {
    if (!names.has(required)) throw new Error(`fixture catalog missing ${required}`)
  }
  const account = text(await call('get_account'))
  const before = text(await call('list_positions'))
  const snapshot = text(await call('get_stock_snapshot', { symbol: 'SPY' }))
  const news = text(await call('get_news', { symbols: 'SPY', limit: 10 }))
  const recorded = text(await call('place_order', { symbol: 'SPY', side: 'buy', type: 'market', time_in_force: 'day', qty: '1' }))
  const orders = text(await call('list_orders', { status: 'all' }))
  const after = text(await call('list_positions'))
  if (recorded?.dry_run !== true || recorded?.status !== 'dry_run') throw new Error('place_order was not recorded as dry_run')
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('dry-run order mutated positions')
  console.log(JSON.stringify({ ok: true, tools: names.size, account, positions_before: before, snapshot, news, recorded_order: recorded, orders, positions_after: after }, null, 2))
} finally {
  child.close()
}
