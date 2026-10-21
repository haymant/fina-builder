import { ExternalLink, GitCompare, History, Pencil, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { fmtNotional, tradeRepo } from '../api'
import type { AsOf, Change, LifecycleEvent, Trade, TradeEvent } from '../types'
import { Badge, ErrorState, Loading, fmtTs } from './common'

const ACTION_LABEL: Record<string, string> = { CANCEL: 'Cancel', NOVATE: 'Novate', PARTIAL_TERMINATE: 'Partial terminate', EXERCISE: 'Exercise', MATURE: 'Mature', BOOK_TRANSFER: 'Book transfer' }

export function TradeDrawer({ tradeId, asOf, refreshKey, canWrite, onClose, onAmend, onLifecycle, onOpenTrade, mode = 'inspector', version: controlledVersion, onVersion, onOpenTab, hasDraft }: {
  tradeId: string; asOf: AsOf; refreshKey: number; canWrite: boolean
  onClose: () => void; onAmend: (t: Trade) => void; onLifecycle: (t: Trade, e: LifecycleEvent) => void; onOpenTrade: (id: string) => void
  /** inspector = side panel next to the blotter; document = full-width tab body. */
  mode?: 'inspector' | 'document'
  /** Explicit version to show (undefined = latest / as-of). Controlled when onVersion is given. */
  version?: number; onVersion?: (v: number | undefined) => void
  onOpenTab?: (version?: number) => void
  hasDraft?: boolean
}) {
  const [localVersion, setLocalVersion] = useState<number | undefined>(undefined)
  const version = onVersion ? controlledVersion : localVersion
  const setVersion = (v: number | undefined) => (onVersion ? onVersion(v) : setLocalVersion(v))
  useEffect(() => { setLocalVersion(undefined) }, [tradeId])
  const [tab, setTab] = useState<'economics' | 'timeline' | 'diff'>('economics')
  const [data, setData] = useState<{ trade: Trade; isLatest: boolean; latestVersion: number; allowedEvents: string[] } | null>(null)
  const [events, setEvents] = useState<TradeEvent[]>([])
  const [error, setError] = useState<unknown>(null)
  const [diff, setDiff] = useState<{ from: number; to: number; changes: Change[] } | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [d, h] = await Promise.all([
        tradeRepo.call<typeof data>('tr_trade_get', version ? { tradeId, version } : { tradeId, ...asOf }),
        tradeRepo.call<{ events: TradeEvent[] }>('tr_trade_history', { tradeId }),
      ])
      setData(d)
      setEvents(h.events)
      const n = h.events.length
      if (n > 1) {
        const r = await tradeRepo.call<{ changes: Change[] }>('tr_trade_diff', { tradeId, fromVersion: n - 1, toVersion: n })
        setDiff({ from: n - 1, to: n, changes: r.changes })
      } else setDiff(null)
    } catch (e) {
      setError(e)
    }
  }, [tradeId, asOf, version])
  useEffect(() => { void load() }, [load, refreshKey])

  const pickDiff = async (from: number, to: number) => {
    if (from === to) return
    const r = await tradeRepo.call<{ changes: Change[] }>('tr_trade_diff', { tradeId, fromVersion: Math.min(from, to), toVersion: Math.max(from, to) })
    setDiff({ from: Math.min(from, to), to: Math.max(from, to), changes: r.changes })
  }

  const t = data?.trade
  const rows: [string, React.ReactNode][] = t ? [
    ['Product', t.productType.replace(/_/g, ' ')], ['Side', t.side], ['Notional', `${fmtNotional(t.notional)} ${t.currency}`],
    ...(t.terminatedNotional ? [['Terminated', `${fmtNotional(t.terminatedNotional)} ${t.currency}`] as [string, string]] : []),
    ['Underlying', t.underlying ?? '—'], ...(t.fixedRate !== undefined ? [['Fixed rate', `${(t.fixedRate * 100).toFixed(3)}%`] as [string, string]] : []),
    ...(t.price !== undefined ? [['Price', String(t.price)] as [string, string]] : []), ...(t.strike !== undefined ? [['Strike', String(t.strike)] as [string, string]] : []),
    ...(t.optionType ? [['Option', t.optionType] as [string, string]] : []),
    ['Trade date', t.tradeDate], ['Effective', t.effectiveDate ?? '—'], ['Maturity', t.maturityDate],
    ['Counterparty', t.counterpartyId], ['Book', t.bookId], ['Legal entity', t.legalEntityId], ['Trader', t.trader ?? '—'], ['Venue', t.venue ?? '—'],
    ['External id', t.externalId ?? '—'], ['UTI', <code key="uti" className="tr-code">{t.uti}</code>],
    ...(t.novatedTo ? [['Novated to', <button key="n" type="button" className="tr-link" onClick={() => onOpenTrade(t.novatedTo!)}>{t.novatedTo}</button>] as [string, React.ReactNode]] : []),
    ...(t.tags?.novatedFrom ? [['Novated from', <button key="nf" type="button" className="tr-link" onClick={() => onOpenTrade(t.tags!.novatedFrom!)}>{t.tags.novatedFrom}</button>] as [string, React.ReactNode]] : []),
    ['Content hash', <code key="h" className="tr-code">{t.contentHash}</code>],
  ] : []

  return (
    <aside className={`tr-drawer ${mode === 'document' ? 'tr-document' : ''}`} data-testid={mode === 'document' ? 'trade-document' : 'trade-drawer'} aria-label={`Trade ${tradeId}`}>
      <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="eyebrow">Trade detail</p>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-main"><span data-testid="drawer-trade-id">{tradeId}</span>{hasDraft ? <span className="tr-dirty" title="Unsaved amend draft" data-testid="draft-marker">● draft</span> : null}{t ? <Badge value={t.status} testId="drawer-status" /> : null}{t ? <span className="text-[11px] text-muted" data-testid="drawer-version">v{t.version}</span> : null}</h2>
        </div>
        <div className="flex items-center gap-1.5">
          {events.length > 1 ? (
            <select aria-label="Version" data-testid="version-switcher" className="control-select" value={version ?? ''} onChange={(e) => setVersion(e.target.value ? Number(e.target.value) : undefined)}>
              <option value="">Latest (v{events.length})</option>
              {events.slice().reverse().map((e) => <option key={e.version} value={e.version}>v{e.version} · {e.eventType.replace(/_/g, ' ').toLowerCase()}</option>)}
            </select>
          ) : null}
          {mode === 'inspector' && onOpenTab ? <button type="button" className="icon-button" title="Open in tab (double-click row)" aria-label="Open in tab" data-testid="open-in-tab" onClick={() => onOpenTab(version)}><ExternalLink size={14} /></button> : null}
          {mode === 'inspector' ? <button type="button" className="icon-button" aria-label="Close drawer" onClick={onClose}><X size={14} /></button> : null}
        </div>
      </div>
      {t && version && data && !data.isLatest ? (
        <div className="tr-info flex flex-wrap items-center gap-2" data-testid="version-banner">
          Viewing historical v{t.version} of {data.latestVersion}.
          <button type="button" className="tr-link" data-testid="compare-latest" onClick={() => { setTab('diff'); void pickDiff(t.version, data.latestVersion) }}><GitCompare size={12} className="inline" /> Compare with latest</button>
          {onOpenTab ? <button type="button" className="tr-link" data-testid="open-version-tab" onClick={() => onOpenTab(t.version)}>Open v{t.version} in new tab</button> : null}
          <button type="button" className="tr-link" data-testid="back-to-latest" onClick={() => setVersion(undefined)}>Back to latest</button>
        </div>
      ) : null}
      {error ? <ErrorState error={error} onRetry={load} /> : !t ? <Loading /> : (
        <>
          {!data!.isLatest && !version ? <div className="tr-asof-banner" data-testid="drawer-asof">Showing v{t.version} as of the selected time — latest is v{data!.latestVersion}. Actions are disabled in time-travel mode.</div> : null}
          {canWrite && data!.isLatest && t.status === 'LIVE' ? (
            <div className="flex flex-wrap gap-1.5 border-b border-line px-4 py-2" data-testid="drawer-actions">
              <button type="button" className="tr-primary tr-sm" data-testid="action-AMEND" onClick={() => onAmend(t)}><Pencil size={12} /> {hasDraft ? 'Resume amend draft' : 'Amend'}</button>
              {data!.allowedEvents.filter((e) => e !== 'AMEND').map((e) => (
                <button key={e} type="button" className={`add-tile-button tr-sm ${e === 'CANCEL' ? 'hover:text-danger' : ''}`} data-testid={`action-${e}`} onClick={() => onLifecycle(t, e as LifecycleEvent)}>{ACTION_LABEL[e]}</button>
              ))}
            </div>
          ) : null}
          <div className="tr-subtabs px-4" role="tablist">
            {(['economics', 'timeline', 'diff'] as const).map((k) => (
              <button key={k} role="tab" aria-selected={tab === k} data-testid={`drawer-tab-${k}`} type="button" className={`tr-subtab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
                {k === 'timeline' ? <><History size={12} /> Timeline ({events.length})</> : k === 'diff' ? 'Version diff' : 'Economics'}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
            {tab === 'economics' ? (
              <dl className="tr-dl" data-testid="economics">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
            ) : tab === 'timeline' ? (
              <ol className="tr-timeline" data-testid="timeline">
                {events.slice().reverse().map((e) => (
                  <li key={e.eventId} data-testid="timeline-event">
                    <div className="flex flex-wrap items-center gap-2">
                      <b className="text-xs text-main">v{e.version} · {e.eventType.replace(/_/g, ' ')}</b>
                      {e.amendKind ? <Badge value={e.amendKind} /> : null}
                      <Badge value={e.status} />
                    </div>
                    <p className="text-[11px] text-muted">valid from {e.validFrom} · recorded {fmtTs(e.recordedAt)} · by {e.actor}</p>
                    {e.reason ? <p className="text-[11px] text-main">“{e.reason}”</p> : null}
                    {e.changes.length && e.version > 1 ? <ul className="tr-changes">{e.changes.slice(0, 6).map((c) => <li key={c.field}><span>{c.field}</span> {String(c.before ?? '∅')} → <b>{String(c.after ?? '∅')}</b></li>)}</ul> : null}
                  </li>
                ))}
              </ol>
            ) : (
              <div data-testid="diff">
                {events.length < 2 ? <p className="text-xs text-muted">Only one version — nothing to compare.</p> : (
                  <>
                    <div className="mb-2 flex items-center gap-2 text-xs">
                      <select aria-label="From version" data-testid="diff-from" className="control-select" value={diff?.from} onChange={(e) => void pickDiff(Number(e.target.value), diff?.to ?? events.length)}>{events.map((e) => <option key={e.version} value={e.version}>v{e.version}</option>)}</select>
                      →
                      <select aria-label="To version" data-testid="diff-to" className="control-select" value={diff?.to} onChange={(e) => void pickDiff(diff?.from ?? 1, Number(e.target.value))}>{events.map((e) => <option key={e.version} value={e.version}>v{e.version}</option>)}</select>
                    </div>
                    <table className="tr-table"><thead><tr><th>Field</th><th>v{diff?.from}</th><th>v{diff?.to}</th><th /></tr></thead>
                      <tbody>{diff?.changes.map((c) => <tr key={c.field} data-testid="diff-row"><td>{c.field}</td><td className="tr-before">{JSON.stringify(c.before)}</td><td className="tr-after">{JSON.stringify(c.after)}</td><td>{c.economic ? <Badge value="ECONOMIC" /> : null}</td></tr>)}</tbody>
                    </table>
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  )
}
