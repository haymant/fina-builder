import type { Page } from '@playwright/test'

export class TileGallery {
  readonly heading
  readonly searchInput

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Add visualization' })
    this.searchInput = page.getByPlaceholder('Search tiles...')
  }

  async search(query: string): Promise<void> {
    await this.searchInput.fill(query)
  }

  async addTile(title: string): Promise<void> {
    // Scope to the gallery item and exact visible title; descriptions may mention other tiles.
    const item = this.page.locator('.gallery-item').filter({
      has: this.page.getByText(title, { exact: true }),
    })
    await item.click()
  }
}
