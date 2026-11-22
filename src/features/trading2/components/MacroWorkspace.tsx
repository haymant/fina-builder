import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Chart from '../../shared/components/Chart'
import { PanelCard } from '../../shared/components/PanelCard'
import { WorkspaceTileGrid } from '../../workspace/components/WorkspaceTileGrid'
import { trading2Api, type Trading2FeatureRow, type Trading2LoadJob } from '../../../api/trading2Api'
import { groupMacroCatalog, MACRO_FEATURES, type MacroBar, type MacroCatalogRow, type MacroCoverageRow } from '../macroCatalog'

const button = 'rounded-md border border-line px-3 py-1.5 text-xs text-main hover:border-primary hover:text-primary disabled:opacity-50'
const active = 'rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-xs text-main'
const smallButton = 'shrink-0 rounded-md border border-line px-2 py-1 text-[10px] text-main hover:border-primary hover:text-primary disabled:opacity-50'
const iso = (date: Date) => date.toISOString().slice(0, 10)
const isTerminal = (status?: string) => status === 'completed' || status === 'failed'

function MacroChart({ bars, features, selected, symbol }: { bars: MacroBar[]; features: Trading2FeatureRow[]; selected: string[]; symbol: string }) {
  const times = useMemo(() => Array.from(new Set([...bars.map((b) => b.t), ...features.map((f) => f.timestamp)])).sort(), [bars, features])
  const byBar = useMemo(() => new Map(bars.map((b) => [b.t, b.c])), [bars])
  const byFeature = useMemo(() => new Map(features.map((f) => [f.timestamp, f])), [features])
  const byDate = useMemo(() => new Map(features.map((f) => [f.timestamp.slice(0, 10), f])), [features])
  const series = symbol === 'CBOE_VIX'
    ? [{ name: 'OHLC', type: 'candlestick', data: times.map((t) => { const bar = bars.find((item) => item.t === t); return bar ? [bar.o, bar.c, bar.l, bar.h] : [null, null, null, null] }), itemStyle: { color: '#16a34a', color0: '#dc2626', borderColor: '#16a34a', borderColor0: '#dc2626' } }]
    : [{ name: 'Level', type: 'line', data: times.map((t) => byBar.get(t) ?? null), smooth: false, showSymbol: false, connectNulls: true, lineStyle: { width: 2, color: '#6366f1' }, areaStyle: { color: 'rgba(99,102,241,0.14)' } }, ...selected.map((key, i) => ({ name: key.replace('macro_', '').replaceAll('_', ' '), type: 'line', data: times.map((t) => { const value = (byFeature.get(t) ?? byDate.get(t.slice(0, 10)))?.raw[key]; return typeof value === 'number' && Number.isFinite(value) ? value : null }), showSymbol: false, connectNulls: true, lineStyle: { type: 'dashed', color: ['#22c55e', '#f59e0b', '#ef4444', '#06b6d4'][i % 4] } }))]
  if (!bars.length) return <div className="flex h-72 items-center justify-center rounded-md border border-dashed text-xs text-muted">No loaded macro data for this series. Use “Load all” or the row’s “Load” button to load it into the TAC lake first.</div>
  return <Chart option={{ animation: false, legend: { type: 'scroll' }, tooltip: { trigger: 'axis' }, grid: { left: 52, right: 18, top: 34, bottom: 62 }, xAxis: { type: 'category', data: times.map((t) => t.slice(0, 10)), boundaryGap: symbol === 'CBOE_VIX' }, yAxis: { type: 'value', scale: true }, dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 10, height: 18 }], series }} style={{ width: '100%', height: 380 }} />
}

export function MacroWorkspace() {
  const [catalog, setCatalog] = useState<MacroCatalogRow[]>([])
  const [coverage, setCoverage] = useState<Record<string, MacroCoverageRow>>({})
  const [symbol, setSymbol] = useState<string>()
  const [bars, setBars] = useState<MacroBar[]>([])
  const [features, setFeatures] = useState<Trading2FeatureRow[]>([])
  const [featureKeys, setFeatureKeys] = useState<string[]>(['macro_value_ffill'])
  const [range, setRange] = useState(365)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [loading, setLoading] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const [job, setJob] = useState<Trading2LoadJob | null>(null)
  const bootstrapped = useRef(false)

  const refreshCoverage = useCallback(async () => {
    const cov = await trading2Api.getMacroCoverage()
    setCoverage(Object.fromEntries(cov.map((row) => [row.symbol!.toUpperCase(), row])))
  }, [])

  const startLoad = useCallback(async (symbols?: string[]) => {
    setLoadError('')
    try {
      setJob(await trading2Api.loadMacroSymbols(symbols))
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void Promise.all([trading2Api.getMacroSymbols(), trading2Api.getMacroCoverage()]).then(([rows, cov]) => {
      const nextCatalog = rows.filter((r) => r.enabled !== false).map((r) => ({ symbol: r.symbol, source: r.source ?? 'unknown', source_id: r.sourceId ?? '', title: r.title, frequency: r.frequency, units: r.units, enabled: r.enabled })) as MacroCatalogRow[]
      setCatalog(nextCatalog)
      setCoverage(Object.fromEntries(cov.map((row) => [row.symbol!.toUpperCase(), row])))
      setSymbol((current) => current ?? nextCatalog.find((r) => r.symbol === 'CBOE_VIX')?.symbol ?? nextCatalog[0]?.symbol)
    }).catch((e) => setError(String(e)))
  }, [])

  // Auto-load enabled series that have no coverage once per mount: macro bars
  // never lazy-load like US equities, so a fresh lake shows 0 bars until a load
  // job has run. Symbols that keep failing stay visible with their 0-bar count
  // and can be retried with “Load all”.
  useEffect(() => {
    if (bootstrapped.current || !catalog.length) return
    bootstrapped.current = true
    const missing = catalog.filter((row) => !(coverage[row.symbol]?.num_bars)).map((row) => row.symbol)
    if (missing.length) void startLoad(missing)
  }, [catalog, coverage, startLoad])

  useEffect(() => {
    const jobId = job?.jobId
    if (!jobId) return
    let cancelled = false
    if (!isTerminal(job?.status)) {
      const timer = window.setInterval(() => {
        void trading2Api.getLoadStatus(jobId).then((next) => {
          if (cancelled) return
          setJob(next)
          if (isTerminal(next.status)) window.clearInterval(timer)
        }).catch((cause) => { if (!cancelled) setLoadError(cause instanceof Error ? cause.message : String(cause)) })
      }, 1500)
      return () => { cancelled = true; window.clearInterval(timer) }
    }
    // Terminal: the worker has written coverage/bars, so refresh both and re-read
    // the selected series without requiring a manual page refresh.
    void refreshCoverage().finally(() => { if (!cancelled) setReloadToken((token) => token + 1) })
    return () => { cancelled = true }
  }, [job?.jobId, job?.status, refreshCoverage])

  useEffect(() => {
    if (!symbol) return
    const to = new Date(); const from = new Date(to); from.setUTCDate(from.getUTCDate() - range)
    let cancelled = false
    setLoading(true); setError('')
    void Promise.all([trading2Api.getMacroBars(symbol, iso(from), iso(to)), trading2Api.getMacroFeatures(symbol, iso(from), iso(to))]).then(([nextBars, nextFeatures]) => {
      if (cancelled) return
      setBars(nextBars); setFeatures(nextFeatures)
      // macro_value_ffill / macro_age_days are null for some sources (e.g. CBOE
      // index history); fall back to the first feature the loaded rows actually carry.
      const availableKeys = MACRO_FEATURES.filter((f) => nextFeatures.some((row) => typeof row.raw[f.key] === 'number')).map((f) => f.key)
      setFeatureKeys((keys) => {
        const valid = keys.filter((key) => availableKeys.includes(key))
        return valid.length ? valid : availableKeys.slice(0, 1)
      })
    }).catch((e) => { if (!cancelled) { setBars([]); setFeatures([]); setError(String(e)) } }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [symbol, range, reloadToken])

  const groups = useMemo(() => groupMacroCatalog(catalog), [catalog])
  const current = catalog.find((r) => r.symbol === symbol)
  const available = useMemo(() => MACRO_FEATURES.filter((f) => features.some((row) => typeof row.raw[f.key] === 'number')), [features])
  const busy = Boolean(job && !isTerminal(job.status))
  const progress = job ? `${job.status}${job.totalSymbols ? ` ${job.processed}/${job.totalSymbols}` : ''}` : ''
  return <main className="workspace-canvas relative min-h-0 flex-1 overflow-auto p-4" data-testid="trading2-macro"><div className="mb-5 flex flex-wrap items-start gap-3"><div><p className="eyebrow">Trading 2ⁿd</p><h1 className="text-lg font-semibold text-main">Macro</h1><p className="mt-1 text-xs text-muted">Synthetic macro symbols from the TAC lake; native observation cadence is preserved. Macro bars never lazy-load, so use the loader to persist them before charting.</p></div></div>{error ? <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 p-3 text-xs text-danger" role="alert">{error}</div> : null}{loadError ? <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 p-3 text-xs text-danger" role="alert">{loadError}</div> : null}{job?.error ? <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 p-3 text-xs text-danger" role="alert">{job.error}</div> : null}<WorkspaceTileGrid workspaceId="trading2-macro" tileIds={['catalog', 'chart']} defaultHeights={[8, 8]}>{[<PanelCard key="catalog" title="Macro catalog" subtitle={`${catalog.length} enabled series · ${Object.keys(coverage).length} loaded`} collapsible={false} bodyClassName="p-3"><div className="space-y-4">{groups.map((group) => <section key={group.id}><h2 className="text-xs font-semibold text-main">{group.title}</h2><p className="mb-2 text-[10px] text-muted">{group.description}</p><div className="space-y-1">{group.rows.map((row) => { const rowBars = coverage[row.symbol]?.num_bars ?? 0; return <div key={row.symbol} className={`flex items-center gap-1 rounded-md border px-2 py-1.5 ${row.symbol === symbol ? 'border-primary bg-primary/10' : 'border-line'}`}><button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSymbol(row.symbol)}><b className="block truncate text-xs text-main">{row.symbol}</b><span className="text-[10px] text-muted">{row.title ?? 'Untitled'} · {row.frequency ?? '—'}</span></button><span className="shrink-0 text-[10px] text-muted">{rowBars} bars</span><button type="button" className={smallButton} onClick={() => void startLoad([row.symbol])} disabled={busy}>{busy ? '…' : rowBars ? 'Reload' : 'Load'}</button></div> })}</div></section>)}</div></PanelCard>, <PanelCard key="chart" title={symbol ?? 'Macro series'} subtitle={current ? `${current.source ?? '—'} · ${current.units ?? 'units'} · ${current.frequency ?? '—'}` : 'Select a series'} collapsible={false} bodyClassName="p-3"><div className="mb-3 flex flex-wrap items-center gap-2"><span className="text-xs text-muted">Range</span>{[90, 365, 1825].map((days) => <button key={days} type="button" className={range === days ? active : button} onClick={() => setRange(days)}>{days === 1825 ? '5Y' : `${days}D`}</button>)}<button type="button" className={button} onClick={() => void startLoad()} disabled={busy || !catalog.length}>{busy ? 'Loading…' : 'Load all'}</button>{job ? <span className="text-[10px] text-muted">{progress}</span> : null}{loading ? <span className="text-[10px] text-muted">Loading series…</span> : null}</div>{symbol ? <><div className="mb-3 flex flex-wrap gap-2">{symbol === 'CBOE_VIX' ? null : available.map((feature) => <label key={feature.key} className="flex items-center gap-1 text-[10px] text-muted"><input type="checkbox" checked={featureKeys.includes(feature.key)} onChange={(e) => setFeatureKeys((keys) => e.target.checked ? [...keys, feature.key] : keys.filter((key) => key !== feature.key))} />{feature.label}</label>)}</div><MacroChart bars={bars} features={features} selected={featureKeys} symbol={symbol} /></> : <div className="py-16 text-center text-xs text-muted">Select a macro series from the catalog.</div>}</PanelCard>]}</WorkspaceTileGrid></main>
}
