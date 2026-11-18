// The Phoenix terminal-outcome tree (PheonixPayoff.md Diagram 2) as a Petri net
// (docs/49 P3g-vi). Three determinants are drawn as three visual channels:
//
//   • trade rails  → dashed/dimmed nodes and arcs that this trade cannot reach
//   • population   → arc width + percentage, from query_execution_net
//   • selected path → amber animated route + ringed terminal bucket
//
// Traversal itself is *not* path-only: the trade fixes the gate wiring (which KO
// bucket, whether a call region exists), the population decides how many paths
// take each arc, and the path only picks one route. The tile keeps those apart
// instead of implying a single cause.

import { Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, type Node, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { memo } from 'react'
import { useRigaExecutionNet, useSelectedPathRecord } from '../hooks'
import { useInstrumentStore } from '../../../store/instrumentStore'
import { useTheme } from '../../themes/ThemeProvider'
import {
  DISABLED_STRIKE,
  PAYOFF_TREE,
  koPayoffId,
  reachableTerminals,
  resolvePayoffRoute,
  type KoKind,
  type PayoffId,
  type PayoffRails,
  type PayoffTreeNode,
} from '../data/payoffTree'
import { Kpi, num, pct, RigaPanel } from './primitives'
import { AutoFit } from './AutoFit'

interface TreeData extends Record<string, unknown> {
  label: string
  kind: 'place' | 'transition'
  payoffId?: PayoffId
  unreachable?: boolean
  selected?: boolean
}

const handleStyle = { width: 7, height: 7, background: '#64748b', border: '1px solid #0f172a' }

function TreePlaceNode({ data }: NodeProps) {
  const node = data as TreeData
  const ring = node.selected
    ? 'border-warning ring-2 ring-warning/60'
    : node.unreachable
      ? 'border-dashed border-slate-600 opacity-55'
      : 'border-slate-500'
  const terminal = node.payoffId !== undefined
  return (
    <div
      className={`flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-full border-2 bg-panel text-center shadow ${ring}`}
      data-testid="payoff-tree-place"
      data-payoff={node.payoffId}
      data-unreachable={node.unreachable ? '1' : undefined}
      title={node.unreachable ? 'Not reachable for this trade' : node.label}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />
      <span className={`line-clamp-3 px-1 text-[8px] leading-tight font-semibold ${terminal ? 'text-main' : 'text-muted'}`}>
        {node.label}
      </span>
      {node.unreachable ? <span className="text-[7px] text-muted">unreachable</span> : null}
    </div>
  )
}

function TreeTransitionNode({ data }: NodeProps) {
  const node = data as TreeData
  return (
    <div
      className="flex h-full w-full items-center justify-center overflow-hidden rounded border border-slate-600 bg-panel px-1 text-center shadow"
      data-testid="payoff-tree-transition"
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />
      <span className="line-clamp-2 text-[8px] leading-tight font-semibold text-primary">{node.label}</span>
    </div>
  )
}

const nodeTypes = { treePlace: TreePlaceNode, treeTransition: TreeTransitionNode }

export const RigaPayoffTreeTile = memo(function RigaPayoffTreeTile() {
  const state = useRigaExecutionNet()
  const selectedPath = useSelectedPathRecord()
  const document = useInstrumentStore((s) => s.document)
  const { tokens } = useTheme()

  return (
    <RigaPanel
      title="Payoff Tree"
      subtitle="query_execution_net · P01–P08 decision tree · selected path route"
      tool="query_execution_net"
      state={state}
    >
      {(net) => {
        const put = document.legs.find((leg) => leg.kind === 'put')?.put
        const koKind: KoKind = put?.knockOutKind === 'local' ? 'local' : put?.knockOutKind === 'none' ? 'none' : 'global'
        const koId = koPayoffId(koKind, put?.memoryCoupon ?? false)
        const callRaw = put?.rails.lowCallStrik
        const maturityRaw = put?.rails.maturBarrier
        const rails: PayoffRails = {
          koPayoffId: koId,
          callStrike: callRaw !== null && callRaw !== undefined && callRaw < DISABLED_STRIKE ? callRaw : null,
          knockInBarrier: put?.knockInBarrier ?? 0,
          maturityBarrier:
            maturityRaw !== null && maturityRaw !== undefined && maturityRaw < DISABLED_STRIKE ? maturityRaw : null,
        }
        const reachable = reachableTerminals(rails)
        const path = selectedPath.data
        const route = resolvePayoffRoute(path, rails)

        // Populations the engine actually reports on this trade's arcs.
        const byId = new Map(net.transitions.map((transition) => [transition.id, transition]))
        const ko = byId.get('daily_global_ko')
        const putTransition = byId.get('final_fixing_eki')
        const paths = ko?.populationBefore ?? 0
        const koPaths = ko?.populationAfter ?? 0
        const survive = Math.max(paths - koPaths, 0)
        const kiPaths = Math.min(putTransition?.populationAfter ?? 0, survive)
        const noKi = Math.max(survive - kiPaths, 0)
        // When a call region exists the reported KI count no longer isolates the
        // KI/no-KI split (P05 paths are in the surviving pool), so don't label it.
        const callEnabled = rails.callStrike !== null
        const populations: Record<string, number | null> = {
          ko: koPaths > 0 ? koPaths : null,
          survive: survive > 0 ? survive : null,
          ki: !callEnabled && kiPaths > 0 ? kiPaths : null,
          'no-ki': !callEnabled && noKi > 0 ? noKi : null,
        }
        const maxPopulation = Math.max(1, koPaths, survive, kiPaths, noKi)
        const routeEdgeIds = new Set(route?.edges ?? [])
        const unreachableTerminals = new Set(
          PAYOFF_TREE.nodes
            .filter((node) => node.payoffId !== undefined && !reachable[node.payoffId])
            .map((node) => node.id),
        )

        const nodes: Node<TreeData>[] = PAYOFF_TREE.nodes.map((node: PayoffTreeNode) => {
          const terminal = node.payoffId !== undefined
          return {
            id: `${node.kind}:${node.id}`,
            type: node.kind === 'place' ? 'treePlace' : 'treeTransition',
            position: node.position,
            style: node.kind === 'place' ? { width: terminal ? 84 : 70, height: terminal ? 84 : 70 } : { width: 120, height: 42 },
            data: {
              label: node.label,
              kind: node.kind,
              payoffId: node.payoffId,
              unreachable: terminal && unreachableTerminals.has(node.id),
              selected: route !== null && node.payoffId === route.payoffId,
            },
            draggable: false,
          }
        })
        const kinds = new Map(PAYOFF_TREE.nodes.map((node) => [node.id, node.kind]))
        const edges = PAYOFF_TREE.edges.map((edge) => {
          const fromKind = kinds.get(edge.from) ?? 'place'
          const toKind = kinds.get(edge.to) ?? 'transition'
          const hot = routeEdgeIds.has(edge.id)
          const dead = unreachableTerminals.has(edge.to)
          const population = edge.population ? populations[edge.population] : null
          const width = population === null ? 1.2 : 1 + 4 * Math.sqrt(population / maxPopulation)
          return {
            id: edge.id,
            source: `${fromKind}:${edge.from}`,
            target: `${toKind}:${edge.to}`,
            animated: hot,
            label:
              population !== null && paths > 0 && !dead
                ? `${pct(population / paths, 1)}`
                : undefined,
            labelStyle: { fill: tokens.muted, fontSize: 8 },
            labelBgStyle: { fill: 'transparent' },
            markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13, color: hot ? tokens.warning : '#64748b' },
            style: hot
              ? { stroke: tokens.warning, strokeWidth: 2.4 }
              : dead
                ? { stroke: '#64748b', strokeWidth: 1.3, strokeDasharray: '5 4', opacity: 0.4 }
                : { stroke: '#64748b', strokeWidth: width, opacity: population === null ? 0.7 : 0.95 },
          }
        })

        return (
          <div className="flex h-full min-h-0 flex-col">
            <div className="grid shrink-0 grid-cols-2 gap-2 p-3 sm:grid-cols-4">
              <Kpi label="Paths" value={num(paths, 0)} />
              <Kpi label="KO" value={num(koPaths, 0)} tone="success" />
              <Kpi label="Survive" value={num(survive, 0)} />
              <Kpi label="Terminal" value={route ? route.payoffId : '—'} tone="primary" />
            </div>
            <div className="relative min-h-[300px] flex-1" data-testid="payoff-tree-canvas">
              <ReactFlowProvider>
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable={false}
                  fitView
                  fitViewOptions={{ padding: 0.06 }}
                  minZoom={0.25}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background />
                  <Controls className="react-flow-controls-themed" showInteractive={false} />
                  <AutoFit padding={0.06} />
                </ReactFlow>
              </ReactFlowProvider>
            </div>
            <div className="shrink-0 space-y-1 border-t border-line px-3 py-2 text-[9px] text-muted">
              {route ? (
                <p className="text-warning" data-testid="payoff-tree-route">
                  Path #{path?.identity?.pathId ?? '—'} → {route.payoffId}
                  {path?.knockedOut
                    ? ` · knocked out at t=${num(path.koTime, 4)}`
                    : path?.kiHit
                      ? ` · KI hit · terminal worst-of ${num(path.worstFinal)}`
                      : ` · no KI · terminal worst-of ${num(path?.worstFinal)}`}
                  . The trade fixes the gate wiring; this path supplies the outcome.
                </p>
              ) : (
                <p>Select a path to trace its route through the tree.</p>
              )}
              <p>
                Solid = reachable for this trade · dashed = not reachable · arc width = population share. Amber = the
                selected path.
              </p>
              {!reachable.P05 ? <p>P05 unreachable: the lower call strike is disabled.</p> : null}
              {!reachable.P06 ? (
                <p>P06 unreachable: the maturity barrier is above the knock-in barrier, so every KI path is below it.</p>
              ) : null}
            </div>
          </div>
        )
      }}
    </RigaPanel>
  )
})
