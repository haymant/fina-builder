// riga-flow branch-flow tile (docs/49 P3g-iv) — the Phoenix payoff decision tree
// (`modules/riga-flow/skills/riga-flow/refs/PheonixPayoff.md`, Diagram 2) with the
// live transition populations from `query_execution_net`.
//
// The tree: Coupon Leg → KO? → {P01..P04} | maturity → (WPS ≥ LowerCallStrike) →
// P05 | KI? → {P06 | P07 | P08}. The coupon leg is additive on every branch
// (`FinalPayoff = CouponLeg + OptionLeg + ReturnRatio`), so it is a KPI, not a flow.

import { memo } from 'react'
import { useRigaExecutionNet } from '../hooks'
import { useInstrumentStore } from '../../../store/instrumentStore'
import { useTheme } from '../../themes/ThemeProvider'
import Chart from '../../shared/components/Chart'
import { Kpi, num, RigaPanel } from './primitives'

/** The Murex sentinel for a disabled call strike / barrier. */
const DISABLED = 900

type KoKind = 'global' | 'local' | 'none'

/** The payoff id the current trade resolves to on the KO branch. */
function koPayoffId(kind: KoKind, memory: boolean): string | null {
  if (kind === 'none') return null
  if (kind === 'global') return memory ? 'P01' : 'P03'
  return memory ? 'P02' : 'P04'
}

function koScenario(id: string | null): string {
  switch (id) {
    case 'P01':
      return 'Global Memory KO'
    case 'P02':
      return 'Local Memory KO'
    case 'P03':
      return 'Global KO'
    case 'P04':
      return 'Local KO'
    default:
      return 'KO'
  }
}

export const RigaBranchFlowTile = memo(function RigaBranchFlowTile() {
  const state = useRigaExecutionNet()
  const document = useInstrumentStore((s) => s.document)
  const { tokens } = useTheme()

  return (
    <RigaPanel
      title="Branch Flow"
      subtitle="Phoenix payoff decision tree · query_execution_net populations"
      tool="query_execution_net"
      state={state}
    >
      {(data) => {
        const put = document.legs.find((leg) => leg.kind === 'put')?.put
        const koKind: KoKind = put?.knockOutKind === 'local' ? 'local' : put?.knockOutKind === 'none' ? 'none' : 'global'
        const memory = put?.memoryCoupon ?? false
        const koId = koPayoffId(koKind, memory)

        const byId = new Map((data.transitions ?? []).map((t) => [t.id, t]))
        const ko = byId.get('daily_global_ko')
        const putTransition = byId.get('final_fixing_eki')
        const coupon = byId.get('memory_coupon')

        const paths = ko?.populationBefore ?? 0
        const koPaths = ko?.populationAfter ?? 0
        const survive = Math.max(paths - koPaths, 0)
        // `final_fixing_eki` fires on the KI-and-not-KO paths: P07 (below the
        // maturity barrier when it is stricter than the KI barrier).
        const kiPaths = Math.min(putTransition?.populationAfter ?? 0, survive)
        const noKi = Math.max(survive - kiPaths, 0)
        const couponPaths = coupon?.populationAfter ?? 0

        // Which catalogue branches cannot fire for this trade (from its rails).
        const callStrike = put?.rails.lowCallStrik
        const maturityBarrier = put?.rails.maturBarrier
        const knockIn = put?.knockInBarrier
        const unreachable: string[] = []
        if (callStrike === null || callStrike === undefined || callStrike >= DISABLED) {
          unreachable.push('P05 (LowerCallStrike disabled)')
        }
        if (
          maturityBarrier !== null &&
          maturityBarrier !== undefined &&
          knockIn !== null &&
          knockIn !== undefined &&
          maturityBarrier > knockIn
        ) {
          unreachable.push('P06 (maturity barrier above the KI barrier ⇒ every KI path is below it)')
        }

        const koNode = koId ? `${koId} ${koScenario(koId)}` : 'KO'
        const nodes = [
          { name: 'Paths' },
          { name: koNode },
          { name: 'No KO → maturity' },
          { name: 'KI → P07 below maturity barrier' },
          { name: 'No KI → P08 no-KI region' },
        ]
        const links = [
          ...(koPaths > 0 ? [{ source: 'Paths', target: koNode, value: koPaths }] : []),
          ...(survive > 0 ? [{ source: 'Paths', target: 'No KO → maturity', value: survive }] : []),
          ...(kiPaths > 0
            ? [{ source: 'No KO → maturity', target: 'KI → P07 below maturity barrier', value: kiPaths }]
            : []),
          ...(noKi > 0 ? [{ source: 'No KO → maturity', target: 'No KI → P08 no-KI region', value: noKi }] : []),
        ]

        const option = {
          backgroundColor: 'transparent',
          tooltip: { trigger: 'item' },
          series: [
            {
              type: 'sankey',
              left: 8,
              right: 190,
              top: 12,
              bottom: 12,
              nodeWidth: 13,
              nodeGap: 16,
              layoutIterations: 0,
              data: nodes,
              links,
              label: { fontSize: 10, color: tokens.text },
              lineStyle: { color: 'gradient', curveness: 0.5 },
              itemStyle: { borderColor: tokens.border, borderWidth: 1 },
            },
          ],
        }

        return (
          <div className="flex h-full min-h-0 flex-col">
            <div className="grid shrink-0 grid-cols-3 gap-2 p-3 sm:grid-cols-5">
              <Kpi label="Paths" value={num(paths, 0)} />
              <Kpi label={koId ? `KO (${koId})` : 'KO'} value={num(koPaths, 0)} tone="success" />
              <Kpi label="Survive" value={num(survive, 0)} />
              <Kpi label="KI (P07)" value={num(kiPaths, 0)} tone="danger" />
              <Kpi label="No KI (P08)" value={num(noKi, 0)} tone="primary" />
            </div>
            <div className="min-h-0 flex-1 p-2">
              {links.length === 0 ? (
                <p className="p-3 text-[11px] text-muted">No transition populations in this run.</p>
              ) : (
                <Chart option={option} style={{ height: '100%', width: '100%' }} />
              )}
            </div>
            <div className="shrink-0 space-y-1 border-t border-line px-3 py-2 text-[9px] text-muted">
              <p>
                Coupon leg (C01–C03) accrues on {num(couponPaths, 0)} paths and is additive on every branch:{' '}
                <span className="font-mono">FinalPayoff = CouponLeg + OptionLeg + ReturnRatio</span>.
              </p>
              {unreachable.length > 0 ? <p>Not reachable for this trade: {unreachable.join('; ')}.</p> : null}
            </div>
          </div>
        )
      }}
    </RigaPanel>
  )
})
