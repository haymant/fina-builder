import { TacUnavailableError, tac } from './tacTransport'

export type Trading2ErrorKind = 'unavailable' | 'backend' | 'validation' | 'timeout' | 'ambiguous' | 'conflict' | 'not-found'

export class Trading2Error extends Error {
  readonly kind: Trading2ErrorKind
  readonly tool?: string
  constructor(
    message: string,
    kind: Trading2ErrorKind,
    tool?: string,
  ) {
    super(message)
    this.name = 'Trading2Error'
    this.kind = kind
    this.tool = tool
  }
}

export interface Trading2Account {
  id?: string
  status?: string
  currency?: string
  buyingPower?: number
  cash?: number
  portfolioValue?: number
  equity?: number
  lastEquity?: number
  dayTradeCount?: number
  raw: Record<string, unknown>
}

export interface Trading2Position {
  symbol: string
  quantity?: number
  marketValue?: number
  costBasis?: number
  unrealizedPl?: number
  unrealizedPlPct?: number
  side?: string
  avgEntryPrice?: number
  currentPrice?: number
  raw: Record<string, unknown>
}

export interface Trading2Order {
  id?: string
  symbol: string
  side?: string
  quantity?: number
  filledQuantity?: number
  type?: string
  status?: string
  submittedAt?: string
  raw: Record<string, unknown>
}

export type Trading2OrderInput = {
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit' | 'stop' | 'stop_limit' | 'trailing_stop'
  timeInForce: 'day' | 'gtc' | 'opg' | 'cls' | 'ioc' | 'fok'
  qty?: string
  notional?: string
  limitPrice?: string
  stopPrice?: string
  clientOrderId?: string
}

export interface Trading2NewsItem {
  id?: string | number
  headline: string
  summary?: string
  source?: string
  url?: string
  createdAt?: string
  symbols: string[]
}

export interface Trading2WatchlistItem {
  symbol: string
  name?: string
  price?: number
  changePct?: number
}

export interface Trading2Snapshot {
  account: Trading2Account | null
  positions: Trading2Position[]
  orders: Trading2Order[]
}

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})
const asArray = (value: unknown, ...keys: string[]): unknown[] => {
  if (Array.isArray(value)) return value
  const record = asRecord(value)
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[]
  return []
}
const stringValue = (record: Record<string, unknown>, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
    if (typeof value === 'number') return String(value)
  }
  return undefined
}
const numberValue = (record: Record<string, unknown>, ...keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  }
  return undefined
}

function errorFor(tool: string, error: unknown): Trading2Error {
  if (error instanceof Trading2Error) return error
  if (error instanceof TacUnavailableError) return new Trading2Error(error.message, 'unavailable', tool)
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  const kind: Trading2ErrorKind = lower.includes('credential') || lower.includes('alpaca') || lower.includes('not configured')
    ? 'unavailable'
    : lower.includes('timeout') || lower.includes('timed out') ? 'timeout'
    : lower.includes('not found') ? 'not-found'
    : lower.includes('already') || lower.includes('conflict') ? 'conflict'
    : lower.includes('ambiguous') ? 'ambiguous'
    : 'backend'
  return new Trading2Error(message, kind, tool)
}

async function call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  try {
    return await tac.callTool<T>(tool, args)
  } catch (error) {
    throw errorFor(tool, error)
  }
}

export function normalizeAccount(value: unknown): Trading2Account {
  const raw = asRecord(value)
  return {
    id: stringValue(raw, 'id', 'account_id', 'accountId'),
    status: stringValue(raw, 'status'),
    currency: stringValue(raw, 'currency', 'currency_code'),
    buyingPower: numberValue(raw, 'buying_power', 'buyingPower'),
    cash: numberValue(raw, 'cash'),
    portfolioValue: numberValue(raw, 'portfolio_value', 'portfolioValue'),
    equity: numberValue(raw, 'equity'),
    lastEquity: numberValue(raw, 'last_equity', 'lastEquity'),
    dayTradeCount: numberValue(raw, 'daytrade_count', 'dayTradeCount'),
    raw,
  }
}

export function normalizePositions(value: unknown): Trading2Position[] {
  return asArray(value, 'positions', 'data').map((item) => {
    const raw = asRecord(item)
    return {
      symbol: stringValue(raw, 'symbol', 'asset_symbol') ?? '—',
      quantity: numberValue(raw, 'qty', 'quantity'),
      marketValue: numberValue(raw, 'market_value', 'marketValue'),
      costBasis: numberValue(raw, 'cost_basis', 'costBasis'),
      unrealizedPl: numberValue(raw, 'unrealized_pl', 'unrealizedPl'),
      unrealizedPlPct: numberValue(raw, 'unrealized_plpc', 'unrealized_pl_pct', 'unrealizedPlPct'),
      side: stringValue(raw, 'side'),
      avgEntryPrice: numberValue(raw, 'avg_entry_price', 'avgEntryPrice'),
      currentPrice: numberValue(raw, 'current_price', 'currentPrice'),
      raw,
    }
  })
}

export function normalizeOrders(value: unknown): Trading2Order[] {
  return asArray(value, 'orders', 'data').map((item) => {
    const raw = asRecord(item)
    return {
      id: stringValue(raw, 'id', 'order_id', 'orderId'),
      symbol: stringValue(raw, 'symbol') ?? '—',
      side: stringValue(raw, 'side'),
      quantity: numberValue(raw, 'qty', 'quantity'),
      filledQuantity: numberValue(raw, 'filled_qty', 'filledQuantity'),
      type: stringValue(raw, 'type', 'order_type'),
      status: stringValue(raw, 'status'),
      submittedAt: stringValue(raw, 'submitted_at', 'submittedAt', 'created_at'),
      raw,
    }
  })
}

export function normalizeNews(value: unknown): Trading2NewsItem[] {
  return asArray(value, 'news', 'articles', 'data').map((item) => {
    const raw = asRecord(item)
    return {
      id: stringValue(raw, 'id'),
      headline: stringValue(raw, 'headline', 'title') ?? 'Untitled news item',
      summary: stringValue(raw, 'summary', 'content'),
      source: stringValue(raw, 'source', 'author'),
      url: stringValue(raw, 'url'),
      createdAt: stringValue(raw, 'created_at', 'createdAt', 'updated_at'),
      symbols: Array.isArray(raw.symbols) ? raw.symbols.filter((s): s is string => typeof s === 'string') : [],
    }
  })
}

export function normalizeWatchlist(value: unknown): Trading2WatchlistItem[] {
  return asArray(value, 'watchlist', 'items', 'data').map((item) => {
    const raw = asRecord(item)
    return {
      symbol: stringValue(raw, 'symbol', 'ticker') ?? '—',
      name: stringValue(raw, 'name', 'asset_name'),
      price: numberValue(raw, 'price', 'last_price', 'current_price'),
      changePct: numberValue(raw, 'change_pct', 'changePct', 'percent_change'),
    }
  })
}

export const trading2Api = {
  getAccount: async () => normalizeAccount(await call('get_account')),
  listPositions: async () => normalizePositions(await call('list_positions')),
  listOrders: async (status = 'open') => normalizeOrders(await call('list_orders', { status })),
  getNews: async (symbols?: string[]) => normalizeNews(await call('get_news', symbols?.length ? { symbols: symbols.join(','), limit: 25 } : { limit: 25 })),
  getWatchlist: async () => normalizeWatchlist(await call('get_lake_watchlist')),
  placeOrder: async (input: Trading2OrderInput) => normalizeOrders([await call('place_order', {
    symbol: input.symbol.trim().toUpperCase(), side: input.side, type: input.type, time_in_force: input.timeInForce,
    ...(input.qty ? { qty: input.qty } : {}), ...(input.notional ? { notional: input.notional } : {}),
    ...(input.limitPrice ? { limit_price: input.limitPrice } : {}), ...(input.stopPrice ? { stop_price: input.stopPrice } : {}),
    ...(input.clientOrderId ? { client_order_id: input.clientOrderId } : {}),
  })])[0],
  getOrder: async (orderId: string) => normalizeOrders([await call('get_order', { order_id: orderId })])[0],
  cancelOrder: async (orderId: string) => normalizeOrders([await call('cancel_order', { order_id: orderId })])[0],
  loadSnapshot: async (): Promise<Trading2Snapshot> => {
    const results = await Promise.allSettled([
      trading2Api.getAccount(),
      trading2Api.listPositions(),
      trading2Api.listOrders(),
    ])
    const [account, positions, orders] = results
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (firstError && results.every((result) => result.status === 'rejected')) throw firstError.reason
    return {
      account: account.status === 'fulfilled' ? account.value : null,
      positions: positions.status === 'fulfilled' ? positions.value : [],
      orders: orders.status === 'fulfilled' ? orders.value : [],
    }
  },
}
