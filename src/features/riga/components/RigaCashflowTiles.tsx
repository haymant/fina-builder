// riga-flow cashflow tiles (docs/49 P2a) — `build_cashflows`: mean per-leg PV,
// the sampled paths, and the coupon accrual/payment timeline.

import { memo } from 'react'
import { useRigaCashflows } from '../hooks'
import { useTheme } from '../../themes/ThemeProvider'
import Chart from '../../shared/components/Chart'
import { chartBase, DataTable, Kpi, num, pct, RigaPanel } from './primitives'

export const RigaCashflowSummaryTile = memo(function RigaCashflowSummaryTile() {
  const state = useRigaCashflows()
  return (
    <RigaPanel
      title="Cashflow Summary"
      subtitle="build_cashflows · mean per-leg PV"
      tool="build_cashflows"
      state={state}
    >
      {(data) => (
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Kpi label="Paths" value={Number.isFinite(data.paths) ? data.paths.toLocaleString() : '—'} />
            <Kpi label="Mean coupon PV" value={num(data.mean?.couponPv)} tone="primary" />
            <Kpi label="Mean funding" value={num(data.mean?.funding)} />
            <Kpi label="Mean put payoff" value={num(data.mean?.putPayoff)} tone="danger" />
          </div>
          <div>
            <p className="eyebrow mb-1">Sampled paths</p>
            <DataTable
              columns={[
                { key: 'pathId', label: 'Path', render: (row) => `#${row.pathId}` },
                { key: 'pv', label: 'PV', render: (row) => num(row.pv) },
                { key: 'couponPv', label: 'Coupon PV', render: (row) => num(row.couponPv) },
                { key: 'funding', label: 'Funding', render: (row) => num(row.funding) },
                { key: 'putPayoff', label: 'Put payoff', render: (row) => num(row.putPayoff) },
              ]}
              rows={data.samplePaths ?? []}
              empty="No sampled paths"
            />
          </div>
        </div>
      )}
    </RigaPanel>
  )
})

export const RigaCashflowTimelineTile = memo(function RigaCashflowTimelineTile() {
  const state = useRigaCashflows()
  const { tokens } = useTheme()
  return (
    <RigaPanel
      title="Cashflow Timeline"
      subtitle="build_cashflows · coupon by period"
      tool="build_cashflows"
      state={state}
    >
      {(data) => {
        const points = data.timeline ?? []
        const base = chartBase(tokens)
        const option = {
          ...base,
          xAxis: { ...(base.xAxis as object), type: 'category', data: points.map((p) => `P${p.period}`), name: 'Period' },
          yAxis: { ...(base.yAxis as object), name: 'Value' },
          legend: { top: 4, textStyle: { color: tokens.muted, fontSize: 9 } },
          series: [
            {
              name: 'Expected coupon PV',
              type: 'bar',
              data: points.map((p) => p.expectedCouponPv),
              itemStyle: { color: tokens.primary },
            },
            {
              name: 'Paid probability',
              type: 'line',
              data: points.map((p) => p.paidProbability),
              symbol: 'circle',
              lineStyle: { color: tokens.success, width: 2 },
              itemStyle: { color: tokens.success },
            },
          ],
        }
        return (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 p-2">
              <Chart option={option} style={{ height: '100%', width: '100%' }} />
            </div>
            <div className="shrink-0 border-t border-line/60 p-2">
              <DataTable
                columns={[
                  { key: 'period', label: 'Period' },
                  { key: 'expectedCouponPv', label: 'Expected coupon PV', render: (row) => num(row.expectedCouponPv) },
                  { key: 'paidProbability', label: 'Paid prob', render: (row) => pct(row.paidProbability) },
                ]}
                rows={points}
                empty="No timeline"
              />
            </div>
          </div>
        )
      }}
    </RigaPanel>
  )
})
