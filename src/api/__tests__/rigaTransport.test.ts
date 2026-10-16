// rigaTransport contract test (§14.1): handshake, structuredContent unwrap,
// tool-level error mapping, and a price_put round-trip — over the Streamable
// HTTP transport with a stubbed `fetch`.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpRigaTransport, parseRpcBody, RigaToolError, tauriRigaTransport } from '../rigaTransport'
import { invoke } from '../../tests/mocks/tauriMock'
import { RIGA_TRANSCRIPT } from '../../tests/mocks/transcripts'

interface RpcCall {
  method: string
  params: Record<string, unknown>
}

function stubMcpServer(options: { sse?: boolean; errorOn?: string } = {}) {
  const calls: RpcCall[] = []
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { method: string; params?: Record<string, unknown>; id?: number }
    calls.push({ method: body.method, params: body.params ?? {} })
    const headers = new Headers({ 'Content-Type': 'application/json' })
    if (body.method === 'initialize') headers.set('Mcp-Session-Id', 'session-123')
    if (body.id === undefined) return new Response('', { status: 202, headers })
    if (body.method === 'initialize') {
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', serverInfo: { name: 'riga-mcp', version: '0.3.0' } } }),
        { headers },
      )
    }
    if (body.method === 'tools/call') {
      const name = String((body.params?.name ?? '') as string)
      if (options.errorOn === name) {
        const result = { jsonrpc: '2.0', id: body.id, result: { isError: true, structuredContent: { code: 'invalid_market', message: 'spots must have length 2' }, content: [] } }
        return new Response(JSON.stringify(result), { headers })
      }
      const result = { jsonrpc: '2.0', id: body.id, result: { isError: false, structuredContent: RIGA_TRANSCRIPT.tools[name] ?? { ok: true }, content: [] } }
      if (options.sse) {
        const sse = new Headers({ 'Content-Type': 'text/event-stream' })
        return new Response(`event: message\ndata: ${JSON.stringify(result)}\n\n`, { headers: sse })
      }
      return new Response(JSON.stringify(result), { headers })
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), { headers })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

afterEach(() => vi.unstubAllGlobals())

describe('parseRpcBody', () => {
  it('parses a plain JSON-RPC body', () => {
    const parsed = parseRpcBody('application/json', '{"jsonrpc":"2.0","id":1,"result":{"pv":1.34}}')
    expect(parsed.result).toEqual({ pv: 1.34 })
  })

  it('parses an SSE data frame', () => {
    const parsed = parseRpcBody('text/event-stream', 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"pv":2.0}}\n\n')
    expect(parsed.result).toEqual({ pv: 2.0 })
  })
})

describe('rigaTransport (HTTP MCP contract)', () => {
  it('handshakes, replays the session id and unwraps structuredContent', async () => {
    const { calls } = stubMcpServer()
    const transport = createHttpRigaTransport('http://127.0.0.1:8788')
    const result = await transport.callTool<{ result: { pv: number } }>('price_put')
    expect(result.result.pv).toBeCloseTo(1.000264636050433, 9)
    const methods = calls.map((c) => c.method)
    expect(methods).toContain('initialize')
    expect(methods).toContain('notifications/initialized')
    expect(methods).toContain('tools/call')
    // initialize must precede the call.
    expect(methods.indexOf('initialize')).toBeLessThan(methods.indexOf('tools/call'))
  })

  it('parses a text/event-stream reply', async () => {
    stubMcpServer({ sse: true })
    const transport = createHttpRigaTransport('http://127.0.0.1:8788')
    const result = await transport.callTool<{ status: string }>('health')
    expect(result.status).toBe('ok')
  })

  it('maps a tool-level {code,message} error to RigaToolError', async () => {
    stubMcpServer({ errorOn: 'price_put' })
    const transport = createHttpRigaTransport('http://127.0.0.1:8788')
    await expect(transport.callTool('price_put')).rejects.toMatchObject({ name: 'RigaToolError', code: 'invalid_market' })
  })

  it('round-trips price_put and price_trade', async () => {
    stubMcpServer()
    const transport = createHttpRigaTransport('http://127.0.0.1:8788')
    const put = await transport.callTool<{ result: { pv: number } }>('price_put')
    const trade = await transport.callTool<{ pv: number }>('price_trade', { request: {} })
    expect(put.result.pv).toBeCloseTo(1.000264636050433, 9)
    expect(trade.pv).toBeCloseTo(0.9258746452443771, 9)
  })

  it('rethrows a JSON-RPC-level error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }), { headers: { 'Content-Type': 'application/json' } })),
    )
    const transport = createHttpRigaTransport('http://127.0.0.1:8788')
    await expect(transport.listTools()).rejects.toBeInstanceOf(RigaToolError)
  })
})

describe('tauri transport argument casing (regression)', () => {
  afterEach(() => vi.resetAllMocks())

  it('snake-cases arguments before invoking the engine', async () => {
    vi.mocked(invoke).mockResolvedValue({ isError: false, structuredContent: { total: 1 }, content: [] } as never)
    await tauriRigaTransport.callTool('pl_explain', {
      spotMoves: [0.01, -0.01],
      volMoves: [0.01, -0.01],
      rateMove: 0.0001,
      corrMove: 0.01,
    })
    const [, args] = vi.mocked(invoke).mock.calls[0] as [string, { name: string; arguments: Record<string, unknown> }]
    expect(args.name).toBe('pl_explain')
    // The engine rejects camelCase (`deny_unknown_fields`); the transport must
    // send snake_case or the tool errors.
    expect(Object.keys(args.arguments).sort()).toEqual(['corr_move', 'rate_move', 'spot_moves', 'vol_moves'])
  })

  it('surfaces the server text for a non-structured tool error', async () => {
    vi.mocked(invoke).mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'failed to deserialize parameters: unknown field `corrMove`' }],
    } as never)
    await expect(tauriRigaTransport.callTool('pl_explain', {})).rejects.toMatchObject({
      name: 'RigaToolError',
      message: expect.stringContaining('unknown field `corrMove`'),
    })
  })
})
