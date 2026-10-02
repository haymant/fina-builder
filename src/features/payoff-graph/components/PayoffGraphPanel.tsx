import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Node,
  type NodeTypes,
} from '@xyflow/react'
import { memo, useCallback, useEffect, useMemo, type MouseEvent } from 'react'
import { useExplorerStore, useSelectedPath } from '../../../store/explorerStore'
import type { PayoffNodeId } from '../../shared/types'
import { PanelCard } from '../../shared/components/PanelCard'
import { buildGraphElements } from '../data/graphLayout'
import { PayoffGraphNode, type PayoffNodeData } from './PayoffGraphNode'

const nodeTypes: NodeTypes = {
  payoff: PayoffGraphNode as unknown as NodeTypes[string],
}

export const PayoffGraphPanel = memo(function PayoffGraphPanel() {
  const path = useSelectedPath()
  const selectedNodeId = useExplorerStore((s) => s.selectedNodeId)
  const setSelectedNodeId = useExplorerStore((s) => s.setSelectedNodeId)

  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => buildGraphElements(path, selectedNodeId),
    [path, selectedNodeId],
  )

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  useEffect(() => {
    const next = buildGraphElements(path, selectedNodeId)
    setNodes(next.nodes)
    setEdges(next.edges)
  }, [path, selectedNodeId, setNodes, setEdges])

  const onNodeClick = useCallback(
    (_: MouseEvent, node: Node) => {
      setSelectedNodeId(node.id as PayoffNodeId)
    },
    [setSelectedNodeId],
  )

  return (
    <PanelCard
      title="Payoff Graph"
      subtitle={`Traversal · ${path.traversal.join(' → ')}`}
      className="h-full"
      bodyClassName="relative"
    >
      <ReactFlow
        nodes={nodes as Node<PayoffNodeData>[]}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.4}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background color="#1e293b" gap={18} size={1} />
        <Controls
          showInteractive={false}
          className="!overflow-hidden !rounded !border !border-slate-600 !bg-panel"
        />
        <MiniMap
          nodeColor={(n) => {
            const state = (n.data as PayoffNodeData | undefined)?.state
            if (state === 'active') return '#22c55e'
            if (state === 'visited') return '#3b82f6'
            if (state === 'skipped') return '#334155'
            return '#64748b'
          }}
          maskColor="rgba(15,23,42,0.75)"
          className="!overflow-hidden !rounded !border !border-slate-600 !bg-bg"
        />
      </ReactFlow>
    </PanelCard>
  )
})
