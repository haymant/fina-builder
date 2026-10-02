import { create } from 'zustand'
import { simulationBundle } from '../mock-data/generatePaths'
import type { PayoffNodeId, ThemeMode } from '../features/shared/types'
import type { Dashboard, TileLayout } from '../features/dashboards/types'

const initialDashboards: Dashboard[] = [
  { id: 'payoff-explorer', name: 'Payoff Explorer', layout: [
    { i: 'payoff-graph', x: 0, y: 0, w: 8, h: 5, minW: 4, minH: 3 }, { i: 'path-timeline', x: 8, y: 0, w: 4, h: 5, minW: 3, minH: 3 }, { i: 'node-details', x: 0, y: 5, w: 4, h: 4, minW: 3, minH: 3 }, { i: 'sankey', x: 4, y: 5, w: 8, h: 4, minW: 4, minH: 3 },
  ] },
  { id: 'pathcube-analytics', name: 'PathCube Analytics', layout: [
    { i: 'quantile-fan', x: 0, y: 0, w: 8, h: 5, minW: 4, minH: 3 }, { i: 'path-distribution-position', x: 8, y: 0, w: 4, h: 5, minW: 3, minH: 3 }, { i: 'state-occupancy', x: 0, y: 5, w: 6, h: 4, minW: 4, minH: 3 }, { i: 'barrier-heatmap', x: 6, y: 5, w: 6, h: 4, minW: 4, minH: 3 },
  ] },
  { id: 'risk-diagnostics', name: 'Risk Diagnostics', layout: [
    { i: 'attribution', x: 0, y: 0, w: 6, h: 5, minW: 4, minH: 3 }, { i: 'histogram', x: 6, y: 0, w: 6, h: 5, minW: 4, minH: 3 }, { i: 'sankey', x: 0, y: 5, w: 12, h: 4, minW: 4, minH: 3 },
  ] },
  { id: 'monte-carlo-diagnostics', name: 'Monte Carlo Diagnostics', layout: [
    { i: 'simulation-summary', x: 0, y: 0, w: 12, h: 3, minW: 6, minH: 2 },
    { i: 'pv-convergence', x: 0, y: 3, w: 8, h: 5, minW: 5, minH: 3 }, { i: 'convergence-health', x: 8, y: 3, w: 4, h: 5, minW: 3, minH: 3 },
    { i: 'ci-shrinkage', x: 0, y: 8, w: 6, h: 4, minW: 4, minH: 3 }, { i: 'error-vs-path-count', x: 6, y: 8, w: 6, h: 4, minW: 4, minH: 3 },
    { i: 'ki-probability-convergence', x: 0, y: 12, w: 6, h: 4, minW: 4, minH: 3 }, { i: 'ko-probability-convergence', x: 6, y: 12, w: 6, h: 4, minW: 4, minH: 3 },
    { i: 'percentile-convergence', x: 0, y: 16, w: 12, h: 4, minW: 5, minH: 3 }, { i: 'distribution-stability', x: 0, y: 20, w: 8, h: 4, minW: 5, minH: 3 }, { i: 'simulation-efficiency', x: 8, y: 20, w: 4, h: 4, minW: 3, minH: 3 },
  ] },
  { id: 'trade-design', name: 'Trade Design', layout: [
    { i: 'trade-summary', x: 0, y: 0, w: 6, h: 4, minW: 4, minH: 3 }, { i: 'economics-impact-summary', x: 6, y: 0, w: 6, h: 4, minW: 4, minH: 3 },
    { i: 'sensitivity-tornado', x: 0, y: 4, w: 6, h: 5, minW: 4, minH: 3 }, { i: 'parameter-impact-matrix', x: 6, y: 4, w: 6, h: 5, minW: 4, minH: 3 },
  ] },
]

type ExplorerState = {
  selectedPathId: string; selectedNodeId: PayoffNodeId; selectedDateIndex: number; theme: ThemeMode
  dashboards: Dashboard[]; selectedDashboardId: string
  setSelectedPathId: (id: string) => void; setSelectedNodeId: (id: PayoffNodeId) => void; setSelectedDateIndex: (index: number) => void
  toggleTheme: () => void; selectRandomPath: () => void; nextPath: (direction: 1 | -1) => void
  selectDashboard: (id: string) => void; createDashboard: () => void; renameDashboard: (id: string, name: string) => void; deleteDashboard: (id: string) => void; duplicateDashboard: (id: string) => void; updateLayout: (layout: TileLayout[]) => void
}

function load() { try { return JSON.parse(localStorage.getItem('fina-workspace') ?? '{}') as Partial<ExplorerState> } catch { return {} } }
const saved = typeof window !== 'undefined' ? load() : {}
const initialPath = simulationBundle.paths[0]!
const restoredDashboards = saved.dashboards?.length
  ? [...saved.dashboards, ...initialDashboards.filter((dashboard) => !saved.dashboards!.some((savedDashboard) => savedDashboard.id === dashboard.id))]
  : initialDashboards

function persist(state: Partial<ExplorerState>) { try { localStorage.setItem('fina-workspace', JSON.stringify({ dashboards: state.dashboards, selectedDashboardId: state.selectedDashboardId, theme: state.theme })) } catch { /* storage is optional */ } }

export const useExplorerStore = create<ExplorerState>((set, get) => ({
  selectedPathId: initialPath.id, selectedNodeId: 'PathCube', selectedDateIndex: 0, theme: saved.theme ?? 'dark', dashboards: restoredDashboards, selectedDashboardId: saved.selectedDashboardId ?? 'payoff-explorer',
  setSelectedPathId: (id) => { const path = simulationBundle.paths.find((p) => p.id === id); if (path) set({ selectedPathId: id, selectedDateIndex: 0, selectedNodeId: path.traversal[0] ?? 'PathCube' }) },
  setSelectedNodeId: (id) => set({ selectedNodeId: id }), setSelectedDateIndex: (index) => set({ selectedDateIndex: index }),
  toggleTheme: () => { const theme = get().theme === 'dark' ? 'light' : 'dark'; set({ theme }); persist({ ...get(), theme }) },
  selectRandomPath: () => { const paths = simulationBundle.paths.filter((p) => p.id !== get().selectedPathId); const pick = paths[Math.floor(Math.random() * paths.length)]; if (pick) get().setSelectedPathId(pick.id) },
  nextPath: (direction) => { const idx = simulationBundle.paths.findIndex((p) => p.id === get().selectedPathId); const next = simulationBundle.paths[(idx + direction + simulationBundle.paths.length) % simulationBundle.paths.length]; if (next) get().setSelectedPathId(next.id) },
  selectDashboard: (id) => { set({ selectedDashboardId: id }); persist({ ...get(), selectedDashboardId: id }) },
  createDashboard: () => { const id = `dashboard-${Date.now()}`; const dashboard = { id, name: 'Untitled Dashboard', layout: [] }; set((s) => ({ dashboards: [...s.dashboards, dashboard], selectedDashboardId: id })); persist({ ...get(), dashboards: [...get().dashboards, dashboard], selectedDashboardId: id }) },
  renameDashboard: (id, name) => { const dashboards = get().dashboards.map((d) => d.id === id ? { ...d, name: name || 'Untitled Dashboard' } : d); set({ dashboards }); persist({ ...get(), dashboards }) },
  deleteDashboard: (id) => { if (get().dashboards.length <= 1) return; const dashboards = get().dashboards.filter((d) => d.id !== id); const selectedDashboardId = get().selectedDashboardId === id ? dashboards[0]!.id : get().selectedDashboardId; set({ dashboards, selectedDashboardId }); persist({ ...get(), dashboards, selectedDashboardId }) },
  duplicateDashboard: (id) => { const source = get().dashboards.find((d) => d.id === id); if (!source) return; const copy = { ...source, id: `dashboard-${Date.now()}`, name: `${source.name} Copy`, layout: source.layout.map((l) => ({ ...l, i: `${l.i}-copy-${Date.now()}` })) }; const dashboards = [...get().dashboards, copy]; set({ dashboards, selectedDashboardId: copy.id }); persist({ ...get(), dashboards, selectedDashboardId: copy.id }) },
  updateLayout: (layout) => { const dashboards = get().dashboards.map((d) => d.id === get().selectedDashboardId ? { ...d, layout } : d); set({ dashboards }); persist({ ...get(), dashboards }) },
}))

export function useSelectedPath() { const id = useExplorerStore((s) => s.selectedPathId); return simulationBundle.paths.find((p) => p.id === id) ?? initialPath }
