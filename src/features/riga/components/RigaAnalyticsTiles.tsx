// riga-flow analytics tiles (§7 / §11): statistics, P&L attribution, PLVA,
// Taylor, book risk, scenario comparison, governance, RCA, regression, sanity
// and stress bands. Every tile states its tool + run id and respects the trace
// level (§10).

import ReactECharts from '../../shared/components/Chart'
import { memo, useEffect, useMemo, useState } from 'react'
import {
  freezeRigaBaseline,
  priceBookAsync,
  useRigaAttribution,
  useRigaBookRisk,
  useRigaBranchStats,
  useRigaCompareCorpus,
  useRigaDistributions,
  useRigaExecutionTape,
  useRigaGovernanceEvidence,
  useRigaMcDiagnostics,
  useRigaPathCube,
  useRigaRiskBatch,
  useRigaRiskNet,
  useRigaRootCause,
  useRigaScenario,
  useRigaStressBands,
  useRigaTriageRegression,
  useRigaValuationExplain,
  useRigaValidateGreeks,
} from '../hooks'
import { useTheme } from '../../themes/ThemeProvider'
import { useObservabilityStore } from '../../../store/observabilityStore'
import { chartBase, DataTable, EmptyTile, Kpi, num, pathIdentity, pct, RigaPanel } from './primitives'
import { PanelCard } from '../../shared/components/PanelCard'
import type { RigaFactorContribution } from '../types'

function formatChangeValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function Waterfall({ items, sign }: { items: RigaFactorContribution[]; sign?: number }) {
  const { tokens } = useTheme()
  const option = useMemo(
    () => ({
      ...chartBase(tokens),
      xAxis: {
        type: 'category',
        data: items.map((item) => item.factor),
        axisLabel: { color: tokens.muted, fontSize: 9, rotate: 24 },
      },
      yAxis: { type: 'value', axisLabel: { color: tokens.muted, fontSize: 9 }, splitLine: { lineStyle: { color: tokens.grid } } },
      series: [
        {
          type: 'bar',
          data: items.map((item) => ({
            value: item.contribution,
            itemStyle: { color: item.contribution * (sign ?? 1) < 0 ? tokens.danger : tokens.success },
          })),
          label: { show: true, position: 'top', color: tokens.text, fontSize: 9, formatter: (p: { value: number }) => p.value.toFixed(4) },
        },
      ],
    }),
    [items, tokens, sign],
  )
  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} notMerge />
}

export const RigaTaylorExplainTile = memo(function RigaTaylorExplainTile() {
  const state = useRigaValuationExplain()
  const level = useObservabilityStore((s) => s.level)
  return (
    <RigaPanel
      title="Taylor Explain"
      subtitle="valuation_explain Taylor + residual"
      tool="valuation_explain"
      state={state}
      empty={level === 'off' ? 'trace off — aggregate only.' : null}
    >
      {(data) => (
        <div className="space-y-2 p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Kpi label="Base PV" value={num(data.basePv)} />
            <Kpi label="Current PV" value={num(data.currentPv)} tone="primary" />
            <Kpi label="ΔPV (base→current)" value={num(data.deltaPv)} />
            <Kpi label="Predicted ΔPV (Taylor)" value={num(data.predictedDpv)} />
            <Kpi label="Residual" value={num(data.residual)} tone={Math.abs(data.residual) > 1e-6 ? 'warning' : 'success'} />
          </div>
          <div className="h-40 min-h-[10rem]">
            <Waterfall items={data.contributions} />
          </div>
          <DataTable
            columns={[
              { key: 'factor', label: 'Factor' },
              { key: 'contribution', label: 'Contribution', render: (row) => num(row.contribution) },
            ]}
            rows={data.contributions}
          />
        </div>
      )}
    </RigaPanel>
  )
})

export const RigaStatisticsSummaryTile = memo(function RigaStatisticsSummaryTile() {
  const branch = useRigaBranchStats()
  const mc = useRigaMcDiagnostics()
  const distributions = useRigaDistributions()

  const ready = branch.data || mc.data || distributions.data
  if (!ready) {
    return <EmptyTile title="Statistics" subtitle="branch stats · diagnostics · distributions" message="Loading riga-flow statistics…" />
  }
  return (
    <PanelCard title="Statistics" subtitle="branch stats · MC diagnostics · distributions" className="h-full" bodyClassName="overflow-auto">
      <div className="space-y-3 p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Kpi label="PV" value={num(mc.data?.pv)} tone="primary" />
          <Kpi label="MC error" value={num(mc.data?.mcError)} />
          <Kpi label="Relative SE" value={pct(mc.data?.relativeSe)} />
          <Kpi label="KI rate" value={pct(distributions.data?.kiRate)} tone="danger" />
        </div>
        <div>
          <p className="eyebrow mb-1">Transition stats</p>
          <DataTable
            columns={[
              { key: 'transitionId', label: 'Transition' },
              { key: 'inputCount', label: 'In' },
              { key: 'outputCount', label: 'Out' },
              { key: 'probability', label: 'Prob', render: (row) => pct(row.probability) },
              { key: 'meanPayoff', label: 'Mean payoff', render: (row) => num(row.meanPayoff) },
              { key: 'variancePayoff', label: 'Variance', render: (row) => num(row.variancePayoff) },
            ]}
            rows={branch.data ?? []}
            empty="No transition stats"
          />
          <p className="mt-1 text-[10px] text-muted">Per-transition Δ/ν: see the Leg Attribution or Risk Net tile.</p>
        </div>
        <div>
          <p className="eyebrow mb-1">Worst-final deciles</p>
          <div className="flex flex-wrap gap-1">
            {(distributions.data?.worstFinalDeciles ?? []).map((value, index) => (
              <span key={index} className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[9px]">
                D{index}: {num(value, 3)}
              </span>
            ))}
          </div>
        </div>
        <p className="text-[10px] text-muted">Statistics are sourced from get_branch_stats · get_mc_diagnostics · get_distributions.</p>
      </div>
    </PanelCard>
  )
})

export const RigaScenarioComparisonTile = memo(function RigaScenarioComparisonTile() {
  const state = useRigaScenario()
  return (
    <RigaPanel title="Scenario Comparison" subtitle="real bump scenarios" tool="scenario" state={state}>
      {(data) => (
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Kpi label="Base PV" value={num(data.basePv)} tone="primary" />
            <Kpi label="Rate up" value={num(data.rateUpPv)} />
            <Kpi label="Rate down" value={num(data.rateDownPv)} />
            <Kpi label="Corr up" value={num(data.correlationUpPv)} />
            <Kpi label="Corr down" value={num(data.correlationDownPv)} />
            <Kpi label="Scenarios" value={data.scenarioCount} />
          </div>
          <DataTable
            columns={[
              { key: 'assetIndex', label: 'Asset' },
              { key: 'delta', label: 'Delta', render: (row) => num(row.delta) },
              { key: 'gamma', label: 'Gamma', render: (row) => num(row.gamma) },
              { key: 'vega', label: 'Vega', render: (row) => num(row.vega) },
            ]}
            rows={data.assets}
          />
        </div>
      )}
    </RigaPanel>
  )
})

export const RigaBookRiskTile = memo(function RigaBookRiskTile() {
  const [notionalsText, setNotionalsText] = useState('10000, 10000')
  const notionals = useMemo(
    () => notionalsText.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0),
    [notionalsText],
  )
  const state = useRigaBookRisk(notionals)
  const [task, setTask] = useState<{ status: string; progress?: number; message?: string } | null>(null)
  const [asyncError, setAsyncError] = useState<string | null>(null)

  return (
    <RigaPanel
      title="Book Risk"
      subtitle="portfolio aggregation"
      tool="compute_book_risk"
      state={state}
      actions={
        <button
          type="button"
          className="shock-button"
          onClick={async () => {
            setAsyncError(null)
            setTask({ status: 'queued' })
            try {
              await priceBookAsync(notionals, (t) => setTask(t))
              setTask({ status: 'completed', progress: 100 })
            } catch (e) {
              setAsyncError((e as { message?: string }).message ?? String(e))
              setTask(null)
            }
          }}
        >
          async task
        </button>
      }
    >
      {(data) => (
        <div className="space-y-3 p-3">
          <label className="block text-[10px] text-muted">
            Notionals
            <input
              className="economics-number-input mt-1 w-full"
              value={notionalsText}
              onChange={(e) => setNotionalsText(e.target.value)}
            />
          </label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Kpi label="Book PV" value={num(data.pv)} tone="primary" />
            <Kpi label="Trades" value={data.trades} />
            <Kpi label="DV01" value={num(data.dv01)} />
            <Kpi label="Corr ρ" value={num(data.correlationSensitivity)} />
          </div>
          <DataTable
            columns={[
              { key: 'index', label: 'Asset', render: (_row, i) => i },
              { key: 'delta', label: 'Delta', render: (_row, i) => num(data.delta[i]) },
              { key: 'gamma', label: 'Gamma', render: (_row, i) => num(data.gamma[i]) },
              { key: 'vega', label: 'Vega', render: (_row, i) => num(data.vega[i]) },
            ]}
            rows={data.delta.map((_, index) => ({ index }))}
          />
          {task ? (
            <div className="rounded border border-line bg-surface p-2 text-[10px]">
              <div className="flex items-center justify-between">
                <span className="text-muted">price_book_async task</span>
                <span className="font-mono text-main">{task.status}</span>
              </div>
              <div className="mt-1 h-1.5 w-full rounded bg-slate-700">
                <div className="h-1.5 rounded bg-primary" style={{ width: `${Math.min(100, Math.max(0, task.progress ?? 10))}%` }} />
              </div>
              {task.message ? <p className="mt-1 text-muted">{task.message}</p> : null}
            </div>
          ) : null}
          {asyncError ? <p className="text-[10px] text-danger">{asyncError}</p> : null}
        </div>
      )}
    </RigaPanel>
  )
})

export const RigaGovernanceEvidenceTile = memo(function RigaGovernanceEvidenceTile() {
  const state = useRigaGovernanceEvidence()
  const level = useObservabilityStore((s) => s.level)
  return (
    <RigaPanel
      title="Governance Evidence"
      subtitle="assumptions · limitations · lineage"
      tool="export_governance_evidence"
      state={state}
      empty={level !== 'full' ? 'Set the trace level to Full to export governance evidence.' : null}
    >
      {(data) => (
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-2 gap-2">
            <Kpi label="Model" value={data.model} />
            <Kpi label="Source model" value={data.sourceModel} />
          </div>
          <div>
            <p className="eyebrow mb-1">Assumptions</p>
            <ul className="list-disc pl-4 text-[10px] text-main">
              {data.assumptions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="eyebrow mb-1">Limitations</p>
            <ul className="list-disc pl-4 text-[10px] text-danger">
              {data.limitations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="eyebrow mb-1">Stress methodology</p>
            <p className="text-[10px] text-muted">{data.stressMethodology}</p>
          </div>
          <div>
            <p className="eyebrow mb-1">Sampled paths</p>
            <DataTable
              columns={[
                { key: 'pathId', label: 'Path', render: (row) => String(pathIdentity(row).pathId ?? '—') },
                { key: 'rngSeed', label: 'Seed', render: (row) => String(pathIdentity(row).rngSeed ?? '—') },
                { key: 'sobol', label: 'Sobol', render: (row) => String(pathIdentity(row).sobolIndex ?? '—') },
                { key: 'worstFinal', label: 'Worst final', render: (row) => num(row.worstFinal) },
                { key: 'putPayoff', label: 'Put', render: (row) => num(row.putPayoff) },
              ]}
              rows={data.lineage?.sampledPaths ?? []}
              empty="No sampled paths"
            />
          </div>
          <p className="font-mono text-[9px] text-muted">market {data.lineage?.determinism?.marketSnapshotId ?? '—'}</p>
        </div>
      )}
    </RigaPanel>
  )
})

export const RigaRootCauseTile = memo(function RigaRootCauseTile() {
  const state = useRigaRootCause()
  const level = useObservabilityStore((s) => s.level)
  return (
    <RigaPanel
      title="Root Cause"
      subtitle="RCA + change log"
      tool="root_cause"
      state={state}
      empty={level !== 'full' ? 'Set the trace level to Full to run root-cause analysis.' : null}
    >
      {(data) => (
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-2 gap-2">
            <Kpi label="Trade" value={data.trade} />
            <Kpi label="Engine model" value={data.engineModel} />
          </div>
          <p className="eyebrow">Finding</p>
          <p className="text-xs text-main">{data.finding}</p>
          <div>
            <p className="eyebrow mb-1">Evidence</p>
            <div className="flex flex-wrap gap-1">
              {data.evidenceRefs.map((ref) => (
                <span key={ref} className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] text-primary">
                  {ref}
                </span>
              ))}
            </div>
          </div>
          {data.changeLog ? (
            <DataTable
              columns={[
                { key: 'field', label: 'Field' },
                { key: 'value', label: 'Value', render: (row: { field: string; value: unknown }) => formatChangeValue(row.value) },
              ]}
              rows={Object.entries(data.changeLog).map(([field, value]) => ({ field, value }))}
            />
          ) : null}
          <p className="text-[10px] text-muted">{data.note}</p>
        </div>
      )}
    </RigaPanel>
  )
})

export const RigaRegressionTriageTile = memo(function RigaRegressionTriageTile() {
  const corpus = useRigaCompareCorpus()
  const triage = useRigaTriageRegression()
  const [frozen, setFrozen] = useState<string | null>(null)
  const runId = corpus.data?.name
  // `compare_corpus`/`triage_regression` need a frozen baseline; freeze the
  // current run once on mount, then reload both views.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await freezeRigaBaseline()
      } catch {
        /* no baseline is a valid state; the error surfaces on the tile */
      }
      if (!cancelled) {
        corpus.refresh()
        triage.refresh()
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <RigaPanel
      title="Regression Triage"
      subtitle="baseline comparison"
      tool="triage_regression"
      runId={runId}
      state={triage.data ? triage : corpus}
      actions={
        <button
          type="button"
          className="shock-button"
          onClick={async () => {
            const baseline = await freezeRigaBaseline()
            setFrozen(`frozen ${baseline.name} @ ${baseline.frozen.frozenAtUnix}`)
          }}
        >
          freeze
        </button>
      }
    >
      {(result) => (
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-3 gap-2">
            <Kpi label="Within tolerance" value={result.withinTolerance ? 'yes' : 'no'} tone={result.withinTolerance ? 'success' : 'danger'} />
            <Kpi label="Exceptions" value={result.count} tone={result.count > 0 ? 'warning' : 'success'} />
            <Kpi label="Baseline" value={result.name} />
          </div>
          {frozen ? <p className="text-[10px] text-success">{frozen}</p> : null}
          <DataTable
            columns={[
              { key: 'family', label: 'Family', render: (row) => row.family ?? '—' },
              { key: 'transitionId', label: 'Transition', render: (row) => row.transitionId ?? '—' },
              { key: 'message', label: 'Message' },
              { key: 'delta', label: 'Δ', render: (row) => num(row.delta) },
            ]}
            rows={result.exceptions}
            empty="No exceptions"
          />
        </div>
      )}
    </RigaPanel>
  )
})

export const RigaGreeksSanityTile = memo(function RigaGreeksSanityTile() {
  const state = useRigaValidateGreeks()
  return (
    <RigaPanel title="Greeks Sanity" subtitle="validate_greeks flags" tool="validate_greeks" state={state}>
      {(data) => (
        <DataTable
          columns={[
            {
              key: 'severity',
              label: 'Severity',
              render: (row) => (
                <span
                  className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                    row.severity === 'error' ? 'bg-danger/20 text-danger' : 'bg-warning/20 text-warning'
                  }`}
                >
                  {row.severity}
                </span>
              ),
            },
            { key: 'message', label: 'Message' },
          ]}
          rows={data.flags}
          empty="No validation flags"
        />
      )}
    </RigaPanel>
  )
})

export const RigaStressBandsTile = memo(function RigaStressBandsTile() {
  const state = useRigaStressBands()
  const { tokens } = useTheme()
  return (
    <RigaPanel title="Stress Bands" subtitle="recommend_scenarios bands" tool="recommend_scenarios" state={state}>
      {(data) => (
        <div className="flex h-full flex-col">
          <div className="min-h-0 flex-1 overflow-auto">
            <DataTable
              columns={[
                { key: 'spotBand', label: 'Spot band', render: (row) => `${num(row.spotBand[0], 2)} – ${num(row.spotBand[1], 2)}` },
                { key: 'reason', label: 'Reason' },
              ]}
              rows={data.recommendations}
            />
          </div>
          <div className="h-24 border-t border-line/60">
            <ReactECharts
              option={{
                ...chartBase(tokens),
                grid: { left: 40, right: 12, top: 10, bottom: 18 },
                xAxis: { type: 'value', axisLabel: { color: tokens.muted, fontSize: 9 } },
                yAxis: { type: 'category', data: data.recommendations.map((r) => r.reason), axisLabel: { color: tokens.muted, fontSize: 8 } },
                series: [{ type: 'bar', data: data.recommendations.map((r) => r.spotBand[1] - r.spotBand[0]), itemStyle: { color: tokens.warning } }],
              }}
              style={{ height: '100%', width: '100%' }}
              notMerge
            />
          </div>
        </div>
      )}
    </RigaPanel>
  )
})

export const RigaPathCubeTile = memo(function RigaPathCubeTile() {
  const state = useRigaPathCube(0.05)
  const level = useObservabilityStore((s) => s.level)
  return (
    <RigaPanel
      title="PathCube Query"
      subtitle="worst-5% sample"
      tool="query_path_cube"
      state={state}
      empty={level === 'off' ? 'trace off — aggregate only.' : null}
    >
      {(data) => (
        <div className="space-y-2 p-3">
          <div className="flex flex-wrap gap-2">
            <Kpi label="Percentile" value={pct(data.percentile)} />
            <Kpi label="Count" value={Number.isFinite(data.total) ? data.total.toLocaleString() : '—'} tone="primary" />
          </div>
          <DataTable
            columns={[
              { key: 'pathId', label: 'Path', render: (row) => String(pathIdentity(row).pathId ?? '—') },
              { key: 'worstFinal', label: 'Worst final', render: (row) => num(row.worstFinal) },
              { key: 'knockedOut', label: 'KO', render: (row) => (row.knockedOut ? 'yes' : 'no') },
              { key: 'kiHit', label: 'KI', render: (row) => (row.kiHit ? 'yes' : 'no') },
              { key: 'pv', label: 'PV', render: (row) => num(row.pv) },
            ]}
            rows={data.sample}
            empty="No sample"
          />
        </div>
      )}
    </RigaPanel>
  )
})


export const RigaExecutionTapeTile = memo(function RigaExecutionTapeTile() {
  const state = useRigaExecutionTape()
  const level = useObservabilityStore((s) => s.level)
  const [selected, setSelected] = useState<string | null>(null)
  return (
    <RigaPanel
      title="Execution Tape"
      subtitle="bounded event tape"
      tool="execution_events"
      state={state}
      empty={level === 'off' ? 'trace off — aggregate only.' : null}
    >
      {(data) => (
        <div className="space-y-2 p-3">
          <div className="flex gap-2">
            <Kpi label="Paths" value={data.totalPaths} />
            <Kpi label="Tape size" value={data.tapeSize} tone="primary" />
          </div>
          <DataTable
            columns={[
              { key: 'pathId', label: 'Path' },
              { key: 'events', label: 'Events', render: (row) => row.events.map((e) => e.kind).join(' → ') },
              { key: 'pv', label: 'PV', render: (row) => num(row.pv) },
            ]}
            rows={data.tape}
            onRowClick={(row) => setSelected(row.pathId === selected ? null : row.pathId)}
            empty="No tape"
          />
          {selected ? <p className="text-[10px] text-muted">selected path {selected}</p> : null}
        </div>
      )}
    </RigaPanel>
  )
})

/** PV by leg + PV/Δ/ν by transition (`explain_pv_attribution` + `query_risk_net`). */
export const RigaAttributionTile = memo(function RigaAttributionTile() {
  const state = useRigaAttribution()
  // Per-transition Δ/ν is only produced by the risk batch (the ledger's own
  // delta/vega impacts are zero in the engine), so overlay `query_risk_net`.
  const risk = useRigaRiskNet()
  return (
    <RigaPanel
      title="Leg Attribution"
      subtitle="explain_pv_attribution · PV by leg, PV/Δ/ν by transition"
      tool="explain_pv_attribution"
      runId={state.data?.determinism?.marketSnapshotId}
      state={state}
    >
      {(data) => {
        const legs = data.legs
        return (
          <div className="space-y-3 p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Kpi label="Total PV" value={num(legs.total)} tone="primary" />
              <Kpi label="KI probability" value={pct(data.kiProbability)} tone="danger" />
              <Kpi label="Engine model" value={data.engineModel} />
            </div>
            <div>
              <p className="eyebrow mb-1">PV by leg</p>
              <DataTable
                columns={[
                  { key: 'leg', label: 'Leg' },
                  { key: 'pv', label: 'PV', render: (row) => num(row.pv) },
                ]}
                rows={[
                  { leg: 'Par redemption', pv: legs.parRedemption },
                  { leg: 'Coupon', pv: legs.coupon },
                  { leg: 'Memory coupon', pv: legs.memoryCoupon },
                  { leg: 'Down-and-in put', pv: legs.downAndInPut },
                  { leg: 'Funding', pv: legs.funding },
                  { leg: 'Discounting', pv: legs.discounting },
                  { leg: 'Total', pv: legs.total },
                ]}
              />
            </div>
            <div>
              <p className="eyebrow mb-1">PV &amp; sensitivities by transition</p>
              <DataTable
                columns={[
                  { key: 'transitionId', label: 'Transition' },
                  { key: 'probability', label: 'Prob', render: (row) => pct(row.probability) },
                  { key: 'pvImpact', label: 'PV impact', render: (row) => num(row.pvImpact) },
                  { key: 'deltaImpact', label: 'Δ', render: (row) => num(row.deltaImpact) },
                  { key: 'vegaImpact', label: 'ν', render: (row) => num(row.vegaImpact) },
                ]}
                rows={(data.stats ?? []).map((stat) => {
                  const entry = (risk.data?.transitions ?? []).find((t) => t.id === stat.transitionId)
                  return {
                    transitionId: stat.transitionId,
                    probability: stat.probability,
                    pvImpact: entry?.pvImpact ?? stat.meanPayoff,
                    deltaImpact: entry?.deltaImpact ?? stat.meanDelta,
                    vegaImpact: entry?.vegaImpact ?? stat.meanVega,
                  }
                })}
                empty="No transition stats"
              />
              <p className="mt-1 text-[10px] text-muted">
                Δ/ν are attributed per transition by the risk batch (`query_risk_net`); the
                down-and-in put is the vol-driven term. The engine does not report per-leg
                sensitivities.
              </p>
            </div>
          </div>
        )
      }}
    </RigaPanel>
  )
})

/** Per-asset risk summary (`risk_batch`): PV, DV01, correlation and Δ/Γ/ν. */
export const RigaRiskSummaryTile = memo(function RigaRiskSummaryTile() {
  const state = useRigaRiskBatch()
  return (
    <RigaPanel
      title="Risk Summary"
      subtitle="risk_batch · per-asset Δ/Γ/ν"
      tool="risk_batch"
      state={state}
    >
      {(data) => (
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Kpi label="Base PV" value={num(data.basePv)} tone="primary" />
            <Kpi label="MC error" value={num(data.pvMcError)} />
            <Kpi label="DV01" value={num(data.dv01)} />
            <Kpi label="Correlation ρ" value={num(data.correlationSensitivity)} tone="warning" />
            <Kpi label="Scenarios" value={data.scenarioCount} />
          </div>
          <div>
            <p className="eyebrow mb-1">Per-asset Greeks</p>
            <DataTable
              columns={[
                { key: 'assetIndex', label: 'Asset', render: (row) => `#${row.assetIndex}` },
                { key: 'delta', label: 'Delta', render: (row) => num(row.delta) },
                { key: 'gamma', label: 'Gamma', render: (row) => num(row.gamma) },
                { key: 'vega', label: 'Vega', render: (row) => num(row.vega, 4) },
              ]}
              rows={data.assets ?? []}
              empty="No per-asset Greeks"
            />
          </div>
        </div>
      )}
    </RigaPanel>
  )
})

/** Worst-of deciles, KI rate and mean put (`get_distributions`). */
export const RigaDistributionSummaryTile = memo(function RigaDistributionSummaryTile() {
  const state = useRigaDistributions()
  const { tokens } = useTheme()
  return (
    <RigaPanel
      title="Distribution Summary"
      subtitle="get_distributions · worst-of deciles"
      tool="get_distributions"
      state={state}
    >
      {(data) => {
        const deciles = data.worstFinalDeciles ?? []
        const base = chartBase(tokens)
        const option = {
          ...base,
          xAxis: { ...(base.xAxis as object), type: 'category', data: deciles.map((_, index) => `D${index + 1}`) },
          yAxis: { ...(base.yAxis as object), name: 'Worst-of final' },
          series: [{ type: 'bar', data: deciles, itemStyle: { color: tokens.primary } }],
        }
        return (
          <div className="flex h-full min-h-0 flex-col">
            <div className="grid shrink-0 grid-cols-3 gap-2 p-3">
              <Kpi label="Paths" value={Number.isFinite(data.count) ? data.count.toLocaleString() : '—'} />
              <Kpi label="KI rate" value={pct(data.kiRate)} tone="danger" />
              <Kpi label="Mean put" value={num(data.meanPut)} tone="primary" />
            </div>
            <div className="min-h-0 flex-1 p-2">
              <ReactECharts option={option} style={{ height: '100%', width: '100%' }} notMerge />
            </div>
          </div>
        )
      }}
    </RigaPanel>
  )
})

/** Worst-percentile path sample + selected-path detail (`query_path_cube`). */
export const RigaSelectedPathTile = memo(function RigaSelectedPathTile() {
  const state = useRigaPathCube(0.05)
  const { tokens } = useTheme()
  return (
    <RigaPanel
      title="Selected Path"
      subtitle="query_path_cube · worst-percentile sample"
      tool="query_path_cube"
      state={state}
    >
      {(data) => {
        const sample = data.sample ?? []
        const first = sample[0]
        const base = chartBase(tokens)
        const option = {
          ...base,
          xAxis: { ...(base.xAxis as object), type: 'category', data: (first?.couponByPeriod ?? []).map((_, index) => `P${index + 1}`), name: 'Coupon period' },
          yAxis: { ...(base.yAxis as object), name: 'Coupon PV' },
          series: [{ type: 'bar', data: first?.couponByPeriod ?? [], itemStyle: { color: tokens.primary } }],
        }
        return (
          <div className="flex h-full min-h-0 flex-col">
            <div className="grid shrink-0 grid-cols-2 gap-2 p-3 sm:grid-cols-4">
              <Kpi label="Percentile" value={pct(data.percentile)} />
              <Kpi label="Paths" value={Number.isFinite(data.total) ? data.total.toLocaleString() : '—'} />
              <Kpi label="Worst threshold" value={num(data.thresholdWorstFinal)} />
              <Kpi label="Selected" value={`#${data.selected}`} />
            </div>
            <div className="shrink-0 p-2">
              <DataTable
                columns={[
                  { key: 'identity', label: 'Path', render: (row) => `#${row.identity?.pathId ?? '—'}` },
                  { key: 'worstFinal', label: 'Worst', render: (row) => num(row.worstFinal) },
                  { key: 'knockedOut', label: 'KO', render: (row) => (row.knockedOut ? `@${row.koTime}` : '—') },
                  { key: 'kiHit', label: 'KI', render: (row) => (row.kiHit ? 'yes' : 'no') },
                  { key: 'putPayoff', label: 'Put', render: (row) => num(row.putPayoff) },
                  { key: 'pv', label: 'PV', render: (row) => num(row.pv) },
                ]}
                rows={sample}
                empty="No sample paths"
              />
            </div>
            <div className="min-h-0 flex-1 p-2">
              <ReactECharts option={option} style={{ height: '100%', width: '100%' }} notMerge />
            </div>
          </div>
        )
      }}
    </RigaPanel>
  )
})

/** Base PV → market explain → residual → current PV (`valuation_explain`). */
export const RigaMasterExplainWaterfallTile = memo(function RigaMasterExplainWaterfallTile() {
  const state = useRigaValuationExplain()
  const { tokens } = useTheme()
  return (
    <RigaPanel
      title="Master Explain Waterfall"
      subtitle="valuation_explain · base → current bridge"
      tool="valuation_explain"
      state={state}
    >
      {(data) => {
        const steps = [
          { name: 'Base PV', value: data.basePv, delta: false },
          ...(data.contributions ?? []).map((c) => ({ name: c.factor, value: c.contribution, delta: true })),
          { name: 'Residual', value: data.residual, delta: true },
          { name: 'Current PV', value: data.currentPv, delta: false },
        ]
        const helpers: number[] = []
        const positives: Array<number | string> = []
        const negatives: Array<number | string> = []
        const totals: Array<number | string> = []
        let running = 0
        for (const step of steps) {
          if (!step.delta) {
            helpers.push(0)
            positives.push('-')
            negatives.push('-')
            totals.push(step.value)
            running = step.value
          } else {
            const end = running + step.value
            helpers.push(Math.min(running, end))
            if (step.value >= 0) {
              positives.push(step.value)
              negatives.push('-')
            } else {
              positives.push('-')
              negatives.push(-step.value)
            }
            totals.push('-')
            running = end
          }
        }
        const base = chartBase(tokens)
        const option = {
          ...base,
          grid: { left: 48, right: 16, top: 28, bottom: 58 },
          xAxis: {
            ...(base.xAxis as object),
            type: 'category',
            data: steps.map((s) => s.name),
            axisLabel: { color: tokens.muted, fontSize: 8, rotate: 25, interval: 0 },
          },
          yAxis: { ...(base.yAxis as object) },
          series: [
            { name: 'helper', type: 'bar', stack: 'total', silent: true, itemStyle: { color: 'transparent' }, data: helpers },
            { name: 'increase', type: 'bar', stack: 'total', itemStyle: { color: tokens.success }, data: positives },
            { name: 'decrease', type: 'bar', stack: 'total', itemStyle: { color: tokens.danger }, data: negatives },
            { name: 'total', type: 'bar', stack: 'total', itemStyle: { color: tokens.primary }, data: totals },
          ],
        }
        return (
          <div className="flex h-full min-h-0 flex-col">
            <div className="grid shrink-0 grid-cols-2 gap-2 p-3 sm:grid-cols-4">
              <Kpi label="Base PV" value={num(data.basePv)} />
              <Kpi label="Market explain" value={num(data.predictedDpv)} />
              <Kpi label="Residual" value={num(data.residual)} tone={Math.abs(data.residual) > 1e-6 ? 'warning' : 'success'} />
              <Kpi label="Current PV" value={num(data.currentPv)} tone="primary" />
            </div>
            <div className="min-h-0 flex-1 p-2">
              <ReactECharts option={option} style={{ height: '100%', width: '100%' }} notMerge />
            </div>
          </div>
        )
      }}
    </RigaPanel>
  )
})
