// riga-flow market-explorer tiles (docs/49 P3g-v) — `get_market` (flat ATM marks)
// plus the instrument document's Dupire local-vol grid.

import { memo } from 'react'
import { useRigaMarket } from '../hooks'
import { useInstrumentStore } from '../../../store/instrumentStore'
import { useTheme } from '../../themes/ThemeProvider'
import Chart from '../../shared/components/Chart'
import { PanelCard } from '../../shared/components/PanelCard'
import { chartBase, DataTable, EmptyTile, Kpi, num, pct, RigaPanel } from './primitives'

export const RigaMarketExplorerTile = memo(function RigaMarketExplorerTile() {
  const state = useRigaMarket()
  return (
    <RigaPanel
      title="Market Explorer"
      subtitle="get_market · spots / flat ATM vols / correlation"
      tool="get_market"
      state={state}
    >
      {(market) => (
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Kpi label="Market id" value={market.id} tone="primary" />
            <Kpi label="As of" value={market.asOf} />
            <Kpi label="Risk-free" value={num(market.riskFreeRate)} />
            <Kpi label="Model" value={market.engineModel ?? '—'} />
          </div>
          <div>
            <p className="eyebrow mb-1">Marks</p>
            <DataTable
              columns={[
                { key: 'index', label: '#', render: (row) => `#${row.index}` },
                { key: 'spot', label: 'Spot', render: (row) => num(row.spot, 3) },
                { key: 'vol', label: 'ATM vol', render: (row) => pct(row.vol) },
                { key: 'div', label: 'Div yield', render: (row) => pct(row.div) },
              ]}
              rows={(market.spots ?? []).map((spot, index) => ({
                index,
                spot,
                vol: market.vols?.[index] ?? 0,
                div: market.dividendYields?.[index] ?? 0,
              }))}
              empty="No marks"
            />
          </div>
          <div>
            <p className="eyebrow mb-1">Correlation</p>
            <div className="flex flex-wrap gap-1">
              {(market.correlation ?? []).map((row, i) =>
                row.map((value, j) => (
                  <span
                    key={`${i}-${j}`}
                    className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[9px]"
                  >
                    ρ{i}
                    {j} {num(value)}
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

export const RigaVolSurfaceTile = memo(function RigaVolSurfaceTile() {
  const document = useInstrumentStore((s) => s.document)
  const { tokens } = useTheme()
  const surface = document.market.localVol?.[0]
  if (!surface || surface.strikes.length === 0 || surface.maturitiesYears.length === 0) {
    return (
      <EmptyTile
        title="Vol Surface"
        subtitle="document · Dupire local vol"
        message="No Dupire local-vol surface in the instrument document. Import a Murex chunk or the termsheet1 fixture."
      />
    )
  }
  const data: Array<[number, number, number]> = []
  surface.vols.forEach((row, maturityIndex) => {
    row.forEach((value, strikeIndex) => data.push([strikeIndex, maturityIndex, +(value * 100).toFixed(2)]))
  })
  const base = chartBase(tokens)
  const option = {
    ...base,
    tooltip: { trigger: 'item' },
    grid: { left: 62, right: 30, top: 24, bottom: 44 },
    xAxis: {
      ...(base.xAxis as object),
      type: 'category',
      data: surface.strikes.map((strike) => strike.toFixed(1)),
      name: 'Strike',
      axisLabel: { color: tokens.muted, fontSize: 8, interval: 2 },
    },
    yAxis: {
      ...(base.yAxis as object),
      type: 'category',
      data: surface.maturitiesYears.map((years) => years.toFixed(2)),
      name: 'Years',
    },
    visualMap: {
      min: 20,
      max: 80,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      top: 0,
      textStyle: { color: tokens.muted, fontSize: 9 },
      inRange: { color: [tokens.danger, tokens.warning, tokens.success] },
    },
    series: [{ type: 'heatmap', data, label: { show: false } }],
  }
  return (
    <PanelCard title="Vol Surface" subtitle="document · Dupire local vol (%)" className="h-full" bodyClassName="overflow-hidden">
      <div className="h-full min-h-0 p-2">
        <Chart option={option} style={{ height: '100%', width: '100%' }} />
      </div>
    </PanelCard>
  )
})
