// httpTransport contract (§6.2): POST to /api/cmd/{command}, JSON body,
// non-2xx → ApiError with code/message, SSE frames → progress then result.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { httpTransport } from '../httpTransport'
import { server } from '../../tests/mocks/httpMock'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

describe('httpTransport', () => {
  it('POSTs the request to the command endpoint and parses the JSON', async () => {
    const out = await httpTransport.call('get_branch_stats', {})
    expect(out).toMatchObject({ totalPaths: 100000 })
  })

  it('sends the trade/market payload for compute_risk', async () => {
    const out = await httpTransport.call('compute_risk', { trade: {}, market: {} })
    expect(out).toMatchObject({ pv: 154.03 })
  })

  it('maps a 404 to an ApiError carrying code and message', async () => {
    await expect(
      httpTransport.call('get_path', { pathIndex: 500 }),
    ).rejects.toEqual({
      code: 'PATH_OUT_OF_RANGE',
      message: 'path index 500 out of range (bundle has 100)',
    })
  })

  it('throws for un-stubbed commands (missing mock fails loudly)', async () => {
    await expect(httpTransport.call('sudo_rm_rf', {})).rejects.toMatchObject({
      code: 'UNKNOWN_COMMAND',
    })
  })

  it('parses SSE frames: progress events stream out, final frame is the result', async () => {
    // MSW cannot stream true SSE without a custom transform; instead assert the
    // framing contract through a locally-served stream of two frames.
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        'data: {"phase":"generate_series","completed":0,"total":2,"message":""}\n\ndata: {"paths":[]}\n\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      )) as typeof fetch

    const progress: unknown[] = []
    const result = await httpTransport.generatePaths({ config: {} }, (e) => progress.push(e))
    expect(progress).toEqual([
      { phase: 'generate_series', completed: 0, total: 2, message: '' },
    ])
    expect(result).toEqual({ paths: [] })

    globalThis.fetch = originalFetch
  })
})