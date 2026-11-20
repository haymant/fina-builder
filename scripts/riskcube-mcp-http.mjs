import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStdioClient } from './lib/mcpStdio.mjs'
import { validateRiskcubeToolCall } from './lib/mcpAllowlist.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.RISKCUBE_MCP_HTTP_PORT ?? 8797)
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, mcp-session-id, accept, mcp-protocol-version', 'Access-Control-Expose-Headers': 'Mcp-Session-Id' }
const bin = process.env.RISK_CUBE_MCP_BIN
let child = null
let setupError = bin ? null : 'RiskCube OLAP service is not configured; set RISK_CUBE_MCP_BIN to a named MCP sidecar.'
if (bin) {
  try { child = createStdioClient(bin, [], { cwd: root, env: process.env }); await child.initialize() } catch (error) { setupError = `RiskCube OLAP service could not start: ${error?.message ?? error}`; child?.close() }
}
function safeCall(message) {
  validateRiskcubeToolCall(message.params)
}
async function handle(message) {
  const { id, method, params } = message
  if (id === undefined) return null
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fina-riskcube-olap', version: '0.1.0' } } }
  if (method === 'notifications/initialized' || method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (method !== 'tools/call') throw new Error(`RiskCube method is not allowed: ${method}`)
  safeCall({ params })
  if (setupError || !child) throw new Error(setupError ?? 'RiskCube OLAP service unavailable')
  const result = await child.call({ jsonrpc: '2.0', id, method, params })
  return { ...result, id }
}
const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end() }
  if (req.method === 'GET' && req.url === '/health') { res.writeHead(setupError ? 503 : 200, { ...CORS, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: !setupError, service: 'riskcube', error: setupError })) }
  if (req.method !== 'POST' || !(req.url ?? '').startsWith('/mcp')) { res.writeHead(404, CORS); return res.end() }
  let body = ''
  for await (const chunk of req) body += chunk
  try { const reply = await handle(JSON.parse(body)); res.writeHead(200, { ...CORS, 'Content-Type': 'application/json', 'Mcp-Session-Id': 'riskcube' }); res.end(JSON.stringify(reply)) }
  catch (error) { console.error('[riskcube-mcp] request rejected:', error?.message ?? error); res.writeHead(503, { ...CORS, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: setupError ?? error?.message ?? 'RiskCube service unavailable' } })) }
})
let shuttingDown = false
async function shutdown(code) { if (shuttingDown) return; shuttingDown = true; server.close(); child?.close(); process.exit(code) }
process.once('SIGINT', () => void shutdown(130)); process.once('SIGTERM', () => void shutdown(143))
server.listen(port, '127.0.0.1', () => console.error(`[riskcube-mcp] listening on http://127.0.0.1:${port}/mcp${setupError ? ` (${setupError})` : ''}`))
