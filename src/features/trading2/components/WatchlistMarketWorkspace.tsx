import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import Chart from '../../shared/components/Chart'
import { PanelCard } from '../../shared/components/PanelCard'
import { WorkspaceTileGrid } from '../../workspace/components/WorkspaceTileGrid'
import { ConfirmDialog } from '../../workspace/components/ConfirmDialog'
import { Trading2Error, trading2Api, type Trading2Bar, type Trading2FeatureRow, type Trading2Option, type Trading2Order, type Trading2Quote, type Trading2Watchlist } from '../../../api/trading2Api'
import { LakeIndicatorPicker } from './LakeIndicatorPicker'
import { DEFAULT_INCLUDE_VOLUME, DEFAULT_SELECTION, hasSpSelection, selectionToSeries, selectionToSpFamilies, selectionToTaSpecs } from '../indicatorCatalog'
import type { IndicatorSeries, SelectedIndicator } from '../marketTypes'
import type { MacroBar } from '../macroCatalog'

const inputClass = 'w-full rounded-md border border-line bg-bg px-2.5 py-2 text-xs text-main outline-none focus:border-primary'
const primaryClass = 'inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50'
const ghostClass = 'inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-main hover:border-primary disabled:opacity-50'

function money(value?: number) { return value === undefined ? '—' : `$${value.toFixed(2)}` }
function dateOnly(value: Date) { return value.toISOString().slice(0, 10) }

// Share only in-flight reads. This removes the selected-symbol duplicate while
// avoiding a stale quote cache for later symbol changes or manual refreshes.
const quoteRequests = new Map<string, Promise<Trading2Quote | null>>()
function getQuoteOnce(symbol: string): Promise<Trading2Quote | null> {
  const key = symbol.trim().toUpperCase()
  const existing = quoteRequests.get(key)
  if (existing) return existing
  const request = trading2Api.getQuote(key).then((quote) =>
    quote.bid !== undefined || quote.ask !== undefined || quote.last !== undefined ? quote : null,
  ).finally(() => quoteRequests.delete(key))
  quoteRequests.set(key, request)
  return request
}

const barsCache = new Map<string, Trading2Bar[]>()
const barsRequests = new Map<string, Promise<Trading2Bar[]>>()
class LatestRequestQueue<T> {
  private active = false
  private pending: { run: () => Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } | null = null

  enqueue(run: () => Promise<T>, staleValue: T): Promise<T> {
    const promise = new Promise<T>((resolve, reject) => {
      if (this.pending) this.pending.resolve(staleValue)
      this.pending = { run, resolve, reject }
    })
    void this.pump()
    return promise
  }

  private async pump() {
    if (this.active || !this.pending) return
    this.active = true
    const task = this.pending
    this.pending = null
    try {
      task.resolve(await task.run())
    } catch (cause) {
      task.reject(cause)
    } finally {
      this.active = false
      if (this.pending) void this.pump()
    }
  }
}

const barsQueue = new LatestRequestQueue<Trading2Bar[]>()
const selectedDetailsQueue = new LatestRequestQueue<[Trading2Quote | null, Trading2Option[]]>()
const featuresQueue = new LatestRequestQueue<Trading2FeatureRow[]>()

function getLakeBarsOnce(symbol: string, start: string, end: string): Promise<Trading2Bar[]> {
  const key = `${symbol.trim().toUpperCase()}|${start}|${end}`
  const cached = barsCache.get(key)
  if (cached) return Promise.resolve(cached)
  const existing = barsRequests.get(key)
  if (existing) return existing
  const request = barsQueue.enqueue(() => trading2Api.getLakeBars(symbol, start, end).then((bars) => {
    barsCache.set(key, bars)
    return bars
  }), [])
  request.finally(() => barsRequests.delete(key)).catch(() => undefined)
  barsRequests.set(key, request)
  return request
}

function scheduleOptional(task: () => void, delay = 0): () => void {
  const timer = setTimeout(task, delay)
  return () => clearTimeout(timer)
}

function CandleChart({ bars, features, series, vixBars }: { bars: Trading2Bar[]; features: Trading2FeatureRow[]; series: IndicatorSeries[]; vixBars: MacroBar[] }) {
  const option = useMemo(() => {
    const visible = bars.length > 300 ? bars.slice(-300) : bars
    const dates = visible.map((bar) => bar.timestamp.slice(0, 16))
    const keys = new Map<string, Trading2FeatureRow>()
    const dateKeys = new Map<string, Trading2FeatureRow>()
    for (const row of features) {
      keys.set(row.timestamp, row)
      dateKeys.set(row.timestamp.slice(0, 10), row)
    }
    const panes = ['price', ...Array.from(new Set(series.filter((item) => item.pane !== 'price').map((item) => item.pane))), ...(vixBars.length ? ['vix'] : [])]
    const paneIndex = (pane: string) => Math.max(0, panes.indexOf(pane))
    const height = panes.length === 1 ? 70 : panes.length === 2 ? 56 : 42
    const grid = panes.map((_, index) => ({ left: 52, right: 18, top: 30 + index * (height + 8) + '%', height: `${height}%` }))
    const xAxis = panes.map((_, index) => ({ type: 'category', data: dates, gridIndex: index, boundaryGap: true, axisLabel: { show: index === panes.length - 1, fontSize: 10 } }))
    const yAxis = panes.map((_, index) => ({ type: 'value', scale: true, gridIndex: index, axisLabel: { fontSize: 9 } }))
    const outSeries: Record<string, unknown>[] = [{ name: 'Candlestick', type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0, data: visible.map((bar) => [bar.open ?? null, bar.close ?? null, bar.low ?? null, bar.high ?? null]), itemStyle: { color: '#16a34a', color0: '#dc2626', borderColor: '#16a34a', borderColor0: '#dc2626' } }]
    for (const item of series) {
      const data = visible.map((bar) => {
        const row = keys.get(bar.timestamp) ?? dateKeys.get(bar.timestamp.slice(0, 10))
        if (item.key === 'volume') return bar.volume ?? null
        const value = row?.[item.key]
        return typeof value === 'number' && Number.isFinite(value) ? value : null
      })
      outSeries.push({ name: item.label, type: item.kind === 'bar' ? 'bar' : 'line', xAxisIndex: paneIndex(item.pane), yAxisIndex: paneIndex(item.pane), data, showSymbol: false, smooth: true, lineStyle: { width: 1.4 }, itemStyle: { color: item.color } })
    }
    if (vixBars.length) {
      const byDate = new Map(vixBars.map((bar) => [bar.t.slice(0, 10), [bar.o, bar.c, bar.l, bar.h]]))
      outSeries.push({ name: 'VIX', type: 'candlestick', xAxisIndex: paneIndex('vix'), yAxisIndex: paneIndex('vix'), data: dates.map((date) => byDate.get(date.slice(0, 10)) ?? [null, null, null, null]), itemStyle: { color: '#16a34a', color0: '#dc2626', borderColor: '#16a34a', borderColor0: '#dc2626' } })
    }
    return { animation: false, grid, xAxis, yAxis, legend: { top: 3, type: 'scroll', data: ['Candlestick', ...series.map((item) => item.label), ...(vixBars.length ? ['VIX'] : [])], textStyle: { fontSize: 10 } }, tooltip: { trigger: 'axis' }, dataZoom: [{ type: 'inside', xAxisIndex: panes.map((_, index) => index), start: 0, end: 100 }, { type: 'slider', xAxisIndex: panes.map((_, index) => index), bottom: 6, height: 18, start: 0, end: 100 }], series: outSeries }
  }, [bars, features, series, vixBars])
  return bars.length ? <Chart option={option} style={{ height: 560, width: '100%' }} /> : <div className="flex h-[560px] items-center justify-center text-xs text-muted">No bar data for this symbol and date range.</div>
}

function QuickOrder({ symbol, quote, onOrder }: { symbol: string; quote: Trading2Quote | null; onOrder: (order: Trading2Order) => void }) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy'); const [type, setType] = useState<'market' | 'limit'>('market'); const [tif, setTif] = useState<'day' | 'gtc' | 'ioc'>('day'); const [qty, setQty] = useState('1'); const [limit, setLimit] = useState(''); const [confirm, setConfirm] = useState(false); const [message, setMessage] = useState('')
  const suggested = side === 'buy' ? quote?.ask : quote?.bid
  useEffect(() => { if (suggested !== undefined && type === 'limit') setLimit(String(suggested)) }, [suggested, type])
  const submit = (event: React.FormEvent) => { event.preventDefault(); if (!qty || Number(qty) <= 0 || (type === 'limit' && (!limit || Number(limit) <= 0))) return setMessage('Enter a positive quantity and required limit price.'); setMessage(''); setConfirm(true) }
  const place = async () => { setConfirm(false); try { const result = await trading2Api.placeOrder({ symbol, side, type, timeInForce: tif, qty, limitPrice: type === 'limit' ? limit : undefined }); setMessage(`Submitted ${result.symbol} · ${result.status ?? 'acknowledged'}`); onOrder(result) } catch (cause) { setMessage(cause instanceof Trading2Error ? cause.message : String(cause)) } }
  return <><div className="space-y-3"><div className="grid grid-cols-3 gap-2 text-xs"><div className="rounded-md bg-success/10 p-2"><span className="block text-[10px] text-muted">Bid</span><b className="text-success">{money(quote?.bid)}</b><span className="block text-[10px] text-muted">size {quote?.bidSize ?? '—'}</span></div><div className="rounded-md bg-bg p-2 text-center"><span className="block text-[10px] text-muted">Last close</span><b className="text-main">{money(quote?.last)}</b><span className="block text-[10px] text-muted">daily bar</span></div><div className="rounded-md bg-danger/10 p-2 text-right"><span className="block text-[10px] text-muted">Ask</span><b className="text-danger">{money(quote?.ask)}</b><span className="block text-[10px] text-muted">size {quote?.askSize ?? '—'}</span></div></div><form className="grid grid-cols-2 gap-2" onSubmit={submit}><label className="space-y-1 text-[10px] text-muted">Side<select className={inputClass} value={side} onChange={(e) => setSide(e.target.value as 'buy' | 'sell')}><option value="buy">Buy</option><option value="sell">Sell</option></select></label><label className="space-y-1 text-[10px] text-muted">Type<select className={inputClass} value={type} onChange={(e) => setType(e.target.value as 'market' | 'limit')}><option value="market">Market</option><option value="limit">Limit</option></select></label><label className="space-y-1 text-[10px] text-muted">TIF<select className={inputClass} value={tif} onChange={(e) => setTif(e.target.value as typeof tif)}><option value="day">Day</option><option value="gtc">GTC</option><option value="ioc">IOC</option></select></label><label className="space-y-1 text-[10px] text-muted">Qty<input className={inputClass} value={qty} onChange={(e) => setQty(e.target.value)} /></label>{type === 'limit' ? <label className="col-span-2 space-y-1 text-[10px] text-muted">Limit price<input className={inputClass} value={limit} onChange={(e) => setLimit(e.target.value)} /></label> : null}<button className={`${primaryClass} col-span-2`} type="submit">{side === 'buy' ? 'Buy' : 'Sell'} {symbol}</button></form>{message ? <p className="text-[11px] text-muted" role="status">{message}</p> : null}</div><ConfirmDialog open={confirm} title="Confirm watchlist order" message={`${side.toUpperCase()} ${qty} ${symbol} ${type} · ${tif}. Account/environment and paper/live mode remain host-controlled.`} confirmLabel="Submit order" onConfirm={() => void place()} onCancel={() => setConfirm(false)} /></>
}

function OptionChain({ options }: { options: Trading2Option[] }) { const expirations = [...new Set(options.map((option) => option.expiration).filter(Boolean))] as string[]; const [expiration, setExpiration] = useState(''); useEffect(() => { setExpiration((current) => current && expirations.includes(current) ? current : expirations[0] ?? '') }, [options]) ; const rows = options.filter((option) => !expiration || option.expiration === expiration).sort((a, b) => (a.strike ?? 0) - (b.strike ?? 0)); return <div className="space-y-2"><div className="flex items-center justify-between gap-2"><p className="text-[11px] text-muted">Calls and puts from canonical TAC option snapshots.</p><select className={inputClass} value={expiration} onChange={(e) => setExpiration(e.target.value)}><option value="">All expirations</option>{expirations.map((item) => <option key={item} value={item}>{item}</option>)}</select></div>{rows.length ? <div className="max-h-[360px] overflow-auto rounded-md border border-line"><table className="min-w-[700px] w-full text-xs"><thead className="sticky top-0 bg-bg text-[10px] uppercase text-muted"><tr><th className="px-2 py-2">Type</th><th className="px-2 py-2 text-right">Bid</th><th className="px-2 py-2 text-right">Ask</th><th className="px-2 py-2 text-right">Mid</th><th className="px-2 py-2 text-right">Strike</th><th className="px-2 py-2 text-right">Volume</th><th className="px-2 py-2 text-right">IV</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.symbol ?? row.type}-${row.strike}-${index}`} className="border-t border-line"><td className="px-2 py-1.5 uppercase">{row.type ?? '—'}</td><td className="px-2 py-1.5 text-right">{money(row.bid)}</td><td className="px-2 py-1.5 text-right">{money(row.ask)}</td><td className="px-2 py-1.5 text-right">{money(row.mid)}</td><td className="px-2 py-1.5 text-right">{row.strike ?? '—'}</td><td className="px-2 py-1.5 text-right">{row.volume ?? '—'}</td><td className="px-2 py-1.5 text-right">{row.impliedVolatility === undefined ? '—' : `${(row.impliedVolatility * 100).toFixed(2)}%`}</td></tr>)}</tbody></table></div> : <div className="py-8 text-center text-xs text-muted">No option chain data.</div>}</div> }

function IntradayPriceBar({ bar, last }: { bar?: Trading2Bar; last?: number }) {
  const open = bar?.open
  const low = bar?.low
  const high = bar?.high
  const close = last ?? bar?.close
  if (![open, low, high, close].every((value) => typeof value === 'number' && Number.isFinite(value)) || (high as number) <= (low as number)) return <span className="h-7 w-24 shrink-0 rounded border border-line/60" aria-label="Intraday range unavailable" />
  const range = (high as number) - (low as number)
  const position = (value: number) => `${Math.max(0, Math.min(100, ((value - (low as number)) / range) * 100))}%`
  const left = Math.min(open as number, close as number)
  const width = Math.max(2, Math.abs((close as number) - (open as number)) / range * 100)
  const rising = (close as number) > (open as number)
  return <span className="relative block h-7 w-24 shrink-0" title={`Low ${money(low)} · Open ${money(open)} · Last ${money(close)} · High ${money(high)}`} aria-label={`Low ${money(low)}, open ${money(open)}, last ${money(close)}, high ${money(high)}`}><span className="absolute left-0 right-0 top-1/2 h-px -translate-y-1/2 bg-muted/70" /><span className={`absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full ${rising ? 'bg-success' : 'bg-danger'}`} style={{ left: position(left), width: `${width}%` }} /><span className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-main" style={{ left: position(open as number) }} /><span className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-main" style={{ left: position(close as number) }} /></span>
}

export function WatchlistMarketWorkspace({ watchlists, selected, onWatchlistsChange, onSelectedChange }: { watchlists: Trading2Watchlist[]; selected: Trading2Watchlist | null; onWatchlistsChange: (lists: Trading2Watchlist[]) => void; onSelectedChange: (list: Trading2Watchlist | null) => void }) {
  const [symbol, setSymbol] = useState(selected?.symbols[0] ?? ''); const [newSymbol, setNewSymbol] = useState(''); const [newName, setNewName] = useState(''); const [bars, setBars] = useState<Trading2Bar[]>([]); const [quote, setQuote] = useState<Trading2Quote | null>(null); const [options, setOptions] = useState<Trading2Option[]>([]); const [vixBars, setVixBars] = useState<MacroBar[]>([]); const [rowQuotes, setRowQuotes] = useState<Record<string, Trading2Quote | null>>({}); const [rowBars, setRowBars] = useState<Record<string, Trading2Bar[]>>({}); const [rowLastCloses, setRowLastCloses] = useState<Record<string, number>>({}); const [marketError, setMarketError] = useState(''); const [range, setRange] = useState(180); const [runOpen, setRunOpen] = useState(false); const [pendingAction, setPendingAction] = useState<{ kind: 'create' | 'add' | 'remove'; value: string } | null>(null); const [selection, setSelection] = useState<SelectedIndicator[]>(DEFAULT_SELECTION); const [includeVolume, setIncludeVolume] = useState(DEFAULT_INCLUDE_VOLUME); const [persistFeatures, setPersistFeatures] = useState(false); const [features, setFeatures] = useState<Trading2FeatureRow[]>([]); const [featureError, setFeatureError] = useState(''); const [barsReady, setBarsReady] = useState<{ symbol: string; range: number } | null>(null)
  useEffect(() => { if (selected && !selected.symbols.includes(symbol)) setSymbol(selected.symbols[0] ?? '') }, [selected?.id, selected?.symbols.join(',')])
  useEffect(() => {
    let cancelled = false
    const cancelSchedule = scheduleOptional(() => {
      Promise.all((selected?.symbols ?? []).map(async (item) => [item, await getQuoteOnce(item)] as const)).then((entries) => { if (!cancelled) setRowQuotes(Object.fromEntries(entries)) }).catch(() => { if (!cancelled) setRowQuotes({}) })
    })
    return () => { cancelled = true; cancelSchedule() }
  }, [selected?.id, selected?.symbols.join(',')])
  useEffect(() => {
    let cancelled = false
    const end = dateOnly(new Date())
    const startDate = new Date()
    startDate.setUTCDate(startDate.getUTCDate() - 30)
    const start = dateOnly(startDate)
    setRowBars({})
    setRowLastCloses({})
    Promise.all((selected?.symbols ?? []).map(async (item) => {
      const history = await trading2Api.getLakeBars(item, start, end)
      return [item, history] as const
    })).then((entries) => {
      if (cancelled) return
      setRowBars(Object.fromEntries(entries))
      setRowLastCloses(Object.fromEntries(entries.filter((entry): entry is [string, Trading2Bar[]] => entry[1].length > 0).map(([item, history]) => [item, history.at(-1)?.close]).filter((entry): entry is [string, number] => entry[1] !== undefined)))
    }).catch(() => { if (!cancelled) { setRowBars({}); setRowLastCloses({}) } })
    return () => { cancelled = true }
  }, [selected?.id, selected?.symbols.join(',')])
  useEffect(() => {
    if (!symbol) { setBars([]); setBarsReady(null); return }
    const end = new Date(); const start = new Date(); start.setUTCDate(end.getUTCDate() - range)
    let cancelled = false
    setMarketError(''); setBarsReady(null); setVixBars([])
    const timer = window.setTimeout(() => {
      Promise.all([getLakeBarsOnce(symbol, dateOnly(start), dateOnly(end)), trading2Api.getMacroBars('CBOE_VIX', dateOnly(start), dateOnly(end)).catch(() => [])]).then(([nextBars, nextVix]) => {
        if (cancelled) return
        setBars(nextBars)
        setVixBars(nextVix)
        // TA/SP must run after the lazy bar fetch has persisted the bars: get_lake_ta
        // only reads the lake and returns nothing while the bar file is missing.
        setBarsReady({ symbol, range })
      }).catch((cause) => { if (!cancelled) { setBars([]); setMarketError(cause instanceof Trading2Error ? cause.message : String(cause)) } })
    }, 180)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [symbol, range])
  useEffect(() => {
    if (!symbol) { setQuote(null); setOptions([]); return }
    let cancelled = false
    setQuote(null); setOptions([])
    const cancelSchedule = scheduleOptional(() => {
      selectedDetailsQueue.enqueue(async () => {
        const [nextQuote, nextOptions] = await Promise.allSettled([getQuoteOnce(symbol), trading2Api.getOptionChain(symbol)])
        return [nextQuote.status === 'fulfilled' ? nextQuote.value : null, nextOptions.status === 'fulfilled' ? nextOptions.value : []]
      }, [null, []]).then(([nextQuote, nextOptions]) => {
        if (cancelled) return
        setQuote(nextQuote)
        setOptions(nextOptions)
      })
    })
    return () => { cancelled = true; cancelSchedule() }
  }, [symbol])
  useEffect(() => {
    if (!symbol) { setFeatures([]); return }
    if (barsReady?.symbol !== symbol || barsReady?.range !== range) { setFeatures([]); return }
    const taSpecs = selectionToTaSpecs(selection)
    const spFamilies = selectionToSpFamilies(selection)
    if (!taSpecs.length && !hasSpSelection(selection)) { setFeatures([]); return }
    const end = dateOnly(new Date()); const startDate = new Date(); startDate.setUTCDate(startDate.getUTCDate() - range); const start = dateOnly(startDate)
    let cancelled = false
    setFeatureError('')
    const cancelSchedule = scheduleOptional(() => {
      featuresQueue.enqueue(() => Promise.all([
        taSpecs.length ? trading2Api.getLakeTa(symbol, '1d', start, end, taSpecs, persistFeatures) : Promise.resolve([]),
        hasSpSelection(selection) ? trading2Api.getLakeSp(symbol, '1d', start, end, spFamilies, persistFeatures) : Promise.resolve([]),
      ]).then(([ta, sp]) => {
        const merged = new Map<string, Trading2FeatureRow>()
        for (const row of [...ta, ...sp]) merged.set(row.timestamp, { ...(merged.get(row.timestamp) ?? {}), ...row })
        return [...merged.values()]
      }), []).then((nextFeatures) => {
        if (cancelled) return
        setFeatures(nextFeatures)
      }).catch((cause) => { if (!cancelled) { setFeatures([]); setFeatureError(cause instanceof Trading2Error ? cause.message : String(cause)) } })
    })
    return () => { cancelled = true; cancelSchedule() }
  }, [symbol, range, selection, persistFeatures, barsReady])

  const addSymbol = async () => { const value = pendingAction?.value; setPendingAction(null); if (!selected || !value) return; try { const updated = await trading2Api.addWatchlistAsset(selected.id, value); onSelectedChange(updated); onWatchlistsChange(watchlists.map((list) => list.id === updated.id ? updated : list)); setNewSymbol(''); setSymbol(value.trim().toUpperCase()) } catch (cause) { setMarketError(cause instanceof Trading2Error ? cause.message : String(cause)) } }
  const removeSymbol = async () => { const value = pendingAction?.value; setPendingAction(null); if (!selected || !value) return; try { const updated = await trading2Api.removeWatchlistAsset(selected.id, value); onSelectedChange(updated); onWatchlistsChange(watchlists.map((list) => list.id === updated.id ? updated : list)); if (symbol === value) setSymbol(updated.symbols[0] ?? '') } catch (cause) { setMarketError(cause instanceof Trading2Error ? cause.message : String(cause)) } }
  const createList = async () => { const value = pendingAction?.value; setPendingAction(null); if (!value) return; try { const created = await trading2Api.createWatchlist(value); onWatchlistsChange([...watchlists, created]); onSelectedChange(created); setNewName(''); setSymbol('') } catch (cause) { setMarketError(cause instanceof Trading2Error ? cause.message : String(cause)) } }
  const submitAdd = (event: React.FormEvent) => { event.preventDefault(); if (selected && newSymbol.trim()) setPendingAction({ kind: 'add', value: newSymbol.trim().toUpperCase() }) }
  const submitCreate = (event: React.FormEvent) => { event.preventDefault(); if (newName.trim()) setPendingAction({ kind: 'create', value: newName.trim() }) }
  const latestClose = bars.at(-1)?.close
  const displayQuote: Trading2Quote | null = quote ?? (latestClose === undefined ? null : { last: latestClose, raw: { source: 'lake-bars' } })
  return <><WorkspaceTileGrid workspaceId="trading2-watchlist" tileIds={["watchlists", "chart", "options", "order"]} defaultHeights={[6, 8, 6, 6]}>{[<PanelCard key="watchlists" title="Watchlists" subtitle="Account-defined Alpaca lists" collapsible={false} bodyClassName="p-3"><div className="space-y-3"><div className="flex gap-2"><select className={inputClass} value={selected?.id ?? ''} onChange={(e) => { const next = watchlists.find((list) => list.id === e.target.value); if (next) onSelectedChange(next) }}>{watchlists.map((list) => <option key={list.id} value={list.id}>{list.name} ({list.symbols.length})</option>)}</select><button className={ghostClass} type="button" title="Delete is intentionally not exposed">×</button></div><form className="flex gap-2" onSubmit={submitCreate}><input className={inputClass} placeholder="New watchlist" value={newName} onChange={(e) => setNewName(e.target.value)} /><button className={ghostClass} type="submit" title="Create watchlist"><Plus size={14} /></button></form><form className="flex gap-2" onSubmit={submitAdd}><input className={inputClass} aria-label="Add symbol" placeholder="Add symbol" value={newSymbol} onChange={(e) => setNewSymbol(e.target.value.toUpperCase())} /><button className={primaryClass} type="submit">Add</button></form><div className="space-y-1">{selected?.symbols.map((item) => { const row = rowQuotes[item] ?? (item === symbol ? displayQuote : undefined); const rowLast = row?.last ?? rowLastCloses[item]; return <div key={item} className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 ${symbol === item ? 'border-primary bg-primary/10' : 'border-line'}`}><button type="button" onClick={() => setSymbol(item)} className="min-w-0 flex-1 text-left"><b className="block text-xs">{item}</b><span className="text-[10px] text-muted">Bid {money(row?.bid)} · Last {money(rowLast)} · Ask {money(row?.ask)}</span></button><IntradayPriceBar bar={(rowBars[item] ?? []).at(-1)} last={rowLast} /><button type="button" aria-label={`Remove ${item} from watchlist`} title={`Remove ${item}`} className="rounded p-1 text-muted hover:bg-danger/10 hover:text-danger" onClick={() => setPendingAction({ kind: 'remove', value: item })}><Trash2 size={14} /></button></div> })}</div></div></PanelCard>, <PanelCard key="chart" title={symbol ? `${symbol} · price action` : 'Select a symbol'} subtitle="Candlestick, volume, date range, indicators, and run overlays" collapsible={false} bodyClassName="p-3"><div className="mb-3 flex flex-wrap items-center gap-2"><div className="flex gap-1">{[[30, '1M'], [90, '3M'], [180, '6M'], [365, '1Y']].map(([days, label]) => <button key={String(days)} className={range === days ? primaryClass : ghostClass} type="button" onClick={() => setRange(days as number)}>{label}</button>)}</div><LakeIndicatorPicker selection={selection} includeVolume={includeVolume} updateLake={persistFeatures} onApply={(nextSelection, nextVolume, nextPersist) => { setSelection(nextSelection); setIncludeVolume(nextVolume); setPersistFeatures(nextPersist) }} /><button className={ghostClass} type="button" onClick={() => setRunOpen((open) => !open)}>Run orders <ChevronDown size={13} /></button>{runOpen ? <div className="rounded-md border border-line bg-bg p-2 text-[11px] text-muted">Run-order overlay shell migrated. The current named R&D read contract does not expose a canonical trade blotter for chart markers.</div> : null}</div>{marketError ? <p className="mb-2 text-xs text-danger">{marketError}</p> : null}{featureError ? <p className="mb-2 text-xs text-danger">{featureError}</p> : null}<CandleChart bars={bars} features={features} series={selectionToSeries(selection, includeVolume)} vixBars={vixBars} /></PanelCard>, <PanelCard key="options" title="Option chain" subtitle={`${options.length} contracts from TAC`} collapsible={false} bodyClassName="p-3"><OptionChain options={options} /></PanelCard>, <PanelCard key="order" title={symbol ? `Trade ${symbol}` : 'Quick order'} subtitle="Top-of-book and confirmed order ticket" collapsible={false} bodyClassName="p-3"><QuickOrder symbol={symbol} quote={displayQuote} onOrder={() => {}} /></PanelCard>]}</WorkspaceTileGrid><ConfirmDialog open={Boolean(pendingAction)} title={pendingAction?.kind === 'create' ? 'Confirm watchlist creation' : pendingAction?.kind === 'remove' ? 'Remove symbol' : 'Confirm watchlist update'} message={pendingAction?.kind === 'create' ? `Create the durable Alpaca watchlist “${pendingAction.value}”?` : pendingAction?.kind === 'remove' ? `Remove ${pendingAction.value} from the watchlist “${selected?.name ?? ''}”?` : `Add ${pendingAction?.value ?? ''} to the Alpaca watchlist “${selected?.name ?? ''}”?`} confirmLabel={pendingAction?.kind === 'create' ? 'Create watchlist' : pendingAction?.kind === 'remove' ? 'Remove symbol' : 'Add symbol'} onConfirm={() => void (pendingAction?.kind === 'create' ? createList() : pendingAction?.kind === 'remove' ? removeSymbol() : addSymbol())} onCancel={() => setPendingAction(null)} /></>
}
