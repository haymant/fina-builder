// Generic lifecycle event dialog: the parameter form, guards and effects all come from the
// product template (tr_trade_events). Derived consequences come back as separate events.
import { useState } from 'react'
import { fmtNotional, newIdempotencyKey, tradeRepo, TradeRepoApiError } from '../api'
import type { EventDef, Reference, Trade } from '../types'
import { FieldErrors, Modal } from './common'
import { TemplateFields } from './fields'

export interface LifecycleOutcome { tradeId: string; version: number; novatedTo?: string; events: { eventId: string; eventType: string; version: number; detail?: Record<string, unknown> | null }[] }

export function describeOutcome(out: LifecycleOutcome, ccy: string) {
  const parts = out.events.map((e) => {
    const d = (e.detail ?? {}) as Record<string, unknown>
    if (e.eventType === 'COUPON') return d.paid ? `coupon paid ${fmtNotional(d.amount as number)} ${ccy}${(d.memoryCatchUp as number) > 0 ? ` (incl. ${d.memoryCatchUp} memory)` : ''}` : 'coupon missed'
    if (e.eventType === 'FIXING') return `fixing #${d.n} worst-of ${Math.round((d.worst as number) * 1e4) / 100}%`
    if (e.eventType === 'AUTOCALL') return `AUTOCALLED at ${Math.round((d.level as number) * 100)}%`
    if (e.eventType === 'KNOCK_IN') return 'KNOCKED IN'
    if (e.eventType === 'REDEMPTION') return `redeemed ${fmtNotional(d.amount as number)} ${ccy}`
    return e.eventType.replace(/_/g, ' ').toLowerCase()
  })
  return `${out.tradeId}: ${parts.join(' → ')} · v${out.version}${out.novatedTo ? ` · new trade ${out.novatedTo}` : ''}`
}

export function LifecycleDialog({ trade, event, reference, onClose, onDone }: { trade: Trade; event: EventDef; reference: Reference; onClose: () => void; onDone: (msg: string, out: LifecycleOutcome) => void }) {
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10))
  const [reason, setReason] = useState('')
  const [params, setParams] = useState<Record<string, unknown>>(() => Object.fromEntries(event.params.filter((f) => f.default !== undefined && f.default !== null).map((f) => [f.path, f.default])))
  const [error, setError] = useState<TradeRepoApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [key] = useState(newIdempotencyKey)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const out = await tradeRepo.call<LifecycleOutcome>('tr_trade_lifecycle', { tradeId: trade.tradeId, eventType: event.name, expectedVersion: trade.version, effectiveDate: event.effectiveDateDerived ? undefined : effectiveDate, reason: reason || undefined, params, idempotencyKey: key })
      onDone(describeOutcome(out, trade.currency), out)
    } catch (e) {
      setError(e as TradeRepoApiError)
    } finally {
      setBusy(false)
    }
  }
  const issues = error?.details ?? []
  const danger = event.name === 'CANCEL'
  return (
    <Modal testId="lifecycle-dialog" eyebrow={`${trade.tradeId} · v${trade.version} · ${trade.status} · outstanding ${fmtNotional(trade.notional)} ${trade.currency}`} title={event.label} onClose={onClose}
      footer={<><button type="button" className="add-tile-button" onClick={onClose}>Cancel</button><button type="button" data-testid="confirm-lifecycle" className={danger ? 'tr-danger' : 'tr-primary'} disabled={busy} onClick={submit}>{busy ? 'Applying…' : `Apply ${event.label.toLowerCase()}`}</button></>}>
      {error ? <div className="tr-alert" role="alert" data-testid="lifecycle-error">{error.code}: {error.message}</div> : null}
      <div className="grid gap-3" data-testid={`event-form-${event.name}`}>
        {event.effectiveDateDerived ? <p className="text-[11px] text-muted">Effective date comes from the product schedule / parameters.</p> : (
          <label className="tr-field"><span>Effective date</span><input data-testid="l-effectiveDate" type="date" className="tr-input" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} /><FieldErrors issues={issues} path="effectiveDate" /></label>
        )}
        <TemplateFields fields={event.params} value={params} onChange={setParams} issues={issues} base="params" tid="p" reference={reference} />
        <label className="tr-field"><span>Reason {event.requiresReason ? '(required)' : '(recommended)'}</span><input data-testid="l-reason" className="tr-input" value={reason} onChange={(e) => setReason(e.target.value)} /><FieldErrors issues={issues} path="reason" /></label>
      </div>
    </Modal>
  )
}
