// Template-driven trade capture: kernel fields + the product template's form sections
// (Phoenix today), live server validation and a schedule preview. No per-product code.
import { useEffect, useMemo, useState } from 'react'
import { newIdempotencyKey, tradeRepo, type TradeRepoApiError } from '../api'
import { defaultTerms, pctStr, useProduct, useProducts } from '../products'
import type { FieldIssue, Reference, Trade, TradeInput, Validation } from '../types'
import { FieldErrors, Modal } from './common'
import { TemplateFields } from './fields'

const today = () => new Date().toISOString().slice(0, 10)
const KERNEL_NON_ECONOMIC = ['trader', 'venue', 'externalId', 'comment', 'tags']
const KERNEL_FIELDS = ['productType', 'side', 'notional', 'currency', 'tradeDate', 'counterpartyId', 'bookId', 'trader', 'venue', 'externalId', 'comment']

export function TradeForm({ reference, trade, onClose, onDone, initialDraft, initialReason, onDraft }: {
  reference: Reference; trade?: Trade; onClose: () => void; onDone: (tradeId: string, message: string) => void
  /** Amend only: unsaved edits restored from a document tab, and a callback to keep/clear them. */
  initialDraft?: Partial<TradeInput>; initialReason?: string; onDraft?: (draft: Partial<TradeInput> | undefined, reason?: string) => void
}) {
  const amend = !!trade
  const { items: products } = useProducts()
  const [form, setForm] = useState<Partial<TradeInput>>(() =>
    trade
      ? { ...structuredClone(trade), ...(initialDraft ?? {}), terms: { ...structuredClone(trade.terms), ...(initialDraft?.terms ?? {}) } }
      : { productType: 'PHOENIX_AUTOCALL', tradeDate: today(), bookId: reference.books[0]?.bookId, counterpartyId: reference.parties.find((p) => p.kind === 'COUNTERPARTY')?.partyId, venue: 'PRIMARY' },
  )
  const { tpl } = useProduct(form.productType, trade?.productTemplate?.version)
  // New trades start from the template's declared defaults (kernel + terms).
  useEffect(() => {
    if (amend || !tpl) return
    setForm((f) => (f.terms ? f : { ...(tpl.kernel?.defaults ?? {}), ...f, terms: defaultTerms(tpl) }))
  }, [tpl, amend])
  const [reason, setReason] = useState(initialReason ?? '')
  const [validation, setValidation] = useState<Validation | null>(null)
  const [serverIssues, setServerIssues] = useState<FieldIssue[]>([])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [idemKey] = useState(newIdempotencyKey)
  const set = (k: keyof TradeInput, v: unknown) => setForm((f) => ({ ...f, [k]: v === '' ? undefined : v }))

  const termsChanged = useMemo(() => {
    if (!trade) return [] as string[]
    const t = (form.terms ?? {}) as Record<string, unknown>
    return Object.keys({ ...t, ...trade.terms }).filter((k) => k !== 'observations' && JSON.stringify(t[k]) !== JSON.stringify(trade.terms[k]))
  }, [form, trade])
  const kernelChanged = useMemo(() => (trade ? KERNEL_FIELDS.filter((k) => JSON.stringify((form as Record<string, unknown>)[k]) !== JSON.stringify((trade as unknown as Record<string, unknown>)[k])) : []), [form, trade])
  const changedCount = kernelChanged.length + termsChanged.length
  const economic = termsChanged.length > 0 || kernelChanged.some((k) => !KERNEL_NON_ECONOMIC.includes(k))

  const draftChanges = (): Partial<TradeInput> | undefined => {
    if (!trade || !changedCount) return undefined
    const d: Record<string, unknown> = Object.fromEntries(kernelChanged.map((k) => [k, (form as Record<string, unknown>)[k]]))
    if (termsChanged.length) d.terms = Object.fromEntries(termsChanged.map((k) => [k, (form.terms as Record<string, unknown>)[k]]))
    return d as Partial<TradeInput>
  }
  const close = () => { if (onDraft) onDraft(draftChanges(), reason || undefined); onClose() }

  // Live validation against the server (single source of rules, incl. template constraints), debounced.
  useEffect(() => {
    if (!form.terms) return
    const h = setTimeout(() => {
      const payload = { ...form }
      if (amend && termsChanged.some((k) => !['coupon', 'autocall', 'knockIn', 'isin', 'issuerId', 'underlyings', 'denomination', 'issuePrice', 'upfrontFeePct', 'putStrike', 'settlement', 'basket'].includes(k))) delete (payload.terms as Record<string, unknown>).observations
      tradeRepo.call<Validation>('tr_trade_validate', { trade: amend ? payload : { ...payload, maturityDate: undefined } }).then(setValidation).catch(() => setValidation(null))
    }, 250)
    return () => clearTimeout(h)
  }, [form, amend, termsChanged])

  const issues = [...(validation?.errors ?? []), ...serverIssues]
  const canSubmit = !submitting && (validation?.valid ?? false) && (!amend || (changedCount > 0 && reason.trim().length > 0))

  const submit = async () => {
    setSubmitting(true)
    setError(null)
    setServerIssues([])
    try {
      if (amend) {
        const changes = draftChanges() ?? {}
        const out = await tradeRepo.call<{ tradeId: string; version: number; amendKind: string }>('tr_trade_amend', { tradeId: trade.tradeId, expectedVersion: trade.version, changes, reason, idempotencyKey: idemKey })
        onDraft?.(undefined)
        onDone(out.tradeId, `${out.tradeId} amended (${out.amendKind.toLowerCase().replace('_', '-')}) → v${out.version}`)
      } else {
        const { maturityDate: _m, ...rest } = form
        const out = await tradeRepo.call<{ tradeId: string; trade: Trade }>('tr_trade_book', { trade: rest, idempotencyKey: idemKey })
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

  const kInput = (k: keyof TradeInput, label: string, type = 'text', extra: Record<string, unknown> = {}) => (
    <label className="tr-field">
      <span>{label}</span>
      <input name={k} data-testid={`f-${k}`} type={type} aria-invalid={issues.some((i) => i.path === k)} className={`tr-input ${kernelChanged.includes(k) ? 'tr-changed' : ''}`}
        value={(form[k] as string | number | undefined) ?? ''} onChange={(e) => set(k, type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)} {...extra} />
      <FieldErrors issues={issues} path={k} />
    </label>
  )
  const kSelect = (k: keyof TradeInput, label: string, options: { value: string; label: string }[], disabled = false) => (
    <label className="tr-field">
      <span>{label}</span>
      <select name={k} data-testid={`f-${k}`} disabled={disabled} className={`control-select w-full ${kernelChanged.includes(k) ? 'tr-changed' : ''}`} value={(form[k] as string) ?? ''} onChange={(e) => set(k, e.target.value)}>
        <option value="">—</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <FieldErrors issues={issues} path={k} />
    </label>
  )
  const preview = validation?.preview
  const sections = tpl?.ui?.form ?? [{ id: 'terms', title: 'Terms', fields: tpl?.terms.fields.map((f) => f.path) ?? [] }]
  const fieldsOf = (paths: string[]) => paths.map((p) => tpl!.terms.fields.find((f) => f.path === p)).filter(Boolean) as NonNullable<typeof tpl>['terms']['fields']

  return (
    <Modal
      testId="trade-form"
      eyebrow={amend ? `Amend ${trade.tradeId} · v${trade.version}` : `Trade capture · ${tpl?.name ?? form.productType}`}
      title={amend ? 'Amend trade' : 'Book new trade'}
      onClose={close}
      wide
      footer={
        <>
          {amend && changedCount ? <span className="mr-auto self-center text-xs text-muted" data-testid="amend-kind">{changedCount} field(s) changed · <b>{economic ? 'Economic' : 'Non-economic'}</b> amendment</span> : null}
          <button type="button" className="add-tile-button" onClick={close} data-testid="form-cancel">{amend && onDraft ? 'Close (keep draft)' : 'Cancel'}</button>
          <button type="button" data-testid="submit-trade" className="tr-primary" disabled={!canSubmit} onClick={submit}>{submitting ? 'Saving…' : amend ? 'Submit amendment' : 'Book trade'}</button>
        </>
      }
    >
      {error ? <div className="tr-alert" role="alert" data-testid="form-error">{error}</div> : null}
      <div className="tr-capture">
        <div className="tr-form-grid">
          <fieldset className="tr-fieldset">
            <legend>Trade</legend>
            {kSelect('productType', 'Product', products.map((p) => ({ value: p.id, label: p.name })), amend)}
            {kSelect('side', 'Side', [{ value: 'SELL', label: tpl?.kernel?.sideLabels?.SELL ?? 'Sell' }, { value: 'BUY', label: tpl?.kernel?.sideLabels?.BUY ?? 'Buy' }])}
            {kInput('notional', 'Notional', 'number', { min: 0, step: 1000 })}
            {kInput('currency', 'Currency', 'text', { maxLength: 3, style: { textTransform: 'uppercase' } })}
            {kInput('tradeDate', 'Trade date', 'date')}
            {kSelect('counterpartyId', 'Counterparty / distributor', reference.parties.filter((p) => p.kind === 'COUNTERPARTY').map((p) => ({ value: p.partyId, label: `${p.name} (${p.partyId})` })))}
            {amend ? <p className="text-[11px] text-muted">Book: {trade.bookId} — use “Book transfer” to move books.</p> : kSelect('bookId', 'Book', reference.books.map((b) => ({ value: b.bookId, label: `${b.bookId} — ${b.name}` })))}
            {kInput('trader', 'Trader')}
            {kInput('externalId', 'External id')}
          </fieldset>
          {tpl && form.terms ? sections.map((s) => (
            <fieldset key={s.id} className="tr-fieldset" data-testid={`section-${s.id}`}>
              <legend>{s.title}</legend>
              <TemplateFields fields={fieldsOf(s.fields)} value={form.terms!} onChange={(t) => setForm((f) => ({ ...f, terms: t }))} issues={issues} base="terms" tid="t" reference={reference}
                changed={(p) => termsChanged.includes(p.split('.')[0]!)} />
            </fieldset>
          )) : null}
        </div>
        <aside className="tr-preview" data-testid="schedule-preview">
          <p className="eyebrow">Derived by the template</p>
          <dl className="tr-dl">
            <div><dt>Maturity</dt><dd data-testid="preview-maturity">{preview?.maturityDate ?? '—'}</dd></div>
            <div><dt>Issue date</dt><dd>{preview?.effectiveDate ?? '—'}</dd></div>
            <div><dt>Basket</dt><dd>{preview?.underlying ?? '—'}</dd></div>
          </dl>
          <table className="tr-table mt-2">
            <thead><tr><th>#</th><th>Observation</th><th>Payment</th><th>Autocall</th><th>Cpn bar.</th></tr></thead>
            <tbody>{(preview?.schedule ?? []).map((r) => <tr key={r.n} data-testid="preview-row"><td>{r.n}</td><td>{r.observationDate}</td><td>{r.paymentDate}</td><td>{r.autocallLevel == null ? '—' : pctStr(r.autocallLevel)}</td><td>{pctStr(r.couponBarrier)}</td></tr>)}</tbody>
          </table>
        </aside>
      </div>
      {validation?.warnings.length ? <div className="tr-warn" data-testid="form-warnings">{validation.warnings.map((w) => <div key={w.code + w.path}>⚠ {w.message}</div>)}</div> : null}
      {issues.length ? <div className="tr-alert mt-2" data-testid="form-issues">{issues.slice(0, 6).map((i) => <div key={i.path + i.code}><code>{i.path}</code> {i.message}</div>)}</div> : null}
      {amend ? (
        <label className="tr-field mt-3">
          <span>Reason for amendment (required, kept in the audit trail)</span>
          <input data-testid="f-reason" className="tr-input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Coupon corrected to final term sheet" />
        </label>
      ) : null}
      <p className="mt-2 text-[10px] text-muted">Template {tpl ? `${tpl.id}@${tpl.version}` : '…'} · idempotency key {idemKey} — resubmitting this form cannot double-book.</p>
    </Modal>
  )
}
