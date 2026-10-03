// dashboardDocsStore contract (§6.2): templates, per-dashboard usage docs and
// notebook notes persist under `fina-dashboard-docs`.

import { beforeEach, describe, expect, it } from 'vitest'
import { useDashboardDocsStore } from '../dashboardDocsStore'

beforeEach(() => {
  localStorage.clear()
  useDashboardDocsStore.setState({ notes: {}, usage: {}, templates: useDashboardDocsStore.getState().templates })
})

describe('dashboardDocsStore', () => {
  it('offers the built-in templates', () => {
    const t = useDashboardDocsStore.getState().templates
    expect(t.length).toBeGreaterThanOrEqual(8)
    expect(t.map((x) => x.id)).toContain('trade-structuring')
  })

  it('adds, updates, deletes, duplicates and pins notes with persistence', () => {
    const store = useDashboardDocsStore.getState()
    store.addNote('payoff-explorer')
    let notes = useDashboardDocsStore.getState().notes['payoff-explorer']
    expect(notes).toHaveLength(1)
    const noteId = notes![0]!.id

    useDashboardDocsStore.getState().updateNote('payoff-explorer', noteId, { title: 'Renamed' })
    expect(useDashboardDocsStore.getState().notes['payoff-explorer']?.[0]?.title).toBe('Renamed')

    useDashboardDocsStore.getState().togglePin('payoff-explorer', noteId)
    expect(useDashboardDocsStore.getState().notes['payoff-explorer']?.[0]?.pinned).toBe(true)

    useDashboardDocsStore.getState().duplicateNote('payoff-explorer', noteId)
    expect(useDashboardDocsStore.getState().notes['payoff-explorer']).toHaveLength(2)

    useDashboardDocsStore.getState().deleteNote('payoff-explorer', noteId)
    expect(useDashboardDocsStore.getState().notes['payoff-explorer']).toHaveLength(1)

    const saved = JSON.parse(localStorage.getItem('fina-dashboard-docs') ?? '{}') as { notes?: Record<string, unknown[]> }
    expect(saved.notes?.['payoff-explorer']).toHaveLength(1)
  })

  it('updateUsage patches and persists the usage docs', () => {
    useDashboardDocsStore.getState().updateUsage('payoff-explorer', { purpose: 'Changed purpose' })
    expect(useDashboardDocsStore.getState().usage['payoff-explorer']?.purpose).toBe('Changed purpose')
    const saved = JSON.parse(localStorage.getItem('fina-dashboard-docs') ?? '{}') as { usage?: Record<string, { purpose: string }> }
    expect(saved.usage?.['payoff-explorer']?.purpose).toBe('Changed purpose')
  })
})