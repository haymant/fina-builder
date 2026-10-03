import { memo, useMemo } from 'react'
import { useExplorerStore, useSelectedPath } from '../../../store/explorerStore'
import { PanelCard } from '../../shared/components/PanelCard'
import { PanelLoading } from '../../shared/components/AsyncPanel'
import { StatsBadge } from '../../shared/components/StatsBadge'

export const NodeDetailPanel = memo(function NodeDetailPanel() {
  const path = useSelectedPath()
  const selectedNodeId = useExplorerStore((s) => s.selectedNodeId)
  const selectedDateIndex = useExplorerStore((s) => s.selectedDateIndex)

  const detail = path?.nodeDetails[selectedNodeId]
  const obs = path?.observations[selectedDateIndex]

  const liveInput = useMemo(() => {
    if (!detail) return '—'
    if (!obs) return detail.inputValue
    if (selectedNodeId === 'WorstOfPerformance') {
      return `Wo = ${(obs.worstOfPerformance * 100).toFixed(1)}% @ ${obs.date}`
    }
    if (selectedNodeId === 'KnockInGate') {
      return `${(obs.worstOfPerformance * 100).toFixed(1)}%`
    }
    if (selectedNodeId === 'GlobalKOGate') {
      return `${(obs.worstOfPerformance * 100).toFixed(1)}%`
    }
    if (selectedNodeId === 'MemoryCarry') {
      return `${obs.couponMemoryBalance.toFixed(2)}`
    }
    return detail.inputValue
  }, [detail, obs, selectedNodeId])

  if (!path || !detail) {
    return (
      <PanelLoading
        title="Node Details"
        subtitle="Node-level probability and decision detail"
      />
    )
  }

  return (
    <PanelCard
      title="Node Details"
      subtitle={detail.name}
      className="h-full"
      bodyClassName="overflow-auto p-3"
    >
      <div className="space-y-3">
        <div>
          <div className="text-[10px] tracking-wider text-muted uppercase">Node</div>
          <div className="text-sm font-semibold text-slate-100">{detail.name}</div>
        </div>

        <p className="text-xs leading-relaxed text-slate-400">{detail.description}</p>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded border border-slate-700 bg-bg/60 p-2">
            <div className="text-[9px] text-muted uppercase">Input Value</div>
            <div className="mt-0.5 font-mono text-xs text-primary">{liveInput}</div>
          </div>
          <div className="rounded border border-slate-700 bg-bg/60 p-2">
            <div className="text-[9px] text-muted uppercase">Decision Rule</div>
            <div className="mt-0.5 font-mono text-xs text-slate-200">{detail.decisionRule}</div>
          </div>
          <div className="rounded border border-slate-700 bg-bg/60 p-2">
            <div className="text-[9px] text-muted uppercase">Output</div>
            <div
              className={`mt-0.5 font-mono text-xs font-semibold ${
                detail.isLossRelated ? 'text-danger' : 'text-success'
              }`}
            >
              {detail.output}
            </div>
          </div>
          <div className="rounded border border-slate-700 bg-bg/60 p-2">
            <div className="text-[9px] text-muted uppercase">Affected Paths</div>
            <div className="mt-0.5 font-mono text-xs text-slate-200">
              {detail.affectedPaths.toLocaleString()}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <StatsBadge
            label="Probability"
            value={`${(detail.probability * 100).toFixed(1)}%`}
            tone="primary"
          />
          <StatsBadge
            label="Cond. E[Payoff]"
            value={detail.conditionalExpectedPayoff.toFixed(1)}
            tone={detail.conditionalExpectedPayoff < 100 ? 'warning' : 'success'}
          />
          {obs ? (
            <StatsBadge
              label="Date Index"
              value={selectedDateIndex}
              tone="default"
            />
          ) : null}
        </div>

        {obs ? (
          <div className="rounded border border-slate-700/80 bg-slate-900/50 p-2">
            <div className="mb-1 text-[9px] tracking-wider text-muted uppercase">
              Observation Snapshot
            </div>
            <div className="grid grid-cols-3 gap-1 font-mono text-[10px] text-slate-300">
              <span>AAPL {(obs.aapl * 100).toFixed(1)}%</span>
              <span>MSFT {(obs.msft * 100).toFixed(1)}%</span>
              <span>NVDA {(obs.nvda * 100).toFixed(1)}%</span>
            </div>
          </div>
        ) : null}
      </div>
    </PanelCard>
  )
})
