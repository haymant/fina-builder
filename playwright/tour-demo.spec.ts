import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { expect, test } from './fixtures/test'
import { NotebookPanel } from './components/NotebookPanel'
import {
  expectAuditLoaded,
  expectBlotterLoaded,
  expectPositionsAggregated,
  expectReconciliationLoaded,
  expectTradeDrawerOpen,
} from './assertions/tradeRepository.assertions'
import { expectTileLoaded } from './assertions/pricer.assertions'
import { PricerPage } from './pages/PricerPage'
import { isRigaEngineReady } from './support/engines'
import {
  expectEmptyDashboard,
  expectNotebookOpen,
  expectSelectedNoteTitle,
  expectWorkspaceReady,
} from './assertions/workspace.assertions'
import { TAG } from './support/tags'

const CUE_OUT = join(process.cwd(), 'playwright', 'recordings', 'tour', 'cues.json')

test.describe('complete guided tour', () => {
  test.use({ stubEngines: false })

  test.beforeEach(async ({ request }) => {
    test.skip(
      !(await isRigaEngineReady(request)),
      'riga-mcp is not reachable on 127.0.0.1:8788; start it with `npm run mcp:http:riga`',
    )
  })

  test('tours every user journey in one narrated walkthrough', {
    tag: [
      TAG.demo.any,
      TAG.demo.tour,
      TAG.priority.p0,
      TAG.dependency.riga,
      TAG.journey.dashboardReview,
      TAG.journey.dashboardSetup,
      TAG.journey.notebookCapture,
      TAG.journey.visualizationAdd,
      TAG.journey.preferences,
      TAG.journey.pricerDashboards,
      TAG.journey.riskReview,
      TAG.journey.tradeNavigation,
      TAG.journey.tradeBlotter,
      TAG.journey.tradeCapture,
      TAG.journey.tradeHistory,
      TAG.journey.tradeLifecycle,
      TAG.journey.tradePositions,
      TAG.journey.portfolioRiskHandoff,
      TAG.journey.tradeReconciliation,
      TAG.journey.tradeGovernance,
      TAG.journey.tradeImportExport,
      TAG.journey.tradeEntitlements,
      TAG.journey.tradeKeyboard,
      TAG.feature.workspace,
      TAG.feature.dashboards,
      TAG.feature.templates,
      TAG.feature.visualizations,
      TAG.feature.notebook,
      TAG.feature.theme,
      TAG.feature.pricer,
      TAG.feature.risk,
      TAG.feature.valuation,
      TAG.feature.sensitivities,
      TAG.feature.scenarios,
      TAG.feature.pnlAttribution,
      TAG.feature.tradeRepository,
      TAG.feature.tradeBlotter,
      TAG.feature.tradeCapture,
      TAG.feature.tradeForms,
      TAG.feature.tradePositions,
      TAG.feature.tradeHistory,
      TAG.feature.tradeLifecycle,
      TAG.feature.tradeRecon,
      TAG.feature.tradeAudit,
      TAG.feature.tradeImport,
      TAG.feature.tradeExport,
      TAG.feature.tradeProductTemplates,
      TAG.feature.tradeReferenceData,
      TAG.feature.tradePricingLink,
      TAG.feature.tradeKeyboard,
      TAG.feature.tradeErrors,
      TAG.feature.portfolioRisk,
      TAG.feature.positionSnapshot,
      TAG.feature.bitemporal,
      TAG.feature.entitlements,
      TAG.feature.savedViews,
    ],
  }, async ({ page, workspace, repository }) => {
    test.setTimeout(600_000) // Paced holds are intentional in demo recordings.
    const t0 = Date.now()
    const marks: Array<{ atMs: number; label: string }> = []
    const mark = (label: string) => {
      marks.push({ atMs: Date.now() - t0, label })
      console.log(`[tour] ${String(Date.now() - t0).padStart(6)}ms  ${label}`)
    }
    const hold = async (ms: number, label: string) => {
      mark(label)
      await page.waitForTimeout(ms)
    }

    await test.step('Dashboard review: open the workspace', async () => {
      await expectWorkspaceReady(workspace)
      await expectEmptyDashboard(workspace, 'Playwright Dashboard')
      await hold(4_500, 'Opening the workspace and the empty Playwright dashboard')
    })

    await test.step('Dashboard setup: create a blank dashboard', async () => {
      const templates = await workspace.openTemplates()
      await expect(templates.heading).toBeVisible()
      await hold(2_500, 'The File menu opens the dashboard template gallery')
      await templates.createBlankDashboard()
      await expectEmptyDashboard(workspace, 'Untitled Dashboard')
      await hold(2_000, 'A blank dashboard is created and the dashboard notebook opens')
    })

    const notebook = new NotebookPanel(page)
    await test.step('Notebook capture: record a trade idea', async () => {
      await expectNotebookOpen(notebook)
      await hold(2_500, 'The dashboard notebook holds usage notes and free-form research')
      const note = await notebook.createNote()
      await note.click()
      await expectSelectedNoteTitle(notebook, 'New Note')
      await notebook.renameSelectedNote('Phoenix trade idea')
      await expectSelectedNoteTitle(notebook, 'Phoenix trade idea')
      await hold(3_500, 'A new note captures the Phoenix trade idea next to the dashboard')
      await page.getByTitle('Collapse notebook').click()
    })

    await test.step('Visualization add: add and inspect the Payoff Petri Net', async () => {
      const gallery = await workspace.openTileGallery()
      await expect(gallery.heading).toBeVisible()
      await hold(2_000, 'Add tile opens the visualization gallery')
      await gallery.search('Payoff Petri Net')
      await hold(1_500, 'Filtering to the Payoff Petri Net')
      await gallery.addTile('Payoff Petri Net')
      await expect(page.getByRole('heading', { name: 'Payoff Petri Net' })).toBeVisible()
      await hold(2_000, 'The live engine renders the execution Petri net')
      await page.getByTitle('Expand').click()
      const expanded = page.getByTestId('expanded-tile')
      await expect(expanded).toBeVisible()
      await expanded.locator('.react-flow__controls-zoomin').click()
      await expanded.locator('.react-flow__controls-zoomin').click()
      await hold(2_500, 'The focused view exposes the full execution graph')
      await expanded.getByRole('button', { name: 'Risk', exact: true }).click()
      await hold(1_500, 'The risk layer tints the net by exposure')
      await expanded.getByRole('button', { name: 'Explain', exact: true }).click()
      await hold(2_500, 'The explain layer links every valuation to evidence')
      await expanded.getByRole('button', { name: 'Close focused view' }).click()
    })

    await test.step('Preferences: switch theme', async () => {
      await page.getByRole('button', { name: 'Toggle theme' }).click()
      await hold(2_000, 'The theme preference switches the whole workspace')
    })

    await test.step('Pricer dashboards: pricing, design and risk', async () => {
      const pricer = new PricerPage(page)
      await workspace.openDashboard('Payoff Explorer')
      await expectTileLoaded(pricer, 'RigaPayoffGraph', 'query_execution_net')
      await hold(2_500, 'Payoff Explorer starts with the priced execution pipeline')
      await pricer.expand('RigaPayoffGraph')
      await hold(2_000, 'The full product graph shows the path-dependent events')
      await pricer.closeExpanded()

      await workspace.openDashboard('Trade Design')
      await expectTileLoaded(pricer, 'RigaEconomicsImpactSummary', 'trade_design')
      await hold(2_000, 'Trade Design links editable terms to base economics')
      const tradeDesign = await pricer.expand('RigaTradeEconomics')
      await hold(1_500, 'The trade economics are editable')
      await tradeDesign.getByRole('button', { name: 'Aggressive Yield' }).click()
      await tradeDesign.getByTestId('kpi-pv').scrollIntoViewIfNeeded()
      await hold(2_000, 'A preset reprice updates PV from the live engine')
      await pricer.closeExpanded()

      await workspace.openDashboard('Risk Diagnostics')
      await expectTileLoaded(pricer, 'RigaAttribution', 'explain_pv_attribution')
      await hold(2_500, 'Risk Diagnostics attributes PV and shows the payoff distribution')

      await workspace.openDashboard('Market & Risk')
      await expectTileLoaded(pricer, 'RigaRiskSummary', 'risk_batch')
      await hold(2_000, 'Market and Risk summarizes greeks and scenario bumps')
      await pricer.expand('RigaGreeksTable')
      await hold(2_500, 'Theta, rho and the cross-gamma matrix complete the risk review')
      await pricer.closeExpanded()
    })

    await test.step('Trade navigation: open the trade repository', async () => {
      await repository.openView('blotter')
      await expectBlotterLoaded(repository)
      await hold(2_500, 'The Trades menu opens the booked trade blotter')
    })

    await test.step('Trade blotter: filter, group, save and export', async () => {
      await page.getByTestId('facet-status-LIVE').click()
      await hold(1_500, 'Facets filter server-side to live trades')
      await page.getByTestId('group-by').selectOption('bookId')
      await expect(page.getByTestId('group-row').first()).toBeVisible()
      await hold(1_800, 'Grouping rolls the blotter up by book')
      await page.getByTestId('group-by').selectOption('')
      await page.getByTestId('facet-status-LIVE').click()
      page.once('dialog', (dialog) => void dialog.accept('Tour live books'))
      await page.getByTestId('save-view').click()
      await expect(page.getByTestId('view-select')).toContainText('Tour live books')
      await hold(1_500, 'The current filters and grouping are saved as a reusable view')
      await page.getByTestId('view-select').selectOption('all')
      const download = page.waitForEvent('download')
      await page.getByTestId('export-csv').click()
      expect((await download).suggestedFilename()).toMatch(/^trades-\d{4}-\d{2}-\d{2}\.csv$/)
      await hold(1_500, 'CSV export downloads the exact filtered result set')
    })

    await test.step('Trade history: timeline, diff and bitemporal time travel', async () => {
      await repository.search('PHX-1006')
      const tradeId = await repository.openFirstTrade()
      await expectTradeDrawerOpen(repository, tradeId)
      await hold(1_500, 'Opening a seeded trade shows its current economics')
      await page.getByTestId('drawer-tab-timeline').click()
      await expect(page.getByTestId('timeline')).toContainText(/AMEND/)
      await hold(2_000, 'The immutable timeline lists every version and audit reason')
      await page.getByTestId('drawer-tab-diff').click()
      await expect(page.getByTestId('diff-row').first()).toBeVisible()
      await hold(1_800, 'The diff view isolates every changed field')
      await page.getByTestId('time-travel-toggle').click()
      await page.getByTestId('as-of-valid').fill('2026-10-20')
      await expect(page.getByTestId('asof-banner')).toContainText('Editing is disabled')
      await expect(page.getByTestId('action-AMEND')).toHaveCount(0)
      await hold(2_200, 'Bitemporal time travel replays the repository read-only')
      await page.getByTestId('time-travel-toggle').click()
      await page.keyboard.press('Escape')
      await repository.blotterSearch.fill('')
      await expect.poll(() => repository.rows().count()).toBeGreaterThan(0)
    })

    await test.step('Trade capture: book a Phoenix note', async () => {
      await page.getByTestId('new-trade').click()
      await expect(page.getByTestId('trade-form')).toBeVisible()
      await hold(1_800, 'Trade capture starts from the product template and server validation')
      const today = new Date().toISOString().slice(0, 10)
      await page.getByTestId('f-notional').fill('2000000')
      await page.getByTestId('f-tradeDate').fill(today)
      await page.getByTestId('f-externalId').fill(`TOUR-${Date.now()}`)
      await page.getByTestId('t-isin').fill('XS2960012347')
      await page.getByTestId('t-underlyings-add').click()
      await page.getByTestId('t-underlyings-add').click()
      await page.getByTestId('t-underlyings-0-symbol').fill('AAPL')
      await page.getByTestId('t-underlyings-0-initialFixing').fill('190')
      await page.getByTestId('t-underlyings-1-symbol').fill('MSFT')
      await page.getByTestId('t-underlyings-1-initialFixing').fill('420')
      await page.getByTestId('t-strikeDate').fill(today)
      await page.getByTestId('t-coupon-ratePerPeriod').fill('2.5')
      await expect(page.getByTestId('submit-trade')).toBeEnabled({ timeout: 15_000 })
      await hold(1_200, 'The generated schedule and validations are shown before booking')
      await page.getByTestId('submit-trade').click()
      await expect(page.getByTestId('trade-drawer')).toBeVisible()
      await expect(page.getByTestId('drawer-version')).toHaveText('v1')
      await hold(2_000, 'Booking assigns a trade id and UTI at version one')
    })

    await test.step('Trade lifecycle: amend, review and cancel', async () => {
      await page.getByTestId('action-AMEND').click()
      await expect(page.getByTestId('trade-form')).toBeVisible()
      await page.getByTestId('f-notional').fill('2100000')
      await page.getByTestId('f-reason').fill('Tour: notional increased after client confirmation')
      await expect(page.getByTestId('amend-kind')).toContainText('Economic')
      await expect(page.getByTestId('submit-trade')).toBeEnabled()
      await hold(1_000, 'An economic amendment is classified before submission')
      await page.getByTestId('submit-trade').click()
      await expect(page.getByTestId('drawer-version')).toHaveText('v2')
      await page.getByTestId('drawer-tab-timeline').click()
      await expect(page.getByTestId('timeline')).toContainText('Tour: notional increased after client confirmation')
      await hold(2_000, 'Every amendment appends a reason to the immutable history')
      await page.getByTestId('drawer-tab-diff').click()
      await expect(page.getByTestId('diff-row').first()).toBeVisible()
      await hold(1_500, 'The version diff highlights the notional change')
      await page.getByTestId('action-CANCEL').click()
      await page.getByTestId('l-reason').fill('Tour: booked for demonstration and cancelled after review')
      await hold(1_000, 'Lifecycle dialogs require an audited reason')
      await page.getByTestId('confirm-lifecycle').click()
      await expect(page.getByTestId('drawer-status')).toHaveText('CANCELLED')
      await hold(2_000, 'The trade reaches its terminal state without deleting history')
    })

    await test.step('Trade positions and risk handoff', async () => {
      await repository.openView('positions')
      await expectPositionsAggregated(repository)
      await page.getByTestId('dim-counterpartyId').click()
      await hold(2_000, 'Positions aggregate live trades by book, basket, currency and counterparty')
      await page.getByTestId('risk-snapshot').click()
      await expect(page.getByTestId('snapshot-result')).toContainText(/fina\.position-snapshot\/v1/)
      await hold(2_200, 'The canonical risk snapshot carries signed positions and trade links')
      const positionRow = repository.positions.locator('.ag-row').first()
      await positionRow.dblclick()
      await expect(page.getByTestId('drill-banner')).toContainText(/Position drill-down/)
      await hold(1_800, 'Drilling from a position opens the trades behind it')
    })

    await test.step('Trade reconciliation: work a break', async () => {
      await repository.openView('recon')
      await expectReconciliationLoaded(repository)
      await hold(2_000, 'Reconciliation shows the latest run, matched count and typed breaks')
      const firstBreak = repository.recon.locator('.ag-row').first()
      await expect(firstBreak).toBeVisible()
      await firstBreak.click()
      await expect(page.getByTestId('break-panel')).toBeVisible()
      await page.getByTestId('break-comment').fill('Tour: matched to the signed distributor statement.')
      await hold(1_200, 'Break resolution requires an audited comment')
      await page.getByTestId('break-to-RESOLVED').click()
      await expect(page.getByTestId('break-status')).toHaveText('RESOLVED')
      await hold(2_000, 'The break closes with a complete comment trail')
    })

    await test.step('Trade governance: filter the audit trail', async () => {
      await repository.openView('audit')
      await expectAuditLoaded(repository)
      await page.getByTestId('audit-action').selectOption('trade.amend')
      await expect(repository.audit.locator('.ag-row').first()).toBeVisible()
      await hold(2_200, 'The append-only audit trail filters by action, actor and target')
    })

    await test.step('Bulk import: validate and commit', async () => {
      await repository.openView('import')
      const externalId = `TOUR-IMP-${Date.now()}`
      const csv = [
        'productType,side,notional,tradeDate,counterpartyId,bookId,externalId,terms.isin,terms.underlyings[0].symbol,terms.underlyings[0].initialFixing,terms.underlyings[1].symbol,terms.underlyings[1].initialFixing,terms.strikeDate,terms.frequency,terms.numObservations,terms.coupon.ratePerPeriod,terms.coupon.barrier,terms.knockIn.barrier',
        `PHOENIX_AUTOCALL,SELL,2000000,2026-03-02,CP-UOB,PHX-ASIA,${externalId},XS2960012347,D05,38.2,HSI,21000,2026-03-04,QUARTERLY,8,0.025,0.7,0.6`,
      ].join('\n')
      await page.getByTestId('import-csv').fill(csv)
      await hold(1_500, 'Bulk import accepts template-shaped rows and validates first')
      await page.getByTestId('import-validate').click()
      await expect(page.getByTestId('import-summary')).toContainText('Dry run: 1 valid, 0 with errors')
      await hold(1_200, 'A clean dry run unlocks commit')
      await page.getByTestId('import-commit').click()
      await expect(page.getByTestId('import-summary')).toContainText(/Committed: 1 valid, 0 with errors, 1 booked/)
      await hold(1_800, 'Commit books the row once and reports row-level results')
      await repository.openView('blotter')
      await repository.search(externalId)
      await expect(repository.rows().first()).toBeVisible()
      await hold(1_500, 'The imported trade is immediately visible in the blotter')
      await repository.blotterSearch.fill('')
    })

    await test.step('Trade entitlements: read-only viewer', async () => {
      await page.getByTestId('user-select').selectOption('victor.view')
      await expect(page.getByTestId('new-trade')).toHaveCount(0)
      await hold(1_500, 'Switching to the read-only viewer removes every write action')
      await repository.openFirstTrade()
      await expect(page.getByTestId('action-AMEND')).toHaveCount(0)
      await hold(1_800, 'Entitlements scope both the blotter and the trade document')
      await page.keyboard.press('Escape')
    })

    await test.step('Trade keyboard shortcuts', async () => {
      await page.getByTestId('shortcuts').click()
      await expect(page.getByTestId('shortcuts-dialog')).toContainText('Focus blotter search')
      await expect(page.getByTestId('shortcuts-dialog')).toContainText('Toggle as-of time travel')
      await hold(2_000, 'Keyboard shortcuts keep every workstation action reachable without the mouse')
      await page.keyboard.press('Escape')
    })

    await test.step('Return to the dashboard workspace', async () => {
      await workspace.openDashboard('Untitled Dashboard')
      await expect(workspace.emptyDashboardMessage).toHaveCount(0)
      await expect(page.getByRole('heading', { name: 'Payoff Petri Net' })).toBeVisible()
      await hold(3_000, 'The tour returns to the populated dashboard; all journeys are covered')
    })

    mkdirSync(dirname(CUE_OUT), { recursive: true })
    writeFileSync(CUE_OUT, `${JSON.stringify({ test: 'complete guided tour', startedAt: new Date(t0).toISOString(), marks }, null, 2)}\n`)
  })
})
