import { CalendarClock, CheckCircle2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { newIdempotencyKey, tradeRepo } from '../api'
import type { FixingBatchResult, FixingDue, FixingDueItem } from '../types'
import { EmptyState, Loading } from './common'

interface Draft {
  levels: Record<string, string>
  source: string
  sourceObservedAt: string
  evidenceRef: string
}

type Drafts = Record<string, Draft>

export function FixingsView({ canManage, onOpenTrade, onCommitted }: { canManage: boolean; onOpenTrade: (tradeId: string) => void; onCommitted: (message: string) => void }) {
  const [asOfDate, setAsOfDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [due, setDue] = useState<FixingDue | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [drafts, setDrafts] = useState<Drafts>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<'all-or-nothing' | 'best-effort'>('all-or-nothing')
  const [batchKey, setBatchKey] = useState('')
  const [preview, setPreview] = useState<FixingBatchResult | null>(null)
  const [previewSignature, setPreviewSignature] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const result = await tradeRepo.call<FixingDue>('tr_fixing_due', { asOfDate, limit: 500 })
      setDue(result)
      setDrafts((prior) => Object.fromEntries(result.items.map((item) => [item.tradeId, prior[item.tradeId] ?? { levels: Object.fromEntries(item.levelsRequired.map((symbol) => [symbol, ''])), source: '', sourceObservedAt: '', evidenceRef: '' }])))
      setSelected((prior) => new Set([...prior].filter((id) => result.items.some((item) => item.tradeId === id))))
    } catch (e) { setLoadError((e as Error).message ?? String(e)) }
    finally { setLoading(false) }
  }, [asOfDate])
  useEffect(() => { void load() }, [load])

  const items = due?.items ?? []
  const selectedItems = items.filter((item) => selected.has(item.tradeId))
  const requestRows = (key: string) => selectedItems.map((item) => {
    const draft = drafts[item.tradeId] ?? { levels: {}, source: '', sourceObservedAt: '', evidenceRef: '' }
    return {
      tradeId: item.tradeId,
      expectedVersion: item.version,
      n: item.n,
      levels: Object.fromEntries(Object.entries(draft.levels).map(([symbol, value]) => [symbol, Number(value)])),
      source: draft.source,
      sourceObservedAt: draft.sourceObservedAt,
      ...(draft.evidenceRef ? { evidenceRef: draft.evidenceRef } : {}),
      reason: `Scheduled observation ${item.n} fixing capture`,
      idempotencyKey: `${key}:${item.tradeId}:${item.n}`,
    }
  })
  const payloadSignature = batchKey ? JSON.stringify({ rows: requestRows(batchKey), mode }) : ''
  const isPreviewCurrent = !!preview && previewSignature === payloadSignature
  const canCommit = canManage && isPreviewCurrent && (mode === 'all-or-nothing' ? preview.failed === 0 && preview.valid > 0 : preview.valid > 0)

  const changeDraft = (tradeId: string, change: Partial<Draft>) => {
    setDrafts((prior) => ({ ...prior, [tradeId]: { ...(prior[tradeId] ?? { levels: {}, source: '', sourceObservedAt: '', evidenceRef: '' }), ...change } }))
    setPreview(null); setPreviewSignature(''); setBatchKey(''); setActionError('')
  }
  const toggleSelected = (tradeId: string, checked: boolean) => {
    setSelected((prior) => { const next = new Set(prior); if (checked) next.add(tradeId); else next.delete(tradeId); return next })
    setPreview(null); setPreviewSignature(''); setBatchKey(''); setActionError('')
  }

  const runPreview = async () => {
    if (!selectedItems.length) return
    setBusy(true); setActionError('')
    const key = batchKey || newIdempotencyKey()
    setBatchKey(key)
    const rows = requestRows(key)
    try {
      const result = await tradeRepo.call<FixingBatchResult>('tr_fixings_bulk', { rows, mode, dryRun: true })
      setPreview(result)
      setPreviewSignature(JSON.stringify({ rows, mode }))
    } catch (e) { setActionError((e as Error).message ?? String(e)) }
    finally { setBusy(false) }
  }

  const commit = async () => {
    if (!canCommit) return
    setBusy(true); setActionError('')
    try {
      const result = await tradeRepo.call<FixingBatchResult>('tr_fixings_bulk', { rows: requestRows(batchKey), mode, dryRun: false })
      setPreview(result)
      setPreviewSignature('')
      if (result.results.some((row) => row.status === 'COMMITTED')) {
        onCommitted(result.committed > 0 ? `Committed ${result.committed} fixing${result.committed === 1 ? '' : 's'}${result.failed ? `; ${result.failed} row${result.failed === 1 ? '' : 's'} failed` : ''}` : 'Fixing batch was already committed; replay was idempotent')
        setSelected(new Set()); setBatchKey('')
        await load()
      }
    } catch (e) { setActionError((e as Error).message ?? String(e)) }
    finally { setBusy(false) }
  }

  return (
    <section className="tr-view" data-testid="fixings">
      <div className="tr-toolbar flex flex-wrap items-center gap-2">
        <div className="mr-auto flex items-center gap-2"><CalendarClock size={15} /><strong className="text-sm">Scheduled fixing queue</strong><span className="text-xs text-muted">Due observations require operator review; prices are never fetched or posted automatically.</span></div>
        <label className="tr-field inline-flex items-center gap-2"><span>Due on or before</span><input type="date" className="tr-input" data-testid="fixing-as-of-date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} /></label>
        <button type="button" className="add-tile-button" data-testid="fixing-refresh" onClick={() => void load()} disabled={loading}><RefreshCw size={13} /> Refresh</button>
      </div>
      {loadError ? <div className="tr-alert" role="alert" data-testid="fixing-load-error">{loadError}</div> : null}
      {!canManage ? <div className="tr-info" data-testid="fixing-readonly">Fixing capture is restricted to ops/admin users and is disabled in time-travel mode.</div> : null}
      {loading && !due ? <Loading label="Loading due observations…" /> : null}
      {due && !items.length ? <EmptyState title="No observations due" hint={`No unresolved product observations are scheduled on or before ${due.asOfDate}. Refresh after the relevant exchange close.`} /> : null}
      {due && items.length ? (
        <>
          <div className="tr-info" data-testid="fixing-queue-summary">{due.total} due observation{due.total === 1 ? '' : 's'} · cutoff {due.asOfDate}{due.truncated ? ' · showing first 500' : ''}</div>
          <div className="grid gap-2" data-testid="fixing-queue">
            {items.map((item: FixingDueItem) => {
              const draft = drafts[item.tradeId] ?? { levels: {}, source: '', sourceObservedAt: '', evidenceRef: '' }
              return (
                <article key={item.tradeId} className="tr-card grid gap-3 p-3" data-testid={`due-fixing-${item.tradeId}`} data-fixing-n={item.n} data-fixing-count={item.observationCount} data-observation-date={item.observationDate}>
                  <header className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-xs"><input type="checkbox" data-testid={`select-fixing-${item.tradeId}`} checked={selected.has(item.tradeId)} disabled={!canManage} onChange={(e) => toggleSelected(item.tradeId, e.target.checked)} />Select</label>
                    <strong className="font-mono text-xs">{item.tradeId}</strong><span className="text-xs">Observation #{item.n} · {item.observationDate}</span><span className="text-xs text-muted">{item.bookId} · v{item.version} · pays {item.paymentDate}</span>
                    <button type="button" className="tr-link ml-auto" data-testid={`open-fixing-trade-${item.tradeId}`} onClick={() => onOpenTrade(item.tradeId)}>Open trade</button>
                  </header>
                  <div className="flex flex-wrap gap-3">
                    {item.levelsRequired.map((symbol) => <label key={symbol} className="tr-field"><span>{symbol} close</span><input type="number" min="0.000001" step="any" className="tr-input w-32" data-testid={`fixing-level-${item.tradeId}-${symbol}`} value={draft.levels[symbol] ?? ''} disabled={!canManage} onChange={(e) => changeDraft(item.tradeId, { levels: { ...draft.levels, [symbol]: e.target.value } })} /></label>)}
                    <label className="tr-field"><span>Source</span><input className="tr-input w-48" data-testid={`fixing-source-${item.tradeId}`} placeholder="Exchange / vendor" value={draft.source} disabled={!canManage} onChange={(e) => changeDraft(item.tradeId, { source: e.target.value })} /></label>
                    <label className="tr-field"><span>Source timestamp with timezone</span><input className="tr-input w-64" data-testid={`fixing-observed-at-${item.tradeId}`} placeholder="2026-10-22T16:00:00-04:00" value={draft.sourceObservedAt} disabled={!canManage} onChange={(e) => changeDraft(item.tradeId, { sourceObservedAt: e.target.value })} /></label>
                    <label className="tr-field"><span>Evidence / source record ID</span><input className="tr-input w-52" data-testid={`fixing-evidence-${item.tradeId}`} placeholder="Optional vendor message / case ID" value={draft.evidenceRef} disabled={!canManage} onChange={(e) => changeDraft(item.tradeId, { evidenceRef: e.target.value })} /></label>
                  </div>
                </article>
              )
            })}
          </div>
          <div className="tr-card mt-3 grid gap-3 p-3" data-testid="fixing-batch-controls">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs">Selected: {selectedItems.length}</span>
              <label className="tr-field ml-auto"><span>Batch behavior</span><select className="control-select" data-testid="fixing-batch-mode" value={mode} onChange={(e) => { setMode(e.target.value as typeof mode); setPreview(null); setPreviewSignature(''); setBatchKey('') }} disabled={!canManage}><option value="all-or-nothing">All or nothing</option><option value="best-effort">Best effort</option></select></label>
              <button type="button" className="add-tile-button" data-testid="fixing-preview" onClick={() => void runPreview()} disabled={!canManage || busy || !selectedItems.length}>{busy ? 'Working…' : 'Validate batch'}</button>
              <button type="button" className="tr-primary" data-testid="fixing-commit" onClick={() => void commit()} disabled={!canCommit || busy}>{busy ? 'Working…' : 'Commit fixing batch'}</button>
            </div>
            {preview ? <div className="tr-info" data-testid="fixing-batch-summary">{isPreviewCurrent ? 'Preview' : 'Preview is stale'}: {preview.valid} valid, {preview.failed} with errors{preview.noWrites ? ' · no writes made' : ''}{preview.committed ? ` · ${preview.committed} committed` : ''}</div> : null}
            {preview?.results.map((row) => <div key={`${row.row}-${row.tradeId}`} className="flex items-center gap-2 text-xs" data-testid={`fixing-result-${row.tradeId ?? row.row}`}>
              {row.status === 'ERROR' ? <span className="tr-badge tr-badge-danger">ERROR</span> : <span className="tr-badge tr-badge-success">{row.status}</span>}
              <span className="font-mono">{row.tradeId ?? `row ${row.row}`}</span><span>obs #{row.n ?? '—'}</span>
              <span className="text-muted">{row.errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ') || row.events.map((event) => event.eventType).join(' → ')}</span>
              {row.replayed ? <CheckCircle2 size={12} aria-label="Idempotent replay" /> : null}
            </div>)}
            {actionError ? <div className="tr-alert" role="alert" data-testid="fixing-batch-error">{actionError}</div> : null}
          </div>
        </>
      ) : null}
    </section>
  )
}
