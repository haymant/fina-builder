import type { Page } from '@playwright/test'
import { DashboardTemplatesDialog } from '../components/DashboardTemplatesDialog'
import { NotebookPanel } from '../components/NotebookPanel'
import { TileGallery } from '../components/TileGallery'

export class WorkspacePage {
  readonly heading
  readonly dashboardName
  readonly emptyDashboardMessage
  readonly addTileButton
  readonly newDashboardButton
  readonly notebookToggle

  constructor(readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Structured Product Explorer' })
    this.dashboardName = page.getByLabel('Rename dashboard')
    this.emptyDashboardMessage = page.getByRole('heading', { name: 'Start building your dashboard' })
    this.addTileButton = page.getByRole('button', { name: 'Add tile' })
    this.newDashboardButton = page.getByRole('button', { name: 'New dashboard' })
    this.notebookToggle = page.getByRole('button', { name: 'Notebook' })
  }

  async open(): Promise<void> {
    await this.page.goto('/')
  }

  async openTemplates(): Promise<DashboardTemplatesDialog> {
    await this.newDashboardButton.click()
    return new DashboardTemplatesDialog(this.page)
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
