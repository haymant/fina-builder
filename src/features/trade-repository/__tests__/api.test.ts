import { describe, expect, it, vi } from 'vitest'
import { createTradeRepoClient, fmtNotional, TradeRepoApiError } from '../api'

const reply = (result: unknown, ok = true, status = 200) => Promise.resolve({ ok, status, json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result }) } as Response)

describe('trade repo client', () => {
  it('sends tools/call with camelCase args and the session context', async () => {
    const fetchImpl = vi.fn(() => reply({ isError: false, structuredContent: { items: [], total: 0 } }))
    const c = createTradeRepoClient('/trade-repo', fetchImpl as unknown as typeof fetch)
    c.setSession({ actor: 'alice.rates', role: 'trader' })
    await expect(c.call('tr_trade_query', { filter: { bookIds: ['X'] } })).resolves.toEqual({ items: [], total: 0 })
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.params).toEqual({ name: 'tr_trade_query', arguments: { filter: { bookIds: ['X'] }, context: { actor: 'alice.rates', role: 'trader' } } })
  })
  it('maps structured tool errors with details', async () => {
    const c = createTradeRepoClient('/x', (() => reply({ isError: true, structuredContent: { code: 'CONFLICT', message: 'stale', details: [{ code: 'STALE_VERSION', path: 'expectedVersion', message: 'v3' }], retryable: true, correlationId: 'cor-1' } })) as unknown as typeof fetch)
    const err = await c.call('tr_trade_amend').catch((e) => e)
    expect(err).toBeInstanceOf(TradeRepoApiError)
    expect(err).toMatchObject({ code: 'CONFLICT', retryable: true, correlationId: 'cor-1', details: [{ path: 'expectedVersion' }] })
  })
  it('reports an unavailable server', async () => {
    const c = createTradeRepoClient('/x', (() => reply({}, false, 502)) as unknown as typeof fetch)
    await expect(c.call('tr_capabilities')).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    const d = createTradeRepoClient('/x', (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch)
    await expect(d.call('tr_capabilities')).rejects.toMatchObject({ code: 'UNAVAILABLE', retryable: true })
  })
  it('formats notionals', () => {
    expect(fmtNotional(25_000_000)).toBe('25.00m')
    expect(fmtNotional(-1_500_000_000)).toBe('-1.50bn')
    expect(fmtNotional(undefined)).toBe('—')
  })
})
