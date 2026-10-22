import type { Page } from '@playwright/test'

/**
 * Book a Phoenix trade through the trade-repository MCP so fixing journeys have
 * a due observation that is isolated from the seeded demo book.
 */
export async function bookFixingFixture(page: Page, suffix: string): Promise<string> {
  const today = new Date().toISOString().slice(0, 10)
  const externalId = `E2E-FIXING-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const response = await page.request.post('http://127.0.0.1:4173/trade-repo/mcp', {
    data: {
      jsonrpc: '2.0',
      id: `book-${externalId}`,
      method: 'tools/call',
      params: {
        name: 'tr_trade_book',
        arguments: {
          context: { actor: 'trash.box', role: 'admin' },
          idempotencyKey: externalId,
          trade: {
            productType: 'PHOENIX_AUTOCALL',
            side: 'SELL',
            notional: 1_000_000,
            currency: 'USD',
            tradeDate: today,
            maturityDate: today,
            counterpartyId: 'CP-DBS',
            bookId: 'PHX-ASIA',
            externalId,
            terms: {
              isin: 'XS2960012347',
              underlyings: [
                { symbol: 'AAPL', initialFixing: 200 },
                { symbol: 'MSFT', initialFixing: 400 },
              ],
              strikeDate: today,
              frequency: 'QUARTERLY',
              numObservations: 4,
              coupon: { ratePerPeriod: 0.02, barrier: 0.7, memory: true },
              autocall: { initialLevel: 1, startObservation: 2, stepDown: 0.05, floor: 0.85 },
              knockIn: { barrier: 0.6, observation: 'EUROPEAN' },
            },
          },
        },
      },
    },
  })
  const rpc = await response.json()
  const result = rpc.result?.structuredContent as
    | { tradeId?: string; trade?: { tradeId: string } }
    | undefined
  if (!response.ok || rpc.result?.isError || !(result?.tradeId ?? result?.trade?.tradeId)) {
    throw new Error(
      `Could not book fixing test fixture: ${JSON.stringify(rpc.result?.structuredContent ?? rpc.error)}`,
    )
  }
  return result.tradeId ?? result.trade!.tradeId
}
