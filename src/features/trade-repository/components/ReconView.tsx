import { AgGridReact } from 'ag-grid-react'
import { useCallback, useEffect, useState } from 'react'
import { tradeRepo, TradeRepoApiError } from '../api'
import type { BreakStatus, ReconBreak, ReconRun } from '../types'
import { Badge, EmptyState, ErrorState, Loading, Modal, fmtTs, gridTheme } from './common'

const NEXT: Record<BreakStatus, BreakStatus[]> = { OPEN: ['INVESTIGATING', 'RESOLVED', 'WAIVED'], INVESTIGATING: ['OPEN', 'RESOLVED', 'WAIVED'], RESOLVED: ['OPEN'], WAIVED: ['OPEN'] }

export function ReconView({ refreshKey, canManage, actor, onOpenTrade, onChanged }: { refreshKey: number; canManage: boolean; actor: string; onOpenTrade: (id: string) => void; onChanged: (msg: string) => void }) {
  const [runs, setRuns] = useState<ReconRun[] | null>(null)
  const [breaks, setBreaks] = useState<ReconBreak[]>([])
  const [statusFilter, setStatusFilter] = useState<BreakStatus[]>(['OPEN', 'INVESTIGATING'])
  const [selected, setSelected] = useState<ReconBreak | null>(null)
  const [comment, setComment] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [runOpen, setRunOpen] = useState(false)
  const [runText, setRunText] = useState('')
  const [runSource, setRunSource] = useState('Counterparty confirm file')
  const load = useCallback(async () => {
    setError(null)
    try {
      const [r, b] = await Promise.all([tradeRepo.call<{ items: ReconRun[] }>('tr_recon_runs'), tradeRepo.call<{ items: ReconBreak[] }>('tr_recon_breaks_query', { filter: { statuses: statusFilter } })])
      setRuns(r.items)
      setBreaks(b.items)
    } catch (e) { setError(e) }
  }, [statusFilter])
  useEffect(() => { void load() }, [load, refreshKey])

  const update = async (status?: BreakStatus, assignee?: string | null) => {
    if (!selected) return
    setActionError(null)
    try {
      const b = await tradeRepo.call<ReconBreak>('tr_recon_break_update', { breakId: selected.breakId, status, assignee, comment: comment || undefined, expectedUpdatedAt: selected.updatedAt })
      setSelected(b)
      setComment('')
      onChanged(`${b.breakId} → ${b.status}`)
      await load()
    } catch (e) { setActionError(`${(e as TradeRepoApiError).code}: ${(e as Error).message}`) }
  }
  const startRun = async () => {
    try {
      const records = JSON.parse(runText) as unknown[]
      const run = await tradeRepo.call<ReconRun>('tr_recon_run', { source: runSource, records })
      setRunOpen(false)
      onChanged(`${run.runId}: ${run.summary.matched} matched, ${run.summary.breaks} breaks`)
      await load()
    } catch (e) { setActionError((e as Error).message) }
  }
  const latest = runs?.[0]
  return (
    <div className="flex min-h-0 flex-1 gap-3" data-testid="recon">
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {latest ? (
          <div className="tr-kpis" data-testid="recon-summary">
            <div><span>Last run</span><b>{latest.runId}</b><small>{latest.source} · {fmtTs(latest.ranAt)}</small></div>
            <div><span>Matched</span><b className="text-success">{latest.summary.matched}</b><small>of {latest.summary.external} external</small></div>
            <div><span>Breaks</span><b className="text-danger" data-testid="recon-break-count">{latest.summary.breaks}</b><small>{Object.entries(latest.summary.byType).map(([k, v]) => `${k.replace(/_/g, ' ').toLowerCase()} ${v}`).join(' · ')}</small></div>
          </div>
        ) : null}
        <div className="tr-toolbar">
          <span className="eyebrow">Break status</span>
          {(['OPEN', 'INVESTIGATING', 'RESOLVED', 'WAIVED'] as BreakStatus[]).map((s) => <button key={s} type="button" data-testid={`break-filter-${s}`} aria-pressed={statusFilter.includes(s)} className={`tr-chip ${statusFilter.includes(s) ? 'active' : ''}`} onClick={() => setStatusFilter((f) => (f.includes(s) ? f.filter((x) => x !== s) : [...f, s]))}>{s}</button>)}
          {canManage ? <button type="button" className="add-tile-button ml-auto" data-testid="new-recon" onClick={() => setRunOpen(true)}>Run reconciliation…</button> : null}
        </div>
        <div className="min-h-0 flex-1">
          {error ? <ErrorState error={error} onRetry={load} /> : !runs ? <Loading /> : breaks.length === 0 ? <EmptyState title="No breaks in this filter" hint="Everything reconciles. 🎉" /> : (
            <AgGridReact theme={gridTheme} rowData={breaks} getRowId={(p) => p.data!.breakId} rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }} onRowClicked={(e) => { setSelected(e.data ?? null); setActionError(null) }}
              columnDefs={[
                { field: 'breakId', width: 110 }, { field: 'type', width: 170, valueFormatter: (p) => String(p.value).replace(/_/g, ' ') },
                { field: 'status', width: 130, cellRenderer: (p: { value: string }) => <Badge value={p.value} /> }, { field: 'tradeId', width: 110 }, { field: 'uti', width: 280, cellClass: 'font-mono' },
                { field: 'assignee', width: 110 }, { headerName: 'Detail', flex: 1, valueGetter: (p) => { const d = p.data!.detail as { mismatches?: { field: string; ours: unknown; theirs: unknown }[] }; return d.mismatches ? d.mismatches.map((m) => `${m.field}: ours ${m.ours} vs theirs ${m.theirs}`).join('; ') : p.data!.type === 'MISSING_IN_REPO' ? 'Reported externally, not in repository' : 'In repository, not reported externally' } },
              ]} />
          )}
        </div>
      </div>
      {selected ? (
        <aside className="tr-side" data-testid="break-panel">
          <p className="eyebrow">Break</p>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-main">{selected.breakId} <Badge value={selected.status} testId="break-status" /></h3>
          <p className="text-xs text-muted">{selected.type.replace(/_/g, ' ')} · {selected.source}</p>
          {selected.tradeId ? <button type="button" className="tr-link text-xs" data-testid="break-open-trade" onClick={() => onOpenTrade(selected.tradeId!)}>Open trade {selected.tradeId}</button> : null}
          <pre className="tr-pre">{JSON.stringify(selected.detail, null, 2)}</pre>
          <p className="text-[11px] text-muted">Assignee: <b>{selected.assignee ?? 'unassigned'}</b></p>
          {canManage ? (
            <>
              <button type="button" className="add-tile-button tr-sm" data-testid="break-assign-me" onClick={() => void update(undefined, actor)}>Assign to me</button>
              <textarea data-testid="break-comment" className="tr-input mt-2" rows={2} placeholder="Comment (required to resolve or waive)" value={comment} onChange={(e) => setComment(e.target.value)} />
              <div className="mt-2 flex flex-wrap gap-1.5">{NEXT[selected.status].map((s) => <button key={s} type="button" className="add-tile-button tr-sm" data-testid={`break-to-${s}`} onClick={() => void update(s)}>{s === 'OPEN' ? 'Reopen' : s.charAt(0) + s.slice(1).toLowerCase()}</button>)}</div>
            </>
          ) : <p className="text-[11px] text-muted">Read-only: only ops/admin can work breaks.</p>}
          {actionError ? <div className="tr-alert mt-2" role="alert" data-testid="break-error">{actionError}</div> : null}
          <ol className="tr-timeline mt-3">{selected.comments.map((c, i) => <li key={i}><p className="text-[11px] text-muted">{fmtTs(c.at)} · {c.actor}</p><p className="text-xs text-main">{c.text}</p></li>)}</ol>
        </aside>
      ) : null}
      {runOpen ? (
        <Modal testId="recon-dialog" title="Run reconciliation" eyebrow="Match by UTI" onClose={() => setRunOpen(false)} footer={<><button type="button" className="add-tile-button" onClick={() => setRunOpen(false)}>Cancel</button><button type="button" className="tr-primary" data-testid="recon-run" onClick={() => void startRun()}>Run</button></>}>
          <label className="tr-field"><span>Source</span><input className="tr-input" data-testid="recon-source" value={runSource} onChange={(e) => setRunSource(e.target.value)} /></label>
          <label className="tr-field mt-2"><span>External records (JSON array of {'{uti, notional, maturityDate, currency, counterpartyId, side}'})</span><textarea data-testid="recon-records" className="tr-input font-mono" rows={8} value={runText} onChange={(e) => setRunText(e.target.value)} /></label>
          {actionError ? <div className="tr-alert mt-2" role="alert">{actionError}</div> : null}
        </Modal>
      ) : null}
    </div>
  )
}
