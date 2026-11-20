import { useEffect, useMemo, useState } from 'react'
import Chart from '../../shared/components/Chart'
import { PanelCard } from '../../shared/components/PanelCard'
import { WorkspaceTileGrid } from '../../workspace/components/WorkspaceTileGrid'
import { trading2Api, type Trading2FeatureRow } from '../../../api/trading2Api'
import { groupMacroCatalog, MACRO_FEATURES, type MacroBar, type MacroCatalogRow, type MacroCoverageRow } from '../macroCatalog'

const button = 'rounded-md border border-line px-3 py-1.5 text-xs text-main hover:border-primary hover:text-primary disabled:opacity-50'
const active = 'rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-xs text-main'
const iso = (date: Date) => date.toISOString().slice(0, 10)

function MacroChart({ bars, features, selected }: { bars: MacroBar[]; features: Trading2FeatureRow[]; selected: string[] }) {
  const times = useMemo(() => Array.from(new Set([...bars.map((b) => b.t), ...features.map((f) => f.timestamp)])).sort(), [bars, features])
  const byBar = useMemo(() => new Map(bars.map((b) => [b.t, b.c])), [bars])
  const byFeature = useMemo(() => new Map(features.map((f) => [f.timestamp, f])), [features])
  const series = [{ name: 'Level', type: 'line', data: times.map((t) => byBar.get(t) ?? null), smooth: false, showSymbol: false, connectNulls: true, lineStyle: { width: 2, color: '#6366f1' }, areaStyle: { color: 'rgba(99,102,241,0.14)' } }, ...selected.map((key, i) => ({ name: key.replace('macro_', '').replaceAll('_', ' '), type: 'line', data: times.map((t) => { const value = byFeature.get(t)?.raw[key]; return typeof value === 'number' ? value : null }), showSymbol: false, connectNulls: true, lineStyle: { type: 'dashed', color: ['#22c55e', '#f59e0b', '#ef4444', '#06b6d4'][i % 4] } }))]
  if (!bars.length) return <div className="flex h-72 items-center justify-center rounded-md border border-dashed text-xs text-muted">No loaded macro data for this series. Load it through the TAC macro loader first.</div>
  return <Chart option={{ animation: false, legend: { type: 'scroll' }, tooltip: { trigger: 'axis' }, grid: { left: 52, right: 18, top: 34, bottom: 62 }, xAxis: { type: 'category', data: times.map((t) => t.slice(0, 10)), boundaryGap: false }, yAxis: { type: 'value', scale: true }, dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 10, height: 18 }], series }} style={{ width: '100%', height: 380 }} />
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
  const [loading, setLoading] = useState(false)

  useEffect(() => { void Promise.all([trading2Api.getMacroSymbols(), trading2Api.getMacroCoverage()]).then(([rows, cov]) => { setCatalog(rows.filter((r) => r.enabled !== false).map((r) => ({ symbol: r.symbol, source: r.source ?? 'unknown', source_id: r.sourceId ?? '', title: r.title, frequency: r.frequency, units: r.units, enabled: r.enabled })) as MacroCatalogRow[]); setCoverage(Object.fromEntries(cov.map((r) => [r.symbol!.toUpperCase(), r]))); setSymbol(rows.find((r) => r.symbol === 'CBOE_VIX')?.symbol ?? rows[0]?.symbol) }).catch((e) => setError(String(e))) }, [])
  useEffect(() => { if (!symbol) return; const to = new Date(); const from = new Date(to); from.setUTCDate(from.getUTCDate() - range); setLoading(true); setError(''); void Promise.all([trading2Api.getMacroBars(symbol, iso(from), iso(to)), trading2Api.getMacroFeatures(symbol, iso(from), iso(to))]).then(([nextBars, nextFeatures]) => { setBars(nextBars); setFeatures(nextFeatures) }).catch((e) => { setBars([]); setFeatures([]); setError(String(e)) }).finally(() => setLoading(false)) }, [symbol, range])
  const groups = useMemo(() => groupMacroCatalog(catalog), [catalog])
  const current = catalog.find((r) => r.symbol === symbol)
  const available = useMemo(() => MACRO_FEATURES.filter((f) => features.some((row) => typeof row.raw[f.key] === 'number')), [features])
  return <main className="workspace-canvas relative min-h-0 flex-1 overflow-auto p-4" data-testid="trading2-macro"><div className="mb-5 flex flex-wrap items-start gap-3"><div><p className="eyebrow">Trading 2ⁿd</p><h1 className="text-lg font-semibold text-main">Macro</h1><p className="mt-1 text-xs text-muted">Synthetic macro symbols from the TAC lake; native observation cadence is preserved and unloaded data is shown honestly.</p></div></div>{error ? <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 p-3 text-xs text-danger" role="alert">{error}</div> : null}<WorkspaceTileGrid workspaceId="trading2-macro" tileIds={['catalog', 'chart']} defaultHeights={[8, 8]}>{[<PanelCard key="catalog" title="Macro catalog" subtitle={`${catalog.length} enabled series`} collapsible={false} bodyClassName="p-3"><div className="space-y-4">{groups.map((group) => <section key={group.id}><h2 className="text-xs font-semibold text-main">{group.title}</h2><p className="mb-2 text-[10px] text-muted">{group.description}</p><div className="space-y-1">{group.rows.map((row) => <button key={row.symbol} type="button" className={`flex w-full items-center justify-between rounded-md border px-2 py-2 text-left ${row.symbol === symbol ? 'border-primary bg-primary/10' : 'border-line hover:border-primary/50'}`} onClick={() => setSymbol(row.symbol)}><span className="min-w-0"><b className="block truncate text-xs text-main">{row.symbol}</b><span className="text-[10px] text-muted">{row.title ?? 'Untitled'} · {row.frequency ?? '—'}</span></span><span className="ml-2 shrink-0 text-[10px] text-muted">{coverage[row.symbol]?.num_bars ?? 0} bars</span></button>)}</div></section>)}</div></PanelCard>, <PanelCard key="chart" title={symbol ?? 'Macro series'} subtitle={current ? `${current.source ?? '—'} · ${current.units ?? 'units'} · ${current.frequency ?? '—'}` : 'Select a series'} collapsible={false} bodyClassName="p-3"><div className="mb-3 flex flex-wrap items-center gap-2"><span className="text-xs text-muted">Range</span>{[90, 365, 1825].map((days) => <button key={days} type="button" className={range === days ? active : button} onClick={() => setRange(days)}>{days === 1825 ? '5Y' : `${days}D`}</button>)}{loading ? <span className="text-[10px] text-muted">Loading…</span> : null}</div>{symbol ? <><div className="mb-3 flex flex-wrap gap-2">{available.map((feature) => <label key={feature.key} className="flex items-center gap-1 text-[10px] text-muted"><input type="checkbox" checked={featureKeys.includes(feature.key)} onChange={(e) => setFeatureKeys((keys) => e.target.checked ? [...keys, feature.key] : keys.filter((key) => key !== feature.key))} />{feature.label}</label>)}</div><MacroChart bars={bars} features={features} selected={featureKeys} /></> : <div className="py-16 text-center text-xs text-muted">Select a macro series from the catalog.</div>}</PanelCard>]}</WorkspaceTileGrid></main>
}
