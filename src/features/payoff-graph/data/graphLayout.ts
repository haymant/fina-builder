import type { Edge, Node } from '@xyflow/react'
import type { NodeState, PayoffNodeId, SimulationPath } from '../../shared/types'
import type { PayoffNodeData } from '../components/PayoffGraphNode'

const NODE_META: { id: PayoffNodeId; label: string; x: number; y: number }[] = [
  { id: 'PathCube', label: 'PathCube', x: 0, y: 120 },
  { id: 'FixingSchedule', label: 'FixingSchedule', x: 180, y: 40 },
  { id: 'WorstOfPerformance', label: 'WorstOfPerformance', x: 180, y: 140 },
  { id: 'KnockInGate', label: 'KnockInGate', x: 380, y: 40 },
  { id: 'GlobalKOGate', label: 'GlobalKOGate', x: 380, y: 140 },
  { id: 'RangeAccrual', label: 'RangeAccrual', x: 580, y: 20 },
  { id: 'CouponStrip', label: 'CouponStrip', x: 580, y: 100 },
  { id: 'MemoryCarry', label: 'MemoryCarry', x: 580, y: 180 },
  { id: 'DownAndInPut', label: 'DownAndInPut', x: 780, y: 40 },
  { id: 'Redemption', label: 'Redemption', x: 780, y: 140 },
  { id: 'Discount', label: 'Discount', x: 980, y: 100 },
  { id: 'AggregatePV', label: 'AggregatePV', x: 1160, y: 100 },
]

const EDGE_DEFS: [PayoffNodeId, PayoffNodeId][] = [
  ['PathCube', 'FixingSchedule'],
  ['PathCube', 'WorstOfPerformance'],
  ['FixingSchedule', 'KnockInGate'],
  ['WorstOfPerformance', 'KnockInGate'],
  ['WorstOfPerformance', 'GlobalKOGate'],
  ['KnockInGate', 'RangeAccrual'],
  ['KnockInGate', 'DownAndInPut'],
  ['GlobalKOGate', 'CouponStrip'],
  ['GlobalKOGate', 'MemoryCarry'],
  ['GlobalKOGate', 'Redemption'],
  ['RangeAccrual', 'CouponStrip'],
  ['CouponStrip', 'MemoryCarry'],
  ['MemoryCarry', 'Redemption'],
  ['DownAndInPut', 'Redemption'],
  ['Redemption', 'Discount'],
  ['Discount', 'AggregatePV'],
]

function resolveState(
  nodeId: PayoffNodeId,
  path: SimulationPath,
  selectedNodeId: PayoffNodeId,
): NodeState {
  const traversal = path.traversal
  const idx = traversal.indexOf(nodeId)
  if (idx === -1) return 'skipped'
  if (nodeId === selectedNodeId) return 'active'
  return 'visited'
}

export function buildGraphElements(
  path: SimulationPath,
  selectedNodeId: PayoffNodeId,
): { nodes: Node<PayoffNodeData>[]; edges: Edge[] } {
  const traversalSet = new Set(path.traversal)

  const nodes: Node<PayoffNodeData>[] = NODE_META.map((meta) => {
    const detail = path.nodeDetails[meta.id]
    const state = resolveState(meta.id, path, selectedNodeId)
    return {
      id: meta.id,
      type: 'payoff',
      position: { x: meta.x, y: meta.y },
      data: {
        label: meta.label,
        nodeId: meta.id,
        state,
        isLossRelated: detail?.isLossRelated ?? false,
        isSelected: meta.id === selectedNodeId,
      },
      selectable: true,
    }
  })

  const edges: Edge[] = EDGE_DEFS.map(([source, target], i) => {
    const onPath =
      traversalSet.has(source) &&
      traversalSet.has(target) &&
      path.traversal.indexOf(source) < path.traversal.indexOf(target)
    return {
      id: `e-${i}`,
      source,
      target,
      animated: onPath,
      style: {
        stroke: onPath ? '#3b82f6' : '#334155',
        strokeWidth: onPath ? 2.2 : 1,
        opacity: onPath ? 1 : 0.25,
      },
    }
  })

  return { nodes, edges }
}
