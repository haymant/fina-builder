// Interactive narrative graph. ECharts owns zoom, pan, drag and the force
// layout; this component only adds the readability toggles, because a dense
// projection is unreadable with every label forced on at once.

import { useMemo, useState } from 'react'
import Chart from '../../shared/components/Chart'
import { buildGraphOption } from '../graph'
import type { NipNarrativeGraph } from '../types'

interface ClickParams {
  dataType?: string
  data?: { evidenceEventIds?: string[] }
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      className={`narrative-graph-toggle ${on ? 'is-on' : ''}`}
      aria-pressed={on}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function NarrativeGraphChart({
  graph,
  onOpenEvent,
}: {
  graph: NipNarrativeGraph
  onOpenEvent: (eventId: string) => void
}) {
  const [showNodeLabels, setShowNodeLabels] = useState(true)
  // Off by default: one label per edge turns a wide projection into a wall of
  // text. Hovering an edge still names its relation through the tooltip.
  const [showEdgeLabels, setShowEdgeLabels] = useState(false)
  const [colorByCluster, setColorByCluster] = useState(true)

  const option = useMemo(
    () => buildGraphOption(graph, { showNodeLabels, showEdgeLabels, colorByCluster }),
    [graph, showNodeLabels, showEdgeLabels, colorByCluster],
  )

  const handleClick = (params: ClickParams) => {
    if (params.dataType !== 'node') return
    const eventId = params.data?.evidenceEventIds?.[0]
    if (eventId) onOpenEvent(eventId)
  }

  return (
    <div className="narrative-graph" data-testid="narrative-graph">
      <div className="narrative-graph-toolbar">
        <Toggle on={showNodeLabels} onClick={() => setShowNodeLabels((value) => !value)}>
          Node labels
        </Toggle>
        <Toggle on={showEdgeLabels} onClick={() => setShowEdgeLabels((value) => !value)}>
          Edge labels
        </Toggle>
        <Toggle on={colorByCluster} onClick={() => setColorByCluster((value) => !value)}>
          Colour by cluster
        </Toggle>
        <span className="narrative-graph-hint">
          Scroll to zoom · drag the canvas to pan · drag a node to pin it · hover an edge for its
          relation
        </span>
      </div>
      <Chart
        option={option}
        style={{ height: 420, width: '100%' }}
        onEvents={{ click: handleClick }}
        notMerge
      />
      <p className="text-[10px] text-muted">Click any node to open the retained event behind it.</p>
    </div>
  )
}
