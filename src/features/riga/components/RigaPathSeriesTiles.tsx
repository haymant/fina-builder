// riga-flow path-series tiles (docs/49 P3g-i) — the real bounded-cube
// `path_series`: selected-path worst-of, population quantile bands, barrier
// crossings and state occupancy over the observation steps.

import { memo } from 'react'
import { useRigaPathSeries } from '../hooks'
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

export const RigaPathTimelineTile = memo(function RigaPathTimelineTile() {
  const state = useRigaPathSeries()
  const { tokens } = useTheme()
  return (
    <RigaPanel title="Path Timeline" subtitle="path_series · selected path worst-of" tool="path_series" state={state}>
      {(data) => {
        const pts = data.series ?? []
        const option = timeChart(tokens, [
          line('Selected path', pts.map((p) => [p.years, p.worstOf]), tokens.primary, 2),
          ...(data.barriers
            ? [line('Knock-in', pts.map((p) => [p.years, data.barriers!.knockIn]), tokens.danger, 1, true)]
            : []),
          ...(data.barriers?.knockOut
            ? [line('Knock-out', pts.map((p) => [p.years, data.barriers!.knockOut!]), tokens.success, 1, true)]
            : []),
        ])
        return (
          <div className="flex h-full min-h-0 flex-col">
            <div className="grid shrink-0 grid-cols-2 gap-2 p-3 sm:grid-cols-3">
              <Kpi label="Paths" value={num(data.paths, 0)} />
              <Kpi label="Steps" value={num(data.steps, 0)} />
              <Kpi label="Selected" value={`#${data.selectedPath ?? 0}`} />
            </div>
            <div className="min-h-0 flex-1 p-2">
              <Chart option={option} style={{ height: '100%', width: '100%' }} />
            </div>
          </div>
        )
      }}
    </RigaPanel>
  )
})

export const RigaQuantileFanTile = memo(function RigaQuantileFanTile() {
  const state = useRigaPathSeries()
  const { tokens } = useTheme()
  return (
    <RigaPanel title="Quantile Fan" subtitle="path_series · population envelope" tool="path_series" state={state}>
      {(data) => {
        const bands = data.bands ?? []
        const option = timeChart(tokens, [
          line('P95', bands.map((b) => [b.years, b.p95]), tokens.success, 1, true),
          line('P75', bands.map((b) => [b.years, b.p75]), tokens.muted, 1),
          line('P50', bands.map((b) => [b.years, b.p50]), tokens.primary, 2),
          line('P25', bands.map((b) => [b.years, b.p25]), tokens.muted, 1),
          line('P05', bands.map((b) => [b.years, b.p05]), tokens.danger, 1, true),
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
        const option = timeChart(tokens, [
          line('P05', bands.map((b) => [b.years, b.p05]), tokens.danger, 1, true),
          line('P95', bands.map((b) => [b.years, b.p95]), tokens.success, 1, true),
          line('Median (P50)', bands.map((b) => [b.years, b.p50]), tokens.primary, 3),
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
