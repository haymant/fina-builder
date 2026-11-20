import { describe, expect, it } from 'vitest'
import { BookServiceError, READ_ONLY_BOOK_TOOLS, createReadOnlyBookClient } from '../book-contract.mjs'

const fixture = {
  round: { id: 42, source: 'scheduled', target_date: '2026-11-20', status: 'settled', account_equity_at_sizing: '1250000.125', created_at: '2026-11-20T09:00:00+00:00', updated_at: '2026-11-20T09:01:00Z' },
  intents: [{ id: 7, round_id: 42, version: 1, created_at: '2026-11-20T09:00:01Z' }],
  decisions: [{ id: 8, round_id: 42, symbol: 'AAPL', status: 'filled' }],
  orders: [{ id: 9, round_id: 42, qty_filled: '10.500', avg_fill_price: '125.25' }],
  facts: [{ id: 10, round_id: 42, at: '2026-11-20T09:00:02Z' }],
  funnel: { target: 1, filled: 1, turnover: '1315.125' },
  metrics: { turnover: '1315.125', slippage_bps: '-0.500' },
}

function clientFor(mode) {
  return createReadOnlyBookClient(async (tool) => {
    if (mode === 'desktop-stdio') return structuredClone(tool === 'round_get' ? fixture : { rounds: [fixture.round], turnover: '1315.125' })
    return JSON.parse(JSON.stringify(tool === 'round_get' ? fixture : { rounds: [fixture.round], turnover: '1315.125' }))
  })
}

describe('Phase 3A read-only book boundary', () => {
  it('exposes only the approved read-only tool set', async () => {
    expect(READ_ONLY_BOOK_TOOLS).toEqual(['round_list', 'round_get', 'trail_query', 'trail_funnel', 'round_metrics'])
    const client = clientFor('browser-http')
    await expect(client.roundGet({ roundId: '42' })).resolves.toMatchObject({ round: { id: '42', accountEquityAtSizing: '1250000.125' } })
    await expect(client.roundList()).resolves.toMatchObject({ rounds: [{ id: '42' }] })
    await expect(clientFor('browser-http').roundGet({ roundId: '42' })).resolves.toMatchObject({ orders: [{ qtyFilled: '10.5', avgFillPrice: '125.25' }] })
  })

  it('normalizes equivalent HTTP and stdio fixtures identically', async () => {
    const browser = await clientFor('browser-http').roundGet({ roundId: '42' })
    const desktop = await clientFor('desktop-stdio').roundGet({ roundId: '42' })
    expect(desktop).toEqual(browser)
  })

  it('rejects mutation tools before they reach the service', async () => {
    const called = []
    const client = createReadOnlyBookClient(async (tool) => { called.push(tool); return {} })
    await expect(client.call?.('round_create')).rejects.toBeDefined()
    expect(called).toEqual([])
  })

  it('maps backend failures to typed errors without exposing the original diagnostic', async () => {
    const client = createReadOnlyBookClient(async () => { throw new Error('DATABASE_URL=postgres://user:secret@db/prod') })
    await expect(client.roundList()).rejects.toMatchObject({ code: 'BACKEND', retryable: true })
    try { await client.roundList() } catch (error) {
      expect(error).toBeInstanceOf(BookServiceError)
      expect(error.message).not.toContain('secret')
    }
  })
})
