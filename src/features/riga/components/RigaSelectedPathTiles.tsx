// The shared simulation-path detail (docs/49 P3g-ii) — `get_path` for the path
// picked in the workspace stepper. Every path-dependent tile reads the same
// selection, so this tile is the "what did that path actually do" view: terminal
// worst-of, KO/KI status, PV by leg and the per-period coupon schedule.

import { memo } from 'react'
import Chart from '../../shared/components/Chart'
import { useObservabilityStore } from '../../../store/observabilityStore'
import { useSelectedPathRecord } from '../hooks'
import { useTheme } from '../../themes/ThemeProvider'
import { chartBase, Kpi, num, RigaPanel } from './primitives'

export const RigaSelectedPathDetailTile = memo(function RigaSelectedPathDetailTile() {
  const level = useObservabilityStore((s) => s.level)
  const state = useSelectedPathRecord()
  const { tokens } = useTheme()
  return (
    <RigaPanel
      title="Selected Path Detail"
      subtitle="get_path · shared path selection"
      tool="get_path"
      state={state}
      empty={level === 'off' ? 'trace off — path replay needs Sampled or Full.' : null}
    >
      {(path) => {
        const coupons = path.couponByPeriod ?? []
        const base = chartBase(tokens)
        const option = {
          ...base,
          xAxis: {
            ...(base.xAxis as object),
            type: 'category',
            data: coupons.map((_, index) => `P${index + 1}`),
            name: 'Coupon period',
          },
          yAxis: { ...(base.yAxis as object), name: 'Coupon PV' },
          series: [{ type: 'bar', data: coupons, itemStyle: { color: tokens.primary } }],
        }
        const outcome = path.knockedOut
          ? `knocked out at t=${num(path.koTime, 4)}`
          : path.kiHit
            ? 'survived · knock-in hit'
            : 'survived · no knock-in'
        return (
          <div className="flex h-full min-h-0 flex-col">
            <div className="grid shrink-0 grid-cols-2 gap-2 p-3 sm:grid-cols-3">
              <Kpi label="Path" value={`#${path.identity?.pathId ?? '—'}`} tone="primary" />
              <Kpi label="PV" value={num(path.pv)} />
              <Kpi label="Worst final" value={num(path.worstFinal)} />
              <Kpi label="Coupon PV" value={num(path.couponPv)} />
              <Kpi label="Put payoff" value={num(path.putPayoff)} tone="danger" />
              <Kpi label="Funding" value={num(path.funding)} />
            </div>
            <p className="shrink-0 px-3 pb-2 text-[10px] text-muted" data-testid="selected-path-outcome">
              {path.identity?.pathId !== undefined ? `Path #${path.identity.pathId} ` : 'Path '}
              {outcome}. Seed {path.identity?.rngSeed ?? '—'}
              {path.identity?.sobolIndex !== null && path.identity?.sobolIndex !== undefined
                ? ` · Sobol ${path.identity.sobolIndex}`
                : ''}
              .
            </p>
            <div className="min-h-0 flex-1 p-2">
              {coupons.length === 0 ? (
                <p className="p-3 text-[11px] text-muted">This path paid no coupon.</p>
              ) : (
                <Chart option={option} style={{ height: '100%', width: '100%' }} />
              )}
            </div>
          </div>
        )
      }}
    </RigaPanel>
  )
})
