import type { ColDef, GridApi, RowClickedEvent } from 'ag-grid-community'
import { AgGridReact } from 'ag-grid-react'
import { Columns3, Download, Save, Search, Trash2 } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { fmtNotional, tradeRepo } from '../api'
import { deleteView, groupRows, loadViews, saveView, type BlotterView, type GroupRow } from '../savedViews'
import type { AsOf, Page, Reference, Trade } from '../types'
import { Badge, EmptyState, ErrorState, Loading, gridTheme } from './common'

const STATUSES = ['LIVE', 'CANCELLED', 'MATURED', 'NOVATED', 'EXERCISED', 'TERMINATED']
const PRODUCTS = ['IRS', 'FX_FORWARD', 'EQUITY_OPTION', 'CDS', 'PHOENIX_AUTOCALL']
const GROUPABLE = [['bookId', 'Book'], ['productType', 'Product'], ['counterpartyId', 'Counterparty'], ['status', 'Status'], ['currency', 'Currency'], ['legalEntityId', 'Legal entity']]

export interface BlotterHandle { focusSearch: () => void; reload: () => void }

export const Blotter = forwardRef<BlotterHandle, { reference: Reference; asOf: AsOf; refreshKey: number; selectedId: string | null; onSelect: (id: string) => void; onNew: () => void; canWrite: boolean }>(function Blotter({ asOf, refreshKey, selectedId, onSelect, onNew, canWrite }, ref) {
  const [views, setViews] = useState<BlotterView[]>(() => loadViews())
  const [viewId, setViewId] = useState('all')
  const view = views.find((v) => v.id === viewId) ?? views[0]!
  const [text, setText] = useState('')
  const [statuses, setStatuses] = useState<string[]>([])
  const [products, setProducts] = useState<string[]>([])
  const [hidden, setHidden] = useState<string[]>([])
  const [groupBy, setGroupBy] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [chooser, setChooser] = useState(false)
  const [rows, setRows] = useState<Trade[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<unknown>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const apiRef = useRef<GridApi | null>(null)

  const applyView = useCallback((v: BlotterView) => {
    setViewId(v.id)
    setText(v.filter.text ?? '')
    setStatuses(v.filter.statuses ?? [])
    setProducts(v.filter.productTypes ?? [])
    setHidden(v.hiddenColumns)
    setGroupBy(v.groupBy)
    setExpanded(new Set())
  }, [])

  const load = useCallback(async () => {
    setError(null)
    try {
      // Server-side filtering + cursor pagination; the grid pages through all results.
      const items: Trade[] = []
      let cursor: string | null = null
      let tot = 0
      do {
        const page: Page<Trade> = await tradeRepo.call<Page<Trade>>('tr_trade_query', { filter: { text: text || undefined, statuses, productTypes: products }, sort: [{ field: 'tradeId', dir: 'desc' }], limit: 200, cursor: cursor ?? undefined, ...asOf })
        items.push(...page.items)
        cursor = page.nextCursor
        tot = page.total
      } while (cursor)
      setRows(items)
      setTotal(tot)
    } catch (e) {
      setError(e)
      setRows([])
    }
  }, [text, statuses, products, asOf])

  useEffect(() => {
    const h = setTimeout(() => void load(), 200)
    return () => clearTimeout(h)
  }, [load, refreshKey])

  useImperativeHandle(ref, () => ({ focusSearch: () => searchRef.current?.focus(), reload: () => void load() }), [load])

  const columns = useMemo<ColDef[]>(() => {
    const cols: ColDef[] = [
      { field: 'tradeId', headerName: 'Trade', width: 118, cellRenderer: (p: { data: Trade | GroupRow; value: string }) => {
        const d = p.data as GroupRow
        if (d?.__group) return <span className="tr-group-cell" data-testid="group-row">{d.expanded ? '▾' : '▸'} {d.groupKey} <span className="text-muted">({d.count}) · net {fmtNotional(d.netNotional)}</span></span>
        return <span className="font-mono">{p.value}</span>
      }, colSpan: (p) => ((p.data as GroupRow)?.__group ? 6 : 1) },
      { field: 'version', headerName: 'v', width: 56, type: 'numericColumn' },
      { field: 'status', width: 110, cellRenderer: (p: { value: string }) => (p.value ? <Badge value={p.value} /> : null) },
      { field: 'productType', headerName: 'Product', width: 140, valueFormatter: (p) => String(p.value ?? '').replace(/_/g, ' ') },
      { field: 'side', width: 70 },
      { field: 'notional', width: 110, type: 'numericColumn', valueFormatter: (p) => (p.value === undefined ? '' : fmtNotional(p.value as number)) },
      { field: 'currency', headerName: 'Ccy', width: 66 },
      { field: 'underlying', width: 130 },
      { field: 'fixedRate', headerName: 'Rate', width: 80, valueFormatter: (p) => (p.value === undefined || p.value === null ? '' : `${((p.value as number) * 100).toFixed(3)}%`) },
      { field: 'strike', width: 76 },
      { field: 'optionType', headerName: 'C/P', width: 66 },
      { field: 'tradeDate', width: 104 },
      { field: 'maturityDate', headerName: 'Maturity', width: 104 },
      { field: 'counterpartyId', headerName: 'Counterparty', width: 110 },
      { field: 'bookId', headerName: 'Book', width: 112 },
      { field: 'legalEntityId', headerName: 'Legal entity', width: 110 },
      { field: 'trader', width: 104 },
      { field: 'uti', headerName: 'UTI', width: 290, cellClass: 'font-mono' },
      { field: 'lastEventType', headerName: 'Last event', width: 120 },
    ]
    return cols.map((c) => ({ ...c, hide: hidden.includes(c.field!), sortable: true, resizable: true, filter: c.field === 'tradeId' ? false : true }))
  }, [hidden])

  const data = useMemo(() => (rows ? groupRows(rows as unknown as Record<string, unknown>[], groupBy, expanded) : []), [rows, groupBy, expanded])

  const onRowClicked = (e: RowClickedEvent) => {
    const d = e.data as GroupRow | Trade
    if ((d as GroupRow).__group) {
      const k = (d as GroupRow).groupKey
      setExpanded((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })
    } else onSelect((d as Trade).tradeId)
  }

  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  const dirty = JSON.stringify({ text, statuses, products, hidden, groupBy }) !== JSON.stringify({ text: view.filter.text ?? '', statuses: view.filter.statuses ?? [], products: view.filter.productTypes ?? [], hidden: view.hiddenColumns, groupBy: view.groupBy })

  const onSaveView = () => {
    const name = window.prompt('Save current filters, columns and grouping as view:', view.builtin ? 'My view' : view.name)
    if (!name) return
    const v: BlotterView = { id: view.builtin ? `v-${Date.now().toString(36)}` : view.id, name, filter: { text, statuses, productTypes: products }, hiddenColumns: hidden, groupBy }
    setViews(saveView(v))
    setViewId(v.id)
  }
  const onExport = async (format: 'csv' | 'json') => {
    const out = await tradeRepo.call<{ content: string; count: number }>('tr_export', { format, filter: { text: text || undefined, statuses, productTypes: products }, ...asOf })
    const blob = new Blob([out.content], { type: format === 'csv' ? 'text/csv' : 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `trades-${new Date().toISOString().slice(0, 10)}.${format}`
    a.click()
  }

  useEffect(() => {
    if (!selectedId || !apiRef.current) return
    apiRef.current.forEachNode((n) => n.setSelected((n.data as Trade)?.tradeId === selectedId))
  }, [selectedId, data])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="blotter">
      <div className="tr-toolbar">
        <label className="eyebrow" htmlFor="tr-view">View</label>
        <select id="tr-view" data-testid="view-select" className="control-select min-w-36" value={viewId} onChange={(e) => applyView(views.find((v) => v.id === e.target.value)!)}>
          {views.map((v) => <option key={v.id} value={v.id}>{v.name}{v.builtin ? '' : ' ★'}</option>)}
        </select>
        <button type="button" className="icon-button" title="Save view" data-testid="save-view" onClick={onSaveView}><Save size={14} /></button>
        {!view.builtin ? <button type="button" className="icon-button hover:text-danger" title="Delete view" data-testid="delete-view" onClick={() => { setViews(deleteView(view.id)); applyView(views[0]!) }}><Trash2 size={14} /></button> : null}
        {dirty ? <span className="text-[10px] text-warning" data-testid="view-dirty">modified</span> : null}
        <div className="tr-search">
          <Search size={13} />
          <input ref={searchRef} data-testid="blotter-search" aria-label="Search trades" placeholder="Search id, UTI, underlying, trader…  ( / )" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        <select aria-label="Group by" data-testid="group-by" className="control-select" value={groupBy ?? ''} onChange={(e) => { setGroupBy(e.target.value || null); setExpanded(new Set()) }}>
          <option value="">No grouping</option>
          {GROUPABLE.map(([f, l]) => <option key={f} value={f}>Group: {l}</option>)}
        </select>
        <div className="relative">
          <button type="button" className="add-tile-button" data-testid="column-chooser" onClick={() => setChooser((c) => !c)}><Columns3 size={13} /> Columns</button>
          {chooser ? (
            <div className="tr-popover" data-testid="column-chooser-panel" onMouseLeave={() => setChooser(false)}>
              {columns.map((c) => (
                <label key={c.field} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" data-testid={`col-${c.field}`} checked={!hidden.includes(c.field!)} disabled={c.field === 'tradeId'} onChange={() => toggle(hidden, setHidden, c.field!)} /> {c.headerName ?? c.field}
                </label>
              ))}
            </div>
          ) : null}
        </div>
        <button type="button" className="add-tile-button" data-testid="export-csv" onClick={() => void onExport('csv')}><Download size={13} /> CSV</button>
        {canWrite ? <button type="button" className="tr-primary" data-testid="new-trade" onClick={onNew}>+ New trade <kbd>N</kbd></button> : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" data-testid="facets">
        <span className="eyebrow mr-1">Status</span>
        {STATUSES.map((s) => <button key={s} type="button" data-testid={`facet-status-${s}`} aria-pressed={statuses.includes(s)} className={`tr-chip ${statuses.includes(s) ? 'active' : ''}`} onClick={() => toggle(statuses, setStatuses, s)}>{s}</button>)}
        <span className="eyebrow ml-3 mr-1">Product</span>
        {PRODUCTS.map((s) => <button key={s} type="button" data-testid={`facet-product-${s}`} aria-pressed={products.includes(s)} className={`tr-chip ${products.includes(s) ? 'active' : ''}`} onClick={() => toggle(products, setProducts, s)}>{s.replace(/_/g, ' ')}</button>)}
        <span className="ml-auto text-[11px] text-muted" data-testid="blotter-count">{rows ? `${total} trade${total === 1 ? '' : 's'}` : ''}</span>
      </div>
      <div className="min-h-0 flex-1">
        {error ? <ErrorState error={error} onRetry={load} /> : rows === null ? <Loading label="Loading trades…" /> : rows.length === 0 ? (
          <EmptyState title="No trades match" hint={text || statuses.length || products.length ? 'Clear the search or facets to see more.' : 'Book a trade or import a file to get started.'} action={<button type="button" className="add-tile-button" onClick={() => applyView(views[0]!)}>Reset filters</button>} />
        ) : (
          <div className="h-full" data-testid="blotter-grid">
            <AgGridReact
              theme={gridTheme}
              rowData={data}
              columnDefs={columns}
              getRowId={(p) => ((p.data as GroupRow).__group ? `g:${(p.data as GroupRow).groupKey}` : (p.data as Trade).tradeId)}
              rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
              onRowClicked={onRowClicked}
              onGridReady={(e) => { apiRef.current = e.api }}
              getRowClass={(p) => ((p.data as GroupRow)?.__group ? 'tr-group-row' : (p.data as Trade)?.status !== 'LIVE' ? 'tr-row-terminal' : '')}
              animateRows={false}
              suppressCellFocus={false}
              onCellKeyDown={(e) => { if ((e.event as KeyboardEvent)?.key === 'Enter' && e.data && !(e.data as GroupRow).__group) onSelect((e.data as Trade).tradeId) }}
            />
          </div>
        )}
      </div>
    </div>
  )
})
