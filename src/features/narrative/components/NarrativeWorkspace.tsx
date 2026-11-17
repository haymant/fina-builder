import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Activity, AlertCircle, ArrowLeft, BarChart3, BookOpen, CheckCircle2, ChevronRight, Circle, Clock3, Database, FileText, ListChecks, Network, RefreshCw, Search, ShieldCheck, Sparkles, WifiOff } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { PanelCard } from '../../shared/components/PanelCard'
import { AddSourceForm, SourceRegistry } from './SourceRegistry'
import { narrativeApi } from '../api'
import type { NipCapabilities, NipClaim, NipEditorialCandidate, NipEtfMapping, NipEvent, NipExtractionStatus, NipHealth, NipNarrativeCluster, NipNarrativeGraph, NipNarrativeSignal, NipPodcastEpisode, NipPodcastSubscription, NipProviderStatus, NipResourceStatus, NipSource } from '../types'
import './narrative.css'

type NarrativeView = 'overview' | 'radar' | 'timeline' | 'graph' | 'themes' | 'editorial' | 'claims'

function formatDate(value: string | null | undefined): string {
  if (!value) return 'Not available'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function confidenceLabel(millis: number): string {
  return `${Math.round(millis / 10)}% confidence`
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="narrative-notice narrative-notice-error" role="alert">
      <AlertCircle size={16} />
      <div className="min-w-0 flex-1"><strong>NIP service unavailable</strong><p>{message}</p></div>
      <Button variant="outline" size="sm" onClick={onRetry}><RefreshCw size={13} /> Retry</Button>
    </div>
  )
}

function StatusCard({ health, subscriptions, loading }: { health: NipHealth | null; subscriptions: NipPodcastSubscription[]; loading: boolean }) {
  return (
    <PanelCard title="Local readiness" subtitle="NIP-owned DuckDB and service boundary" collapsible={false} bodyClassName="narrative-card-body">
      <div>
        <div className="flex items-center gap-3">
          <span className={`narrative-status-dot ${health ? 'is-ready' : 'is-pending'}`} aria-hidden />
          <div><p className="text-sm font-semibold text-main">{loading ? 'Checking local service…' : health ? 'Ready for local review' : 'Not connected'}</p><p className="text-xs text-muted">{health ? `Schema v${health.schema_version} · API v${health.api_version}` : 'Start nip-engine to review retained events and claims.'}</p></div>
        </div>
        <dl className="narrative-kv-list"><div><dt>Storage</dt><dd>DuckDB ledger</dd></div><div><dt>Search</dt><dd>{health ? 'Text + optional hybrid' : 'Unavailable'}</dd></div><div><dt>Semantic index</dt><dd>Optional Qdrant</dd></div><div><dt>Approved feeds</dt><dd>{subscriptions.length ? `${subscriptions.length} · ${subscriptions[0].state}` : 'None yet'}</dd></div></dl>
      </div>
    </PanelCard>
  )
}

type SetupState = 'done' | 'next' | 'action' | 'blocked' | 'pending'

function setupStateLabel(state: SetupState): string {
  if (state === 'done') return 'Complete'
  if (state === 'next') return 'Next'
  if (state === 'action') return 'Consent needed'
  if (state === 'blocked') return 'Blocked'
  return 'Waiting'
}

export function SetupChecklist({ health, provider, subscriptions, events, claims }: { health: NipHealth | null; provider: NipProviderStatus | null; subscriptions: NipPodcastSubscription[]; events: NipEvent[]; claims: NipClaim[] }) {
  const providerDetail = !provider
    ? 'Checking the RIGA-selected provider…'
    : !provider.configured
      ? 'Configure a local or remote model in RIGA.'
      : provider.remote && provider.consent !== 'granted'
        ? `${provider.model ?? 'Configured model'} · remote consent is required.`
        : `${provider.model ?? 'Configured model'} · ${provider.remote ? 'remote' : 'local'} · extraction ${provider.extraction_state.replace('_', ' ')}.`
  const steps: Array<{ id: string; title: string; detail: string; state: SetupState }> = [
    { id: 'service', title: 'Local service', detail: health ? `DuckDB schema v${health.schema_version} · API v${health.api_version}` : 'Start the NIP sidecar to open the local ledger.', state: health ? 'done' : 'blocked' },
    { id: 'provider', title: 'Extraction provider', detail: providerDetail, state: !provider ? 'pending' : !provider.configured ? 'blocked' : provider.remote && provider.consent !== 'granted' ? 'action' : 'done' },
    { id: 'source', title: 'Approved source', detail: subscriptions.length ? `${subscriptions.length} feed${subscriptions.length === 1 ? '' : 's'} approved with rights confirmation.` : 'Confirm access and retention rights before NIP fetches a feed.', state: subscriptions.length ? 'done' : 'next' },
    { id: 'transcript', title: 'Retained transcript', detail: events.length ? `${events.length} source-linked event${events.length === 1 ? '' : 's'} in the ledger.` : subscriptions.length ? 'Review a discovered episode and transcribe it locally.' : 'Waiting for an approved feed.', state: events.length ? 'done' : subscriptions.length ? 'next' : 'pending' },
    { id: 'claims', title: 'Evidence-linked claims', detail: claims.length ? `${claims.length} claim${claims.length === 1 ? '' : 's'} retain event quotes and derivation provenance.` : events.length ? 'Run extraction and review the evidence links.' : 'Waiting for a retained transcript.', state: claims.length ? 'done' : events.length ? 'next' : 'pending' },
  ]
  const complete = steps.filter((step) => step.state === 'done').length
  return <section className="narrative-setup" aria-label="NIP setup checklist" data-testid="nip-setup-checklist">
    <div className="narrative-setup-head"><span className="narrative-setup-icon"><ListChecks size={16} /></span><div><p className="eyebrow">First-run setup</p><h2 className="text-sm font-semibold text-main">From source rights to reviewable evidence</h2><p className="text-[10px] text-muted">Desktop sidecar · local DuckDB ledger · model selected in RIGA</p></div><span className="narrative-chip">{complete}/{steps.length} complete</span></div>
    <ol className="narrative-setup-steps">{steps.map((step, index) => <li key={step.id} data-state={step.state}><span className="narrative-setup-index" aria-hidden>{step.state === 'done' ? <CheckCircle2 size={13} /> : <Circle size={13} />}</span><div><strong>{step.title}</strong><p>{step.detail}</p></div><span className="narrative-setup-state">{setupStateLabel(step.state)}</span><span className="sr-only">step {index + 1}</span></li>)}</ol>
  </section>
}

function PollingStatus({ subscriptions, onRefresh, refreshing }: { subscriptions: NipPodcastSubscription[]; onRefresh: () => Promise<void>; refreshing: boolean }) {
  return <PanelCard title="Refresh status" bodyClassName="narrative-card-body" subtitle="The desktop process refreshes due feeds at startup and every six hours." collapsible={false} actions={<Button variant="ghost" size="sm" onClick={() => void onRefresh()} disabled={refreshing}><RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Run now</Button>}>
    {subscriptions.length ? <div className="space-y-2">{subscriptions.map((subscription) => <div className="evidence-card" key={subscription.source_id}><div className="flex items-center justify-between gap-2"><strong className="text-xs text-main">{subscription.show_name}</strong><span className="narrative-chip">{subscription.state}</span></div><dl className="narrative-provenance mt-2"><div><dt>Last checked</dt><dd>{formatDate(subscription.last_checked_at)}</dd></div><div><dt>Next poll</dt><dd>{formatDate(subscription.next_poll_at)}</dd></div></dl>{subscription.last_error_code ? <p className="mt-2 text-[10px] text-red-600">Last error: {subscription.last_error_code} · {subscription.consecutive_failures} consecutive failure{subscription.consecutive_failures === 1 ? '' : 's'}</p> : <p className="mt-2 text-[10px] text-muted">No recorded feed errors.</p>}</div>)}</div> : <p className="text-[11px] text-muted">No approved feeds are scheduled.</p>}
  </PanelCard>
}

export function OperationalMonitor({ resource, extraction }: { resource: NipResourceStatus | null; extraction: NipExtractionStatus | null }) {
  return <PanelCard title="Operational monitor" bodyClassName="narrative-card-body" subtitle="What is local, derived, and currently reviewable" collapsible={false}>
    <div className="grid grid-cols-2 gap-2 text-[10px]">
      <div className="evidence-card"><Database size={13} className="text-primary" /><span className="mt-1 block text-muted">Ledger</span><strong className="text-main">{resource ? `${resource.event_count} events · ${resource.database_bytes} B` : 'Checking…'}</strong></div>
      <div className="evidence-card"><Activity size={13} className="text-primary" /><span className="mt-1 block text-muted">Extraction</span><strong className="text-main">{extraction ? `${extraction.claim_count} claims · ${extraction.extraction_run_count} runs` : 'Checking…'}</strong></div>
      <div className="evidence-card"><Network size={13} className="text-primary" /><span className="mt-1 block text-muted">Graph</span><strong className="text-main">{resource ? `${resource.graph_edge_count} evidence edges` : 'Checking…'}</strong></div>
      <div className="evidence-card"><Clock3 size={13} className="text-primary" /><span className="mt-1 block text-muted">Scheduler</span><strong className="text-main">{resource ? `Every ${resource.scheduler_interval_seconds / 3600}h · ${resource.scheduler_state}` : 'Checking…'}</strong></div>
    </div>
    {extraction?.latest_provider ? <p className="mt-3 text-[10px] text-muted">Latest extraction: {extraction.latest_provider} / {extraction.latest_model} · run {extraction.latest_run_id}</p> : <p className="mt-3 text-[10px] text-amber-700">No extraction run has committed claims yet.</p>}
    {resource?.warnings.length ? <p className="mt-2 text-[10px] text-amber-700">Resource warnings: {resource.warnings.join(' · ')}</p> : null}
    {extraction?.warnings.length ? <p className="mt-2 text-[10px] text-amber-700">Extraction warnings: {extraction.warnings.join(' · ')}</p> : null}
  </PanelCard>
}

export function ProviderStatusPanel({ status, busy, onGrant, onRevoke }: { status: NipProviderStatus | null; busy: boolean; onGrant: () => Promise<void>; onRevoke: () => Promise<void> }) {
  if (!status) return <PanelCard title="Extraction provider" bodyClassName="narrative-card-body" subtitle="Configured through the RIGA assistant · credentials stay in the desktop host" collapsible={false}><p className="text-[11px] text-muted">Checking the configured provider…</p></PanelCard>
  if (!status.configured) return <PanelCard title="Extraction provider" bodyClassName="narrative-card-body" subtitle="Configured through the RIGA assistant · credentials stay in the desktop host" collapsible={false}><div className="space-y-2"><div className="flex items-center gap-2"><WifiOff size={14} className="text-amber-700" /><strong className="text-xs text-main">{status.bridge_state === 'not_configured' ? 'Provider bridge not configured' : 'Provider unavailable'}</strong></div><p className="text-[10px] text-muted">Claim extraction stays unavailable. NIP does not fall back to a different or fake provider.</p>{status.warnings.length ? <p className="text-[10px] text-amber-700">{status.warnings.join(' · ')}</p> : null}</div></PanelCard>
  const consentLabel = status.remote ? status.consent.replace('_', ' ') : 'not required for local models'
  return <PanelCard title="Extraction provider" bodyClassName="narrative-card-body" subtitle="Configured through the RIGA assistant · credentials stay in the desktop host" collapsible={false}><div className="space-y-2"><div className="flex items-center justify-between gap-2"><strong className="text-xs text-main">{status.model}</strong><span className="narrative-chip">{status.remote ? 'remote' : 'local'}</span></div><dl className="narrative-provenance"><div><dt>Provider</dt><dd>{status.provider_id || status.provider_api || 'Configured provider'}</dd></div><div><dt>Reasoning</dt><dd>{status.reasoning_effort || 'Default'}</dd></div><div><dt>Consent</dt><dd>{consentLabel}</dd></div><div><dt>Extraction</dt><dd>{status.extraction_state.replace('_', ' ')}</dd></div></dl>{status.remote && status.disclosure && status.consent !== 'granted' ? <p className="text-[10px] text-amber-700" role="status">{status.disclosure}</p> : null}{status.consent_recorded_at ? <p className="text-[10px] text-muted">Consent recorded {formatDate(status.consent_recorded_at)}</p> : null}{status.warnings.length ? <p className="text-[10px] text-amber-700">{status.warnings.join(' · ')}</p> : null}<div className="flex flex-wrap gap-2">{status.remote && status.consent !== 'granted' ? <Button size="sm" disabled={busy} onClick={() => void onGrant()}><ShieldCheck size={13} /> {busy ? 'Recording…' : 'Allow remote extraction'}</Button> : null}{status.remote && status.consent === 'granted' ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void onRevoke()}><WifiOff size={13} /> {busy ? 'Revoking…' : 'Revoke remote consent'}</Button> : null}</div></div></PanelCard>
}

type EpisodeSort = 'published_desc' | 'title_asc'

export interface EpisodeFilters {
  sort: EpisodeSort
  sourceId: string
  title: string
}

/** Keep the card responsive when a feed has thousands of discovered items. */
const EPISODE_PAGE_SIZE = 50

function formatEpisodeCount(total: number): string {
  return `${total.toLocaleString()} episode${total === 1 ? '' : 's'}`
}

export function EpisodePanel({ subscriptions, episodes, total, loading, hasMore, filters, onFiltersChange, onLoadMore, busyKey, message, onTranscribe, transcriptionAvailable }: { subscriptions: NipPodcastSubscription[]; episodes: NipPodcastEpisode[]; total: number; loading: boolean; hasMore: boolean; filters: EpisodeFilters; onFiltersChange: (filters: EpisodeFilters) => void; onLoadMore: () => void; busyKey: string | null; message: string | null; onTranscribe: (episode: NipPodcastEpisode) => Promise<void>; transcriptionAvailable: boolean }) {
  const sentinel = useRef<HTMLDivElement | null>(null)
  const showNames = useMemo(() => new Map(subscriptions.map((subscription) => [subscription.source_id, subscription.show_name])), [subscriptions])
  const sourceOptions = useMemo(() => [...showNames.entries()].sort((left, right) => left[1].localeCompare(right[1])), [showNames])

  useEffect(() => {
    const node = sentinel.current
    if (!node || !hasMore || loading) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoadMore()
    }, { rootMargin: '240px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, loading, onLoadMore])

  return <PanelCard title="Discovered episodes" bodyClassName="narrative-card-body" subtitle={`RSS metadata · ${EPISODE_PAGE_SIZE} per page · local transcription is a separate, explicit step`} collapsible={false}>
    {subscriptions.length ? <>
      <div className="episode-controls" role="group" aria-label="Episode filters and sorting">
        <label className="episode-control"><span>Sort</span><select aria-label="Sort episodes" value={filters.sort} onChange={(event) => onFiltersChange({ ...filters, sort: event.target.value as EpisodeSort })}><option value="published_desc">Published · newest first</option><option value="title_asc">Title · A–Z</option></select></label>
        <label className="episode-control"><span>Source</span><select aria-label="Filter episodes by source" value={filters.sourceId} onChange={(event) => onFiltersChange({ ...filters, sourceId: event.target.value })}><option value="all">All sources</option>{sourceOptions.map(([sourceId, showName]) => <option key={sourceId} value={sourceId}>{showName}</option>)}</select></label>
        <label className="episode-control episode-control-title"><span>Title contains</span><input type="search" aria-label="Filter episodes by title" placeholder="e.g. rates, inflation…" value={filters.title} onChange={(event) => onFiltersChange({ ...filters, title: event.target.value })} /></label>
      </div>
      <p className="episode-count" role="status">Showing {episodes.length.toLocaleString()} of {formatEpisodeCount(total)}{filters.sourceId === 'all' ? '' : ` · ${showNames.get(filters.sourceId) ?? filters.sourceId}`}{filters.title.trim() ? ` · title contains “${filters.title.trim()}”` : ''}</p>
      {!transcriptionAvailable ? <p className="episode-empty episode-empty-error" role="alert"><strong>Local ASR is not configured.</strong> Set <code>NIP_COMFYUI_URL</code> to a loopback ComfyUI server running the Qwen3-ASR workflow and restart the app. NIP will not upload audio or substitute a remote ASR service.</p> : null}
      {loading && !episodes.length ? <p className="episode-empty"><RefreshCw size={14} className="animate-spin" /> Loading episodes…</p> : episodes.length ? <ul className="episode-list">{episodes.map((episode, index) => {
        const key = `${episode.source_id}:${episode.source_native_id ?? episode.canonical_url ?? episode.title ?? index}`
        const canTranscribe = episode.state === 'awaiting_local_transcription' || episode.state === 'failed' || episode.state === 'transcription_unavailable'
        return <li className="episode-row" key={key}><div className="flex items-start justify-between gap-2"><div className="min-w-0"><strong className="block truncate text-[11px] text-main">{episode.title ?? episode.source_native_id ?? 'Untitled episode'}</strong><p className="mt-1 text-[10px] text-muted">{showNames.get(episode.source_id) ?? episode.source_id} · {episode.source_native_id ?? 'No episode GUID'} · published {formatDate(episode.published_at)}</p></div><span className="narrative-chip">{episode.state.replaceAll('_', ' ')}</span></div>{canTranscribe && transcriptionAvailable ? <Button className="mt-2" variant="outline" size="sm" disabled={busyKey === key || !episode.enclosure_url} onClick={() => void onTranscribe(episode)}><Sparkles size={12} /> {busyKey === key ? 'Transcribing locally…' : episode.state === 'failed' || episode.state === 'transcription_unavailable' ? 'Retry local transcription' : 'Transcribe locally'}</Button> : episode.state === 'transcribed' ? <p className="mt-2 text-[10px] text-emerald-700">Transcript committed · open the retained event to review provenance.</p> : canTranscribe && !episode.enclosure_url ? <p className="mt-2 text-[10px] text-amber-700">No audio enclosure is available for this episode.</p> : canTranscribe ? null : <p className="mt-2 text-[10px] text-amber-700">Local transcription is unavailable for this episode. NIP will not upload audio or substitute a remote ASR service.</p>}</li>
      })}</ul> : total ? <p className="episode-empty">No episodes match the current filters. Clear the title filter or choose another source.</p> : <p className="episode-empty">No RSS episodes discovered yet. Run a due-feed refresh after the initial sync.</p>}
      {hasMore ? <div className="episode-sentinel" ref={sentinel} aria-hidden>{loading ? <RefreshCw size={14} className="animate-spin" /> : <span>Scroll for more episodes…</span>}</div> : null}
    </> : <p className="text-[11px] text-muted">Approve a podcast feed to discover episodes. The primary journey never asks you to import each episode file.</p>}
    {message ? <p className="mt-2 text-[10px] text-muted" role="status">{message}</p> : null}
  </PanelCard>
}

function GraphExplorer({ graph, onOpenEvent }: { graph: NipNarrativeGraph | null; onOpenEvent: (eventId: string) => void }) {
  if (!graph) return <div className="narrative-empty"><Network size={22} /><p>No graph projection has been built.</p><span>Rebuild the graph after claims and clusters are available; the last successful version remains authoritative.</span></div>
  return <div className="space-y-3"><div className="evidence-card"><p className="eyebrow">Versioned graph projection</p><h2 className="mt-1 text-sm font-semibold text-main">{graph.algorithm_version}</h2><p className="mt-1 text-[10px] text-muted">Run {graph.derivation_run_id} · built {formatDate(graph.created_at)} · {graph.nodes.length} nodes · {graph.edges.length} evidence-linked edges</p></div>{graph.edges.map((edge) => <article className="evidence-card" key={edge.edge_id}><div className="flex items-center justify-between gap-2"><strong className="text-xs text-main">{edge.edge_type.replace('_', ' ')}</strong><span className="narrative-chip">{Math.round(edge.confidence_millis / 10)}% confidence</span></div><p className="mt-1 text-[10px] text-muted">{edge.from_node_id} → {edge.to_node_id}</p><div className="mt-2 flex flex-wrap gap-1">{edge.evidence_event_ids.map((eventId) => <button className="narrative-chip underline" type="button" key={eventId} onClick={() => onOpenEvent(eventId)}>Evidence {eventId.slice(0, 12)}…</button>)}</div></article>)}</div>
}

function SignalExplorer({ signals, mode, onOpenEvent }: { signals: NipNarrativeSignal[]; mode: 'radar' | 'timeline'; onOpenEvent: (eventId: string) => void }) {
  const ordered = [...signals].sort((a, b) => b.current_count - a.current_count || b.distinct_source_categories - a.distinct_source_categories || a.narrative_id.localeCompare(b.narrative_id))
  if (!ordered.length) return <div className="narrative-empty"><BarChart3 size={22} /><p>No dated narrative signals are available.</p><span>Signals require retained observations with trustworthy publication dates.</span></div>
  return <div className="space-y-3">{ordered.map((signal) => <article className="evidence-card" key={signal.narrative_id}><div className="flex items-start justify-between gap-3"><div><p className="eyebrow">{mode === 'radar' ? 'Radar ranking' : 'Timeline window'}</p><h3 className="text-sm font-semibold text-main">{signal.label}</h3><p className="mt-1 text-[10px] text-muted">{formatDate(signal.current_week_start)} – {formatDate(signal.current_week_end)} · {signal.coverage} coverage</p></div><span className="narrative-chip">{signal.distinct_source_categories} categories</span></div><div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4"><div><span className="text-[10px] text-muted">Current week</span><strong className="block text-lg text-main">{signal.current_count}</strong></div><div><span className="text-[10px] text-muted">Prior week</span><strong className="block text-lg text-main">{signal.prior_count}</strong></div><div><span className="text-[10px] text-muted">Delta / day</span><strong className="block text-lg text-main">{signal.delta_mentions_per_day.toFixed(2)}</strong></div><div><span className="text-[10px] text-muted">Persistence</span><strong className="block text-lg text-main">{signal.persistence_complete_weeks} wk</strong></div></div><div className="mt-3 flex flex-wrap gap-1">{Object.entries(signal.category_counts).map(([category, count]) => <span className="narrative-chip" key={category}>{category}: {count}</span>)}</div>{signal.percent_change === null ? <p className="mt-2 text-[10px] text-muted">No comparable baseline; percent change is intentionally unavailable.</p> : null}{signal.data_quality_flags.length ? <p className="mt-2 text-[10px] text-amber-700">Quality: {signal.data_quality_flags.join(' · ')}</p> : null}<div className="mt-3 flex flex-wrap items-center gap-2"><Clock3 size={12} className="text-muted" /><span className="text-[10px] text-muted">Evidence:</span>{signal.evidence_event_ids.slice(0, 8).map((eventId) => <button className="narrative-chip underline" key={eventId} type="button" onClick={() => onOpenEvent(eventId)}>{eventId.slice(0, 12)}…</button>)}</div></article>)}</div>
}

function EventRow({ event, onOpen }: { event: NipEvent; onOpen: () => void }) {
  const preview = event.content_text?.replace(/\s+/g, ' ').slice(0, 180) || 'No retained text preview.'
  return (
    <button type="button" className="narrative-event-row" onClick={onOpen}>
      <div className="narrative-event-icon"><FileText size={15} /></div>
      <div className="min-w-0 flex-1 text-left"><div className="flex items-center gap-2"><strong className="truncate text-xs text-main">{event.source_native_id || event.event_id}</strong><span className="narrative-chip">{event.source_id}</span></div><p className="mt-1 line-clamp-2 text-[11px] text-muted">{preview}</p><p className="mt-1 text-[10px] text-muted">Published {formatDate(event.times.published_at)} · captured {formatDate(event.times.captured_at)}</p></div><ChevronRight size={15} className="shrink-0 text-muted" />
    </button>
  )
}

export function ClaimExplorer({ claims, events, selectedClaimId, onSelectClaim, onBack }: { claims: NipClaim[]; events: NipEvent[]; selectedClaimId?: string; onSelectClaim: (claim: NipClaim) => void; onBack?: () => void }) {
  const selected = claims.find((claim) => claim.claim_id === selectedClaimId) ?? claims[0]
  const eventById = useMemo(() => new Map(events.map((event) => [event.event_id, event])), [events])
  if (!selected) return <div className="narrative-empty"><ShieldCheck size={25} /><p>No claims have been extracted yet.</p><span>Claims appear here after a deterministic or configured extraction run commits evidence.</span></div>
  return (
    <div className="claim-explorer-grid">
      <div className="claim-list" aria-label="Claims">
        {claims.map((claim) => <button type="button" key={claim.claim_id} className={`claim-list-item ${claim.claim_id === selected.claim_id ? 'is-selected' : ''}`} onClick={() => onSelectClaim(claim)}><span className="claim-confidence" aria-hidden style={{ '--confidence': `${Math.min(100, Math.max(0, claim.confidence_millis / 10))}%` } as CSSProperties} /><span className="min-w-0 flex-1 text-left"><strong className="line-clamp-2 text-xs text-main">{claim.claim_text}</strong><small>{confidenceLabel(claim.confidence_millis)} · {claim.evidence.length} evidence link{claim.evidence.length === 1 ? '' : 's'}</small></span><ChevronRight size={14} className="shrink-0 text-muted" /></button>)}
      </div>
      <article className="claim-detail" aria-label="Claim details">
        <div className="flex items-start justify-between gap-4"><div><p className="eyebrow">Evidence-linked claim</p><h2 className="mt-1 text-base font-semibold text-main">{selected.claim_text}</h2></div>{onBack ? <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft size={13} /> Events</Button> : null}</div>
        <div className="claim-meta-grid"><div><span>Confidence</span><b>{confidenceLabel(selected.confidence_millis)}</b></div><div><span>Speaker / author</span><b>{selected.speaker_or_author || 'Not specified'}</b></div><div><span>Extracted</span><b>{formatDate(selected.extracted_at)}</b></div><div><span>Run</span><b className="font-mono text-[10px]">{selected.extraction_run_id}</b></div></div>
        <section className="mt-5"><div className="flex items-center gap-2"><BookOpen size={14} className="text-primary" /><h3 className="text-xs font-semibold uppercase tracking-wide text-main">Source evidence</h3></div><div className="mt-2 space-y-2">{selected.evidence.map((evidence, index) => { const event = eventById.get(evidence.event_id); return <div className="evidence-card" key={`${evidence.event_id}-${index}`}><div className="flex items-center justify-between gap-3"><span className="narrative-chip">Event {evidence.event_id}</span><span className="text-[10px] text-muted">{event ? event.source_id : 'Source not in current page'}</span></div>{evidence.quote ? <blockquote>“{evidence.quote}”</blockquote> : <p className="mt-2 text-[11px] text-muted">No quote or span was provided by this source format.</p>}{event ? <p className="mt-2 text-[10px] text-muted">Published {formatDate(event.times.published_at)} · ingested {formatDate(event.times.ingested_at)}</p> : null}</div> })}</div></section>
        <section className="mt-5 border-t border-line pt-4"><p className="eyebrow">Derivation provenance</p><dl className="narrative-provenance"><div><dt>Provider</dt><dd>{selected.provider}</dd></div>{selected.provider_kind ? <div><dt>Provider type</dt><dd>{selected.provider_kind}</dd></div> : null}{selected.provider_profile_id ? <div><dt>Profile</dt><dd>{selected.provider_profile_id}</dd></div> : null}<div><dt>Model</dt><dd>{selected.model}</dd></div>{selected.reasoning_effort ? <div><dt>Reasoning</dt><dd>{selected.reasoning_effort}</dd></div> : null}<div><dt>Prompt / schema</dt><dd>{selected.prompt_version}</dd></div></dl></section>
      </article>
    </div>
  )
}

function EtfMappingForm({ events, onSaved }: { events: NipEvent[]; onSaved: () => Promise<void> }) {
  const [ticker, setTicker] = useState('')
  const [narrativeId, setNarrativeId] = useState('')
  const [rationale, setRationale] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault(); const evidence = events[0]?.event_id; if (!evidence || !ticker.trim() || !narrativeId.trim() || !rationale.trim()) { setMessage('Add a narrative, ticker, rationale, and retain at least one event first.'); return }
    setSaving(true); setMessage(null)
    try { const now = new Date().toISOString(); await narrativeApi.saveEtfMapping({ mapping_id: `mapping-${Date.now()}`, narrative_id: narrativeId.trim(), ticker: ticker.trim().toUpperCase(), rationale: rationale.trim(), evidence_event_ids: [evidence], author: 'local-analyst', reviewer: null, version: 1, effective_from: now, effective_to: null, known_at: now, review_status: 'unreviewed', ticker_status: 'unknown', market_data_coverage: 'unavailable', mapping_validity: 'pending_review', supersedes_mapping_id: null, created_at: now }); setTicker(''); setNarrativeId(''); setRationale(''); setMessage('Mapping saved as an unreviewed research record.'); await onSaved() } catch (error) { setMessage(error instanceof Error ? error.message : 'Mapping could not be saved.') } finally { setSaving(false) }
  }
  return <form className="evidence-card space-y-2" onSubmit={submit}><p className="eyebrow">Add manual mapping revision</p><div className="grid gap-2 sm:grid-cols-2"><input aria-label="Narrative ID" placeholder="Narrative ID" value={narrativeId} onChange={(event) => setNarrativeId(event.target.value)} /><input aria-label="ETF ticker" placeholder="ETF ticker" value={ticker} onChange={(event) => setTicker(event.target.value)} /></div><textarea aria-label="Mapping rationale" placeholder="Why is this association worth researching?" value={rationale} onChange={(event) => setRationale(event.target.value)} /><p className="text-[10px] text-muted">Evidence defaults to the first retained event: {events[0]?.event_id ?? 'none available'}. Ticker existence and market-data coverage remain unknown/unavailable until separately verified.</p><Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : 'Save mapping revision'}</Button>{message ? <p className="text-[10px] text-muted">{message}</p> : null}</form>
}

export function NarrativeWorkspace({ view = 'overview' }: { view?: NarrativeView }) {
  const [health, setHealth] = useState<NipHealth | null>(null)
  const [events, setEvents] = useState<NipEvent[]>([])
  const [claims, setClaims] = useState<NipClaim[]>([])
  const [subscriptions, setSubscriptions] = useState<NipPodcastSubscription[]>([])
  const [sources, setSources] = useState<NipSource[]>([])
  const [episodes, setEpisodes] = useState<NipPodcastEpisode[]>([])
  const [episodeTotal, setEpisodeTotal] = useState(0)
  const [episodeNextOffset, setEpisodeNextOffset] = useState<number | null>(null)
  const [episodesLoading, setEpisodesLoading] = useState(true)
  const [episodeFilters, setEpisodeFilters] = useState<EpisodeFilters>({ sort: 'published_desc', sourceId: 'all', title: '' })
  const [capabilities, setCapabilities] = useState<NipCapabilities | null>(null)
  const episodeRequest = useRef(0)
  const [transcribingKey, setTranscribingKey] = useState<string | null>(null)
  const [transcribeMessage, setTranscribeMessage] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  const [semanticMode, setSemanticMode] = useState(false)
  const [clusters, setClusters] = useState<NipNarrativeCluster[]>([])
  const [signalSnapshot, setSignalSnapshot] = useState<import('../types').NipNarrativeSignalSnapshot | null>(null)
  const [mappings, setMappings] = useState<NipEtfMapping[]>([])
  const [editorialCandidates, setEditorialCandidates] = useState<NipEditorialCandidate[]>([])
  const [resourceStatus, setResourceStatus] = useState<NipResourceStatus | null>(null)
  const [extractionStatus, setExtractionStatus] = useState<NipExtractionStatus | null>(null)
  const [providerStatus, setProviderStatus] = useState<NipProviderStatus | null>(null)
  const [providerBusy, setProviderBusy] = useState(false)
  const [providerMessage, setProviderMessage] = useState<string | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [graph, setGraph] = useState<NipNarrativeGraph | null>(null)
  const [clusterMessage, setClusterMessage] = useState<string | null>(null)
  const [rebuildingClusters, setRebuildingClusters] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState<NipEvent | null>(null)
  const [selectedClaimId, setSelectedClaimId] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [activeView, setActiveView] = useState<NarrativeView>(view)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [nextHealth, page, nextClaims, nextSubscriptions, nextClusters, nextSignals, nextMappings, nextEditorial, nextResource, nextExtraction, nextGraph, nextProvider, nextSources, nextCapabilities] = await Promise.all([narrativeApi.health(), semanticMode && activeQuery ? narrativeApi.semanticSearch(activeQuery, 50).then((results) => ({ events: results.map((result) => result.event), next_cursor: null })) : narrativeApi.searchEvents({ text: activeQuery || undefined, limit: 50 }), narrativeApi.listClaims(), narrativeApi.listPodcastSubscriptions(), narrativeApi.listNarrativeClusters().catch(() => []), narrativeApi.signalSnapshot().catch(() => null), narrativeApi.listEtfMappings().catch(() => []), narrativeApi.listEditorialCandidates().catch(() => []), narrativeApi.resourceStatus().catch(() => null), narrativeApi.extractionStatus().catch(() => null), narrativeApi.listNarrativeGraph().catch(() => null), narrativeApi.providerStatus().catch(() => null), narrativeApi.listSources(true).catch(() => []), narrativeApi.capabilities().catch(() => null)])
      setHealth(nextHealth); setEvents(page.events); setClaims(nextClaims); setSubscriptions(nextSubscriptions); setClusters(nextClusters); setSignalSnapshot(nextSignals); setMappings(nextMappings); setEditorialCandidates(nextEditorial); setResourceStatus(nextResource); setExtractionStatus(nextExtraction); setGraph(nextGraph); setProviderStatus(nextProvider); setSources(nextSources); setCapabilities(nextCapabilities); setSelectedClaimId((current) => current && nextClaims.some((claim) => claim.claim_id === current) ? current : nextClaims[0]?.claim_id)
    } catch (reason) { setHealth(null); setError(reason instanceof Error ? reason.message : 'The local NIP endpoint did not respond.') } finally { setLoading(false) }
  }, [activeQuery, semanticMode])

  const loadEpisodePage = useCallback(async (filters: EpisodeFilters, offset: number, append: boolean) => {
    const requestId = ++episodeRequest.current
    setEpisodesLoading(true)
    try {
      const page = await narrativeApi.listEpisodePage({
        sourceId: filters.sourceId === 'all' ? undefined : filters.sourceId,
        titleContains: filters.title.trim() || undefined,
        sort: filters.sort,
        limit: 50,
        offset,
      })
      if (requestId !== episodeRequest.current) return
      setEpisodes((current) => append ? [...current, ...page.episodes] : page.episodes)
      setEpisodeTotal(page.total)
      setEpisodeNextOffset(page.next_offset)
    } catch (reason) {
      if (requestId === episodeRequest.current) setError(reason instanceof Error ? reason.message : 'Discovered episodes could not be loaded.')
    } finally {
      if (requestId === episodeRequest.current) setEpisodesLoading(false)
    }
  }, [])

  useEffect(() => {
    const delay = episodeFilters.title.trim() ? 250 : 0
    const handle = window.setTimeout(() => { void loadEpisodePage(episodeFilters, 0, false) }, delay)
    return () => window.clearTimeout(handle)
  }, [episodeFilters, loadEpisodePage])

  const loadMoreEpisodes = useCallback(() => {
    if (episodesLoading || episodeNextOffset === null) return
    void loadEpisodePage(episodeFilters, episodeNextOffset, true)
  }, [episodesLoading, episodeNextOffset, episodeFilters, loadEpisodePage])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!selectedEvent) return
    const detail = document.querySelector('.event-detail')
    detail?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [selectedEvent])

  const refreshDue = async () => {
    setRefreshing(true); setError(null)
    try { await narrativeApi.refreshDuePodcastFeeds(); await load(); await loadEpisodePage(episodeFilters, 0, false) } catch (reason) { setError(reason instanceof Error ? reason.message : 'The refresh cycle failed.') } finally { setRefreshing(false) }
  }

  const transcribeEpisode = async (episode: NipPodcastEpisode) => {
    const key = `${episode.source_id}:${episode.source_native_id ?? episode.canonical_url ?? episode.title ?? 'episode'}`
    setTranscribingKey(key); setTranscribeMessage(null)
    try {
      await narrativeApi.transcribePodcastEpisode({ sourceId: episode.source_id, sourceNativeId: episode.source_native_id, canonicalUrl: episode.canonical_url })
      setTranscribeMessage('Episode transcribed locally. The retained event and Radar/Timeline observations were refreshed; the graph projection was rebuilt. Claims still require a separate extraction step.')
      await narrativeApi.rebuildNarrativeGraph().catch(() => null)
      await load()
      await loadEpisodePage(episodeFilters, 0, false)
    } catch (reason) {
      setTranscribeMessage(reason instanceof Error ? reason.message : 'Local transcription is unavailable; no remote ASR fallback was attempted.')
    } finally { setTranscribingKey(null) }
  }

  const grantProviderConsent = async () => {
    setProviderBusy(true); setProviderMessage(null)
    try { await narrativeApi.grantRemoteConsent({ actor: 'local-user', reason: 'Confirmed the NIP remote extraction disclosure.' }); setProviderMessage('Remote extraction consent recorded for this provider/model.'); await load() } catch (reason) { setProviderMessage(reason instanceof Error ? reason.message : 'Remote consent could not be recorded.') } finally { setProviderBusy(false) }
  }

  const revokeProviderConsent = async () => {
    setProviderBusy(true); setProviderMessage(null)
    try { await narrativeApi.revokeRemoteConsent({ actor: 'local-user', reason: 'Revoked remote transcript extraction consent.' }); setProviderMessage('Remote extraction consent revoked; transcript text stays local.'); await load() } catch (reason) { setProviderMessage(reason instanceof Error ? reason.message : 'Remote consent could not be revoked.') } finally { setProviderBusy(false) }
  }

  const rebuildClusters = async () => {
    setRebuildingClusters(true); setClusterMessage(null)
    try {
      const next = await narrativeApi.rebuildNarrativeClusters()
      setClusters(next)
      setClusterMessage(`${next.length} narrative cluster${next.length === 1 ? '' : 's'} rebuilt from canonical events.`)
      await load()
    } catch (reason) {
      setClusterMessage(reason instanceof Error ? reason.message : 'The cluster projection could not be rebuilt.')
    } finally { setRebuildingClusters(false) }
  }

  const extractSelectedEvent = async () => {
    if (!selectedEvent) return
    setExtracting(true); setProviderMessage(null)
    try { const nextClaims = await narrativeApi.extractClaimsFromEvent(selectedEvent.event_id); setProviderMessage(`${nextClaims.length} claim${nextClaims.length === 1 ? '' : 's'} committed with source evidence.`); await load() } catch (reason) { setProviderMessage(reason instanceof Error ? reason.message : 'Claim extraction is unavailable.') } finally { setExtracting(false) }
  }
  const submitSearch = (event: FormEvent) => { event.preventDefault(); setActiveQuery(query.trim()) }
  const selectedClaim = claims.find((claim) => claim.claim_id === selectedClaimId)
  const evidenceEvents = selectedClaim ? selectedClaim.evidence.map((evidence) => events.find((event) => event.event_id === evidence.event_id)).filter((event): event is NipEvent => Boolean(event)) : events

  return <div className="narrative-page">
    <header className="narrative-hero"><div><div className="flex items-center gap-2"><span className="narrative-mark"><Sparkles size={16} /></span><p className="eyebrow">Local-first research workspace</p></div><h1 className="mt-2 text-2xl font-semibold text-main">Narrative Intelligence</h1><p className="mt-2 max-w-2xl text-sm text-muted">Trace retained observations into claims without losing the source, time, or derivation that makes them reviewable.</p></div><Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh</Button></header>
    {error ? <ErrorNotice message={error} onRetry={() => void load()} /> : null}
    <SetupChecklist health={health} provider={providerStatus} subscriptions={subscriptions} events={events} claims={claims} />
    <div className="narrative-content">
      <aside className="narrative-sidebar"><StatusCard health={health} subscriptions={subscriptions} loading={loading} /><AddSourceForm onSubmitted={load} /><OperationalMonitor resource={resourceStatus} extraction={extractionStatus} /><ProviderStatusPanel status={providerStatus} busy={providerBusy} onGrant={grantProviderConsent} onRevoke={revokeProviderConsent} />{providerMessage ? <p className="narrative-sidebar-note" role="status">{providerMessage}</p> : null}<SourceRegistry sources={sources} onChanged={load} /><PollingStatus subscriptions={subscriptions} onRefresh={refreshDue} refreshing={refreshing} /><PanelCard title="Workspace" bodyClassName="narrative-card-body" subtitle="Evidence before interpretation" collapsible={false}><nav className="narrative-nav" aria-label="Narrative workspace"><button type="button" className={activeView === 'overview' ? 'is-active' : ''} onClick={() => setActiveView('overview')}><FileText size={14} /> Event review <span>{events.length}</span></button><button type="button" className={activeView === 'radar' ? 'is-active' : ''} onClick={() => setActiveView('radar')}><BarChart3 size={14} /> Radar <span>{signalSnapshot?.signals.length ?? 0}</span></button><button type="button" className={activeView === 'graph' ? 'is-active' : ''} onClick={() => setActiveView('graph')}><Network size={14} /> Graph <span>{resourceStatus?.graph_edge_count ?? 0}</span></button><button type="button" className={activeView === 'themes' ? 'is-active' : ''} onClick={() => setActiveView('themes')}><ShieldCheck size={14} /> ETF Themes <span>{mappings.length}</span></button><button type="button" className={activeView === 'editorial' ? 'is-active' : ''} onClick={() => setActiveView('editorial')}><Sparkles size={14} /> Editorial <span>{editorialCandidates.length}</span></button><button type="button" className={activeView === 'claims' ? 'is-active' : ''} onClick={() => setActiveView('claims')}><ShieldCheck size={14} /> Claim Explorer <span>{claims.length}</span></button></nav></PanelCard><div className="narrative-sidebar-note"><ShieldCheck size={14} /><span>Raw events remain immutable. Derived claims always link back to evidence.</span></div></aside>
      <main className="narrative-main">
        <div className="narrative-tabs" role="tablist" aria-label="Narrative views"><button type="button" role="tab" aria-selected={activeView === 'overview'} className={activeView === 'overview' ? 'is-active' : ''} onClick={() => setActiveView('overview')}>Event review</button><button type="button" role="tab" aria-selected={activeView === 'radar'} className={activeView === 'radar' ? 'is-active' : ''} onClick={() => setActiveView('radar')}>Radar</button><button type="button" role="tab" aria-selected={activeView === 'graph'} className={activeView === 'graph' ? 'is-active' : ''} onClick={() => setActiveView('graph')}>Graph</button><button type="button" role="tab" aria-selected={activeView === 'timeline'} className={activeView === 'timeline' ? 'is-active' : ''} onClick={() => setActiveView('timeline')}>Timeline</button><button type="button" role="tab" aria-selected={activeView === 'themes'} onClick={() => setActiveView('themes')}>ETF Themes</button><button type="button" role="tab" aria-selected={activeView === 'editorial'} onClick={() => setActiveView('editorial')}>Editorial</button><button type="button" role="tab" aria-selected={activeView === 'claims'} className={activeView === 'claims' ? 'is-active' : ''} onClick={() => setActiveView('claims')}>Claim Explorer</button></div>
        {activeView === 'graph' ? <PanelCard title="Narrative Graph" subtitle="Versioned derived projection · every edge retains source evidence" bodyClassName="narrative-card-body" collapsible={false} actions={<><Button variant="outline" size="sm" disabled={rebuildingClusters} onClick={() => void rebuildClusters()}><Sparkles size={13} /> {rebuildingClusters ? 'Rebuilding clusters…' : 'Rebuild clusters'}</Button><Button variant="outline" size="sm" onClick={async () => { const next = await narrativeApi.rebuildNarrativeGraph(); setGraph(next); await load() }}><Network size={13} /> Rebuild graph</Button></>}><GraphExplorer graph={graph} onOpenEvent={(eventId) => { const event = events.find((candidate) => candidate.event_id === eventId); if (event) { setSelectedEvent(event); setActiveView('overview') } }} />{clusterMessage ? <p className="mt-2 text-[10px] text-muted" role="status">{clusterMessage}</p> : null}</PanelCard> : activeView === 'themes' ? <PanelCard title="ETF Themes" bodyClassName="narrative-card-body" subtitle="Manual, dated research mappings · not investment recommendations" collapsible={false}><div className="space-y-3"><EtfMappingForm events={events} onSaved={load} />{mappings.length ? mappings.map((mapping) => <article className="evidence-card" key={mapping.mapping_id}><div className="flex items-center justify-between gap-2"><strong className="text-sm text-main">{mapping.ticker}</strong><span className="narrative-chip">v{mapping.version} · {mapping.review_status}</span></div><p className="mt-1 text-xs text-main">{mapping.rationale}</p><p className="mt-2 text-[10px] text-muted">Narrative {mapping.narrative_id} · effective {formatDate(mapping.effective_from)} · known {formatDate(mapping.known_at)}</p><div className="mt-2 flex flex-wrap gap-1"><span className="narrative-chip">Ticker: {mapping.ticker_status}</span><span className="narrative-chip">Market data: {mapping.market_data_coverage}</span><span className="narrative-chip">Validity: {mapping.mapping_validity}</span></div><p className="mt-2 text-[10px] text-amber-700">Backtest unavailable: required point-in-time price/mapping data is incomplete.</p></article>) : <div className="narrative-empty"><ShieldCheck size={22} /><p>No manual ETF mappings yet.</p><span>Mappings require a dated rationale and source-event evidence.</span></div>}</div></PanelCard> : activeView === 'editorial' ? <PanelCard title="Editorial Planning" bodyClassName="narrative-card-body" subtitle="Ranked topic candidates for human review · no finished content or CTR prediction" collapsible={false}><div className="space-y-3">{editorialCandidates.length ? editorialCandidates.map((candidate) => <article className="evidence-card" key={candidate.candidate_id}><div className="flex items-center justify-between gap-2"><strong className="text-sm text-main">#{candidate.rank} · {candidate.title_angle}</strong><span className="narrative-chip">{candidate.review_status}</span></div><p className="mt-2 text-[10px] text-muted">Run {candidate.derivation_run_id} · {candidate.evidence_event_ids.length} evidence events</p><div className="mt-2 flex flex-wrap gap-1">{Object.entries(candidate.component_values).map(([key, value]) => <span className="narrative-chip" key={key}>{key}: {value}</span>)}</div>{candidate.review_reason ? <p className="mt-2 text-xs text-main">Review: {candidate.review_reason} · {candidate.reviewer}</p> : <p className="mt-2 text-[10px] text-amber-700">Awaiting human review. Novelty and CTR components are not available.</p>}{candidate.review_status === 'unreviewed' ? <div className="mt-3 flex gap-2"><Button size="sm" variant="outline" onClick={async () => { const reason = window.prompt('Review reason', 'Needs additional source review.') || 'Needs additional source review.'; await narrativeApi.reviewEditorialCandidate({ candidateId: candidate.candidate_id, status: 'deferred', reason, reviewer: 'local-editor', reviewedAt: new Date().toISOString() }); await load() }}>Defer for review</Button><Button size="sm" onClick={async () => { await narrativeApi.reviewEditorialCandidate({ candidateId: candidate.candidate_id, status: 'relevant', reason: 'Relevant for editorial review.', reviewer: 'local-editor', reviewedAt: new Date().toISOString() }); await load() }}>Mark relevant</Button></div> : null}</article>) : <div className="narrative-empty"><Sparkles size={22} /><p>No editorial candidates yet.</p><span>Topic candidates must retain narrative, claim, and event evidence.</span></div>}</div></PanelCard> : activeView === 'claims' ? <PanelCard title="Claim Explorer" subtitle="Every interpretation stays connected to the source event" collapsible={false} bodyClassName="overflow-auto"><ClaimExplorer claims={claims} events={evidenceEvents} selectedClaimId={selectedClaimId} onSelectClaim={(claim) => setSelectedClaimId(claim.claim_id)} onBack={() => setActiveView('overview')} /></PanelCard> : activeView === 'radar' || activeView === 'timeline' ? <PanelCard title={activeView === 'radar' ? 'Narrative Radar' : 'Narrative Timeline'} subtitle={`Descriptive ${activeView} · ${signalSnapshot?.coverage ?? 'unknown'} source coverage · ${signalSnapshot?.formula_version ?? 'signal unavailable'}`} collapsible={false} bodyClassName="narrative-card-body"><SignalExplorer signals={signalSnapshot?.signals ?? []} mode={activeView} onOpenEvent={(eventId) => { const event = events.find((candidate) => candidate.event_id === eventId); if (event) { setSelectedEvent(event); setActiveView('overview') } }} /></PanelCard> : <div className="space-y-4"><EpisodePanel subscriptions={subscriptions} episodes={episodes} total={episodeTotal} loading={episodesLoading} hasMore={episodeNextOffset !== null} filters={episodeFilters} onFiltersChange={setEpisodeFilters} onLoadMore={loadMoreEpisodes} busyKey={transcribingKey} message={transcribeMessage} onTranscribe={transcribeEpisode} transcriptionAvailable={capabilities?.features.local_audio_transcription ?? false} /><PanelCard title="Search retained events" bodyClassName="narrative-card-body" subtitle={semanticMode ? 'Qdrant hybrid semantic + lexical retrieval · model/provider must be configured' : 'Authoritative DuckDB text and metadata search'} collapsible={false}><form className="narrative-search" onSubmit={submitSearch}><Search size={15} className="text-muted" /><input aria-label="Search retained events" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search transcript text, source IDs, or event content…" /><Button type="submit" size="sm">Search</Button></form><label className="mt-3 flex items-center gap-2 text-[11px] text-muted"><input type="checkbox" checked={semanticMode} onChange={(event) => setSemanticMode(event.target.checked)} /> Use optional semantic index <span className="narrative-chip">BGE-M3 / RRF</span></label>{activeQuery ? <p className="mt-2 text-[10px] text-muted">Showing {semanticMode ? 'semantic' : 'text'} results for “{activeQuery}”</p> : null}</PanelCard>{clusters.length ? <PanelCard title="Narrative clusters" bodyClassName="narrative-card-body" subtitle="Versioned derived projection · not an investment score" collapsible={false}><div className="grid gap-2 sm:grid-cols-2">{clusters.map((cluster) => <div className="evidence-card" key={`${cluster.derivation_run_id}-${cluster.cluster_id}`}><div className="flex items-center justify-between gap-2"><strong className="text-xs text-main">{cluster.label}</strong><span className="narrative-chip">{cluster.member_count} events</span></div><p className="mt-1 text-[10px] text-muted">{cluster.algorithm_version} · {cluster.derivation_run_id}</p></div>)}</div></PanelCard> : null}<PanelCard title="Retained observations" subtitle={`${events.length} event${events.length === 1 ? '' : 's'} in the current page`} collapsible={false} bodyClassName="overflow-auto"><div className="narrative-event-list">{loading ? <div className="narrative-empty"><RefreshCw size={20} className="animate-spin" /><p>Loading the local event ledger…</p></div> : events.length ? events.map((event) => <EventRow key={event.event_id} event={event} onOpen={() => setSelectedEvent(event)} />) : <div className="narrative-empty"><WifiOff size={22} /><p>No retained events match this view.</p><span>Import a permitted local document or subscribe to a reviewed feed before searching.</span></div>}</div></PanelCard>{selectedEvent ? <PanelCard title="Event detail" subtitle="Immutable source observation" collapsible={false} actions={<><Button variant="outline" size="sm" onClick={() => void extractSelectedEvent()} disabled={extracting || providerStatus?.extraction_state !== 'available'}>{extracting ? 'Extracting…' : 'Extract claims'}</Button><Button variant="ghost" size="sm" onClick={() => setSelectedEvent(null)}>Close</Button></>}><div className="event-detail">{providerStatus?.remote && providerStatus.consent !== 'granted' ? <div className="narrative-notice narrative-notice-warning" role="status" data-testid="event-consent"><ShieldCheck size={16} /><div className="min-w-0 flex-1"><strong>Remote extraction is blocked</strong><p>{providerStatus.disclosure ?? 'Transcript text would leave this device.'}</p><Button className="mt-2" size="sm" disabled={providerBusy} onClick={() => void grantProviderConsent()} data-testid="event-consent-grant"><ShieldCheck size={13} /> {providerBusy ? 'Recording…' : 'Allow remote extraction'}</Button></div></div> : null}<div className="event-detail-banner"><CheckCircle2 size={16} /><span>Source-linked record · content hash <code>{selectedEvent.content_hash.slice(0, 18)}…</code></span></div><h2 className="mt-3 text-base font-semibold text-main">{selectedEvent.source_native_id || selectedEvent.event_id}</h2><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-main">{selectedEvent.content_text || 'No retained content text.'}</p><dl className="narrative-provenance mt-4"><div><dt>Source</dt><dd>{selectedEvent.source_id}</dd></div><div><dt>Published</dt><dd>{formatDate(selectedEvent.times.published_at)}</dd></div><div><dt>Captured</dt><dd>{formatDate(selectedEvent.times.captured_at)}</dd></div><div><dt>Ingested</dt><dd>{formatDate(selectedEvent.times.ingested_at)}</dd></div></dl></div></PanelCard> : null}</div>}
      </main>
    </div>
  </div>
}
