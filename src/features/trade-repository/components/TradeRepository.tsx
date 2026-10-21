import { ArrowLeftRight, BookOpenCheck, Clock, FileUp, History, Keyboard, Layers, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Toaster, toast } from 'sonner'
import { tradeRepo } from '../api'
import type { AsOf, LifecycleEvent, Reference, Role, Trade } from '../types'
import { AuditView } from './AuditView'
import { Blotter, type BlotterHandle } from './Blotter'
import { ErrorState, Loading, Modal } from './common'
import { ImportView } from './ImportView'
import { LifecycleDialog } from './LifecycleDialog'
import { PositionsView } from './PositionsView'
import { ReconView } from './ReconView'
import { TradeDrawer } from './TradeDrawer'
import { TradeForm } from './TradeForm'
import '../trade-repo.css'

type View = 'blotter' | 'positions' | 'recon' | 'audit' | 'import'
const VIEWS: { id: View; label: string; icon: typeof Layers; key: string }[] = [
  { id: 'blotter', label: 'Blotter', icon: BookOpenCheck, key: '1' },
  { id: 'positions', label: 'Positions', icon: Layers, key: '2' },
  { id: 'recon', label: 'Reconciliation', icon: ArrowLeftRight, key: '3' },
  { id: 'audit', label: 'Audit log', icon: History, key: '4' },
  { id: 'import', label: 'Bulk import', icon: FileUp, key: '5' },
]
const SHORTCUTS: [string, string][] = [['/', 'Focus blotter search'], ['N', 'New trade'], ['A', 'Amend selected trade'], ['1 – 5', 'Switch view'], ['T', 'Toggle as-of time travel'], ['Esc', 'Close drawer / dialog'], ['Enter', 'Open focused row'], ['?', 'Show shortcuts']]

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
}

export function TradeRepository() {
  const [reference, setReference] = useState<Reference | null>(null)
  const [refError, setRefError] = useState<unknown>(null)
  const [view, setView] = useState<View>('blotter')
  const [userId, setUserId] = useState('trash.box')
  const [selected, setSelected] = useState<string | null>(null)
  const [form, setForm] = useState<{ trade?: Trade } | null>(null)
  const [lifecycle, setLifecycle] = useState<{ trade: Trade; event: LifecycleEvent } | null>(null)
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

  const openTrade = (id: string) => { setSelected(id); setView('blotter') }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (help) setHelp(false); else if (!form && !lifecycle) setSelected(null); return }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey || form || lifecycle) return
      if (e.key === '/') { e.preventDefault(); setView('blotter'); setTimeout(() => blotterRef.current?.focusSearch(), 0) }
      else if (e.key === 'n' || e.key === 'N') { if (canWrite) { e.preventDefault(); setForm({}) } }
      else if ((e.key === 'a' || e.key === 'A') && lastTrade.current && canWrite) { e.preventDefault(); setForm({ trade: lastTrade.current }) }
      else if (e.key === 't' || e.key === 'T') setTimeTravel((t) => !t)
      else if (e.key === '?') setHelp(true)
      else { const v = VIEWS.find((x) => x.key === e.key); if (v) setView(v.id) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [help, form, lifecycle, canWrite])

  // Keep the selected trade's latest state for the "A" shortcut.
  useEffect(() => {
    lastTrade.current = null
    if (!selected) return
    tradeRepo.call<{ trade: Trade }>('tr_trade_get', { tradeId: selected }).then((r) => { lastTrade.current = r.trade.status === 'LIVE' ? r.trade : null }).catch(() => {})
  }, [selected, refreshKey])

  if (refError) return <div className="tr-root"><ErrorState error={refError} onRetry={loadRef} /></div>
  if (!reference) return <div className="tr-root"><Loading label="Connecting to trade repository…" /></div>

  return (
    <div className="tr-root" data-testid="trade-repository">
      <Toaster position="bottom-right" richColors closeButton />
      <div className="tr-header">
        <nav className="tr-subtabs" role="tablist" aria-label="Trade repository views">
          {VIEWS.map(({ id, label, icon: Icon, key }) => (
            <button key={id} role="tab" type="button" aria-selected={view === id} data-testid={`tr-view-${id}`} className={`tr-subtab ${view === id ? 'active' : ''}`} onClick={() => setView(id)}>
              <Icon size={13} /> {label} <kbd>{key}</kbd>
            </button>
          ))}
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
        {view === 'blotter' ? <Blotter ref={blotterRef} reference={reference} asOf={asOf} refreshKey={refreshKey} selectedId={selected} onSelect={setSelected} onNew={() => setForm({})} canWrite={canWrite && !timeTravel} /> : null}
        {view === 'positions' ? <PositionsView asOf={asOf} refreshKey={refreshKey} onDrill={(ids) => { setDrilled(ids); setView('blotter'); setSelected(ids[0] ?? null) }} /> : null}
        {view === 'recon' ? <ReconView refreshKey={refreshKey} canManage={role === 'ops' || role === 'admin'} actor={userId} onOpenTrade={openTrade} onChanged={(m) => bump(m)} /> : null}
        {view === 'audit' ? <AuditView refreshKey={refreshKey} onOpenTrade={openTrade} /> : null}
        {view === 'import' ? <ImportView canWrite={canWrite} onImported={(m) => bump(m)} /> : null}
        {selected && view === 'blotter' ? (
          <TradeDrawer tradeId={selected} asOf={asOf} refreshKey={refreshKey} canWrite={canWrite && !timeTravel} onClose={() => setSelected(null)} onAmend={(t) => setForm({ trade: t })} onLifecycle={(t, e) => setLifecycle({ trade: t, event: e })} onOpenTrade={setSelected} />
        ) : null}
      </div>
      {form ? <TradeForm reference={reference} trade={form.trade} onClose={() => setForm(null)} onDone={(id, msg) => { setForm(null); setSelected(id); bump(msg) }} /> : null}
      {lifecycle ? <LifecycleDialog reference={reference} trade={lifecycle.trade} eventType={lifecycle.event} onClose={() => setLifecycle(null)} onDone={(msg) => { setLifecycle(null); bump(msg) }} /> : null}
      {help ? (
        <Modal testId="shortcuts-dialog" title="Keyboard shortcuts" eyebrow="Trade repository" onClose={() => setHelp(false)}>
          <table className="tr-table"><tbody>{SHORTCUTS.map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>)}</tbody></table>
        </Modal>
      ) : null}
    </div>
  )
}
