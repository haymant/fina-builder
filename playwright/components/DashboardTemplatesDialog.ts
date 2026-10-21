import type { Page } from '@playwright/test'

export class DashboardTemplatesDialog {
  readonly heading
  readonly searchInput

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Create Dashboard' })
    this.searchInput = page.getByPlaceholder('Search templates')
  }

  async search(query: string): Promise<void> {
    await this.searchInput.fill(query)
  }

  async createBlankDashboard(): Promise<void> {
    await this.page.getByRole('button', { name: 'Create empty dashboard' }).click()
  }

  async createDashboardFromTemplate(name: string): Promise<void> {
    const card = this.page.locator('.template-card').filter({
      has: this.page.getByRole('heading', { name, exact: true }),
    })
    await card.getByRole('button', { name: 'Create dashboard' }).click()
  }
}
