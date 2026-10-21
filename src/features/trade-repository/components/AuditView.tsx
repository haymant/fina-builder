import { AgGridReact } from 'ag-grid-react'
import { useCallback, useEffect, useState } from 'react'
import { tradeRepo } from '../api'
import type { AuditRow, Page } from '../types'
import { EmptyState, ErrorState, Loading, fmtTs, gridTheme } from './common'

const ACTIONS = ['', 'trade.book', 'trade.amend', 'trade.cancel', 'trade.novate', 'trade.partial_terminate', 'trade.mature', 'trade.book_transfer', 'trade.import', 'recon.run', 'recon.break.update']

export function AuditView({ refreshKey, onOpenTrade }: { refreshKey: number; onOpenTrade: (id: string) => void }) {
  const [actor, setActor] = useState('')
  const [action, setAction] = useState('')
  const [targetId, setTargetId] = useState('')
  const [page, setPage] = useState<Page<AuditRow> | null>(null)
  const [error, setError] = useState<unknown>(null)
  const load = useCallback(async () => {
    setError(null)
    try { setPage(await tradeRepo.call('tr_audit_query', { filter: { actor: actor || undefined, action: action || undefined, targetId: targetId || undefined }, limit: 500 })) } catch (e) { setError(e) }
  }, [actor, action, targetId])
  useEffect(() => { const h = setTimeout(() => void load(), 200); return () => clearTimeout(h) }, [load, refreshKey])
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="audit">
      <div className="tr-toolbar">
        <input aria-label="Actor" data-testid="audit-actor" className="tr-input w-36" placeholder="Actor" value={actor} onChange={(e) => setActor(e.target.value)} />
        <select aria-label="Action" data-testid="audit-action" className="control-select" value={action} onChange={(e) => setAction(e.target.value)}>{ACTIONS.map((a) => <option key={a} value={a}>{a || 'All actions'}</option>)}</select>
        <input aria-label="Target" data-testid="audit-target" className="tr-input w-36" placeholder="Trade / break id" value={targetId} onChange={(e) => setTargetId(e.target.value)} />
        <span className="ml-auto text-[11px] text-muted" data-testid="audit-count">{page ? `${page.total} entries (append-only)` : ''}</span>
      </div>
      <div className="min-h-0 flex-1">
        {error ? <ErrorState error={error} onRetry={load} /> : !page ? <Loading /> : page.items.length === 0 ? <EmptyState title="No audit entries" /> : (
          <AgGridReact theme={gridTheme} rowData={page.items} getRowId={(p) => p.data!.auditId} onRowDoubleClicked={(e) => e.data!.target?.type === 'trade' && onOpenTrade(e.data!.target.id)}
            columnDefs={[
              { field: 'occurredAt', headerName: 'When (UTC)', width: 170, valueFormatter: (p) => fmtTs(p.value) }, { field: 'actor', width: 110 }, { field: 'role', width: 80 },
              { field: 'action', width: 170 }, { headerName: 'Target', width: 140, valueGetter: (p) => `${p.data!.target?.id ?? ''}${p.data!.target?.version ? ` v${p.data!.target.version}` : ''}` },
              { headerName: 'Detail', flex: 1, valueGetter: (p) => JSON.stringify(p.data!.detail) }, { field: 'correlationId', headerName: 'Correlation', width: 150 },
            ]} />
        )}
      </div>
    </div>
  )
}
