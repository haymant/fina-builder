import { AgGridReact } from 'ag-grid-react'
import { Upload } from 'lucide-react'
import { useState } from 'react'
import { tradeRepo, TradeRepoApiError } from '../api'
import type { ImportResult } from '../types'
import { Badge, gridTheme } from './common'

export const IMPORT_TEMPLATE = 'productType,side,notional,currency,underlying,fixedRate,price,strike,optionType,tradeDate,maturityDate,counterpartyId,bookId,trader,externalId'

export function ImportView({ canWrite, onImported }: { canWrite: boolean; onImported: (msg: string) => void }) {
  const [csv, setCsv] = useState('')
  const [mode, setMode] = useState<'all-or-nothing' | 'best-effort'>('all-or-nothing')
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (dryRun: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const r = await tradeRepo.call<ImportResult>('tr_bulk_import', { csv, dryRun, mode })
      setResult(r)
      if (!dryRun && r.committed) onImported(`Imported ${r.committed} trade(s)${r.failed ? `, ${r.failed} rejected` : ''}`)
    } catch (e) { setError(`${(e as TradeRepoApiError).code}: ${(e as Error).message}`) } finally { setBusy(false) }
  }
  const onFile = async (f: File | undefined) => { if (f) setCsv(await f.text()) }
  return (
    <div className="flex min-h-0 flex-1 gap-3" data-testid="import">
      <div className="flex w-[44%] min-w-80 flex-col gap-2">
        <p className="text-xs text-muted">Paste or drop a CSV. Header row required. Validate first (dry run) — nothing is booked until you commit. Rows are idempotent on <code>externalId</code>.</p>
        <label className="tr-dropzone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void onFile(e.dataTransfer.files[0]) }}>
          <Upload size={16} /> <span>Drop a .csv here or <u>browse</u></span>
          <input type="file" accept=".csv,text/csv" className="hidden" data-testid="import-file" onChange={(e) => void onFile(e.target.files?.[0])} />
        </label>
        <textarea data-testid="import-csv" className="tr-input min-h-0 flex-1 font-mono text-[11px]" placeholder={IMPORT_TEMPLATE} value={csv} onChange={(e) => { setCsv(e.target.value); setResult(null) }} />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="add-tile-button" onClick={() => setCsv(`${IMPORT_TEMPLATE}\n`)}>Insert template</button>
          <select aria-label="Import mode" data-testid="import-mode" className="control-select" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}><option value="all-or-nothing">All or nothing</option><option value="best-effort">Best effort (skip bad rows)</option></select>
          <button type="button" className="add-tile-button ml-auto" data-testid="import-validate" disabled={!csv.trim() || busy} onClick={() => void run(true)}>Validate</button>
          {canWrite ? <button type="button" className="tr-primary" data-testid="import-commit" disabled={!csv.trim() || busy || !result?.dryRun || (mode === 'all-or-nothing' && result.failed > 0)} onClick={() => void run(false)}>Commit import</button> : null}
        </div>
        {error ? <div className="tr-alert" role="alert" data-testid="import-error">{error}</div> : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {result ? <div className="tr-info" data-testid="import-summary">{result.dryRun ? 'Dry run' : 'Committed'}: {result.results.length - result.failed} valid, {result.failed} with errors{result.dryRun ? '' : `, ${result.committed} booked`}</div> : <p className="text-xs text-muted">Validation results appear here, row by row.</p>}
        {result ? (
          <div className="min-h-0 flex-1">
            <AgGridReact theme={gridTheme} rowData={result.results} columnDefs={[
              { field: 'row', width: 64 }, { field: 'status', width: 90, cellRenderer: (p: { value: string }) => <Badge value={p.value} /> },
              { field: 'externalId', width: 110 }, { field: 'tradeId', width: 110 },
              { headerName: 'Issues', flex: 1, valueGetter: (p) => [...p.data!.errors, ...p.data!.warnings].map((e: { path: string; message: string }) => `${e.path}: ${e.message}`).join('; ') },
            ]} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
