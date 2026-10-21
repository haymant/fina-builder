import { expect, type Locator, type Page } from '@playwright/test'

/** KPI labels are stable user-facing text; derive the same id the tile primitives use. */
export function kpiTestId(label: string): string {
  return `kpi-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
}

/**
 * Pricer dashboards are tile dashboards: each catalog tile renders a
 * `data-testid="tile-<TileType>"` shell, and every KPI carries a labelled id.
 */
export class PricerPage {
  readonly expanded: Locator

  constructor(readonly page: Page) {
    this.expanded = page.getByTestId('expanded-tile')
  }

  tile(type: string): Locator {
    return this.page.getByTestId(`tile-${type}`)
  }

  kpi(type: string, label: string): Locator {
    return this.tile(type).getByTestId(kpiTestId(label)).getByTestId('kpi-value')
  }

  async readKpi(type: string, label: string): Promise<string> {
    return (await this.kpi(type, label).innerText()).trim()
  }

  /** Open a tile in the focused (larger) view and return the dialog body. */
  async expand(type: string): Promise<Locator> {
    await this.tile(type).getByTitle('Expand').click()
    await expect(this.expanded).toBeVisible()
    return this.expanded
  }

  async closeExpanded(): Promise<void> {
    await this.expanded.getByRole('button', { name: 'Close focused view' }).click()
    await expect(this.expanded).toHaveCount(0)
  }

  /** Reveal the secondary tiles of a focus-mode dashboard. */
  async showAllTiles(): Promise<void> {
    const toggle = this.page.getByTestId('toggle-all-tiles')
    if (await toggle.isVisible()) await toggle.click()
  }

  /** Open the Dashboards menu (used for the closing shot in the demo). */
  async openDashboardsMenu(): Promise<void> {
    await this.page.getByTestId('menu-dashboards').click()
  }
}
