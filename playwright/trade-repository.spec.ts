import { expect, test } from './fixtures/test'
import type { Page } from '@playwright/test'
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

async function bookFixingFixture(page: Page, suffix: string) {
  const today = new Date().toISOString().slice(0, 10)
  const externalId = `E2E-FIXING-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const response = await page.request.post('http://127.0.0.1:4173/trade-repo/mcp', { data: {
    jsonrpc: '2.0', id: `book-${externalId}`, method: 'tools/call', params: { name: 'tr_trade_book', arguments: {
      context: { actor: 'trash.box', role: 'admin' }, idempotencyKey: externalId,
      trade: { productType: 'PHOENIX_AUTOCALL', side: 'SELL', notional: 1_000_000, currency: 'USD', tradeDate: today, maturityDate: today, counterpartyId: 'CP-DBS', bookId: 'PHX-ASIA', externalId,
        terms: { isin: 'XS2960012347', underlyings: [{ symbol: 'AAPL', initialFixing: 200 }, { symbol: 'MSFT', initialFixing: 400 }], strikeDate: today, frequency: 'QUARTERLY', numObservations: 4, coupon: { ratePerPeriod: 0.02, barrier: 0.7, memory: true }, autocall: { initialLevel: 1, startObservation: 2, stepDown: 0.05, floor: 0.85 }, knockIn: { barrier: 0.6, observation: 'EUROPEAN' } },
      },
    } },
  } })
  const rpc = await response.json()
  const result = rpc.result?.structuredContent as { tradeId?: string; trade?: { tradeId: string } } | undefined
  if (!response.ok || rpc.result?.isError || !(result?.tradeId ?? result?.trade?.tradeId)) throw new Error(`Could not book fixing test fixture: ${JSON.stringify(rpc.result?.structuredContent ?? rpc.error)}`)
  return result.tradeId ?? result.trade!.tradeId
}

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

  await test.step('Open the scheduled fixing queue', async () => {
    await repository.openView('fixings')
    await expect(repository.fixings).toBeVisible()
    await expect(page.getByTestId('fixing-as-of-date')).toBeVisible()
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


test('publishes aggregated positions as the canonical portfolio-risk handoff', {
  tag: [journey.portfolioRiskHandoff, journey.tradePositions, feature.tradeRepository, feature.tradePositions, feature.portfolioRisk, feature.positionSnapshot],
}, async ({ page, repository }) => {
  await repository.openView('positions')
  await expectPositionsAggregated(repository)
  await expect(repository.positionsSummary).toContainText(/positions from \d+ live trades/)

  const snapshotCall = page.waitForResponse((response) => {
    const body = response.request().postData() ?? ''
    return response.url().includes('/trade-repo/mcp') && body.includes('tr_position_snapshot')
  })
  await page.getByTestId('risk-snapshot').click()
  const response = await snapshotCall
  const rpc = await response.json()
  const snapshot = rpc.result.structuredContent as {
    schema: string
    id: string
    version: string
    links: { trades: string[] }
    payload: { positions: Array<{ positionId: string; instrumentVersion: string; quantity: number }> }
  }

  expect(snapshot).toMatchObject({ schema: 'fina.position-snapshot/v1', id: 'fina:position-snapshot:all' })
  expect(snapshot.version).toMatch(/^h:[a-f\d]+$/)
  expect(snapshot.payload.positions.length).toBeGreaterThan(0)
  expect(snapshot.payload.positions.every((position) => position.positionId && position.instrumentVersion && Number.isFinite(position.quantity))).toBe(true)
  expect(snapshot.links.trades.length).toBe(snapshot.payload.positions.length)
  await expect(page.getByTestId('snapshot-result')).toContainText(/fina\.position-snapshot\/v1/)
})

test('shows bitemporal read-only mode and hides writes for viewers', {
  tag: [journey.tradeBlotter, feature.tradeRepository, feature.bitemporal, feature.entitlements],
}, async ({ page, repository }) => {
  await repository.openView('blotter')
  const tradeId = await repository.openFirstTrade()
  await expectTradeDrawerOpen(repository, tradeId)

  await page.getByTestId('time-travel-toggle').click()
  await page.getByTestId('as-of-valid').fill('2026-10-20')
  await expect(page.getByTestId('asof-banner')).toContainText('Editing is disabled')
  await expect(page.getByTestId('new-trade')).toHaveCount(0)
  await expect(page.getByTestId('action-AMEND')).toHaveCount(0)

  await page.getByTestId('user-select').selectOption('victor.view')
  await expect(page.getByTestId('new-trade')).toHaveCount(0)
  await expect(page.getByTestId('action-AMEND')).toHaveCount(0)
})

test('reviews immutable trade events and field-level version differences', {
  tag: [journey.tradeHistory, feature.tradeRepository, feature.tradeHistory, feature.tradeLifecycle],
}, async ({ page, repository }) => {
  await repository.openView('blotter')
  await repository.search('PHX-1006')
  const tradeId = await repository.openFirstTrade()
  await expectTradeDrawerOpen(repository, tradeId)

  await page.getByTestId('drawer-tab-timeline').click()
  await expect(page.getByTestId('timeline-event').nth(1)).toBeVisible()
  await expect(page.getByTestId('timeline')).toContainText(/AMEND/)

  await page.getByTestId('drawer-tab-diff').click()
  await expect(page.getByTestId('diff-row').first()).toBeVisible()
  await expect(page.getByTestId('diff-row').first()).toContainText(/productState\.|terms\.|notional|status/i)
})

test('requires an audited comment before reconciliation breaks can be resolved', {
  tag: [journey.tradeReconciliation, feature.tradeRepository, feature.tradeRecon, feature.tradeAudit],
}, async ({ page, repository }) => {
  await repository.openView('recon')
  const firstBreak = repository.recon.locator('.ag-row').first()
  await expect(firstBreak).toBeVisible()
  await firstBreak.click()
  await expect(page.getByTestId('break-panel')).toBeVisible()

  await page.getByTestId('break-to-RESOLVED').click()
  await expect(page.getByTestId('break-error')).toContainText(/VALIDATION_FAILED/)
  await expect(page.getByTestId('break-status')).not.toHaveText('RESOLVED')

  await page.getByTestId('break-comment').fill('Confirmed against the signed counterparty statement.')
  await page.getByTestId('break-to-RESOLVED').click()
  await expect(page.getByTestId('break-status')).toHaveText('RESOLVED')
  await expect(page.getByTestId('break-panel')).toContainText('Confirmed against the signed counterparty statement.')
})

test('filters immutable audit history by action', {
  tag: [journey.tradeGovernance, feature.tradeRepository, feature.tradeAudit],
}, async ({ page, repository }) => {
  await repository.openView('audit')
  await expectAuditLoaded(repository)
  await page.getByTestId('audit-action').selectOption('trade.amend')
  await expect(repository.audit.locator('.ag-row').first()).toBeVisible()
  await expect(repository.auditCount).toContainText(/entries \(append-only\)/)
})

test('preserves a saved blotter view and applies client-side grouping', {
  tag: [journey.tradeBlotter, feature.tradeRepository, feature.tradeBlotter, feature.savedViews],
}, async ({ page, repository }) => {
  await repository.openView('blotter')
  await expectBlotterLoaded(repository)
  await page.getByTestId('facet-status-LIVE').click()
  await expect(page.getByTestId('facet-status-LIVE')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('group-by').selectOption('bookId')
  await expect(page.getByTestId('group-row').first()).toBeVisible()

  page.once('dialog', (dialog) => void dialog.accept('E2E Live books'))
  await page.getByTestId('save-view').click()
  await expect(page.getByTestId('view-select')).toContainText('E2E Live books')
  await page.getByTestId('view-select').selectOption('all')
  await page.getByTestId('view-select').selectOption({ label: 'E2E Live books ★' })
  await expect(page.getByTestId('facet-status-LIVE')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('group-by')).toHaveValue('bookId')
})

test('keeps all-or-nothing imports blocked when dry-run validation finds a bad row', {
  tag: [journey.tradeOperations, feature.tradeRepository, feature.tradeImport],
}, async ({ page, repository }) => {
  await repository.openView('import')
  const csv = [
    'productType,side,notional,tradeDate,counterpartyId,bookId,externalId,terms.isin,terms.underlyings[0].symbol,terms.underlyings[0].initialFixing,terms.underlyings[1].symbol,terms.underlyings[1].initialFixing,terms.strikeDate,terms.frequency,terms.numObservations,terms.coupon.ratePerPeriod,terms.coupon.barrier,terms.knockIn.barrier',
    `PHOENIX_AUTOCALL,SELL,2000000,2026-03-02,CP-UOB,PHX-ASIA,DRY-${Date.now()},XS2960012347,D05,38.2,HSI,21000,2026-03-04,QUARTERLY,8,0.025,0.7,0.6`,
    `PHOENIX_AUTOCALL,SELL,-10,2026-03-02,CP-UOB,PHX-ASIA,BAD-${Date.now()},XS2960012354,D05,38.2,HSI,21000,2026-03-04,QUARTERLY,8,0.025,0.7,0.6`,
  ].join('\n')

  await page.getByTestId('import-csv').fill(csv)
  await page.getByTestId('import-validate').click()
  await expect(page.getByTestId('import-summary')).toContainText(/1 valid, 1 with errors/)
  await expect(page.getByTestId('import-commit')).toBeDisabled()
  await page.getByTestId('import-mode').selectOption('best-effort')
  await expect(page.getByTestId('import-commit')).toBeEnabled()
})


test('books, amends, and cancels a trade with versioned audit reasons', {
  tag: [TAG.priority.p0, journey.tradeOperations, journey.tradeHistory, feature.tradeRepository, feature.tradeLifecycle, feature.tradeHistory],
}, async ({ page, repository }) => {
  await repository.openView('blotter')
  await page.getByTestId('new-trade').click()
  await expect(page.getByTestId('trade-form')).toBeVisible()
  await expect(page.getByTestId('submit-trade')).toBeDisabled()

  const today = new Date().toISOString().slice(0, 10)
  await page.getByTestId('f-notional').fill('2000000')
  await page.getByTestId('f-tradeDate').fill(today)
  await page.getByTestId('f-externalId').fill(`E2E-${Date.now()}`)
  await page.getByTestId('t-isin').fill('XS2960012347')
  await page.getByTestId('t-underlyings-add').click()
  await page.getByTestId('t-underlyings-add').click()
  await page.getByTestId('t-underlyings-0-symbol').fill('AAPL')
  await page.getByTestId('t-underlyings-0-initialFixing').fill('190')
  await page.getByTestId('t-underlyings-1-symbol').fill('MSFT')
  await page.getByTestId('t-underlyings-1-initialFixing').fill('420')
  await page.getByTestId('t-strikeDate').fill(today)
  await page.getByTestId('t-coupon-ratePerPeriod').fill('2.5')
  await expect(page.getByTestId('submit-trade')).toBeEnabled({ timeout: 10_000 })
  await page.getByTestId('submit-trade').click()

  const drawer = page.getByTestId('trade-drawer')
  await expect(drawer).toBeVisible()
  const tradeId = (await page.getByTestId('drawer-trade-id').textContent())?.trim() ?? ''
  expect(tradeId).toMatch(/^TR-\d+$/)
  await expect(page.getByTestId('drawer-version')).toHaveText('v1')

  await page.getByTestId('action-AMEND').click()
  await expect(page.getByTestId('trade-form')).toBeVisible()
  await page.getByTestId('f-trader').fill('e2e.trader')
  await page.getByTestId('f-reason').fill('Trader reassignment verified in E2E')
  await expect(page.getByTestId('amend-kind')).toContainText('Non-economic')
  await expect(page.getByTestId('submit-trade')).toBeEnabled()
  await page.getByTestId('submit-trade').click()
  await expect(page.getByTestId('drawer-version')).toHaveText('v2')

  await page.getByTestId('drawer-tab-timeline').click()
  await expect(page.getByTestId('timeline')).toContainText('Trader reassignment verified in E2E')
  await expect(page.getByTestId('timeline')).toContainText('NON ECONOMIC')

  await page.getByTestId('action-CANCEL').click()
  await expect(page.getByTestId('lifecycle-dialog')).toBeVisible()
  await page.getByTestId('confirm-lifecycle').click()
  await expect(page.getByTestId('lifecycle-error')).toContainText(/VALIDATION_FAILED/)
  await page.getByTestId('l-reason').fill('Booked in error during automated verification')
  await page.getByTestId('confirm-lifecycle').click()
  await expect(page.getByTestId('drawer-status')).toHaveText('CANCELLED')
})

test('exports the filtered blotter and opens trade shortcuts from the keyboard', {
  tag: [journey.tradeBlotter, feature.tradeRepository, feature.tradeBlotter],
}, async ({ page, repository }) => {
  await repository.openView('blotter')
  await expectBlotterLoaded(repository)
  const downloadStarted = page.waitForEvent('download')
  await page.getByTestId('export-csv').click()
  const download = await downloadStarted
  expect(download.suggestedFilename()).toMatch(/^trades-\d{4}-\d{2}-\d{2}\.csv$/)

  await page.keyboard.press('n')
  await expect(page.getByTestId('trade-form')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('trade-form')).toHaveCount(0)
  await page.getByTestId('shortcuts').click()
  await expect(page.getByTestId('shortcuts-dialog')).toContainText('Focus blotter search')
  await expect(page.getByTestId('shortcuts-dialog')).toContainText('Show shortcuts')
})


test('captures one due instrument fixing through the trade lifecycle dialog with source evidence', {
  tag: [TAG.priority.p1, journey.tradeFixingCapture, feature.tradeRepository, feature.tradeFixings, feature.tradeLifecycle, feature.fixingDueQueue],
}, async ({ page, repository }) => {
  const tradeId = await bookFixingFixture(page, 'individual')
  await repository.openView('fixings')
  const dueCall = page.waitForResponse((response) => (response.request().postData() ?? '').includes('tr_fixing_due'))
  await page.getByTestId('fixing-as-of-date').fill('2035-12-31')
  await dueCall
  await expect(repository.fixings.locator('[data-testid^="due-fixing-"]').first()).toBeVisible()

  const candidate = await repository.fixings.locator(`[data-testid="due-fixing-${tradeId}"]`).evaluate((node) => {
    const testId = node?.getAttribute('data-testid')
    return node && testId ? { tradeId: testId.slice('due-fixing-'.length), n: Number(node.getAttribute('data-fixing-n')), date: node.getAttribute('data-observation-date') } : null
  })
  expect(candidate).toBeTruthy()
  if (!candidate) throw new Error('No non-terminal due observation available for the individual fixing journey')

  await page.getByTestId(`open-fixing-trade-${candidate.tradeId}`).click()
  await expectTradeDrawerOpen(repository, candidate.tradeId)
  await page.getByTestId('action-FIXING').click()
  await expect(page.getByTestId('lifecycle-dialog')).toBeVisible()
  await expect(page.getByTestId('p-n')).toHaveValue(String(candidate.n))
  for (const input of await page.locator('input[data-testid^="p-levels-"]').all()) await input.fill('100')
  await page.getByTestId('p-source').fill('E2E official exchange close')
  await page.getByTestId('p-sourceObservedAt').fill(`${candidate.date}T20:00:00Z`)
  await page.getByTestId('p-evidenceRef').fill(`e2e-feed:${candidate.tradeId}:${candidate.n}`)
  await page.getByTestId('l-reason').fill('Verified against the close message in the fixing workflow test')

  const fixingCall = page.waitForResponse((response) => {
    const body = response.request().postData() ?? ''
    return response.url().includes('/trade-repo/mcp') && body.includes('tr_trade_lifecycle') && body.includes('FIXING')
  })
  await page.getByTestId('confirm-lifecycle').click()
  const response = await fixingCall
  const rpc = await response.json()
  const outcome = rpc.result.structuredContent as { events: { eventType: string; detail?: Record<string, unknown> }[]; replayed?: boolean }
  expect(outcome.events.map((event) => event.eventType)).toContain('FIXING')
  const fixing = outcome.events.find((event) => event.eventType === 'FIXING')!
  expect(fixing.detail).toMatchObject({ source: 'E2E official exchange close', sourceObservedAt: `${candidate.date}T20:00:00Z`, evidenceRef: `e2e-feed:${candidate.tradeId}:${candidate.n}` })
  await expect(repository.drawer).toBeVisible()
})

test('previews and atomically commits a bulk of scheduled observations with per-row provenance', {
  tag: [TAG.priority.p1, journey.tradeFixingCapture, feature.tradeRepository, feature.tradeFixings, feature.fixingDueQueue],
}, async ({ page, repository }) => {
  const tradeIds = [await bookFixingFixture(page, 'bulk-a'), await bookFixingFixture(page, 'bulk-b')]
  await repository.openView('fixings')
  const dueCall = page.waitForResponse((response) => (response.request().postData() ?? '').includes('tr_fixing_due'))
  await page.getByTestId('fixing-as-of-date').fill('2035-12-31')
  await dueCall
  const rows = repository.fixings.locator('[data-testid^="due-fixing-"]')
  await expect(rows.first()).toBeVisible()
  const trades = await Promise.all(tradeIds.map(async (tradeId) => ({ tradeId, date: await page.getByTestId(`due-fixing-${tradeId}`).getAttribute('data-observation-date') ?? '' })))
  expect(trades.length).toBe(2)

  for (const trade of trades) {
    const row = page.getByTestId(`due-fixing-${trade.tradeId}`)
    await page.getByTestId(`select-fixing-${trade.tradeId}`).check()
    for (const input of await row.locator('input[data-testid^="fixing-level-"]').all()) await input.fill('100')
    await page.getByTestId(`fixing-source-${trade.tradeId}`).fill('E2E official exchange close')
    await page.getByTestId(`fixing-observed-at-${trade.tradeId}`).fill(`${trade.date}T20:00:00Z`)
    await page.getByTestId(`fixing-evidence-${trade.tradeId}`).fill(`e2e-batch:${trade.tradeId}`)
  }

  await page.getByTestId('fixing-preview').click()
  await expect(page.getByTestId('fixing-batch-summary')).toContainText('2 valid, 0 with errors')
  await expect(page.getByTestId('fixing-commit')).toBeEnabled()
  const commitCall = page.waitForResponse((response) => {
    const body = response.request().postData() ?? ''
    return body.includes('tr_fixings_bulk') && body.includes('"dryRun":false')
  })
  await page.getByTestId('fixing-commit').click()
  const response = await commitCall
  const rpc = await response.json()
  const result = rpc.result.structuredContent as { committed: number; failed: number; results: { status: string; events: { eventType: string; detail?: Record<string, unknown> }[] }[] }
  expect(result).toMatchObject({ committed: 2, failed: 0 })
  expect(result.results.every((item) => item.status === 'COMMITTED')).toBe(true)
  expect(result.results.every((item) => item.events.some((event) => event.eventType === 'FIXING' && event.detail?.source === 'E2E official exchange close'))).toBe(true)
  await expect(page.getByTestId('fixing-batch-summary')).toContainText('2 committed')
})
