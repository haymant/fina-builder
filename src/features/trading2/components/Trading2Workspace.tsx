import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, ShieldAlert } from 'lucide-react'
import { PanelCard } from '../../shared/components/PanelCard'
import { Trading2Error, trading2Api, type Trading2Account, type Trading2NewsItem, type Trading2Order, type Trading2Position, type Trading2WatchlistItem } from '../../../api/trading2Api'
import type { Trading2View } from '../../workspace/navigation'

export type Trading2WorkspaceView = Trading2View

function formatMoney(value?: number): string {
  return value === undefined ? '—' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value)
}
function formatNumber(value?: number): string {
  return value === undefined ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value)
}
function Loading() { return <div className="narrative-empty" role="status">Loading Trading 2ⁿᵈ account data…</div> }
function Empty({ title, hint }: { title: string; hint: string }) { return <div className="narrative-empty" role="status"><b>{title}</b><span className="text-[11px]">{hint}</span></div> }
function ErrorState({ error, retry }: { error: Trading2Error; retry: () => void }) {
  return <div className="narrative-empty" role="alert">
    <ShieldAlert size={20} className="text-primary" />
    <b>{error.kind === 'unavailable' ? 'Trading 2ⁿᵈ data is not configured' : 'Trading 2ⁿᵈ data could not be loaded'}</b>
    <span className="max-w-lg text-center text-[11px]">{error.message}</span>
    {error.kind === 'unavailable' ? <span className="text-[11px]">Configure Alpaca credentials for account and broker data, or use the TAC lake for read-only market views.</span> : null}
    <button type="button" className="ghost-button mt-2" onClick={retry}><RefreshCw size={13} /> Retry</button>
  </div>
}

function AccountCard({ account }: { account: Trading2Account | null }) {
  if (!account) return <Empty title="Account unavailable" hint="The TAC engine did not return an account record." />
  const fields = [['Status', account.status], ['Equity', formatMoney(account.equity ?? account.portfolioValue)], ['Cash', formatMoney(account.cash)], ['Buying power', formatMoney(account.buyingPower)], ['Day trades', formatNumber(account.dayTradeCount)]]
  return <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-5">{fields.map(([label, value]) => <div key={label} className="rounded border border-line bg-bg px-2 py-2"><div className="text-[10px] uppercase tracking-wide text-muted">{label}</div><div className="mt-1 text-xs font-semibold text-main">{value ?? '—'}</div></div>)}</div>
}

function PositionsTable({ rows }: { rows: Trading2Position[] }) {
  if (!rows.length) return <Empty title="No open positions" hint="The account currently has no positions returned by TAC." />
  return <div className="overflow-auto"><table className="w-full text-left text-xs"><thead className="border-b border-line text-[10px] uppercase tracking-wide text-muted"><tr><th className="px-3 py-2">Symbol</th><th className="px-3 py-2">Qty</th><th className="px-3 py-2">Market value</th><th className="px-3 py-2">Unrealized P/L</th><th className="px-3 py-2">P/L %</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.symbol}-${index}`} className="border-b border-line last:border-0"><td className="px-3 py-2 font-semibold">{row.symbol}</td><td className="px-3 py-2">{formatNumber(row.quantity)}</td><td className="px-3 py-2">{formatMoney(row.marketValue)}</td><td className="px-3 py-2">{formatMoney(row.unrealizedPl)}</td><td className="px-3 py-2">{row.unrealizedPlPct === undefined ? '—' : `${formatNumber(row.unrealizedPlPct * 100)}%`}</td></tr>)}</tbody></table></div>
}

function OrdersTable({ rows }: { rows: Trading2Order[] }) {
  if (!rows.length) return <Empty title="No open orders" hint="There are no open orders returned by TAC." />
  return <div className="overflow-auto"><table className="w-full text-left text-xs"><thead className="border-b border-line text-[10px] uppercase tracking-wide text-muted"><tr><th className="px-3 py-2">Symbol</th><th className="px-3 py-2">Side</th><th className="px-3 py-2">Qty</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Status</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.id ?? row.symbol}-${index}`} className="border-b border-line last:border-0"><td className="px-3 py-2 font-semibold">{row.symbol}</td><td className="px-3 py-2">{row.side ?? '—'}</td><td className="px-3 py-2">{formatNumber(row.quantity)}</td><td className="px-3 py-2">{row.type ?? '—'}</td><td className="px-3 py-2">{row.status ?? '—'}</td></tr>)}</tbody></table></div>
}

function NewsList({ rows }: { rows: Trading2NewsItem[] }) {
  if (!rows.length) return <Empty title="No news returned" hint="TAC returned no news for the current query." />
  return <div className="divide-y divide-line">{rows.map((row, index) => <article key={`${row.id ?? row.headline}-${index}`} className="p-3"><div className="flex items-start justify-between gap-3"><div><h2 className="text-xs font-semibold text-main">{row.headline}</h2><p className="mt-1 text-[11px] text-muted">{[row.source, row.createdAt].filter(Boolean).join(' · ') || 'TAC news'}</p></div>{row.url ? <a className="ghost-button shrink-0" href={row.url} target="_blank" rel="noreferrer">Open</a> : null}</div>{row.summary ? <p className="mt-2 line-clamp-3 text-xs text-muted">{row.summary}</p> : null}{row.symbols.length ? <div className="mt-2 flex flex-wrap gap-1">{row.symbols.slice(0, 8).map((symbol) => <span key={symbol} className="rounded border border-line px-1.5 py-0.5 text-[10px] text-muted">{symbol}</span>)}</div> : null}</article>)}</div>
}

function WatchlistTable({ rows }: { rows: Trading2WatchlistItem[] }) {
  if (!rows.length) return <Empty title="Watchlist is empty" hint="TAC returned no symbols in the local watchlist." />
  return <div className="overflow-auto"><table className="w-full text-left text-xs"><thead className="border-b border-line text-[10px] uppercase tracking-wide text-muted"><tr><th className="px-3 py-2">Symbol</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Price</th><th className="px-3 py-2">Change</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.symbol}-${index}`} className="border-b border-line last:border-0"><td className="px-3 py-2 font-semibold">{row.symbol}</td><td className="px-3 py-2">{row.name ?? '—'}</td><td className="px-3 py-2">{formatMoney(row.price)}</td><td className="px-3 py-2">{row.changePct === undefined ? '—' : `${formatNumber(row.changePct)}%`}</td></tr>)}</tbody></table></div>
}

export function Trading2Workspace({ view }: { view: Trading2View }) {
  const [account, setAccount] = useState<Trading2Account | null>(null)
  const [positions, setPositions] = useState<Trading2Position[]>([])
  const [orders, setOrders] = useState<Trading2Order[]>([])
  const [news, setNews] = useState<Trading2NewsItem[]>([])
  const [watchlist, setWatchlist] = useState<Trading2WatchlistItem[]>([])
  const [error, setError] = useState<Trading2Error | null>(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      if (view === 'account') setAccount(await trading2Api.getAccount())
      else if (view === 'positions') setPositions(await trading2Api.listPositions())
      else if (view === 'orders') setOrders(await trading2Api.listOrders())
      else if (view === 'news') setNews(await trading2Api.getNews())
      else if (view === 'watchlist') setWatchlist(await trading2Api.getWatchlist())
      else {
        const snapshot = await trading2Api.loadSnapshot()
        setAccount(snapshot.account); setPositions(snapshot.positions); setOrders(snapshot.orders)
      }
    } catch (cause) {
      setError(cause instanceof Trading2Error ? cause : new Trading2Error(String(cause), 'backend'))
    } finally { setLoading(false) }
  }, [view])
  useEffect(() => { void load() }, [load])
  const title = useMemo(() => ({ overview: 'Trading 2ⁿᵈ overview', account: 'Account', positions: 'Positions', orders: 'Orders', news: 'News', watchlist: 'Watchlist' }[view]), [view])
  return <main className="workspace-canvas relative min-h-0 flex-1 overflow-auto p-4" data-testid="trading2-workspace">
    <div className="mb-4 flex items-center gap-3"><div><p className="eyebrow">Trading 2ⁿᵈ</p><h1 className="text-lg font-semibold text-main">{title}</h1><p className="text-xs text-muted">Read-only TAC account and broker state. Mutations are intentionally not enabled in this slice.</p></div><button type="button" className="ghost-button ml-auto" onClick={() => void load()} disabled={loading}><RefreshCw size={13} /> Refresh</button></div>
    {loading ? <Loading /> : error ? <ErrorState error={error} retry={() => void load()} /> : view === 'account' ? <PanelCard title="Broker account" subtitle="TAC account snapshot" collapsible={false}><AccountCard account={account} /></PanelCard> : view === 'positions' ? <PanelCard title="Open positions" subtitle={`${positions.length} position${positions.length === 1 ? '' : 's'}`} collapsible={false}><PositionsTable rows={positions} /></PanelCard> : view === 'orders' ? <PanelCard title="Open orders" subtitle={`${orders.length} order${orders.length === 1 ? '' : 's'}`} collapsible={false}><OrdersTable rows={orders} /></PanelCard> : view === 'news' ? <PanelCard title="Market news" subtitle={`${news.length} article${news.length === 1 ? '' : 's'}`} collapsible={false}><NewsList rows={news} /></PanelCard> : view === 'watchlist' ? <PanelCard title="Watchlist" subtitle={`${watchlist.length} symbol${watchlist.length === 1 ? '' : 's'}`} collapsible={false}><WatchlistTable rows={watchlist} /></PanelCard> : <div className="grid min-h-0 gap-4 xl:grid-cols-3"><PanelCard title="Account" subtitle="TAC snapshot" collapsible={false}><AccountCard account={account} /></PanelCard><PanelCard title="Positions" subtitle={`${positions.length} open`} collapsible={false}><PositionsTable rows={positions} /></PanelCard><PanelCard title="Orders" subtitle={`${orders.length} open`} collapsible={false}><OrdersTable rows={orders} /></PanelCard></div>}
  </main>
}
