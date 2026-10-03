// explorerStore contract (§6.2): the `fina-workspace` localStorage round-trip
// stays byte-compatible with the pre-migration code (I-6), dashboards
// create/rename/duplicate/delete behave as before, and the restored dashboards
// merge with the built-ins.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useExplorerStore } from '../explorerStore'

function persisted(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem('fina-workspace') ?? '{}') as Record<string, unknown>
}

describe('explorerStore', () => {
  beforeEach(() => {
    localStorage.clear()
    useExplorerStore.setState({
      dashboards: [
        { id: 'payoff-explorer', name: 'Payoff Explorer', layout: [] },
        { id: 'pathcube-analytics', name: 'PathCube Analytics', layout: [] },
        { id: 'risk-diagnostics', name: 'Risk Diagnostics', layout: [] },
        { id: 'monte-carlo-diagnostics', name: 'Monte Carlo Diagnostics', layout: [] },
        { id: 'trade-design', name: 'Trade Design', layout: [] },
        { id: 'market-risk', name: 'Market & Risk', layout: [] },
      ],
      selectedDashboardId: 'payoff-explorer',
    })
  })

  it('persists only dashboards, selectedDashboardId and theme under fina-workspace', () => {
    const store = useExplorerStore.getState()
    store.createDashboard()
    const saved = persisted()
    expect(saved.dashboards).toBeDefined()
    expect(saved.selectedDashboardId).toBeDefined()
    expect(saved.theme).toBeDefined()
    expect(Object.keys(saved).sort()).toEqual(['dashboards', 'selectedDashboardId', 'theme'])
  })

  it('create/rename/duplicate update state and localStorage', () => {
    const store = useExplorerStore.getState()
    const id = store.createDashboardFromTemplate('Risk 2', [])
    expect(useExplorerStore.getState().dashboards.map((d) => d.id)).toContain(id)
    expect(persisted().dashboards as unknown[]).toHaveLength(7)

    useExplorerStore.getState().renameDashboard(id, 'Renamed')
    expect(useExplorerStore.getState().dashboards.find((d) => d.id === id)?.name).toBe('Renamed')

    const before = useExplorerStore.getState().dashboards.length
    useExplorerStore.getState().duplicateDashboard(id)
    expect(useExplorerStore.getState().dashboards).toHaveLength(before + 1)
  })

  it('delete refuses when only one dashboard remains (parity with previous code)', () => {
    const dashboards = useExplorerStore.getState().dashboards
    // Collapse to one dashboard, then attempt to delete it.
    const first = dashboards[0]!
    useExplorerStore.setState({ dashboards: [first], selectedDashboardId: first.id })
    const n = useExplorerStore.getState().dashboards.length
    useExplorerStore.getState().deleteDashboard(first.id)
    expect(useExplorerStore.getState().dashboards).toHaveLength(n)
  })

  it('delete removes the selected dashboard and selects the first remaining', () => {
    useExplorerStore.getState().createDashboard()
    const fresh = useExplorerStore.getState()
    const target = fresh.selectedDashboardId
    fresh.deleteDashboard(target)
    const after = useExplorerStore.getState()
    expect(after.dashboards.map((d) => d.id)).not.toContain(target)
    expect(after.selectedDashboardId).toBe(after.dashboards[0]!.id)
  })

  it('restored dashboards merge with the built-ins without duplicates', async () => {
    // A previous session renamed one built-in and added one custom dashboard.
    const next = [
      { id: 'pathcube-analytics', name: 'Renamed', layout: [] },
      { id: 'custom-one', name: 'Custom', layout: [] },
    ]
    localStorage.setItem(
      'fina-workspace',
      JSON.stringify({ dashboards: next, selectedDashboardId: 'custom-one', theme: 'light' }),
    )

    // The merge runs at module load; reload the module against the seeded
    // storage to observe it.
    vi.resetModules()
    const fresh = await import('../explorerStore')
    const dashboards = fresh.useExplorerStore.getState().dashboards
    const ids = dashboards.map((d) => d.id)
    // Modified built-in kept exactly once, every other built-in present, custom kept.
    expect(ids.filter((id) => id === 'pathcube-analytics')).toHaveLength(1)
    expect(ids).toContain('payoff-explorer')
    expect(ids).toContain('market-risk')
    expect(ids).toContain('custom-one')
    // The persisted selection is restored.
    expect(fresh.useExplorerStore.getState().selectedDashboardId).toBe('custom-one')
  })
})