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
  accountNumber?: string
  status?: string
  currency?: string
  buyingPower?: number
  effectiveBuyingPower?: number
  regtBuyingPower?: number
  daytradingBuyingPower?: number
  nonMarginableBuyingPower?: number
  optionsBuyingPower?: number
  cash?: number
  portfolioValue?: number
  equity?: number
  lastEquity?: number
  longMarketValue?: number
  shortMarketValue?: number
  initialMargin?: number
  maintenanceMargin?: number
  sma?: number
  multiplier?: string
  dayTradeCount?: number
  patternDayTrader?: boolean
  tradingBlocked?: boolean
  shortingEnabled?: boolean
  raw: Record<string, unknown>
}

export interface Trading2Position {
  symbol: string
  quantity?: number
  marketValue?: number
  costBasis?: number
  unrealizedPl?: number
  unrealizedPlPct?: number
  unrealizedIntradayPl?: number
  unrealizedIntradayPlPct?: number
  changeToday?: number
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
  filledAveragePrice?: number
  type?: string
  timeInForce?: string
  limitPrice?: number
  stopPrice?: number
  notional?: number
  orderClass?: string
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

export type Trading2NewsQuery = {
  symbols?: string
  start?: string
  end?: string
  limit?: number
}

export interface Trading2WatchlistItem {
  symbol: string
  name?: string
  price?: number
  changePct?: number
}

export interface Trading2Watchlist {
  id: string
  name: string
  symbols: string[]
  raw: Record<string, unknown>
}

export interface Trading2Snapshot {
  account: Trading2Account | null
  positions: Trading2Position[]
  orders: Trading2Order[]
}

export interface Trading2PortfolioPoint {
  timestamp?: string
  equity?: number
  profitLoss?: number
  profitLossPct?: number
  raw: Record<string, unknown>
}

export interface Trading2Bar { timestamp: string; open?: number; high?: number; low?: number; close?: number; volume?: number }
export interface Trading2Quote { bid?: number; ask?: number; bidSize?: number; askSize?: number; last?: number; raw: Record<string, unknown> }
export interface Trading2Option { symbol?: string; expiration?: string; strike?: number; type?: string; bid?: number; ask?: number; mid?: number; volume?: number; openInterest?: number; impliedVolatility?: number; raw: Record<string, unknown> }

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
    accountNumber: stringValue(raw, 'account_number', 'accountNumber'),
    status: stringValue(raw, 'status'),
    currency: stringValue(raw, 'currency', 'currency_code'),
    buyingPower: numberValue(raw, 'buying_power', 'buyingPower'),
    effectiveBuyingPower: numberValue(raw, 'effective_buying_power', 'effectiveBuyingPower'),
    regtBuyingPower: numberValue(raw, 'regt_buying_power', 'regtBuyingPower'),
    daytradingBuyingPower: numberValue(raw, 'daytrading_buying_power', 'daytradingBuyingPower'),
    nonMarginableBuyingPower: numberValue(raw, 'non_marginable_buying_power', 'nonMarginableBuyingPower'),
    optionsBuyingPower: numberValue(raw, 'options_buying_power', 'optionsBuyingPower'),
    cash: numberValue(raw, 'cash'),
    portfolioValue: numberValue(raw, 'portfolio_value', 'portfolioValue'),
    equity: numberValue(raw, 'equity'),
    lastEquity: numberValue(raw, 'last_equity', 'lastEquity'),
    longMarketValue: numberValue(raw, 'long_market_value', 'longMarketValue'),
    shortMarketValue: numberValue(raw, 'short_market_value', 'shortMarketValue'),
    initialMargin: numberValue(raw, 'initial_margin', 'initialMargin'),
    maintenanceMargin: numberValue(raw, 'maintenance_margin', 'maintenanceMargin'),
    sma: numberValue(raw, 'sma'),
    multiplier: stringValue(raw, 'multiplier'),
    dayTradeCount: numberValue(raw, 'daytrade_count', 'dayTradeCount'),
    patternDayTrader: raw.pattern_day_trader === true || raw.patternDayTrader === true,
    tradingBlocked: raw.trading_blocked === true || raw.tradingBlocked === true,
    shortingEnabled: raw.shorting_enabled === true || raw.shortingEnabled === true,
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
      unrealizedIntradayPl: numberValue(raw, 'unrealized_intraday_pl', 'unrealizedIntradayPl'),
      unrealizedIntradayPlPct: numberValue(raw, 'unrealized_intraday_plpc', 'unrealizedIntradayPlPct'),
      changeToday: numberValue(raw, 'change_today', 'changeToday'),
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
      filledAveragePrice: numberValue(raw, 'filled_avg_price', 'filledAveragePrice'),
      type: stringValue(raw, 'type', 'order_type'),
      timeInForce: stringValue(raw, 'time_in_force', 'timeInForce'),
      limitPrice: numberValue(raw, 'limit_price', 'limitPrice'),
      stopPrice: numberValue(raw, 'stop_price', 'stopPrice'),
      notional: numberValue(raw, 'notional'),
      orderClass: stringValue(raw, 'order_class', 'orderClass'),
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

export function normalizeWatchlists(value: unknown): Trading2Watchlist[] {
  const direct = asRecord(value)
  const items = asArray(value, 'watchlists', 'data')
  if (!items.length && (direct.id || direct.watchlist_id || direct.watchlistId)) items.push(value)
  return items.map((item) => {
    const raw = asRecord(item)
    const symbols = Array.isArray(raw.symbols)
      ? raw.symbols.flatMap((symbol) => typeof symbol === 'string' ? [symbol.toUpperCase()] : [])
      : Array.isArray(raw.assets)
        ? raw.assets.flatMap((asset) => {
          const assetRecord = asRecord(asset)
          const symbol = stringValue(assetRecord, 'symbol', 'ticker')
          return symbol ? [symbol.toUpperCase()] : []
        })
        : []
    return {
      id: stringValue(raw, 'id', 'watchlist_id', 'watchlistId') ?? '',
      name: stringValue(raw, 'name') ?? 'Unnamed watchlist',
      symbols,
      raw,
    }
  }).filter((watchlist) => watchlist.id)
}

export function normalizeWatchlistRecord(value: unknown): Trading2Watchlist {
  return normalizeWatchlists({ watchlists: [value] })[0] ?? { id: '', name: 'Unnamed watchlist', symbols: [], raw: asRecord(value) }
}

export function normalizePortfolioHistory(value: unknown): Trading2PortfolioPoint[] {
  const raw = asRecord(value)
  const rows = asArray(value, 'history', 'data', 'portfolio_history')
  if (rows.length) return rows.map((item) => {
    const row = asRecord(item)
    return { timestamp: stringValue(row, 'timestamp', 'time', 'date'), equity: numberValue(row, 'equity'), profitLoss: numberValue(row, 'profit_loss', 'profitLoss'), profitLossPct: numberValue(row, 'profit_loss_pct', 'profitLossPct'), raw: row }
  })
  const timestamps = Array.isArray(raw.timestamp) ? raw.timestamp : []
  const equities = Array.isArray(raw.equity) ? raw.equity : []
  const profits = Array.isArray(raw.profit_loss) ? raw.profit_loss : []
  const profitPcts = Array.isArray(raw.profit_loss_pct) ? raw.profit_loss_pct : []
  const length = Math.max(timestamps.length, equities.length, profits.length, profitPcts.length)
  return Array.from({ length }, (_, index) => ({
    timestamp: typeof timestamps[index] === 'string' ? timestamps[index] : undefined,
    equity: typeof equities[index] === 'number' ? equities[index] : Number(equities[index]),
    profitLoss: typeof profits[index] === 'number' ? profits[index] : Number(profits[index]),
    profitLossPct: typeof profitPcts[index] === 'number' ? profitPcts[index] : Number(profitPcts[index]),
    raw,
  })).map((row) => ({ ...row, equity: Number.isFinite(row.equity) ? row.equity : undefined, profitLoss: Number.isFinite(row.profitLoss) ? row.profitLoss : undefined, profitLossPct: Number.isFinite(row.profitLossPct) ? row.profitLossPct : undefined }))
}

export function normalizeBars(value: unknown, symbol?: string): Trading2Bar[] {
  const raw = asRecord(value); const source = asRecord(raw.bars ?? value); const rows: unknown[] = Array.isArray(source[symbol ?? '']) ? source[symbol ?? ''] as unknown[] : asArray(value, 'bars', 'data')
  return rows.map((item) => { const row = asRecord(item); return { timestamp: stringValue(row, 't', 'timestamp', 'time') ?? '', open: numberValue(row, 'o', 'open'), high: numberValue(row, 'h', 'high'), low: numberValue(row, 'l', 'low'), close: numberValue(row, 'c', 'close'), volume: numberValue(row, 'v', 'volume') } }).filter((row) => row.timestamp)
}

export function normalizeQuote(value: unknown): Trading2Quote {
  const raw = asRecord(value); const quote = asRecord(raw.latestQuote ?? raw.quote); const trade = asRecord(raw.latestTrade ?? raw.trade); const bar = asRecord(raw.dailyBar ?? raw.bar)
  return { bid: numberValue(quote, 'bp', 'bid', 'bid_price'), ask: numberValue(quote, 'ap', 'ask', 'ask_price'), bidSize: numberValue(quote, 'bs', 'bid_size'), askSize: numberValue(quote, 'as', 'ask_size'), last: numberValue(trade, 'p', 'price') ?? numberValue(bar, 'c', 'close'), raw }
}

export function normalizeOptions(value: unknown): Trading2Option[] {
  const raw = asRecord(value); const snapshots = asRecord(raw.snapshots ?? raw.options ?? value); const items = Array.isArray(value) ? value : Object.entries(snapshots).map(([symbol, item]) => ({ ...asRecord(item), symbol }))
  return items.map((item) => { const row = asRecord(item); const quote = asRecord(row.latestQuote ?? row.quote); const greeks = asRecord(row.greeks); const bid = numberValue(quote, 'bp', 'bid'); const ask = numberValue(quote, 'ap', 'ask'); return { symbol: stringValue(row, 'symbol', 'contract_symbol'), expiration: stringValue(row, 'expiration_date', 'expiration'), strike: numberValue(row, 'strike_price', 'strike'), type: stringValue(row, 'type', 'option_type'), bid, ask, mid: numberValue(row, 'mid') ?? (bid !== undefined && ask !== undefined ? (bid + ask) / 2 : undefined), volume: numberValue(row, 'volume'), openInterest: numberValue(row, 'open_interest', 'openInterest'), impliedVolatility: numberValue(row, 'implied_volatility', 'impliedVolatility') ?? numberValue(greeks, 'implied_volatility', 'impliedVolatility'), raw: row } })
}

export const trading2Api = {
  getAccount: async () => normalizeAccount(await call('get_account')),
  getPortfolioHistory: async (period = '1M') => normalizePortfolioHistory(await call('get_portfolio_history', { period })),
  listPositions: async () => normalizePositions(await call('list_positions')),
  listOrders: async (status = 'open') => normalizeOrders(await call('list_orders', { status })),
  getNews: async (query?: Trading2NewsQuery | string[]) => {
    const args = Array.isArray(query)
      ? query.length ? { symbols: query.join(','), limit: 25 } : { limit: 25 }
      : { limit: 25, ...(query ?? {}) }
    return normalizeNews(await call('get_news', args))
  },
  listWatchlists: async () => normalizeWatchlists(await call('list_watchlists')),
  getWatchlist: async (watchlistId: string) => normalizeWatchlistRecord(await call('get_watchlist', { watchlist_id: watchlistId })),
  createWatchlist: async (name: string) => normalizeWatchlistRecord(await call('create_watchlist', { name: name.trim() })),
  addWatchlistAsset: async (watchlistId: string, symbol: string) => normalizeWatchlistRecord(await call('add_watchlist_asset', { watchlist_id: watchlistId, symbol: symbol.trim().toUpperCase() })),
  getBars: async (symbol: string, start: string, end: string, timeframe = '1Day') => normalizeBars(await call('get_stock_bars', { symbols: symbol, timeframe, start, end, feed: 'iex', adjustment: 'split', limit: 1000 }), symbol),
  getQuote: async (symbol: string) => normalizeQuote(await call('get_stock_snapshot', { symbol })),
  getOptionChain: async (symbol: string, expiration?: string) => normalizeOptions(await call('get_option_chain', { underlying_symbol: symbol, ...(expiration ? { expiration } : {}) })),
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
