// Template widget "observation-timeline": every scheduled observation with its barriers
// (autocall step-down, coupon, KI) vs the captured worst-of fixing and what it triggered.
import { useEffect, useState } from 'react'
import { fmtNotional, tradeRepo } from '../api'
import { pctStr } from '../products'
import type { Schedule } from '../types'
import { ErrorState, Loading } from './common'

const W = 760, H = 230, PL = 44, PR = 12, PT = 12, PB = 28

export function ObservationTimeline({ tradeId, version, refreshKey, currency }: { tradeId: string; version?: number; refreshKey: number; currency: string }) {
  const [s, setS] = useState<Schedule | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    let live = true
    tradeRepo.call<Schedule>('tr_trade_schedule', { tradeId, version }).then((r) => { if (live) { setS(r); setError(null) } }).catch((e) => { if (live) setError(e) })
    return () => { live = false }
  }, [tradeId, version, refreshKey])
  if (error) return <ErrorState error={error} />
  if (!s) return <Loading />
  if (!s.rows.length) return <p className="text-xs text-muted">This product has no observation schedule.</p>
  const vals = [...s.rows.flatMap((r) => [r.autocallLevel ?? 0, r.couponBarrier ?? 0, r.fixing?.worst ?? 0]), s.knockIn.barrier ?? 0, 1.1]
  const yMax = Math.max(...vals) * 1.05, yMin = Math.min(0.3, ...s.rows.map((r) => r.fixing?.worst ?? 1)) * 0.95
  const n = s.rows.length
  const x = (i: number) => PL + ((W - PL - PR) * (i + 0.5)) / n
  const y = (v: number) => PT + (H - PT - PB) * (1 - (v - yMin) / (yMax - yMin))
  const step = (get: (i: number) => number | null) => s.rows.map((_, i) => { const v = get(i); return v == null ? '' : `M${x(i) - (W - PL - PR) / n / 2},${y(v)}h${(W - PL - PR) / n}` }).join('')
  const fixed = s.rows.filter((r) => r.fixing)
  return (
    <div data-testid="observation-timeline">
      <div className="mb-2 flex flex-wrap gap-3 text-[11px] text-muted">
        <span><i className="tr-legend" style={{ background: 'var(--theme-primary)' }} /> Autocall trigger</span>
        <span><i className="tr-legend" style={{ background: 'var(--theme-success, #22c55e)' }} /> Coupon barrier</span>
        <span><i className="tr-legend" style={{ background: 'var(--theme-danger, #ef4444)' }} /> KI barrier ({s.knockIn.observation?.toLowerCase()})</span>
        <span>● worst-of fixing</span>
        {s.knockIn.knockedIn ? <b className="text-danger" data-testid="ki-flag">Knocked in {s.knockIn.date} at {pctStr(s.knockIn.worst)}</b> : null}
        {s.redemption ? <b data-testid="redemption-flag">Redeemed {fmtNotional(s.redemption.amount)} {currency} ({pctStr(s.redemption.pct)}) on {s.redemption.paymentDate}</b> : null}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="tr-chart" role="img" aria-label="Observation schedule: fixings versus barriers">
        {[0.5, 0.75, 1, 1.25].filter((v) => v > yMin && v < yMax).map((v) => <g key={v}><line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} className="tr-grid-line" /><text x={4} y={y(v) + 3} className="tr-axis">{v * 100}%</text></g>)}
        <path d={step((i) => s.rows[i]!.couponBarrier)} stroke="var(--theme-success, #22c55e)" strokeWidth={2} fill="none" />
        <path d={step((i) => s.rows[i]!.autocallLevel)} stroke="var(--theme-primary)" strokeWidth={2} fill="none" />
        {s.knockIn.barrier ? <line x1={PL} x2={W - PR} y1={y(s.knockIn.barrier)} y2={y(s.knockIn.barrier)} stroke="var(--theme-danger, #ef4444)" strokeDasharray="6 5" strokeWidth={2} /> : null}
        {fixed.length > 1 ? <polyline points={fixed.map((r) => `${x(r.n - 1)},${y(r.fixing!.worst)}`).join(' ')} stroke="var(--theme-text)" strokeOpacity={0.5} fill="none" /> : null}
        {s.rows.map((r, i) => (
          <g key={r.n} data-testid={`obs-${r.n}`} data-status={r.status}>
            {r.fixing ? <circle cx={x(i)} cy={y(r.fixing.worst)} r={5} className={r.autocalled ? 'tr-dot-call' : r.coupon?.paid ? 'tr-dot-paid' : 'tr-dot-miss'}><title>{`#${r.n} ${r.observationDate}: worst ${r.fixing.worstSymbol} ${pctStr(r.fixing.worst)}`}</title></circle> : <circle cx={x(i)} cy={y(yMin) - 4} r={2.5} className="tr-dot-pending" />}
            {i % Math.ceil(n / 12) === 0 ? <text x={x(i)} y={H - 10} textAnchor="middle" className="tr-axis">{r.observationDate.slice(2, 7)}</text> : null}
          </g>
        ))}
      </svg>
      <table className="tr-table mt-2" data-testid="schedule-table">
        <thead><tr><th>#</th><th>Observation</th><th>Payment</th><th>Autocall</th><th>Coupon bar.</th><th>Worst-of</th><th>Outcome</th></tr></thead>
        <tbody>
          {s.rows.map((r) => (
            <tr key={r.n} data-testid="schedule-row" className={r.status === 'PENDING' ? '' : r.status === 'NOT_REACHED' ? 'opacity-50' : ''}>
              <td>{r.n}</td><td>{r.observationDate}</td><td>{r.paymentDate}</td><td>{r.autocallLevel == null ? '—' : pctStr(r.autocallLevel)}</td><td>{pctStr(r.couponBarrier)}</td>
              <td>{r.fixing ? `${pctStr(r.fixing.worst)} (${r.fixing.worstSymbol})` : '—'}</td>
              <td>{r.autocalled ? <b>Autocalled</b> : r.coupon ? (r.coupon.paid ? `Coupon ${fmtNotional(r.coupon.amount)}${r.coupon.memoryCatchUp ? ` (+${r.coupon.memoryCatchUp} memory)` : ''}` : 'Coupon missed') : r.status === 'NOT_REACHED' ? 'not reached' : 'pending'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {s.corporateActions.length ? <p className="mt-2 text-[11px] text-muted" data-testid="ca-list">Corporate actions: {s.corporateActions.map((c) => `${c.symbol} ${String(c.type).toLowerCase()} ex ${c.exDate} (×${c.factor})`).join('; ')}</p> : null}
    </div>
  )
}
