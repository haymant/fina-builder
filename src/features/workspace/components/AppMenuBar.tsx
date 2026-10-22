import { Command as Cmd } from 'cmdk'
import {
  BookOpen, Columns3, Copy, Database, FilePlus2, FileUp, HelpCircle, History, Keyboard, LayoutGrid, Layers, ArrowLeftRight,
  MessageSquare, Moon, Plus, Search, Sun, Trash2, BookOpenCheck, Activity, CalendarClock,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Menubar, MenubarCheckboxItem, MenubarContent, MenubarItem, MenubarLabel, MenubarMenu, MenubarRadioGroup, MenubarRadioItem,
  MenubarSeparator, MenubarShortcut, MenubarTrigger,
} from '@/components/ui/menubar'
import { accelLabel, matchAccel, TRADE_VIEWS, type Location, type TradeView } from '../navigation'

const TRADE_ICONS: Record<TradeView, typeof Layers> = { blotter: BookOpenCheck, positions: Layers, recon: ArrowLeftRight, audit: History, import: FileUp, fixings: CalendarClock }

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
    return [
      { id: 'file:new-dashboard', group: 'File', label: 'New dashboard from template…', icon: Plus, run: p.onNewDashboard },
      { id: 'file:duplicate', group: 'File', label: 'Duplicate dashboard', icon: Copy, run: p.onDuplicateDashboard },
      { id: 'file:delete', group: 'File', label: 'Delete dashboard…', icon: Trash2, run: p.onDeleteDashboard },
      ...dash,
      ...trades,
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

  const where = loc.kind === 'dashboard' ? ['Dashboards', props.dashboards.find((d) => d.id === loc.dashboardId)?.name ?? '—'] : ['Trade Repository', TRADE_VIEWS.find((v) => v.id === loc.view)!.label]

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
        {loc.kind === 'trades' ? <Database size={12} /> : <LayoutGrid size={12} />}
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
              {['Dashboards', 'Trades', 'Tools', 'View', 'File', 'Help'].map((g) => (
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
