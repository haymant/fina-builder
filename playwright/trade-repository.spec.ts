import { expect, test } from './fixtures/test'
import {
  expectAuditLoaded,
  expectBlotterLoaded,
  expectPositionsAggregated,
  expectReconciliationLoaded,
  expectTradeDrawerOpen,
  expectTradeRepositoryOpen,
} from './assertions/tradeRepository.assertions'
import { TAG } from './support/tags'

const { journey, feature } = TAG

test('navigates every trade repository dashboard from the Trades menu', {
  tag: [TAG.smoke, journey.tradeNavigation, feature.tradeRepository],
}, async ({ page, repository, workspace }) => {
  await test.step('Open the blotter from the Trades menu', async () => {
    await repository.openView('blotter')
    await expectTradeRepositoryOpen(repository)
    await expectBlotterLoaded(repository)
  })

  await test.step('Open the positions dashboard', async () => {
    await repository.openView('positions')
    await expectPositionsAggregated(repository)
  })

  await test.step('Open the reconciliation dashboard', async () => {
    await repository.openView('recon')
    await expectReconciliationLoaded(repository)
  })

  await test.step('Open the audit log dashboard', async () => {
    await repository.openView('audit')
    await expectAuditLoaded(repository)
  })

  await test.step('Open the bulk import dashboard', async () => {
    await repository.openView('import')
    await expect(repository.bulkImport).toBeVisible()
    await expect(page.getByTestId('import-validate')).toBeDisabled()
  })

  await test.step('Return to a tile dashboard from the Dashboards menu', async () => {
    await workspace.openDashboard('Playwright Dashboard')
    await expect(workspace.emptyDashboardMessage).toBeVisible()
  })
})

test('searches the blotter and opens a trade in the drawer', {
  tag: [journey.tradeBlotter, feature.tradeRepository, feature.tradeBlotter],
}, async ({ page, repository }) => {
  await repository.openView('blotter')
  await expectBlotterLoaded(repository)

  const before = await repository.rows().count()
  expect(before).toBeGreaterThan(0)

  await test.step('Filter the blotter with the server-side search', async () => {
    await repository.search('PHX-')
    await expect(repository.blotterCount).toContainText(/\d+ trades?/)
  })

  await test.step('Open the first matching trade in the drawer', async () => {
    const tradeId = await repository.openFirstTrade()
    await expectTradeDrawerOpen(repository, tradeId)
    await expect(page.getByTestId('drawer-version')).toHaveText(/v\d+/)
  })

  await test.step('Close the drawer and clear the search', async () => {
    await page.keyboard.press('Escape')
    await expect(repository.drawer).toHaveCount(0)
    await repository.blotterSearch.fill('')
    await expect.poll(() => repository.rows().count()).toBeGreaterThan(0)
  })
})

test('drills from a position into the blotter', {
  tag: [journey.tradePositions, feature.tradeRepository, feature.tradePositions],
}, async ({ page, repository }) => {
  await repository.openView('positions')
  await expectPositionsAggregated(repository)

  await test.step('Choose the dimensions to aggregate by', async () => {
    // Book, basket and currency are selected by default; add counterparty.
    await page.getByTestId('dim-counterpartyId').click()
    await expect(page.getByTestId('dim-counterpartyId')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByTestId('dim-underlying')).toHaveAttribute('aria-pressed', 'true')
  })

  await test.step('Drill into the trades behind a position', async () => {
    const row = repository.positions.locator('.ag-row').first()
    await expect(row).toBeVisible()
    await row.dblclick()
    await expect(page.getByTestId('drill-banner')).toContainText(/Position drill-down: \d+ trades/)
    await expect(repository.blotter).toBeVisible()
    await expect(repository.breadcrumb).toContainText('Blotter')
  })
})

test('validates a bulk import as a dry run before committing', {
  tag: [journey.tradeOperations, feature.tradeRepository, feature.tradeImport],
}, async ({ page, repository }) => {
  await repository.openView('import')
  const csv = [
    'productType,side,notional,tradeDate,counterpartyId,bookId,externalId,terms.isin,terms.underlyings[0].symbol,terms.underlyings[0].initialFixing,terms.underlyings[1].symbol,terms.underlyings[1].initialFixing,terms.strikeDate,terms.frequency,terms.numObservations,terms.coupon.ratePerPeriod,terms.coupon.barrier,terms.knockIn.barrier',
    `PHOENIX_AUTOCALL,SELL,2000000,2026-03-02,CP-UOB,PHX-ASIA,E2E-IMP-${Date.now()},XS2960012347,D05,38.2,HSI,21000,2026-03-04,QUARTERLY,8,0.025,0.7,0.6`,
  ].join('\n')

  await test.step('Validate a Phoenix row as a dry run', async () => {
    await page.getByTestId('import-csv').fill(csv)
    await page.getByTestId('import-validate').click()
    await expect(page.getByTestId('import-summary')).toContainText('Dry run: 1 valid, 0 with errors')
  })

  await test.step('Commit unlocks once the dry run is clean', async () => {
    await expect(page.getByTestId('import-commit')).toBeEnabled()
  })
})
