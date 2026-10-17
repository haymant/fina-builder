import { memo, useMemo } from 'react'
import ReactECharts from '../../shared/components/Chart'
import { useExplorerStore, useSelectedPath } from '../../../store/explorerStore'
import { useSimulationStore } from '../../../store/simulationStore'
import { PanelCard } from '../../shared/components/PanelCard'
import { PanelLoading } from '../../shared/components/AsyncPanel'

const EMPTY_BRANCH = { totalPaths: 0, koTriggered: 0, alive: 0, knockIn: 0, noKnockIn: 0, cashSettlement: 0, physicalDelivery: 0 }

// Node names carry the payoff-catalog ids from `PheonixPayoff.md` so the flow
// reads against the decision tree (P01–P08). The demo kernel exposes aggregate
// branches, not the full catalog, so the ranges are honest about what is merged:
//   KO          -> P01–P04 (global/local × memory/plain are not split)
//   Call/No-KI  -> P05 (call region) / P08 (no-KI region are not split)
//   KI          -> P06 (above maturity barrier) / P07 (below are not split)
const NODE = {
  root: 'All paths',
  ko: 'KO · P01–P04',
  alive: 'No KO — survive',
  noKi: 'Call / No-KI · P05/P08',
  ki: 'KI region · P06/P07',
  cash: 'Cash settlement',
  physical: 'Physical delivery',
} as const

export const BranchSankeyPanel = memo(function BranchSankeyPanel() {
  const path = useSelectedPath()
  const theme = useExplorerStore((s) => s.theme)
  const bundle = useSimulationStore((s) => s.bundle)
  const stats = bundle?.branchStats ?? EMPTY_BRANCH

  const highlightNode = useMemo(() => {
    if (!path) return NODE.noKi
    if (path.knockedOut) return NODE.ko
    if (!path.knockInTriggered) return NODE.noKi
    return path.settlementType === 'physical' ? NODE.physical : NODE.cash
  }, [path])

  const option = useMemo(() => {
    const nodes = Object.values(NODE).map((name) => ({ name }))
    const links = [
      { source: NODE.root, target: NODE.ko, value: stats.koTriggered },
      { source: NODE.root, target: NODE.alive, value: stats.alive },
      { source: NODE.alive, target: NODE.noKi, value: stats.noKnockIn },
      { source: NODE.alive, target: NODE.ki, value: stats.knockIn },
      { source: NODE.ki, target: NODE.cash, value: stats.cashSettlement },
      { source: NODE.ki, target: NODE.physical, value: stats.physicalDelivery },
    ]

    const highlight = new Set<string>([NODE.root, highlightNode])
    if (highlightNode === NODE.cash || highlightNode === NODE.physical) {
      highlight.add(NODE.alive)
      highlight.add(NODE.ki)
    } else if (highlightNode === NODE.noKi) {
      highlight.add(NODE.alive)
    }

    const count = (value: number) => value.toLocaleString()
    const share = (value: number) =>
      stats.totalPaths > 0 ? ` · ${((value / stats.totalPaths) * 100).toFixed(2)}%` : ''

    return {
      backgroundColor: 'transparent',
      animationDuration: 400,
      tooltip: {
        trigger: 'item',
        triggerOn: 'mousemove',
        backgroundColor: '#111827',
        borderColor: '#334155',
        textStyle: { color: '#e2e8f0', fontSize: 11 },
        // `confine` + size limits come from the shared Chart wrapper.
        formatter: (params: {
          dataType?: string
          name?: string
          data?: { source?: string; target?: string; value?: number }
        }) => {
          if (params.dataType === 'edge' && params.data) {
            const value = params.data.value ?? 0
            return `<b>${params.data.source} → ${params.data.target}</b><br/>${count(value)} paths${share(value)}`
          }
          const name = params.name ?? ''
          if (name === NODE.root) return `<b>${name}</b><br/>${count(stats.totalPaths)} paths`
          const entry = [
            [NODE.ko, stats.koTriggered],
            [NODE.alive, stats.alive],
            [NODE.noKi, stats.noKnockIn],
            [NODE.ki, stats.knockIn],
            [NODE.cash, stats.cashSettlement],
            [NODE.physical, stats.physicalDelivery],
          ].find(([label]) => label === name)
          const value = (entry?.[1] as number | undefined) ?? 0
          return `<b>${name}</b><br/>${count(value)} paths${share(value)}`
        },
      },
      series: [
        {
          type: 'sankey',
          emphasis: { focus: 'adjacency' },
          nodeAlign: 'left',
          orient: 'horizontal',
          left: 12,
          right: 148,
          top: 16,
          bottom: 16,
          nodeWidth: 14,
          nodeGap: 18,
          layoutIterations: 0,
          data: nodes.map((n) => ({
            ...n,
            itemStyle: {
              color: highlight.has(n.name) ? '#3b82f6' : '#334155',
              borderColor: highlight.has(n.name) ? '#60a5fa' : '#1e293b',
              borderWidth: highlight.has(n.name) ? 1 : 0,
              opacity: highlight.has(n.name) ? 1 : 0.45,
            },
            label: { color: highlight.has(n.name) ? '#e2e8f0' : '#64748b', fontSize: 11 },
          })),
          links: links.map((l) => {
            const active =
              (highlightNode === NODE.ko && l.target === NODE.ko) ||
              (highlightNode === NODE.noKi && (l.target === NODE.alive || l.target === NODE.noKi)) ||
              ((highlightNode === NODE.cash || highlightNode === NODE.physical) &&
                (l.target === NODE.alive || l.target === NODE.ki || l.target === highlightNode))
            return {
              ...l,
              lineStyle: { color: 'gradient', opacity: active ? 0.6 : 0.12, curveness: 0.5 },
            }
          }),
          lineStyle: { color: 'gradient', curveness: 0.5 },
          label: { fontSize: 11, formatter: '{b}' },
        },
      ],
    }
  }, [stats, highlightNode, theme])

  if (!bundle || !path) {
    return <PanelLoading title="Branch Statistics" subtitle={`Selected branch · ${highlightNode}`} />
  }

  return (
    <PanelCard
      title="Branch Statistics"
      subtitle={`Payoff decision tree (P01–P08) · selected: ${highlightNode}`}
      className="h-full"
      bodyClassName="overflow-hidden"
      actions={
        <span className="text-[9px] text-muted" title="The demo kernel exposes aggregate branches; global/local & memory KO, call vs no-KI, and KI above/below are merged.">
          {stats.totalPaths.toLocaleString()} paths
        </span>
      }
    >
      <ReactECharts option={option} style={{ height: '100%', width: '100%' }} opts={{ renderer: 'canvas' }} notMerge />
    </PanelCard>
  )
})
