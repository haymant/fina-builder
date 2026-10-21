import { expect, test } from '@playwright/test'

test('narrated demo: create a dashboard note', async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('__playwright_demo_seeded') !== '1') {
      localStorage.clear()
      localStorage.setItem(
        'fina-workspace',
        JSON.stringify({
          dashboards: [{ id: 'playwright-demo', name: 'Demo Dashboard', layout: [] }],
          selectedDashboardId: 'playwright-demo',
          theme: 'dark',
        }),
      )
      sessionStorage.setItem('__playwright_demo_seeded', '1')
    }
  })
  await page.route('**/riga/mcp**', (route) => route.abort())
  await page.route('**/tac/mcp**', (route) => route.abort())
  await page.goto('/')

  await expect(page.getByRole('heading', { name: 'Structured Product Explorer' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Start building your dashboard' })).toBeVisible()
  await page.waitForTimeout(4_000)

  await page.getByRole('button', { name: 'New dashboard' }).click()
  await expect(page.getByRole('heading', { name: 'Create Dashboard' })).toBeVisible()
  await page.waitForTimeout(2_400)

  await page.getByRole('button', { name: 'Create empty dashboard' }).click()
  await expect(page.getByText('Dashboard notebook')).toBeVisible()
  await expect(page.getByLabel('Rename dashboard')).toHaveValue('Untitled Dashboard')
  await page.waitForTimeout(5_500)

  await page.getByRole('button', { name: 'New note' }).click()
  const noteItem = page.locator('.notebook-note-item').filter({ hasText: 'New Note' })
  await expect(noteItem).toBeVisible()
  await page.waitForTimeout(1_500)
  await noteItem.click()

  const noteTitle = page.locator('input.notebook-title')
  await expect(noteTitle).toHaveValue('New Note')
  await noteTitle.fill('Analysis note')
  await expect(noteTitle).toHaveValue('Analysis note')
  await page.waitForTimeout(4_500)
})
