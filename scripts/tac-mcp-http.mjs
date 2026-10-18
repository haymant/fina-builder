// Local stdio→Streamable-HTTP bridge for `tac-engine`.
//
// The browser has no shell, so it cannot spawn the stdio-only tac-engine
// (T-EXT-3). This dev bridge does it for the webview: it spawns the engine and
// exposes the same JSON-RPC endpoint shape `riga-mcp --transport http` uses, so
// `VITE_TAC_MCP_URL` (default http://127.0.0.1:8790) just works in `npm run dev`.
//
//   npm run mcp:http:tac
//
// The desktop app does NOT need this — it reaches tac-engine over stdio through
// the Rust sidecar. Env is read from the tac-engine `.env` (dotenvy) and the
// host environment.

import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStdioClient } from './lib/mcpStdio.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const binary = process.env.TAC_ENGINE_BIN ?? resolve(root, 'modules/tac-engine/target/release/tac-engine')
const cwd = resolve(root, 'modules/tac-engine')
const port = Number(process.env.TAC_MCP_HTTP_PORT ?? 8790)

if (!existsSync(binary)) {
  console.error(`tac-engine binary not found at ${binary}`)
  console.error('Build it: cargo build --release --manifest-path modules/tac-engine/Cargo.toml')
  process.exit(1)
}

const client = createStdioClient(binary, [], { cwd, timeoutMs: 120000 })
client.child.on('exit', (code) => {
  console.error(`tac-engine exited (${code}); shutting down the bridge`)
  process.exit(code ?? 1)
})

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, mcp-session-id, accept, mcp-protocol-version',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      data += chunk
    })
    req.on('end', () => resolvePromise(data))
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }
  if (req.method !== 'POST' || !(req.url ?? '').startsWith('/mcp')) {
    res.writeHead(404, CORS)
    res.end()
    return
  }
  let message
  try {
    message = JSON.parse(await readBody(req))
  } catch {
    res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
    return
  }
  try {
    const reply = await client.call(message)
    res.setHeader('Mcp-Session-Id', 'tac-bridge')
    if (reply === null) {
      // A JSON-RPC notification (no id) has no response body.
      res.writeHead(202, CORS)
      res.end()
      return
    }
    // Wrap the engine result in a JSON-RPC 2.0 envelope. `client.call` resolves
    // with `message.result`, but every MCP client on this endpoint
    // (`createHttpMcpTransport` in src/api/rigaTransport.ts, used by
    // tacTransport) reads `parsed.result` — returning the bare result left the
    // browser tac lane with zero tools.
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, result: reply }))
  } catch (error) {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: String(error.message ?? error) } }))
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`tac-engine MCP HTTP bridge on http://127.0.0.1:${port}/mcp  (cwd ${cwd})`)
})

function shutdown() {
  client.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 500)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
