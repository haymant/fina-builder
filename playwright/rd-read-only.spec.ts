import { expect, test } from './fixtures/test'
import { TAG } from './support/tags'
import type { Page, Route } from '@playwright/test'

test.use({ stubEngines: false })
const fixtures: Record<string, unknown> = {
  rd_exp_list: { experiments: [{ experiment_id: '7', name: 'Fixture alpha signal', lifecycle_stage: 'active', run_count: 1, latest_run: { run_id: 'run-fixture', name: 'baseline', status: 'FINISHED', start_time: '2026-11-20T09:00:00Z', headline: { IC: 0.12 } }, best_headline: { IC: 0.12 } }] },
  rd_exp_get_experiment: { experiment: { experiment_id: '7', name: 'Fixture alpha signal', lifecycle_stage: 'active', run_count: 1 }, runs: [{ meta: { run_id: 'run-fixture', name: 'baseline', status: 'FINISHED', experiment_id: '7', start_time: '2026-11-20T09:00:00Z' }, params: { topk: '10' }, tags: {}, metrics: {}, metrics_latest: { IC: 0.12 }, headline: { IC: 0.12 }, notes: {}, artifacts: ['config'] }] },
  rd_exp_result: { run_id: 'run-fixture', experiment_id: '7', metrics: { IC: 0.12, ICIR: 1.4 }, headline: { IC: 0.12, ICIR: 1.4 }, ic_series: [{ date: '2026-11-19', value: 0.12 }], group_returns: {}, backtest: {}, explanation: {}, warnings: [] },
  rd_exp_input: { run_id: 'run-fixture', experiment_id: '7', dataset: { handler_kwargs: { instruments: ['AAPL', 'MSFT'], feature_fields: ['$close', '$volume'] }, features: ['$close', '$volume'], universe: ['AAPL', 'MSFT'], segments: { train: ['2026-01-01', '2026-01-03'], valid: ['2026-01-04', '2026-01-05'], test: ['2026-01-06', '2026-01-07'] } } },
  rd_exp_model: { run_id: 'run-fixture', experiment_id: '7', model_class: 'FixtureModel', tree: {}, hyperparams: {} },
  rd_exp_blotter: { run_id: 'run-fixture', experiment_id: '7', summary: {}, daily: [], positions: [], trades: [], signals: [], warnings: [] },
  rd_exp_dataset: { run_id: 'run-fixture', experiment_id: '7', group: 'train', instrument: 'AAPL', instruments: ['AAPL', 'MSFT'], columns: ['date', 'instrument', '$close', '$volume', 'label'], rows: [{ date: '2026-01-02T00:00:00', instrument: 'AAPL', '$close': 10, '$volume': 100, label: 0.1 }], page: 1, page_size: 50, total: 1, has_next: false, sort: 'asc', provenance: { source: 'run-config' }, warnings: [] },
}
async function installRdFixture(page: Page) {
  await page.route('**/rd/mcp', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { id?: number; method?: string; params?: { name?: string } }
    if (body.method === 'initialize') {
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Mcp-Session-Id': 'rd-fixture' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'rd-fixture', version: '1.0.0' } } }) })
      return
    }
    if (body.method === 'notifications/initialized') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', result: {} }) }); return }
    if (body.method === 'tools/call') {
      const payload = fixtures[body.params?.name ?? '']
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: payload === undefined ? { isError: true, structuredContent: { code: 'unknown_tool', message: 'fixture does not implement requested tool' } } : { structuredContent: payload, isError: false } }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }) })
  })
}
test('loads R&D experiment to run result workflow through browser MCP transport', { tag: [TAG.journey.rdReadOnly, TAG.feature.rd] }, async ({ page, workspace }) => {
  await installRdFixture(page)
  await page.getByTestId('menu-rd').click()
  await page.getByTestId('menuitem-rd-dashboard').click()
  await expect(page.getByTestId('rd-workspace')).toBeVisible({ timeout: 15000 })
  await expect(page.getByRole('heading', { name: 'Experiments and runs', exact: true, level: 1 })).toBeVisible()
  await expect(page.getByText('Fixture alpha signal', { exact: true })).toBeVisible()
  await expect(workspace.breadcrumb).toContainText('R&D')
  await page.getByText('baseline').click()
  await page.getByTestId('menu-rd').click()
  await page.getByRole('menuitem', { name: 'Runs', exact: true }).hover()
  await page.getByTestId('menuitem-rd-dataset').click()
  await expect(page.getByRole('heading', { name: 'Dataset rows', exact: true })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'label' })).toBeVisible()
})
