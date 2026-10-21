import { expect } from '@playwright/test'
import type { WorkspacePage } from '../pages/WorkspacePage'
import type { NotebookPanel } from '../components/NotebookPanel'

export async function expectWorkspaceReady(workspace: WorkspacePage): Promise<void> {
  await expect(workspace.heading).toBeVisible()
  await expect(workspace.dashboardName).toBeVisible()
  await expect(workspace.addTileButton).toBeVisible()
}

export async function expectEmptyDashboard(workspace: WorkspacePage, name: string): Promise<void> {
  await expect(workspace.dashboardName).toHaveValue(name)
  await expect(workspace.emptyDashboardMessage).toBeVisible()
}

export async function expectNotebookOpen(notebook: NotebookPanel): Promise<void> {
  await expect(notebook.heading).toBeVisible()
  await expect(notebook.newNoteButton).toBeVisible()
}

export async function expectSelectedNoteTitle(notebook: NotebookPanel, title: string): Promise<void> {
  await expect(notebook.selectedTitleInput).toHaveValue(title)
}
