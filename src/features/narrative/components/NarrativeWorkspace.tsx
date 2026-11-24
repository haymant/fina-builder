import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { Activity, AlertCircle, ArrowLeft, BarChart3, BookOpen, CheckCircle2, ChevronRight, Circle, Clapperboard, Clock3, Database, FileText, ListChecks, Network, RefreshCw, Search, ShieldCheck, Sparkles, WifiOff } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { PanelCard } from '../../shared/components/PanelCard'
import { AddSourceForm, SourceRegistry } from './SourceRegistry'
import { AsrReadiness, CachedMediaPanel, JobProgress, TranscriptionActivity } from './TranscriptionReview'
import { NarrativeGraphChart } from './NarrativeGraphChart'
import { DirectLocalSettingsPanel } from './DirectLocalSettingsPanel'
import { relationshipName } from '../graph'
import { jobIsActive } from '../jobs'
import { narrativeApi } from '../api'
import { nipMediaBaseUrl } from '../../../api/nipTransport'
import type { NipAsrStatus, NipCapabilities, NipClaim, NipEditorialCandidate, NipEtfMapping, NipEvent, NipExtractionStatus, NipHealth, NipMediaArtifact, NipNarrativeCluster, NipNarrativeGraph, NipNarrativeSignal, NipPodcastEpisode, NipPodcastSubscription, NipProviderStatus, NipResourceStatus, NipSource, NipTranscriptionJob } from '../types'
import { CreateVideoEpisodeDialog } from './CreateVideoEpisodeDialog'
import { useConfirm } from '../../workspace/components/useConfirm'
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
  const directLocal = provider?.provider_id === 'direct-local'
  const providerDetail = !provider
    ? 'Checking the host-selected provider…'
    : !provider.configured
      ? directLocal ? 'Set NIP_LOCAL_LLM_URL and NIP_LOCAL_LLM_MODEL to a loopback OpenAI-compatible server, then restart.' : 'Configure a local or remote model in RIGA.'
      : provider.remote && provider.consent !== 'granted'
        ? `${provider.model ?? 'Configured model'} · remote consent is required.`
        : `${provider.model ?? 'Configured model'} · ${directLocal ? 'direct local' : provider.remote ? 'remote' : 'local'} · extraction ${provider.extraction_state.replace('_', ' ')}.`
  const providerStepState: SetupState = !provider
    ? 'pending'
    : provider.extraction_state === 'consent_required'
      ? 'action'
      : provider.extraction_state === 'available' ? 'done' : 'blocked'
  const steps: Array<{ id: string; title: string; detail: string; state: SetupState }> = [
    { id: 'service', title: 'Local service', detail: health ? `DuckDB schema v${health.schema_version} · API v${health.api_version}` : 'Start the NIP sidecar to open the local ledger.', state: health ? 'done' : 'blocked' },
    { id: 'provider', title: 'Extraction provider', detail: providerDetail, state: providerStepState },
    { id: 'source', title: 'Approved source', detail: subscriptions.length ? `${subscriptions.length} feed${subscriptions.length === 1 ? '' : 's'} approved with rights confirmation.` : 'Confirm access and retention rights before NIP fetches a feed.', state: subscriptions.length ? 'done' : 'next' },
    { id: 'transcript', title: 'Retained transcript', detail: events.length ? `${events.length} source-linked event${events.length === 1 ? '' : 's'} in the ledger.` : subscriptions.length ? 'Review a discovered episode and transcribe it locally.' : 'Waiting for an approved feed.', state: events.length ? 'done' : subscriptions.length ? 'next' : 'pending' },
    { id: 'claims', title: 'Evidence-linked claims', detail: claims.length ? `${claims.length} claim${claims.length === 1 ? '' : 's'} retain event quotes and derivation provenance.` : events.length ? 'Run extraction and review the evidence links.' : 'Waiting for a retained transcript.', state: claims.length ? 'done' : events.length ? 'next' : 'pending' },
  ]
  const complete = steps.filter((step) => step.state === 'done').length
  return <section className="narrative-setup" aria-label="NIP setup checklist" data-testid="nip-setup-checklist">
    <div className="narrative-setup-head"><span className="narrative-setup-icon"><ListChecks size={16} /></span><div><p className="eyebrow">First-run setup</p><h2 className="text-sm font-semibold text-main">From source rights to reviewable evidence</h2><p className="text-[10px] text-muted">Desktop sidecar · local DuckDB ledger · host-selected extraction provider</p></div><span className="narrative-chip">{complete}/{steps.length} complete</span></div>
    <ol className="narrative-setup-steps">{steps.map((step, index) => <li key={step.id} data-state={step.state}><span className="narrative-setup-index" aria-hidden>{step.state === 'done' ? <CheckCircle2 size={13} /> : <Circle size={13} />}</span><div><strong>{step.title}</strong><p>{step.detail}</p></div><span className="narrative-setup-state">{setupStateLabel(step.state)}</span><span className="sr-only">step {index + 1}</span></li>)}</ol>
  </section>
}

function PollingStatus({ subscriptions, onRefresh, refreshing }: { subscriptions: NipPodcastSubscription[]; onRefresh: () => Promise<void>; refreshing: boolean }) {
  return <PanelCard title="Refresh status" bodyClassName="narrative-card-body" subtitle="The desktop process refreshes due feeds at startup and every six hours. Run now refreshes every active feed, ignoring that window." collapsible={false} actions={<Button variant="ghost" size="sm" onClick={() => void onRefresh()} disabled={refreshing}><RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Run now</Button>}>
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
  return <PanelCard title="Extraction provider" bodyClassName="narrative-card-body" subtitle="Configured through the RIGA assistant · credentials stay in the desktop host" collapsible={false}><div className="space-y-2"><div className="flex items-center justify-between gap-2"><strong className="text-xs text-main">{status.model}</strong><span className="narrative-chip">{status.remote ? 'remote' : 'local'}</span></div><dl className="narrative-provenance"><div><dt>Provider</dt><dd>{status.provider_id || status.provider_api || 'Configured provider'}</dd></div><div><dt>Reasoning</dt><dd>{status.reasoning_effort || 'Default'}</dd></div><div><dt>Consent</dt><dd>{consentLabel}</dd></div><div><dt>Extraction</dt><dd>{status.extraction_state.replace('_', ' ')}</dd></div></dl>{status.remote && status.disclosure && status.consent !== 'granted' ? <p className="text-[10px] text-amber-700" role="status">{status.disclosure}</p> : null}{status.consent_recorded_at ? <p className="text-[10px] text-muted">Consent recorded {formatDate(status.consent_recorded_at)}</p> : null}{status.warnings.length ? <p className="text-[10px] text-amber-700">{status.warnings.join(' · ')}</p> : null}<div className="flex flex-wrap gap-2">{status.remote && status.consent !== 'granted' ? <Button size="sm" disabled={busy} onClick={() => void onGrant()}><ShieldCheck size={13} /> {busy ? 'Recording…' : 'Allow remote extraction'}</Button> : null}{status.remote && status.consent === 'granted' ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void onRevoke()}><WifiOff size={13} /> {busy ? 'Revoking…' : 'Revoke remote consent'}</Button> : null}</div>{status.provider_type === 'opencode_open_ai_compatible' ? <details className="narrative-adapter-guide" open={status.extraction_state !== 'available'}><summary>How to start the OpenCode adapter</summary><p>This provider type talks to the RIGA OpenCode adapter on <code>http://127.0.0.1:8791/v1</code>. RIGA starts it on demand; it is missing here, so point the host at a built adapter:</p><pre>{`cd modules/riga
npm install
npm run build --workspace @rigai/opencode
RIGA_OPENCODE_ADAPTER="$PWD/packages/opencode/dist/cli.js"`}</pre><p>Restart the desktop app with that variable set, then press <strong>Use provider</strong> again. To run the adapter by hand instead:</p><pre>{`RIGA_OPENCODE_PORT=8791 node modules/riga/packages/opencode/dist/cli.js`}</pre><p>The adapter needs <code>opencode</code> on <code>PATH</code> (it launches <code>opencode serve</code> on 4096 unless <code>OPENCODE_BASE_URL</code> is set). <code>RIGA_OPENCODE_BIN</code> works in place of a PATH install, and <code>RIGA_OPENCODE_PORT</code> changes the port.</p></details> : null}</div></PanelCard>
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

export function EpisodePanel({ subscriptions, episodes, total, loading, hasMore, filters, onFiltersChange, onLoadMore, busyKey, message, messageIsError = false, onTranscribe, transcriptionAvailable, jobs = [], asrStatus = null, mediaBase = null, asrBusy = false, asrMessage = null, onPrepareWorkspace, onRefreshAsr, onOpenTranscript, onOpenJobEvent, selectedEpisodeKey, onSelectEpisode }: { subscriptions: NipPodcastSubscription[]; episodes: NipPodcastEpisode[]; total: number; loading: boolean; hasMore: boolean; filters: EpisodeFilters; onFiltersChange: (filters: EpisodeFilters) => void; onLoadMore: () => void; busyKey: string | null; message: string | null; messageIsError?: boolean; onTranscribe: (episode: NipPodcastEpisode) => Promise<void>; transcriptionAvailable: boolean; jobs?: NipTranscriptionJob[]; asrStatus?: NipAsrStatus | null; mediaBase?: string | null; asrBusy?: boolean; asrMessage?: string | null; onPrepareWorkspace?: () => void; onRefreshAsr?: () => void; onOpenTranscript?: (episode: NipPodcastEpisode) => void; onOpenJobEvent?: (job: NipTranscriptionJob) => void; selectedEpisodeKey?: string | null; onSelectEpisode?: (episode: NipPodcastEpisode) => void }) {
  const sentinel = useRef<HTMLDivElement | null>(null)
  const showNames = useMemo(() => new Map(subscriptions.map((subscription) => [subscription.source_id, subscription.show_name])), [subscriptions])
  const sourceOptions = useMemo(() => [...showNames.entries()].sort((left, right) => left[1].localeCompare(right[1])), [showNames])
  const asrUsable = transcriptionAvailable && (asrStatus ? asrStatus.ready : true)
  const hasPublisherTranscript = episodes.some((episode) => Boolean(episode.transcript_url))
  const jobsByEpisode = useMemo(() => {
    const map = new Map<string, NipTranscriptionJob>()
    for (const job of jobs) {
      const key = `${job.source_id}:${job.source_native_id ?? job.canonical_url ?? job.title ?? 'episode'}`
      const existing = map.get(key)
      if (!existing || new Date(job.started_at) > new Date(existing.started_at)) map.set(key, job)
    }
    return map
  }, [jobs])

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
      {asrStatus && !asrStatus.ready ? <AsrReadiness status={asrStatus} preparing={asrBusy} message={asrMessage} onPrepare={onPrepareWorkspace ?? (() => {})} onRefresh={onRefreshAsr ?? (() => {})} /> : !transcriptionAvailable ? <p className="episode-empty episode-empty-error" role="alert"><strong>Local ASR is unavailable.</strong> Start ComfyUI Desktop (or set <code>NIP_COMFYUI_URL</code> to a loopback server) so NIP can reach the Qwen3-ASR workflow. NIP will not upload audio or substitute a remote ASR service.</p> : null}
      {!asrUsable && hasPublisherTranscript ? <p className="episode-empty" role="status">Local ASR is blocked, but episodes that advertise a publisher transcript can still be transcribed without it: NIP fetches the feed text directly and never uploads audio.</p> : null}
      {loading && !episodes.length ? <p className="episode-empty"><RefreshCw size={14} className="animate-spin" /> Loading episodes…</p> : episodes.length ? <ul className="episode-list">{episodes.map((episode, index) => {
        const key = `${episode.source_id}:${episode.source_native_id ?? episode.canonical_url ?? episode.title ?? index}`
        const job = jobsByEpisode.get(key) ?? null
        const canTranscribe = !jobIsActive(job) && (episode.state === 'awaiting_local_transcription' || episode.state === 'failed' || episode.state === 'transcription_unavailable')
        // A publisher transcript is fetched as text and needs no local ASR, so
        // it must stay available while the ComfyUI/Qwen path is blocked.
        const hasPublisherTranscript = Boolean(episode.transcript_url)
        const canStart = canTranscribe && (asrUsable || hasPublisherTranscript)
        return <li className="episode-row" key={key}><div className="flex items-start justify-between gap-2"><div className="min-w-0"><strong className="block truncate text-[11px] text-main">{episode.title ?? episode.source_native_id ?? 'Untitled episode'}</strong><p className="mt-1 text-[10px] text-muted">{showNames.get(episode.source_id) ?? episode.source_id} · {episode.source_native_id ?? 'No episode GUID'} · published {formatDate(episode.published_at)}</p></div><span className="narrative-chip">{episode.state.replaceAll('_', ' ')}</span><Button variant={selectedEpisodeKey === key ? 'default' : 'ghost'} size="sm" aria-pressed={selectedEpisodeKey === key} title="Select this episode for the NIP Notebook" onClick={() => onSelectEpisode?.(episode)}>{selectedEpisodeKey === key ? 'Selected' : 'Use in Notebook'}</Button></div>{canStart ? <Button className="mt-2" variant="outline" size="sm" disabled={busyKey === key || (!episode.enclosure_url && !hasPublisherTranscript)} onClick={() => void onTranscribe(episode)}><Sparkles size={12} /> {busyKey === key ? 'Starting…' : hasPublisherTranscript ? (episode.state === 'failed' || episode.state === 'transcription_unavailable' ? 'Retry with publisher transcript' : 'Use publisher transcript') : episode.state === 'failed' || episode.state === 'transcription_unavailable' ? 'Retry local transcription' : 'Transcribe locally'}</Button> : episode.state === 'transcribed' ? <div className="mt-2 flex flex-wrap items-center gap-2"><span className="text-[10px] text-emerald-700">Transcript committed.</span>{onOpenTranscript ? <Button variant="outline" size="sm" onClick={() => onOpenTranscript(episode)}><FileText size={12} /> Open retained transcript</Button> : null}</div> : canTranscribe && !episode.enclosure_url ? <p className="mt-2 text-[10px] text-amber-700">No audio enclosure is available for this episode.</p> : canTranscribe ? null : <p className="mt-2 text-[10px] text-amber-700">Local transcription is unavailable for this episode. NIP will not upload audio or substitute a remote ASR service.</p>}
        {job ? <JobProgress job={job} mediaBase={mediaBase} onOpenEvent={onOpenJobEvent} /> : null}
      </li>
      })}</ul> : total ? <p className="episode-empty">No episodes match the current filters. Clear the title filter or choose another source.</p> : <p className="episode-empty">No RSS episodes discovered yet. Run a due-feed refresh after the initial sync.</p>}
      {hasMore ? <div className="episode-sentinel" ref={sentinel} aria-hidden>{loading ? <RefreshCw size={14} className="animate-spin" /> : <span>Scroll for more episodes…</span>}</div> : null}
    </> : <p className="text-[11px] text-muted">Approve a podcast feed to discover episodes. The primary journey never asks you to import each episode file.</p>}
    {message ? <p className={messageIsError ? 'episode-empty episode-empty-error' : 'mt-2 text-[10px] text-muted'} role={messageIsError ? 'alert' : 'status'}>{message}</p> : null}
  </PanelCard>
}

export function GraphExplorer({ graph, events, onOpenEvent, onBackToEvents }: { graph: NipNarrativeGraph | null; events: NipEvent[]; onOpenEvent: (eventId: string) => void; onBackToEvents?: () => void }) {
  const eventById = useMemo(() => new Map(events.map((event) => [event.event_id, event])), [events])
  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map((node) => [node.node_id, node])), [graph])
  const originLabel = (eventId: string) => (eventById.get(eventId) ? (eventById.get(eventId)!.source_native_id || eventId) : eventId)
  const nodeLabel = (nodeId: string) => nodeById.get(nodeId)?.label ?? nodeId
  if (!graph) return <div className="narrative-empty"><Network size={22} /><p>No graph projection has been built.</p><span>Rebuild the graph after retained events exist; the last successful version remains authoritative.</span></div>
  const origins = graph.nodes.filter((node) => node.node_type === 'event')
  const claims = graph.nodes.filter((node) => node.node_type === 'claim')
  const narratives = graph.nodes.filter((node) => node.node_type === 'narrative')
  if (!graph.nodes.length) return <div className="narrative-empty" data-testid="graph-empty"><Network size={22} /><p>The graph has no origin nodes yet.</p><span>Transcribe an episode (or import a document) to create a retained event, then rebuild the graph. Claims and narrative clusters add the interpretive layer on top of those origins.</span>{onBackToEvents ? <Button className="mt-2" size="sm" variant="outline" onClick={onBackToEvents}><FileText size={12} /> Open retained events</Button> : null}</div>
  return <div className="space-y-3">
    <div className="evidence-card"><p className="eyebrow">Versioned graph projection</p><h2 className="mt-1 text-sm font-semibold text-main">{graph.algorithm_version}</h2><p className="mt-1 text-[10px] text-muted">Run {graph.derivation_run_id} · built {formatDate(graph.created_at)} · {graph.nodes.length} nodes · {graph.edges.length} evidence-linked edges</p><div className="mt-2 flex flex-wrap gap-1"><span className="narrative-chip">{origins.length} retained origins</span><span className="narrative-chip">{claims.length} claims</span><span className="narrative-chip">{narratives.length} narratives</span></div><p className="mt-2 text-[10px] text-muted">Every node and edge cites retained events; use the origin chips to open the source record.</p></div>
    <div className="evidence-card"><p className="eyebrow">Projection map</p><p className="mt-1 text-[10px] text-muted">Nodes are stories, claims and narrative clusters; edges are the evidence that connects them. Drag to arrange, scroll to zoom, and click a node to open its origin.</p><NarrativeGraphChart graph={graph} onOpenEvent={onOpenEvent} /></div>
    {origins.length ? <div className="evidence-card"><p className="eyebrow">Retained origins</p><ul className="mt-2 space-y-1">{origins.slice(0, 80).map((node) => { const eventId = node.evidence_event_ids[0] ?? node.node_id.replace('event:', ''); const event = eventById.get(eventId); return <li key={node.node_id} className="flex flex-wrap items-center gap-2 text-[11px]"><span className="narrative-chip">event</span><button type="button" className="max-w-[42ch] truncate text-left underline" title={node.label} onClick={() => onOpenEvent(eventId)}>{node.label}</button><span className="text-[10px] text-muted">{event ? `${event.source_id} · published ${formatDate(event.times.published_at)}` : 'origin not in the current event page'}</span><code className="text-[9px] text-muted">{eventId.slice(0, 14)}…</code></li> })}</ul>{origins.length > 80 ? <p className="mt-2 text-[10px] text-muted">Showing 80 of {origins.length} retained origins.</p> : null}</div> : null}
    {claims.length ? <div className="evidence-card"><p className="eyebrow">Claim nodes</p><div className="mt-2 space-y-2">{claims.map((node) => <div key={node.node_id}><strong className="text-xs text-main">{node.label}</strong><div className="mt-1 flex flex-wrap gap-1">{node.evidence_event_ids.map((eventId) => <button className="narrative-chip underline" type="button" key={eventId} onClick={() => onOpenEvent(eventId)}>Origin {originLabel(eventId).slice(0, 24)}…</button>)}</div></div>)}</div></div> : null}
    {narratives.length ? <div className="evidence-card"><p className="eyebrow">Narrative clusters</p><div className="mt-2 space-y-1">{narratives.map((node) => <div key={node.node_id} className="flex flex-wrap items-center gap-2 text-[11px]"><span className="narrative-chip">narrative</span><span className="text-main">{node.label}</span><span className="text-[10px] text-muted">{node.evidence_event_ids.length} member{node.evidence_event_ids.length === 1 ? '' : 's'}</span></div>)}</div></div> : null}
    {graph.edges.length ? <div className="evidence-card"><p className="eyebrow">Evidence-linked edges</p><div className="mt-2 space-y-2">{graph.edges.map((edge) => <div className="evidence-card" key={edge.edge_id}><div className="flex items-center justify-between gap-3"><strong className="text-xs text-main">{relationshipName(edge.edge_type)}</strong><span className="narrative-chip">{Math.round(edge.confidence_millis / 10)}% confidence</span></div><p className="mt-1 text-[10px] text-muted"><span className="text-main">{nodeLabel(edge.from_node_id)}</span> → <span className="text-main">{nodeLabel(edge.to_node_id)}</span></p><div className="mt-2 flex flex-wrap gap-1">{edge.evidence_event_ids.map((eventId) => <button className="narrative-chip underline" type="button" key={eventId} onClick={() => onOpenEvent(eventId)}>Origin {originLabel(eventId).slice(0, 24)}…</button>)}</div></div>)}</div></div> : <p className="text-[10px] text-muted">No interpretive edges yet: extract claims or rebuild narrative clusters, then rebuild the graph.</p>}
  </div>
}

function SignalExplorer({ signals, mode, week, onOpenEvent }: { signals: NipNarrativeSignal[]; mode: 'radar' | 'timeline'; week?: string | null; onOpenEvent: (eventId: string) => void }) {
  const ordered = [...signals].sort((a, b) => b.current_count - a.current_count || b.distinct_source_categories - a.distinct_source_categories || a.narrative_id.localeCompare(b.narrative_id))
  if (!ordered.length) return <div className="narrative-empty" data-testid="signals-empty"><BarChart3 size={22} /><p>No dated narrative signals for the last completed UTC week.</p><span>{week ? `Signals count clustered mentions published between ${week}. ` : 'Signals count clustered mentions published inside the last completed UTC week. '}An event published this week becomes eligible once that week closes, clusters without a trustworthy publication date are excluded, and coverage stays unknown until a source-completeness manifest exists.</span></div>
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

export function TranscriptDialog({ event, busy, status, statusIsError = false, extractionAvailable, onClose, onExtract, onOpenInList }: { event: NipEvent; busy: boolean; status: string | null; statusIsError?: boolean; extractionAvailable: boolean; onClose: () => void; onExtract: () => void; onOpenInList: () => void }) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])
  return (
    <div className="narrative-dialog-backdrop" data-testid="transcript-dialog" onMouseDown={onClose}>
      <div className="narrative-dialog" role="dialog" aria-modal="true" aria-label="Retained transcript" onMouseDown={(event) => event.stopPropagation()}>
        <header className="narrative-dialog-head">
          <div className="min-w-0"><p className="eyebrow">Retained transcript</p><h2 className="mt-1 truncate text-sm font-semibold text-main">{event.source_native_id || event.event_id}</h2><p className="mt-1 text-[10px] text-muted">{event.source_id} · published {formatDate(event.times.published_at)} · captured {formatDate(event.times.captured_at)}</p></div>
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </header>
        <p className="narrative-dialog-text">{event.content_text || 'No retained content text.'}</p>
        <footer className="narrative-dialog-foot">
          <div className="flex flex-col items-start gap-1"><code className="text-[10px] text-muted" data-testid="retained-event-id">{event.event_id}</code><code className="text-[10px] text-muted">content hash {event.content_hash.slice(0, 18)}…</code></div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" size="sm" onClick={onOpenInList}>Show in event list</Button>
            {extractionAvailable ? <Button size="sm" disabled={busy} onClick={onExtract}>{busy ? 'Extracting…' : 'Extract claims'}</Button> : null}
          </div>
        </footer>
        {!extractionAvailable ? <p className="narrative-extraction-hint">Extraction is unavailable right now: the active RIGA provider is not configured, has no model, or still needs consent. See the Extraction provider card.</p> : null}
        {status ? <p className={`narrative-dialog-status${statusIsError ? ' is-error' : ''}`} role={statusIsError ? 'alert' : 'status'}>{status}</p> : null}
      </div>
    </div>
  )
}

export function ClaimExplorer({ claims, events, selectedClaimId, onSelectClaim, onBack, onOpenVideoEpisode }: { claims: NipClaim[]; events: NipEvent[]; selectedClaimId?: string; onSelectClaim: (claim: NipClaim) => void; onBack?: () => void; onOpenVideoEpisode?: (projectId: string, episodeId: string, claimId: string) => void }) {
  const [createVideoOpen, setCreateVideoOpen] = useState(false)
  const selected = claims.find((claim) => claim.claim_id === selectedClaimId) ?? claims[0]
  const eventById = useMemo(() => new Map(events.map((event) => [event.event_id, event])), [events])
  if (!selected) return <div className="narrative-empty"><ShieldCheck size={25} /><p>No claims have been extracted yet.</p><span>Extraction needs a configured provider: a remote provider requires consent in Provider status, a local one does not. Then open a retained transcript and choose Extract claims. Every claim keeps its evidence event.</span></div>
  return (
    <>
    <div className="claim-explorer-grid">
      <div className="claim-list" aria-label="Claims">
        {claims.map((claim) => <button type="button" key={claim.claim_id} className={`claim-list-item ${claim.claim_id === selected.claim_id ? 'is-selected' : ''}`} onClick={() => onSelectClaim(claim)}><span className="claim-confidence" aria-hidden style={{ '--confidence': `${Math.min(100, Math.max(0, claim.confidence_millis / 10))}%` } as CSSProperties} /><span className="min-w-0 flex-1 text-left"><strong className="line-clamp-2 text-xs text-main">{claim.claim_text}</strong><small>{confidenceLabel(claim.confidence_millis)} · {claim.evidence.length} evidence link{claim.evidence.length === 1 ? '' : 's'}</small></span><ChevronRight size={14} className="shrink-0 text-muted" /></button>)}
      </div>
      <article className="claim-detail" aria-label="Claim details">
        <div className="flex items-start justify-between gap-4"><div><p className="eyebrow">Evidence-linked claim</p><h2 className="mt-1 text-base font-semibold text-main">{selected.claim_text}</h2></div><div className="flex flex-wrap items-center justify-end gap-2"><Button size="sm" onClick={() => setCreateVideoOpen(true)}><Clapperboard size={13} /> Create video episode</Button>{onBack ? <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft size={13} /> Events</Button> : null}</div></div>
        <div className="claim-meta-grid"><div><span>Confidence</span><b>{confidenceLabel(selected.confidence_millis)}</b></div><div><span>Speaker / author</span><b>{selected.speaker_or_author || 'Not specified'}</b></div><div><span>Extracted</span><b>{formatDate(selected.extracted_at)}</b></div><div><span>Run</span><b className="font-mono text-[10px]">{selected.extraction_run_id}</b></div></div>
        <section className="mt-5"><div className="flex items-center gap-2"><BookOpen size={14} className="text-primary" /><h3 className="text-xs font-semibold uppercase tracking-wide text-main">Source evidence</h3></div><div className="mt-2 space-y-2">{selected.evidence.map((evidence, index) => { const event = eventById.get(evidence.event_id); return <div className="evidence-card" key={`${evidence.event_id}-${index}`}><div className="flex items-center justify-between gap-3"><span className="narrative-chip">Event {evidence.event_id}</span><span className="text-[10px] text-muted">{event ? event.source_id : 'Source not in current page'}</span></div>{evidence.quote ? <blockquote>“{evidence.quote}”</blockquote> : <p className="mt-2 text-[11px] text-muted">No quote or span was provided by this source format.</p>}{event ? <p className="mt-2 text-[10px] text-muted">Published {formatDate(event.times.published_at)} · ingested {formatDate(event.times.ingested_at)}</p> : null}</div> })}</div></section>
        <section className="mt-5 border-t border-line pt-4"><p className="eyebrow">Derivation provenance</p><dl className="narrative-provenance"><div><dt>Provider</dt><dd>{selected.provider}</dd></div>{selected.provider_kind ? <div><dt>Provider type</dt><dd>{selected.provider_kind}</dd></div> : null}{selected.provider_profile_id ? <div><dt>Profile</dt><dd>{selected.provider_profile_id}</dd></div> : null}<div><dt>Model</dt><dd>{selected.model}</dd></div>{selected.reasoning_effort ? <div><dt>Reasoning</dt><dd>{selected.reasoning_effort}</dd></div> : null}<div><dt>Prompt / schema</dt><dd>{selected.prompt_version}</dd></div></dl></section>
      </article>
    </div>
    {createVideoOpen ? <CreateVideoEpisodeDialog claim={selected} onClose={() => setCreateVideoOpen(false)} onOpenVideoEpisode={onOpenVideoEpisode} /> : null}
    </>
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

export function NarrativeWorkspace({ view = 'overview', onOpenVideoEpisode, onNipEpisodeSelection, importRefreshSignal = 0 }: { view?: NarrativeView; onOpenVideoEpisode?: (projectId: string, episodeId: string, claimId: string) => void; onNipEpisodeSelection?: (episode: NipPodcastEpisode | null, event: NipEvent | null) => void; importRefreshSignal?: number }) {
  const [confirm, confirmDialog] = useConfirm()
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
  const [selectedNotebookEpisodeKey, setSelectedNotebookEpisodeKey] = useState<string | null>(null)
  const [capabilities, setCapabilities] = useState<NipCapabilities | null>(null)
  const episodeRequest = useRef(0)
  const episodeSelectionRequest = useRef(0)
  const [transcribingKey, setTranscribingKey] = useState<string | null>(null)
  const [transcribeMessage, setTranscribeMessage] = useState<string | null>(null)
  const [transcribeError, setTranscribeError] = useState(false)
  const [jobs, setJobs] = useState<NipTranscriptionJob[]>([])
  const [asrStatus, setAsrStatus] = useState<NipAsrStatus | null>(null)
  const [asrPreparing, setAsrPreparing] = useState(false)
  const [asrMessage, setAsrMessage] = useState<string | null>(null)
  const [mediaArtifacts, setMediaArtifacts] = useState<NipMediaArtifact[]>([])
  const [mediaBase, setMediaBase] = useState<string | null>(null)
  const [mediaLoading, setMediaLoading] = useState(false)
  const [mediaMessage, setMediaMessage] = useState<string | null>(null)
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
  const [providerMessageIsError, setProviderMessageIsError] = useState(false)
  const [extractElapsed, setExtractElapsed] = useState(0)
  const [extracting, setExtracting] = useState(false)
  const [graph, setGraph] = useState<NipNarrativeGraph | null>(null)
  const [clusterMessage, setClusterMessage] = useState<string | null>(null)
  const [rebuildingClusters, setRebuildingClusters] = useState(false)
  const [selectedEvent, setSelectedEvent] = useState<NipEvent | null>(null)
  const [transcriptEvent, setTranscriptEvent] = useState<NipEvent | null>(null)
  const [derivedMessage, setDerivedMessage] = useState<string | null>(null)
  const [derivedBusy, setDerivedBusy] = useState(false)
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

  // A claim extraction over a full transcript is a minutes-long request. Show
  // that it is running and how long it has been, instead of a frozen label.
  useEffect(() => {
    if (!extracting) { setExtractElapsed(0); return }
    const startedAt = Date.now()
    const timer = window.setInterval(() => setExtractElapsed(Math.round((Date.now() - startedAt) / 1000)), 1_000)
    return () => window.clearInterval(timer)
  }, [extracting])

  const refreshProviderStatus = useCallback(async () => {
    try { setProviderStatus(await narrativeApi.providerStatus()) } catch { /* keep the last known state */ }
  }, [])

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

  const reloadAll = useCallback(async () => {
    await load()
    await loadEpisodePage(episodeFilters, 0, false)
  }, [load, loadEpisodePage, episodeFilters])

  useEffect(() => { void load() }, [load])
  useEffect(() => { if (importRefreshSignal > 0) void reloadAll() }, [importRefreshSignal, reloadAll])
  useEffect(() => {
    if (!selectedEvent) return
    const detail = document.querySelector('.event-detail')
    detail?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
  }, [selectedEvent])

  const refreshDue = async () => {
    setRefreshing(true); setError(null)
    try { await narrativeApi.refreshDuePodcastFeeds(); await load(); await loadEpisodePage(episodeFilters, 0, false) } catch (reason) { setError(reason instanceof Error ? reason.message : 'The refresh cycle failed.') } finally { setRefreshing(false) }
  }

  const transcribeEpisode = async (episode: NipPodcastEpisode) => {
    const key = `${episode.source_id}:${episode.source_native_id ?? episode.canonical_url ?? episode.title ?? 'episode'}`
    setTranscribingKey(key); setTranscribeMessage(null); setTranscribeError(false)
    try {
      const job = await narrativeApi.startPodcastTranscription({ sourceId: episode.source_id, sourceNativeId: episode.source_native_id, canonicalUrl: episode.canonical_url })
      setJobs((current) => [job, ...current.filter((candidate) => candidate.job_id !== job.job_id)])
      setTranscribeMessage(`Started ${job.job_id}. Progress, cached audio and any failing step appear below this episode.`)
    } catch (reason) {
      setTranscribeError(true)
      setTranscribeMessage(reason instanceof Error ? reason.message : 'Local transcription could not start; no remote ASR fallback was attempted.')
    } finally { setTranscribingKey(null) }
  }

  const loadJobs = useCallback(async () => {
    try { setJobs(await narrativeApi.listPodcastTranscriptionJobs(undefined, 30)); jobsLoaded.current = true } catch { /* the next poll retries */ }
  }, [])

  const loadAsrStatus = useCallback(async () => {
    try { setAsrStatus(await narrativeApi.asrStatus()) } catch { setAsrStatus(null) }
  }, [])

  const loadMedia = useCallback(async () => {
    setMediaLoading(true)
    try {
      setMediaArtifacts(await narrativeApi.listMediaArtifacts(50))
      setMediaMessage(null)
    } catch (reason) {
      setMediaMessage(reason instanceof Error ? reason.message : 'Cached media could not be listed.')
    } finally { setMediaLoading(false) }
  }, [])

  useEffect(() => { void loadJobs(); void loadAsrStatus(); void loadMedia() }, [loadJobs, loadAsrStatus, loadMedia])
  useEffect(() => { void nipMediaBaseUrl().then(setMediaBase).catch(() => setMediaBase(null)) }, [])

  const activeJobCount = jobs.filter((job) => jobIsActive(job)).length
  useEffect(() => {
    if (!activeJobCount) return
    const handle = window.setInterval(() => { void loadJobs() }, 1500)
    return () => window.clearInterval(handle)
  }, [activeJobCount, loadJobs])

  const settledJobs = useRef<Set<string> | null>(null)
  const jobsLoaded = useRef(false)

  /**
   * A new transcript changes every derived projection. Rebuild them in the
   * order the service requires — clusters, then the graph that cites them —
   * and reload only after both have committed, so Radar, Timeline, Graph and
   * the cluster panel never read the previous run.
   */
  const refreshDerived = useCallback(async () => {
    setDerivedBusy(true)
    setDerivedMessage('New transcript committed. Rebuilding narrative clusters, radar signals, and the graph…')
    try {
      const nextClusters = await narrativeApi.rebuildNarrativeClusters()
      setClusters(nextClusters)
      const nextGraph = await narrativeApi.rebuildNarrativeGraph()
      setGraph(nextGraph)
      await load()
      await loadEpisodePage(episodeFilters, 0, false)
      await loadMedia()
      setDerivedMessage(`Rebuilt ${nextClusters.length} narrative cluster${nextClusters.length === 1 ? '' : 's'} and the graph. Radar, Timeline, Graph and clusters now read the fresh projection.`)
    } catch (reason) {
      setDerivedMessage(reason instanceof Error ? reason.message : 'The narrative clusters and graph could not be rebuilt from the new transcript.')
      await load()
    } finally { setDerivedBusy(false) }
  }, [load, loadEpisodePage, episodeFilters, loadMedia])

  useEffect(() => {
    const settled = jobs.filter((job) => job.state === 'transcribed' || job.state === 'failed')
    if (settledJobs.current === null) {
      // Seed from the first authoritative list: jobs that finished before this
      // view opened are history, not work this session should re-derive.
      if (!jobsLoaded.current) return
      settledJobs.current = new Set(settled.map((job) => `${job.job_id}:${job.state}`))
      return
    }
    const fresh = settled.filter((job) => !settledJobs.current?.has(`${job.job_id}:${job.state}`))
    if (!fresh.length) return
    for (const job of fresh) settledJobs.current.add(`${job.job_id}:${job.state}`)
    if (fresh.some((job) => job.state === 'transcribed')) { void refreshDerived(); return }
    // A failed run still changes episode state and the cached audio list.
    void load()
    void loadEpisodePage(episodeFilters, 0, false)
    void loadMedia()
  }, [jobs, refreshDerived, load, loadEpisodePage, episodeFilters, loadMedia])

  const cancelTranscription = async (job: NipTranscriptionJob) => {
    try {
      const next = await narrativeApi.cancelPodcastTranscription(job.job_id)
      setJobs((current) => current.map((candidate) => candidate.job_id === next.job_id ? next : candidate))
    } catch (reason) {
      setTranscribeError(true)
      setTranscribeMessage(reason instanceof Error ? reason.message : 'The transcription job could not be cancelled.')
    }
  }

  const openRetainedTranscript = async (episode: { sourceId: string; sourceNativeId?: string | null; canonicalUrl?: string | null }) => {
    try {
      const lookup = await narrativeApi.findPodcastEpisodeEvent({ sourceId: episode.sourceId, sourceNativeId: episode.sourceNativeId, canonicalUrl: episode.canonicalUrl })
      if (!lookup.event) {
        setTranscribeError(true)
        setTranscribeMessage('No retained event was found for this episode yet. Wait for the job to finish or retry the transcription.')
        return
      }
      setActiveView('overview')
      setTranscribeError(false)
      setTranscribeMessage(null)
      // Show the transcript in a card over the page. Scrolling the event list
      // to the newest row loses the text again as soon as infinite scroll
      // appends the next page of episodes.
      setTranscriptEvent(lookup.event)
    } catch (reason) {
      setTranscribeError(true)
      setTranscribeMessage(reason instanceof Error ? reason.message : 'The retained transcript could not be opened.')
    }
  }

  const selectEpisodeForNotebook = async (episode: NipPodcastEpisode) => {
    const key = `${episode.source_id}:${episode.source_native_id ?? episode.canonical_url ?? episode.title ?? 'episode'}`
    const request = ++episodeSelectionRequest.current
    setSelectedNotebookEpisodeKey(key)
    onNipEpisodeSelection?.(episode, null)
    try {
      const lookup = await narrativeApi.findPodcastEpisodeEvent({ sourceId: episode.source_id, sourceNativeId: episode.source_native_id, canonicalUrl: episode.canonical_url })
      if (request === episodeSelectionRequest.current) onNipEpisodeSelection?.(episode, lookup.event)
    } catch {
      if (request === episodeSelectionRequest.current) onNipEpisodeSelection?.(episode, null)
    }
  }

  const prepareComfyWorkspace = async () => {
    setAsrPreparing(true); setAsrMessage(null)
    try {
      const report = await narrativeApi.ensureComfyWorkspace()
      setAsrMessage(report.message)
      await loadAsrStatus()
      await load()
    } catch (reason) {
      setAsrMessage(reason instanceof Error ? reason.message : 'The comfy workspace could not be prepared.')
    } finally { setAsrPreparing(false) }
  }

  const deleteMedia = async (artifact: NipMediaArtifact) => {
    if (!(await confirm({ title: 'Delete cached file?', message: `Delete the cached file ${artifact.name}?`, confirmLabel: 'Delete file' }))) return
    try {
      await narrativeApi.deleteMediaArtifact(artifact.job_id, artifact.name)
      await loadMedia()
    } catch (reason) {
      setMediaMessage(reason instanceof Error ? reason.message : 'The cached file could not be deleted.')
    }
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
      // The graph cites clusters, so it is stale the moment they change.
      const nextGraph = await narrativeApi.rebuildNarrativeGraph()
      setGraph(nextGraph)
      setClusterMessage(`${next.length} narrative cluster${next.length === 1 ? '' : 's'} rebuilt from canonical events; the graph and radar now read them.`)
      await load()
    } catch (reason) {
      setClusterMessage(reason instanceof Error ? reason.message : 'The cluster projection could not be rebuilt.')
    } finally { setRebuildingClusters(false) }
  }

  const rebuildGraph = async () => {
    setClusterMessage(null)
    try {
      const next = await narrativeApi.rebuildNarrativeGraph()
      setGraph(next)
      setClusterMessage(`Graph rebuilt from ${next?.nodes.length ?? 0} nodes and ${next?.edges.length ?? 0} evidence-linked edges.`)
      await load()
    } catch (reason) {
      setClusterMessage(reason instanceof Error ? `Graph rebuild failed: ${reason.message}` : 'The graph projection could not be rebuilt.')
    }
  }

  const extractClaims = async (event: NipEvent) => {
    setExtracting(true); setProviderMessage(null); setProviderMessageIsError(false)
    try {
      const nextClaims = await narrativeApi.extractClaimsFromEvent(event.event_id)
      setProviderMessage(`${nextClaims.length} claim${nextClaims.length === 1 ? '' : 's'} committed with source evidence.`)
      try { setGraph(await narrativeApi.rebuildNarrativeGraph()) } catch { /* the claims are already committed */ }
      await load()
    } catch (reason) {
      // A dead endpoint used to fail silently: the tool did report an error,
      // but it landed in a sidebar note that is hidden behind the dialog and
      // easy to miss on a long page. Keep it next to the action and re-read
      // the provider state so the panel stops claiming extraction is ready.
      const hint = providerStatus?.provider_type === 'opencode_open_ai_compatible'
        ? 'The active provider is the OpenCode adapter on 127.0.0.1:8791 — see "How to start the OpenCode adapter" in Extraction provider.'
        : 'Check that the active provider in the local agent settings is reachable, then retry.'
      setProviderMessageIsError(true)
      setProviderMessage(`${reason instanceof Error ? reason.message : 'Claim extraction is unavailable.'} ${hint}`)
      void refreshProviderStatus()
    } finally { setExtracting(false) }
  }

  const extractSelectedEvent = async () => {
    if (!selectedEvent) return
    await extractClaims(selectedEvent)
  }
  const submitSearch = (event: FormEvent) => { event.preventDefault(); setActiveQuery(query.trim()) }
  const selectedClaim = claims.find((claim) => claim.claim_id === selectedClaimId)
  const evidenceEvents = selectedClaim ? selectedClaim.evidence.map((evidence) => events.find((event) => event.event_id === evidence.event_id)).filter((event): event is NipEvent => Boolean(event)) : events

  return <div className="narrative-page">
    <header className="narrative-hero"><div><div className="flex items-center gap-2"><span className="narrative-mark"><Sparkles size={16} /></span><p className="eyebrow">Local-first research workspace</p></div><h1 className="mt-2 text-2xl font-semibold text-main">Narrative Intelligence</h1><p className="mt-2 max-w-2xl text-sm text-muted">Trace retained observations into claims without losing the source, time, or derivation that makes them reviewable.</p></div><Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh</Button></header>
    {error ? <ErrorNotice message={error} onRetry={() => void load()} /> : null}
    <SetupChecklist health={health} provider={providerStatus} subscriptions={subscriptions} events={events} claims={claims} />
    <div className="narrative-content">
      <aside className="narrative-sidebar"><StatusCard health={health} subscriptions={subscriptions} loading={loading} /><AddSourceForm onSubmitted={reloadAll} /><OperationalMonitor resource={resourceStatus} extraction={extractionStatus} />{providerStatus?.provider_id !== 'direct-local' ? <ProviderStatusPanel status={providerStatus} busy={providerBusy} onGrant={grantProviderConsent} onRevoke={revokeProviderConsent} /> : null}<DirectLocalSettingsPanel status={providerStatus} />{providerMessage ? <p className={providerMessageIsError ? 'narrative-sidebar-note text-amber-700' : 'narrative-sidebar-note'} role={providerMessageIsError ? 'alert' : 'status'}>{providerMessage}</p> : null}<SourceRegistry sources={sources} onChanged={reloadAll} /><PollingStatus subscriptions={subscriptions} onRefresh={refreshDue} refreshing={refreshing} /><PanelCard title="Workspace" bodyClassName="narrative-card-body" subtitle="Evidence before interpretation" collapsible={false}><nav className="narrative-nav" aria-label="Narrative workspace"><button type="button" className={activeView === 'overview' ? 'is-active' : ''} onClick={() => setActiveView('overview')}><FileText size={14} /> Event review <span>{events.length}</span></button><button type="button" className={activeView === 'radar' ? 'is-active' : ''} onClick={() => setActiveView('radar')}><BarChart3 size={14} /> Radar <span>{signalSnapshot?.signals.length ?? 0}</span></button><button type="button" className={activeView === 'graph' ? 'is-active' : ''} onClick={() => setActiveView('graph')}><Network size={14} /> Graph <span>{resourceStatus?.graph_edge_count ?? 0}</span></button><button type="button" className={activeView === 'themes' ? 'is-active' : ''} onClick={() => setActiveView('themes')}><ShieldCheck size={14} /> ETF Themes <span>{mappings.length}</span></button><button type="button" className={activeView === 'editorial' ? 'is-active' : ''} onClick={() => setActiveView('editorial')}><Sparkles size={14} /> Editorial <span>{editorialCandidates.length}</span></button><button type="button" className={activeView === 'claims' ? 'is-active' : ''} onClick={() => setActiveView('claims')}><ShieldCheck size={14} /> Claim Explorer <span>{claims.length}</span></button></nav></PanelCard><div className="narrative-sidebar-note"><ShieldCheck size={14} /><span>Raw events remain immutable. Derived claims always link back to evidence.</span></div></aside>
      <main className="narrative-main">
        {derivedMessage ? <div className={`narrative-notice ${derivedBusy ? 'narrative-notice-info' : 'narrative-notice-success'}`} role="status" data-testid="derived-refresh"><RefreshCw size={15} className={derivedBusy ? 'animate-spin' : ''} /><div className="min-w-0 flex-1"><strong>{derivedBusy ? 'Updating derived views' : 'Derived views updated'}</strong><p>{derivedMessage}</p></div>{derivedBusy ? null : <Button variant="ghost" size="sm" onClick={() => setDerivedMessage(null)}>Dismiss</Button>}</div> : null}
        <div className="narrative-tabs" role="tablist" aria-label="Narrative views"><button type="button" role="tab" aria-selected={activeView === 'overview'} className={activeView === 'overview' ? 'is-active' : ''} onClick={() => setActiveView('overview')}>Event review</button><button type="button" role="tab" aria-selected={activeView === 'radar'} className={activeView === 'radar' ? 'is-active' : ''} onClick={() => setActiveView('radar')}>Radar</button><button type="button" role="tab" aria-selected={activeView === 'graph'} className={activeView === 'graph' ? 'is-active' : ''} onClick={() => setActiveView('graph')}>Graph</button><button type="button" role="tab" aria-selected={activeView === 'timeline'} className={activeView === 'timeline' ? 'is-active' : ''} onClick={() => setActiveView('timeline')}>Timeline</button><button type="button" role="tab" aria-selected={activeView === 'themes'} onClick={() => setActiveView('themes')}>ETF Themes</button><button type="button" role="tab" aria-selected={activeView === 'editorial'} onClick={() => setActiveView('editorial')}>Editorial</button><button type="button" role="tab" aria-selected={activeView === 'claims'} className={activeView === 'claims' ? 'is-active' : ''} onClick={() => setActiveView('claims')}>Claim Explorer</button></div>
        {activeView === 'graph' ? <PanelCard title="Narrative Graph" subtitle={`Versioned derived projection · ${graph?.nodes.length ?? 0} nodes · ${graph?.edges.length ?? 0} evidence edges · ${claims.length} claims · ${clusters.length} clusters`} bodyClassName="narrative-card-body" collapsible={false} actions={<><Button variant="outline" size="sm" disabled={rebuildingClusters} onClick={() => void rebuildClusters()}><Sparkles size={13} /> {rebuildingClusters ? 'Rebuilding clusters…' : 'Rebuild clusters'}</Button><Button variant="outline" size="sm" onClick={() => void rebuildGraph()}><Network size={13} /> Rebuild graph</Button></>}><GraphExplorer graph={graph} events={events} onOpenEvent={(eventId) => { const event = events.find((candidate) => candidate.event_id === eventId); if (event) { setSelectedEvent(event); setActiveView('overview') } }} onBackToEvents={() => setActiveView('overview')} />{clusterMessage ? <p className="mt-2 text-[10px] text-muted" role="status">{clusterMessage}</p> : null}</PanelCard> : activeView === 'themes' ? <PanelCard title="ETF Themes" bodyClassName="narrative-card-body" subtitle="Manual, dated research mappings · not investment recommendations" collapsible={false}><div className="space-y-3"><EtfMappingForm events={events} onSaved={load} />{mappings.length ? mappings.map((mapping) => <article className="evidence-card" key={mapping.mapping_id}><div className="flex items-center justify-between gap-2"><strong className="text-sm text-main">{mapping.ticker}</strong><span className="narrative-chip">v{mapping.version} · {mapping.review_status}</span></div><p className="mt-1 text-xs text-main">{mapping.rationale}</p><p className="mt-2 text-[10px] text-muted">Narrative {mapping.narrative_id} · effective {formatDate(mapping.effective_from)} · known {formatDate(mapping.known_at)}</p><div className="mt-2 flex flex-wrap gap-1"><span className="narrative-chip">Ticker: {mapping.ticker_status}</span><span className="narrative-chip">Market data: {mapping.market_data_coverage}</span><span className="narrative-chip">Validity: {mapping.mapping_validity}</span></div><p className="mt-2 text-[10px] text-amber-700">Backtest unavailable: required point-in-time price/mapping data is incomplete.</p></article>) : <div className="narrative-empty"><ShieldCheck size={22} /><p>No manual ETF mappings yet.</p><span>Mappings are manual by design: choose a ticker, a dated rationale and the source event, then save. Nothing is inferred from market data, and backtests stay unavailable while point-in-time coverage is incomplete.</span></div>}</div></PanelCard> : activeView === 'editorial' ? <PanelCard title="Editorial Planning" bodyClassName="narrative-card-body" subtitle="Ranked topic candidates for human review · no finished content or CTR prediction" collapsible={false}><div className="space-y-3">{editorialCandidates.length ? editorialCandidates.map((candidate) => <article className="evidence-card" key={candidate.candidate_id}><div className="flex items-center justify-between gap-2"><strong className="text-sm text-main">#{candidate.rank} · {candidate.title_angle}</strong><span className="narrative-chip">{candidate.review_status}</span></div><p className="mt-2 text-[10px] text-muted">Run {candidate.derivation_run_id} · {candidate.evidence_event_ids.length} evidence events</p><div className="mt-2 flex flex-wrap gap-1">{Object.entries(candidate.component_values).map(([key, value]) => <span className="narrative-chip" key={key}>{key}: {value}</span>)}</div>{candidate.review_reason ? <p className="mt-2 text-xs text-main">Review: {candidate.review_reason} · {candidate.reviewer}</p> : <p className="mt-2 text-[10px] text-amber-700">Awaiting human review. Novelty and CTR components are not available.</p>}{candidate.review_status === 'unreviewed' ? <div className="mt-3 flex gap-2"><Button size="sm" variant="outline" onClick={async () => { const reason = window.prompt('Review reason', 'Needs additional source review.') || 'Needs additional source review.'; await narrativeApi.reviewEditorialCandidate({ candidateId: candidate.candidate_id, status: 'deferred', reason, reviewer: 'local-editor', reviewedAt: new Date().toISOString() }); await load() }}>Defer for review</Button><Button size="sm" onClick={async () => { await narrativeApi.reviewEditorialCandidate({ candidateId: candidate.candidate_id, status: 'relevant', reason: 'Relevant for editorial review.', reviewer: 'local-editor', reviewedAt: new Date().toISOString() }); await load() }}>Mark relevant</Button></div> : null}</article>) : <div className="narrative-empty"><Sparkles size={22} /><p>No editorial candidates yet.</p><span>A derivation run composes candidates from committed claims and narrative clusters; there is no automatic generator. Extract claims from a retained transcript first, then write a candidate run. This is a review queue, not finished content.</span></div>}</div></PanelCard> : activeView === 'claims' ? <PanelCard title="Claim Explorer" subtitle="Every interpretation stays connected to the source event" collapsible={false} bodyClassName="overflow-auto"><ClaimExplorer claims={claims} events={evidenceEvents} selectedClaimId={selectedClaimId} onSelectClaim={(claim) => setSelectedClaimId(claim.claim_id)} onBack={() => setActiveView('overview')} onOpenVideoEpisode={onOpenVideoEpisode} /></PanelCard> : activeView === 'radar' || activeView === 'timeline' ? <PanelCard title={activeView === 'radar' ? 'Narrative Radar' : 'Narrative Timeline'} subtitle={`Descriptive ${activeView} · ${signalSnapshot?.coverage ?? 'unknown'} source coverage · ${signalSnapshot?.formula_version ?? 'signal unavailable'}`} collapsible={false} bodyClassName="narrative-card-body" actions={activeView === 'radar' ? <Button variant="outline" size="sm" disabled={rebuildingClusters} onClick={() => void rebuildClusters()}><Sparkles size={13} /> {rebuildingClusters ? 'Rebuilding clusters…' : 'Rebuild clusters'}</Button> : undefined}><SignalExplorer signals={signalSnapshot?.signals ?? []} mode={activeView} week={signalSnapshot ? `${formatDate(signalSnapshot.current_week_start)} – ${formatDate(signalSnapshot.current_week_end)}` : null} onOpenEvent={(eventId) => { const event = events.find((candidate) => candidate.event_id === eventId); if (event) { setSelectedEvent(event); setActiveView('overview') } }} />{activeView === 'radar' && clusterMessage ? <p className="mt-2 text-[10px] text-muted" role="status">{clusterMessage}</p> : null}</PanelCard> : <div className="space-y-4"><EpisodePanel subscriptions={subscriptions} episodes={episodes} total={episodeTotal} loading={episodesLoading} hasMore={episodeNextOffset !== null} filters={episodeFilters} onFiltersChange={setEpisodeFilters} onLoadMore={loadMoreEpisodes} busyKey={transcribingKey} message={transcribeMessage} messageIsError={transcribeError} onTranscribe={transcribeEpisode} transcriptionAvailable={capabilities?.features?.local_audio_transcription ?? false} jobs={jobs} asrStatus={asrStatus} mediaBase={mediaBase} asrBusy={asrPreparing} asrMessage={asrMessage} onPrepareWorkspace={() => void prepareComfyWorkspace()} onRefreshAsr={() => void loadAsrStatus()} selectedEpisodeKey={selectedNotebookEpisodeKey} onSelectEpisode={(episode) => void selectEpisodeForNotebook(episode)} onOpenTranscript={(episode) => void openRetainedTranscript({ sourceId: episode.source_id, sourceNativeId: episode.source_native_id, canonicalUrl: episode.canonical_url })} onOpenJobEvent={(job) => void openRetainedTranscript({ sourceId: job.source_id, sourceNativeId: job.source_native_id, canonicalUrl: job.canonical_url })} />
          <PanelCard title="Transcription activity" bodyClassName="narrative-card-body" subtitle="Every local run, its cached audio, warnings and the exact step that failed" collapsible={false} actions={<Button variant="outline" size="sm" onClick={() => void loadJobs()}><RefreshCw size={12} /> Refresh</Button>}>
            <TranscriptionActivity jobs={jobs} mediaBase={mediaBase} onCancel={(job) => void cancelTranscription(job)} onOpenEvent={(job) => void openRetainedTranscript({ sourceId: job.source_id, sourceNativeId: job.source_native_id, canonicalUrl: job.canonical_url })} />
          </PanelCard>
          <PanelCard title="Cached media" bodyClassName="narrative-card-body" subtitle="Local audio/video artifacts · replayed from the NIP cache, nothing leaves this device" collapsible={false}>
            <CachedMediaPanel artifacts={mediaArtifacts} mediaBase={mediaBase} loading={mediaLoading} message={mediaMessage} onRefresh={() => void loadMedia()} onDelete={(artifact) => void deleteMedia(artifact)} />
          </PanelCard><PanelCard title="Search retained events" bodyClassName="narrative-card-body" subtitle={semanticMode ? 'Qdrant hybrid semantic + lexical retrieval · model/provider must be configured' : 'Authoritative DuckDB text and metadata search'} collapsible={false}><form className="narrative-search" onSubmit={submitSearch}><Search size={15} className="text-muted" /><input aria-label="Search retained events" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search transcript text, source IDs, or event content…" /><Button type="submit" size="sm">Search</Button></form><label className="mt-3 flex items-center gap-2 text-[11px] text-muted"><input type="checkbox" checked={semanticMode} onChange={(event) => setSemanticMode(event.target.checked)} /> Use optional semantic index <span className="narrative-chip">BGE-M3 / RRF</span></label>{activeQuery ? <p className="mt-2 text-[10px] text-muted">Showing {semanticMode ? 'semantic' : 'text'} results for “{activeQuery}”</p> : null}</PanelCard>{clusters.length ? <PanelCard title="Narrative clusters" bodyClassName="narrative-card-body" subtitle="Versioned derived projection · not an investment score" collapsible={false}><div className="grid gap-2 sm:grid-cols-2">{clusters.map((cluster) => <div className="evidence-card" key={`${cluster.derivation_run_id}-${cluster.cluster_id}`}><div className="flex items-center justify-between gap-2"><strong className="text-xs text-main">{cluster.label}</strong><span className="narrative-chip">{cluster.member_count} events</span></div><p className="mt-1 text-[10px] text-muted">{cluster.algorithm_version} · {cluster.derivation_run_id}</p></div>)}</div></PanelCard> : null}<PanelCard title="Retained events" subtitle={`${events.length} event${events.length === 1 ? '' : 's'} in the current page · origins for transcripts and graph edges`} collapsible={false} bodyClassName="overflow-auto"><div className="narrative-event-list">{loading ? <div className="narrative-empty"><RefreshCw size={20} className="animate-spin" /><p>Loading the local event ledger…</p></div> : events.length ? events.map((event) => <EventRow key={event.event_id} event={event} onOpen={() => setSelectedEvent(event)} />) : <div className="narrative-empty"><WifiOff size={22} /><p>No retained events match this view.</p><span>Import a permitted local document or subscribe to a reviewed feed before searching.</span></div>}</div></PanelCard>{selectedEvent ? <PanelCard title="Event detail" subtitle="Immutable source observation" collapsible={false} actions={<><Button variant="outline" size="sm" onClick={() => void extractSelectedEvent()} disabled={extracting || providerStatus?.extraction_state !== 'available'}>{extracting ? 'Extracting…' : 'Extract claims'}</Button><Button variant="ghost" size="sm" onClick={() => setSelectedEvent(null)}>Close</Button></>}><div className="event-detail">{extracting ? <p className="narrative-extraction-hint" role="status" data-testid="extraction-waiting">Waiting for the model — {extractElapsed}s elapsed. Long transcripts are extracted in up to 8 windows; the run aborts after 10 minutes, and the rest of this page stays usable.</p> : null}{providerMessage ? <div className={`narrative-notice ${providerMessageIsError ? 'narrative-notice-error' : 'narrative-notice-success'}`} role={providerMessageIsError ? 'alert' : 'status'} data-testid="extraction-status"><div className="min-w-0 flex-1">{providerMessage}</div>{providerMessageIsError ? <Button variant="outline" size="sm" onClick={() => void refreshProviderStatus()}>Check provider</Button> : null}</div> : null}{providerStatus?.extraction_state === 'unavailable' ? <p className="narrative-extraction-hint" role="status">Claim extraction is unavailable: configure a provider and model in the local agent settings.</p> : null}{!providerStatus ? <p className="narrative-extraction-hint" role="status">The extraction provider status could not be read. Check the local agent connection, then retry.</p> : null}{providerStatus?.remote && providerStatus.consent !== 'granted' ? <div className="narrative-notice narrative-notice-warning" role="status" data-testid="event-consent"><ShieldCheck size={16} /><div className="min-w-0 flex-1"><strong>Remote extraction is blocked</strong><p>{providerStatus.disclosure ?? 'Transcript text would leave this device.'}</p><Button className="mt-2" size="sm" disabled={providerBusy} onClick={() => void grantProviderConsent()} data-testid="event-consent-grant"><ShieldCheck size={13} /> {providerBusy ? 'Recording…' : 'Allow remote extraction'}</Button></div></div> : null}<div className="event-detail-banner"><CheckCircle2 size={16} /><span>Source-linked record · content hash <code>{selectedEvent.content_hash.slice(0, 18)}…</code></span></div><h2 className="mt-3 text-base font-semibold text-main">{selectedEvent.source_native_id || selectedEvent.event_id}</h2><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-main">{selectedEvent.content_text || 'No retained content text.'}</p><dl className="narrative-provenance mt-4"><div><dt>Source</dt><dd>{selectedEvent.source_id}</dd></div><div><dt>Canonical event ID</dt><dd><code data-testid="canonical-event-id" className="select-all break-all" title="Select and copy this ID into Video Workspace">{selectedEvent.event_id}</code></dd></div><div><dt>Published</dt><dd>{formatDate(selectedEvent.times.published_at)}</dd></div><div><dt>Captured</dt><dd>{formatDate(selectedEvent.times.captured_at)}</dd></div><div><dt>Ingested</dt><dd>{formatDate(selectedEvent.times.ingested_at)}</dd></div></dl></div></PanelCard> : null}</div>}
      </main>
    </div>
    {transcriptEvent ? <TranscriptDialog event={transcriptEvent} busy={extracting} status={extracting ? `Waiting for the model — ${extractElapsed}s elapsed. Long transcripts are extracted in up to 8 windows; the run aborts after 10 minutes.` : providerMessage} statusIsError={providerMessageIsError} extractionAvailable={providerStatus?.extraction_state === 'available'} onClose={() => setTranscriptEvent(null)} onExtract={() => void extractClaims(transcriptEvent)} onOpenInList={() => { setSelectedEvent(transcriptEvent); setTranscriptEvent(null); setActiveView('overview') }} /> : null}
    {confirmDialog}
  </div>
}
