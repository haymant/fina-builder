import ReactECharts from 'echarts-for-react'
import { memo, useMemo } from 'react'
import { BARRIERS } from '../../../mock-data/generatePaths'
import { useExplorerStore, useSelectedPath } from '../../../store/explorerStore'
import { PanelCard } from '../../shared/components/PanelCard'

export const PathTimelinePanel = memo(function PathTimelinePanel() {
  const path = useSelectedPath()
  const selectedDateIndex = useExplorerStore((s) => s.selectedDateIndex)
  const setSelectedDateIndex = useExplorerStore((s) => s.setSelectedDateIndex)
  const theme = useExplorerStore((s) => s.theme)

  const option = useMemo(() => {
    const dates = path.dates
    const wo = path.worstOfPerformance.map((v) => +(v * 100).toFixed(2))
    const markPoint =
      selectedDateIndex >= 0 && selectedDateIndex < wo.length
        ? {
            data: [
              {
                name: 'selected',
                coord: [dates[selectedDateIndex], wo[selectedDateIndex]],
                symbol: 'circle',
                symbolSize: 10,
                itemStyle: { color: '#22c55e', borderColor: '#fff', borderWidth: 1 },
              },
            ],
          }
        : undefined

    return {
      backgroundColor: 'transparent',
      animationDuration: 300,
      grid: { left: 48, right: 20, top: 36, bottom: 36 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: '#111827',
        borderColor: '#334155',
        textStyle: { color: '#e2e8f0', fontSize: 11 },
        valueFormatter: (v: unknown) => `${v}%`,
      },
      legend: {
        top: 4,
        textStyle: { color: '#94a3b8', fontSize: 10 },
        data: ['Worst Of %'],
      },
      xAxis: {
        type: 'category',
        data: dates,
        axisLabel: {
          color: '#64748b',
          fontSize: 9,
          formatter: (v: string) => v.slice(2, 7),
          interval: 5,
        },
        axisLine: { lineStyle: { color: '#334155' } },
      },
      yAxis: {
        type: 'value',
        name: 'Worst Of %',
        nameTextStyle: { color: '#64748b', fontSize: 10 },
        axisLabel: { color: '#64748b', fontSize: 10, formatter: '{value}%' },
        splitLine: { lineStyle: { color: '#1e293b' } },
        min: (ext: { min: number }) => Math.min(50, Math.floor(ext.min - 5)),
        max: (ext: { max: number }) => Math.max(110, Math.ceil(ext.max + 5)),
      },
      series: [
        {
          name: 'Worst Of %',
          type: 'line',
          data: wo,
          showSymbol: false,
          lineStyle: { width: 2, color: '#3b82f6' },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(59,130,246,0.25)' },
                { offset: 1, color: 'rgba(59,130,246,0.02)' },
              ],
            },
          },
          markPoint,
          markLine: {
            symbol: 'none',
            silent: true,
            label: { fontSize: 9, color: '#94a3b8', position: 'insideEndTop' },
            data: [
              {
                yAxis: BARRIERS.koBarrier * 100,
                name: 'KO',
                lineStyle: { color: '#22c55e', type: 'dashed', width: 1.5 },
                label: { formatter: 'KO {c}%' },
              },
              {
                yAxis: BARRIERS.kiBarrier * 100,
                name: 'KI',
                lineStyle: { color: '#ef4444', type: 'dashed', width: 1.5 },
                label: { formatter: 'KI {c}%' },
              },
              {
                yAxis: BARRIERS.couponLower * 100,
                name: 'Cpn Lo',
                lineStyle: { color: '#f59e0b', type: 'dotted', width: 1 },
                label: { formatter: 'Cpn Lo {c}%' },
              },
              {
                yAxis: BARRIERS.couponUpper * 100,
                name: 'Cpn Hi',
                lineStyle: { color: '#f59e0b', type: 'dotted', width: 1 },
                label: { formatter: 'Cpn Hi {c}%' },
              },
            ],
          },
        },
      ],
    }
  }, [path, selectedDateIndex, theme])

  return (
    <PanelCard
      title="Path Timeline"
      subtitle={`Observation · ${path.dates[selectedDateIndex] ?? '—'}`}
      className="h-full"
    >
      <ReactECharts
        option={option}
        style={{ height: '100%', width: '100%' }}
        opts={{ renderer: 'canvas' }}
        notMerge
        onEvents={{
          click: (params: { dataIndex?: number }) => {
            if (typeof params.dataIndex === 'number') {
              setSelectedDateIndex(params.dataIndex)
            }
          },
        }}
      />
    </PanelCard>
  )
})
