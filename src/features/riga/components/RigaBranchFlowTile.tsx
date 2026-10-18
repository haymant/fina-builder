// riga-flow branch-flow tile (docs/49 P3g-iv) — the real transition populations
// from `query_execution_net`, drawn as a decision-tree sankey.

import { memo } from 'react'
import { useRigaExecutionNet } from '../hooks'
import Chart from '../../shared/components/Chart'
import { Kpi, num, RigaPanel } from './primitives'

export const RigaBranchFlowTile = memo(function RigaBranchFlowTile() {
  const state = useRigaExecutionNet()
  return (
    <RigaPanel
      title="Branch Flow"
      subtitle="query_execution_net · transition populations"
      tool="query_execution_net"
      state={state}
    >
      {(data) => {
        const byId = new Map((data.transitions ?? []).map((t) => [t.id, t]))
        const ko = byId.get('daily_global_ko')
        const put = byId.get('final_fixing_eki')
        const coupon = byId.get('memory_coupon')
        const paths = ko?.populationBefore ?? 0
        const koAfter = ko?.populationAfter ?? 0
        const survive = Math.max(paths - koAfter, 0)
        const putAfter = put?.populationAfter ?? 0
        const noPut = Math.max((put?.populationBefore ?? 0) - putAfter, 0)
        const couponAfter = coupon?.populationAfter ?? 0

        const nodes = ['Paths', 'KO', 'Survive', 'Put eligible', 'No put', 'Coupon carry'].map((name) => ({ name }))
        const links = [
          { source: 'Paths', target: 'KO', value: koAfter },
          { source: 'Paths', target: 'Survive', value: survive },
          { source: 'Survive', target: 'Put eligible', value: putAfter },
          { source: 'Survive', target: 'No put', value: noPut },
          { source: 'Paths', target: 'Coupon carry', value: couponAfter },
        ]
        const option = {
          backgroundColor: 'transparent',
          tooltip: { trigger: 'item' },
          series: [
            {
              type: 'sankey',
              left: 12,
              right: 160,
              top: 16,
              bottom: 16,
              nodeWidth: 14,
              nodeGap: 18,
              layoutIterations: 0,
              data: nodes,
              links,
              label: { fontSize: 11 },
              lineStyle: { color: 'gradient', curveness: 0.5 },
            },
          ],
        }
        return (
          <div className="flex h-full min-h-0 flex-col">
            <div className="grid shrink-0 grid-cols-2 gap-2 p-3 sm:grid-cols-4">
              <Kpi label="Paths" value={num(paths, 0)} />
              <Kpi label="KO" value={num(koAfter, 0)} tone="success" />
              <Kpi label="Put" value={num(putAfter, 0)} tone="danger" />
              <Kpi label="Coupon" value={num(couponAfter, 0)} tone="primary" />
            </div>
            <div className="min-h-0 flex-1 p-2">
              <Chart option={option} style={{ height: '100%', width: '100%' }} />
            </div>
          </div>
        )
      }}
    </RigaPanel>
  )
})
