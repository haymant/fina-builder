import { test as base, expect } from '@playwright/test'
import { WorkspacePage } from '../pages/WorkspacePage'
import { TradeRepositoryPage } from '../pages/TradeRepositoryPage'
import { createWorkspaceSeed, type WorkspaceSeed } from '../support/workspaceState'

type Fixtures = {
  workspace: WorkspacePage
  repository: TradeRepositoryPage
  workspaceSeed: WorkspaceSeed
  stubEngines: boolean
}

export const test = base.extend<Fixtures>({
  workspaceSeed: [createWorkspaceSeed(), { option: true }],
  stubEngines: [true, { option: true }],
  workspace: async ({ page, workspaceSeed, stubEngines }, use) => {
    await page.addInitScript((state) => {
      if (sessionStorage.getItem('__playwright_seeded') !== '1') {
        localStorage.clear()
        localStorage.setItem('fina-workspace', JSON.stringify(state))
        sessionStorage.setItem('__playwright_seeded', '1')
      }
    }, workspaceSeed)

    // UI-only tests should not depend on engines; integration scopes can opt out.
    if (stubEngines) {
      await page.route('**/riga/mcp**', (route) => route.abort())
      await page.route('**/tac/mcp**', (route) => route.abort())
    }

    const workspace = new WorkspacePage(page)
    await workspace.open()
    // Playwright fixture lifecycle callback; this is not React's use hook.
    // oxlint-disable-next-line react-hooks/rules-of-hooks
    await use(workspace)
  },
  // Depends on `workspace`, so the app is already open when the page object is built.
  repository: async ({ page, workspace }, use) => {
    // oxlint-disable-next-line react-hooks/rules-of-hooks
    await use(new TradeRepositoryPage(page))
  },
})

export { expect }
