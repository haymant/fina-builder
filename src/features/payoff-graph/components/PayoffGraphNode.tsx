import clsx from 'clsx'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { memo } from 'react'
import type { NodeState, PayoffNodeId } from '../../shared/types'

export interface PayoffNodeData {
  label: string
  nodeId: PayoffNodeId
  state: NodeState
  isLossRelated: boolean
  isSelected: boolean
  [key: string]: unknown
}

const stateStyles: Record<NodeState, string> = {
  idle: 'border-slate-600 bg-slate-800/60 text-slate-400 opacity-40',
  visited: 'border-primary/70 bg-primary/15 text-slate-100',
  active: 'border-success bg-success/15 text-slate-50',
  skipped: 'border-slate-700 bg-slate-900/50 text-slate-500 opacity-30 line-through',
}

export const PayoffGraphNode = memo(function PayoffGraphNode({
  data,
}: NodeProps & { data: PayoffNodeData }) {
  const glow =
    data.state === 'active'
      ? data.isLossRelated
        ? 'animate-[node-glow-danger_2s_ease-in-out_infinite]'
        : 'animate-[node-glow-active_2s_ease-in-out_infinite]'
      : data.state === 'visited'
        ? data.isLossRelated
          ? 'animate-[node-glow-danger_2.4s_ease-in-out_infinite]'
          : 'animate-[node-glow_2.4s_ease-in-out_infinite]'
        : ''

  return (
    <div
      className={clsx(
        'min-w-[128px] rounded-md border px-3 py-2 shadow-md transition-all duration-300',
        stateStyles[data.state],
        data.isLossRelated &&
          (data.state === 'visited' || data.state === 'active') &&
          'border-danger/80 bg-danger/15 text-red-100',
        data.isSelected && 'ring-2 ring-white/80 ring-offset-1 ring-offset-bg',
        glow,
      )}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-0 !bg-primary"
      />
      <div className="text-[10px] font-semibold tracking-wide uppercase">{data.label}</div>
      <div className="mt-0.5 font-mono text-[9px] text-muted">{data.state}</div>
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-0 !bg-primary"
      />
    </div>
  )
})
