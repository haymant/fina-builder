import { expect, test } from './fixtures/test'
import {
  expectKpi,
  expectKpisAgree,
  expectTileLoaded,
} from './assertions/pricer.assertions'
import { PricerPage } from './pages/PricerPage'
import { isRigaEngineReady } from './support/engines'
import { TAG } from './support/tags'

const { journey, feature } = TAG

// These specs price through a live riga-flow MCP server; they are skipped when it
// is not running so the default UI-only suite stays green.
test.beforeEach(async ({ request }) => {
  test.skip(
    !(await isRigaEngineReady(request)),
    'riga-mcp is not reachable on 127.0.0.1:8788; start it with `npm run mcp:http:riga`',
  )
})

test.use({ stubEngines: false })

test('tours the pricer dashboards from the Dashboards menu', {
  tag: [journey.pricerDashboards, feature.pricer, feature.visualizations, TAG.dependency.riga],
}, async ({ workspace }) => {
  test.setTimeout(120_000)
  const pricer = new PricerPage(workspace.page)

  await test.step('Price the payoff structure in Payoff Explorer', async () => {
    await workspace.openDashboard('Payoff Explorer')
    await expectTileLoaded(pricer, 'RigaPayoffGraph', 'query_execution_net')
    await expectKpi(pricer, 'RigaPayoffGraph', 'Nodes', /^\d+$/)
    await expectKpi(pricer, 'RigaPayoffGraph', 'Edges', /^\d+$/)
    await expectTileLoaded(pricer, 'RigaPathTimeline', 'path_series')
    await expectKpi(pricer, 'RigaPathTimeline', 'Paths', /^\d[\d,]*$/)
    await expectKpi(pricer, 'RigaPathTimeline', 'Steps', /^\d+$/)
  })

  await test.step('Inspect economics and design sensitivities in Trade Design', async () => {
    await workspace.openDashboard('Trade Design')
    await expectTileLoaded(pricer, 'RigaEconomicsImpactSummary', 'trade_design')
    await expectKpi(pricer, 'RigaEconomicsImpactSummary', 'Expected PV')
    await expectKpi(pricer, 'RigaEconomicsImpactSummary', 'KO probability', /%$/)
    await expectTileLoaded(pricer, 'RigaSensitivityTornado', 'trade_design')
    await expectTileLoaded(pricer, 'RigaParameterImpactMatrix', 'trade_design')
    await expect(pricer.tile('RigaParameterImpactMatrix').getByText('coupon rate')).toBeVisible()
  })

  await test.step('Attribute PV and payoff distribution in Risk Diagnostics', async () => {
    await workspace.openDashboard('Risk Diagnostics')
    await expectTileLoaded(pricer, 'RigaAttribution', 'explain_pv_attribution')
    await expectKpi(pricer, 'RigaAttribution', 'Total PV')
    await expectKpi(pricer, 'RigaAttribution', 'KI probability', /%$/)
    await expectTileLoaded(pricer, 'RigaPayoffHistogram', 'distributions_histogram')
    await expectKpi(pricer, 'RigaPayoffHistogram', 'Mean')
    await expectTileLoaded(pricer, 'RigaBranchFlow', 'query_execution_net')
    await expectKpi(pricer, 'RigaBranchFlow', 'Paths', /^\d[\d,]*$/)
  })

  await test.step('Check Monte Carlo convergence diagnostics', async () => {
    await workspace.openDashboard('Monte Carlo Diagnostics')
    await expect(pricer.tile('RigaStatisticsSummary')).toBeVisible()
    await expectKpi(pricer, 'RigaStatisticsSummary', 'PV')
    await expectTileLoaded(pricer, 'RigaPvConvergence', 'mc_convergence')
    await expectTileLoaded(pricer, 'RigaConvergenceHealth', 'mc_convergence')
    await expectKpi(pricer, 'RigaConvergenceHealth', 'Paths', /^\d[\d,]*$/)
  })
})

test('reprices the note after applying a trade-design preset', {
  tag: [journey.pricerDashboards, feature.pricer, TAG.dependency.riga],
}, async ({ page, workspace }) => {
  test.setTimeout(120_000)
  const pricer = new PricerPage(page)

  await workspace.openDashboard('Trade Design')
  await expectTileLoaded(pricer, 'RigaEconomicsImpactSummary', 'trade_design')
  await expectTileLoaded(pricer, 'RigaTradeEconomics', 'price_trade')

  const before = await pricer.readKpi('RigaEconomicsImpactSummary', 'Expected PV')

  await test.step('Apply the Aggressive Yield preset in the trade editor', async () => {
    const editor = pricer.tile('RigaTradeEconomics')
    await editor.getByRole('button', { name: 'Aggressive Yield' }).click()
    await expect(editor.getByLabel('Coupon / period (return)')).toHaveValue(/0\.015/)
  })

  await test.step('The pricer reprices both tiles with the same request', async () => {
    await expect
      .poll(() => pricer.readKpi('RigaEconomicsImpactSummary', 'Expected PV'), { timeout: 30_000 })
      .not.toBe(before)
    await expectKpi(pricer, 'RigaEconomicsImpactSummary', 'Expected PV')
    await expect(pricer.tile('RigaTradeEconomics').getByText('price_trade', { exact: true }).last()).toBeVisible()
    await expectKpisAgree(
      pricer,
      { type: 'RigaEconomicsImpactSummary', label: 'Expected PV' },
      { type: 'RigaTradeEconomics', label: 'PV' },
    )
  })
})

test('reviews greeks and scenario bumps in Market & Risk', {
  tag: [journey.pricerDashboards, feature.pricer, feature.risk, TAG.dependency.riga],
}, async ({ page, workspace }) => {
  test.setTimeout(120_000)
  const pricer = new PricerPage(page)

  await workspace.openDashboard('Market & Risk')
  await test.step('Read the base PV, DV01 and per-asset greeks', async () => {
    await expectTileLoaded(pricer, 'RigaRiskSummary', 'risk_batch')
    await expectKpi(pricer, 'RigaRiskSummary', 'Base PV')
    await expectKpi(pricer, 'RigaRiskSummary', 'DV01', /^-?\d/)
    await expectTileLoaded(pricer, 'RigaGreeksTable', 'risk_detailed')
    await expectKpi(pricer, 'RigaGreeksTable', 'Theta (1d)', /^-?\d/)
    await expect(pricer.tile('RigaGreeksTable').getByText('Cross-gamma')).toBeVisible()
  })

  await test.step('Reveal the scenario bumps and check they share the base valuation', async () => {
    await pricer.showAllTiles()
    await expectTileLoaded(pricer, 'RigaScenarioComparison', 'scenario')
    await expectKpi(pricer, 'RigaScenarioComparison', 'Rate up', /^-?\d/)
    await expectKpi(pricer, 'RigaScenarioComparison', 'Corr down', /^-?\d/)
    await expectKpisAgree(
      pricer,
      { type: 'RigaRiskSummary', label: 'Base PV' },
      { type: 'RigaScenarioComparison', label: 'Base PV' },
    )
  })

  await test.step('Focus the greeks tile for the full cross-gamma matrix', async () => {
    const expanded = await pricer.expand('RigaGreeksTable')
    await expect(expanded.getByText('Cross-gamma')).toBeVisible()
    await expect(expanded.getByText('Per-asset Greeks')).toBeVisible()
    await pricer.closeExpanded()
  })
})
