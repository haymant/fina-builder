// tac-engine market-data tiles (§6.7). Every tile reads `tacMarketStore.raw`
// (the immutable fetch) and shows its source tool + `source`/`calibrated_at`
// in the header, plus a fetch/refresh affordance. Manipulations are applied by
// the pure selector and the effective market feeds the riga-flow request.

import ReactECharts from '../../shared/components/Chart'
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { PanelCard } from '../../shared/components/PanelCard'
import { useTheme } from '../../themes/ThemeProvider'
import { useTacMarketStore } from '../../../store/tacMarketStore'
import { useTacActions, useTacAutoFetch } from '../hooks'
import { tacBaseUrl, tacTransportMode } from '../../../api/tacTransport'
import { chartBase, DataTable, Kpi, num, pct, Provenance } from '../../riga/components/primitives'
import { toIsoDate } from '../../riga/instrument'
import { applyManipulations, volSurfaceWarnings } from '../manipulations'
import type {
  ManipulationOperation,
  ManipulationType,
  MarketManipulation,
  TacCoverageRow,
} from '../types'

// `echarts-gl` (the 3D surface renderer) is ~1 MB, so it is imported lazily the
// first time a 3D view is opened instead of shipping in the main bundle.
let glPromise: Promise<unknown> | null = null
function loadEchartsGl(): Promise<unknown> {
  glPromise ??= import('echarts-gl').catch((error) => {
    glPromise = null
    throw error
  })
  return glPromise
}

function TacTile({
  title,
  subtitle,
  tool,
  provenance,
  isEmpty,
  emptyMessage,
  onRefresh,
  children,
}: {
  title: string
  subtitle: string
  tool: string
  provenance?: string
  isEmpty: boolean
  emptyMessage: string
  onRefresh?: () => void
  children: ReactNode
}) {
  // Every market-data tile kicks the one-shot bootstrap; it is single-flight, so
  // a dashboard full of tiles triggers exactly one fetch on first mount.
  useTacAutoFetch()
  const actions = (
    <div className="flex items-center gap-2">
      {provenance ? <span className="text-[9px] text-muted">{provenance}</span> : null}
      {onRefresh ? (
        <button type="button" className="shock-button" onClick={onRefresh}>
          refresh
        </button>
      ) : null}
    </div>
  )
  if (isEmpty) {
    return (
      <PanelCard title={title} subtitle={subtitle} className="h-full" actions={actions}>
        <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center">
          <div className="rounded border border-line bg-surface px-2 py-1 text-[9px] font-semibold tracking-wide text-muted uppercase">
            market source not configured
          </div>
          <p className="max-w-[22rem] text-xs text-muted">{emptyMessage}</p>
        </div>
      </PanelCard>
    )
  }
  return (
    <PanelCard title={title} subtitle={subtitle} className="h-full" actions={actions} bodyClassName="overflow-auto">
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-auto text-main">{children}</div>
        <Provenance tool={tool} />
      </div>
    </PanelCard>
  )
}

const SYMBOLS = ['ADBE', 'AMZN']

export const TacSymbolPicker = memo(function TacSymbolPicker() {
  const raw = useTacMarketStore((s) => s.raw)
  const coverage = raw.coverage
  const actions = useTacActions()
  return (
    <TacTile
      title="Symbol Picker"
      subtitle="get_lake_symbols · get_lake_coverage"
      tool="get_lake_coverage"
      isEmpty={coverage.length === 0 && Object.keys(raw.snapshots).length === 0}
      emptyMessage="No symbol master or cache coverage loaded. Configure tac-engine (TAC_LAKE_DIR, APCA_API_KEY_ID, APCA_API_SECRET_KEY) and fetch."
      onRefresh={() => void actions.fetchCoverage()}
    >
      <div className="space-y-2 p-3">
        <div className="flex flex-wrap gap-1">
          {SYMBOLS.map((symbol) => (
            <button key={symbol} type="button" className="shock-button" onClick={() => void actions.fetchSnapshot(symbol)}>
              fetch {symbol}
            </button>
          ))}
        </div>
        <DataTable<TacCoverageRow>
          columns={[
            { key: 'symbol', label: 'Symbol' },
            { key: 'timeframe', label: 'TF' },
            { key: 'start', label: 'Start' },
            { key: 'end', label: 'End' },
            { key: 'rows', label: 'Rows' },
          ]}
          rows={coverage}
          empty="No coverage rows"
        />
      </div>
    </TacTile>
  )
})

export const TacBarChart = memo(function TacBarChart() {
  const { tokens } = useTheme()
  const raw = useTacMarketStore((s) => s.raw)
  const actions = useTacActions()
  const [symbol, setSymbol] = useState(SYMBOLS[0]!)
  const barSet = raw.bars[symbol]
  const option = useMemo(() => {
    const bars = barSet?.bars ?? []
    return {
      ...chartBase(tokens),
      xAxis: { type: 'category', data: bars.map((b) => b.t), axisLabel: { color: tokens.muted, fontSize: 8, interval: Math.ceil(bars.length / 8) } },
      yAxis: { type: 'value', scale: true, axisLabel: { color: tokens.muted, fontSize: 9 }, splitLine: { lineStyle: { color: tokens.grid } } },
      series: [
        {
          type: 'candlestick',
          data: bars.map((b) => [b.o, b.c, b.l, b.h]),
          itemStyle: { color: tokens.success, color0: tokens.danger, borderColor: tokens.success, borderColor0: tokens.danger },
        },
      ],
    }
  }, [barSet, tokens])
  return (
    <TacTile
      title="Bar Chart"
      subtitle={`get_lake_bars · ${symbol}`}
      tool="get_lake_bars"
      provenance={barSet ? `source=${barSet.source}` : undefined}
      isEmpty={!barSet || barSet.bars.length === 0}
      emptyMessage="No bars cached. Fetch a window from tac-engine."
      onRefresh={() => void actions.fetchBars(symbol)}
    >
      <div className="flex h-full flex-col">
        <div className="flex gap-1 p-2">
          {SYMBOLS.map((candidate) => (
            <button key={candidate} type="button" className={candidate === symbol ? 'shock-button bg-primary/20' : 'shock-button'} onClick={() => setSymbol(candidate)}>
              {candidate}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1">
          <ReactECharts option={option} style={{ height: '100%', width: '100%' }} notMerge />
        </div>
      </div>
    </TacTile>
  )
})

export const TacTaSpPanes = memo(function TacTaSpPanes() {
  const raw = useTacMarketStore((s) => s.raw)
  const actions = useTacActions()
  const [symbol, setSymbol] = useState(SYMBOLS[0]!)
  const ta = raw.ta[symbol]
  const sp = raw.sp[symbol]
  const series = ta ? Object.entries(ta.indicators) : []
  const spEntries = sp ? Object.entries(sp.features) : []
  return (
    <TacTile
      title="TA / SP Panes"
      subtitle={`get_lake_ta · get_lake_sp · ${symbol}`}
      tool="get_lake_ta"
      isEmpty={series.length === 0 && spEntries.length === 0}
      emptyMessage="No TA/SP features loaded for this symbol."
      onRefresh={() => {
        void actions.fetchTa(symbol)
        void actions.fetchSp(symbol)
      }}
    >
      <div className="space-y-2 p-3">
        <div className="flex gap-1">
          {SYMBOLS.map((candidate) => (
            <button key={candidate} type="button" className={candidate === symbol ? 'shock-button bg-primary/20' : 'shock-button'} onClick={() => setSymbol(candidate)}>
              {candidate}
            </button>
          ))}
        </div>
        <DataTable
          columns={[
            { key: 'name', label: 'Indicator' },
            { key: 'last', label: 'Last', render: (row: { last: number | null }) => num(row.last) },
          ]}
          rows={series.map(([name, values]) => ({ name, last: values[values.length - 1] ?? null }))}
          empty="No TA indicators"
        />
        <DataTable
          columns={[
            { key: 'name', label: 'SP feature' },
            { key: 'value', label: 'Value', render: (row: { value: number }) => num(row.value) },
          ]}
          rows={spEntries.map(([name, value]) => ({ name, value }))}
          empty="No SP features"
        />
      </div>
    </TacTile>
  )
})

export const TacCorrelationMatrix = memo(function TacCorrelationMatrix() {
  const { tokens } = useTheme()
  const raw = useTacMarketStore((s) => s.raw)
  const actions = useTacActions()
  const correlations = raw.correlations
  const option = useMemo(() => {
    if (!correlations) return {}
    const data = correlations.matrix.flatMap((row, r) => row.map((value, c) => [c, r, value]))
    return {
      ...chartBase(tokens),
      grid: { left: 56, right: 18, top: 16, bottom: 42 },
      xAxis: { type: 'category', data: correlations.legs, axisLabel: { color: tokens.muted, fontSize: 9 } },
      yAxis: { type: 'category', data: correlations.legs, axisLabel: { color: tokens.muted, fontSize: 9 } },
      // Diverging ramp: −1 red → 0 neutral → +1 green. The midpoint is the theme's
      // grid tone (near-white in light, near-black in dark) so it adapts.
      visualMap: {
        min: -1, max: 1, orient: 'horizontal', left: 'center', bottom: 0, calculable: false,
        text: ['+1', '−1'], textStyle: { color: tokens.muted, fontSize: 8 },
        inRange: { color: [tokens.danger, tokens.grid, tokens.success] },
      },
      series: [{
        type: 'heatmap',
        data,
        itemStyle: { borderColor: tokens.border, borderWidth: 1 },
        label: { show: true, color: tokens.text, fontSize: 9 },
        emphasis: { itemStyle: { borderColor: tokens.text, borderWidth: 1 } },
      }],
    }
  }, [correlations, tokens])
  return (
    <TacTile
      title="Correlation Matrix"
      subtitle="corr_matrix"
      tool="corr_matrix"
      isEmpty={!correlations}
      emptyMessage="No correlation matrix. Fetch from tac-engine (corr_matrix)."
      onRefresh={() => void actions.fetchCorrelations(SYMBOLS)}
    >
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <ReactECharts option={option} style={{ height: '100%', width: '100%' }} notMerge />
        </div>
        <DataTable<{ legA: string; legB: string; rho0: number; rho: number }>
          columns={[
            { key: 'legA', label: 'Leg A' },
            { key: 'legB', label: 'Leg B' },
            { key: 'rho0', label: 'Raw ρ', render: (row) => num(row.rho0) },
            { key: 'rho', label: 'Resolved ρ', render: (row) => num(row.rho) },
          ]}
          rows={correlations?.pairs ?? []}
          empty="No pairs"
        />
      </div>
    </TacTile>
  )
})

export const TacVolSurface = memo(function TacVolSurface() {
  const { tokens } = useTheme()
  const raw = useTacMarketStore((s) => s.raw)
  const actions = useTacActions()
  const [underlying, setUnderlying] = useState(SYMBOLS[0]!)
  const [view, setView] = useState<'heat' | '3d'>('heat')
  const [glReady, setGlReady] = useState(false)
  const [glError, setGlError] = useState<string | null>(null)
  const surface = raw.volSurfaces[underlying]
  const warnings = surface ? volSurfaceWarnings(surface) : []

  // Lazily pull in echarts-gl the first time 3D is opened.
  useEffect(() => {
    if (view !== '3d' || glReady) return
    let cancelled = false
    loadEchartsGl()
      .then(() => { if (!cancelled) setGlReady(true) })
      .catch((error: unknown) => { if (!cancelled) setGlError(error instanceof Error ? error.message : String(error)) })
    return () => { cancelled = true }
  }, [view, glReady])

  const use3d = view === '3d' && glReady
  const option = useMemo(() => {
    if (!surface) return {}
    const min = Math.min(...surface.volatility.flat()) * 100
    const max = Math.max(...surface.volatility.flat()) * 100
    // Sequential ramp: calm (green) → elevated (amber) → stressed (red).
    const ramp = [tokens.success, tokens.warning, tokens.danger]
    if (use3d) {
      const data = surface.maturities.flatMap((maturity, r) =>
        surface.strikes.map((strike, c) => [strike, maturity, +((surface.volatility[r]?.[c] ?? 0) * 100).toFixed(2)]),
      )
      const axis = {
        type: 'value' as const,
        nameTextStyle: { color: tokens.muted, fontSize: 9 },
        axisLabel: { color: tokens.muted, fontSize: 8 },
        axisLine: { lineStyle: { color: tokens.border } },
        splitLine: { lineStyle: { color: tokens.grid } },
      }
      return {
        backgroundColor: 'transparent',
        tooltip: { confine: true, backgroundColor: tokens.panel, borderColor: tokens.border, textStyle: { color: tokens.text, fontSize: 11 } },
        visualMap: { min, max, dimension: 2, calculable: false, left: 0, bottom: 0, textStyle: { color: tokens.muted, fontSize: 8 }, inRange: { color: ramp } },
        xAxis3D: { ...axis, name: 'strike' },
        yAxis3D: { ...axis, name: 'maturity' },
        zAxis3D: { ...axis, name: 'vol %' },
        grid3D: {
          boxWidth: 100, boxDepth: 80, boxHeight: 60,
          viewControl: { distance: 190, alpha: 22, beta: 35 },
          axisPointer: { show: false },
          light: { main: { intensity: 1.1, shadow: false }, ambient: { intensity: 0.45 } },
        },
        series: [{ type: 'surface', data, shading: 'color', wireframe: { show: true, lineStyle: { color: tokens.border, width: 0.4 } } }],
      }
    }
    const data = surface.volatility.flatMap((row, r) => row.map((value, c) => [c, r, +(value * 100).toFixed(2)]))
    return {
      ...chartBase(tokens),
      grid: { left: 56, right: 18, top: 16, bottom: 42 },
      xAxis: { type: 'category', data: surface.strikes.map((s) => String(s)), axisLabel: { color: tokens.muted, fontSize: 8, interval: Math.ceil(surface.strikes.length / 8) } },
      yAxis: { type: 'category', data: surface.maturities.map((m) => String(m)), axisLabel: { color: tokens.muted, fontSize: 8 } },
      visualMap: { min, max, orient: 'horizontal', left: 'center', bottom: 0, calculable: false, textStyle: { color: tokens.muted, fontSize: 8 }, inRange: { color: ramp } },
      series: [{ type: 'heatmap', data, itemStyle: { borderColor: tokens.border, borderWidth: 1 }, label: { show: false } }],
    }
  }, [surface, tokens, use3d])

  return (
    <TacTile
      title="Vol Surface"
      subtitle={`vol_surface · ${underlying}`}
      tool="vol_surface"
      provenance={surface ? `model=${surface.model ?? '—'} · source=${surface.source ?? '—'} · ${surface.calibratedAt ?? ''}` : undefined}
      isEmpty={!surface}
      emptyMessage="No calibrated vol surface. Fetch from tac-engine (vol_surface)."
      onRefresh={() => void actions.fetchVolSurface(underlying)}
    >
      <div className="flex h-full flex-col">
        <div className="flex flex-wrap items-center gap-1 p-2">
          {SYMBOLS.map((candidate) => (
            <button key={candidate} type="button" className={candidate === underlying ? 'shock-button bg-primary/20' : 'shock-button'} onClick={() => setUnderlying(candidate)}>
              {candidate}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-line" />
          {(['heat', '3d'] as const).map((mode) => (
            <button key={mode} type="button" className={mode === view ? 'shock-button bg-primary/20' : 'shock-button'} onClick={() => setView(mode)}>
              {mode === 'heat' ? '2D' : '3D'}
            </button>
          ))}
        </div>
        {view === '3d' && glError ? <p className="px-2 text-[10px] text-danger">3D renderer unavailable: {glError}</p> : null}
        {view === '3d' && !glReady && !glError ? <p className="px-2 text-[10px] text-muted">loading 3D renderer…</p> : null}
        {warnings.length ? <p className="px-2 text-[10px] text-warning">{warnings[0]}</p> : null}
        <div className="min-h-0 flex-1">
          <ReactECharts key={view} option={option} style={{ height: '100%', width: '100%' }} notMerge />
        </div>
        <div className="px-3 pb-2 text-[10px] text-muted">
          reference={num(surface?.reference, 2)} · {surface?.strikes.length ?? 0} strikes × {surface?.maturities.length ?? 0} maturities
        </div>
      </div>
    </TacTile>
  )
})

export const TacYieldCurve = memo(function TacYieldCurve() {
  const { tokens } = useTheme()
  const raw = useTacMarketStore((s) => s.raw)
  const actions = useTacActions()
  const curve = raw.curve
  const option = useMemo(() => {
    const pillars = curve?.pillars ?? []
    return {
      ...chartBase(tokens),
      xAxis: { type: 'category', data: pillars.map((p) => p.tenor ?? toIsoDate(p.date) ?? String(p.date)), axisLabel: { color: tokens.muted, fontSize: 8 } },
      yAxis: { type: 'value', scale: true, axisLabel: { color: tokens.muted, fontSize: 9, formatter: (v: number) => `${(v * 100).toFixed(1)}%` }, splitLine: { lineStyle: { color: tokens.grid } } },
      series: [{ type: 'line', data: pillars.map((p) => p.rate), smooth: true, symbolSize: 5, lineStyle: { color: tokens.primary, width: 2 } }],
    }
  }, [curve, tokens])
  return (
    <TacTile
      title="Yield Curve"
      subtitle="get_macro_bars (FRED DGS* → pillars)"
      tool="get_macro_bars"
      isEmpty={!curve}
      emptyMessage="No rate curve. Build it from FRED tenors via get_macro_bars (T-EXT-1)."
      onRefresh={() => void actions.fetchCurve()}
    >
      <div className="flex h-full flex-col">
        <div className="min-h-0 flex-1">
          <ReactECharts option={option} style={{ height: '100%', width: '100%' }} notMerge />
        </div>
        <DataTable
          columns={[
            { key: 'tenor', label: 'Tenor', render: (row) => row.tenor ?? String(row.date) },
            { key: 'rate', label: 'Rate', render: (row) => pct(row.rate, 3) },
          ]}
          rows={curve?.pillars ?? []}
          empty="No pillars"
        />
      </div>
    </TacTile>
  )
})

export const TacFxSpot = memo(function TacFxSpot() {
  const raw = useTacMarketStore((s) => s.raw)
  const actions = useTacActions()
  const entries = Object.values(raw.fx)
  return (
    <TacTile
      title="FX Spot"
      subtitle="get_forex_latest_rates · not sent to riga-flow"
      tool="get_forex_latest_rates"
      isEmpty={entries.length === 0}
      emptyMessage="No FX rates. Fetch from tac-engine."
      onRefresh={() => void actions.fetchFx(['EURUSD', 'USDJPY'])}
    >
      <div className="space-y-2 p-3">
        <div className="flex gap-1">
          <button type="button" className="shock-button" onClick={() => void actions.fetchFx(['EURUSD', 'USDJPY'])}>
            fetch majors
          </button>
        </div>
        <DataTable
          columns={[
            { key: 'pair', label: 'Pair' },
            { key: 'rate', label: 'Rate', render: (row) => num(row.rate, 4) },
            { key: 'asOf', label: 'As of' },
          ]}
          rows={entries}
          empty="No FX"
        />
        <p className="text-[10px] text-warning">not sent to riga-flow (R-EXT-1)</p>
      </div>
    </TacTile>
  )
})

export const TacFxVol = memo(function TacFxVol() {
  const raw = useTacMarketStore((s) => s.raw)
  const actions = useTacActions()
  const entries = Object.entries(raw.fxVol)
  const rows = entries.flatMap(([pair, list]) => list.map((row) => ({ ...row, pair })))
  return (
    <TacTile
      title="FX Vol (realized)"
      subtitle="get_lake_fx_vol · not sent to riga-flow"
      tool="get_lake_fx_vol"
      isEmpty={rows.length === 0}
      emptyMessage="No realized FX vol. Fetch from tac-engine (implied fx_vol_surface is T-EXT-2)."
      onRefresh={() => {
        void actions.fetchFxVol('EURUSD')
        void actions.fetchFxVol('USDJPY')
      }}
    >
      <div className="space-y-2 p-3">
        <DataTable
          columns={[
            { key: 'pair', label: 'Pair' },
            { key: 'windowDays', label: 'Window', render: (row) => `${row.windowDays}d` },
            { key: 'realizedVol', label: 'Realized vol', render: (row) => pct(row.realizedVol) },
          ]}
          rows={rows}
          empty="No FX vol rows"
        />
        <p className="text-[10px] text-warning">not sent to riga-flow (R-EXT-1)</p>
      </div>
    </TacTile>
  )
})

export const TacCorporateActions = memo(function TacCorporateActions() {
  const raw = useTacMarketStore((s) => s.raw)
  const actions = useTacActions()
  return (
    <TacTile
      title="Corporate Actions"
      subtitle="get_corporate_actions (dividends)"
      tool="get_corporate_actions"
      isEmpty={raw.corporateActions.length === 0}
      emptyMessage="No corporate actions. Fetch dividends from tac-engine."
      onRefresh={() => {
        void actions.fetchCorporateActions('ADBE')
        void actions.fetchCorporateActions('AMZN')
      }}
    >
      <div className="space-y-2 p-3">
        <DataTable
          columns={[
            { key: 'symbol', label: 'Symbol' },
            { key: 'type', label: 'Type' },
            { key: 'exDate', label: 'Ex date' },
            { key: 'amount', label: 'Amount', render: (row) => num(row.amount, 4) },
          ]}
          rows={raw.corporateActions}
          empty="No actions"
        />
        <p className="text-[10px] text-muted">dividends feed underlyings[].dividends → dividendYields[]</p>
      </div>
    </TacTile>
  )
})

export const TacLakeCoverage = memo(function TacLakeCoverage() {
  const raw = useTacMarketStore((s) => s.raw)
  const status = useTacMarketStore((s) => s.status)
  const actions = useTacActions()
  return (
    <TacTile
      title="Lake Coverage"
      subtitle="get_lake_coverage · validate_lake_dataset"
      tool="get_lake_coverage"
      provenance={`status=${status}`}
      isEmpty={raw.coverage.length === 0}
      emptyMessage="No lake coverage. Fetch from tac-engine."
      onRefresh={() => void actions.fetchCoverage()}
    >
      <div className="space-y-2 p-3">
        <div className="flex flex-wrap gap-2">
          <Kpi label="Symbols" value={new Set(raw.coverage.map((c) => c.symbol)).size} />
          <Kpi label="Windows" value={raw.coverage.length} tone="primary" />
        </div>
        <DataTable<TacCoverageRow>
          columns={[
            { key: 'symbol', label: 'Symbol' },
            { key: 'timeframe', label: 'TF' },
            { key: 'start', label: 'Start' },
            { key: 'end', label: 'End' },
            { key: 'rows', label: 'Rows' },
          ]}
          rows={raw.coverage}
          empty="No coverage"
        />
      </div>
    </TacTile>
  )
})

export const TacManipulationEditor = memo(function TacManipulationEditor() {
  const manipulations = useTacMarketStore((s) => s.manipulations)
  const addManipulation = useTacMarketStore((s) => s.addManipulation)
  const updateManipulation = useTacMarketStore((s) => s.updateManipulation)
  const removeManipulation = useTacMarketStore((s) => s.removeManipulation)
  const clearManipulations = useTacMarketStore((s) => s.clearManipulations)
  const raw = useTacMarketStore((s) => s.raw)
  const [form, setForm] = useState<MarketManipulation>({ type: 'spot', operation: 'relative', value: 0.01, target: '*' })
  useTacAutoFetch()

  return (
    <PanelCard title="Manipulation Editor" subtitle="in-memory overlays → effective market" className="h-full" bodyClassName="overflow-auto">
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-[10px] text-muted">
            Type
            <select className="control-select mt-0.5 w-full" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as ManipulationType })}>
              {(['spot', 'volatility', 'correlation', 'interest_rate', 'dividend', 'fx_spot', 'fx_volatility'] as ManipulationType[]).map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[10px] text-muted">
            Operation
            <select className="control-select mt-0.5 w-full" value={form.operation} onChange={(e) => setForm({ ...form, operation: e.target.value as ManipulationOperation })}>
              {(['absolute', 'relative', 'set', 'parallel'] as ManipulationOperation[]).map((operation) => (
                <option key={operation} value={operation}>
                  {operation}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-[10px] text-muted">
            Value
            <input className="economics-number-input mt-0.5 w-full" type="number" step="any" value={form.value} onChange={(e) => setForm({ ...form, value: Number(e.target.value) })} />
          </label>
          <label className="block text-[10px] text-muted">
            Target
            <input className="economics-number-input mt-0.5 w-full" value={form.target ?? '*'} onChange={(e) => setForm({ ...form, target: e.target.value })} />
          </label>
          {form.type === 'volatility' ? (
            <label className="block text-[10px] text-muted">
              Surface parameter
              <select className="control-select mt-0.5 w-full" value={form.surfaceParameter ?? 'atm'} onChange={(e) => setForm({ ...form, surfaceParameter: e.target.value as MarketManipulation['surfaceParameter'] })}>
                {(['atm', 'skew', 'curvature', 'term'] as const).map((parameter) => (
                  <option key={parameter} value={parameter}>
                    {parameter}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <div className="flex gap-2">
          <button type="button" className="shock-button" onClick={() => addManipulation(form)}>
            add manipulation
          </button>
          <button type="button" className="shock-button" onClick={clearManipulations}>
            clear
          </button>
        </div>
        <DataTable<MarketManipulation>
          columns={[
            { key: 'type', label: 'Type' },
            { key: 'operation', label: 'Op' },
            { key: 'value', label: 'Value', render: (row) => String(row.value) },
            { key: 'target', label: 'Target', render: (row) => row.target ?? '*' },
            {
              key: 'remove',
              label: '',
              render: (_row, index) => (
                <button type="button" className="shock-button" onClick={() => removeManipulation(index)}>
                  remove
                </button>
              ),
            },
          ]}
          rows={manipulations}
          empty="No manipulations"
          onRowClick={(row) => updateManipulation(manipulations.indexOf(row), row)}
        />
        <div>
          <p className="eyebrow mb-1">Effective market (JSON preview)</p>
          <textarea
            readOnly
            className="h-32 w-full rounded border border-line bg-bg p-2 font-mono text-[10px] text-main"
            value={JSON.stringify(applyManipulations(raw, manipulations), null, 2)}
          />
        </div>
        <p className="text-[10px] text-muted">
          Overlays are in-memory only: the lake is never written and no mutating tac-engine tool is called.
        </p>
      </div>
    </PanelCard>
  )
})

export const TacMarketDataPanel = memo(function TacMarketDataPanel() {
  const raw = useTacMarketStore((s) => s.raw)
  const status = useTacMarketStore((s) => s.status)
  const error = useTacMarketStore((s) => s.error)
  const actions = useTacActions()
  const mode = tacTransportMode()
  const isEmpty = Object.keys(raw.snapshots).length === 0 && Object.keys(raw.bars).length === 0
  return (
    <TacTile
      title="Market Data Workbench"
      subtitle="fetch · manipulate · map into riga-flow"
      tool="get_lake_bars / corr_matrix / vol_surface"
      provenance={`status=${status}`}
      isEmpty={isEmpty && status !== 'error'}
      emptyMessage="tac-engine is not configured or unreachable. Set TAC_LAKE_DIR, APCA_API_KEY_ID and APCA_API_SECRET_KEY, then fetch. Market-data tiles never fall back to fake data."
      onRefresh={() => void actions.fetchAll(SYMBOLS)}
    >
      <div className="space-y-3 p-3">
        <div className="rounded border border-line bg-surface px-2 py-1 text-[10px] text-muted">
          transport:{' '}
          <span className="font-mono text-main">
            {mode === 'tauri' ? 'desktop stdio (Rust sidecar)' : `HTTP bridge · ${tacBaseUrl()}`}
          </span>
          {mode === 'http' ? (
            <>
              {' '}
              — start it with <span className="font-mono">npm run mcp:http:tac</span> (tac-engine is stdio-only).
            </>
          ) : null}
          <br />
          env (host or <span className="font-mono">.env</span>):{' '}
          <span className="font-mono">TAC_LAKE_DIR · APCA_API_KEY_ID · APCA_API_SECRET_KEY · FRED_API_KEY</span>
        </div>
        {status === 'error' && error ? (
          <p className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[10px] text-danger">{error}</p>
        ) : null}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Kpi label="Snapshots" value={Object.keys(raw.snapshots).length} />
          <Kpi label="Bar series" value={Object.keys(raw.bars).length} />
          <Kpi label="Vol surfaces" value={Object.keys(raw.volSurfaces).length} tone="primary" />
          <Kpi label="FX pairs" value={Object.keys(raw.fx).length} />
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="add-tile-button" onClick={() => void actions.fetchAll(SYMBOLS)}>
            fetch all
          </button>
          <button type="button" className="shock-button" onClick={() => void actions.fetchSnapshot('ADBE')}>
            snapshot ADBE
          </button>
          <button type="button" className="shock-button" onClick={() => void actions.fetchVolSurface('AMZN')}>
            vol surface AMZN
          </button>
        </div>
        <p className="text-[10px] text-muted">
          Fetch writes the raw lake view; manipulations are applied by a pure selector and mapped onto the
          riga-flow request (RigaMarketData).
        </p>
      </div>
    </TacTile>
  )
})
