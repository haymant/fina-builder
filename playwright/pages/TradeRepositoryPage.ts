import { expect, type Page } from '@playwright/test'

/**
 * Trade repository views are top-level destinations reached from the Trades menu, not
 * tabs. Document tabs inside the repository belong to individual trades.
 */
export type TradeView = 'blotter' | 'positions' | 'recon' | 'audit' | 'import'

export const TRADE_VIEW_LABEL: Record<TradeView, string> = {
  blotter: 'Blotter',
  positions: 'Positions',
  recon: 'Reconciliation',
  audit: 'Audit log',
  import: 'Bulk import',
}

export class TradeRepositoryPage {
  readonly root
  readonly breadcrumb
  readonly menu
  readonly docHomeTab
  readonly blotter
  readonly blotterGrid
  readonly blotterSearch
  readonly blotterCount
  readonly drawer
  readonly drawerTradeId
  readonly positions
  readonly positionsSummary
  readonly recon
  readonly reconSummary
  readonly reconBreakCount
  readonly audit
  readonly auditCount
  readonly bulkImport

  constructor(readonly page: Page) {
    this.root = page.getByTestId('trade-repository')
    this.breadcrumb = page.getByTestId('breadcrumb')
    this.menu = page.getByTestId('menu-trades')
    this.docHomeTab = page.getByTestId('doc-tab-home')
    this.blotter = page.getByTestId('blotter')
    this.blotterGrid = page.getByTestId('blotter-grid')
    this.blotterSearch = page.getByTestId('blotter-search')
    this.blotterCount = page.getByTestId('blotter-count')
    this.drawer = page.getByTestId('trade-drawer')
    this.drawerTradeId = page.getByTestId('drawer-trade-id')
    this.positions = page.getByTestId('positions')
    this.positionsSummary = page.getByTestId('positions-summary')
    this.recon = page.getByTestId('recon')
    this.reconSummary = page.getByTestId('recon-summary')
    this.reconBreakCount = page.getByTestId('recon-break-count')
    this.audit = page.getByTestId('audit')
    this.auditCount = page.getByTestId('audit-count')
    this.bulkImport = page.getByTestId('import')
  }

  viewRoot(view: TradeView) {
    switch (view) {
      case 'blotter': return this.blotter
      case 'positions': return this.positions
      case 'recon': return this.recon
      case 'audit': return this.audit
      case 'import': return this.bulkImport
    }
  }

  /** Navigate with the desktop menu: Trades ▸ <view>. */
  async openView(view: TradeView): Promise<void> {
    await this.menu.click()
    await this.page.getByTestId(`menuitem-trades-${view}`).click()
    await expect(this.breadcrumb).toContainText(TRADE_VIEW_LABEL[view])
    await expect(this.viewRoot(view)).toBeVisible()
  }

  async expectView(view: TradeView): Promise<void> {
    await expect(this.breadcrumb).toContainText(TRADE_VIEW_LABEL[view])
    await expect(this.viewRoot(view)).toBeVisible()
    await expect(this.docHomeTab).toContainText(TRADE_VIEW_LABEL[view])
  }

  rows() {
    return this.blotterGrid.locator('.ag-row')
  }

  /** Search is server-side and debounced; wait for the query round-trip, not a sleep. */
  async search(text: string): Promise<void> {
    const response = this.page.waitForResponse((candidate) => {
      const body = candidate.request().postData() ?? ''
      return candidate.url().includes('/trade-repo/mcp') && body.includes('tr_trade_query') && body.includes(text)
    })
    await this.blotterSearch.fill(text)
    await response
  }

  /** Single click selects a blotter row and opens the inspector drawer. */
  async openFirstTrade(): Promise<string> {
    const row = this.rows().first()
    await row.click()
    await expect(this.drawer).toBeVisible()
    const tradeId = (await this.drawerTradeId.textContent())?.trim() ?? ''
    expect(tradeId).toMatch(/^TR-\d+$/)
    return tradeId
  }
}
