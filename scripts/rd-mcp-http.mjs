import { createServer } from 'node:http'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStdioClient } from './lib/mcpStdio.mjs'
import { validateRdToolCall } from './lib/mcpAllowlist.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.RD_MCP_HTTP_PORT ?? 8796)
const child = createStdioClient(process.execPath, [resolve(root, 'scripts/tac-qlib-mcp.mjs'), 'rd'], { cwd: root, env: process.env })
await child.initialize()
const MAX_BODY_BYTES = 256 * 1024
const toolCatalog = await child.request('tools/list', {})
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, mcp-session-id, accept, mcp-protocol-version', 'Access-Control-Expose-Headers': 'Mcp-Session-Id' }
async function handle(message) {
  const { id, method, params } = message
  if (id === undefined) return null
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fina-tac-qlib-rd', version: '0.1.0' } } }
  if (method === 'notifications/initialized' || method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: toolCatalog }
  if (method !== 'tools/call') throw new Error(`R&D method is not allowed: ${method}`)
  validateRdToolCall(params)
  const result = await child.call({ jsonrpc: '2.0', id, method, params })
  return { jsonrpc: '2.0', id, result }
}
const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, service: 'rd' })) }
  if (req.method !== 'POST' || !(req.url ?? '').startsWith('/mcp')) { res.writeHead(404, CORS); return res.end() }
  let body = ''
  let bodyBytes = 0
  for await (const chunk of req) {
    bodyBytes += chunk.length
    if (bodyBytes > MAX_BODY_BYTES) { res.writeHead(413, { ...CORS, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'R&D request body too large' })) }
    body += chunk
  }
  try { const reply = await handle(JSON.parse(body)); res.writeHead(200, { ...CORS, 'Content-Type': 'application/json', 'Mcp-Session-Id': 'rd' }); res.end(JSON.stringify(reply)) }
  catch (error) { console.error('[rd-mcp] request rejected:', error?.message ?? error); res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32602, message: error?.message ?? 'R&D request rejected' } })) }
})
let shuttingDown = false
async function shutdown(code) { if (shuttingDown) return; shuttingDown = true; server.close(); child.close(); process.exit(code) }
process.once('SIGINT', () => void shutdown(130)); process.once('SIGTERM', () => void shutdown(143))
server.listen(port, '127.0.0.1', () => console.error(`[rd-mcp] listening on http://127.0.0.1:${port}/mcp`))
