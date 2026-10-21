import { AgGridReact } from 'ag-grid-react'
import { useCallback, useEffect, useState } from 'react'
import { fmtNotional, tradeRepo } from '../api'
import type { AsOf, PositionRow } from '../types'
import { EmptyState, ErrorState, Loading, gridTheme } from './common'

const DIMS = [['bookId', 'Book'], ['productType', 'Product'], ['underlying', 'Underlying'], ['currency', 'Currency'], ['counterpartyId', 'Counterparty'], ['legalEntityId', 'Legal entity']] as const

export function PositionsView({ asOf, refreshKey, onDrill }: { asOf: AsOf; refreshKey: number; onDrill: (tradeIds: string[]) => void }) {
  const [groupBy, setGroupBy] = useState<string[]>(['bookId', 'underlying', 'currency'])
  const [data, setData] = useState<{ rows: PositionRow[]; tradeCount: number } | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const load = useCallback(async () => {
    setError(null)
    try { setData(await tradeRepo.call('tr_position_query', { groupBy, ...asOf })) } catch (e) { setError(e) }
  }, [groupBy, asOf])
  useEffect(() => { void load() }, [load, refreshKey])
  const toggle = (d: string) => setGroupBy((g) => (g.includes(d) ? g.filter((x) => x !== d) : [...g, d]))
  const rows: Record<string, unknown>[] = (data?.rows ?? []).map((r) => ({ ...r.key, netNotional: r.netNotional, grossNotional: r.grossNotional, longNotional: r.longNotional, shortNotional: r.shortNotional, tradeCount: r.tradeCount, tradeIds: r.tradeIds }))
  const money = (p: { value: unknown }) => fmtNotional(p.value as number)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="positions">
      <div className="tr-toolbar">
        <span className="eyebrow">Aggregate by</span>
        {DIMS.map(([d, l]) => <button key={d} type="button" data-testid={`dim-${d}`} aria-pressed={groupBy.includes(d)} className={`tr-chip ${groupBy.includes(d) ? 'active' : ''}`} onClick={() => toggle(d)}>{l}</button>)}
        <span className="text-[11px] text-muted" data-testid="positions-summary">{data ? `${data.rows.length} positions from ${data.tradeCount} live trades` : ''}</span>
        <button type="button" className="add-tile-button ml-auto" data-testid="risk-snapshot" onClick={async () => { const s = await tradeRepo.call<{ id: string; version: string; payload: { positions: unknown[] } }>('tr_position_snapshot', { ...asOf }); setSnapshot(`${s.id} @ ${s.version} — ${s.payload.positions.length} positions (fina.position-snapshot/v1)`) }}>Publish risk snapshot</button>
      </div>
      {snapshot ? <div className="tr-info" data-testid="snapshot-result">Risk feed ready: {snapshot}</div> : null}
      <div className="min-h-0 flex-1">
        {error ? <ErrorState error={error} onRetry={load} /> : !data ? <Loading /> : rows.length === 0 ? <EmptyState title="No live positions" hint="Nothing is live at this as-of time." /> : groupBy.length === 0 ? <EmptyState title="Pick at least one dimension" /> : (
          <AgGridReact theme={gridTheme} rowData={rows} onRowDoubleClicked={(e) => onDrill((e.data!.tradeIds as string[]) ?? [])}
            columnDefs={[
              ...groupBy.map((g) => ({ field: g, headerName: DIMS.find(([d]) => d === g)?.[1], width: 140, sortable: true })),
              { field: 'netNotional', headerName: 'Net notional', type: 'numericColumn', valueFormatter: money, sortable: true, cellClassRules: { 'text-danger': (p: { value: unknown }) => (p.value as number) < 0, 'text-success': (p: { value: unknown }) => (p.value as number) > 0 } },
              { field: 'grossNotional', headerName: 'Gross', type: 'numericColumn', valueFormatter: money, sortable: true },
              { field: 'longNotional', headerName: 'Long', type: 'numericColumn', valueFormatter: money },
              { field: 'shortNotional', headerName: 'Short', type: 'numericColumn', valueFormatter: money },
              { field: 'tradeCount', headerName: 'Trades', type: 'numericColumn', width: 90, sortable: true },
            ]}
          />
        )}
      </div>
      <p className="text-[10px] text-muted">Double-click a position to drill into its trades in the blotter. Notional only — valuation and risk come from the risk engine (doc 51) via the published snapshot.</p>
    </div>
  )
}
