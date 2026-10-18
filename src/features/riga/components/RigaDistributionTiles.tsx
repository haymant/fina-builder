// riga-flow distribution tiles (docs/49 P3b) — the real
// `distributions_histogram`: per-metric histograms + percentiles.

import { memo } from 'react'
import { useRigaDistributionsHistogram } from '../hooks'
import { useTheme } from '../../themes/ThemeProvider'
import Chart from '../../shared/components/Chart'
import { chartBase, DataTable, Kpi, num, RigaPanel } from './primitives'
import type { RigaMetricDistribution } from '../types'

function metricOf(metrics: RigaMetricDistribution[] | undefined, name: string) {
  return (metrics ?? []).find((m) => m.metric === name)
}

export const RigaPayoffHistogramTile = memo(function RigaPayoffHistogramTile() {
  const state = useRigaDistributionsHistogram()
  const { tokens } = useTheme()
  return (
    <RigaPanel
      title="Payoff Histogram"
      subtitle="distributions_histogram · PV distribution"
      tool="distributions_histogram"
      state={state}
    >
      {(data) => {
        const pv = metricOf(data.metrics, 'pv')
        const bins = pv?.bins ?? []
        const base = chartBase(tokens)
        const option = {
          ...base,
          xAxis: {
            ...(base.xAxis as object),
            type: 'category',
            data: bins.map((b) => b.lo.toFixed(2)),
            name: 'PV',
            axisLabel: { color: tokens.muted, fontSize: 8, interval: 3 },
          },
          yAxis: { ...(base.yAxis as object), name: 'Paths' },
          series: [{ type: 'bar', data: bins.map((b) => b.count), itemStyle: { color: tokens.primary } }],
        }
        return (
          <div className="flex h-full min-h-0 flex-col">
            <div className="grid shrink-0 grid-cols-2 gap-2 p-3 sm:grid-cols-4">
              <Kpi label="Mean" value={num(pv?.mean)} tone="primary" />
              <Kpi label="Median" value={num(pv?.median)} />
              <Kpi label="P05" value={num(pv?.p05)} tone="danger" />
              <Kpi label="P95" value={num(pv?.p95)} tone="success" />
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

export const RigaDistributionExplorerTile = memo(function RigaDistributionExplorerTile() {
  const state = useRigaDistributionsHistogram()
  return (
    <RigaPanel
      title="Distribution Explorer"
      subtitle="distributions_histogram · metric compare"
      tool="distributions_histogram"
      state={state}
    >
      {(data) => (
        <div className="space-y-2 p-3">
          <DataTable
            columns={[
              { key: 'metric', label: 'Metric' },
              { key: 'mean', label: 'Mean', render: (row) => num(row.mean) },
              { key: 'median', label: 'Median', render: (row) => num(row.median) },
              { key: 'stdDev', label: 'Std dev', render: (row) => num(row.stdDev) },
              { key: 'p05', label: 'P05', render: (row) => num(row.p05) },
              { key: 'p95', label: 'P95', render: (row) => num(row.p95) },
              { key: 'min', label: 'Min', render: (row) => num(row.min) },
              { key: 'max', label: 'Max', render: (row) => num(row.max) },
            ]}
            rows={data.metrics ?? []}
            empty="No metrics"
          />
          <p className="text-[10px] text-muted">
            {data.count.toLocaleString()} paths · {data.binCount} bins per metric
          </p>
        </div>
      )}
    </RigaPanel>
  )
})
