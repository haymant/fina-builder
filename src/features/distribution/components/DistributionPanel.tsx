import ReactECharts from 'echarts-for-react'
import { memo, useMemo, useState } from 'react'
import type { SimulationBundle, SimulationPath } from '../../../api/types'
import { useExplorerStore, useSelectedPath } from '../../../store/explorerStore'
import { useSimulationStore } from '../../../store/simulationStore'
import type { DistributionStats } from '../../shared/types'
import { PanelCard } from '../../shared/components/PanelCard'
import { PanelLoading } from '../../shared/components/AsyncPanel'
import { StatsBadge } from '../../shared/components/StatsBadge'

type DistTab = 'total' | 'coupon' | 'put' | 'worstOf'

const TABS: { id: DistTab; label: string }[] = [
  { id: 'total', label: 'Total Payoff' },
  { id: 'coupon', label: 'Coupon PV' },
  { id: 'put', label: 'Put PV' },
  { id: 'worstOf', label: 'Worst Of Final' },
]

function histogram(values: number[], bins = 20): { centers: number[]; counts: number[]; width: number } {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const width = span / bins
  const counts = Array.from({ length: bins }, () => 0)
  for (const v of values) {
    let idx = Math.floor((v - min) / width)
    if (idx >= bins) idx = bins - 1
    if (idx < 0) idx = 0
    counts[idx]!++
  }
  const centers = counts.map((_, i) => +(min + width * (i + 0.5)).toFixed(2))
  return { centers, counts, width }
}

function selectedValue(tab: DistTab, path: SimulationPath): number {
  switch (tab) {
    case 'total':
      return path.payoff
    case 'coupon':
      return +(path.couponValue + path.memoryCouponValue).toFixed(2)
    case 'put':
      return path.putValue
    case 'worstOf': {
      const idx = path.knockOutDateIndex ?? path.worstOfPerformance.length - 1
      return +(path.worstOfPerformance[idx]! * 100).toFixed(2)
    }
  }
}

const EMPTY_DIST: SimulationBundle['distributions'] = {
  totalPayoff: { mean: 0, median: 0, stdDev: 0, p05: 0, p95: 0, values: [] },
  couponPv: { mean: 0, median: 0, stdDev: 0, p05: 0, p95: 0, values: [] },
  putPv: { mean: 0, median: 0, stdDev: 0, p05: 0, p95: 0, values: [] },
  worstOfFinal: { mean: 0, median: 0, stdDev: 0, p05: 0, p95: 0, values: [] },
}

function statsFor(tab: DistTab, d: SimulationBundle['distributions']): DistributionStats {
  switch (tab) {
    case 'total':
      return d.totalPayoff
    case 'coupon':
      return d.couponPv
    case 'put':
      return d.putPv
    case 'worstOf':
      return d.worstOfFinal
  }
}

export const DistributionPanel = memo(function DistributionPanel() {
  const [tab, setTab] = useState<DistTab>('total')
  const path = useSelectedPath()
  const theme = useExplorerStore((s) => s.theme)
  const bundle = useSimulationStore((s) => s.bundle)
  const stats = statsFor(tab, bundle?.distributions ?? EMPTY_DIST)
  const marker = path ? selectedValue(tab, path) : 0

  const option = useMemo(() => {
    const { centers, counts } = histogram(stats.values, 18)
    const nearestIdx = centers.reduce(
      (best, c, i) =>
        Math.abs(c - marker) < Math.abs(centers[best]! - marker) ? i : best,
      0,
    )

    return {
      backgroundColor: 'transparent',
      animationDuration: 300,
      grid: { left: 44, right: 20, top: 24, bottom: 40 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#111827',
        borderColor: '#334155',
        textStyle: { color: '#e2e8f0', fontSize: 11 },
      },
      xAxis: {
        type: 'category',
        data: centers.map(String),
        axisLabel: { color: '#64748b', fontSize: 9, rotate: 30 },
        axisLine: { lineStyle: { color: '#334155' } },
        name: tab === 'worstOf' ? 'Worst Of %' : 'Value',
        nameTextStyle: { color: '#64748b', fontSize: 10 },
      },
      yAxis: {
        type: 'value',
        name: 'Count',
        nameTextStyle: { color: '#64748b', fontSize: 10 },
        axisLabel: { color: '#64748b', fontSize: 10 },
        splitLine: { lineStyle: { color: '#1e293b' } },
      },
      series: [
        {
          name: 'Population',
          type: 'bar',
          data: counts.map((c, i) => ({
            value: c,
            itemStyle: {
              color: i === nearestIdx ? '#22c55e' : '#3b82f6',
              opacity: i === nearestIdx ? 1 : 0.75,
              borderRadius: [2, 2, 0, 0],
            },
          })),
          barWidth: '70%',
          markLine: {
            symbol: ['none', 'arrow'],
            symbolSize: 8,
            label: {
              formatter: `Selected Path → ${marker}`,
              color: '#22c55e',
              fontSize: 10,
              position: 'end',
            },
            lineStyle: { color: '#22c55e', width: 2, type: 'solid' },
            data: [{ xAxis: nearestIdx }],
          },
          markPoint: {
            symbol: 'arrow',
            symbolRotate: 180,
            symbolSize: 14,
            data: [
              {
                name: 'selected-path',
                coord: [nearestIdx, counts[nearestIdx]!],
                itemStyle: { color: '#22c55e' },
                label: { show: false },
              },
            ],
          },
        },
      ],
    }
  }, [stats, marker, tab, theme])

  if (!bundle || !path) {
    return (
      <PanelLoading title="Distribution Analytics" subtitle="Population vs selected path" />
    )
  }

  return (
    <PanelCard
      title="Distribution Analytics"
      subtitle="Population vs selected path"
      className="h-full"
      actions={
        <div className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded px-2 py-1 text-[10px] transition ${
                tab === t.id
                  ? 'bg-primary/20 text-primary'
                  : 'text-muted hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      }
      bodyClassName="flex min-h-0 flex-col"
    >
      <div className="flex flex-wrap gap-2 border-b border-slate-800 px-3 py-2">
        <StatsBadge label="Mean" value={stats.mean} tone="primary" />
        <StatsBadge label="Median" value={stats.median} />
        <StatsBadge label="Std Dev" value={stats.stdDev} />
        <StatsBadge label="P05" value={stats.p05} tone="warning" />
        <StatsBadge label="P95" value={stats.p95} tone="success" />
        <StatsBadge label="Selected" value={marker} tone="success" />
      </div>
      <div className="min-h-0 flex-1">
        <ReactECharts
          option={option}
          style={{ height: '100%', width: '100%' }}
          opts={{ renderer: 'canvas' }}
          notMerge
        />
      </div>
    </PanelCard>
  )
})
