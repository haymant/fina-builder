import { useState } from 'react'
import { newIdempotencyKey, tradeRepo, TradeRepoApiError, fmtNotional } from '../api'
import type { LifecycleEvent, Reference, Trade } from '../types'
import { FieldErrors, Modal } from './common'

const HELP: Record<LifecycleEvent, string> = {
  CANCEL: 'Cancels the trade as booked in error. Terminal; the trade stays in history and the audit trail.',
  NOVATE: 'Steps the trade out to a new counterparty: this trade becomes NOVATED and a linked new trade (new UTI) is booked with the transferee.',
  PARTIAL_TERMINATE: 'Reduces the outstanding notional (unwind). Use Cancel for errors.',
  EXERCISE: 'Exercises an option / early redemption right. Terminal.',
  MATURE: 'Marks the trade as matured on or after its maturity date. Terminal.',
  BOOK_TRANSFER: 'Moves the trade to another book (and possibly legal entity). Economics are unchanged.',
}

export function LifecycleDialog({ trade, eventType, reference, onClose, onDone }: { trade: Trade; eventType: LifecycleEvent; reference: Reference; onClose: () => void; onDone: (msg: string) => void }) {
  const [effectiveDate, setEffectiveDate] = useState(eventType === 'MATURE' ? trade.maturityDate : new Date().toISOString().slice(0, 10))
  const [reason, setReason] = useState('')
  const [params, setParams] = useState<Record<string, string>>({})
  const [error, setError] = useState<TradeRepoApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [key] = useState(newIdempotencyKey)
  const p = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setParams((x) => ({ ...x, [k]: e.target.value }))
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const ps: Record<string, unknown> = { ...params }
      if (ps.terminatedNotional) ps.terminatedNotional = Number(ps.terminatedNotional)
      const out = await tradeRepo.call<{ tradeId: string; version: number; novatedTo?: string }>('tr_trade_lifecycle', { tradeId: trade.tradeId, eventType, expectedVersion: trade.version, effectiveDate, reason: reason || undefined, params: ps, idempotencyKey: key })
      onDone(`${eventType.replace(/_/g, ' ').toLowerCase()} applied to ${out.tradeId} → v${out.version}${out.novatedTo ? ` · new trade ${out.novatedTo}` : ''}`)
    } catch (e) {
      setError(e as TradeRepoApiError)
    } finally {
      setBusy(false)
    }
  }
  const issues = error?.details ?? []
  const title = eventType.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())
  return (
    <Modal testId="lifecycle-dialog" eyebrow={`${trade.tradeId} · v${trade.version} · ${trade.status}`} title={title} onClose={onClose}
      footer={<><button type="button" className="add-tile-button" onClick={onClose}>Cancel</button><button type="button" data-testid="confirm-lifecycle" className={eventType === 'CANCEL' ? 'tr-danger' : 'tr-primary'} disabled={busy} onClick={submit}>{busy ? 'Applying…' : `Confirm ${title.toLowerCase()}`}</button></>}>
      <p className="mb-3 text-xs text-muted">{HELP[eventType]}</p>
      {error ? <div className="tr-alert" role="alert" data-testid="lifecycle-error">{error.code}: {error.message}</div> : null}
      <div className="grid gap-3">
        <label className="tr-field"><span>Effective date</span><input data-testid="l-effectiveDate" type="date" className="tr-input" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} /><FieldErrors issues={issues} path="effectiveDate" /></label>
        {eventType === 'PARTIAL_TERMINATE' ? (
          <label className="tr-field"><span>Notional to terminate (outstanding {fmtNotional(trade.notional)} {trade.currency})</span><input data-testid="l-terminatedNotional" type="number" className="tr-input" value={params.terminatedNotional ?? ''} onChange={p('terminatedNotional')} /><FieldErrors issues={issues} path="params.terminatedNotional" /></label>
        ) : null}
        {eventType === 'NOVATE' ? (
          <label className="tr-field"><span>Transferee (new counterparty)</span>
            <select data-testid="l-transfereeId" className="control-select w-full" value={params.transfereeId ?? ''} onChange={p('transfereeId')}>
              <option value="">—</option>
              {reference.parties.filter((x) => x.kind === 'COUNTERPARTY' && x.partyId !== trade.counterpartyId).map((x) => <option key={x.partyId} value={x.partyId}>{x.name}</option>)}
            </select><FieldErrors issues={issues} path="params.transfereeId" /></label>
        ) : null}
        {eventType === 'BOOK_TRANSFER' ? (
          <label className="tr-field"><span>Destination book</span>
            <select data-testid="l-toBookId" className="control-select w-full" value={params.toBookId ?? ''} onChange={p('toBookId')}>
              <option value="">—</option>
              {reference.books.filter((b) => b.bookId !== trade.bookId).map((b) => <option key={b.bookId} value={b.bookId}>{b.bookId} — {b.name}</option>)}
            </select><FieldErrors issues={issues} path="params.toBookId" /></label>
        ) : null}
        <label className="tr-field"><span>Reason {eventType === 'CANCEL' ? '(required)' : '(recommended)'}</span><input data-testid="l-reason" className="tr-input" value={reason} onChange={(e) => setReason(e.target.value)} /><FieldErrors issues={issues} path="reason" /></label>
      </div>
    </Modal>
  )
}
