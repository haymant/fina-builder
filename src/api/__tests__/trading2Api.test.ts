import { afterEach, describe, expect, it, vi } from 'vitest'
import { TacUnavailableError, setTacTransport } from '../tacTransport'
import { normalizeMacroBars, normalizeNews, normalizeOrders, normalizePositions, normalizeWatchlist, trading2Api, Trading2Error } from '../trading2Api'

afterEach(() => setTacTransport(null))

describe('Trading 2nd DTO normalization', () => {
  it('normalizes TAC positions and orders without coupling the UI to raw keys', () => {
    expect(normalizePositions({ positions: [{ symbol: 'AAPL', qty: '2', market_value: '350', unrealized_plpc: '0.1' }] })).toEqual([expect.objectContaining({ symbol: 'AAPL', quantity: 2, marketValue: 350, unrealizedPlPct: 0.1 })])
    expect(normalizeOrders({ orders: [{ id: 'o1', symbol: 'MSFT', qty: 3, submitted_at: '2026-01-01' }] })).toEqual([expect.objectContaining({ id: 'o1', symbol: 'MSFT', quantity: 3, submittedAt: '2026-01-01' })])
  })
  it('normalizes news and tolerates alternate response envelopes', () => {
    expect(normalizeNews({ data: [{ title: 'Headline', created_at: '2026-01-01', symbols: ['AAPL'] }] })).toEqual([expect.objectContaining({ headline: 'Headline', createdAt: '2026-01-01', symbols: ['AAPL'] })])
  })
  it('normalizes the lake watchlist envelope', () => {
    expect(normalizeWatchlist({ watchlist: [{ symbol: 'NVDA', name: 'NVIDIA', price: '120.5', change_pct: '1.25' }] })).toEqual([expect.objectContaining({ symbol: 'NVDA', name: 'NVIDIA', price: 120.5, changePct: 1.25 })])
  })
  it('normalizes synthetic macro bars', () => {
    expect(normalizeMacroBars({ bars: [{ t: '2026-01-01T00:00:00Z', c: '101', o: '101', h: '101', l: '101' }] })).toEqual([expect.objectContaining({ t: '2026-01-01T00:00:00Z', c: 101, o: 101, h: 101, l: 101, v: 0 })])
    expect(normalizeMacroBars({ bars: { CBOE_VIX: [{ t: '2026-01-02T00:00:00Z', c: 22 }] } }, 'CBOE_VIX')).toEqual([expect.objectContaining({ t: '2026-01-02T00:00:00Z', c: 22 })])
  })
})

describe('Trading 2nd API transport boundary', () => {
  it('calls read-only TAC tools with stable arguments', async () => {
    const callTool = vi.fn(async (name: string) => name === 'list_orders' ? { orders: [] } : { positions: [] })
    setTacTransport({ callTool: callTool as unknown as <T>(name: string, args?: unknown) => Promise<T> })
    await trading2Api.listOrders(); await trading2Api.listPositions(); await trading2Api.getLakeBars('aapl', '2026-01-01', '2026-02-01')
    expect(callTool).toHaveBeenNthCalledWith(1, 'list_orders', { status: 'open' })
    expect(callTool).toHaveBeenNthCalledWith(2, 'list_positions', {})
    expect(callTool).toHaveBeenNthCalledWith(3, 'get_lake_bars', { market: 'US', symbols: 'AAPL', timeframe: '1d', start: '2026-01-01', end: '2026-02-01', feed: 'iex', adjustment: 'raw', lazy: true })
  })
  it('calls macro lake reads with MACRO coverage and canonical symbols args', async () => {
    const callTool = vi.fn(async (name: string) => name === 'get_macro_bars' ? { bars: [] } : name === 'get_macro_features' ? { features: [] } : { coverage: [] })
    setTacTransport({ callTool: callTool as unknown as <T>(name: string, args?: unknown) => Promise<T> })
    await trading2Api.getMacroBars('cboe_vix', '2026-01-01', '2026-02-01')
    await trading2Api.getMacroFeatures('fred_cpiauCSL', '2026-01-01', '2026-02-01')
    await trading2Api.getMacroCoverage()
    expect(callTool).toHaveBeenNthCalledWith(1, 'get_macro_bars', { symbols: 'CBOE_VIX', start: '2026-01-01', end: '2026-02-01', quiet: false })
    expect(callTool).toHaveBeenNthCalledWith(2, 'get_macro_features', { symbol: 'FRED_CPIAUCSL', start: '2026-01-01', end: '2026-02-01' })
    expect(callTool).toHaveBeenNthCalledWith(3, 'get_lake_coverage', { market: 'MACRO', timeframe: '1d' })
  })
  it('maps a missing TAC backend to an unavailable Trading2Error', async () => {
    setTacTransport({ callTool: async () => { throw new TacUnavailableError('TAC credentials are not configured') } })
    await expect(trading2Api.getAccount()).rejects.toMatchObject<Partial<Trading2Error>>({ kind: 'unavailable', tool: 'get_account' })
  })
  it('submits and cancels using named TAC operations without floating-point conversion', async () => {
    const callTool = vi.fn(async (name: string) => name === 'place_order' ? { id: 'o1', symbol: 'AAPL', qty: '1.000000000000000001', status: 'accepted' } : { id: 'o1', symbol: 'AAPL', status: 'canceled' })
    setTacTransport({ callTool: callTool as unknown as <T>(name: string, args?: unknown) => Promise<T> })
    await trading2Api.placeOrder({ symbol: 'aapl', side: 'buy', type: 'market', timeInForce: 'day', qty: '1.000000000000000001' }); await trading2Api.cancelOrder('o1')
    expect(callTool).toHaveBeenNthCalledWith(1, 'place_order', expect.objectContaining({ symbol: 'AAPL', qty: '1.000000000000000001' }))
    expect(callTool).toHaveBeenNthCalledWith(2, 'cancel_order', { order_id: 'o1' })
  })
})
