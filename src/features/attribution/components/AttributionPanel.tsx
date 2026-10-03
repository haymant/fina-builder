import ReactECharts from 'echarts-for-react'
import { memo, useMemo } from 'react'
import { useExplorerStore, useSelectedPath } from '../../../store/explorerStore'
import { PanelCard } from '../../shared/components/PanelCard'
import { PanelLoading } from '../../shared/components/AsyncPanel'
import { StatsBadge } from '../../shared/components/StatsBadge'

export const AttributionPanel = memo(function AttributionPanel() {
  const path = useSelectedPath()
  const theme = useExplorerStore((s) => s.theme)
  const a = path?.attribution

  const option = useMemo(() => {
    if (!a) return undefined
    const items = [
      { name: 'Par Redemption', value: a.parRedemption },
      { name: 'Coupon', value: a.coupon },
      { name: 'Memory Coupon', value: a.memoryCoupon },
      { name: 'DownAndIn Put', value: a.downAndInPut },
      { name: 'Funding', value: a.funding },
      { name: 'Discounting', value: a.discounting },
    ]

    // Classic waterfall helper columns
    const helpers: number[] = []
    const positives: (number | '-')[] = []
    const negatives: (number | '-')[] = []
    let running = 0
    for (const item of items) {
      if (item.value >= 0) {
        helpers.push(running)
        positives.push(item.value)
        negatives.push('-')
        running += item.value
      } else {
        helpers.push(running + item.value)
        positives.push('-')
        negatives.push(-item.value)
        running += item.value
      }
    }

    return {
      backgroundColor: 'transparent',
      animationDuration: 350,
      grid: { left: 48, right: 16, top: 28, bottom: 48 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: '#111827',
        borderColor: '#334155',
        textStyle: { color: '#e2e8f0', fontSize: 11 },
      },
      xAxis: {
        type: 'category',
        data: [...items.map((i) => i.name), 'Total PV'],
        axisLabel: {
          color: '#94a3b8',
          fontSize: 9,
          rotate: 25,
          interval: 0,
        },
        axisLine: { lineStyle: { color: '#334155' } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: '#64748b', fontSize: 10 },
        splitLine: { lineStyle: { color: '#1e293b' } },
      },
      series: [
        {
          name: 'Helper',
          type: 'bar',
          stack: 'total',
          silent: true,
          itemStyle: { borderColor: 'transparent', color: 'transparent' },
          emphasis: { itemStyle: { borderColor: 'transparent', color: 'transparent' } },
          data: [...helpers, 0],
        },
        {
          name: 'Positive',
          type: 'bar',
          stack: 'total',
          label: { show: true, position: 'top', color: '#94a3b8', fontSize: 9 },
          itemStyle: { color: '#3b82f6', borderRadius: [2, 2, 0, 0] },
          data: [...positives, '-'],
        },
        {
          name: 'Negative',
          type: 'bar',
          stack: 'total',
          label: { show: true, position: 'bottom', color: '#fca5a5', fontSize: 9 },
          itemStyle: { color: '#ef4444', borderRadius: [0, 0, 2, 2] },
          data: [...negatives, '-'],
        },
        {
          name: 'Total',
          type: 'bar',
          stack: 'total',
          label: {
            show: true,
            position: 'top',
            color: '#22c55e',
            fontSize: 11,
            fontWeight: 600,
          },
          itemStyle: { color: '#22c55e', borderRadius: [2, 2, 0, 0] },
          data: [...items.map(() => '-' as const), a.totalPv],
        },
      ],
    }
  }, [a, theme])

  if (!a) {
    return (
      <PanelLoading title="Attribution" subtitle="Expected value decomposition" />
    )
  }

  return (
    <PanelCard
      title="Attribution"
      subtitle="Expected value decomposition"
      className="h-full"
      actions={
        <StatsBadge
          label="Final PV"
          value={a.totalPv.toFixed(2)}
          tone={a.totalPv >= 100 ? 'success' : 'warning'}
        />
      }
    >
      <ReactECharts
        option={option}
        style={{ height: '100%', width: '100%' }}
        opts={{ renderer: 'canvas' }}
        notMerge
      />
    </PanelCard>
  )
})
