// riga-flow payoff-graph tile (docs/49 P3g-ii) — the full product payoff graph
// shipped inside `query_execution_net` (the execution net is its priced
// projection), so the Petri net is a complete superset.

import { memo } from 'react'
import { useRigaExecutionNet } from '../hooks'
import { DataTable, Kpi, RigaPanel } from './primitives'

export const RigaPayoffGraphTile = memo(function RigaPayoffGraphTile() {
  const state = useRigaExecutionNet()
  return (
    <RigaPanel
      title="Payoff Graph"
      subtitle="query_execution_net · product payoff pipeline"
      tool="query_execution_net"
      state={state}
    >
      {(net) => {
        const graph = net.payoffGraph
        const nodes = graph?.nodes ?? []
        return (
          <div className="space-y-3 p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Kpi label="Nodes" value={graph?.nodeCount ?? 0} tone="primary" />
              <Kpi label="Edges" value={graph?.edges.length ?? 0} />
              <Kpi label="Sources" value={(graph?.sources ?? []).length} />
              <Kpi label="Execution transitions" value={(net.transitions ?? []).length} />
            </div>
            <div>
              <p className="eyebrow mb-1">Pipeline (inputs → transition → output)</p>
              <DataTable
                columns={[
                  { key: 'id', label: 'Transition' },
                  { key: 'inputs', label: 'Inputs', render: (row) => row.inputs.join(', ') || '—' },
                  { key: 'output', label: 'Output' },
                ]}
                rows={nodes}
                empty="No payoff graph"
              />
            </div>
            <p className="text-[10px] text-muted">
              The execution net ({net.transitions?.length ?? 0} priced transitions with populations)
              is the projected, priced view of this {graph?.nodeCount ?? 0}-node product graph.
            </p>
          </div>
        )
      }}
    </RigaPanel>
  )
})
