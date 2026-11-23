import { createServer } from 'node:http'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStdioClient } from './lib/mcpStdio.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.BOOK_MCP_HTTP_PORT ?? 8795)
const child = createStdioClient(process.execPath, [resolve(root, 'scripts/tac-qlib-mcp.mjs'), 'book'], { cwd: root, env: process.env })
await child.initialize()
const log = (...args) => console.error('[book-mcp]', ...args)
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, mcp-session-id, accept, mcp-protocol-version', 'Access-Control-Expose-Headers': 'Mcp-Session-Id' }

async function handle(message) {
  const { id, method, params } = message
  if (id === undefined) return null
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fina-tac-qlib-book', version: '0.1.0' } } }
  if (method === 'notifications/initialized' || method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  // `client.call` resolves with the child's `result` payload. Wrap it in a
  // JSON-RPC envelope because the browser transport reads `parsed.result`.
  const result = await child.call({ jsonrpc: '2.0', id, method, params })
  return { jsonrpc: '2.0', id, result }
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, service: 'book' })) }
  if (req.method !== 'POST' || !(req.url ?? '').startsWith('/mcp')) { res.writeHead(404, CORS); return res.end() }
  let body = ''
  for await (const chunk of req) body += chunk
  try {
    const reply = await handle(JSON.parse(body))
    if (reply === null) { res.writeHead(202, CORS); return res.end() }
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json', 'Mcp-Session-Id': 'book' })
    res.end(JSON.stringify(reply))
  } catch (error) {
    log('request failed:', error?.message ?? error)
    res.writeHead(503, { ...CORS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'book service unavailable' } }))
  }
})

let shuttingDown = false
async function shutdown(code) { if (shuttingDown) return; shuttingDown = true; server.close(); child.close(); process.exit(code) }
process.once('SIGINT', () => void shutdown(130)); process.once('SIGTERM', () => void shutdown(143))
server.listen(port, '127.0.0.1', () => log(`listening on http://127.0.0.1:${port}/mcp`))
