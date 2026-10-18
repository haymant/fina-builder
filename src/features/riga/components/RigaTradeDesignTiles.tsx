// riga-flow trade-design tiles (docs/49 P3e) — the real `trade_design` bump batch:
// per-parameter PV/KI/KO deltas under CRN, plus the base economics.

import { memo } from 'react'
import { useRigaTradeDesign } from '../hooks'
import { useTheme } from '../../themes/ThemeProvider'
import Chart from '../../shared/components/Chart'
import { chartBase, DataTable, Kpi, num, pct, RigaPanel } from './primitives'

export const RigaEconomicsImpactSummaryTile = memo(function RigaEconomicsImpactSummaryTile() {
  const state = useRigaTradeDesign()
  return (
    <RigaPanel
      title="Economics Impact Summary"
      subtitle="trade_design · base economics"
      tool="trade_design"
      state={state}
    >
      {(data) => (
        <div className="grid grid-cols-2 gap-2 p-3">
          <Kpi label="Expected PV" value={num(data.base.pv)} tone="primary" />
          <Kpi label="Coupon PV" value={num(data.base.couponPv)} />
          <Kpi label="Put PV" value={num(data.base.putPv)} tone="warning" />
          <Kpi label="KO probability" value={pct(data.base.ko)} tone="success" />
          <Kpi label="KI probability" value={pct(data.base.ki)} tone="danger" />
          <Kpi label="Funding" value={num(data.base.funding)} />
        </div>
      )}
    </RigaPanel>
  )
})

export const RigaSensitivityTornadoTile = memo(function RigaSensitivityTornadoTile() {
  const state = useRigaTradeDesign()
  const { tokens } = useTheme()
  return (
    <RigaPanel
      title="Sensitivity Tornado"
      subtitle="trade_design · one-step PV impact"
      tool="trade_design"
      state={state}
    >
      {(data) => {
        const items = (data.parameters ?? [])
          .map((p) => ({ name: p.parameter.replace(/_/g, ' '), value: Math.abs(p.deltaPv) }))
          .sort((a, b) => b.value - a.value)
        const base = chartBase(tokens)
        const option = {
          ...base,
          grid: { left: 110, right: 30, top: 18, bottom: 28 },
          xAxis: { ...(base.xAxis as object), type: 'value' },
          yAxis: { ...(base.yAxis as object), type: 'category', data: items.map((i) => i.name) },
          series: [{ type: 'bar', data: items.map((i) => i.value), itemStyle: { color: tokens.primary } }],
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

export const RigaParameterImpactMatrixTile = memo(function RigaParameterImpactMatrixTile() {
  const state = useRigaTradeDesign()
  return (
    <RigaPanel
      title="Parameter Impact Matrix"
      subtitle="trade_design · ΔPV / ΔKI / ΔKO by parameter"
      tool="trade_design"
      state={state}
    >
      {(data) => (
        <div className="space-y-2 p-3">
          <DataTable
            columns={[
              { key: 'parameter', label: 'Parameter', render: (row) => row.parameter.replace(/_/g, ' ') },
              { key: 'step', label: 'Step', render: (row) => num(row.step, 3) },
              { key: 'deltaPv', label: 'ΔPV', render: (row) => num(row.deltaPv) },
              { key: 'deltaKi', label: 'ΔKI', render: (row) => (row.deltaKi === undefined ? '—' : pct(row.deltaKi)) },
              { key: 'deltaKo', label: 'ΔKO', render: (row) => (row.deltaKo === undefined ? '—' : pct(row.deltaKo)) },
            ]}
            rows={data.parameters ?? []}
            empty="No parameters"
          />
          <p className="text-[10px] text-muted">
            {data.scenarioCount} CRN-paired revaluations · step {data.step}
          </p>
        </div>
      )}
    </RigaPanel>
  )
})
