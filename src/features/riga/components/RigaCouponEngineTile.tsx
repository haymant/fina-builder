// Diagram 1 coupon engine for the selected path and fixing (docs/49 P3g-vii).
//
// The engine's `get_path` now returns the nominal coupon strip it computes while
// pricing (`couponLedger`): C01/C02 accrual, C03 memory recovery, the discount
// factor and the booked PV per period. This tile renders that strip as a table
// or as stacked bars, highlights the period that contains the observation
// selected on the Path Timeline, and reconciles the strip's PV with `couponPv`.
//
// Older engines do not return the nominal strip; the tile then falls back to the
// discounted `couponByPeriod` series and says so.

import { memo, useState } from 'react'
import Chart from '../../shared/components/Chart'
import { useObservabilityStore } from '../../../store/observabilityStore'
import { useRigaMarketStore } from '../../../store/rigaMarketStore'
import { useRigaSelectionStore } from '../../../store/rigaSelectionStore'
import { useRigaTradeStore } from '../../../store/rigaTradeStore'
import { useSelectedPathRecord } from '../hooks'
import {
  activeLedger,
  couponFrequencyLabel,
  couponTotals,
  periodEndDate,
  periodForStep,
} from '../data/couponEngine'
import type { CouponLedgerRow } from '../types'
import { useTheme } from '../../themes/ThemeProvider'
import { chartBase, DataTable, Kpi, num, RigaPanel } from './primitives'

export const RigaCouponEngineTile = memo(function RigaCouponEngineTile() {
  const state = useSelectedPathRecord()
  const level = useObservabilityStore((s) => s.level)
  const trade = useRigaTradeStore((s) => s.trade)
  const asOf = useRigaMarketStore((s) => s.market.asOf)
  const pathId = useRigaSelectionStore((s) => s.selectedPathId)
  const observation = useRigaSelectionStore((s) => s.selectedObservation)
  const { tokens } = useTheme()
  const [view, setView] = useState<'table' | 'graph'>('table')
  const periods = trade.couponPeriods ?? 1
  const clock = couponFrequencyLabel(periods, trade.maturityYears)

  return (
    <RigaPanel
      title="Coupon Engine"
      subtitle={`get_path · Diagram 1 strip · ${clock}`}
      tool="get_path"
      state={state}
      empty={level === 'off' ? 'trace off — the coupon strip needs get_path (Sampled or Full).' : null}
      actions={
        <div className="flex items-center gap-1" data-testid="coupon-engine-view-switch">
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
            data-testid="coupon-engine-view-graph"
          >
            Graph
          </button>
        </div>
      }
    >
      {(path) => {
        const engineRows = activeLedger(path.couponLedger)
        const usingFallback = engineRows.length === 0
        const rows: CouponLedgerRow[] = usingFallback
          ? path.couponByPeriod.map((pv, period) => ({
              period,
              years: 0,
              qualifiedSteps: 0,
              periodSteps: 0,
              accrual: 0,
              memoryPaid: 0,
              paid: 0,
              memoryAccrued: 0,
              discountFactor: 0,
              pv,
              knockedOut: false,
            }))
          : engineRows
        const totals = couponTotals(rows)
        const selectedPeriod =
          observation !== null && observation.pathId === pathId
            ? periodForStep(observation.step, trade.steps, periods)
            : null
        let running = 0
        const cumulative = rows.map((row) => {
          running += row.paid
          return running
        })
        const base = chartBase(tokens)
        const option = {
          ...base,
          legend: {
            top: 4,
            textStyle: { color: tokens.muted, fontSize: 9 },
            data: usingFallback
              ? ['Coupon PV', 'Cumulative PV']
              : ['Accrual (C01/C02)', 'Memory (C03)', 'Cumulative paid'],
          },
          xAxis: {
            ...(base.xAxis as object),
            type: 'category',
            data: rows.map((row) => `P${row.period + 1}`),
            name: 'Period',
          },
          yAxis: usingFallback
            ? { ...(base.yAxis as object), type: 'value', name: 'PV' }
            : [
                { ...(base.yAxis as object), type: 'value', name: 'Nominal coupon' },
                { type: 'value', name: 'Cumulative', axisLabel: { color: tokens.muted, fontSize: 9 }, splitLine: { show: false } },
              ],
          series: usingFallback
            ? [
                {
                  name: 'Coupon PV',
                  type: 'bar',
                  data: rows.map((row, index) => ({
                    value: row.pv,
                    itemStyle: { color: index === selectedPeriod ? tokens.warning : tokens.primary },
                  })),
                },
                {
                  name: 'Cumulative PV',
                  type: 'line',
                  symbol: 'none',
                  data: rows.map((_, index) => rows.slice(0, index + 1).reduce((sum, row) => sum + row.pv, 0)),
                  lineStyle: { color: tokens.success, width: 2 },
                  itemStyle: { color: tokens.success },
                },
              ]
            : [
                {
                  name: 'Accrual (C01/C02)',
                  type: 'bar',
                  stack: 'coupon',
                  data: rows.map((row, index) => ({
                    value: row.accrual,
                    itemStyle: { color: index === selectedPeriod ? tokens.warning : tokens.primary },
                  })),
                },
                {
                  name: 'Memory (C03)',
                  type: 'bar',
                  stack: 'coupon',
                  data: rows.map((row) => row.memoryPaid),
                  itemStyle: { color: tokens.danger },
                },
                {
                  name: 'Cumulative paid',
                  type: 'line',
                  yAxisIndex: 1,
                  symbol: 'none',
                  data: cumulative,
                  lineStyle: { color: tokens.success, width: 2 },
                  itemStyle: { color: tokens.success },
                },
              ],
        }
        return (
          <div className="flex h-full min-h-0 flex-col">
            <div className="grid shrink-0 grid-cols-2 gap-2 p-3 sm:grid-cols-4">
              <Kpi label="Coupon (nominal)" value={usingFallback ? '—' : num(totals.paid, 6)} tone="primary" />
              <Kpi label="Memory recovered" value={usingFallback ? '—' : num(totals.memory, 6)} />
              <Kpi label="Coupon PV" value={num(totals.pv, 6)} />
              <Kpi label="Periods paid" value={`${totals.periodsPaid}/${rows.length}`} />
            </div>
            {usingFallback ? (
              <p className="shrink-0 px-3 pb-1 text-[10px] text-warning" data-testid="coupon-engine-fallback">
                This engine build does not return the nominal coupon strip; showing the discounted coupon PV per
                period. Rebuild riga-mcp to enable C01/C02/C03.
              </p>
            ) : null}
            {view === 'graph' ? (
              <div className="min-h-0 flex-1 p-2" data-testid="coupon-engine-graph">
                <Chart option={option} style={{ height: '100%', width: '100%' }} />
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto px-1" data-testid="coupon-engine-table">
                <DataTable
                  columns={
                    usingFallback
                      ? [
                          { key: 'period', label: 'Period', render: (row: CouponLedgerRow) => `P${row.period + 1}` },
                          { key: 'pv', label: 'Coupon PV', render: (row: CouponLedgerRow) => num(row.pv, 6) },
                        ]
                      : [
                          {
                            key: 'period',
                            label: 'Period',
                            render: (row: CouponLedgerRow) =>
                              `P${row.period + 1}${row.knockedOut ? ' · KO' : ''}`,
                          },
                          {
                            key: 'end',
                            label: 'Period end',
                            render: (row: CouponLedgerRow) => periodEndDate(asOf, row.years),
                          },
                          {
                            key: 'qualified',
                            label: 'C02 qualifier',
                            render: (row: CouponLedgerRow) =>
                              row.period === 0 && trade.fixedFirstCoupon
                                ? 'fixed first'
                                : `${row.qualifiedSteps}/${row.periodSteps}`,
                          },
                          {
                            key: 'accrual',
                            label: 'C01/C02 accrual',
                            render: (row: CouponLedgerRow) => num(row.accrual, 6),
                          },
                          {
                            key: 'memory',
                            label: 'C03 memory',
                            render: (row: CouponLedgerRow) => num(row.memoryPaid, 6),
                          },
                          { key: 'paid', label: 'Paid', render: (row: CouponLedgerRow) => num(row.paid, 6) },
                          { key: 'pv', label: 'PV', render: (row: CouponLedgerRow) => num(row.pv, 6) },
                          {
                            key: 'cumulative',
                            label: 'Cumulative',
                            render: (_row: CouponLedgerRow, index: number) => num(cumulative[index], 6),
                          },
                        ]
                  }
                  rows={rows}
                  rowClassName={(row) => (row.period === selectedPeriod ? 'bg-primary/10 text-primary' : '')}
                  rowTestId={(row) => `coupon-period-${row.period}`}
                  empty="No coupon strip"
                />
              </div>
            )}
            <div className="shrink-0 space-y-1 border-t border-line px-3 py-2 text-[9px] text-muted">
              <p>
                C01 base accrual × C02 barrier qualifier (qualified steps / period steps) + C03 memory recovery.
                Nominal total <span className="font-mono text-main">{num(totals.paid, 6)}</span> · engine coupon PV{' '}
                <span className="font-mono text-main">{num(path.couponPv, 6)}</span>.
              </p>
              <p>
                {selectedPeriod !== null
                  ? `Selected fixing ${observation!.step + 1} falls in period P${selectedPeriod + 1}.`
                  : 'Select a fixing on the Path Timeline to highlight its coupon period.'}
              </p>
            </div>
          </div>
        )
      }}
    </RigaPanel>
  )
})
