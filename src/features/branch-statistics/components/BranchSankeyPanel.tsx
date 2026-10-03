import ReactECharts from 'echarts-for-react'
import { memo, useMemo } from 'react'
import { useExplorerStore, useSelectedPath } from '../../../store/explorerStore'
import { useSimulationStore } from '../../../store/simulationStore'
import { PanelCard } from '../../shared/components/PanelCard'
import { PanelLoading } from '../../shared/components/AsyncPanel'

const EMPTY_BRANCH = { totalPaths: 0, koTriggered: 0, alive: 0, knockIn: 0, noKnockIn: 0, cashSettlement: 0, physicalDelivery: 0 }

export const BranchSankeyPanel = memo(function BranchSankeyPanel() {
  const path = useSelectedPath()
  const theme = useExplorerStore((s) => s.theme)
  const bundle = useSimulationStore((s) => s.bundle)
  const stats = bundle?.branchStats ?? EMPTY_BRANCH

  const highlightBranch = useMemo(() => {
    if (!path) return 'No KnockIn'
    if (path.knockedOut) return 'KO Triggered'
    if (path.knockInTriggered) {
      return path.settlementType === 'physical' ? 'Physical Delivery' : 'Cash Settlement'
    }
    return 'No KnockIn'
  }, [path])

  const option = useMemo(() => {
    const nodes = [
      { name: '100000 Paths' },
      { name: 'KO Triggered' },
      { name: 'Alive' },
      { name: 'KnockIn' },
      { name: 'No KnockIn' },
      { name: 'Cash Settlement' },
      { name: 'Physical Delivery' },
    ]

    const links = [
      { source: '100000 Paths', target: 'KO Triggered', value: stats.koTriggered },
      { source: '100000 Paths', target: 'Alive', value: stats.alive },
      { source: 'Alive', target: 'KnockIn', value: stats.knockIn },
      { source: 'Alive', target: 'No KnockIn', value: stats.noKnockIn },
      { source: 'KnockIn', target: 'Cash Settlement', value: stats.cashSettlement },
      { source: 'KnockIn', target: 'Physical Delivery', value: stats.physicalDelivery },
    ]

    const highlightSet = new Set<string>(['100000 Paths', highlightBranch])
    if (highlightBranch === 'Cash Settlement' || highlightBranch === 'Physical Delivery') {
      highlightSet.add('Alive')
      highlightSet.add('KnockIn')
    } else if (highlightBranch === 'No KnockIn') {
      highlightSet.add('Alive')
    } else if (highlightBranch === 'KO Triggered') {
      // root + KO
    }

    return {
      backgroundColor: 'transparent',
      animationDuration: 400,
      tooltip: {
        trigger: 'item',
        triggerOn: 'mousemove',
        backgroundColor: '#111827',
        borderColor: '#334155',
        textStyle: { color: '#e2e8f0', fontSize: 11 },
      },
      series: [
        {
          type: 'sankey',
          emphasis: { focus: 'adjacency' },
          nodeAlign: 'left',
          orient: 'horizontal',
          left: 12,
          right: 120,
          top: 16,
          bottom: 16,
          nodeWidth: 14,
          nodeGap: 18,
          layoutIterations: 0,
          data: nodes.map((n) => ({
            ...n,
            itemStyle: {
              color: highlightSet.has(n.name) ? '#3b82f6' : '#334155',
              borderColor: highlightSet.has(n.name) ? '#60a5fa' : '#1e293b',
              borderWidth: highlightSet.has(n.name) ? 1 : 0,
              opacity: highlightSet.has(n.name) ? 1 : 0.45,
            },
            label: {
              color: highlightSet.has(n.name) ? '#e2e8f0' : '#64748b',
              fontSize: 11,
            },
          })),
          links: links.map((l) => {
            const onPath =
              highlightSet.has(l.source) &&
              (highlightSet.has(l.target) ||
                (l.target === 'Alive' && highlightSet.has('Alive')))
            const active =
              (highlightBranch === 'KO Triggered' && l.target === 'KO Triggered') ||
              (highlightBranch === 'No KnockIn' &&
                (l.target === 'Alive' || l.target === 'No KnockIn')) ||
              ((highlightBranch === 'Cash Settlement' ||
                highlightBranch === 'Physical Delivery') &&
                (l.target === 'Alive' ||
                  l.target === 'KnockIn' ||
                  l.target === highlightBranch))
            return {
              ...l,
              lineStyle: {
                color: 'gradient',
                opacity: active || onPath ? 0.55 : 0.12,
                curveness: 0.5,
              },
            }
          }),
          lineStyle: {
            color: 'gradient',
            curveness: 0.5,
          },
          label: {
            fontSize: 11,
            formatter: '{b}',
          },
        },
      ],
    }
  }, [stats, highlightBranch, theme])

  if (!bundle || !path) {
    return (
      <PanelLoading
        title="Branch Statistics"
        subtitle={`Selected branch · ${highlightBranch}`}
      />
    )
  }

  return (
    <PanelCard
      title="Branch Statistics"
      subtitle={`Selected branch · ${highlightBranch}`}
      className="h-full"
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
