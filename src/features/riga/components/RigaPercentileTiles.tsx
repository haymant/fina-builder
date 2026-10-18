// riga-flow percentile tiles (docs/49 P3g-vi) — the real `percentile_convergence`
// ladder: terminal worst-of P05/P25/P50/P75/P95 across path counts.

import { memo } from 'react'
import { useRigaPercentileConvergence } from '../hooks'
import { useTheme } from '../../themes/ThemeProvider'
import Chart from '../../shared/components/Chart'
import { chartBase, Kpi, num, RigaPanel } from './primitives'


function bandLine(name: string, points: Array<[number, number]>, color: string, width = 2, dashed = false) {
  return {
    name,
    type: 'line',
    symbol: 'none',
    data: points,
    lineStyle: { color, width, type: dashed ? 'dashed' : 'solid' },
    itemStyle: { color },
  }
}

export const RigaPercentileConvergenceTile = memo(function RigaPercentileConvergenceTile() {
  const state = useRigaPercentileConvergence()
  const { tokens } = useTheme()
  return (
    <RigaPanel
      title="Percentile Convergence"
      subtitle="percentile_convergence · P05/P50/P95 vs path count"
      tool="percentile_convergence"
      state={state}
    >
      {(data) => {
        const points = data.points ?? []
        const base = chartBase(tokens)
        const option = {
          ...base,
          xAxis: { ...(base.xAxis as object), type: 'log', logBase: 10, name: 'Paths (log)' },
          yAxis: { ...(base.yAxis as object), name: 'Worst-of' },
          legend: { top: 4, textStyle: { color: tokens.muted, fontSize: 9 } },
          series: [
            bandLine('P95', points.map((p) => [p.paths, p.p95]), tokens.success, 1, true),
            bandLine('P50', points.map((p) => [p.paths, p.p50]), tokens.primary, 3),
            bandLine('P05', points.map((p) => [p.paths, p.p05]), tokens.danger, 1, true),
          ],
        }
        return (
          <div className="flex h-full min-h-0 flex-col">
            <div className="grid shrink-0 grid-cols-2 gap-2 p-3 sm:grid-cols-4">
              <Kpi label="Ladder points" value={points.length} />
              <Kpi label="Final P05" value={num(points.at(-1)?.p05)} tone="danger" />
              <Kpi label="Final P50" value={num(points.at(-1)?.p50)} tone="primary" />
              <Kpi label="Final P95" value={num(points.at(-1)?.p95)} tone="success" />
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

export const RigaDistributionStabilityTile = memo(function RigaDistributionStabilityTile() {
  const state = useRigaPercentileConvergence()
  const { tokens } = useTheme()
  return (
    <RigaPanel
      title="Distribution Stability"
      subtitle="percentile_convergence · P05–P95 bands vs path count"
      tool="percentile_convergence"
      state={state}
    >
      {(data) => {
        const points = data.points ?? []
        const base = chartBase(tokens)
        const option = {
          ...base,
          xAxis: { ...(base.xAxis as object), type: 'log', logBase: 10, name: 'Paths (log)' },
          yAxis: { ...(base.yAxis as object), name: 'Worst-of' },
          legend: { top: 4, textStyle: { color: tokens.muted, fontSize: 9 } },
          series: [
            bandLine('P95', points.map((p) => [p.paths, p.p95]), tokens.success, 1, true),
            bandLine('P75', points.map((p) => [p.paths, p.p75]), tokens.muted, 1),
            bandLine('P50', points.map((p) => [p.paths, p.p50]), tokens.primary, 2),
            bandLine('P25', points.map((p) => [p.paths, p.p25]), tokens.muted, 1),
            bandLine('P05', points.map((p) => [p.paths, p.p05]), tokens.danger, 1, true),
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
