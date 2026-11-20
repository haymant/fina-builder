import { expect, test } from './fixtures/test'
import { TAG } from './support/tags'
import type { Page, Route } from '@playwright/test'

test.use({ stubEngines: false })
const fixtures: Record<string, unknown> = {
  riskcube_capabilities: { engine: 'fixture-olap', version: '1.0', schema: 'fina.risk-report/v1', dimensions: ['scenario_key', 'underlying'], measures: ['pv_amount', 'delta'], aggregations: ['sum'], max_rows: 100, max_cells: 1000 },
  risk_cube_partitions: { partitions: [{ partition_id: 'part-1', version_id: 'v1', scenario_id: 'base', name: 'Fixture base partition', cell_count: 2, instance_count: 1, source: 'fixture' }] },
  olap_query: { schema: 'fina.risk-report/v1', query: { scope: { partition_id: 'part-1' }, dimensions: ['scenario_key', 'underlying'], measures: ['pv_amount', 'delta'], aggregation: 'sum', filters: [], limit: 100 }, scope: { partition_id: 'part-1' }, columns: [{ key: 'scenario_key', label: 'Scenario', wire_type: 'string' }, { key: 'pv_amount', label: 'PV', wire_type: 'decimal', unit: 'currency_amount', currency: 'USD' }, { key: 'delta', label: 'Delta', wire_type: 'decimal' }], rows: [['base', '1250000.125', '-430.5']], totals: null, truncated: false, warnings: [], assumptions: [], limitations: [], provenance: { snapshot_id: 'snap-fixture' }, lineage: {}, engine_run_id: 'run-fixture', snapshot_id: 'snap-fixture' },
}
async function installFixture(page: Page) {
  await page.route('**/riskcube/mcp', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { id?: number; method?: string; params?: { name?: string } }
    if (body.method === 'initialize') { await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Mcp-Session-Id': 'riskcube-fixture' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'riskcube-fixture', version: '1.0' } } }) }); return }
    if (body.method === 'notifications/initialized') { await route.fulfill({ status: 202, contentType: 'application/json', body: '' }); return }
    if (body.method === 'tools/call') { const payload = fixtures[body.params?.name ?? '']; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: payload, isError: false, content: [] } }) }); return }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }) })
  })
}
test('loads the read-only RiskCube partition to semantic cube and slice workflow', { tag: [TAG.journey.riskCubeReadOnly, TAG.feature.riskCube] }, async ({ page, workspace }) => {
  await installFixture(page)
  await page.getByTestId('menu-riskcube').click(); await page.getByTestId('menuitem-riskcube-cubes').click()
  await expect(page.getByTestId('riskcube-workspace')).toBeVisible(); await expect(page.getByRole('heading', { name: 'Cubes', exact: true })).toBeVisible()
  await expect(page.getByText('Fixture base partition')).toBeVisible(); await expect(workspace.breadcrumb).toContainText('RiskCube')
  await page.getByRole('button', { name: /Fixture base partition/ }).click(); await expect(page.getByText('1250000.125')).toBeVisible(); await expect(page.getByText('snap-fixture')).toBeVisible()
  await page.getByLabel('Slice selection').selectOption('stress-up'); await expect(page.getByText('No arbitrary SQL, URI, filesystem path, or engine configuration reaches the service.')).toBeVisible()
  await page.reload(); await expect(page.getByTestId('riskcube-workspace')).toBeVisible(); await expect(page.getByRole('heading', { name: 'Cubes', exact: true })).toBeVisible()
})
