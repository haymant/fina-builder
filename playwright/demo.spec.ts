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

test.describe('visualization gallery demo', () => {
  test.use({ stubEngines: false })

  test('adds a Payoff Petri Net from the visualization gallery', {
    tag: [TAG.demo.any, TAG.demo.visualizationAdd, TAG.journey.visualizationAdd, TAG.feature.visualizations, TAG.dependency.riga],
  }, async ({ page, workspace }) => {
    await test.step('Open the empty workspace', async () => {
      await expectWorkspaceReady(workspace)
      await expectEmptyDashboard(workspace, 'Playwright Dashboard')
      await page.waitForTimeout(3_500) // Deliberate capture hold for the opening narration.
    })

    const gallery = await workspace.openTileGallery()
    await test.step('Browse the visualization gallery', async () => {
      await expect(gallery.heading).toBeVisible()
      await page.waitForTimeout(2_000) // Hold on the full gallery before searching.
      await gallery.search('Payoff Petri Net')
      await page.waitForTimeout(2_000) // Hold on the filtered result before adding it.
    })

    await test.step('Add the Payoff Petri Net tile', async () => {
      await gallery.addTile('Payoff Petri Net')
      await expect(page.getByRole('heading', { name: 'Payoff Petri Net' })).toBeVisible()
      await expect(workspace.emptyDashboardMessage).toHaveCount(0)
      await page.waitForTimeout(2_500) // Let the engine response render in the grid tile.
    })

    await test.step('Expand the Petri net', async () => {
      await page.getByTitle('Expand').click()
      await expect(page.getByText('Expanded view')).toBeVisible()
      const expanded = page.locator('.expanded-modal')
      await expanded.locator('.react-flow__controls-zoomin').click()
      await expanded.locator('.react-flow__controls-zoomin').click()
      await page.waitForTimeout(4_000) // Hold on the zoomed execution net for narration.
    })

    await test.step('Switch to the risk and explain layers', async () => {
      const expanded = page.locator('.expanded-modal')
      await expanded.getByRole('button', { name: 'Risk', exact: true }).click()
      await page.waitForTimeout(3_000) // Hold on the risk-tinted net.
      await expanded.getByRole('button', { name: 'Explain', exact: true }).click()
      await page.waitForTimeout(5_000) // Hold on the explain layer for the closing narration.
    })
  })
})
