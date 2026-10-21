// Generic term-sheet renderer: layout + values are evaluated server-side from the template.
import { useEffect, useState } from 'react'
import { tradeRepo } from '../api'
import type { TermSheet as TS } from '../types'
import { ErrorState, Loading } from './common'

export function TermSheet({ tradeId, version, refreshKey }: { tradeId: string; version?: number; refreshKey: number }) {
  const [ts, setTs] = useState<TS | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    let live = true
    tradeRepo.call<TS>('tr_trade_termsheet', { tradeId, version }).then((r) => { if (live) { setTs(r); setError(null) } }).catch((e) => { if (live) setError(e) })
    return () => { live = false }
  }, [tradeId, version, refreshKey])
  if (error) return <ErrorState error={error} />
  if (!ts) return <Loading />
  return (
    <div className="tr-termsheet" data-testid="termsheet">
      {ts.sections.map((s) => (
        <section key={s.title} data-testid={`ts-${s.title.toLowerCase().replace(/\W+/g, '-')}`}>
          <h3>{s.title}</h3>
          {s.columns ? (
            <table className="tr-table"><thead><tr>{s.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead><tbody>{s.rows.map((r, i) => <tr key={i}>{r.map((v, k) => <td key={k}>{String(v)}</td>)}</tr>)}</tbody></table>
          ) : (
            <dl className="tr-dl">{s.rows.map(([k, v]) => <div key={String(k)}><dt>{k}</dt><dd>{String(v)}</dd></div>)}</dl>
          )}
        </section>
      ))}
    </div>
  )
}
