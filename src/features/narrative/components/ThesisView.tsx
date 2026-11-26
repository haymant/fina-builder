import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { PanelCard } from '../../shared/components/PanelCard'
import { narrativeApi } from '../api'
import { scraperApi } from '../scraperApi'
import type { NipBacktestEvidence, NipClaim, NipEvent, NipNarrativeGraph, NipThesis, NipTranscript, ThesisStatus } from '../types'
import type { SymbolFeatures, TriageResponse } from '../scraperTypes'
import {
  canAdvanceThesis,
  formatNumber,
  reviewStatusLabel,
  thesisBasisLabel,
  thesisGateReason,
  thesisStatusLabel,
  tierLabel,
  THESIS_PIPELINE,
} from '../thesisGates'

/**
 * Which cited claims appear as nodes in the NIP graph — the baseline-e2e
 * lesson, enforced in the presentation, not just in prose. A single-event
 * NIP graph holds only claims quoted in that event's transcript, so the
 * graph is NEVER complete corroboration: the thesis may cite claims the
 * graph does not contain, and the UI must say so.
 */
export function graphClaimCoverage(
  thesis: NipThesis,
  claims: NipClaim[],
  graph: NipNarrativeGraph | null,
): { inGraph: string[]; missing: string[] } {
  const nodes = graph?.nodes ?? []
  const inGraph: string[] = []
  const missing: string[] = []
  for (const claimId of thesis.claim_ids) {
    const claim = claims.find((candidate) => candidate.claim_id === claimId)
    const found = nodes.some((node) =>
      node.node_type === 'claim' && (node.node_id.includes(claimId) || (claim !== undefined && node.label === claim.claim_text)),
    )
    if (found) inGraph.push(claimId)
    else missing.push(claimId)
  }
  return { inGraph, missing }
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function BasisBadge({ thesis }: { thesis: NipThesis }) {
  const provisional = thesis.thesis_basis === 'provisional_fast_glance'
  return (
    <span className={`narrative-chip ${provisional ? 'is-provisional' : 'is-verified'}`} data-testid={`thesis-basis-${thesis.thesis_id}`}>
      {thesisBasisLabel(thesis.thesis_basis)}
    </span>
  )
}

export function ThesisView({
  theses,
  claims,
  events,
  graph,
  asOf,
  onChanged,
  onSendToVideo,
  initialTriageTickers = '',
}: {
  theses: NipThesis[]
  claims: NipClaim[]
  events: NipEvent[]
  graph: NipNarrativeGraph | null
  asOf: string | null
  onChanged: () => Promise<void>
  onSendToVideo?: (thesis: NipThesis, transcript: NipTranscript | null) => void
  /** Tickers pre-filled into the triage runner (e.g. from Editorial → Open triage). */
  initialTriageTickers?: string
}) {
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [basisFilter, setBasisFilter] = useState<string>('all')
  const [symbolFilter, setSymbolFilter] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(theses[0]?.thesis_id ?? null)
  const [backtests, setBacktests] = useState<NipBacktestEvidence[]>([])
  const [transcripts, setTranscripts] = useState<NipTranscript[]>([])
  const [features, setFeatures] = useState<SymbolFeatures | null>(null)
  const [featuresError, setFeaturesError] = useState<string | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [actionIsError, setActionIsError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [triageTickers, setTriageTickers] = useState(initialTriageTickers)
  const [triage, setTriage] = useState<TriageResponse | null>(null)
  const [triageLoading, setTriageLoading] = useState(false)
  const [triageError, setTriageError] = useState<string | null>(null)

  useEffect(() => { if (initialTriageTickers) setTriageTickers(initialTriageTickers) }, [initialTriageTickers])

  useEffect(() => {
    if (!selectedId && theses.length) setSelectedId(theses[0].thesis_id)
    if (selectedId && !theses.some((thesis) => thesis.thesis_id === selectedId)) setSelectedId(theses[0]?.thesis_id ?? null)
  }, [theses, selectedId])

  const selected = theses.find((thesis) => thesis.thesis_id === selectedId) ?? null

  const filtered = useMemo(() => {
    const needle = symbolFilter.trim().toLowerCase()
    return [...theses]
      .filter((thesis) => (statusFilter === 'all' || thesis.status === statusFilter))
      .filter((thesis) => (basisFilter === 'all' || thesis.thesis_basis === basisFilter))
      .filter((thesis) => !needle || (thesis.entity_symbol ?? '').toLowerCase().includes(needle) || thesis.title.toLowerCase().includes(needle))
      .sort((a, b) => b.as_of.localeCompare(a.as_of))
  }, [theses, statusFilter, basisFilter, symbolFilter])

  const loadDetail = useCallback(async (thesis: NipThesis) => {
    setDetailLoading(true)
    setFeatures(null)
    setFeaturesError(null)
    try {
      setBacktests(await narrativeApi.listBacktestEvidence(thesis.thesis_id).catch(() => []))
    } catch { setBacktests([]) }
    try {
      setTranscripts(await narrativeApi.listTranscripts(thesis.thesis_id).catch(() => []))
    } catch { setTranscripts([]) }
    if (thesis.entity_symbol && asOf) {
      try {
        setFeatures(await scraperApi.querySymbolFeatures({ symbol: thesis.entity_symbol, asOf: thesis.as_of }))
      } catch (reason) {
        setFeaturesError(reason instanceof Error ? reason.message : 'Symbol features could not be loaded.')
      }
    }
    setDetailLoading(false)
  }, [asOf])

  useEffect(() => { if (selected) void loadDetail(selected) }, [selected, loadDetail])

  const runTriage = async () => {
    const tickers = triageTickers.split(',').map((ticker) => ticker.trim().toUpperCase()).filter(Boolean)
    if (!tickers.length || !asOf) {
      setTriageError(!asOf ? 'No as_of set.' : 'Enter at least one ticker (comma separated).')
      return
    }
    setTriageLoading(true)
    setTriageError(null)
    try {
      setTriage(await scraperApi.queryTriage({ asOf, tickers }))
    } catch (reason) {
      setTriageError(reason instanceof Error ? reason.message : 'Triage could not run.')
      setTriage(null)
    } finally {
      setTriageLoading(false)
    }
  }

  const advance = async (thesis: NipThesis, target: ThesisStatus) => {
    const reason = thesisGateReason(thesis, target)
    if (reason) {
      setActionIsError(true)
      setActionMessage(reason)
      return
    }
    setBusy(true)
    setActionMessage(null)
    setActionIsError(false)
    try {
      await narrativeApi.saveThesis({ ...thesis, status: target, updated_at: new Date().toISOString() })
      setActionMessage(`Thesis moved to ${thesisStatusLabel(target)}.`)
      await onChanged()
    } catch (error) {
      setActionIsError(true)
      setActionMessage(error instanceof Error ? error.message : 'The status change was refused.')
    } finally {
      setBusy(false)
    }
  }

  const markInvalidated = async (thesis: NipThesis) => {
    const observation = window.prompt('What invalidated this thesis? (the observation, not just a label)', '')
    if (observation === null) return
    setBusy(true)
    setActionMessage(null)
    setActionIsError(false)
    try {
      await narrativeApi.saveThesis({
        ...thesis,
        status: 'invalidated',
        reason: `[invalidated ${new Date().toISOString()}: ${observation || 'no observation recorded'}] ${thesis.reason ?? ''}`.trim(),
        updated_at: new Date().toISOString(),
      })
      setActionMessage('Thesis marked invalidated, with the observation recorded.')
      await onChanged()
    } catch (error) {
      setActionIsError(true)
      setActionMessage(error instanceof Error ? error.message : 'The invalidation was refused.')
    } finally {
      setBusy(false)
    }
  }

  const exportTranscript = (transcript: NipTranscript) => {
    const blob = new Blob([JSON.stringify(transcript, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${transcript.transcript_id}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const eventById = useMemo(() => new Map(events.map((event) => [event.event_id, event])), [events])
  const claimById = useMemo(() => new Map(claims.map((claim) => [claim.claim_id, claim])), [claims])
  const coverage = selected ? graphClaimCoverage(selected, claims, graph) : { inGraph: [], missing: [] }
  const selectedTranscript = transcripts[0] ?? null
  const nextPipelineStep = selected ? THESIS_PIPELINE[THESIS_PIPELINE.indexOf(selected.status) + 1] : undefined
  const canSendToVideo = Boolean(
    selected && selectedTranscript && selected.thesis_basis === 'llm_verified_only' &&
    (selected.status === 'transcript_ready' || selected.status === 'video_ready' || selected.status === 'published'),
  )

  return (
    <div className="space-y-3" data-testid="thesis-view">
      <PanelCard title="Pipeline — sweep → triage → deep dive → thesis gate → backtest → transcript" subtitle="A thesis that stopped at triage is listed as stopped, not vanished. “No thesis today” is a first-class outcome." collapsible={false} bodyClassName="narrative-card-body">
        <div className="flex flex-wrap items-center gap-2">
          <input aria-label="Triage tickers" placeholder="Tickers, e.g. NVDA, AAPL" value={triageTickers} onChange={(event) => setTriageTickers(event.target.value)} data-testid="triage-tickers" className="min-w-52 flex-1" />
          <Button size="sm" onClick={() => void runTriage()} disabled={triageLoading || !asOf} data-testid="triage-run">{triageLoading ? 'Running…' : 'Run triage'}</Button>
          <span className="text-[10px] text-muted">as_of {asOf ?? 'not set'} · triage ranks fast-glance candidates for LLM time; it does not make a call.</span>
        </div>
        {triageError ? <p className="mt-2 text-[10px] text-red-600" role="alert">{triageError}</p> : null}
        {triage ? (
          <div className="mt-2" data-testid="triage-results">
            <p className="text-[11px] text-main">{triage.candidates.length} candidate{triage.candidates.length === 1 ? '' : 's'} · {triage.rejected_count} rejected</p>
            {triage.candidates.length ? (
              <ul className="mt-1 space-y-1">{triage.candidates.map((candidate, index) => (
                <li key={index} className="text-[11px] text-main" data-testid={`triage-candidate-${index}`}>
                  {candidate.ticker ?? candidate.entity ?? 'unknown'} · z={candidate.z_score === null || candidate.z_score === undefined ? '—' : Number(candidate.z_score).toFixed(2)} · burst={candidate.burst_ratio === null || candidate.burst_ratio === undefined ? '—' : Number(candidate.burst_ratio).toFixed(2)} · n={candidate.n ?? '—'} · {candidate.llm_worth_it ? 'LLM worth it' : 'not worth LLM time'}{candidate.reason ? ` — ${candidate.reason}` : ''}
                </li>
              ))}</ul>
            ) : <p className="mt-1 text-[11px] text-amber-700" role="status">No thesis today — stopped at triage: no candidate earned LLM time.</p>}
            {triage.rejected_reasons.length ? (
              <details className="mt-2"><summary className="text-[11px] text-main">Rejected ({triage.rejected_count}) — with reasons</summary>
                <ul className="mt-1 space-y-1">{triage.rejected_reasons.map((rejected, index) => <li key={index} className="text-[10px] text-muted">{rejected.ticker ?? rejected.entity ?? 'unknown'} — {rejected.reason}</li>)}</ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </PanelCard>

      <PanelCard title="Theses" subtitle="Newest decision as_of first · provisional theses are listed and badged, never advancing" collapsible={false} bodyClassName="narrative-card-body">
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[11px] text-muted">Status <select aria-label="Filter theses by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} data-testid="thesis-filter-status"><option value="all">All</option>{[...THESIS_PIPELINE, 'rejected', 'invalidated'].map((status) => <option key={status} value={status}>{thesisStatusLabel(status as ThesisStatus)}</option>)}</select></label>
          <label className="text-[11px] text-muted">Basis <select aria-label="Filter theses by basis" value={basisFilter} onChange={(event) => setBasisFilter(event.target.value)} data-testid="thesis-filter-basis"><option value="all">All</option><option value="llm_verified_only">llm_verified_only</option><option value="provisional_fast_glance">provisional_fast_glance</option></select></label>
          <label className="text-[11px] text-muted">Symbol / title <input type="search" aria-label="Filter theses by symbol or title" placeholder="NVDA…" value={symbolFilter} onChange={(event) => setSymbolFilter(event.target.value)} data-testid="thesis-filter-symbol" /></label>
        </div>
        {filtered.length ? (
          <div className="mt-3 space-y-2">
            {filtered.map((thesis) => (
              <article key={thesis.thesis_id} className={`evidence-card ${selectedId === thesis.thesis_id ? 'is-selected' : ''}`} data-testid={`thesis-row-${thesis.thesis_id}`} onClick={() => setSelectedId(thesis.thesis_id)}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-xs text-main">{thesis.title}</strong>
                  <span className="flex flex-wrap gap-1"><BasisBadge thesis={thesis} /><span className="narrative-chip">{thesisStatusLabel(thesis.status)}</span><span className="narrative-chip">{thesis.direction}</span></span>
                </div>
                <p className="mt-1 text-[10px] text-muted">{thesis.entity_symbol ?? 'no symbol'} · horizon {thesis.horizon ?? '—'} · as_of {formatDate(thesis.as_of)}{thesis.confidence_millis !== null ? ` · ${Math.round(thesis.confidence_millis / 10)}% confidence` : ''}</p>
                {thesis.thesis_basis === 'provisional_fast_glance' ? <p className="mt-1 text-[10px] text-red-600">Provisional — listed for the audit trail, never advances past draft.</p> : null}
              </article>
            ))}
          </div>
        ) : <p className="mt-3 text-[11px] text-muted">No theses recorded yet. A thesis arrives here after triage, LLM deep dive, and the thesis gate — or nothing arrives, and “no thesis today” is the result.</p>}
      </PanelCard>

      {selected ? (
        <PanelCard title={`Thesis — ${selected.title}`} subtitle="Falsifiable statement, evidence, features, ablation, transcript" collapsible={false} bodyClassName="narrative-card-body">
          <div data-testid={`thesis-detail-${selected.thesis_id}`}>
            <section>
              <div className="flex flex-wrap items-center gap-2"><BasisBadge thesis={selected} /><span className="narrative-chip">{thesisStatusLabel(selected.status)}</span><span className="narrative-chip">{selected.direction}</span><span className="narrative-chip">horizon {selected.horizon ?? '—'}</span></div>
              <p className="mt-2 text-sm text-main">{selected.reason ?? 'No reason recorded.'}</p>
              <dl className="narrative-provenance mt-2">
                <div><dt>Decision as_of</dt><dd>{formatDate(selected.as_of)}</dd></div>
                <div><dt>Invalidation</dt><dd>{selected.invalidation_condition ?? 'not stated — a thesis without an invalidation condition cannot be tested'}</dd></div>
                <div><dt>What would change my mind</dt><dd>{selected.what_would_change_mind ?? '—'}</dd></div>
              </dl>
              <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Thesis pipeline">
                {THESIS_PIPELINE.map((step, index) => {
                  const current = THESIS_PIPELINE.indexOf(selected.status)
                  return <span key={step} className={`narrative-chip ${index === current ? 'is-active' : ''}`} data-testid={`thesis-pipeline-${step}`}>{thesisStatusLabel(step)}</span>
                })}
                {selected.status === 'rejected' || selected.status === 'invalidated' ? <span className="narrative-chip is-active">{thesisStatusLabel(selected.status)}</span> : null}
              </div>
              {selected.thesis_basis === 'provisional_fast_glance' ? (
                <p className="mt-2 text-[11px] text-red-600" role="alert" data-testid="thesis-provisional-gate">Provisional thesis — it can never enter backtested or any later stage. The gate is in the data (the store refuses the transition), not just in this UI. Deep-dive the claims, record LLM reviews, and re-issue as llm_verified_only.</p>
              ) : null}
            </section>

            <section className="mt-4">
              <h3 className="text-xs font-semibold text-main">Evidence — cited claims</h3>
              <div className="mt-2 rounded border border-line p-2" data-testid="thesis-graph-coverage">
                <p className="text-[11px] text-main"><strong>Graph coverage: {coverage.inGraph.length} of {selected.claim_ids.length} cited claims appear in the NIP graph.</strong></p>
                <p className="mt-1 text-[10px] text-muted">A single-event NIP graph holds only claims quoted in that event's transcript — it is not complete corroboration. {coverage.missing.length ? `Missing from the graph: ${coverage.missing.map((id) => claimById.get(id)?.claim_text ?? id).join(' · ')}. Do not present this graph as “${selected.claim_ids.length} sources agree” until every cited claim is in it.` : 'Every cited claim is a graph node.'}</p>
              </div>
              {selected.claim_ids.length ? (
                <div className="mt-2 space-y-2">{selected.claim_ids.map((claimId) => {
                  const claim = claimById.get(claimId)
                  if (!claim) return <p key={claimId} className="text-[11px] text-amber-700">Cited claim {claimId} is not in the current claim page.</p>
                  const sources = [...new Set(claim.evidence.map((evidence) => eventById.get(evidence.event_id)?.source_id).filter(Boolean))]
                  return (
                    <article className="evidence-card" key={claimId} data-testid={`thesis-claim-${claimId}`}>
                      <p className="text-[11px] text-main">{claim.claim_text}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <span className="narrative-chip">{tierLabel(claim.extraction_tier)}</span>
                        <span className="narrative-chip">{reviewStatusLabel(claim.review_status)}</span>
                        <span className="narrative-chip">{Math.round(claim.confidence_millis / 10)}% confidence</span>
                        <span className="narrative-chip" data-testid={`thesis-claim-corroboration-${claimId}`}>{sources.length} source{sources.length === 1 ? '' : 's'} cited</span>
                        {coverage.inGraph.includes(claimId) ? <span className="narrative-chip">in graph</span> : <span className="narrative-chip">not in graph</span>}
                      </div>
                      {claim.evidence.map((evidence, index) => <blockquote key={index} className="mt-1 text-[11px]">“{evidence.quote ?? 'no quote recorded'}” <span className="text-muted">— {eventById.get(evidence.event_id)?.source_id ?? evidence.event_id}</span></blockquote>)}
                    </article>
                  )
                })}</div>
              ) : <p className="mt-1 text-[10px] text-muted">No claims cited.</p>}
              {selected.rejected_claims.length ? (
                <details className="mt-2"><summary className="text-[11px] text-main">Considered and rejected ({selected.rejected_claims.length})</summary>
                  <ul className="mt-1 space-y-1">{selected.rejected_claims.map((rejected) => <li key={rejected.claim_id} className="text-[10px] text-muted">{claimById.get(rejected.claim_id)?.claim_text ?? rejected.claim_id} — {rejected.reason}</li>)}</ul>
                </details>
              ) : null}
            </section>

            <section className="mt-4">
              <h3 className="text-xs font-semibold text-main">Features at decision as_of</h3>
              {detailLoading ? <p className="mt-1 text-[10px] text-muted">Loading features…</p>
              : !selected.entity_symbol ? <p className="mt-1 text-[10px] text-muted">No symbol — no feature vector.</p>
              : featuresError ? <p className="mt-1 text-[10px] text-amber-700">{featuresError}</p>
              : features ? features.error === 'symbol_unmapped' ? <p className="mt-1 text-[10px] text-amber-700">Symbol unmapped at this as_of — no features were guessed.</p>
              : <div className="mt-1" data-testid="thesis-features">
                <p className="text-[11px] text-main">LLM-verified coverage: {features.llm_verified_coverage === null || features.llm_verified_coverage === undefined ? '—' : `${Math.round(features.llm_verified_coverage * 100)}%`}</p>
                {features.mostly_fast_glance ? <p className="mt-1 text-[10px] text-amber-700">mostly_fast_glance — over half of these features are fast glance. Missing values are shown as —, never 0.</p> : null}
                {features.features_by_tier ? <dl className="narrative-provenance mt-2">{Object.entries(features.features_by_tier).map(([tier, values]) => <div key={tier}><dt>{tier}</dt><dd>{Object.entries(values).map(([key, value]) => `${key}: ${value === null || value === undefined ? '—' : value}`).join(' · ')}</dd></div>)}</dl> : <p className="mt-1 text-[10px] text-muted">No feature vector returned.</p>}
              </div> : null}
            </section>

            <section className="mt-4">
              <h3 className="text-xs font-semibold text-main">Backtest — ablation A vs B</h3>
              {detailLoading ? <p className="mt-1 text-[10px] text-muted">Loading backtests…</p>
              : backtests.length ? backtests.map((backtest) => (
                <div key={backtest.backtest_id} className="mt-2 rounded border border-line p-2" data-testid={`thesis-backtest-${backtest.backtest_id}`}>
                  <p className="text-[11px] text-main"><strong>Verdict: {backtest.verdict === 'supported' ? 'thesis SUPPORTED by the backtest' : backtest.verdict === 'not_supported' ? 'thesis NOT supported by the backtest' : 'ablation could not run'}</strong></p>
                  {backtest.verdict === 'could_not_run' ? <p className="mt-1 text-[10px] text-amber-700">Could not run: {backtest.could_not_run_reason ?? 'no reason recorded'}. This is recorded, never a missing panel that looks like a pass.</p> : null}
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div><p className="text-[10px] text-muted">Run A — TA+macro ({backtest.run_id_a})</p><p className="text-[11px] text-main">Sharpe {formatNumber(backtest.metrics_a.sharpe)} · return {formatNumber(backtest.metrics_a.total_return)} · max DD {formatNumber(backtest.metrics_a.max_drawdown)} · IC {formatNumber(backtest.metrics_a.ic)}</p></div>
                    <div><p className="text-[10px] text-muted">Run B — TA+macro+$narr_* tier2_llm ({backtest.run_id_b})</p><p className="text-[11px] text-main">Sharpe {formatNumber(backtest.metrics_b.sharpe)} · return {formatNumber(backtest.metrics_b.total_return)} · max DD {formatNumber(backtest.metrics_b.max_drawdown)} · IC {formatNumber(backtest.metrics_b.ic)}</p></div>
                  </div>
                  <p className="mt-2 text-[11px] text-main">Delta A→B out-of-sample: Sharpe {formatNumber(backtest.delta.sharpe, 3)} · return {formatNumber(backtest.delta.total_return, 3)} · max DD {formatNumber(backtest.delta.max_drawdown, 3)} · IC {formatNumber(backtest.delta.ic, 3)}</p>
                  <p className="mt-1 text-[10px] text-muted">Config fingerprint {backtest.config_fingerprint ?? '—'} · recorded {formatDate(backtest.recorded_at)} · source {backtest.source}</p>
                </div>
              )) : <p className="mt-1 text-[10px] text-muted">No ablation recorded for this thesis yet. The thesis cannot advance to transcript_ready without one — run the A/B ablation (TA+macro vs TA+macro+$narr_* tier2_llm, same seed/dates, out-of-sample delta).</p>}
            </section>

            <section className="mt-4">
              <h3 className="text-xs font-semibold text-main">Transcript</h3>
              {detailLoading ? <p className="mt-1 text-[10px] text-muted">Loading transcripts…</p>
              : selectedTranscript ? (
                <div className="mt-2" data-testid={`thesis-transcript-${selectedTranscript.transcript_id}`}>
                  <p className="text-[11px] text-main">{selectedTranscript.summary ?? 'No summary recorded.'}</p>
                  <p className="mt-1 text-[10px] text-muted">Hash {selectedTranscript.transcript_hash} · {selectedTranscript.beats.length} beats · fina-import {selectedTranscript.fina_import_path ?? 'not exported'}</p>
                  <ol className="mt-2 space-y-2">{selectedTranscript.beats.map((beat) => (
                    <li key={beat.ordinal} className="rounded border border-line p-2"><p className="text-[10px] text-muted">Beat {beat.ordinal} — {beat.title}</p><p className="mt-1 text-[11px] text-main">{beat.script}</p><p className="mt-1 text-[10px] text-muted">Evidence: {beat.evidence_refs.map((ref) => [ref.kind, ref.claim_id ?? ref.item_id ?? ref.backtest_id ?? ref.run_id ?? ''].filter(Boolean).join(':')).join(' · ') || 'none'}</p></li>
                  ))}</ol>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => exportTranscript(selectedTranscript)} data-testid="thesis-export-transcript">Export fina-import JSON</Button>
                  </div>
                </div>
              ) : <p className="mt-1 text-[10px] text-muted">{selected.thesis_basis === 'provisional_fast_glance' ? 'No transcript exists — the tool refuses to write one for a provisional thesis.' : 'No transcript recorded yet.'}</p>}
            </section>

            <section className="mt-4 flex flex-wrap gap-2">
              {nextPipelineStep && selected.status !== 'published' ? (
                <Button size="sm" disabled={busy || !canAdvanceThesis(selected, nextPipelineStep)} onClick={() => void advance(selected, nextPipelineStep)} data-testid={`thesis-advance-${nextPipelineStep}`} title={canAdvanceThesis(selected, nextPipelineStep) ? undefined : thesisGateReason(selected, nextPipelineStep) ?? undefined}>
                  Advance to {thesisStatusLabel(nextPipelineStep)}
                </Button>
              ) : null}
              <Button size="sm" variant="outline" disabled={busy || selected.status === 'invalidated'} onClick={() => void markInvalidated(selected)} data-testid="thesis-invalidate">Mark invalidated</Button>
              <Button size="sm" variant="outline" disabled={!canSendToVideo || !onSendToVideo} onClick={() => onSendToVideo?.(selected, selectedTranscript)} data-testid="thesis-send-to-video" title={canSendToVideo ? undefined : 'Send to Video needs a recorded transcript for an llm_verified_only thesis at transcript_ready or later.'}>
                Send to Video
              </Button>
              {!canSendToVideo ? <span className="text-[10px] text-muted">Send to Video unlocks once a transcript exists for an llm_verified_only thesis at transcript_ready or later.</span> : null}
            </section>
            {actionMessage ? <p className={`mt-2 text-[10px] ${actionIsError ? 'text-red-600' : 'text-muted'}`} role={actionIsError ? 'alert' : 'status'}>{actionMessage}</p> : null}
          </div>
        </PanelCard>
      ) : null}
    </div>
  )
}
