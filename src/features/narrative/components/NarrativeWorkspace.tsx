import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import { Activity, AlertCircle, ArrowLeft, BarChart3, BookOpen, CheckCircle2, ChevronRight, Clock3, Database, FileText, Network, RefreshCw, Search, ShieldCheck, Sparkles, WifiOff } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { PanelCard } from '../../shared/components/PanelCard'
import { narrativeApi } from '../api'
import type { NipClaim, NipEditorialCandidate, NipEtfMapping, NipEvent, NipExtractionStatus, NipHealth, NipNarrativeCluster, NipNarrativeGraph, NipNarrativeSignal, NipPodcastSubscription, NipResourceStatus } from '../types'
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
    <PanelCard title="Local readiness" subtitle="NIP-owned DuckDB and service boundary" collapsible={false}>
      <div className="narrative-status-body">
        <div className="flex items-center gap-3">
          <span className={`narrative-status-dot ${health ? 'is-ready' : 'is-pending'}`} aria-hidden />
          <div><p className="text-sm font-semibold text-main">{loading ? 'Checking local service…' : health ? 'Ready for local review' : 'Not connected'}</p><p className="text-xs text-muted">{health ? `Schema v${health.schema_version} · API v${health.api_version}` : 'Start nip-engine to review retained events and claims.'}</p></div>
        </div>
        <dl className="narrative-kv-list"><div><dt>Storage</dt><dd>DuckDB ledger</dd></div><div><dt>Search</dt><dd>{health ? 'Text + optional hybrid' : 'Unavailable'}</dd></div><div><dt>Semantic index</dt><dd>Optional Qdrant</dd></div><div><dt>Approved feeds</dt><dd>{subscriptions.length ? `${subscriptions.length} · ${subscriptions[0].state}` : 'None yet'}</dd></div></dl>
      </div>
    </PanelCard>
  )
}

function SubscriptionForm({ onSubmitted }: { onSubmitted: () => Promise<void> }) {
  const [sourceId, setSourceId] = useState('podcast-source')
  const [feedUrl, setFeedUrl] = useState('')
  const [showName, setShowName] = useState('')
  const [rightsStatement, setRightsStatement] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSubmitting(true); setMessage(null)
    try {
      await narrativeApi.subscribePodcastFeed({ sourceId, feedUrl, showName, rightsStatement, userConfirmedRights: confirmed })
      setFeedUrl(''); setShowName(''); setRightsStatement(''); setConfirmed(false)
      setMessage('Feed approved and initial sync requested.'); await onSubmitted()
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'The feed could not be approved.') } finally { setSubmitting(false) }
  }

  return <PanelCard title="Add an approved podcast" subtitle="One-time access and retention confirmation is required before any fetch." collapsible={false}>
    <form className="space-y-2" onSubmit={submit}>
      <input aria-label="Source ID" value={sourceId} onChange={(event) => setSourceId(event.target.value)} placeholder="Source ID" required />
      <input aria-label="Podcast feed URL" type="url" value={feedUrl} onChange={(event) => setFeedUrl(event.target.value)} placeholder="https://example.com/feed.xml" required />
      <input aria-label="Show name" value={showName} onChange={(event) => setShowName(event.target.value)} placeholder="Show name" required />
      <textarea aria-label="Rights statement" value={rightsStatement} onChange={(event) => setRightsStatement(event.target.value)} placeholder="Describe your rights to access and retain this feed." rows={2} required />
      <label className="flex items-start gap-2 text-[11px] text-muted"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} required /><span>I confirm access and retention rights for this source.</span></label>
      <Button type="submit" size="sm" disabled={submitting || !confirmed}>{submitting ? 'Approving…' : 'Approve and sync'}</Button>
      {message ? <p className="text-[10px] text-muted" role="status">{message}</p> : null}
    </form>
  </PanelCard>
}

function PollingStatus({ subscriptions, onRefresh, refreshing }: { subscriptions: NipPodcastSubscription[]; onRefresh: () => Promise<void>; refreshing: boolean }) {
  return <PanelCard title="Refresh status" subtitle="The desktop process refreshes due feeds at startup and every six hours." collapsible={false} actions={<Button variant="ghost" size="sm" onClick={() => void onRefresh()} disabled={refreshing}><RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} /> Run now</Button>}>
    {subscriptions.length ? <div className="space-y-2">{subscriptions.map((subscription) => <div className="evidence-card" key={subscription.source_id}><div className="flex items-center justify-between gap-2"><strong className="text-xs text-main">{subscription.show_name}</strong><span className="narrative-chip">{subscription.state}</span></div><dl className="narrative-provenance mt-2"><div><dt>Last checked</dt><dd>{formatDate(subscription.last_checked_at)}</dd></div><div><dt>Next poll</dt><dd>{formatDate(subscription.next_poll_at)}</dd></div></dl>{subscription.last_error_code ? <p className="mt-2 text-[10px] text-red-600">Last error: {subscription.last_error_code} · {subscription.consecutive_failures} consecutive failure{subscription.consecutive_failures === 1 ? '' : 's'}</p> : <p className="mt-2 text-[10px] text-muted">No recorded feed errors.</p>}</div>)}</div> : <p className="text-[11px] text-muted">No approved feeds are scheduled.</p>}
  </PanelCard>
}

export function OperationalMonitor({ resource, extraction }: { resource: NipResourceStatus | null; extraction: NipExtractionStatus | null }) {
  return <PanelCard title="Operational monitor" subtitle="What is local, derived, and currently reviewable" collapsible={false}>
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
        <section className="mt-5 border-t border-line pt-4"><p className="eyebrow">Derivation provenance</p><dl className="narrative-provenance"><div><dt>Provider</dt><dd>{selected.provider}</dd></div><div><dt>Model</dt><dd>{selected.model}</dd></div><div><dt>Prompt / schema</dt><dd>{selected.prompt_version}</dd></div></dl></section>
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
  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  const [semanticMode, setSemanticMode] = useState(false)
  const [clusters, setClusters] = useState<NipNarrativeCluster[]>([])
  const [signalSnapshot, setSignalSnapshot] = useState<import('../types').NipNarrativeSignalSnapshot | null>(null)
  const [mappings, setMappings] = useState<NipEtfMapping[]>([])
  const [editorialCandidates, setEditorialCandidates] = useState<NipEditorialCandidate[]>([])
  const [resourceStatus, setResourceStatus] = useState<NipResourceStatus | null>(null)
  const [extractionStatus, setExtractionStatus] = useState<NipExtractionStatus | null>(null)
  const [graph, setGraph] = useState<NipNarrativeGraph | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<NipEvent | null>(null)
  const [selectedClaimId, setSelectedClaimId] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [activeView, setActiveView] = useState<NarrativeView>(view)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [nextHealth, page, nextClaims, nextSubscriptions, nextClusters, nextSignals, nextMappings, nextEditorial, nextResource, nextExtraction, nextGraph] = await Promise.all([narrativeApi.health(), semanticMode && activeQuery ? narrativeApi.semanticSearch(activeQuery, 50).then((results) => ({ events: results.map((result) => result.event), next_cursor: null })) : narrativeApi.searchEvents({ text: activeQuery || undefined, limit: 50 }), narrativeApi.listClaims(), narrativeApi.listPodcastSubscriptions(), narrativeApi.listNarrativeClusters().catch(() => []), narrativeApi.signalSnapshot().catch(() => null), narrativeApi.listEtfMappings().catch(() => []), narrativeApi.listEditorialCandidates().catch(() => []), narrativeApi.resourceStatus().catch(() => null), narrativeApi.extractionStatus().catch(() => null), narrativeApi.listNarrativeGraph().catch(() => null)])
      setHealth(nextHealth); setEvents(page.events); setClaims(nextClaims); setSubscriptions(nextSubscriptions); setClusters(nextClusters); setSignalSnapshot(nextSignals); setMappings(nextMappings); setEditorialCandidates(nextEditorial); setResourceStatus(nextResource); setExtractionStatus(nextExtraction); setGraph(nextGraph); setSelectedClaimId((current) => current && nextClaims.some((claim) => claim.claim_id === current) ? current : nextClaims[0]?.claim_id)
    } catch (reason) { setHealth(null); setError(reason instanceof Error ? reason.message : 'The local NIP endpoint did not respond.') } finally { setLoading(false) }
  }, [activeQuery, semanticMode])
  useEffect(() => { void load() }, [load])

  const refreshDue = async () => {
    setRefreshing(true); setError(null)
    try { await narrativeApi.refreshDuePodcastFeeds(); await load() } catch (reason) { setError(reason instanceof Error ? reason.message : 'The refresh cycle failed.') } finally { setRefreshing(false) }
  }

  const submitSearch = (event: FormEvent) => { event.preventDefault(); setActiveQuery(query.trim()) }
  const selectedClaim = claims.find((claim) => claim.claim_id === selectedClaimId)
  const evidenceEvents = selectedClaim ? selectedClaim.evidence.map((evidence) => events.find((event) => event.event_id === evidence.event_id)).filter((event): event is NipEvent => Boolean(event)) : events

  return <div className="narrative-page">
    <header className="narrative-hero"><div><div className="flex items-center gap-2"><span className="narrative-mark"><Sparkles size={16} /></span><p className="eyebrow">Local-first research workspace</p></div><h1 className="mt-2 text-2xl font-semibold text-main">Narrative Intelligence</h1><p className="mt-2 max-w-2xl text-sm text-muted">Trace retained observations into claims without losing the source, time, or derivation that makes them reviewable.</p></div><Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh</Button></header>
    {error ? <ErrorNotice message={error} onRetry={() => void load()} /> : null}
    <div className="narrative-content">
      <aside className="narrative-sidebar"><StatusCard health={health} subscriptions={subscriptions} loading={loading} /><OperationalMonitor resource={resourceStatus} extraction={extractionStatus} /><SubscriptionForm onSubmitted={load} /><PollingStatus subscriptions={subscriptions} onRefresh={refreshDue} refreshing={refreshing} /><PanelCard title="Approved sources" subtitle="One-time rights confirmation · local processing" collapsible={false}><div className="space-y-2">{subscriptions.length ? subscriptions.map((subscription) => <div className="evidence-card" key={subscription.source_id}><div className="flex items-center justify-between gap-2"><strong className="text-xs text-main">{subscription.show_name}</strong><span className="narrative-chip">{subscription.state}</span></div><p className="mt-1 truncate text-[10px] text-muted">{subscription.feed_url}</p><p className="mt-1 text-[10px] text-muted">Rights confirmed {formatDate(subscription.rights_confirmed_at)}</p></div>) : <p className="text-[11px] text-muted">No podcast feeds are subscribed. Add one after reviewing access and retention rights.</p>}</div></PanelCard><PanelCard title="Workspace" subtitle="Evidence before interpretation" collapsible={false}><nav className="narrative-nav" aria-label="Narrative workspace"><button type="button" className={activeView === 'overview' ? 'is-active' : ''} onClick={() => setActiveView('overview')}><FileText size={14} /> Event review <span>{events.length}</span></button><button type="button" className={activeView === 'radar' ? 'is-active' : ''} onClick={() => setActiveView('radar')}><BarChart3 size={14} /> Radar <span>{signalSnapshot?.signals.length ?? 0}</span></button><button type="button" className={activeView === 'graph' ? 'is-active' : ''} onClick={() => setActiveView('graph')}><Network size={14} /> Graph <span>{resourceStatus?.graph_edge_count ?? 0}</span></button><button type="button" className={activeView === 'themes' ? 'is-active' : ''} onClick={() => setActiveView('themes')}><ShieldCheck size={14} /> ETF Themes <span>{mappings.length}</span></button><button type="button" className={activeView === 'editorial' ? 'is-active' : ''} onClick={() => setActiveView('editorial')}><Sparkles size={14} /> Editorial <span>{editorialCandidates.length}</span></button><button type="button" className={activeView === 'claims' ? 'is-active' : ''} onClick={() => setActiveView('claims')}><ShieldCheck size={14} /> Claim Explorer <span>{claims.length}</span></button></nav></PanelCard><div className="narrative-sidebar-note"><ShieldCheck size={14} /><span>Raw events remain immutable. Derived claims always link back to evidence.</span></div></aside>
      <main className="narrative-main">
        <div className="narrative-tabs" role="tablist" aria-label="Narrative views"><button type="button" role="tab" aria-selected={activeView === 'overview'} className={activeView === 'overview' ? 'is-active' : ''} onClick={() => setActiveView('overview')}>Event review</button><button type="button" role="tab" aria-selected={activeView === 'radar'} className={activeView === 'radar' ? 'is-active' : ''} onClick={() => setActiveView('radar')}>Radar</button><button type="button" role="tab" aria-selected={activeView === 'graph'} className={activeView === 'graph' ? 'is-active' : ''} onClick={() => setActiveView('graph')}>Graph</button><button type="button" role="tab" aria-selected={activeView === 'timeline'} className={activeView === 'timeline' ? 'is-active' : ''} onClick={() => setActiveView('timeline')}>Timeline</button><button type="button" role="tab" aria-selected={activeView === 'themes'} onClick={() => setActiveView('themes')}>ETF Themes</button><button type="button" role="tab" aria-selected={activeView === 'editorial'} onClick={() => setActiveView('editorial')}>Editorial</button><button type="button" role="tab" aria-selected={activeView === 'claims'} className={activeView === 'claims' ? 'is-active' : ''} onClick={() => setActiveView('claims')}>Claim Explorer</button></div>
        {activeView === 'graph' ? <PanelCard title="Narrative Graph" subtitle="Versioned derived projection · every edge retains source evidence" collapsible={false} actions={<Button variant="outline" size="sm" onClick={async () => { const next = await narrativeApi.rebuildNarrativeGraph(); setGraph(next); await load() }}><Network size={13} /> Rebuild graph</Button>}><GraphExplorer graph={graph} onOpenEvent={(eventId) => { const event = events.find((candidate) => candidate.event_id === eventId); if (event) { setSelectedEvent(event); setActiveView('overview') } }} /></PanelCard> : activeView === 'themes' ? <PanelCard title="ETF Themes" subtitle="Manual, dated research mappings · not investment recommendations" collapsible={false}><div className="space-y-3"><EtfMappingForm events={events} onSaved={load} />{mappings.length ? mappings.map((mapping) => <article className="evidence-card" key={mapping.mapping_id}><div className="flex items-center justify-between gap-2"><strong className="text-sm text-main">{mapping.ticker}</strong><span className="narrative-chip">v{mapping.version} · {mapping.review_status}</span></div><p className="mt-1 text-xs text-main">{mapping.rationale}</p><p className="mt-2 text-[10px] text-muted">Narrative {mapping.narrative_id} · effective {formatDate(mapping.effective_from)} · known {formatDate(mapping.known_at)}</p><div className="mt-2 flex flex-wrap gap-1"><span className="narrative-chip">Ticker: {mapping.ticker_status}</span><span className="narrative-chip">Market data: {mapping.market_data_coverage}</span><span className="narrative-chip">Validity: {mapping.mapping_validity}</span></div><p className="mt-2 text-[10px] text-amber-700">Backtest unavailable: required point-in-time price/mapping data is incomplete.</p></article>) : <div className="narrative-empty"><ShieldCheck size={22} /><p>No manual ETF mappings yet.</p><span>Mappings require a dated rationale and source-event evidence.</span></div>}</div></PanelCard> : activeView === 'editorial' ? <PanelCard title="Editorial Planning" subtitle="Ranked topic candidates for human review · no finished content or CTR prediction" collapsible={false}><div className="space-y-3">{editorialCandidates.length ? editorialCandidates.map((candidate) => <article className="evidence-card" key={candidate.candidate_id}><div className="flex items-center justify-between gap-2"><strong className="text-sm text-main">#{candidate.rank} · {candidate.title_angle}</strong><span className="narrative-chip">{candidate.review_status}</span></div><p className="mt-2 text-[10px] text-muted">Run {candidate.derivation_run_id} · {candidate.evidence_event_ids.length} evidence events</p><div className="mt-2 flex flex-wrap gap-1">{Object.entries(candidate.component_values).map(([key, value]) => <span className="narrative-chip" key={key}>{key}: {value}</span>)}</div>{candidate.review_reason ? <p className="mt-2 text-xs text-main">Review: {candidate.review_reason} · {candidate.reviewer}</p> : <p className="mt-2 text-[10px] text-amber-700">Awaiting human review. Novelty and CTR components are not available.</p>}{candidate.review_status === 'unreviewed' ? <div className="mt-3 flex gap-2"><Button size="sm" variant="outline" onClick={async () => { const reason = window.prompt('Review reason', 'Needs additional source review.') || 'Needs additional source review.'; await narrativeApi.reviewEditorialCandidate({ candidateId: candidate.candidate_id, status: 'deferred', reason, reviewer: 'local-editor', reviewedAt: new Date().toISOString() }); await load() }}>Defer for review</Button><Button size="sm" onClick={async () => { await narrativeApi.reviewEditorialCandidate({ candidateId: candidate.candidate_id, status: 'relevant', reason: 'Relevant for editorial review.', reviewer: 'local-editor', reviewedAt: new Date().toISOString() }); await load() }}>Mark relevant</Button></div> : null}</article>) : <div className="narrative-empty"><Sparkles size={22} /><p>No editorial candidates yet.</p><span>Topic candidates must retain narrative, claim, and event evidence.</span></div>}</div></PanelCard> : activeView === 'claims' ? <PanelCard title="Claim Explorer" subtitle="Every interpretation stays connected to the source event" collapsible={false} bodyClassName="overflow-auto"><ClaimExplorer claims={claims} events={evidenceEvents} selectedClaimId={selectedClaimId} onSelectClaim={(claim) => setSelectedClaimId(claim.claim_id)} onBack={() => setActiveView('overview')} /></PanelCard> : activeView === 'radar' || activeView === 'timeline' ? <PanelCard title={activeView === 'radar' ? 'Narrative Radar' : 'Narrative Timeline'} subtitle={`Descriptive ${activeView} · ${signalSnapshot?.coverage ?? 'unknown'} source coverage · ${signalSnapshot?.formula_version ?? 'signal unavailable'}`} collapsible={false}><SignalExplorer signals={signalSnapshot?.signals ?? []} mode={activeView} onOpenEvent={(eventId) => { const event = events.find((candidate) => candidate.event_id === eventId); if (event) { setSelectedEvent(event); setActiveView('overview') } }} /></PanelCard> : <div className="space-y-4"><PanelCard title="Search retained events" subtitle={semanticMode ? 'Qdrant hybrid semantic + lexical retrieval · model/provider must be configured' : 'Authoritative DuckDB text and metadata search'} collapsible={false}><form className="narrative-search" onSubmit={submitSearch}><Search size={15} className="text-muted" /><input aria-label="Search retained events" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search transcript text, source IDs, or event content…" /><Button type="submit" size="sm">Search</Button></form><label className="mt-3 flex items-center gap-2 text-[11px] text-muted"><input type="checkbox" checked={semanticMode} onChange={(event) => setSemanticMode(event.target.checked)} /> Use optional semantic index <span className="narrative-chip">BGE-M3 / RRF</span></label>{activeQuery ? <p className="mt-2 text-[10px] text-muted">Showing {semanticMode ? 'semantic' : 'text'} results for “{activeQuery}”</p> : null}</PanelCard>{clusters.length ? <PanelCard title="Narrative clusters" subtitle="Versioned derived projection · not an investment score" collapsible={false}><div className="grid gap-2 sm:grid-cols-2">{clusters.map((cluster) => <div className="evidence-card" key={`${cluster.derivation_run_id}-${cluster.cluster_id}`}><div className="flex items-center justify-between gap-2"><strong className="text-xs text-main">{cluster.label}</strong><span className="narrative-chip">{cluster.member_count} events</span></div><p className="mt-1 text-[10px] text-muted">{cluster.algorithm_version} · {cluster.derivation_run_id}</p></div>)}</div></PanelCard> : null}<PanelCard title="Retained observations" subtitle={`${events.length} event${events.length === 1 ? '' : 's'} in the current page`} collapsible={false} bodyClassName="overflow-auto"><div className="narrative-event-list">{loading ? <div className="narrative-empty"><RefreshCw size={20} className="animate-spin" /><p>Loading the local event ledger…</p></div> : events.length ? events.map((event) => <EventRow key={event.event_id} event={event} onOpen={() => setSelectedEvent(event)} />) : <div className="narrative-empty"><WifiOff size={22} /><p>No retained events match this view.</p><span>Import a permitted local document or subscribe to a reviewed feed before searching.</span></div>}</div></PanelCard>{selectedEvent ? <PanelCard title="Event detail" subtitle="Immutable source observation" collapsible={false} actions={<Button variant="ghost" size="sm" onClick={() => setSelectedEvent(null)}>Close</Button>}><div className="event-detail"><div className="event-detail-banner"><CheckCircle2 size={16} /><span>Source-linked record · content hash <code>{selectedEvent.content_hash.slice(0, 18)}…</code></span></div><h2 className="mt-3 text-base font-semibold text-main">{selectedEvent.source_native_id || selectedEvent.event_id}</h2><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-main">{selectedEvent.content_text || 'No retained content text.'}</p><dl className="narrative-provenance mt-4"><div><dt>Source</dt><dd>{selectedEvent.source_id}</dd></div><div><dt>Published</dt><dd>{formatDate(selectedEvent.times.published_at)}</dd></div><div><dt>Captured</dt><dd>{formatDate(selectedEvent.times.captured_at)}</dd></div><div><dt>Ingested</dt><dd>{formatDate(selectedEvent.times.ingested_at)}</dd></div></dl></div></PanelCard> : null}</div>}
      </main>
    </div>
  </div>
}
