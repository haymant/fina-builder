import { ReactFlowProvider } from '@xyflow/react'
import { AttributionPanel } from './features/attribution/components/AttributionPanel'
import { BranchSankeyPanel } from './features/branch-statistics/components/BranchSankeyPanel'
import { DistributionPanel } from './features/distribution/components/DistributionPanel'
import { PayoffGraphPanel } from './features/payoff-graph/components/PayoffGraphPanel'
import { NodeDetailPanel } from './features/path-inspector/components/NodeDetailPanel'
import { PathTimelinePanel } from './features/path-inspector/components/PathTimelinePanel'
import { TopToolbar } from './features/shared/components/TopToolbar'

export default function App() {
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <TopToolbar />
      <main className="grid min-h-0 flex-1 grid-rows-[minmax(240px,1.2fr)_minmax(210px,1fr)_minmax(190px,0.95fr)_minmax(230px,1.15fr)] gap-2 overflow-auto p-2">
        <ReactFlowProvider>
          <PayoffGraphPanel />
        </ReactFlowProvider>

        <div className="grid min-h-0 grid-cols-1 gap-2 lg:grid-cols-[1.4fr_1fr]">
          <PathTimelinePanel />
          <NodeDetailPanel />
        </div>

        <BranchSankeyPanel />

        <div className="grid min-h-0 grid-cols-1 gap-2 lg:grid-cols-2">
          <AttributionPanel />
          <DistributionPanel />
        </div>
      </main>
    </div>
  )
}
