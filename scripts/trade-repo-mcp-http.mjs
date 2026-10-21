// Trade repository MCP server (Streamable-HTTP JSON-RPC, same endpoint shape as
// `riga-mcp --transport http` and `scripts/tac-mcp-http.mjs`).
//
//   npm run mcp:http:trade-repo          # http://127.0.0.1:8792/mcp, proxied by Vite at /trade-repo/mcp
//   DATABASE_URL=sqlite:/path/db.sqlite  # default: SQLite at $TRADE_REPO_DATA_DIR/trade-repo.sqlite
//   DATABASE_URL=postgres://...          # PostgreSQL (e.g. Supabase)
//   --reset   drop + re-migrate;  --seed  seed demo data when empty;  --stdio  serve MCP over stdio
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { createRepository, parseCsv, TradeRepoError } from './lib/trade-repo/core.mjs'
import { REFERENCE } from './lib/trade-repo/reference.mjs'
import { seedRepository } from './lib/trade-repo/seed.mjs'
import { createStoreFromUrl } from './lib/trade-repo/store.mjs'
import { TOOLS } from './lib/trade-repo/tools.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Load an untracked .env (DATABASE_URL lives there; never committed).
const envFile = resolve(root, '.env')
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
const args = new Set(process.argv.slice(2))
const port = Number(process.env.TRADE_REPO_HTTP_PORT ?? 8792)
const log = (...a) => console.error('[trade-repo]', ...a)

const store = createStoreFromUrl(process.env.DATABASE_URL, { reset: args.has('--reset') })
await store.init()
const repo = createRepository({ reference: REFERENCE, store })
if (args.has('--seed') && repo.query({ role: 'admin' }, { limit: 1 }).total === 0) {
  const n = store.transaction ? store.transaction(() => seedRepository(repo)) : seedRepository(repo)
  await store.flush()
  log(`seeded ${n} demo trades`)
}
log(`store: ${store.kind} ${store.location}`)

const DEFAULT_CTX = { actor: process.env.TRADE_REPO_ACTOR ?? 'trash.box', role: 'admin' }

async function callTool(name, rawArgs = {}) {
  const tool = TOOLS.find((t) => t.name === name)
  const correlationId = `cor-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  if (!tool) return errorResult(new TradeRepoError('UNKNOWN_TOOL', `unknown tool ${name}`), correlationId)
  const { context, ...a } = rawArgs
  const ctx = { ...DEFAULT_CTX, ...(context ?? {}), correlationId }
  try {
    if (name === 'tr_bulk_import' && a.csv) a.rows = parseCsv(a.csv)
    const run = () => tool.run(repo, a, ctx)
    const out = store.transaction ? store.transaction(run) : run()
    await store.flush()
    return { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out, isError: false }
  } catch (e) {
    return errorResult(e, correlationId)
  }
}

function errorResult(e, correlationId) {
  const err = e instanceof TradeRepoError ? { ...e.toJSON(), correlationId } : { code: 'INTERNAL', message: String(e?.message ?? e), details: [], retryable: true, correlationId }
  if (err.code === 'INTERNAL') log(e)
  return { content: [{ type: 'text', text: `${err.code}: ${err.message}${err.details?.length ? ` — ${err.details.map((d) => `${d.path}: ${d.message}`).join('; ')}` : ''}` }], structuredContent: err, isError: true }
}

async function handle(msg) {
  const { id, method, params } = msg
  if (id === undefined) return null
  const ok = (result) => ({ jsonrpc: '2.0', id, result })
  switch (method) {
    case 'initialize':
      return ok({ protocolVersion: params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fina-trade-repo', version: '1.0.0' } })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
    case 'tools/call':
      return ok(await callTool(params?.name, params?.arguments))
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
  }
}

if (args.has('--stdio')) {
  const rl = createInterface({ input: process.stdin })
  rl.on('line', async (line) => {
    if (!line.trim()) return
    const reply = await handle(JSON.parse(line))
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`)
  })
} else {
  const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, mcp-session-id, accept, mcp-protocol-version', 'Access-Control-Expose-Headers': 'Mcp-Session-Id' }
  createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }
    if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, store: store.kind })) }
    if (req.method !== 'POST' || !(req.url ?? '').startsWith('/mcp')) { res.writeHead(404, CORS); return res.end() }
    let body = ''
    for await (const chunk of req) body += chunk
    let msg
    try { msg = JSON.parse(body) } catch {
      res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
    }
    const reply = await handle(msg)
    res.setHeader('Mcp-Session-Id', 'trade-repo')
    if (!reply) { res.writeHead(202, CORS); return res.end() }
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify(reply))
  }).listen(port, '127.0.0.1', () => log(`listening on http://127.0.0.1:${port}/mcp`))
}
