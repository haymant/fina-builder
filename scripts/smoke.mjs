#!/usr/bin/env node
// Live end-to-end smoke test (docs/49): drives the running engines through the
// *same* JSON-RPC MCP handshake the app uses, then calls a real tool. This is
// the one path the unit tests can't cover — the transports are injected in
// tests, so nothing proves the real servers answer over the real routes.
//
//   npm run backend:dev && npm run mcp:http:tac   # riga-mcp :8788 + tac bridge :8790
//   npm run dev                                   # vite :5173 (proxies /riga/mcp, /tac/mcp)
//
//   npm run smoke            # direct: 127.0.0.1:8788 + 127.0.0.1:8790
//   npm run smoke -- --web   # through the Vite proxy, and checks the page HTML
//
// Exit 0 only if every stage passes.

const PROTOCOL_VERSION = '2025-11-25'

const argv = process.argv.slice(2)
const webIdx = argv.indexOf('--web')
const webBase =
  webIdx >= 0 && argv[webIdx + 1] && !argv[webIdx + 1].startsWith('-')
    ? argv[webIdx + 1]
    : webIdx >= 0
      ? 'http://127.0.0.1:5173'
      : null
const RIGA = webBase ? `${webBase}/riga` : 'http://127.0.0.1:8788'
const TAC = webBase ? `${webBase}/tac` : 'http://127.0.0.1:8790'

const results = []

function pass(name, detail = '') {
  results.push(true)
  console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ''}`)
}
function fail(name, error) {
  results.push(false)
  console.error(`  \u2717 ${name} — ${error instanceof Error ? error.message : String(error)}`)
}

/** Parses a JSON-RPC reply that may arrive as JSON or as SSE `data:` frames. */
function parseRpcBody(contentType, body) {
  if (contentType.includes('text/event-stream')) {
    for (const frame of body.split('\n\n')) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!line) continue
      const payload = line.slice('data:'.length).trim()
      if (!payload) continue
      try {
        const parsed = JSON.parse(payload)
        if (parsed.result !== undefined || parsed.error !== undefined) return parsed
      } catch {
        /* keep scanning frames */
      }
    }
    throw new Error('the MCP server returned no JSON-RPC result frame')
  }
  return JSON.parse(body)
}

/** Minimal Streamable-HTTP MCP client, matching src/api/rigaTransport.ts. */
async function connect(label, base) {
  let session = null
  let nextId = 1
  const rpc = async (method, params, notify = false) => {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    }
    if (session) headers['Mcp-Session-Id'] = session
    const body = { jsonrpc: '2.0', ...(notify ? {} : { id: nextId++ }), method, params }
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
    const returned = response.headers.get('Mcp-Session-Id')
    if (returned) session = returned
    if (notify) return undefined
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
    const parsed = parseRpcBody(response.headers.get('Content-Type') ?? '', text)
    if (parsed.error) throw new Error(parsed.error.message)
    return parsed.result ?? {}
  }
  await rpc('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'fina-builder-smoke', version: '0.1.0' },
  })
  await rpc('notifications/initialized', {}, true)
  pass(`${label} initialize (${base})`, session ? 'session established' : 'stateless')
  return rpc
}

async function main() {
  if (webBase) {
    console.log(`Web (${webBase})`)
    try {
      const response = await fetch(webBase)
      const html = await response.text()
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!html.includes('<div id="root">')) throw new Error('served HTML has no <div id="root">')
      pass('Vite serves the app shell')
    } catch (error) {
      fail('Vite serves the app shell', error)
    }
  }

  console.log(`riga-mcp (${RIGA})`)
  try {
    const rpc = await connect('riga-mcp', RIGA)
    const tools = (await rpc('tools/list', {})).tools ?? []
    if (!tools.some((t) => t.name === 'price_put')) {
      throw new Error(`price_put not advertised (got ${tools.length} tools)`)
    }
    pass('tools/list', `${tools.length} tools`)
    const call = await rpc('tools/call', { name: 'price_put', arguments: {} })
    if (call.isError) throw new Error('price_put reported isError')
    const result = call.structuredContent?.result ?? {}
    const pv = result.pv
    const put = result.legs?.down_and_in_put
    if (typeof pv !== 'number') throw new Error('price_put returned no numeric pv')
    if (typeof put !== 'number' || !(put > 0)) throw new Error('price_put returned no positive put leg')
    pass('price_put', `pv=${pv.toFixed(6)} down_and_in_put=${put.toFixed(6)}`)
  } catch (error) {
    fail('riga-mcp round-trip', error)
  }

  console.log(`tac-engine (${TAC})`)
  try {
    const rpc = await connect('tac-engine', TAC)
    const tools = (await rpc('tools/list', {})).tools ?? []
    if (tools.length === 0) throw new Error('no tools advertised')
    pass('tools/list', `${tools.length} tools: ${tools.slice(0, 4).map((t) => t.name).join(', ')}`)
  } catch (error) {
    fail('tac-engine round-trip', error)
  }

  const failed = results.filter((ok) => !ok).length
  console.log(failed === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failed})`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
