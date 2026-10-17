// Layer 1/2/3 nets + transition/token detail panels (§5).
//
// The net draws the engine's canonical execution-graph topology
// (`data/netLayout.ts`): a left→right workflow of what the production graph
// runtime actually chains (worst-of → KO/KI gates → put/coupon/funding →
// aggregates), with the live `query_execution_net` token counts and firing
// probabilities overlaid. The three layers share the topology but style it
// differently: execution (structure + counts), risk (colour by Δ/ν impact +
// per-asset table), explain (colour by ledger pv impact + evidence).

import { ReactFlow, Background, Controls, ReactFlowProvider, Handle, Position, MarkerType, useNodesState, type Node, type Edge, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { memo, useEffect, useMemo, useState } from 'react'
import { useRigaExecutionNet, useRigaRiskNet, useRigaLedger, useRigaBranchStats, useRigaExecutionTape, useRigaPathCube, replayRigaPath } from '../hooks'
import {
  ENGINE_PLACE_TO_WORKFLOW,
  ENGINE_TO_WORKFLOW,
  WORKFLOW_TRANSITIONS,
  layoutWorkflow,
  transitionLabel,
  type Point,
} from '../data/netLayout'
import { transitionReference } from '../data/transitionReference'
import { useRigaSelectionStore } from '../../../store/rigaSelectionStore'
import { useObservabilityStore } from '../../../store/observabilityStore'
import { RigaPanel, DataTable, FormulaTag, num, pathIdentity, pct, EmptyTile, Kpi } from './primitives'
import { PanelCard } from '../../shared/components/PanelCard'
import type { ExecutionNet, LedgerEntry, PathRecord, RiskNet } from '../types'

type NetMode = 'execution' | 'risk' | 'explain'

interface NetNodeData extends Record<string, unknown> {
  label: string
  kind: 'place' | 'transition'
  tokens?: number
  probability?: number
  pvImpact?: number
  deltaImpact?: number
  vegaImpact?: number
  selected?: boolean
  mode: NetMode
  tint?: string
}

const PLACE_SIZE = 74
const TRANSITION_WIDTH = 150
const TRANSITION_HEIGHT = 50

/** Reverse map: workflow stage → the engine transition id that populates it. */
function engineIdFor(workflowId: string): string | undefined {
  return Object.entries(ENGINE_TO_WORKFLOW).find(([, workflow]) => workflow === workflowId)?.[0]
}

function liveTransition(net: ExecutionNet, workflowId: string) {
  return (
    net.transitions.find((t) => t.id === workflowId) ??
    (engineIdFor(workflowId) ? net.transitions.find((t) => t.id === engineIdFor(workflowId)!) : undefined)
  )
}

function liveStat(net: ExecutionNet, workflowId: string) {
  if (!Array.isArray(net.stats)) return undefined
  const stats = net.stats as Array<{ transitionId?: string; probability?: number }>
  const engineId = engineIdFor(workflowId)
  return stats.find((s) => s.transitionId === workflowId) ?? (engineId ? stats.find((s) => s.transitionId === engineId) : undefined)
}

/** Diverging tint from a signed impact, `unit` normalising the magnitude. */
function tint(value: number | undefined, unit: number): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value === 0) return undefined
  const alpha = Math.min(0.4, 0.08 + (Math.abs(value) / Math.max(unit, 1e-12)) * 0.32)
  return value > 0 ? `rgba(34,197,94,${alpha})` : `rgba(239,68,68,${alpha})`
}

/** Build the xyflow graph from the workflow topology + live overlays. */
export function buildNetGraph(
  net: ExecutionNet,
  mode: NetMode,
  selection: { transitionId: string | null; placeId: string | null },
  risk?: RiskNet,
  ledger?: LedgerEntry[],
): { nodes: Node<NetNodeData>[]; edges: Edge[] } {
  const riskMap = new Map((risk?.transitions ?? []).map((t) => [t.id, t]))
  const ledgerMap = new Map((ledger ?? []).map((entry) => [entry.transitionId, entry]))

  // Live token counts: `start` plus the mapped `{id}_out` places.
  const tokens = new Map<string, number>()
  for (const place of net.places) {
    tokens.set(place.id, place.tokens)
    const workflow = ENGINE_PLACE_TO_WORKFLOW[place.id]
    if (workflow) tokens.set(workflow, place.tokens)
  }

  const layout = layoutWorkflow()
  const placeStyle = { width: PLACE_SIZE, height: PLACE_SIZE }
  const transitionStyle = { width: TRANSITION_WIDTH, height: TRANSITION_HEIGHT }

  // Normalise risk magnitude for the tint.
  const maxRisk = Math.max(1e-12, ...(risk?.transitions ?? []).map((t) => Math.max(Math.abs(t.deltaImpact), Math.abs(t.vegaImpact))))
  const maxPv = Math.max(1e-12, ...(ledger ?? []).map((entry) => Math.abs(entry.pvImpact)), ...net.transitions.map((t) => Math.abs(t.pvImpact)))

  const nodes: Node<NetNodeData>[] = layout.nodes.map((item) => {
    if (item.kind === 'place') {
      return {
        id: `place:${item.id}`,
        type: 'rigaNet',
        position: item.position,
        style: placeStyle,
        data: {
          label: item.id,
          kind: 'place' as const,
          tokens: tokens.get(item.id),
          selected: selection.placeId === item.id,
          mode,
        },
      }
    }
    const live = liveTransition(net, item.id)
    const stat = liveStat(net, item.id)
    const engineId = engineIdFor(item.id)
    const riskEntry = riskMap.get(item.id) ?? (engineId ? riskMap.get(engineId) : undefined)
    const ledgerEntry = ledgerMap.get(item.id) ?? (engineId ? ledgerMap.get(engineId) : undefined)
    const deltaImpact = riskEntry?.deltaImpact ?? ledgerEntry?.deltaImpact
    const pvImpact = live?.pvImpact ?? ledgerEntry?.pvImpact
    return {
      id: `transition:${item.id}`,
      type: 'rigaNet',
      position: item.position,
      style: transitionStyle,
      data: {
        label: transitionLabel(item.id),
        kind: 'transition' as const,
        probability: live?.probability ?? stat?.probability,
        pvImpact,
        deltaImpact,
        vegaImpact: riskEntry?.vegaImpact ?? ledgerEntry?.vegaImpact,
        selected: selection.transitionId === item.id,
        mode,
        tint: mode === 'risk' ? tint(deltaImpact ?? riskEntry?.vegaImpact, maxRisk) : mode === 'explain' ? tint(pvImpact, maxPv) : undefined,
      },
    }
  })

  const arrow = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#64748b' }
  const edges: Edge[] = layout.edges.map((edge) => {
    const isTransitionSource = WORKFLOW_TRANSITIONS.some((t) => t.id === edge.from)
    const transition = WORKFLOW_TRANSITIONS.find((t) => t.id === edge.from)
    const probability = transition ? liveTransition(net, transition.id)?.probability : undefined
    return {
      id: edge.id,
      source: isTransitionSource ? `transition:${edge.from}` : `place:${edge.from}`,
      target: isTransitionSource ? `place:${edge.to}` : `transition:${edge.to}`,
      markerEnd: arrow,
      label: isTransitionSource && probability !== undefined ? pct(probability, 1) : undefined,
      labelStyle: { fill: '#94a3b8', fontSize: 9 },
      labelBgStyle: { fill: 'transparent' },
      style: {
        stroke: '#64748b',
        strokeWidth: isTransitionSource && probability !== undefined ? 1 + probability * 4 : 1.4,
      },
    }
  })

  return { nodes, edges }
}

function compact(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

const handleStyle = { width: 8, height: 8, background: '#64748b', border: '1px solid #0f172a' }

function RigaNetNode({ data, selected }: NodeProps) {
  const node = data as NetNodeData
  const isSelected = Boolean(selected) || Boolean(node.selected)
  const selectedClass = isSelected ? 'border-primary ring-2 ring-primary/60' : ''
  const riskTone = node.mode === 'risk' && (node.deltaImpact ?? 0) < 0 ? 'text-danger' : 'text-muted'

  if (node.kind === 'place') {
    return (
      <div
        className={`flex h-full w-full flex-col items-center justify-center overflow-hidden rounded-full border-2 bg-panel text-center shadow ${selectedClass || 'border-slate-500'}`}
        data-testid="riga-net-place"
      >
        <Handle type="target" position={Position.Left} style={handleStyle} />
        <Handle type="source" position={Position.Right} style={handleStyle} />
        <span className="line-clamp-2 px-1 text-[8px] leading-tight font-semibold text-main">{node.label}</span>
        <span className="font-mono text-[8px] text-muted">
          {node.tokens !== undefined ? `${compact(node.tokens)} tok` : 'n/a'}
        </span>
      </div>
    )
  }
  return (
    <div
      className={`flex h-full w-full flex-col items-center justify-center overflow-hidden rounded border bg-panel px-1 text-center shadow ${selectedClass || 'border-slate-600'}`}
      style={node.tint ? { backgroundColor: node.tint } : undefined}
      data-testid="riga-net-transition"
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />
      <span className="text-[9px] font-semibold text-primary">{node.label}</span>
      <span className={`font-mono text-[8px] ${riskTone}`}>
        {node.mode === 'risk'
          ? `Δ ${num(node.deltaImpact)} · v ${num(node.vegaImpact)}`
          : `${pct(node.probability, 1)} · pv ${num(node.pvImpact)}`}
      </span>
    </div>
  )
}

const nodeTypes = { rigaNet: RigaNetNode }

function NetCanvas({ net, mode, risk, ledger }: { net: ExecutionNet; mode: NetMode; risk?: RiskNet; ledger?: LedgerEntry[] }) {
  const selectTransition = useRigaSelectionStore((s) => s.selectTransition)
  const selectPlace = useRigaSelectionStore((s) => s.selectPlace)
  // Structure only — selection is handled by ReactFlow's own node state, so
  // dragging a node keeps its position (a selection change must not rebuild the
  // graph and snap the nodes back to the layout).
  const structural = useMemo(
    () => buildNetGraph(net, mode, { transitionId: null, placeId: null }, risk, ledger),
    [net, mode, risk, ledger],
  )
  const [nodes, setNodes, onNodesChange] = useNodesState(structural.nodes)

  // Reset positions only when the data/topology changes (new run, mode switch).
  useEffect(() => {
    setNodes(structural.nodes)
  }, [structural, setNodes])

  return (
    <div className="relative h-full min-h-[260px] w-full" data-testid="riga-net-canvas">
      <ReactFlow
        nodes={nodes}
        edges={structural.edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.15}
        nodesConnectable={false}
        nodesDraggable
        elementsSelectable
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_event, node) => {
          const [kind, id] = node.id.split(':') as ['place' | 'transition', string]
          if (kind === 'place') {
            selectPlace(id)
            selectTransition(null)
          } else {
            selectTransition(id)
            selectPlace(null)
          }
        }}
      >
        <Background />
        <Controls className="react-flow-controls-themed" showInteractive={false} />
      </ReactFlow>
      <button
        type="button"
        className="shock-button absolute top-1.5 right-1.5 z-10"
        title="Restore the computed layout after dragging nodes"
        onClick={() => setNodes(structural.nodes)}
      >
        reset layout
      </button>
    </div>
  )
}

export const PayoffPetriNetTile = memo(function PayoffPetriNetTile() {
  const state = useRigaExecutionNet()
  return (
    <RigaPanel title="Payoff Petri Net" subtitle="Layer 1 — execution workflow" tool="query_execution_net" runId={state.data?.runId} state={state}>
      {(net) => (
        <ReactFlowProvider>
          <NetCanvas net={net} mode="execution" />
        </ReactFlowProvider>
      )}
    </RigaPanel>
  )
})

export const RiskNetTile = memo(function RiskNetTile() {
  const state = useRigaRiskNet()
  const net = useRigaExecutionNet()
  return (
    <RigaPanel title="Risk Net" subtitle="Layer 2 — risk propagation (Δ/ν heat)" tool="query_risk_net" state={state}>
      {(risk) =>
        net.data ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
              <ReactFlowProvider>
                <NetCanvas net={net.data} mode="risk" risk={risk} />
              </ReactFlowProvider>
            </div>
            <div className="shrink-0 border-t border-line p-2">
              <div className="mb-2 flex flex-wrap gap-2">
                <Kpi label="DV01" value={num(risk.dv01)} />
                <Kpi label="Correlation ρ" value={num(risk.correlationSensitivity)} tone="warning" />
                <span className="ml-auto self-center text-[9px] text-muted">node tint = signed Δ / ν impact</span>
              </div>
              <DataTable
                columns={[
                  { key: 'assetIndex', label: 'Asset', render: (row) => `#${row.assetIndex}` },
                  { key: 'delta', label: 'Delta', render: (row) => num(row.delta) },
                  { key: 'gamma', label: 'Gamma', render: (row) => num(row.gamma) },
                  { key: 'vega', label: 'Vega', render: (row) => num(row.vega, 4) },
                ]}
                rows={risk.perAsset ?? []}
                empty="No per-asset Greeks"
              />
            </div>
          </div>
        ) : (
          <div className="p-3 text-xs text-muted">Execution net unavailable</div>
        )
      }
    </RigaPanel>
  )
})

export const ExplainNetTile = memo(function ExplainNetTile() {
  const state = useRigaLedger()
  const net = useRigaExecutionNet()
  return (
    <RigaPanel title="Explain Net" subtitle="Layer 3 — ledger overlay" tool="get_ledger" state={state}>
      {(ledger) =>
        net.data ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
              <ReactFlowProvider>
                <NetCanvas net={net.data} mode="explain" ledger={ledger.ledger} />
              </ReactFlowProvider>
            </div>
            <div className="shrink-0 border-t border-line p-2">
              <span className="text-[9px] text-muted">node tint = signed ledger pv_impact</span>
            </div>
          </div>
        ) : (
          <div className="p-3 text-xs text-muted">Execution net unavailable</div>
        )
      }
    </RigaPanel>
  )
})

export const TransitionDetailTile = memo(function TransitionDetailTile() {
  const selectedTransitionId = useRigaSelectionStore((s) => s.selectedTransitionId)
  const net = useRigaExecutionNet()
  const stats = useRigaBranchStats()
  const risk = useRigaRiskNet()
  const ledger = useRigaLedger()

  if (!selectedTransitionId) {
    return (
      <EmptyTile
        title="Transition Detail"
        subtitle="Select a transition in the net"
        message="Click a transition (the blue boxes) in the Payoff Petri Net, Risk Net or Explain Net to inspect its logic, populations, PV impact and evidence."
      />
    )
  }
  const engineId = engineIdFor(selectedTransitionId)
  const reference = transitionReference(selectedTransitionId) ?? (engineId ? transitionReference(engineId) : undefined)
  const live = liveTransition(net.data ?? ({} as ExecutionNet), selectedTransitionId)
  const stat =
    stats.data?.find((s) => s.transitionId === selectedTransitionId) ??
    (engineId ? stats.data?.find((s) => s.transitionId === engineId) : undefined)
  const riskEntry = risk.data?.transitions.find((t) => t.id === selectedTransitionId) ?? (engineId ? risk.data?.transitions.find((t) => t.id === engineId) : undefined)
  const ledgerEntry = ledger.data?.ledger.find((e) => e.transitionId === selectedTransitionId) ?? (engineId ? ledger.data?.ledger.find((e) => e.transitionId === engineId) : undefined)

  return (
    <PanelCard title="Transition Detail" subtitle={selectedTransitionId} className="h-full" bodyClassName="overflow-auto">
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Kpi label="Population before" value={ledgerEntry?.populationBefore ?? live?.populationBefore ?? '—'} />
          <Kpi label="Population after" value={ledgerEntry?.populationAfter ?? live?.populationAfter ?? '—'} />
          <Kpi label="Probability" value={pct(live?.probability ?? (stat as { probability?: number } | undefined)?.probability)} tone="primary" />
          <Kpi label="PV impact" value={num(live?.pvImpact ?? ledgerEntry?.pvImpact)} tone={(live?.pvImpact ?? 0) < 0 ? 'danger' : 'success'} />
          <Kpi label="Delta impact" value={num(riskEntry?.deltaImpact ?? ledgerEntry?.deltaImpact)} />
          <Kpi label="Vega impact" value={num(riskEntry?.vegaImpact ?? ledgerEntry?.vegaImpact)} />
        </div>
        {stat ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Kpi label="Mean payoff" value={num((stat as { meanPayoff?: number }).meanPayoff)} />
            <Kpi label="Variance" value={num((stat as { variancePayoff?: number }).variancePayoff)} />
          </div>
        ) : null}
        <div>
          <p className="eyebrow mb-1">Condition</p>
          <p className="text-xs text-main">{live?.condition ?? ledgerEntry?.condition ?? '—'}</p>
        </div>
        {reference ? (
          <div>
            <p className="eyebrow mb-1">Reference formula</p>
            <FormulaTag>{reference.formula}</FormulaTag>
            {reference.note ? <p className="mt-1 text-[10px] text-muted">{reference.note}</p> : null}
          </div>
        ) : null}
        <div>
          <p className="eyebrow mb-1">Evidence</p>
          <div className="flex flex-wrap gap-1">
            {(ledgerEntry?.evidenceRefs ?? []).length === 0 ? (
              <span className="text-[10px] text-muted">No evidence refs</span>
            ) : (
              ledgerEntry!.evidenceRefs.map((ref) => (
                <span key={ref} className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary">
                  {ref}
                </span>
              ))
            )}
          </div>
        </div>
      </div>
    </PanelCard>
  )
})

export const TokenDetailTile = memo(function TokenDetailTile() {
  const selectedPlaceId = useRigaSelectionStore((s) => s.selectedPlaceId)
  const level = useObservabilityStore((s) => s.level)
  const net = useRigaExecutionNet()
  const tape = useRigaExecutionTape()
  const cube = useRigaPathCube(0.05)
  const [replayed, setReplayed] = useState<PathRecord | null>(null)
  const [replayError, setReplayError] = useState<string | null>(null)

  if (!selectedPlaceId) {
    return (
      <EmptyTile
        title="Token Detail"
        subtitle="Select a place in the net"
        message="Click a place (the round marks) in the Payoff Petri Net to list a bounded sample of the tokens it holds."
      />
    )
  }
  if (level === 'off') {
    return (
      <EmptyTile
        title="Token Detail"
        subtitle={selectedPlaceId}
        message="trace off — aggregate only. Raise the trace level to Sampled or Full in the title bar to inspect tokens."
      />
    )
  }

  const directId = Object.entries(ENGINE_PLACE_TO_WORKFLOW).find(([, workflow]) => workflow === selectedPlaceId)?.[0]
  const place = net.data?.places.find((p) => p.id === selectedPlaceId || p.id === directId)
  const tokens = place?.tokens
  const sampled: PathRecord[] = cube.data?.sample ?? []

  return (
    <PanelCard
      title="Token Detail"
      subtitle={`${selectedPlaceId} · sampled tokens (bounded)`}
      className="h-full"
      bodyClassName="overflow-auto"
      actions={<span className="text-[9px] text-muted">cap {cube.data?.sample?.length ?? 16}</span>}
    >
      <div className="space-y-2 p-3">
        <div className="flex flex-wrap gap-2">
          <Kpi label="Tokens in place" value={tokens !== undefined ? tokens.toLocaleString() : 'n/a'} tone="primary" />
          <Kpi label="Tape size" value={tape.data?.tapeSize ?? '—'} />
          <Kpi label="Worst-5% sample" value={sampled.length} />
        </div>
        <p className="text-[10px] text-muted">
          riga-flow returns counts per place, not full token vectors (R-EXT-2). The sample below is composed
          from <span className="font-mono">query_path_cube</span> worst-tail records and{" "}
          <span className="font-mono">execution_events</span>.
        </p>
        <DataTable
          columns={[
            { key: 'pathId', label: 'Path', render: (row) => String(pathIdentity(row).pathId ?? '—') },
            { key: 'worstFinal', label: 'Worst final', render: (row) => num(row.worstFinal) },
            { key: 'knockedOut', label: 'KO', render: (row) => (row.knockedOut ? `t=${row.koTime ?? '—'}` : 'no') },
            { key: 'kiHit', label: 'KI', render: (row) => (row.kiHit ? 'yes' : 'no') },
            { key: 'putPayoff', label: 'Put', render: (row) => num(row.putPayoff) },
            { key: 'pv', label: 'PV', render: (row) => num(row.pv) },
            {
              key: 'action',
              label: '',
              render: (row) => (
                <button
                  type="button"
                  className="shock-button"
                  onClick={async () => {
                    setReplayError(null)
                    try {
                      setReplayed(await replayRigaPath(String(pathIdentity(row).pathId)))
                    } catch (e) {
                      setReplayError((e as { message?: string }).message ?? String(e))
                    }
                  }}
                >
                  replay
                </button>
              ),
            },
          ]}
          rows={sampled}
          empty="No sampled tokens"
        />
        {replayError ? <p className="text-[10px] text-danger">{replayError}</p> : null}
        {replayed ? (
          <div className="rounded border border-line bg-surface p-2">
            <p className="eyebrow">Replayed path {String(pathIdentity(replayed).pathId)}</p>
            <div className="mt-1 grid grid-cols-3 gap-2">
              <Kpi label="Worst final" value={num(replayed.worstFinal)} />
              <Kpi label="Put payoff" value={num(replayed.putPayoff)} />
              <Kpi label="PV" value={num(replayed.pv)} />
            </div>
          </div>
        ) : null}
      </div>
    </PanelCard>
  )
})

export const RigaDataLineageTile = memo(function RigaDataLineageTile() {
  const state = useRigaLedger()
  const runId = state.data?.determinism.marketSnapshotId
  return (
    <RigaPanel title="Data Lineage" subtitle="determinism + evidence graph" tool="get_ledger" runId={runId} state={state}>
      {(ledger) => (
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-3 gap-2">
            <Kpi label="Seed" value={ledger.determinism.seed} />
            <Kpi label="As of" value={ledger.determinism.asOf} />
            <Kpi label="Market id" value={ledger.determinism.marketSnapshotId} />
          </div>
          <p className="text-[10px] text-muted">trade → market (sha256) → seed → transitions</p>
          <DataTable
            columns={[
              { key: 'transitionId', label: 'Transition' },
              { key: 'condition', label: 'Condition' },
              { key: 'evidenceRefs', label: 'Evidence', render: (row) => row.evidenceRefs.join(', ') || '—' },
            ]}
            rows={ledger.ledger}
            empty="No ledger entries"
          />
        </div>
      )}
    </RigaPanel>
  )
})

export type { Point }
