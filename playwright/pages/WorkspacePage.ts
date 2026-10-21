import { expect, type Page } from '@playwright/test'
import { DashboardTemplatesDialog } from '../components/DashboardTemplatesDialog'
import { NotebookPanel } from '../components/NotebookPanel'
import { TileGallery } from '../components/TileGallery'

export class WorkspacePage {
  readonly heading
  readonly menubar
  readonly breadcrumb
  readonly dashboardName
  readonly emptyDashboardMessage
  readonly addTileButton
  readonly newDashboardButton
  readonly notebookToggle

  constructor(readonly page: Page) {
    // The workspace shell is identified by the desktop menu bar; the app title only
    // appears in the About dialog since dashboards moved behind the menus.
    this.heading = page.getByTestId('app-menubar')
    this.menubar = page.getByTestId('app-menubar')
    this.breadcrumb = page.getByTestId('breadcrumb')
    this.dashboardName = page.getByLabel('Rename dashboard')
    this.emptyDashboardMessage = page.getByRole('heading', { name: 'Start building your dashboard' })
    this.addTileButton = page.getByRole('button', { name: 'Add tile' })
    this.newDashboardButton = page.getByTestId('menuitem-file-new-dashboard')
    this.notebookToggle = page.getByRole('button', { name: 'Notebook' })
  }

  async open(): Promise<void> {
    await this.page.goto('/')
  }

  async openTemplates(): Promise<DashboardTemplatesDialog> {
    await this.page.getByTestId('menu-file').click()
    await this.newDashboardButton.click()
    return new DashboardTemplatesDialog(this.page)
  }

  /** Navigate to a tile dashboard through the Dashboards menu. */
  async openDashboard(name: string): Promise<void> {
    await this.page.getByTestId('menu-dashboards').click()
    await this.page.getByRole('menuitemcheckbox', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) }).click()
    await expect(this.breadcrumb).toContainText(name)
  }

  async openNotebook(): Promise<NotebookPanel> {
    await this.notebookToggle.click()
    return new NotebookPanel(this.page)
  }

  async openTileGallery(): Promise<TileGallery> {
    await this.addTileButton.click()
    return new TileGallery(this.page)
  }
}
