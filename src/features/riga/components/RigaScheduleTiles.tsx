// riga-flow observation/schedule tiles (docs/49 P3g-iii) — frontend-only, from
// the real `path_series` (per-step barrier hits + state counts + barrier levels).

import { memo } from 'react'
import { useRigaPathSeries } from '../hooks'
import { useTheme } from '../../themes/ThemeProvider'
import Chart from '../../shared/components/Chart'
import { chartBase, DataTable, Kpi, num, RigaPanel } from './primitives'

export const RigaObservationScheduleTile = memo(function RigaObservationScheduleTile() {
  const state = useRigaPathSeries()
  return (
    <RigaPanel
      title="Observation Schedule"
      subtitle="path_series · steps + barrier hits"
      tool="path_series"
      state={state}
    >
      {(data) => {
        const states = data.states ?? []
        const rows = (data.crossings ?? []).map((crossing) => {
          const snapshot = states.find((entry) => entry.time === crossing.time)
          return {
            step: crossing.time + 1,
            years: crossing.years,
            belowKi: snapshot?.belowKi ?? 0,
            knockOut: crossing.knockOut ?? 0,
            couponPaid: snapshot?.couponPaid ?? 0,
          }
        })
        return (
          <div className="space-y-3 p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Kpi label="Steps" value={num(data.steps, 0)} />
              <Kpi label="Paths" value={num(data.paths, 0)} />
              <Kpi label="KI barrier" value={num(data.barriers?.knockIn)} />
              <Kpi label="KO barrier" value={data.barriers?.knockOut != null ? num(data.barriers.knockOut) : '—'} />
            </div>
            <DataTable
              columns={[
                { key: 'step', label: 'Step' },
                { key: 'years', label: 'Years', render: (row) => num(row.years, 4) },
                { key: 'belowKi', label: 'Below KI', render: (row) => row.belowKi },
                { key: 'knockOut', label: 'Above KO', render: (row) => row.knockOut },
                { key: 'couponPaid', label: 'Coupon paid', render: (row) => row.couponPaid },
              ]}
              rows={rows}
              empty="No schedule"
            />
          </div>
        )
      }}
    </RigaPanel>
  )
})

export const RigaScheduleExplorerTile = memo(function RigaScheduleExplorerTile() {
  const state = useRigaPathSeries()
  const { tokens } = useTheme()
  return (
    <RigaPanel
      title="Schedule Explorer"
      subtitle="path_series · coupon-paid / below-KI per step"
      tool="path_series"
      state={state}
    >
      {(data) => {
        const states = data.states ?? []
        const base = chartBase(tokens)
        const option = {
          ...base,
          xAxis: { ...(base.xAxis as object), type: 'value', name: 'Years' },
          yAxis: { ...(base.yAxis as object), name: 'Paths' },
          legend: { top: 4, textStyle: { color: tokens.muted, fontSize: 9 } },
          series: [
            {
              name: 'Coupon paid',
              type: 'bar',
              data: states.map((entry) => [entry.years, entry.couponPaid]),
              itemStyle: { color: tokens.primary },
            },
            {
              name: 'Below KI',
              type: 'line',
              symbol: 'none',
              data: states.map((entry) => [entry.years, entry.belowKi]),
              lineStyle: { color: tokens.danger, width: 2 },
              itemStyle: { color: tokens.danger },
            },
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
