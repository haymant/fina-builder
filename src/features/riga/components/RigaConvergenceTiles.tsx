// riga-flow Monte-Carlo convergence tiles (docs/49 P3a) — the real
// `mc_convergence` series: PV / standard error / 95% CI / KI / KO probability vs
// path count. The series is one batched engine call (points are CRN-paired).

import { memo } from 'react'
import { useRigaMcConvergence } from '../hooks'
import { useTheme } from '../../themes/ThemeProvider'
import Chart from '../../shared/components/Chart'
import { chartBase, DataTable, Kpi, num, pct, RigaPanel } from './primitives'
import type { RigaConvergencePoint } from '../types'

type Tokens = ReturnType<typeof useTheme>['tokens']

/** A log-x line chart over the ladder; `extra` adds comparison series. */
function convergenceOption(
  tokens: Tokens,
  points: RigaConvergencePoint[],
  name: string,
  value: (point: RigaConvergencePoint) => number,
  extra: object[] = [],
) {
  const base = chartBase(tokens)
  return {
    ...base,
    xAxis: { ...(base.xAxis as object), type: 'log', logBase: 10, name: 'Paths (log)' },
    yAxis: { ...(base.yAxis as object), name },
    legend: { top: 4, textStyle: { color: tokens.muted, fontSize: 9 } },
    series: [
      {
        name,
        type: 'line',
        symbol: 'circle',
        data: points.map((point) => [point.paths, value(point)]),
        lineStyle: { color: tokens.primary, width: 2 },
        itemStyle: { color: tokens.primary },
      },
      ...extra,
    ],
  }
}

function ChartBody({ option }: { option: object }) {
  return (
    <div className="h-full min-h-0 p-2">
      <Chart option={option} style={{ height: '100%', width: '100%' }} />
    </div>
  )
}

export const RigaPvConvergenceTile = memo(function RigaPvConvergenceTile() {
  const state = useRigaMcConvergence()
  const { tokens } = useTheme()
  return (
    <RigaPanel title="PV Convergence" subtitle="mc_convergence · PV vs path count" tool="mc_convergence" state={state}>
      {(data) => {
        const points = data.points ?? []
        const option = convergenceOption(tokens, points, 'PV estimate', (p) => p.pv, [
          { name: '95% CI', type: 'line', symbol: 'none', data: points.map((p) => [p.paths, p.upper]), lineStyle: { color: tokens.muted, type: 'dashed', width: 1 } },
          { name: '95% CI lower', type: 'line', symbol: 'none', data: points.map((p) => [p.paths, p.lower]), lineStyle: { color: tokens.muted, type: 'dashed', width: 1 } },
        ])
        return <ChartBody option={option} />
      }}
    </RigaPanel>
  )
})

export const RigaCiShrinkageTile = memo(function RigaCiShrinkageTile() {
  const state = useRigaMcConvergence()
  const { tokens } = useTheme()
  return (
    <RigaPanel title="CI Shrinkage" subtitle="mc_convergence · 95% CI width vs path count" tool="mc_convergence" state={state}>
      {(data) => (
        <ChartBody option={convergenceOption(tokens, data.points ?? [], 'CI width', (p) => p.upper - p.lower)} />
      )}
    </RigaPanel>
  )
})

export const RigaErrorVsPathsTile = memo(function RigaErrorVsPathsTile() {
  const state = useRigaMcConvergence()
  const { tokens } = useTheme()
  return (
    <RigaPanel title="Error vs Path Count" subtitle="mc_convergence · SE vs theoretical 1/√N" tool="mc_convergence" state={state}>
      {(data) => {
        const points = data.points ?? []
        const first = points[0]
        const k = first ? first.se * Math.sqrt(first.paths) : 0
        const option = convergenceOption(tokens, points, 'Observed SE', (p) => p.se, [
          { name: 'Theoretical 1/√N', type: 'line', symbol: 'none', data: points.map((p) => [p.paths, k / Math.sqrt(p.paths)]), lineStyle: { color: tokens.warning, type: 'dashed', width: 2 } },
        ])
        return <ChartBody option={option} />
      }}
    </RigaPanel>
  )
})

export const RigaKiConvergenceTile = memo(function RigaKiConvergenceTile() {
  const state = useRigaMcConvergence()
  const { tokens } = useTheme()
  return (
    <RigaPanel title="KI Probability Convergence" subtitle="mc_convergence · KI rate vs path count" tool="mc_convergence" state={state}>
      {(data) => {
        const points = data.points ?? []
        const option = convergenceOption(tokens, points, 'KI probability', (p) => p.ki)
        ;(option.series[0] as { lineStyle: object; itemStyle: object }).lineStyle = { color: tokens.danger, width: 2 }
        ;(option.series[0] as { lineStyle: object; itemStyle: object }).itemStyle = { color: tokens.danger }
        return <ChartBody option={option} />
      }}
    </RigaPanel>
  )
})

export const RigaKoConvergenceTile = memo(function RigaKoConvergenceTile() {
  const state = useRigaMcConvergence()
  const { tokens } = useTheme()
  return (
    <RigaPanel title="KO Probability Convergence" subtitle="mc_convergence · KO rate vs path count" tool="mc_convergence" state={state}>
      {(data) => {
        const points = data.points ?? []
        const option = convergenceOption(tokens, points, 'KO probability', (p) => p.ko)
        ;(option.series[0] as { lineStyle: object; itemStyle: object }).lineStyle = { color: tokens.success, width: 2 }
        ;(option.series[0] as { lineStyle: object; itemStyle: object }).itemStyle = { color: tokens.success }
        return <ChartBody option={option} />
      }}
    </RigaPanel>
  )
})

export const RigaConvergenceHealthTile = memo(function RigaConvergenceHealthTile() {
  const state = useRigaMcConvergence()
  return (
    <RigaPanel title="Convergence Health" subtitle="mc_convergence · final estimator" tool="mc_convergence" state={state}>
      {(data) => {
        const points = data.points ?? []
        const final = data.final ?? points[points.length - 1]
        const relativeSe = final?.relativeSe ?? NaN
        const tone = !Number.isFinite(relativeSe) ? undefined : relativeSe < 0.01 ? 'success' : relativeSe < 0.02 ? 'warning' : 'danger'
        const monotone = points.every((p, i) => i === 0 || p.se <= points[i - 1]!.se + 1e-12)
        return (
          <div className="space-y-3 p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Kpi label="Paths" value={final ? final.paths.toLocaleString() : '—'} />
              <Kpi label="PV" value={num(final?.pv)} tone="primary" />
              <Kpi label="Relative SE" value={pct(relativeSe)} tone={tone} />
              <Kpi label="SE decreasing" value={monotone ? 'yes' : 'no'} tone={monotone ? 'success' : 'warning'} />
            </div>
            <div>
              <p className="eyebrow mb-1">Ladder</p>
              <DataTable
                columns={[
                  { key: 'paths', label: 'Paths', render: (row) => row.paths.toLocaleString() },
                  { key: 'pv', label: 'PV', render: (row) => num(row.pv) },
                  { key: 'se', label: 'SE', render: (row) => num(row.se) },
                  { key: 'relativeSe', label: 'Rel SE', render: (row) => pct(row.relativeSe) },
                  { key: 'ki', label: 'KI', render: (row) => pct(row.ki) },
                  { key: 'ko', label: 'KO', render: (row) => pct(row.ko) },
                ]}
                rows={points}
                empty="No ladder"
              />
            </div>
          </div>
        )
      }}
    </RigaPanel>
  )
})
