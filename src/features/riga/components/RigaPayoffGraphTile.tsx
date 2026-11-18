// riga-flow payoff-graph tile (docs/49 P3g-ii) — the full product payoff graph
// shipped inside `query_execution_net` (the execution net is its priced
// projection). The engine returns it as a Petri incidence list
// (`inputs → transition → output`), so the tile can show it either as the flow
// table or as the same graph. Clicking either representation selects the mapped
// workflow transition, which is what feeds Transition Detail.

import { Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useNodesState, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { memo, useEffect, useMemo, useState } from 'react'
import { useRigaExecutionNet } from '../hooks'
import { useRigaSelectionStore } from '../../../store/rigaSelectionStore'
import { layoutPayoffGraph, PRODUCT_TO_WORKFLOW, transitionLabel } from '../data/netLayout'
import { AutoFit } from './AutoFit'
import { DataTable, Kpi, RigaPanel } from './primitives'
import type { RigaPayoffGraphNode } from '../types'

interface PayoffNodeData extends Record<string, unknown> {
  label: string
  kind: 'place' | 'transition'
  selected?: boolean
}

const handleStyle = { width: 7, height: 7, background: '#64748b', border: '1px solid #0f172a' }

function PayoffGraphNode({ data }: NodeProps) {
  const node = data as PayoffNodeData
  const ring = node.selected ? 'border-primary ring-2 ring-primary/60' : ''
  if (node.kind === 'place') {
    return (
      <div
        className={`flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-full border-2 bg-panel text-center shadow ${ring || 'border-slate-500'}`}
        data-testid="payoff-graph-place"
      >
        <Handle type="target" position={Position.Left} style={handleStyle} />
        <Handle type="source" position={Position.Right} style={handleStyle} />
        <span className="line-clamp-2 px-1 text-[8px] leading-tight font-semibold text-main">{node.label}</span>
      </div>
    )
  }
  return (
    <div
      className={`flex h-full w-full flex-col items-center justify-center overflow-hidden rounded border bg-panel px-1 text-center shadow ${ring || 'border-slate-600'}`}
      data-testid="payoff-graph-transition"
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />
      <span className="text-[9px] font-semibold text-primary">{node.label}</span>
    </div>
  )
}

const nodeTypes = { payoff: PayoffGraphNode }

/** The engine's product transitions are a bipartite net: places → transition → place. */
function PayoffCanvas({
  nodes: rows,
  selectedId,
  selectedPlaceId,
  onSelect,
}: {
  nodes: RigaPayoffGraphNode[]
  selectedId: string | null
  selectedPlaceId: string | null
  onSelect: (kind: 'place' | 'transition', id: string) => void
}) {
  // Structure only: selection is applied to `data.selected` below so a click does
  // not rebuild the graph and snap dragged nodes back to the computed layout.
  const structural = useMemo(() => {
    const layout = layoutPayoffGraph(rows)
    const flowNodes: Node<PayoffNodeData>[] = layout.nodes.map((node) => ({
      id: `${node.kind}:${node.id}`,
      type: 'payoff',
      position: node.position,
      style: node.kind === 'place' ? { width: 66, height: 66 } : { width: 150, height: 46 },
      data: {
        label: node.kind === 'place' ? node.id : transitionLabel(node.id),
        kind: node.kind,
        selected: false,
      },
    }))
    const flowEdges = layout.edges.map((edge) => ({
      id: edge.id,
      source: `${edge.fromKind}:${edge.from}`,
      target: `${edge.toKind}:${edge.to}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#64748b' },
      style: { stroke: '#64748b', strokeWidth: 1.4 },
    }))
    return { nodes: flowNodes, edges: flowEdges }
  }, [rows])
  const [nodes, setNodes, onNodesChange] = useNodesState(structural.nodes)

  useEffect(() => {
    setNodes(structural.nodes)
  }, [structural, setNodes])

  useEffect(() => {
    setNodes((current) =>
      current.map((node) => {
        const [kind, id] = node.id.split(':') as ['place' | 'transition', string]
        const selected =
          kind === 'transition'
            ? id === selectedId || PRODUCT_TO_WORKFLOW[id] === selectedId
            : id === selectedPlaceId
        return node.data.selected === selected ? node : { ...node, data: { ...node.data, selected } }
      }),
    )
  }, [selectedId, selectedPlaceId, setNodes])

  return (
    <div className="relative h-[320px] w-full" data-testid="payoff-graph-canvas">
      <ReactFlow
        nodes={nodes}
        edges={structural.edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        nodesConnectable={false}
        nodesDraggable
        elementsSelectable={false}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.15}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_event, node) => {
          const [kind, id] = node.id.split(':') as ['place' | 'transition', string]
          onSelect(kind, id)
        }}
      >
        <Background />
        <Controls className="react-flow-controls-themed" showInteractive={false} />
        <AutoFit padding={0.2} />
      </ReactFlow>
    </div>
  )
}

export const RigaPayoffGraphTile = memo(function RigaPayoffGraphTile() {
  const state = useRigaExecutionNet()
  const selectTransition = useRigaSelectionStore((s) => s.selectTransition)
  const selectPlace = useRigaSelectionStore((s) => s.selectPlace)
  const selectedTransitionId = useRigaSelectionStore((s) => s.selectedTransitionId)
  const selectedPlaceId = useRigaSelectionStore((s) => s.selectedPlaceId)
  const [view, setView] = useState<'table' | 'graph'>('table')
  const selectProduct = (id: string) => selectTransition(PRODUCT_TO_WORKFLOW[id] ?? id)
  // A row is a Petri step: its transition *and* the place it produces. Selecting
  // both is what keeps Transition Detail and Place Detail in sync; the store's
  // `selectNode` would clear one of them, so use the per-kind setters.
  const selectStep = (row: RigaPayoffGraphNode) => {
    selectProduct(row.id)
    selectPlace(row.output)
  }
  const selectGraphNode = (kind: 'place' | 'transition', id: string) => {
    if (kind === 'transition') selectProduct(id)
    else selectPlace(id)
  }
  const placeChip = (place: string) => (
    <button
      key={place}
      type="button"
      data-testid={`payoff-place-${place}`}
      className="rounded border border-line/70 px-1 py-0.5 font-mono text-[9px] text-muted hover:border-primary hover:text-primary"
      title={`Inspect place ${place}`}
      onClick={(event) => {
        event.stopPropagation()
        selectPlace(place)
      }}
    >
      {place}
    </button>
  )
  return (
    <RigaPanel
      title="Payoff Graph"
      subtitle="query_execution_net · product payoff pipeline (click to inspect)"
      tool="query_execution_net"
      state={state}
      actions={
        <div className="flex items-center gap-1" data-testid="payoff-graph-view-switch">
          <button
            type="button"
            className={view === 'table' ? 'shock-button bg-primary/20' : 'shock-button'}
            aria-pressed={view === 'table'}
            onClick={() => setView('table')}
          >
            Table
          </button>
          <button
            type="button"
            className={view === 'graph' ? 'shock-button bg-primary/20' : 'shock-button'}
            aria-pressed={view === 'graph'}
            onClick={() => setView('graph')}
            data-testid="payoff-graph-view-graph"
          >
            Graph
          </button>
        </div>
      }
    >
      {(net) => {
        const graph = net.payoffGraph
        const nodes = graph?.nodes ?? []
        // The engine's `sources` list is empty for the put graph; derive the source
        // places from the incidence instead so the KPI matches the drawing.
        const produced = new Set(nodes.map((node) => node.output))
        const sources = new Set(nodes.flatMap((node) => node.inputs).filter((input) => !produced.has(input)))
        return (
          <div className="space-y-3 p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Kpi label="Nodes" value={graph?.nodeCount ?? 0} tone="primary" />
              <Kpi label="Arcs" value={nodes.reduce((total, node) => total + node.inputs.length + 1, 0)} />
              <Kpi label="Sources" value={sources.size} />
              <Kpi label="Execution transitions" value={(net.transitions ?? []).length} />
            </div>
            {view === 'graph' ? (
              nodes.length === 0 ? (
                <p className="p-3 text-[11px] text-muted">No payoff graph</p>
              ) : (
                <ReactFlowProvider>
                  <PayoffCanvas
                    nodes={nodes}
                    selectedId={selectedTransitionId}
                    selectedPlaceId={selectedPlaceId}
                    onSelect={selectGraphNode}
                  />
                </ReactFlowProvider>
              )
            ) : (
              <div>
                <p className="eyebrow mb-1">Pipeline (input → transition → output)</p>
                <DataTable
                  columns={[
                    {
                      key: 'inputs',
                      label: 'Inputs',
                      render: (row) =>
                        row.inputs.length === 0 ? (
                          '—'
                        ) : (
                          <span className="flex flex-wrap gap-1">{row.inputs.map((place) => placeChip(place))}</span>
                        ),
                    },
                    { key: 'id', label: 'Transition', render: (row) => transitionLabel(row.id) },
                    { key: 'output', label: 'Output', render: (row) => placeChip(row.output) },
                  ]}
                  rows={nodes}
                  rowClassName={(row) =>
                    (PRODUCT_TO_WORKFLOW[row.id] ?? row.id) === selectedTransitionId ? 'bg-primary/10 text-primary' : ''
                  }
                  rowTestId={(row) => `payoff-row-${row.id}`}
                  onRowClick={(row) => selectStep(row)}
                  empty="No payoff graph"
                />
              </div>
            )}
            <p className="text-[10px] text-muted">
              Each output feeds a later transition: this is the product graph in Petri form. Click a row to pin both
              its execution transition and the place it produces; click a place chip (or a place in the graph view) to
              inspect that state on its own. The execution net ({net.transitions?.length ?? 0} priced transitions with
              populations) is the projected, priced view of this {graph?.nodeCount ?? 0}-node product graph.
            </p>
          </div>
        )
      }}
    </RigaPanel>
  )
})
