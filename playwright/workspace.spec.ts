import { expect, test } from './fixtures/test'
import {
  expectEmptyDashboard,
  expectNotebookOpen,
  expectSelectedNoteTitle,
  expectWorkspaceReady,
} from './assertions/workspace.assertions'
import { TAG } from './support/tags'

const { journey, feature } = TAG

test('renders the workspace shell and selected dashboard', {
  tag: [TAG.smoke, journey.dashboardReview, feature.workspace],
}, async ({ workspace }) => {
  await expectWorkspaceReady(workspace)
  await expectEmptyDashboard(workspace, 'Playwright Dashboard')
  await expect(workspace.notebookToggle).toBeVisible()
})

test('creates a blank dashboard and restores it after reload', {
  tag: [TAG.smoke, journey.dashboardSetup, feature.dashboards, feature.templates],
}, async ({ page, workspace }) => {
  const templates = await workspace.openTemplates()
  await expect(templates.heading).toBeVisible()
  await templates.createBlankDashboard()

  await expectEmptyDashboard(workspace, 'Untitled Dashboard')
  await page.reload()
  await expectEmptyDashboard(workspace, 'Untitled Dashboard')
})

test('filters templates and creates the matching dashboard', {
  tag: [journey.dashboardSetup, feature.dashboards, feature.templates],
}, async ({ page, workspace }) => {
  const templates = await workspace.openTemplates()
  await templates.search('Trade Structuring Workspace')

  await expect(page.getByRole('heading', { name: 'Trade Structuring Workspace' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Trader Workspace' })).toHaveCount(0)
  await templates.createDashboardFromTemplate('Trade Structuring Workspace')

  await expect(workspace.dashboardName).toHaveValue('Trade Structuring Workspace')
  await expect(page.getByText('Dashboard notebook')).toBeVisible()
})

test('adds an engine-backed visualization shell', {
  tag: [journey.visualizationAdd, feature.visualizations, TAG.dependency.riga],
}, async ({ page, workspace }) => {
  const gallery = await workspace.openTileGallery()
  await expect(gallery.heading).toBeVisible()
  await gallery.search('Payoff Petri Net')
  await gallery.addTile('Payoff Petri Net')

  await expect(page.getByRole('heading', { name: 'Payoff Petri Net' })).toBeVisible()
  await expect(workspace.emptyDashboardMessage).toHaveCount(0)
  // This suite aborts the RIGA endpoint; this asserts UI insertion, not engine calculation.
  await expect(page.getByText(/could not reach MCP server|Failed to fetch/i)).toBeVisible()
})

test('creates and edits a notebook note', {
  tag: [journey.notebookCapture, feature.notebook],
}, async ({ page, workspace }) => {
  const notebook = await workspace.openNotebook()
  await expectNotebookOpen(notebook)
  await expect(page.getByRole('heading', { name: '2. Notes' })).toBeVisible()

  const note = await notebook.createNote()
  await note.click()
  await expectSelectedNoteTitle(notebook, 'New Note')
  await notebook.renameSelectedNote('Playwright finding')
  await expectSelectedNoteTitle(notebook, 'Playwright finding')

  await page.getByRole('button', { name: 'Collapse notebook' }).click()
  await expect(notebook.heading).toHaveCount(0)
})

test('persists the selected theme after reload', {
  tag: [journey.preferences, feature.theme],
}, async ({ page, workspace }) => {
  const savedTheme = () => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('fina-workspace') ?? '{}') as { theme?: string }
    return saved.theme
  })

  await expect.poll(savedTheme).toBe('dark')
  await page.getByRole('button', { name: 'Toggle theme' }).click()
  await expect.poll(savedTheme).toBe('light')
  await page.reload()
  await expectWorkspaceReady(workspace)
  await expect.poll(savedTheme).toBe('light')
})
