import { useEffect, useMemo, useState } from 'react'
import { newIdempotencyKey, tradeRepo, TradeRepoApiError } from '../api'
import type { FieldIssue, ProductType, Reference, Trade, TradeInput, Validation } from '../types'
import { FieldErrors, Modal } from './common'

const PRODUCTS: ProductType[] = ['IRS', 'FX_FORWARD', 'EQUITY_OPTION', 'CDS', 'PHOENIX_AUTOCALL']
const today = () => new Date().toISOString().slice(0, 10)

/** Fields shown per product (progressive disclosure). */
const PRODUCT_FIELDS: Record<ProductType, string[]> = {
  IRS: ['fixedRate', 'underlying'],
  FX_FORWARD: ['price', 'underlying'],
  EQUITY_OPTION: ['underlying', 'optionType', 'strike', 'quantity'],
  CDS: ['underlying', 'price'],
  PHOENIX_AUTOCALL: ['underlying', 'strike'],
}
const LABELS: Record<string, string> = { fixedRate: 'Fixed rate (decimal)', price: 'Price / forward rate / spread', underlying: 'Underlying / index / pair', optionType: 'Call / put', strike: 'Strike', quantity: 'Quantity' }

export function TradeForm({ reference, trade, onClose, onDone }: { reference: Reference; trade?: Trade; onClose: () => void; onDone: (tradeId: string, message: string) => void }) {
  const amend = !!trade
  const [form, setForm] = useState<Partial<TradeInput>>(() =>
    trade ? { ...trade } : { productType: 'IRS', side: 'BUY', currency: 'USD', tradeDate: today(), bookId: reference.books[0]?.bookId, counterpartyId: reference.parties.find((p) => p.kind === 'COUNTERPARTY')?.partyId, venue: 'OTC' },
  )
  const [reason, setReason] = useState('')
  const [validation, setValidation] = useState<Validation | null>(null)
  const [serverIssues, setServerIssues] = useState<FieldIssue[]>([])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [idemKey] = useState(newIdempotencyKey)
  const set = (k: keyof TradeInput, v: unknown) => setForm((f) => ({ ...f, [k]: v === '' ? undefined : v }))
  const num = (k: keyof TradeInput) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value === '' ? undefined : Number(e.target.value))

  // Live validation against the server (single source of rules), debounced.
  useEffect(() => {
    const h = setTimeout(() => {
      tradeRepo.call<Validation>('tr_trade_validate', { trade: form }).then(setValidation).catch(() => setValidation(null))
    }, 250)
    return () => clearTimeout(h)
  }, [form])

  const changed = useMemo(() => {
    if (!trade) return []
    return Object.keys(form).filter((k) => JSON.stringify((form as Record<string, unknown>)[k]) !== JSON.stringify((trade as unknown as Record<string, unknown>)[k]))
  }, [form, trade])
  const economic = changed.some((k) => !['trader', 'venue', 'externalId', 'comment', 'tags'].includes(k))
  const issues = [...(validation?.errors ?? []), ...serverIssues]
  const canSubmit = !submitting && (validation?.valid ?? false) && (!amend || (changed.length > 0 && reason.trim().length > 0))

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    setServerIssues([])
    try {
      if (amend) {
        const changes = Object.fromEntries(changed.map((k) => [k, (form as Record<string, unknown>)[k]]))
        const out = await tradeRepo.call<{ tradeId: string; version: number; amendKind: string }>('tr_trade_amend', { tradeId: trade.tradeId, expectedVersion: trade.version, changes, reason, idempotencyKey: idemKey })
        onDone(out.tradeId, `${out.tradeId} amended (${out.amendKind.toLowerCase().replace('_', '-')}) → v${out.version}`)
      } else {
        const out = await tradeRepo.call<{ tradeId: string; trade: Trade }>('tr_trade_book', { trade: form, idempotencyKey: idemKey })
        onDone(out.tradeId, `Booked ${out.tradeId} · UTI ${out.trade.uti}`)
      }
    } catch (e) {
      const err = e as TradeRepoApiError
      setServerIssues(err.details ?? [])
      setError(err.code === 'CONFLICT' ? `${err.message}. Someone else changed this trade — close and reopen to see the latest version.` : `${err.code}: ${err.message}`)
    } finally {
      setSubmitting(false)
    }
  }

  const input = (k: keyof TradeInput, type = 'text', extra: Record<string, unknown> = {}) => (
    <label className="tr-field">
      <span>{LABELS[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}</span>
      <input
        name={k}
        data-testid={`f-${k}`}
        type={type}
        aria-invalid={issues.some((i) => i.path === k)}
        className={`tr-input ${changed.includes(k) ? 'tr-changed' : ''}`}
        value={(form[k] as string | number | undefined) ?? ''}
        onChange={type === 'number' ? num(k) : (e) => set(k, e.target.value)}
        {...extra}
      />
      <FieldErrors issues={issues} path={k} />
    </label>
  )
  const select = (k: keyof TradeInput, options: { value: string; label: string }[]) => (
    <label className="tr-field">
      <span>{k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}</span>
      <select name={k} data-testid={`f-${k}`} className={`control-select w-full ${changed.includes(k) ? 'tr-changed' : ''}`} value={(form[k] as string) ?? ''} onChange={(e) => set(k, e.target.value)}>
        <option value="">—</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <FieldErrors issues={issues} path={k} />
    </label>
  )

  const pt = (form.productType ?? 'IRS') as ProductType
  return (
    <Modal
      testId="trade-form"
      eyebrow={amend ? `Amend ${trade.tradeId} · v${trade.version}` : 'Trade capture'}
      title={amend ? 'Amend trade' : 'Book new trade'}
      onClose={onClose}
      wide
      footer={
        <>
          {amend && changed.length ? <span className="mr-auto self-center text-xs text-muted" data-testid="amend-kind">{changed.length} field(s) changed · <b>{economic ? 'Economic' : 'Non-economic'}</b> amendment</span> : null}
          <button type="button" className="add-tile-button" onClick={onClose}>Cancel</button>
          <button type="button" data-testid="submit-trade" className="tr-primary" disabled={!canSubmit} onClick={submit}>{submitting ? 'Saving…' : amend ? 'Submit amendment' : 'Book trade'}</button>
        </>
      }
    >
      {error ? <div className="tr-alert" role="alert" data-testid="form-error">{error}</div> : null}
      <div className="tr-form-grid">
        <fieldset className="tr-fieldset">
          <legend>Economics</legend>
          {select('productType', PRODUCTS.map((p) => ({ value: p, label: p.replace(/_/g, ' ') })))}
          {select('side', [{ value: 'BUY', label: 'Buy / pay fixed / long' }, { value: 'SELL', label: 'Sell / receive fixed / short' }])}
          {input('notional', 'number', { min: 0, step: 1000000 })}
          {input('currency', 'text', { maxLength: 3, style: { textTransform: 'uppercase' } })}
          {PRODUCT_FIELDS[pt].map((k) => k === 'optionType' ? <div key={k}>{select('optionType', [{ value: 'CALL', label: 'Call' }, { value: 'PUT', label: 'Put' }])}</div> : <div key={k}>{input(k as keyof TradeInput, ['underlying'].includes(k) ? 'text' : 'number', k === 'fixedRate' ? { step: 0.0001 } : {})}</div>)}
        </fieldset>
        <fieldset className="tr-fieldset">
          <legend>Dates</legend>
          {input('tradeDate', 'date')}
          {input('effectiveDate', 'date')}
          {input('maturityDate', 'date')}
        </fieldset>
        <fieldset className="tr-fieldset">
          <legend>Parties &amp; booking</legend>
          {select('counterpartyId', reference.parties.filter((p) => p.kind === 'COUNTERPARTY').map((p) => ({ value: p.partyId, label: `${p.name} (${p.partyId})` })))}
          {amend ? <p className="text-[11px] text-muted">Book: {trade.bookId} — use “Book transfer” to move books.</p> : select('bookId', reference.books.map((b) => ({ value: b.bookId, label: `${b.bookId} — ${b.name}` })))}
          {input('trader')}
          {input('venue')}
          {input('externalId')}
          {input('comment')}
        </fieldset>
      </div>
      {validation?.warnings.length ? <div className="tr-warn" data-testid="form-warnings">{validation.warnings.map((w) => <div key={w.code + w.path}>⚠ {w.message}</div>)}</div> : null}
      {amend ? (
        <label className="tr-field mt-3">
          <span>Reason for amendment (required, kept in the audit trail)</span>
          <input data-testid="f-reason" className="tr-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Corrected per broker confirmation" />
        </label>
      ) : null}
      <p className="mt-2 text-[10px] text-muted">Idempotency key {idemKey} — resubmitting this form cannot double-book.</p>
    </Modal>
  )
}
