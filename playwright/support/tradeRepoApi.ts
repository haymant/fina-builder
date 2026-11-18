import { expect, type APIRequestContext } from '@playwright/test'

export type TradeRepoRole = 'viewer' | 'trader' | 'ops' | 'admin'

export type TradeRepoContext = {
  actor: string
  role: TradeRepoRole
}

export const ADMIN: TradeRepoContext = { actor: 'trash.box', role: 'admin' }
export const OPS: TradeRepoContext = { actor: 'olga.ops', role: 'ops' }
export const ALICE: TradeRepoContext = { actor: 'alice.sg', role: 'trader' }
export const EDDIE: TradeRepoContext = { actor: 'eddie.ldn', role: 'trader' }
export const VIEWER: TradeRepoContext = { actor: 'victor.view', role: 'viewer' }

export type TradeRepoErrorBody = {
  code: string
  message: string
  details?: Array<{ code?: string; path?: string; message?: string }>
  retryable?: boolean
  correlationId?: string
}

let rpcId = 10_000

/** Call one trade-repository MCP tool and retain the MCP error envelope. */
export async function callTradeRepoTool<T>(
  request: APIRequestContext,
  name: string,
  args: Record<string, unknown> = {},
  context: TradeRepoContext = ADMIN,
): Promise<{ data: T; isError: boolean; text: string }> {
  const response = await request.post('/trade-repo/mcp', {
    data: {
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: { name, arguments: { ...args, context } },
    },
  })
  expect(response.ok(), `${name} HTTP ${response.status()}`).toBeTruthy()
  const body = await response.json()
  expect(body.error, `${name} JSON-RPC error`).toBeUndefined()
  return {
    data: body.result.structuredContent as T,
    isError: body.result.isError === true,
    text: body.result.content?.[0]?.text ?? '',
  }
}

/** Call a tool that must succeed and return its structured content. */
export async function tradeRepoCall<T>(
  request: APIRequestContext,
  name: string,
  args: Record<string, unknown> = {},
  context: TradeRepoContext = ADMIN,
): Promise<T> {
  const result = await callTradeRepoTool<T>(request, name, args, context)
  expect(result.isError, result.text).toBe(false)
  return result.data
}

/** Call a tool that must fail and return the stable domain error. */
export async function tradeRepoError(
  request: APIRequestContext,
  name: string,
  args: Record<string, unknown> = {},
  context: TradeRepoContext = ADMIN,
): Promise<TradeRepoErrorBody> {
  const result = await callTradeRepoTool<TradeRepoErrorBody>(request, name, args, context)
  expect(result.isError, `${name} unexpectedly succeeded`).toBe(true)
  return result.data
}

export function uniqueExternalId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * A valid Phoenix autocall used by API-level contract tests. The UI defaults fill
 * the remaining template fields; API callers only need this stable core.
 */
export function phoenixTrade(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productType: 'PHOENIX_AUTOCALL',
    side: 'SELL',
    notional: 2_000_000,
    currency: 'USD',
    tradeDate: '2026-03-02',
    counterpartyId: 'CP-UOB',
    bookId: 'PHX-ASIA',
    trader: 'alice.sg',
    externalId: uniqueExternalId('API'),
    terms: {
      isin: 'XS2960012347',
      issuerId: 'LE-FINA-UK',
      basket: 'WORST_OF',
      underlyings: [
        { symbol: 'D05', name: 'DBS', initialFixing: 38.2 },
        { symbol: 'HSI', name: 'Hang Seng', initialFixing: 21000 },
      ],
      strikeDate: '2026-03-04',
      frequency: 'QUARTERLY',
      numObservations: 8,
      coupon: { ratePerPeriod: 0.025, barrier: 0.7, memory: true },
      autocall: { stepDown: 0 },
      knockIn: { barrier: 0.6, observation: 'EUROPEAN' },
    },
    ...overrides,
  }
}

export async function bookPhoenix(
  request: APIRequestContext,
  overrides: Record<string, unknown> = {},
  context: TradeRepoContext = ADMIN,
): Promise<{ tradeId: string; version: number; trade: { uti: string; externalId?: string; version: number; status: string; notional: number; bookId: string; legalEntityId: string } }> {
  return tradeRepoCall(request, 'tr_trade_book', { trade: phoenixTrade(overrides) }, context)
}
