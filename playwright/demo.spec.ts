import { expect, test } from './fixtures/test'
import { NotebookPanel } from './components/NotebookPanel'
import {
  expectEmptyDashboard,
  expectNotebookOpen,
  expectSelectedNoteTitle,
  expectWorkspaceReady,
} from './assertions/workspace.assertions'
import { TAG } from './support/tags'

test('creates a dashboard note for the narrated walkthrough', {
  tag: [TAG.demo.any, TAG.demo.dashboardNote, TAG.journey.dashboardSetup, TAG.journey.notebookCapture, TAG.feature.dashboards, TAG.feature.notebook],
}, async ({ page, workspace }) => {
  await test.step('Open the empty workspace', async () => {
    await expectWorkspaceReady(workspace)
    await expectEmptyDashboard(workspace, 'Playwright Dashboard')
    await page.waitForTimeout(4_000) // Deliberate capture hold for the opening narration.
  })

  const templates = await workspace.openTemplates()
  await test.step('Choose a blank dashboard', async () => {
    await expect(templates.heading).toBeVisible()
    await page.waitForTimeout(2_400) // Deliberate capture hold for narration.
    await templates.createBlankDashboard()
    await expectEmptyDashboard(workspace, 'Untitled Dashboard')
  })

  const notebook = new NotebookPanel(page)
  await test.step('Review the new dashboard notebook', async () => {
    await expectNotebookOpen(notebook)
    await page.waitForTimeout(5_500) // Deliberate capture hold for narration.
  })

  await test.step('Add and rename a notebook note', async () => {
    const note = await notebook.createNote()
    await page.waitForTimeout(1_500) // Hold on the new note before selecting it.
    await note.click()
    await expectSelectedNoteTitle(notebook, 'New Note')
    await notebook.renameSelectedNote('Analysis note')
    await expectSelectedNoteTitle(notebook, 'Analysis note')
    await page.waitForTimeout(4_500) // Hold on the completed note for the closing narration.
  })
})
