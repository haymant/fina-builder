// riga-flow detailed-risk tiles (docs/49 P3c) — the real `risk_detailed`:
// per-asset Δ/Γ/ν, θ/ρ, cross-gamma and per-factor vega buckets.

import { memo } from 'react'
import { useRigaRiskDetailed } from '../hooks'
import { useTheme } from '../../themes/ThemeProvider'
import Chart from '../../shared/components/Chart'
import { chartBase, DataTable, Kpi, num, RigaPanel } from './primitives'

export const RigaGreeksTableTile = memo(function RigaGreeksTableTile() {
  const state = useRigaRiskDetailed()
  return (
    <RigaPanel
      title="Greeks Table"
      subtitle="risk_detailed · per-asset Δ/Γ/ν + θ/ρ"
      tool="risk_detailed"
      state={state}
    >
      {(data) => (
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Kpi label="Theta (1d)" value={num(data.theta)} tone="warning" />
            <Kpi label="Rho / DV01" value={num(data.rho)} />
            <Kpi label="Correlation" value={num(data.correlationSensitivity)} />
            <Kpi label="FX delta" value={num(data.fxDelta)} />
          </div>
          <div>
            <p className="eyebrow mb-1">Per-asset Greeks</p>
            <DataTable
              columns={[
                { key: 'assetIndex', label: 'Asset', render: (row) => `#${row.assetIndex}` },
                { key: 'delta', label: 'Delta', render: (row) => num(row.delta) },
                { key: 'gamma', label: 'Gamma', render: (row) => num(row.gamma) },
                { key: 'vega', label: 'Vega', render: (row) => num(row.vega, 4) },
              ]}
              rows={data.assets ?? []}
              empty="No per-asset Greeks"
            />
          </div>
          <div>
            <p className="eyebrow mb-1">Cross-gamma</p>
            <div className="flex flex-wrap gap-1">
              {(data.crossGamma ?? []).map((row, i) =>
                row.map((value, j) => (
                  <span key={`${i}-${j}`} className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[9px]">
                    γ{i}{j} {num(value, 6)}
                  </span>
                )),
              )}
            </div>
          </div>
        </div>
      )}
    </RigaPanel>
  )
})

export const RigaGreeksWaterfallTile = memo(function RigaGreeksWaterfallTile() {
  const state = useRigaRiskDetailed()
  const { tokens } = useTheme()
  return (
    <RigaPanel
      title="Greeks Waterfall"
      subtitle="risk_detailed · risk magnitude by factor"
      tool="risk_detailed"
      state={state}
    >
      {(data) => {
        const sumAbs = (pick: (row: { delta: number; gamma: number; vega: number }) => number) =>
          (data.assets ?? []).reduce((total, asset) => total + Math.abs(pick(asset)), 0)
        const items = [
          { name: 'Spot (Δ)', value: sumAbs((a) => a.delta) },
          { name: 'Vol (ν)', value: sumAbs((a) => a.vega) },
          { name: 'Rate (ρ)', value: Math.abs(data.rho) },
          { name: 'Correlation', value: Math.abs(data.correlationSensitivity) },
          { name: 'Theta (1d)', value: Math.abs(data.theta) },
        ].sort((a, b) => b.value - a.value)
        const base = chartBase(tokens)
        const option = {
          ...base,
          grid: { left: 92, right: 30, top: 18, bottom: 28 },
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

export const RigaBucketVegaTile = memo(function RigaBucketVegaTile() {
  const state = useRigaRiskDetailed()
  const { tokens } = useTheme()
  return (
    <RigaPanel
      title="Bucket Vega"
      subtitle="risk_detailed · vega by factor"
      tool="risk_detailed"
      state={state}
    >
      {(data) => {
        const buckets = data.bucketVegas ?? []
        const base = chartBase(tokens)
        const option = {
          ...base,
          xAxis: { ...(base.xAxis as object), type: 'category', data: buckets.map((b) => b.bucket) },
          yAxis: { ...(base.yAxis as object), name: 'Vega' },
          series: [{ type: 'bar', data: buckets.map((b) => b.vega), itemStyle: { color: tokens.warning } }],
        }
        return (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1 p-2">
              <Chart option={option} style={{ height: '100%', width: '100%' }} />
            </div>
            <p className="shrink-0 border-t border-line/60 p-2 text-[10px] text-muted">
              riga prices a flat ATM vol per factor; term buckets would need local-vol term bumps.
            </p>
          </div>
        )
      }}
    </RigaPanel>
  )
})
