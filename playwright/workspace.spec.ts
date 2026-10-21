import { expect, test } from '@playwright/test'

const seededWorkspace = {
  dashboards: [{ id: 'playwright-dashboard', name: 'Playwright Dashboard', layout: [] }],
  selectedDashboardId: 'playwright-dashboard',
  theme: 'dark',
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript((state) => {
    if (sessionStorage.getItem('__playwright_seeded') !== '1') {
      localStorage.clear()
      localStorage.setItem('fina-workspace', JSON.stringify(state))
      sessionStorage.setItem('__playwright_seeded', '1')
    }
  }, seededWorkspace)

  // Browser-flow tests exercise UI behavior, not engine availability or market data.
  await page.route('**/riga/mcp**', (route) => route.abort())
  await page.route('**/tac/mcp**', (route) => route.abort())
  await page.goto('/')
})

test('renders the workspace shell and selected dashboard', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Structured Product Explorer' })).toBeVisible()
  await expect(page.getByLabel('Rename dashboard')).toHaveValue('Playwright Dashboard')
  await expect(page.getByRole('heading', { name: 'Start building your dashboard' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Add tile' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Notebook' })).toBeVisible()
})

test('creates a blank dashboard and restores it after reload', async ({ page }) => {
  await page.getByRole('button', { name: 'New dashboard' }).click()
  await expect(page.getByRole('heading', { name: 'Create Dashboard' })).toBeVisible()
  await page.getByRole('button', { name: 'Create empty dashboard' }).click()

  const dashboardName = page.getByLabel('Rename dashboard')
  await expect(dashboardName).toHaveValue('Untitled Dashboard')
  await expect(page.getByRole('heading', { name: 'Start building your dashboard' })).toBeVisible()

  await page.reload()
  await expect(page.getByLabel('Rename dashboard')).toHaveValue('Untitled Dashboard')
  await expect(page.getByRole('heading', { name: 'Start building your dashboard' })).toBeVisible()
})

test('filters templates and creates the matching dashboard', async ({ page }) => {
  await page.getByRole('button', { name: 'New dashboard' }).click()
  await page.getByPlaceholder('Search templates').fill('Trade Structuring Workspace')

  await expect(page.getByRole('heading', { name: 'Trade Structuring Workspace' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Trader Workspace' })).toHaveCount(0)

  const template = page.locator('.template-card').filter({
    has: page.getByRole('heading', { name: 'Trade Structuring Workspace' }),
  })
  await template.getByRole('button', { name: 'Create dashboard' }).click()
  await expect(page.getByLabel('Rename dashboard')).toHaveValue('Trade Structuring Workspace')
  await expect(page.getByText('Dashboard notebook')).toBeVisible()
})

test('adds a visualization from the tile library', async ({ page }) => {
  await page.getByRole('button', { name: 'Add tile' }).click()
  await expect(page.getByRole('heading', { name: 'Add visualization' })).toBeVisible()
  await page.getByPlaceholder('Search tiles...').fill('Payoff Petri Net')
  await page
    .locator('.gallery-item')
    .filter({ has: page.getByText('Payoff Petri Net', { exact: true }) })
    .click()

  await expect(page.getByRole('heading', { name: 'Payoff Petri Net' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Start building your dashboard' })).toHaveCount(0)
})

test('creates and edits a notebook note', async ({ page }) => {
  await page.getByRole('button', { name: 'Notebook' }).click()
  await expect(page.getByText('Dashboard notebook')).toBeVisible()
  await expect(page.getByRole('heading', { name: '2. Notes' })).toBeVisible()

  await page.getByRole('button', { name: 'New note' }).click()
  const noteItem = page.locator('.notebook-note-item').filter({ hasText: 'New Note' })
  await expect(noteItem).toBeVisible()
  await noteItem.click()

  const title = page.locator('input.notebook-title')
  await expect(title).toHaveValue('New Note')
  await title.fill('Playwright finding')
  await expect(title).toHaveValue('Playwright finding')
  await page.getByRole('button', { name: 'Collapse notebook' }).click()
  await expect(page.getByText('Dashboard notebook')).toHaveCount(0)
})

test('persists the selected theme after reload', async ({ page }) => {
  const savedTheme = () => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('fina-workspace') ?? '{}') as { theme?: string }
    return saved.theme
  })

  await expect.poll(savedTheme).toBe('dark')
  await page.getByRole('button', { name: 'Toggle theme' }).click()
  await expect.poll(savedTheme).toBe('light')
  await page.reload()
  await expect.poll(savedTheme).toBe('light')
})
