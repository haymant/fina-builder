import { afterEach, describe, expect, it, vi } from 'vitest'
import { BookApiError, createBookApi } from '../bookApi'

const fixture = {
  round: { id: 42, targetDate: '2026-11-20', status: 'settled', accountEquityAtSizing: '1250000.125', createdAt: '2026-11-20T09:00:00Z' },
  intents: [], decisions: [], orders: [{ id: 9, qtyFilled: '10.500', avgFillPrice: '125.25' }], facts: [], funnel: { filled: 1 }, metrics: { turnover: '1315.125' },
}

afterEach(() => vi.restoreAllMocks())

describe('bookApi Phase 3A read-only contract', () => {
  it('normalizes round detail while preserving decimal strings', async () => {
    const callTool = vi.fn(async () => fixture)
    const api = createBookApi({ callTool })
    const result = await api.getRound({ roundId: '42' })
    expect(result.round).toMatchObject({ id: '42', accountEquityAtSizing: '1250000.125' })
    expect(result.orders[0]).toMatchObject({ id: 9, qtyFilled: '10.500', avgFillPrice: '125.25' })
    expect(callTool).toHaveBeenCalledWith('round_get', { roundId: '42' })
  })

  it('allows only read-only book tools', async () => {
    const callTool = vi.fn(async () => ({ rounds: [] }))
    const api = createBookApi({ callTool })
    await api.listRounds()
    await expect(api as unknown as { createRound: () => Promise<unknown> }).not.toHaveProperty('createRound')
    expect(callTool).toHaveBeenCalledWith('round_list', {})
  })

  it('maps backend failures to typed redacted errors', async () => {
    const api = createBookApi({ callTool: async () => { throw new Error('DATABASE_URL=postgres://user:secret@db/prod') } })
    await expect(api.listRounds()).rejects.toMatchObject<Partial<BookApiError>>({ kind: 'unavailable', tool: 'round_list' })
    try { await api.listRounds() } catch (error) { expect((error as Error).message).not.toContain('secret') }
  })
})
