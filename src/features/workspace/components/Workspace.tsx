import { BookOpen, ChevronDown, ChevronRight, LayoutGrid, MessageSquare, Moon, Plus, RotateCcw, Sun } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppMenuBar } from './AppMenuBar'
import { ConfirmDialog } from './ConfirmDialog'
import { loadLocation, saveLocation, splitPrimary, TRADE_VIEWS, type Location, type TradeView } from '../navigation'
import { Responsive, WidthProvider, type Layout, type ResponsiveLayouts } from 'react-grid-layout/legacy'
import { useExplorerStore, BUILT_IN_DASHBOARDS } from '../../../store/explorerStore'
import { TILE_CATALOG, tileFromType } from '../../dashboards/catalog'
import { PATH_TILE_TYPES } from '../../dashboards/pathTiles'
import type { TileLayout, TileType } from '../../dashboards/types'
import { PathStepper } from '../../riga/components/PathStepper'
import { TileRenderer } from '../../tiles/components/TileRenderer'
import { TileCard } from './TileCard'
import { TileGallery } from './TileGallery'
import { useObservabilityStore, type ObservabilityLevel } from '../../../store/observabilityStore'
import { NotebookDrawer } from './NotebookDrawer'
import { TemplateGallery } from './TemplateGallery'
import { useDashboardDocsStore } from '../../../store/dashboardDocsStore'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import '../panels.css'

const Grid = WidthProvider(Responsive)
const TradeRepository = lazy(() => import('../../trade-repository/components/TradeRepository').then((m) => ({ default: m.TradeRepository })))
const NarrativeWorkspace = lazy(() => import('../../narrative/components/NarrativeWorkspace').then((m) => ({ default: m.NarrativeWorkspace })))

const showAllKey = (id: string) => `fina.showAllTiles.${id}`

export function Workspace({ onOpenLocalAgent }: { onOpenLocalAgent: () => void }) {
  const dashboards = useExplorerStore((s) => s.dashboards)
  const selectedId = useExplorerStore((s) => s.selectedDashboardId)
  const dashboard = dashboards.find((d) => d.id === selectedId) ?? dashboards[0]!
  const updateLayout = useExplorerStore((s) => s.updateLayout)
  const selectDashboard = useExplorerStore((s) => s.selectDashboard)
  const createDashboardFromTemplate = useExplorerStore((s) => s.createDashboardFromTemplate)
  const renameDashboard = useExplorerStore((s) => s.renameDashboard)
  const deleteDashboard = useExplorerStore((s) => s.deleteDashboard)
  const duplicateDashboard = useExplorerStore((s) => s.duplicateDashboard)
  const resetDashboardLayout = useExplorerStore((s) => s.resetDashboardLayout)
  const theme = useExplorerStore((s) => s.theme)
  const toggleTheme = useExplorerStore((s) => s.toggleTheme)
  const [galleryOpen, setGalleryOpen] = useState(false)
  const [notebookOpen, setNotebookOpen] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [help, setHelp] = useState<'shortcuts' | 'about' | null>(null)
  const [newTradeSignal, setNewTradeSignal] = useState(0)
  const [undo, setUndo] = useState<{ item: TileLayout; label: string } | null>(null)
  const [confirmAction, setConfirmAction] = useState<null | 'delete-dashboard' | 'reset-layout'>(null)
  const undoTimer = useRef<number | null>(null)
  // Where the user is: a tile dashboard or a trade repository view. Navigation is via the
  // menu bar / command palette; persisted so a reload (or desktop relaunch) restores it.
  const [location, setLocationState] = useState<Location>(() => {
    const l = loadLocation()
    if (l?.kind === 'trades' && TRADE_VIEWS.some((v) => v.id === l.view)) return l
    if (l?.kind === 'narrative' && (l.view === 'overview' || l.view === 'claims')) return l
    return { kind: 'dashboard', dashboardId: selectedId }
  })
  const navigate = useCallback((l: Location) => {
    if (l.kind === 'dashboard') selectDashboard(l.dashboardId)
    setLocationState(l)
    saveLocation(l)
  }, [selectDashboard])
  const [showAllMap, setShowAllMap] = useState<Record<string, boolean>>({})
  const showAll = showAllMap[dashboard.id] ?? (typeof localStorage !== 'undefined' && localStorage.getItem(showAllKey(dashboard.id)) === '1')
  const toggleShowAll = () => {
    const next = !showAll
    setShowAllMap((m) => ({ ...m, [dashboard.id]: next }))
    try { localStorage.setItem(showAllKey(dashboard.id), next ? '1' : '0') } catch { /* optional */ }
  }
  const layout = dashboard.layout
  const { primary, secondary } = useMemo(() => splitPrimary(layout), [layout])
  const visible = showAll ? layout : primary
  const layouts = useMemo<ResponsiveLayouts>(
    () => ({ lg: visible, md: visible, sm: visible.map((item) => ({ ...item, w: Math.min(item.w, 6) })) }),
    [visible],
  )
  const updateUsage = useDashboardDocsStore((s) => s.updateUsage)
  const traceLevel = useObservabilityStore((s) => s.level)
  const setTraceLevel = useObservabilityStore((s) => s.setLevel)

  const addTile = (type: TileType) => {
    const tile = tileFromType(type)
    const next: Layout[number] = { i: tile.id, x: 0, y: Infinity, w: 6, h: 4, minW: 3, minH: 3 }
    updateLayout([...layout, next], dashboard.id)
    setGalleryOpen(false)
  }
  // Tile removal is reversible, so it never blocks on a dialog: remove now and
  // offer Undo. (Two stacked native `window.confirm`s were the reason removal
  // looked broken — the second one returns false in some Tauri webviews.)
  const removeTile = (id: string) => {
    const meta = TILE_CATALOG.find((entry) => id === entry.id || id.startsWith(`${entry.id}-`))
    const item = layout.find((entry) => entry.i === id)
    if (!item) return
    if (expanded === id) setExpanded(null)
    updateLayout(layout.filter((entry) => entry.i !== id), dashboard.id)
    setUndo({ item, label: meta?.title ?? 'Tile' })
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
    undoTimer.current = window.setTimeout(() => {
      setUndo(null)
      undoTimer.current = null
    }, 8000)
  }
  const undoRemove = () => {
    if (!undo) return
    if (undoTimer.current !== null) {
      window.clearTimeout(undoTimer.current)
      undoTimer.current = null
    }
    updateLayout([...layout, undo.item], dashboard.id)
    setUndo(null)
  }
  useEffect(() => () => {
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current)
  }, [])
  const confirmDeleteDashboard = () => deleteDashboard(selectedId)
  const tileType = (id: string): TileType | undefined =>
    TILE_CATALOG.find((meta) => id === meta.id || id.startsWith(`${meta.id}-`))?.type
  // The path stepper is only meaningful on dashboards with path-dependent tiles
  // (and needs trace on: path replay is a sampled/full-trace feature, §10).
  const hasPathTiles = layout.some((item) => {
    const type = tileType(item.i)
    return type !== undefined && PATH_TILE_TYPES.has(type)
  })
  const isBuiltIn = BUILT_IN_DASHBOARDS.some((entry) => entry.id === dashboard.id)
  // In focus mode only the primary tiles are laid out; hidden tiles keep their positions.
  const onLayoutChange = (next: Layout) => {
    const moved = next.map(({ i, x, y, w, h, minW, minH }) => ({ i, x, y, w, h, minW, minH }))
    const ids = new Set(moved.map((m) => m.i))
    updateLayout([...moved, ...layout.filter((l) => !ids.has(l.i))], dashboard.id)
  }
  const goTrades = (view: TradeView) => navigate({ kind: 'trades', view })

  return (
    <div className="fina-root flex h-full min-h-0 flex-col bg-bg">
      <header className="workspace-header shrink-0 border-b border-line bg-panel">
        <AppMenuBar
          location={location}
          dashboards={dashboards}
          theme={theme}
          traceLevel={traceLevel}
          showAllTiles={showAll}
          onNavigate={navigate}
          onNewDashboard={() => setTemplateOpen(true)}
          onFromTemplate={() => setTemplateOpen(true)}
          onDuplicateDashboard={() => duplicateDashboard(selectedId)}
          onDeleteDashboard={() => setConfirmAction('delete-dashboard')}
          onToggleTheme={toggleTheme}
          onTraceLevel={(l) => setTraceLevel(l as ObservabilityLevel)}
          onToggleShowAllTiles={toggleShowAll}
          onAddTile={() => { if (location.kind !== 'dashboard') navigate({ kind: 'dashboard', dashboardId: selectedId }); setGalleryOpen(true) }}
          onChat={onOpenLocalAgent}
          onNotebook={() => setNotebookOpen(true)}
          onNewTrade={() => { goTrades('blotter'); setNewTradeSignal((n) => n + 1) }}
          onShortcuts={() => setHelp('shortcuts')}
          onAbout={() => setHelp('about')}
          right={
            <div className="ml-auto flex items-center gap-1.5">
              <button type="button" className="icon-button" title="Chat (Alt+C)" aria-label="Chat" onClick={onOpenLocalAgent}><MessageSquare size={14} /></button>
              <button type="button" className="icon-button" title="Notebook (Alt+B)" aria-label="Notebook" onClick={() => setNotebookOpen(true)}><BookOpen size={14} /></button>
              <button type="button" title="Toggle theme (Alt+T)" aria-label="Toggle theme" className="icon-button" onClick={toggleTheme}>{theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}</button>
            </div>
          }
        />
        {location.kind === 'dashboard' ? (
          <div className="dashboard-bar" data-testid="dashboard-bar">
            <input
              aria-label="Rename dashboard"
              value={dashboard.name}
              onChange={(e) => renameDashboard(dashboard.id, e.target.value)}
              className="dashboard-title"
              data-testid="dashboard-title"
            />
            <span className="text-[11px] text-muted" data-testid="tile-count">{showAll ? `${layout.length} tiles` : `${visible.length} of ${layout.length} tiles`}</span>
            <div className="ml-auto flex items-center gap-2">
              {hasPathTiles && traceLevel !== 'off' ? <PathStepper /> : null}
              {secondary.length ? (
                <button type="button" className="ghost-button" data-testid="toggle-all-tiles" aria-pressed={showAll} onClick={toggleShowAll}>
                  {showAll ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {showAll ? 'Focus on primary tiles' : `Show ${secondary.length} more`}
                </button>
              ) : null}
              {isBuiltIn ? (
                <button type="button" className="ghost-button" data-testid="reset-layout" onClick={() => setConfirmAction('reset-layout')}>
                  <RotateCcw size={13} /> Reset layout
                </button>
              ) : null}
              <button type="button" onClick={() => setGalleryOpen(true)} className="ghost-button" data-testid="add-tile"><Plus size={13} /> Add tile</button>
            </div>
          </div>
        ) : null}
      </header>
      {location.kind === 'trades' ? (
        <main className="workspace-canvas relative flex min-h-0 flex-1 flex-col overflow-hidden p-4">
          <Suspense fallback={null}>
            <TradeRepository view={location.view} onViewChange={goTrades} newTradeSignal={newTradeSignal} onOpenDashboard={(id) => navigate({ kind: 'dashboard', dashboardId: dashboards.some((d) => d.id === id) ? id : dashboards[0]!.id })} />
          </Suspense>
        </main>
      ) : location.kind === 'narrative' ? (
        <main className="workspace-canvas relative min-h-0 flex-1 overflow-auto p-5">
          <Suspense fallback={<div className="narrative-empty"><span>Loading Narrative Intelligence…</span></div>}>
            <NarrativeWorkspace view={location.view} />
          </Suspense>
        </main>
      ) : (
      <main className="workspace-canvas relative min-h-0 flex-1 overflow-auto p-4">
        <Grid
          className="layout"
          layouts={layouts}
          breakpoints={{ lg: 1200, md: 996, sm: 640, xs: 0 }}
          cols={{ lg: 12, md: 10, sm: 6, xs: 1 }}
          rowHeight={64}
          margin={[16, 16]}
          containerPadding={[0, 0]}
          compactType="vertical"
          onLayoutChange={onLayoutChange}
          draggableHandle=".tile-header"
          resizeHandles={['s', 'w', 'e', 'n', 'sw', 'nw', 'se', 'ne']}
        >
          {visible.map((item) => {
            const type = tileType(item.i)
            if (!type) return null
            const meta = TILE_CATALOG.find((m) => m.type === type)!
            return (
              <div key={item.i}>
                <TileCard
                  tile={{ id: item.i, type, title: meta.title }}
                  group={meta.group}
                  onRemove={() => removeTile(item.i)}
                  onExpand={() => setExpanded(item.i)}
                >
                  <TileRenderer type={type} />
                </TileCard>
              </div>
            )
          })}
        </Grid>
        {!showAll && secondary.length ? (
          <section className="more-tiles" data-testid="more-tiles" aria-label="More tiles">
            <button type="button" className="more-tiles-head" onClick={toggleShowAll}>
              <ChevronRight size={14} /> {secondary.length} more tile{secondary.length === 1 ? '' : 's'} in this dashboard
            </button>
            <div className="flex flex-wrap gap-2">
              {secondary.map((item) => {
                const meta = TILE_CATALOG.find((m) => m.type === tileType(item.i))
                return meta ? <button key={item.i} type="button" className="tile-chip" data-testid={`more-tile-${item.i}`} onClick={() => setExpanded(item.i)} title="Open in a focused view">{meta.title}</button> : null
              })}
            </div>
          </section>
        ) : null}
        {layout.length === 0 ? (
          <div className="empty-workspace">
            <LayoutGrid size={26} className="text-primary" />
            <h2 className="mt-3 text-sm font-semibold text-main">Start building your dashboard</h2>
            <p className="mt-1 text-xs text-muted">Add a visualization tile from the gallery to begin.</p>
            <button className="add-tile-button mt-4" onClick={() => setGalleryOpen(true)} type="button">
              <Plus size={14} /> Browse tiles
            </button>
          </div>
        ) : null}
        {expanded ? (
          <div className="modal-backdrop" onMouseDown={() => setExpanded(null)}>
            <div className="expanded-modal" data-testid="expanded-tile" onMouseDown={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <div>
                  <p className="eyebrow">Focused view</p>
                  <h2 className="text-sm font-semibold text-main">
                    {TILE_CATALOG.find((m) => expanded === m.id || expanded.startsWith(`${m.id}-`))?.title}
                  </h2>
                </div>
                <button className="icon-button" onClick={() => setExpanded(null)} type="button" aria-label="Close focused view">
                  ×
                </button>
              </div>
              <div className="min-h-0 flex-1 p-3">
                {tileType(expanded) ? <TileRenderer type={tileType(expanded)!} /> : null}
              </div>
            </div>
          </div>
        ) : null}
      </main>
      )}
      <TileGallery open={galleryOpen} onClose={() => setGalleryOpen(false)} onAdd={addTile} />
      {help ? (
        <div className="modal-backdrop" onMouseDown={() => setHelp(null)}>
          <div className="expanded-modal help-modal" role="dialog" aria-label={help === 'about' ? 'About' : 'Keyboard shortcuts'} data-testid={`help-${help}`} onMouseDown={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h2 className="text-sm font-semibold text-main">{help === 'about' ? 'About' : 'Keyboard shortcuts'}</h2>
              <button className="icon-button" onClick={() => setHelp(null)} type="button" aria-label="Close">×</button>
            </div>
            <div className="overflow-auto p-4 text-xs text-main">
              {help === 'about' ? (
                <p>Structured Product Explorer — quant workspace with riga-flow pricing, tac-engine market data and the trade repository (docs 51–53).</p>
              ) : (
                <table className="w-full"><tbody>
                  {[['Ctrl/⌘ K', 'Command palette — go to any dashboard, view or command'], ['Alt 1–8', 'Dashboards'], ['Alt Shift 1–5', 'Trade repository views'], ['Alt N', 'New trade'], ['Alt C / Alt B', 'Chat / Notebook'], ['Alt A', 'Show all tiles / focus'], ['Alt T', 'Toggle theme'], ['Alt W', 'Close the active document tab'], ['Alt [ / Alt ]', 'Previous / next document tab'], ['/ N A T ?', 'Trade repository: search, new, amend, time travel, help']].map(([k, d]) => <tr key={k} className="border-b border-line"><td className="py-1.5 pr-4"><kbd>{k}</kbd></td><td>{d}</td></tr>)}
                </tbody></table>
              )}
            </div>
          </div>
        </div>
      ) : null}
      <NotebookDrawer
        dashboardId={dashboard.id}
        dashboardName={dashboard.name}
        open={notebookOpen}
        onClose={() => setNotebookOpen(false)}
      />
      <TemplateGallery
        open={templateOpen}
        onClose={() => setTemplateOpen(false)}
        onCreate={(name, nextLayout, usage) => {
          const id = createDashboardFromTemplate(name, nextLayout)
          updateUsage(id, { purpose: usage })
          setTemplateOpen(false)
          navigate({ kind: 'dashboard', dashboardId: id })
          setNotebookOpen(true)
        }}
      />
      <ConfirmDialog
        open={confirmAction !== null}
        title={confirmAction === 'reset-layout' ? `Reset “${dashboard.name}” layout?` : `Delete “${dashboard.name}”?`}
        message={
          confirmAction === 'reset-layout'
            ? 'Restore the built-in tile set and positions for this dashboard. Other dashboards are not affected.'
            : 'This dashboard and its layout will be deleted. Tiles in other dashboards are not affected.'
        }
        confirmLabel={confirmAction === 'reset-layout' ? 'Reset layout' : 'Delete dashboard'}
        onCancel={() => setConfirmAction(null)}
        onConfirm={() => {
          if (confirmAction === 'reset-layout') resetDashboardLayout(dashboard.id)
          if (confirmAction === 'delete-dashboard') confirmDeleteDashboard()
          setConfirmAction(null)
        }}
      />
      {undo ? (
        <div className="undo-bar" role="status" data-testid="undo-bar">
          <span>
            Removed <span className="font-semibold text-main">{undo.label}</span>.
          </span>
          <button type="button" className="ghost-button" onClick={undoRemove} data-testid="undo-remove">
            Undo
          </button>
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setUndo(null)}>
            ×
          </button>
        </div>
      ) : null}
    </div>
  )
}
