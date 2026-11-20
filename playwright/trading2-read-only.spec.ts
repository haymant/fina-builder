import { expect, test } from './fixtures/test'
import { TAG } from './support/tags'
import type { Page, Route } from '@playwright/test'

// This journey exercises the browser MCP transport rather than the test seam in
// trading2Api. The TAC process is replaced only at the HTTP boundary with a
// deterministic JSON-RPC fixture; no credentials, broker, or production data are used.
test.use({ stubEngines: false })

const fixtures: Record<string, unknown> = {
  get_account: {
    id: 'acct-fixture',
    status: 'ACTIVE',
    currency: 'USD',
    equity: '125000.50',
    cash: '100000.25',
    buying_power: '200000.00',
    daytrade_count: 1,
  },
  list_positions: {
    positions: [
      { symbol: 'AAPL', qty: '10', market_value: '1850.00', unrealized_pl: '125.50', unrealized_plpc: '0.0725' },
      { symbol: 'MSFT', qty: '5', market_value: '2100.00', unrealized_pl: '-20.00', unrealized_plpc: '-0.0094' },
    ],
  },
  list_orders: {
    orders: [{ id: 'order-fixture', symbol: 'NVDA', side: 'buy', qty: '3', type: 'limit', status: 'accepted' }],
  },
  get_news: {
    data: [{ id: 'news-fixture', title: 'Fixture market headline', source: 'Fixture Wire', symbols: ['AAPL'] }],
  },
  get_lake_watchlist: {
    watchlist: [{ symbol: 'NVDA', name: 'NVIDIA', price: '120.5', change_pct: '1.25' }],
  },
}

async function installTacFixture(page: Page) {
  await page.route('**/tac/mcp', async (route: Route) => {
    const request = route.request()
    const body = JSON.parse(request.postData() ?? '{}') as { id?: number; method?: string; params?: { name?: string } }
    if (body.method === 'initialize') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Mcp-Session-Id': 'trading2-fixture' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'tac-fixture', version: '1.0.0' } },
        }),
      })
      return
    }
    if (body.method === 'notifications/initialized') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', result: {} }) })
      return
    }
    if (body.method === 'tools/call') {
      const name = body.params?.name ?? ''
      const payload = fixtures[name]
      if (payload === undefined) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { isError: true, structuredContent: { code: 'unknown_tool', message: `fixture does not implement ${name}` } } }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: payload, isError: false } }),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }) })
  })
}

test('loads read-only Trading 2nd account workflow through browser MCP transport', {
  tag: [TAG.journey.trading2ReadOnly, TAG.feature.trading2],
}, async ({ page, workspace }) => {
  await installTacFixture(page)
  await page.getByTestId('menu-trading2').click()
  await page.getByTestId('menuitem-trading2-overview').click()

  await expect(page.getByTestId('trading2-workspace')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Trading 2ⁿᵈ overview' })).toBeVisible()
  await expect(page.getByText('125,000.50', { exact: false })).toBeVisible()
  await expect(page.getByText('AAPL')).toBeVisible()
  await expect(page.getByText('NVDA')).toBeVisible()
  await expect(page.getByText('Mutations are intentionally not enabled in this slice.')).toBeVisible()
  await expect(workspace.breadcrumb).toContainText('Trading 2ⁿᵈ')

  await page.getByTestId('menu-trading2').click()
  await page.getByTestId('menuitem-trading2-news').click()
  await expect(page.getByRole('heading', { name: 'News', exact: true })).toBeVisible()
  await expect(page.getByText('Fixture market headline')).toBeVisible()

  await page.reload()
  await expect(page.getByTestId('trading2-workspace')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'News', exact: true })).toBeVisible()
  await expect(page.getByText('Fixture market headline')).toBeVisible()
})
