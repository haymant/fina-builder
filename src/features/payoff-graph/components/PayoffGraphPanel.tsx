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
import { useTheme } from '../../themes/ThemeProvider'
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
  const { tokens, mode } = useTheme()

  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () => buildGraphElements(path, selectedNodeId),
    [path, selectedNodeId],
  )

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  useEffect(() => {
    const next = buildGraphElements(path, selectedNodeId)
    next.edges = next.edges.map((edge) => ({
      ...edge,
      style: { ...edge.style, stroke: edge.animated ? tokens.primary : tokens.border },
    }))
    setNodes(next.nodes)
    setEdges(next.edges)
  }, [path, selectedNodeId, setNodes, setEdges, tokens])

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
        colorMode={mode}
      >
        <Background color={tokens.grid} gap={18} size={1} />
        <Controls
          showInteractive={false}
          className="react-flow-controls-themed !overflow-hidden !rounded"
        />
        <MiniMap
          nodeColor={(n) => {
            const state = (n.data as PayoffNodeData | undefined)?.state
            if (state === 'active') return tokens.success
            if (state === 'visited') return tokens.primary
            if (state === 'skipped') return tokens.border
            return tokens.muted
          }}
          maskColor={mode === 'dark' ? 'rgba(15,23,42,0.75)' : 'rgba(248,250,252,0.75)'}
          className="react-flow-minimap-themed !overflow-hidden !rounded"
        />
      </ReactFlow>
    </PanelCard>
  )
})
