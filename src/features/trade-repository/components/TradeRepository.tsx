import { ArrowLeftRight, BookOpenCheck, CalendarClock, ChevronDown, Clock, FileUp, History, Keyboard, Layers, Pin, PinOff, ShieldCheck, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Toaster, toast } from 'sonner'
import { tradeRepo } from '../api'
import type { AsOf, EventDef, PricingBinding, Reference, Role, Trade } from '../types'
import { toInstrumentDocument } from '../pricing'
import { useInstrumentStore } from '@/store/instrumentStore'
import { AuditView } from './AuditView'
import { Blotter, type BlotterHandle } from './Blotter'
import { ErrorState, Loading, Modal } from './common'
import { FixingsView } from './FixingsView'
import { ImportView } from './ImportView'
import { LifecycleDialog } from './LifecycleDialog'
import { PositionsView } from './PositionsView'
import { ReconView } from './ReconView'
import { TradeDrawer } from './TradeDrawer'
import { TradeForm } from './TradeForm'
import * as Tabs from '../docTabs'
import type { TradeInput } from '../types'
import '../trade-repo.css'

export type View = 'blotter' | 'positions' | 'recon' | 'audit' | 'import' | 'fixings'
const VIEWS: { id: View; label: string; icon: typeof Layers; key: string }[] = [
  { id: 'blotter', label: 'Blotter', icon: BookOpenCheck, key: '1' },
  { id: 'positions', label: 'Positions', icon: Layers, key: '2' },
  { id: 'recon', label: 'Reconciliation', icon: ArrowLeftRight, key: '3' },
  { id: 'audit', label: 'Audit log', icon: History, key: '4' },
  { id: 'import', label: 'Bulk import', icon: FileUp, key: '5' },
  { id: 'fixings', label: 'Fixings', icon: CalendarClock, key: '6' },
]
const SHORTCUTS: [string, string][] = [['/', 'Focus blotter search'], ['N', 'New trade'], ['A', 'Amend selected trade'], ['Alt Shift 1 – 6', 'Switch view (menu Trades)'], ['Double-click row', 'Open trade in a document tab'], ['Alt W', 'Close active tab'], ['Alt [ / Alt ]', 'Previous / next tab'], ['T', 'Toggle as-of time travel'], ['Esc', 'Close drawer / dialog'], ['Enter', 'Open focused row'], ['?', 'Show shortcuts']]

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
}

export function TradeRepository({ view, onViewChange, newTradeSignal = 0, onOpenDashboard }: { view: View; onViewChange: (v: View) => void; newTradeSignal?: number; onOpenDashboard?: (id: string) => void }) {
  const applyDocument = useInstrumentStore((s) => s.applyDocument)
  const currentDoc = useInstrumentStore((s) => s.document)
  const setView = onViewChange
  const [tabs, setTabsState] = useState<Tabs.TabsState>(() => Tabs.loadTabs())
  const setTabs = useCallback((f: (s: Tabs.TabsState) => Tabs.TabsState) => setTabsState((s) => { const n = f(s); Tabs.saveTabs(n); return n }), [])
  const activeTab = tabs.tabs.find((t) => t.id === tabs.active)
  const [overflow, setOverflow] = useState(false)
  const [formTab, setFormTab] = useState<string | null>(null)
  const goHome = () => setTabs((s) => ({ ...s, active: Tabs.HOME }))
  const openTab = (tradeId: string, version?: number) => setTabs((s) => Tabs.openTab(s, tradeId, version))
  const requestClose = (id: string) => {
    const t = tabs.tabs.find((x) => x.id === id)
    if (t?.draft && !window.confirm(`${Tabs.tabLabel(t)} has an unsaved amend draft. Close and discard it?`)) return
    setTabs((s) => Tabs.closeTab(s, id))
  }
  const [reference, setReference] = useState<Reference | null>(null)
  const [refError, setRefError] = useState<unknown>(null)
  const [userId, setUserId] = useState('trash.box')
  const [selected, setSelected] = useState<string | null>(null)
  const [form, setForm] = useState<{ trade?: Trade; tab?: string } | null>(null)
  const [lifecycle, setLifecycle] = useState<{ trade: Trade; event: EventDef } | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [timeTravel, setTimeTravel] = useState(false)
  const [validAt, setValidAt] = useState('')
  const [knownAt, setKnownAt] = useState('')
  const [help, setHelp] = useState(false)
  const [drilled, setDrilled] = useState<string[] | null>(null)
  const blotterRef = useRef<BlotterHandle>(null)
  const lastTrade = useRef<Trade | null>(null)

  const loadRef = useCallback(() => {
    setRefError(null)
    tradeRepo.call<Reference>('tr_reference_list').then(setReference).catch(setRefError)
  }, [])
  useEffect(loadRef, [loadRef])

  const user = reference?.users.find((u) => u.userId === userId)
  const role: Role = user?.role ?? 'viewer'
  useEffect(() => { tradeRepo.setSession({ actor: userId, role }); setRefreshKey((k) => k + 1) }, [userId, role])
  const canWrite = role !== 'viewer'
  const asOf = useMemo<AsOf>(() => (timeTravel ? { validAt: validAt || undefined, knownAt: knownAt ? new Date(knownAt).toISOString() : undefined } : {}), [timeTravel, validAt, knownAt])
  const bump = (msg?: string) => { setRefreshKey((k) => k + 1); if (msg) toast.success(msg) }

  const priceTrade = async (t: Trade) => {
    try {
      const b = await tradeRepo.call<PricingBinding>('tr_trade_pricing', { tradeId: t.tradeId, version: t.version })
      if (!b.applicable) { toast.error(`${t.tradeId}: not priceable by ${b.engine} (${b.notes[0] ?? 'see template binding'})`); return }
      applyDocument(toInstrumentDocument(t, b, currentDoc ?? undefined))
      toast.success(`${t.tradeId} loaded into Payoff Explorer (${b.engine} ${b.tool})`)
      onOpenDashboard?.(b.dashboard ?? 'payoff-explorer')
    } catch (e) { toast.error(String((e as Error).message ?? e)) }
  }
  const openTrade = (id: string) => { setSelected(id); goHome(); setView('blotter') }
  useEffect(() => { if (newTradeSignal) { goHome(); setForm({}) } }, [newTradeSignal]) // eslint-disable-line react-hooks/exhaustive-deps
  // Amend from a document tab carries its draft; from the inspector a tab is opened to hold it.
  const amend = (t: Trade, fromTab?: string) => {
    const tabIdForDraft = fromTab ?? Tabs.tabId(t.tradeId)
    setFormTab(tabIdForDraft)
    setForm({ trade: t, tab: tabIdForDraft })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (help) setHelp(false); else if (!form && !lifecycle) setSelected(null); return }
      if (e.altKey && !e.ctrlKey && !e.metaKey && !form && !lifecycle) {
        if (e.code === 'KeyW') { e.preventDefault(); const t = tabs.tabs.find((x) => x.id === tabs.active); if (t && !t.pinned) requestClose(t.id) }
        else if (e.code === 'BracketLeft') { e.preventDefault(); setTabs((s) => Tabs.cycle(s, -1)) }
        else if (e.code === 'BracketRight') { e.preventDefault(); setTabs((s) => Tabs.cycle(s, 1)) }
        return
      }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || form || lifecycle) return
      if (e.key === '/') { e.preventDefault(); goHome(); setView('blotter'); setTimeout(() => blotterRef.current?.focusSearch(), 0) }
      else if (e.key === 'n' || e.key === 'N') { if (canWrite) { e.preventDefault(); setForm({}) } }
      else if ((e.key === 'a' || e.key === 'A') && lastTrade.current && canWrite) { e.preventDefault(); amend(lastTrade.current, activeTab?.id) }
      else if (e.key === 't' || e.key === 'T') setTimeTravel((t) => !t)
      else if (e.key === '?') setHelp(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [help, form, lifecycle, canWrite, tabs]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the selected trade's latest state for the "A" shortcut.
  useEffect(() => {
    lastTrade.current = null
    const cur = activeTab ? activeTab.tradeId : selected
    if (!cur) return
    tradeRepo.call<{ trade: Trade }>('tr_trade_get', { tradeId: cur }).then((r) => { lastTrade.current = r.trade.status === 'LIVE' ? r.trade : null }).catch(() => {})
  }, [selected, refreshKey, activeTab])

  if (refError) return <div className="tr-root"><ErrorState error={refError} onRetry={loadRef} /></div>
  if (!reference) return <div className="tr-root"><Loading label="Connecting to trade repository…" /></div>

  return (
    <div className="tr-root" data-testid="trade-repository">
      <Toaster position="bottom-right" richColors closeButton />
      <div className="tr-header">
        <nav className="doc-tabs" role="tablist" aria-label="Open documents" data-testid="doc-tabs">
          {(() => { const v = VIEWS.find((x) => x.id === view)!; const Icon = v.icon; return (
            <button role="tab" type="button" aria-selected={tabs.active === Tabs.HOME} data-testid="doc-tab-home" className={`doc-tab home ${tabs.active === Tabs.HOME ? 'active' : ''}`} onClick={goHome} title={`${v.label} (home view)`}>
              <Icon size={13} /> {v.label}
            </button>) })()}
          {tabs.tabs.map((t) => (
            <div key={t.id} role="tab" tabIndex={0} aria-selected={tabs.active === t.id} data-testid={`doc-tab-${t.id}`} data-pinned={t.pinned || undefined} data-dirty={t.draft ? true : undefined}
              className={`doc-tab ${tabs.active === t.id ? 'active' : ''} ${t.pinned ? 'pinned' : ''}`}
              onClick={() => setTabs((s) => ({ ...s, active: t.id }))}
              onKeyDown={(e) => { if (e.key === 'Enter') setTabs((s) => ({ ...s, active: t.id })) }}
              onAuxClick={(e) => { if (e.button === 1 && !t.pinned) { e.preventDefault(); requestClose(t.id) } }}
              title={`${Tabs.tabLabel(t)}${t.draft ? ' — unsaved amend draft' : ''}${t.pinned ? ' (pinned)' : ''}`}>
              <span className="doc-tab-label">{Tabs.tabLabel(t)}</span>
              {t.draft ? <span className="doc-dirty" aria-label="unsaved changes" data-testid="tab-dirty">●</span> : null}
              <button type="button" className="doc-tab-btn" aria-label={t.pinned ? 'Unpin tab' : 'Pin tab'} data-testid={`pin-${t.id}`} onClick={(e) => { e.stopPropagation(); setTabs((s) => Tabs.togglePin(s, t.id)) }}>{t.pinned ? <PinOff size={11} /> : <Pin size={11} />}</button>
              {!t.pinned ? <button type="button" className="doc-tab-btn" aria-label="Close tab" data-testid={`close-${t.id}`} onClick={(e) => { e.stopPropagation(); requestClose(t.id) }}><X size={11} /></button> : null}
            </div>
          ))}
          {tabs.tabs.length ? (
            <div className="relative">
              <button type="button" className="doc-tab-btn overflow" aria-label="All open tabs" data-testid="tabs-overflow" onClick={() => setOverflow((o) => !o)}><ChevronDown size={13} /> {tabs.tabs.length}</button>
              {overflow ? (
                <div className="tr-popover right-0" data-testid="tabs-overflow-menu" onMouseLeave={() => setOverflow(false)}>
                  {tabs.tabs.map((t) => <button key={t.id} type="button" className="tr-menu-item" onClick={() => { setTabs((s) => ({ ...s, active: t.id })); setOverflow(false) }}>{t.pinned ? '📌 ' : ''}{Tabs.tabLabel(t)}{t.draft ? ' ●' : ''}</button>)}
                  <hr className="my-1 border-line" />
                  {activeTab ? <button type="button" className="tr-menu-item" data-testid="close-others" onClick={() => { setTabs((s) => Tabs.closeOthers(s, activeTab.id)); setOverflow(false) }}>Close others (keeps pinned &amp; drafts)</button> : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" data-testid="time-travel-toggle" aria-pressed={timeTravel} className={`tr-chip ${timeTravel ? 'active' : ''}`} onClick={() => setTimeTravel((t) => !t)} title="Bitemporal as-of (T)"><Clock size={12} /> As-of</button>
          {timeTravel ? (
            <>
              <label className="flex items-center gap-1 text-[11px] text-muted">Business date<input type="date" data-testid="as-of-valid" className="tr-input w-36" value={validAt} onChange={(e) => setValidAt(e.target.value)} /></label>
              <label className="flex items-center gap-1 text-[11px] text-muted">Known at<input type="datetime-local" data-testid="as-of-known" className="tr-input w-48" value={knownAt} onChange={(e) => setKnownAt(e.target.value)} /></label>
            </>
          ) : null}
          <label className="flex items-center gap-1 text-[11px] text-muted"><ShieldCheck size={12} />
            <select aria-label="Acting user" data-testid="user-select" className="control-select" value={userId} onChange={(e) => setUserId(e.target.value)}>
              {reference.users.map((u) => <option key={u.userId} value={u.userId}>{u.name} · {u.role}</option>)}
            </select>
          </label>
          <button type="button" className="icon-button" title="Keyboard shortcuts (?)" data-testid="shortcuts" onClick={() => setHelp(true)}><Keyboard size={14} /></button>
        </div>
      </div>
      {timeTravel && (validAt || knownAt) ? <div className="tr-asof-banner" data-testid="asof-banner">Time travel: showing the repository {validAt ? `as of business date ${validAt}` : ''}{validAt && knownAt ? ' and ' : ''}{knownAt ? `as known at ${knownAt.replace('T', ' ')}` : ''}. Editing is disabled.</div> : null}
      {drilled && view === 'blotter' ? <div className="tr-info" data-testid="drill-banner">Position drill-down: {drilled.length} trades — {drilled.slice(0, 8).join(', ')}{drilled.length > 8 ? '…' : ''} <button type="button" className="tr-link" onClick={() => setDrilled(null)}>clear</button></div> : null}
      <div className="tr-body">
        {activeTab ? (
          <TradeDrawer key={activeTab.tradeId} mode="document" tradeId={activeTab.tradeId} version={activeTab.version} onVersion={(v) => setTabs((s) => Tabs.setVersion(s, activeTab.id, v))}
            onOpenTab={(v) => openTab(activeTab.tradeId, v)} hasDraft={!!activeTab.draft}
            asOf={activeTab.version ? {} : asOf} refreshKey={refreshKey} canWrite={canWrite && !timeTravel} onClose={() => requestClose(activeTab.id)}
            onAmend={(t) => amend(t, activeTab.id)} onLifecycle={(t, e) => setLifecycle({ trade: t, event: e })} onOpenTrade={(id) => openTab(id)} onPrice={onOpenDashboard ? (t) => void priceTrade(t) : undefined} />
        ) : null}
        {activeTab ? null : view === 'blotter' ? <Blotter ref={blotterRef} reference={reference} asOf={asOf} refreshKey={refreshKey} selectedId={selected} onSelect={setSelected} onOpen={(id) => openTab(id)} onNew={() => setForm({})} canWrite={canWrite && !timeTravel} /> : null}
        {!activeTab && view === 'positions' ? <PositionsView asOf={asOf} refreshKey={refreshKey} onDrill={(ids) => { setDrilled(ids); setView('blotter'); setSelected(ids[0] ?? null) }} /> : null}
        {!activeTab && view === 'recon' ? <ReconView refreshKey={refreshKey} canManage={role === 'ops' || role === 'admin'} actor={userId} onOpenTrade={openTrade} onChanged={(m) => bump(m)} /> : null}
        {!activeTab && view === 'audit' ? <AuditView refreshKey={refreshKey} onOpenTrade={openTrade} /> : null}
        {!activeTab && view === 'import' ? <ImportView canWrite={canWrite} onImported={(m) => bump(m)} /> : null}
        {!activeTab && view === 'fixings' ? <FixingsView canManage={!timeTravel && (role === 'ops' || role === 'admin')} onOpenTrade={openTrade} onCommitted={(m) => bump(m)} /> : null}
        {selected && !activeTab && view === 'blotter' ? (
          <TradeDrawer tradeId={selected} asOf={asOf} refreshKey={refreshKey} canWrite={canWrite && !timeTravel} onClose={() => setSelected(null)} onAmend={(t) => amend(t)} onLifecycle={(t, e) => setLifecycle({ trade: t, event: e })} onOpenTrade={setSelected} onPrice={onOpenDashboard ? (t) => void priceTrade(t) : undefined} onOpenTab={(v) => openTab(selected, v)} hasDraft={!!tabs.tabs.find((x) => x.id === Tabs.tabId(selected))?.draft} />
        ) : null}
      </div>
      {form ? (() => {
        const dt = form.tab ? tabs.tabs.find((x) => x.id === form.tab) : undefined
        return <TradeForm reference={reference} trade={form.trade} initialDraft={dt?.draft} initialReason={dt?.draftReason}
          onDraft={form.trade ? (d, r) => setTabs((s) => {
            const id = formTab ?? Tabs.tabId(form.trade!.tradeId)
            if (!d) return Tabs.setDraft(s, id, undefined)
            const withTab = s.tabs.some((x) => x.id === id) ? s : { ...Tabs.openTab(s, form.trade!.tradeId), active: s.active }
            return Tabs.setDraft(withTab, id, d as Partial<TradeInput>, r)
          }) : undefined}
          onClose={() => setForm(null)} onDone={(id, msg) => { setForm(null); setSelected(id); bump(msg) }} />
      })() : null}
      {lifecycle ? <LifecycleDialog reference={reference} trade={lifecycle.trade} event={lifecycle.event} onClose={() => setLifecycle(null)} onDone={(msg) => { setLifecycle(null); bump(msg) }} /> : null}
      {help ? (
        <Modal testId="shortcuts-dialog" title="Keyboard shortcuts" eyebrow="Trade repository" onClose={() => setHelp(false)}>
          <table className="tr-table"><tbody>{SHORTCUTS.map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>)}</tbody></table>
        </Modal>
      ) : null}
    </div>
  )
}
