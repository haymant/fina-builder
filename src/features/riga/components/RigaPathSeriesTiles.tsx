// riga-flow path-series tiles (docs/49 P3g-i) — the real bounded-cube
// `path_series`: selected-path worst-of, population quantile bands, barrier
// crossings and state occupancy over the observation steps.

import { memo } from 'react'
import { useRigaPathSeries, useSelectedPathRecord, useSelectedPathSeries } from '../hooks'
import { useRigaSelectionStore } from '../../../store/rigaSelectionStore'
import { firstStepBelow, nearestFixingStep, splitAtStep, type FixingPoint } from '../data/pathMarkers'
import { useTheme } from '../../themes/ThemeProvider'
import Chart from '../../shared/components/Chart'
import { chartBase, Kpi, num, RigaPanel } from './primitives'

type Tokens = ReturnType<typeof useTheme>['tokens']

function line(name: string, data: Array<[number, number]>, color: string, width = 2, dashed = false) {
  return {
    name,
    type: 'line',
    symbol: 'none',
    data,
    lineStyle: { color, width, type: dashed ? 'dashed' : 'solid' },
    itemStyle: { color },
  }
}

function timeChart(tokens: Tokens, series: object[]) {
  const base = chartBase(tokens)
  return {
    ...base,
    xAxis: { ...(base.xAxis as object), type: 'value', name: 'Years' },
    yAxis: { ...(base.yAxis as object), name: 'Worst-of' },
    legend: { top: 4, textStyle: { color: tokens.muted, fontSize: 9 } },
    series,
  }
}

/** A horizontal reference level (a constant line across the observed years). */
function levelLine(
  name: string,
  level: number | null | undefined,
  years: number[],
  color: string,
  dashed = true,
) {
  if (level === null || level === undefined || years.length === 0) return null
  const first = years[0]!
  const last = years[years.length - 1]!
  return line(name, [[first, level], [last, level]], color, 1, dashed)
}

/** The trade's barrier/strike levels, as reference lines over the path views. */
function referenceLines(data: { barriers?: { knockIn: number; knockOut: number | null; coupon: number | null; strike: number } }, years: number[], tokens: Tokens) {
  const barriers = data.barriers
  if (!barriers) return []
  return [
    levelLine('Strike', barriers.strike, years, tokens.warning, true),
    levelLine('Knock-in', barriers.knockIn, years, tokens.danger, true),
    levelLine('Knock-out', barriers.knockOut, years, tokens.success, true),
    levelLine('Coupon barrier', barriers.coupon, years, tokens.muted, true),
  ].filter((entry): entry is ReturnType<typeof line> => entry !== null)
}

export const RigaPathTimelineTile = memo(function RigaPathTimelineTile() {
  const state = useSelectedPathSeries()
  const record = useSelectedPathRecord()
  const pathId = useRigaSelectionStore((s) => s.selectedPathId)
  const selectedObservation = useRigaSelectionStore((s) => s.selectedObservation)
  const selectObservation = useRigaSelectionStore((s) => s.selectObservation)
  const selectTransition = useRigaSelectionStore((s) => s.selectTransition)
  const selectPlace = useRigaSelectionStore((s) => s.selectPlace)
  const { tokens } = useTheme()
  return (
    <RigaPanel
      title="Path Timeline"
      subtitle="path_series · fixings + KO/KI markers"
      tool="path_series"
      state={state}
    >
      {(data) => {
        const pts = (data.series ?? []) as FixingPoint[]
        const years = pts.map((p) => p.years)
        const path = record.data
        const barriers = data.barriers
        // Engine-reported KO time (years) → nearest fixing. KI timing is not
        // reported, so derive the first breach and label it as derived.
        const koStep = path?.knockedOut ? nearestFixingStep(pts, path.koTime ?? Number.NaN) : null
        const kiStep = path?.kiHit ? firstStepBelow(pts, barriers?.knockIn) : null
        const { before, after } = splitAtStep(pts, koStep)
        const selectedStep =
          selectedObservation !== null && selectedObservation.pathId === pathId && selectedObservation.step < pts.length
            ? selectedObservation.step
            : null
        const selectedPoint = selectedStep !== null ? pts[selectedStep] : undefined
        const refs = referenceLines(data, years, tokens)
        const selectedName = `Selected #${data.selectedPath ?? 0}`
        const series: object[] = [
          {
            ...line(selectedName, before.map((p) => [p.years, p.worstOf]), tokens.primary, 2),
            id: 'fixings',
            // One dot per observation. Long schedules would turn into noise, so
            // only render them when the grid is small enough to read.
            showSymbol: pts.length <= 60,
            symbol: 'circle',
            symbolSize: 5,
          },
          ...(after.length > 1
            ? [{
                ...line('After KO', after.map((p) => [p.years, p.worstOf]), tokens.muted, 1.5, true),
                id: 'after-ko',
                showSymbol: false,
                lineStyle: { color: tokens.muted, width: 1.5, type: 'dashed', opacity: 0.55 },
              }]
            : []),
          ...refs,
          ...(selectedPoint
            ? [{
                id: 'selected-fixing',
                name: 'Step',
                type: 'scatter',
                data: [[selectedPoint.years, selectedPoint.worstOf]],
                symbol: 'circle',
                symbolSize: 12,
                itemStyle: { color: 'transparent', borderColor: tokens.primary, borderWidth: 2 },
                z: 12,
                tooltip: { show: false },
              }]
            : []),
          ...(koStep !== null
            ? [{
                id: 'ko-marker',
                name: 'KO',
                type: 'scatter',
                data: [[pts[koStep]!.years, pts[koStep]!.worstOf]],
                symbol: 'diamond',
                symbolSize: 12,
                itemStyle: { color: tokens.danger },
                z: 11,
                markLine: {
                  silent: true,
                  symbol: 'none',
                  data: [{ xAxis: pts[koStep]!.years }],
                  lineStyle: { color: tokens.danger, type: 'dashed', width: 1 },
                  label: { formatter: 'KO', color: tokens.danger, fontSize: 8, position: 'insideEndTop' },
                },
              }]
            : []),
          ...(kiStep !== null
            ? [{
                id: 'ki-marker',
                name: 'KI (derived)',
                type: 'scatter',
                data: [[pts[kiStep]!.years, pts[kiStep]!.worstOf]],
                symbol: 'triangle',
                symbolSize: 11,
                itemStyle: { color: tokens.warning },
                z: 11,
                markLine: {
                  silent: true,
                  symbol: 'none',
                  data: [{ xAxis: pts[kiStep]!.years }],
                  lineStyle: { color: tokens.warning, type: 'dashed', width: 1 },
                  label: { formatter: 'KI', color: tokens.warning, fontSize: 8, position: 'insideStartTop' },
                },
              }]
            : []),
        ]
        const option = timeChart(tokens, series)
        // Markers are annotation, not legend entries; keep the legend to the
        // data lines and reference levels.
        const legendData = [
          selectedName,
          ...(after.length > 1 ? ['After KO'] : []),
          ...refs.map((reference) => (reference as { name: string }).name),
          ...(koStep !== null ? ['KO'] : []),
          ...(kiStep !== null ? ['KI (derived)'] : []),
        ]
        ;(option as { legend?: object }).legend = { ...(option.legend as object), data: legendData }
        const onEvents = {
          click: (params: { componentType?: string; seriesId?: string; dataIndex?: number }) => {
            if (params.componentType !== 'series') return
            if (params.seriesId === 'fixings' && params.dataIndex !== undefined) {
              selectObservation(pathId, params.dataIndex)
            } else if (params.seriesId === 'ko-marker' && koStep !== null) {
              selectObservation(pathId, koStep)
              // KO is the one engine-backed gate with a live condition/population.
              selectTransition('global_ko_gate')
              selectPlace('ko_period')
            } else if (params.seriesId === 'ki-marker' && kiStep !== null) {
              selectObservation(pathId, kiStep)
              // `down_and_in_put` is the engine-backed put transition (`final_fixing_eki`).
              selectTransition('down_and_in_put')
              selectPlace('put')
            }
          },
        }
        return (
          <div className="flex h-full min-h-0 flex-col">
            <div className="grid shrink-0 grid-cols-2 gap-2 p-3 sm:grid-cols-3">
              <Kpi label="Paths" value={num(data.paths, 0)} />
              <Kpi label="Steps" value={num(data.steps, 0)} />
              <Kpi label="Selected" value={`#${data.selectedPath ?? 0}`} />
            </div>
            <div className="min-h-0 flex-1 p-2">
              <Chart option={option} onEvents={onEvents} style={{ height: '100%', width: '100%' }} />
            </div>
            <div className="shrink-0 border-t border-line px-3 py-1.5 text-[10px]">
              {selectedPoint && selectedStep !== null ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="path-observation">
                  <span className="text-muted">
                    Step <b className="font-mono text-main">{selectedStep + 1}/{pts.length}</b>
                  </span>
                  <span className="text-muted">
                    Year <b className="font-mono text-main">{num(selectedPoint.years, 4)}</b>
                  </span>
                  <span className="text-muted">
                    Worst-of <b className="font-mono text-main">{num(selectedPoint.worstOf)}</b>
                  </span>
                  {barriers ? (
                    <>
                      <span className="text-muted">
                        vs KI{' '}
                        <b className={`font-mono ${selectedPoint.worstOf < barriers.knockIn ? 'text-danger' : 'text-main'}`}>
                          {num(selectedPoint.worstOf - barriers.knockIn)}
                        </b>
                      </span>
                      <span className="text-muted">
                        vs strike <b className="font-mono text-main">{num(selectedPoint.worstOf - barriers.strike)}</b>
                      </span>
                      <span className={selectedPoint.worstOf < barriers.knockIn ? 'text-danger' : 'text-success'}>
                        {selectedPoint.worstOf < barriers.knockIn ? 'below KI' : 'above KI'}
                      </span>
                    </>
                  ) : null}
                </div>
              ) : (
                <p className="text-muted">
                  Click a fixing dot for step detail; ◆ marks the engine-reported KO, ▲ the derived first KI breach.
                </p>
              )}
            </div>
          </div>
        )
      }}
    </RigaPanel>
  )
})

export const RigaQuantileFanTile = memo(function RigaQuantileFanTile() {
  const state = useSelectedPathSeries()
  const { tokens } = useTheme()
  return (
    <RigaPanel title="Quantile Fan" subtitle="path_series · population envelope + selected path" tool="path_series" state={state}>
      {(data) => {
        const bands = data.bands ?? []
        const years = bands.map((b) => b.years)
        const selected = data.series ?? []
        const option = timeChart(tokens, [
          ...(selected.length > 0
            ? [line(`Selected #${data.selectedPath ?? 0}`, selected.map((p) => [p.years, p.worstOf]), tokens.warning, 2)]
            : []),
          line('P95', bands.map((b) => [b.years, b.p95]), tokens.success, 1, true),
          line('P75', bands.map((b) => [b.years, b.p75]), tokens.muted, 1),
          line('P50', bands.map((b) => [b.years, b.p50]), tokens.primary, 2),
          line('P25', bands.map((b) => [b.years, b.p25]), tokens.muted, 1),
          line('P05', bands.map((b) => [b.years, b.p05]), tokens.danger, 1, true),
          ...referenceLines(data, years, tokens),
        ])
        return (
          <div className="h-full min-h-0 p-2">
            <Chart option={option} style={{ height: '100%', width: '100%' }} />
          </div>
        )
      }}
    </RigaPanel>
  )
})

export const RigaWorstOfEvolutionTile = memo(function RigaWorstOfEvolutionTile() {
  const state = useRigaPathSeries()
  const { tokens } = useTheme()
  return (
    <RigaPanel title="Worst-of Evolution" subtitle="path_series · median with P05/P95" tool="path_series" state={state}>
      {(data) => {
        const bands = data.bands ?? []
        const years = bands.map((b) => b.years)
        const option = timeChart(tokens, [
          line('P05', bands.map((b) => [b.years, b.p05]), tokens.danger, 1, true),
          line('P95', bands.map((b) => [b.years, b.p95]), tokens.success, 1, true),
          line('Median (P50)', bands.map((b) => [b.years, b.p50]), tokens.primary, 3),
          ...referenceLines(data, years, tokens),
        ])
        return (
          <div className="h-full min-h-0 p-2">
            <Chart option={option} style={{ height: '100%', width: '100%' }} />
          </div>
        )
      }}
    </RigaPanel>
  )
})

export const RigaBarrierHeatmapTile = memo(function RigaBarrierHeatmapTile() {
  const state = useRigaPathSeries()
  const { tokens } = useTheme()
  return (
    <RigaPanel title="Barrier Crossings" subtitle="path_series · below-KI / above-KO per step" tool="path_series" state={state}>
      {(data) => {
        const crossings = data.crossings ?? []
        const option = timeChart(tokens, [
          line('Below knock-in', crossings.map((c) => [c.years, c.knockIn]), tokens.danger, 2),
          ...(crossings.some((c) => c.knockOut !== null)
            ? [line('Above knock-out', crossings.map((c) => [c.years, c.knockOut ?? 0]), tokens.success, 2)]
            : []),
        ])
        return (
          <div className="h-full min-h-0 p-2">
            <Chart option={option} style={{ height: '100%', width: '100%' }} />
          </div>
        )
      }}
    </RigaPanel>
  )
})

export const RigaStateOccupancyTile = memo(function RigaStateOccupancyTile() {
  const state = useRigaPathSeries()
  const { tokens } = useTheme()
  return (
    <RigaPanel title="State Occupancy" subtitle="path_series · above/below KI + coupon-paid" tool="path_series" state={state}>
      {(data) => {
        const states = data.states ?? []
        const base = chartBase(tokens)
        const option = {
          ...base,
          xAxis: { ...(base.xAxis as object), type: 'value', name: 'Years' },
          yAxis: { ...(base.yAxis as object), name: 'Paths' },
          legend: { top: 4, textStyle: { color: tokens.muted, fontSize: 9 } },
          series: [
            line('Above KI', states.map((s) => [s.years, s.aboveKi]), tokens.success, 1),
            line('Below KI', states.map((s) => [s.years, s.belowKi]), tokens.danger, 1),
            line('Coupon paid', states.map((s) => [s.years, s.couponPaid]), tokens.primary, 1, true),
          ],
        }
        return (
          <div className="h-full min-h-0 p-2">
            <Chart option={option} style={{ height: '100%', width: '100%' }} />
          </div>
        )
      }}
    </RigaPanel>
  )
})
