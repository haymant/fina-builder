import type { Locator, Page } from '@playwright/test'

export class NotebookPanel {
  readonly heading
  readonly newNoteButton

  constructor(private readonly page: Page) {
    this.heading = page.getByText('Dashboard notebook')
    this.newNoteButton = page.getByRole('button', { name: 'New note' })
  }

  note(title: string): Locator {
    return this.page.locator('.notebook-note-item').filter({ hasText: title })
  }

  async createNote(): Promise<Locator> {
    await this.newNoteButton.click()
    const note = this.note('New Note')
    await note.waitFor({ state: 'visible' })
    return note
  }

  async selectNote(title: string): Promise<void> {
    await this.note(title).click()
  }

  get selectedTitleInput(): Locator {
    return this.page.locator('input.notebook-title')
  }

  async renameSelectedNote(title: string): Promise<void> {
    await this.selectedTitleInput.fill(title)
  }
}
