import { Command as Cmd } from 'cmdk'
import {
  BookOpen, Columns3, Copy, Database, FilePlus2, FileUp, HelpCircle, History, Keyboard, LayoutGrid, Layers, ArrowLeftRight,
  MessageSquare, Moon, Plus, Search, Sun, Trash2, BookOpenCheck, Activity, CalendarClock, BrainCircuit, ShieldCheck, Clapperboard, BriefcaseBusiness, WalletCards, ListChecks, ClipboardList, Newspaper, Star,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Menubar, MenubarCheckboxItem, MenubarContent, MenubarItem, MenubarLabel, MenubarMenu, MenubarRadioGroup, MenubarRadioItem,
  MenubarSeparator, MenubarShortcut, MenubarTrigger, MenubarSub, MenubarSubContent, MenubarSubTrigger,
} from '@/components/ui/menubar'
import { accelLabel, matchAccel, TRADE_VIEWS, TRADING2_VIEWS, RD_VIEWS, RISKCUBE_VIEWS, type Location, type TradeView, type Trading2View, type RdView, type RiskCubeView } from '../navigation'

const TRADE_ICONS: Record<TradeView, typeof Layers> = { blotter: BookOpenCheck, positions: Layers, recon: ArrowLeftRight, audit: History, import: FileUp, fixings: CalendarClock }
const TRADING2_ICONS: Record<Trading2View, typeof BriefcaseBusiness> = { overview: BriefcaseBusiness, account: WalletCards, positions: ListChecks, orders: ClipboardList, news: Newspaper, watchlist: Star, macro: Activity, calendar: CalendarClock }
const RD_ICONS: Record<RdView, typeof BrainCircuit> = { dashboard: BrainCircuit, input: ClipboardList, result: ClipboardList, model: BrainCircuit, blotter: Activity, models: Database }
const RISKCUBE_ICONS: Record<RiskCubeView, typeof Layers> = { scenarios: Layers, versions: History, slice: Columns3, cubes: Database }

export interface MenuCommand { id: string; group: string; label: string; icon: typeof Layers; accel?: string; run: () => void; keywords?: string }

export interface AppMenuBarProps {
  location: Location
  dashboards: { id: string; name: string }[]
  theme: 'dark' | 'light'
  traceLevel: string
  showAllTiles: boolean
  onNavigate: (l: Location) => void
  onNewDashboard: () => void
  onDuplicateDashboard: () => void
  onDeleteDashboard: () => void
  onFromTemplate: () => void
  onToggleTheme: () => void
  onTraceLevel: (l: 'off' | 'sampled' | 'full') => void
  onToggleShowAllTiles: () => void
  onAddTile: () => void
  onChat: () => void
  onNotebook: () => void
  onNewTrade: () => void
  onShortcuts: () => void
  onAbout: () => void
}

export function useMenuCommands(p: AppMenuBarProps): MenuCommand[] {
  return useMemo(() => {
    const dash = p.dashboards.map((d, i) => ({
      id: `dashboard:${d.id}`, group: 'Dashboards', label: d.name, icon: LayoutGrid, accel: i < 9 ? `Alt+${i + 1}` : undefined,
      run: () => p.onNavigate({ kind: 'dashboard', dashboardId: d.id }),
    }))
    const trades = TRADE_VIEWS.map((v) => ({ id: `trades:${v.id}`, group: 'Trades', label: `Trade Repository: ${v.label}`, icon: TRADE_ICONS[v.id], accel: v.accel, keywords: 'trade repository', run: () => p.onNavigate({ kind: 'trades', view: v.id }) }))
    const trading2 = TRADING2_VIEWS.map((v) => ({ id: `trading2:${v.id}`, group: 'Trading 2ⁿᵈ', label: `Trading 2ⁿᵈ: ${v.label}`, icon: TRADING2_ICONS[v.id], accel: v.accel, keywords: 'alpaca account positions orders broker', run: () => p.onNavigate({ kind: 'trading2', view: v.id }) }))
    const rd = RD_VIEWS.map((v) => ({ id: `rd:${v.id}`, group: 'R&D', label: `R&D: ${v.label}`, icon: RD_ICONS[v.id], accel: v.accel, keywords: 'research experiment run mlflow qlib model metrics input result blotter registry', run: () => p.onNavigate({ kind: 'rd', view: v.id }) }))
    const riskcube = RISKCUBE_VIEWS.map((v) => ({ id: `riskcube:${v.id}`, group: 'RiskCube', label: `RiskCube: ${v.label}`, icon: RISKCUBE_ICONS[v.id], accel: v.accel, keywords: 'OLAP scenario version sensitivity P&L cube partition', run: () => p.onNavigate({ kind: 'riskcube', view: v.id }) }))
    const narrative = [
      { id: 'narrative:overview', group: 'Narrative', label: 'Narrative Intelligence', icon: BrainCircuit, keywords: 'events evidence claims', run: () => p.onNavigate({ kind: 'narrative', view: 'overview' as const }) },
      { id: 'narrative:claims', group: 'Narrative', label: 'Claim Explorer', icon: ShieldCheck, keywords: 'claims evidence provenance', run: () => p.onNavigate({ kind: 'narrative', view: 'claims' as const }) },
    ]
    const video = [
      { id: 'video:projects', group: 'Video', label: 'Video Workspace', icon: Clapperboard, accel: 'Alt+V', keywords: 'video projects storyboard shots assets', run: () => p.onNavigate({ kind: 'video', view: 'projects' as const }) },
    ]
    return [
      { id: 'file:new-dashboard', group: 'File', label: 'New dashboard from template…', icon: Plus, run: p.onNewDashboard },
      { id: 'file:duplicate', group: 'File', label: 'Duplicate dashboard', icon: Copy, run: p.onDuplicateDashboard },
      { id: 'file:delete', group: 'File', label: 'Delete dashboard…', icon: Trash2, run: p.onDeleteDashboard },
      ...dash,
      ...trades,
      ...trading2,
      ...rd,
      ...riskcube,
      ...narrative,
      ...video,
      { id: 'trades:new', group: 'Trades', label: 'New trade…', icon: Plus, accel: 'Alt+N', run: p.onNewTrade },
      { id: 'tools:add-tile', group: 'Tools', label: 'Add tile…', icon: Columns3, run: p.onAddTile },
      { id: 'tools:chat', group: 'Tools', label: 'Chat (RIGA assistant)', icon: MessageSquare, accel: 'Alt+C', run: p.onChat },
      { id: 'tools:notebook', group: 'Tools', label: 'Notebook', icon: BookOpen, accel: 'Alt+B', run: p.onNotebook },
      { id: 'view:theme', group: 'View', label: 'Toggle light / dark theme', icon: p.theme === 'dark' ? Sun : Moon, accel: 'Alt+T', run: p.onToggleTheme },
      { id: 'view:all-tiles', group: 'View', label: p.showAllTiles ? 'Focus: show primary tiles only' : 'Show all tiles', icon: LayoutGrid, accel: 'Alt+A', run: p.onToggleShowAllTiles },
      { id: 'help:shortcuts', group: 'Help', label: 'Keyboard shortcuts', icon: Keyboard, accel: 'Shift+?', run: p.onShortcuts },
    ] as MenuCommand[]
  }, [p])
}

function Item({ cmd, testId }: { cmd: MenuCommand; testId?: string }) {
  const Icon = cmd.icon
  return (
    <MenubarItem data-testid={testId ?? `menuitem-${cmd.id.replace(/[:]/g, '-')}`} onSelect={cmd.run}>
      <Icon /> {cmd.label}
      {cmd.accel ? <MenubarShortcut>{accelLabel(cmd.accel)}</MenubarShortcut> : null}
    </MenubarItem>
  )
}

export function AppMenuBar(props: AppMenuBarProps & { right?: ReactNode }) {
  const commands = useMenuCommands(props)
  const [palette, setPalette] = useState(false)
  const by = (g: string) => commands.filter((c) => c.group === g)
  const loc = props.location

  // Global accelerators (also work in the Tauri webview, which has no native menu here).
  useEffect(() => {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform)
    const onKey = (e: KeyboardEvent) => {
      if (matchAccel(e, 'Mod+K', mac) || matchAccel(e, 'Mod+Shift+P', mac)) { e.preventDefault(); setPalette((o) => !o); return }
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      for (const c of commands) if (c.accel && c.accel !== 'Shift+?' && matchAccel(e, c.accel, false)) { e.preventDefault(); c.run(); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commands])

  const where = loc.kind === 'dashboard'
    ? ['Dashboards', props.dashboards.find((d) => d.id === loc.dashboardId)?.name ?? '—']
    : loc.kind === 'trades'
      ? ['Trade Repository', TRADE_VIEWS.find((v) => v.id === loc.view)!.label]
      : loc.kind === 'trading2'
        ? ['Trading 2ⁿᵈ', TRADING2_VIEWS.find((v) => v.id === loc.view)!.label]
      : loc.kind === 'rd'
        ? ['R&D', RD_VIEWS.find((v) => v.id === loc.view)!.label]
      : loc.kind === 'riskcube'
        ? ['RiskCube', RISKCUBE_VIEWS.find((v) => v.id === loc.view)!.label]
      : loc.kind === 'video'
        ? ['Video Workspace', loc.view === 'projects' ? 'Projects' : 'Episode workspace']
        : ['Narrative Intelligence', loc.view === 'claims' ? 'Claim Explorer' : 'Event review']

  return (
    <div className="app-menubar" data-testid="app-menubar">
      <div className="brand-mark brand-mark-sm" aria-hidden><Activity size={14} /></div>
      <Menubar className="app-menubar-root" aria-label="Application menu">
        <MenubarMenu>
          <MenubarTrigger data-testid="menu-file">File</MenubarTrigger>
          <MenubarContent>
            {by('File').slice(0, 1).map((c) => <Item key={c.id} cmd={c} />)}
            <MenubarItem data-testid="menuitem-file-from-template" onSelect={props.onFromTemplate}><FilePlus2 /> Create from template…</MenubarItem>
            <MenubarSeparator />
            {by('File').slice(1).map((c) => <Item key={c.id} cmd={c} />)}
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger data-testid="menu-view">View</MenubarTrigger>
          <MenubarContent>
            <MenubarItem data-testid="menuitem-view-palette" onSelect={() => setPalette(true)}><Search /> Command palette…<MenubarShortcut>{accelLabel('Mod+K')}</MenubarShortcut></MenubarItem>
            <MenubarSeparator />
            <MenubarCheckboxItem data-testid="menuitem-view-all-tiles" checked={props.showAllTiles} onCheckedChange={props.onToggleShowAllTiles}>Show all tiles<MenubarShortcut>{accelLabel('Alt+A')}</MenubarShortcut></MenubarCheckboxItem>
            <MenubarItem data-testid="menuitem-view-theme" onSelect={props.onToggleTheme}>{props.theme === 'dark' ? <Sun /> : <Moon />} {props.theme === 'dark' ? 'Light theme' : 'Dark theme'}<MenubarShortcut>{accelLabel('Alt+T')}</MenubarShortcut></MenubarItem>
            <MenubarSeparator />
            <MenubarLabel className="text-xs text-muted">Trace level</MenubarLabel>
            <MenubarRadioGroup value={props.traceLevel} onValueChange={(v) => props.onTraceLevel(v as 'off' | 'sampled' | 'full')}>
              {['off', 'sampled', 'full'].map((l) => <MenubarRadioItem key={l} value={l} data-testid={`menuitem-trace-${l}`}>{l[0]!.toUpperCase() + l.slice(1)}</MenubarRadioItem>)}
            </MenubarRadioGroup>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger data-testid="menu-dashboards">Dashboards</MenubarTrigger>
          <MenubarContent>
            {by('Dashboards').map((c) => (
              <MenubarCheckboxItem key={c.id} data-testid={`menuitem-${c.id.replace(':', '-')}`} checked={loc.kind === 'dashboard' && `dashboard:${loc.dashboardId}` === c.id} onCheckedChange={c.run}>
                {c.label}{c.accel ? <MenubarShortcut>{accelLabel(c.accel)}</MenubarShortcut> : null}
              </MenubarCheckboxItem>
            ))}
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger data-testid="menu-trades">Trades</MenubarTrigger>
          <MenubarContent>
            {by('Trades').filter((c) => c.id !== 'trades:new').map((c) => <Item key={c.id} cmd={{ ...c, label: c.label.replace('Trade Repository: ', '') }} />)}
            <MenubarSeparator />
            {by('Trades').filter((c) => c.id === 'trades:new').map((c) => <Item key={c.id} cmd={c} />)}
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger data-testid="menu-trading2">Trading 2ⁿᵈ</MenubarTrigger>
          <MenubarContent>{by('Trading 2ⁿᵈ').map((c) => <Item key={c.id} cmd={{ ...c, label: c.label.replace('Trading 2ⁿᵈ: ', '') }} />)}</MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger data-testid="menu-rd">R&amp;D</MenubarTrigger>
          <MenubarContent>
            {by('R&D').filter((c) => c.id === 'rd:dashboard').map((c) => <Item key={c.id} cmd={{ ...c, label: 'Dashboard' }} />)}
            <MenubarSub>
              <MenubarSubTrigger>Runs</MenubarSubTrigger>
              <MenubarSubContent>
                {by('R&D').filter((c) => ['rd:input', 'rd:result', 'rd:model', 'rd:blotter'].includes(c.id)).map((c) => <Item key={c.id} cmd={{ ...c, label: c.label.replace('R&D: ', '') }} />)}
              </MenubarSubContent>
            </MenubarSub>
            <MenubarSeparator />
            {by('R&D').filter((c) => c.id === 'rd:models').map((c) => <Item key={c.id} cmd={{ ...c, label: 'Models' }} />)}
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger data-testid="menu-riskcube">RiskCube</MenubarTrigger>
          <MenubarContent>{by('RiskCube').map((c) => <Item key={c.id} cmd={{ ...c, label: c.label.replace('RiskCube: ', '') }} />)}</MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger data-testid="menu-narrative">Narrative</MenubarTrigger>
          <MenubarContent>{by('Narrative').map((c) => <Item key={c.id} cmd={c} />)}</MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger data-testid="menu-video">Video</MenubarTrigger>
          <MenubarContent>{by('Video').map((c) => <Item key={c.id} cmd={c} />)}</MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger data-testid="menu-tools">Tools</MenubarTrigger>
          <MenubarContent>{by('Tools').map((c) => <Item key={c.id} cmd={c} />)}</MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger data-testid="menu-help">Help</MenubarTrigger>
          <MenubarContent>
            {by('Help').map((c) => <Item key={c.id} cmd={c} />)}
            <MenubarItem data-testid="menuitem-help-about" onSelect={props.onAbout}><HelpCircle /> About Structured Product Explorer</MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>
      <nav className="app-breadcrumb" aria-label="Location" data-testid="breadcrumb">
        {loc.kind === 'trades' ? <Database size={12} /> : loc.kind === 'trading2' ? <BriefcaseBusiness size={12} /> : loc.kind === 'rd' ? <BrainCircuit size={12} /> : loc.kind === 'riskcube' ? <Database size={12} /> : loc.kind === 'narrative' ? <BrainCircuit size={12} /> : loc.kind === 'video' ? <Clapperboard size={12} /> : <LayoutGrid size={12} />}
        <span>{where[0]}</span><span className="text-muted">/</span><b>{where[1]}</b>
      </nav>
      <button type="button" className="palette-button" data-testid="open-palette" onClick={() => setPalette(true)}>
        <Search size={13} /> <span>Go to anything…</span> <kbd>{accelLabel('Mod+K')}</kbd>
      </button>
      {props.right}
      {palette ? (
        <div className="modal-backdrop palette-backdrop" onMouseDown={() => setPalette(false)}>
          <Cmd label="Command palette" className="palette" data-testid="command-palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') setPalette(false) }}>
            <div className="palette-input"><Search size={15} /><Cmd.Input autoFocus placeholder="Type a dashboard, view or command…" data-testid="palette-input" /></div>
            <Cmd.List className="palette-list">
              <Cmd.Empty className="px-3 py-6 text-center text-xs text-muted">No matches.</Cmd.Empty>
              {['Dashboards', 'Trades', 'Trading 2ⁿᵈ', 'R&D', 'RiskCube', 'Narrative', 'Video', 'Tools', 'View', 'File', 'Help'].map((g) => (
                <Cmd.Group key={g} heading={g} className="palette-group">
                  {by(g).map((c) => {
                    const Icon = c.icon
                    return (
                      <Cmd.Item key={c.id} value={`${c.group} ${c.label} ${c.keywords ?? ''}`} data-testid={`palette-${c.id.replace(/[:]/g, '-')}`} className="palette-item" onSelect={() => { setPalette(false); c.run() }}>
                        <Icon size={14} /> <span className="flex-1">{c.label}</span>{c.accel ? <kbd>{accelLabel(c.accel)}</kbd> : null}
                      </Cmd.Item>
                    )
                  })}
                </Cmd.Group>
              ))}
            </Cmd.List>
          </Cmd>
        </div>
      ) : null}
    </div>
  )
}
