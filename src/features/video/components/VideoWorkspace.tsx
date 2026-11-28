import { Clapperboard, Download, FileCheck2, Film, Plus, RefreshCw, ShieldCheck, Sparkles, Trash2, Video as VideoIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { videoApi, thesisApi, VIDEO_PREVIEW_PROFILE_ID, type VideoTimelineBuildResult, type VideoExportProfile } from '../api'
import { narrativeApi } from '../../narrative/api'
import { claimsForEvent, type VideoClaimOption } from '../claim-selection'
import { buildSelectedClaimsStoryboard, buildTranscriptStoryboard, type VideoStoryboardDraft } from '../storyboard'
import { buildThesisStoryboard, verifyThesisForVideo, verifyTranscriptHash, backtestTableText, backtestVerdictText, validateStoryboardForLinkZag } from '../thesis'
import type { NipBacktestEvidence, NipEvent, NipThesis, NipTranscript } from '../../narrative/types'
import type {
  VideoAsset,
  VideoCapabilities,
  VideoEpisode,
  VideoEvidenceRef,
  VideoJob,
  VideoProject,
  VideoQaFinding,
  VideoSourceEvent,
  VideoStoryboardDocument,
  VideoVisualSpec,
  VideoWorkflow,
} from '../types'
import type { VideoView } from '../../workspace/navigation'
import './video.css'

const id = (prefix: string) => `${prefix}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 14)}`
const now = () => new Date().toISOString()
const evidenceKey = (ref: VideoEvidenceRef) => JSON.stringify([ref.evidence_kind, ref.evidence_id, ref.start_offset, ref.end_offset, ref.quote])
const formatDuration = (milliseconds: number | null | undefined) => {
  if (!milliseconds || milliseconds <= 0) return 'duration unknown'
  const totalSeconds = Math.round(milliseconds / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`
}
const blankProject = (): VideoProject => ({ project_id: id('project'), revision: 1, title: '', language: 'en', target_platform: 'youtube', target_duration_ms: 90_000, audience: '', style_profile: 'evidence_first', status: 'draft', created_at: now(), updated_at: now() })

export function VideoWorkspace({ view, projectId, episodeId, claimId, thesisId, transcriptId, onNavigate }: { view: VideoView; projectId?: string; episodeId?: string; claimId?: string; thesisId?: string; transcriptId?: string; onNavigate: (view: VideoView, projectId?: string) => void }) {
  const [projects, setProjects] = useState<VideoProject[]>([])
  const [capabilities, setCapabilities] = useState<VideoCapabilities | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [selected, setSelected] = useState<VideoProject | null>(null)

  const load = useCallback(async () => {
    try {
      const [items, caps] = await Promise.all([videoApi.listProjects(), videoApi.capabilities()])
      setProjects(items)
      setCapabilities(caps)
      setSelected(projectId ? items.find((item) => item.project_id === projectId) ?? null : null)
      setMessage(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Video service is unavailable.')
    } finally {
      setLoading(false)
    }
  }, [projectId])
  const refresh = useCallback(() => {
    setLoading(true)
    void load()
  }, [load])
  useEffect(() => { void load() }, [load])

  if (view === 'workspace' && selected) {
    return <EpisodeWorkspace key={`${selected.project_id}:${episodeId ?? 'new'}`} project={selected} capabilities={capabilities} episodeId={episodeId} claimId={claimId} thesisId={thesisId} transcriptId={transcriptId} onBack={() => onNavigate('projects')} onMessage={setMessage} message={message} />
  }
  return <ProjectList projects={projects} loading={loading} message={message} onRefresh={refresh} onOpen={(project) => onNavigate('workspace', project.project_id)} onCreated={(project) => { setProjects((items) => [project, ...items]); onNavigate('workspace', project.project_id) }} onDeleted={(projectId) => setProjects((items) => items.filter((item) => item.project_id !== projectId))} />
}

function ProjectList({ projects, loading, message, onRefresh, onOpen, onCreated, onDeleted }: { projects: VideoProject[]; loading: boolean; message: string | null; onRefresh: () => void; onOpen: (project: VideoProject) => void; onCreated: (project: VideoProject) => void; onDeleted: (projectId: string) => void }) {
  const [draft, setDraft] = useState(blankProject)
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<VideoProject | null>(null)
  const [confirmationName, setConfirmationName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!draft.title.trim()) return
    setCreating(true)
    try { onCreated(await videoApi.createProject({ ...draft, title: draft.title.trim(), audience: draft.audience?.trim() || null })) } catch { /* surfaced by the next refresh */ } finally { setCreating(false) }
  }
  const confirmDelete = async () => {
    if (!deleteTarget || confirmationName !== deleteTarget.title) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const result = await videoApi.deleteProject(deleteTarget.project_id, confirmationName)
      if (!result.deleted) throw new Error('The project was not deleted.')
      setDeleteNotice(`Deleted “${deleteTarget.title}”. ${result.retention_note}`)
      onDeleted(deleteTarget.project_id)
      setDeleteTarget(null)
      setConfirmationName('')
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Project deletion failed. No project data was changed.')
    } finally { setDeleting(false) }
  }
  const closeDelete = () => {
    if (deleting) return
    setDeleteTarget(null)
    setConfirmationName('')
    setDeleteError(null)
  }
  return <div className="video-page" data-testid="video-workspace">
    <header className="video-hero"><div><p className="eyebrow">Bounded production domain</p><h1>Video Workspace</h1><p>Turn a retained event transcript into an evidence-linked slides storyboard and a Flash preview, with Full deterministic capture when needed.</p></div><button type="button" className="ghost-button" onClick={onRefresh} disabled={loading}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh</button></header>
    <section className="video-capability-strip"><ShieldCheck size={16} /><span>Planning and source lookup are local and deterministic. TTS is shown only when configured.</span><span className="video-state">{projects.length} project{projects.length === 1 ? '' : 's'}</span></section>
    {message ? <p className="video-alert" role="alert">{message}</p> : null}{deleteNotice ? <p className="video-delete-notice" role="status">{deleteNotice}</p> : null}
    <div className="video-columns">
      <section className="video-card"><div className="video-card-head"><div><p className="eyebrow">Projects</p><h2>Production queue</h2></div><span className="video-chip">revisioned</span></div>
        {projects.length ? <div className="video-project-list">{projects.map((project) => <div className="video-project-row" key={project.project_id}><button type="button" className="video-project-open" aria-label={`Open project ${project.title}`} onClick={() => onOpen(project)}><span className="video-project-icon"><Film size={16} /></span><span className="min-w-0 flex-1 text-left"><strong>{project.title}</strong><small>{project.target_platform} · {Math.round((project.target_duration_ms ?? 0) / 1000)}s · v{project.revision}</small></span><span className="video-chip">{project.status}</span></button><button type="button" className="video-danger-button video-project-delete" aria-label={`Delete project ${project.title}`} data-testid={`delete-project-${project.project_id}`} onClick={() => { setDeleteTarget(project); setConfirmationName(''); setDeleteError(null) }}><Trash2 size={13} /><span>Delete</span></button></div>)}</div> : <div className="video-empty"><Clapperboard size={22} /><p>{loading ? 'Loading projects…' : 'No projects yet.'}</p><span>Create a project from retained source evidence; source text stays in the immutable NIP event ledger.</span></div>}
      </section>
      <form className="video-card video-form" onSubmit={submit}><div className="video-card-head"><div><p className="eyebrow">New project</p><h2>Start a reviewable cut</h2></div><Plus size={18} /></div><label>Project title<input aria-label="Project title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Policy outlook commentary" required /></label><div className="video-form-grid"><label>Platform<select value={draft.target_platform} onChange={(event) => setDraft({ ...draft, target_platform: event.target.value })}><option value="youtube">YouTube</option><option value="shorts">Shorts</option><option value="internal_review">Internal review</option></select></label><label>Length (seconds)<input type="number" min="10" value={Math.round((draft.target_duration_ms ?? 90_000) / 1000)} onChange={(event) => setDraft({ ...draft, target_duration_ms: Number(event.target.value) * 1000 })} /></label></div><label>Audience<input aria-label="Audience" value={draft.audience ?? ''} onChange={(event) => setDraft({ ...draft, audience: event.target.value })} placeholder="Research analysts" /></label><label>Style profile<input value={draft.style_profile ?? ''} onChange={(event) => setDraft({ ...draft, style_profile: event.target.value })} /></label><button className="video-primary-button" type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create project'}</button><p className="video-footnote">Search retained transcript text or source IDs to link an event—no ID copy/paste. Select multiple exact-span-backed NIP claims, or start from Claim Explorer’s “Create video episode” action. Video never invents claims.</p></form>
    </div>
    {deleteTarget ? <ProjectDeleteDialog project={deleteTarget} confirmationName={confirmationName} onConfirmationNameChange={setConfirmationName} deleting={deleting} error={deleteError} onCancel={closeDelete} onConfirm={() => void confirmDelete()} /> : null}
  </div>
}

function ProjectDeleteDialog({ project, confirmationName, onConfirmationNameChange, deleting, error, onCancel, onConfirm }: { project: VideoProject; confirmationName: string; onConfirmationNameChange: (name: string) => void; deleting: boolean; error: string | null; onCancel: () => void; onConfirm: () => void }) {
  const matches = confirmationName === project.title
  return <div className="video-delete-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="video-delete-title" aria-describedby="video-delete-description" className="video-delete-dialog" onKeyDown={(event) => { if (event.key === 'Escape') onCancel() }}><p className="eyebrow">Destructive action</p><h2 id="video-delete-title">Delete “{project.title}”?</h2><p id="video-delete-description">This permanently removes the Video project and its project-owned production records. It does not delete canonical NIP events, transcripts, or claims. Shared media assets and job history are retained; deletion is blocked while any Video job is queued or running.</p><label htmlFor="video-delete-confirmation">Paste the exact project name to confirm<input id="video-delete-confirmation" aria-label="Project name confirmation" autoComplete="off" autoFocus spellCheck={false} value={confirmationName} onChange={(event) => onConfirmationNameChange(event.target.value)} placeholder={project.title} /></label>{error ? <p className="video-alert" role="alert">{error}</p> : null}<div className="video-delete-actions"><button type="button" className="video-secondary-button" onClick={onCancel} disabled={deleting}>Cancel</button><button type="button" className="video-danger-button" onClick={onConfirm} disabled={!matches || deleting}>{deleting ? 'Deleting…' : 'Delete project permanently'}</button></div>{!matches ? <p className="video-delete-hint">The delete button becomes available only when the name matches exactly, including capitalization.</p> : null}</section></div>
}

function EpisodeWorkspace({ project, capabilities, episodeId, claimId, thesisId, transcriptId, onBack, onMessage, message }: { project: VideoProject; capabilities: VideoCapabilities | null; episodeId?: string; claimId?: string; thesisId?: string; transcriptId?: string; onBack: () => void; onMessage: (message: string | null) => void; message: string | null }) {
  const [episode, setEpisode] = useState<VideoEpisode | null>(null)
  const [hydrating, setHydrating] = useState(Boolean(episodeId))
  const [hydrationFailed, setHydrationFailed] = useState(false)
  const [evidence, setEvidence] = useState<VideoEvidenceRef[]>([])
  const [eventId, setEventId] = useState('')
  const [eventQuery, setEventQuery] = useState('')
  const [eventResults, setEventResults] = useState<NipEvent[]>([])
  const [eventSearchLoading, setEventSearchLoading] = useState(false)
  const [eventSearchError, setEventSearchError] = useState<string | null>(null)
  const [eventSearchOpen, setEventSearchOpen] = useState(false)
  const [activeEventIndex, setActiveEventIndex] = useState(0)
  const [selectedSearchEvent, setSelectedSearchEvent] = useState<NipEvent | null>(null)
  const eventSearchRequest = useRef(0)
  const [sourceEvent, setSourceEvent] = useState<VideoSourceEvent | null>(null)
  const [claimOptions, setClaimOptions] = useState<VideoClaimOption[]>([])
  const [selectedClaimIds, setSelectedClaimIds] = useState<string[]>([])
  const [claimFilter, setClaimFilter] = useState('')
  const [claimsLoading, setClaimsLoading] = useState(false)
  const [claimsError, setClaimsError] = useState<string | null>(null)
  const [storyboard, setStoryboard] = useState<VideoStoryboardDocument | null>(null)
  const [saving, setSaving] = useState(false)
  const [loadingSource, setLoadingSource] = useState(false)
  const [workflows, setWorkflows] = useState<VideoWorkflow[]>([])
  const [rendering, setRendering] = useState(false)
  const [captureMode, setCaptureMode] = useState<'flash' | 'full'>('flash')
  const [narrate, setNarrate] = useState(true)
  const [activeJob, setActiveJob] = useState<VideoJob | null>(null)
  const [jobNotice, setJobNotice] = useState<string | null>(null)
  const [episodes, setEpisodes] = useState<VideoEpisode[]>([])
  const [episodesLoading, setEpisodesLoading] = useState(true)
  const [activeEpisodeId, setActiveEpisodeId] = useState<string | undefined>(episodeId)
  const [persistedSpecs, setPersistedSpecs] = useState<VideoVisualSpec[]>([])
  const [projectAssets, setProjectAssets] = useState<VideoAsset[]>([])
  const [previewAsset, setPreviewAsset] = useState<VideoAsset | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const previewRef = useRef<HTMLVideoElement | null>(null)
  // Thesis-first video (revamp §d.1, decision §f.4). The event-explainer
  // flow below stays, labelled as such; the thesis flow is additional.
  const [theses, setTheses] = useState<NipThesis[]>([])
  const [thesesLoading, setThesesLoading] = useState(false)
  const [selectedThesisId, setSelectedThesisId] = useState('')
  const [thesisBundle, setThesisBundle] = useState<{ thesis: NipThesis; transcript: NipTranscript | null; backtests: NipBacktestEvidence[]; verification: ReturnType<typeof verifyThesisForVideo> } | null>(null)
  const [thesisLoading, setThesisLoading] = useState(false)
  const [thesisError, setThesisError] = useState<string | null>(null)
  const [visualReviewDone, setVisualReviewDone] = useState(false)
  const [backtestAbsenceAcknowledged, setBacktestAbsenceAcknowledged] = useState(false)
  const [publishApproval, setPublishApproval] = useState(false)
  const [qaReport, setQaReport] = useState<Record<string, unknown> | null>(null)
  const [qaRunning, setQaRunning] = useState(false)
  const [timelineResult, setTimelineResult] = useState<VideoTimelineBuildResult | null>(null)
  const [timelineBuilding, setTimelineBuilding] = useState(false)
  const [exportProfiles, setExportProfiles] = useState<VideoExportProfile[]>([])
  const [exportProfileId, setExportProfileId] = useState('')
  const [preflight, setPreflight] = useState<Record<string, unknown> | null>(null)
  const [exportManifest, setExportManifest] = useState<Record<string, unknown> | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [publishReceipt, setPublishReceipt] = useState<{ type: string; approvedAt: string; thesisId: string | null; transcriptHash: string | null; storyboardId: string | null; qaReportId: string | null; exportManifestId: string | null; backtestIds: string[] } | null>(null)
  const [publishing, setPublishing] = useState(false)

  const loadEpisodes = useCallback(async () => {
    setEpisodesLoading(true)
    try {
      const items = await videoApi.listEpisodes(project.project_id)
      setEpisodes(items)
      setActiveEpisodeId((current) => current ?? items[0]?.episode_id)
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Persisted episodes could not be loaded.')
    } finally {
      setEpisodesLoading(false)
    }
  }, [project.project_id, onMessage])

  useEffect(() => { void loadEpisodes() }, [loadEpisodes])

  useEffect(() => {
    setStoryboard(null)
    setPersistedSpecs([])
    setProjectAssets([])
    setPreviewAsset(null)
    setPreviewUrl(null)
    setPreviewError(null)
    setEpisode(null)
    setEvidence([])
    setSourceEvent(null)
    setHydrationFailed(false)
    setHydrating(Boolean(activeEpisodeId))
    setThesisBundle(null)
    setThesisError(null)
    setSelectedThesisId('')
    setVisualReviewDone(false)
    setBacktestAbsenceAcknowledged(false)
    setPublishApproval(false)
    setQaReport(null)
    setTimelineResult(null)
    setPreflight(null)
    setExportManifest(null)
    setPublishReceipt(null)
  }, [activeEpisodeId])

  const fetchThesisInput = useCallback(async (thesisId: string, preferredTranscriptId?: string) => {
    const [thesis, transcripts, backtests, allClaims] = await Promise.all([
      thesisApi.getThesis(thesisId),
      thesisApi.listTranscripts(thesisId),
      thesisApi.listBacktestEvidence(thesisId),
      narrativeApi.listClaims(),
    ])
    const transcript = (preferredTranscriptId ? transcripts.find((item) => item.transcript_id === preferredTranscriptId) : null) ?? transcripts[0] ?? null
    const eventIds = new Set<string>()
    for (const claim of allClaims) for (const span of claim.evidence) eventIds.add(span.event_id)
    for (const beat of transcript?.beats ?? []) for (const ref of beat.evidence_refs) {
      if (ref.item_id) eventIds.add(ref.item_id)
    }
    const events = new Map<string, VideoSourceEvent>()
    for (const eventId of eventIds) {
      try {
        events.set(eventId, await videoApi.getEvent(eventId))
      } catch {
        // A missing event surfaces as a span_unverified blocker in verification.
      }
    }
    const verification = verifyThesisForVideo({ thesis, transcript, claims: allClaims, events, backtests })
    return { thesis, transcript, backtests, verification, claims: allClaims, events }
  }, [])

  const loadThesisBundle = useCallback(async (thesisId: string, preferredTranscriptId?: string) => {
    setThesisLoading(true)
    setThesisError(null)
    try {
      const { thesis, transcript, backtests, verification } = await fetchThesisInput(thesisId, preferredTranscriptId)
      setThesisBundle({ thesis, transcript, backtests, verification })
      setSelectedThesisId(thesisId)
      onMessage(verification.ready
        ? `Thesis ${thesisId} re-verified: ${verification.verifiedClaims.length} thesis-grade claim(s), backtest delta shown.`
        : `Thesis ${thesisId} is blocked for a thesis video: ${verification.blockers.map((finding) => finding.code).join(', ')}.`)
    } catch (error) {
      setThesisBundle(null)
      const message = error instanceof Error ? error.message : 'Thesis could not be loaded.'
      setThesisError(message)
      onMessage(message)
    } finally {
      setThesisLoading(false)
    }
  }, [fetchThesisInput, onMessage])

  useEffect(() => {
    if (!episode) return
    setThesesLoading(true)
    void thesisApi.listTheses()
      .then((items) => {
        setTheses(items)
        const requestedThesisId = episode.origin === 'thesis' ? episode.thesis_id : thesisId
        if (requestedThesisId) void loadThesisBundle(requestedThesisId, transcriptId)
      })
      .catch(() => setTheses([]))
      .finally(() => setThesesLoading(false))
  }, [episode, loadThesisBundle, thesisId, transcriptId])

  useEffect(() => {
    if (!previewAsset?.relative_path) {
      setPreviewUrl(null)
      return
    }
    let cancelled = false
    setPreviewUrl(null)
    setPreviewError(null)
    void videoApi.mediaUrl(previewAsset.relative_path)
      .then((url) => {
        if (cancelled) return
        if (url) setPreviewUrl(url)
        else setPreviewError('Inline preview requires the desktop app; the MP4 is still recorded in the asset ledger.')
      })
      .catch((error) => {
        if (!cancelled) setPreviewError(error instanceof Error ? error.message : 'The rendered MP4 could not be resolved.')
      })
    return () => { cancelled = true }
  }, [previewAsset])

  useEffect(() => {
    void videoApi.listWorkflows().then(setWorkflows).catch(() => undefined)
  }, [])

  useEffect(() => {
    const text = eventQuery.trim()
    const requestId = ++eventSearchRequest.current
    if (!text) return
    const timer = window.setTimeout(() => {
      void narrativeApi.searchEvents({ text, limit: 20 }).then((page) => {
        if (requestId !== eventSearchRequest.current) return
        setEventResults(page.events)
        setActiveEventIndex(0)
        setEventSearchOpen(true)
      }).catch((error) => {
        if (requestId !== eventSearchRequest.current) return
        setEventResults([])
        setEventSearchError(error instanceof Error ? error.message : 'Retained events could not be searched.')
        setEventSearchOpen(true)
      }).finally(() => {
        if (requestId === eventSearchRequest.current) setEventSearchLoading(false)
      })
    }, 200)
    return () => window.clearTimeout(timer)
  }, [eventQuery])

  const createEpisode = async () => {
    setSaving(true)
    const timestamp = now()
    const created: VideoEpisode = { episode_id: id('episode'), project_id: project.project_id, revision: 1, title: `${project.title} · Episode 1`, as_of: timestamp, disclosure: 'Candidate planning output; source evidence remains authoritative.', status: 'draft', origin: 'event', created_at: timestamp, updated_at: timestamp }
    try {
      await videoApi.createEpisode(created)
      setEpisode(created)
      setEpisodes((items) => [created, ...items.filter((item) => item.episode_id !== created.episode_id)])
      setActiveEpisodeId(created.episode_id)
      onMessage('Episode created. Link a retained event, then explicitly select its eligible claims to build the storyboard.')
    } catch (error) { onMessage(error instanceof Error ? error.message : 'Episode creation failed.') } finally { setSaving(false) }
  }

  /** Step 0 (§d.1): start a thesis episode from a verified thesis + transcript. */
  const createThesisEpisode = async () => {
    const bundle = thesisBundle
    if (!bundle) { onMessage('Load a thesis first.'); return }
    if (bundle.verification.blockers.some((finding) => finding.code === 'thesis_provisional')) {
      onMessage('Provisional theses cannot enter a thesis video. Deep-dive and re-verify before video.')
      return
    }
    setSaving(true)
    const timestamp = now()
    const created: VideoEpisode = {
      episode_id: id('episode'), project_id: project.project_id, revision: 1,
      title: bundle.thesis.title, as_of: bundle.thesis.as_of,
      disclosure: `Thesis video · basis ${bundle.thesis.thesis_basis} · as_of ${bundle.thesis.as_of} · Not investment advice.`,
      status: 'draft', origin: 'thesis', thesis_id: bundle.thesis.thesis_id,
      transcript_id: bundle.transcript?.transcript_id ?? null,
      transcript_hash: bundle.transcript?.transcript_hash ?? null,
      created_at: timestamp, updated_at: timestamp,
    }
    try {
      await videoApi.createEpisode(created)
      setEpisode(created)
      setEpisodes((items) => [created, ...items.filter((item) => item.episode_id !== created.episode_id)])
      setActiveEpisodeId(created.episode_id)
      onMessage(`Thesis episode created from ${bundle.thesis.thesis_id} at as_of ${bundle.thesis.as_of}.`)
    } catch (error) { onMessage(error instanceof Error ? error.message : 'Thesis episode creation failed.') } finally { setSaving(false) }
  }

  const saveDraft = async (draft: VideoStoryboardDraft) => {
    await videoApi.saveNarrative(draft.narrative)
    await videoApi.saveStoryboard(draft.storyboard)
    await Promise.all(draft.scenes.map((scene) => videoApi.saveScene(scene)))
    await Promise.all(draft.shots.map((shot) => videoApi.saveShot(shot)))
    await Promise.all(draft.visualSpecs.map((spec) => videoApi.saveVisualSpec(spec)))
    setStoryboard(draft.document)
    setPersistedSpecs(draft.visualSpecs)
  }

  /** Step 3 (§d.1): build and save the thesis-shaped storyboard. */
  const saveThesisStoryboard = async () => {
    const bundle = thesisBundle
    if (!episode || !bundle) return
    if (!bundle.transcript) { onMessage('No transcript is recorded for this thesis.'); return }
    const hashFinding = verifyTranscriptHash(episode, bundle.transcript)
    if (hashFinding) { onMessage(hashFinding.message); return }
    setSaving(true)
    try {
      // Re-fetch everything, so the storyboard is built from freshly
      // re-verified spans and backtest rows, not stale UI state.
      const fresh = await fetchThesisInput(bundle.thesis.thesis_id, bundle.transcript?.transcript_id)
      setThesisBundle({ thesis: fresh.thesis, transcript: fresh.transcript, backtests: fresh.backtests, verification: fresh.verification })
      const draft = buildThesisStoryboard(
        { thesis: fresh.thesis, transcript: fresh.transcript, claims: fresh.claims, events: fresh.events, backtests: fresh.backtests },
        project, episode, id, now(),
      )
      const shapeErrors = validateStoryboardForLinkZag(draft.document)
      if (shapeErrors.length) throw new Error(`Storyboard failed the LinkZag shape check: ${shapeErrors.join(' ')}`)
      await saveDraft(draft)
      onMessage(`Thesis storyboard saved: ${draft.document.slides.length} thesis beats from transcript ${fresh.transcript?.transcript_id ?? 'unknown'}, backtests ${draft.document.backtest_refs?.join(', ') ?? 'none'}.`)
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Thesis storyboard save failed.')
    } finally {
      setSaving(false)
    }
  }

  /** The old dead code path, now wired in: transcript-first explainer beats (event origin only). */
  const saveTranscriptStoryboard = async () => {
    if (!episode || !sourceEvent) return
    setSaving(true)
    try {
      const draft = buildTranscriptStoryboard(sourceEvent, project, episode, id, now())
      await saveDraft(draft)
      onMessage('Transcript storyboard saved: 3 event-only beats (hook/source, first-sentence quote, caveat). This is an event explainer, not a thesis video.')
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Transcript storyboard save failed.')
    } finally {
      setSaving(false)
    }
  }

  const refreshClaims = useCallback(async (event: VideoSourceEvent, preferredClaimId?: string): Promise<boolean> => {
    setClaimsLoading(true)
    setClaimsError(null)
    setClaimOptions([])
    setSelectedClaimIds([])
    setClaimFilter('')
    try {
      const options = claimsForEvent(event, await narrativeApi.listClaims())
      setClaimOptions(options)
      setSelectedClaimIds(preferredClaimId && options.some((option) => option.claim.claim_id === preferredClaimId && option.evidence.length > 0) ? [preferredClaimId] : [])
      return true
    } catch (error) {
      setClaimOptions([])
      setSelectedClaimIds([])
      const message = error instanceof Error ? error.message : 'Retained NIP claims could not be loaded.'
      setClaimsError(message)
      onMessage(message)
      return false
    } finally {
      setClaimsLoading(false)
    }
  }, [onMessage])

  useEffect(() => {
    if (!activeEpisodeId) return
    let cancelled = false
    setHydrating(true)
    setHydrationFailed(false)
    const hydrate = async () => {
      try {
        const persistedEpisode = await videoApi.getEpisode(activeEpisodeId)
        if (persistedEpisode.project_id !== project.project_id) {
          throw new Error('The requested episode does not belong to the selected project.')
        }
        const [persistedEvidence, savedSpecs, renderedAssets] = await Promise.all([
          videoApi.listEvidence(persistedEpisode.episode_id, persistedEpisode.revision),
          videoApi.listEpisodeVisualSpecs(project.project_id, persistedEpisode.episode_id),
          videoApi.listProjectAssets(project.project_id, persistedEpisode.episode_id),
        ])
        const firstEventRef = persistedEvidence.find((ref) => ref.evidence_kind === 'event')
        const canonicalEvent = firstEventRef ? await videoApi.getEvent(firstEventRef.evidence_id) : null
        if (firstEventRef && canonicalEvent?.event_id !== firstEventRef.evidence_id) {
          throw new Error('The episode’s linked event could not be validated against its canonical event ID.')
        }
        if (cancelled) return
        if (canonicalEvent && !(await refreshClaims(canonicalEvent, claimId))) {
          if (!cancelled) { setHydrating(false); setHydrationFailed(true) }
          return
        }
        if (cancelled) return
        setEpisode(persistedEpisode)
        setEvidence(persistedEvidence)
        setSourceEvent(canonicalEvent)
        setPersistedSpecs(savedSpecs)
        setProjectAssets(renderedAssets)
        setPreviewAsset((current) => current ?? renderedAssets.find((asset) => asset.asset_kind === 'commentary_video' && asset.relative_path) ?? null)
        setHydrating(false)
        onMessage(null)
      } catch (error) {
        if (!cancelled) {
          setHydrating(false)
          setHydrationFailed(true)
          onMessage(error instanceof Error ? error.message : 'Persisted episode hydration failed.')
        }
      }
    }
    void hydrate()
    return () => { cancelled = true }
  }, [activeEpisodeId, project.project_id, claimId, refreshClaims, onMessage])

  const addEvidence = async (event: FormEvent) => {
    event.preventDefault()
    if (!episode || !eventId.trim() || !selectedSearchEvent || selectedSearchEvent.event_id !== eventId) return
    setLoadingSource(true)
    try {
      const source = await videoApi.getEvent(eventId.trim())
      if (!source.content_text?.trim()) throw new Error('The retained event exists but has no transcript text.')
      const ref: VideoEvidenceRef = { evidence_kind: 'event', evidence_id: source.event_id, start_offset: null, end_offset: null, quote: null }
      await videoApi.linkEvidence(episode.episode_id, episode.revision, ref)
      setEvidence((items) => items.some((item) => item.evidence_id === ref.evidence_id) ? items : [...items, ref])
      setSourceEvent(source)
      setEventId('')
      setSelectedSearchEvent(null)
      setEventQuery('')
      setEventResults([])
      setEventSearchLoading(false)
      setEventSearchError(null)
      setActiveEventIndex(0)
      setEventSearchOpen(false)
      setStoryboard(null)
      await refreshClaims(source)
      onMessage('Canonical event linked. Review the retained claims and select which exact-span-backed claims should drive this storyboard.')
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Event lookup or evidence link failed.')
    } finally {
      setLoadingSource(false)
    }
  }

  const selectSearchEvent = (event: NipEvent) => {
    setSelectedSearchEvent(event)
    setEventId(event.event_id)
    setEventSearchOpen(false)
  }

  const handleEventSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && eventResults.length) {
      event.preventDefault()
      setEventSearchOpen(true)
      setActiveEventIndex((index) => Math.min(index + 1, eventResults.length - 1))
    } else if (event.key === 'ArrowUp' && eventResults.length) {
      event.preventDefault()
      setEventSearchOpen(true)
      setActiveEventIndex((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter' && eventSearchOpen && eventResults[activeEventIndex]) {
      event.preventDefault()
      selectSearchEvent(eventResults[activeEventIndex])
    } else if (event.key === 'Escape') {
      setEventSearchOpen(false)
    }
  }

  const saveStoryboard = async () => {
    if (!episode) return
    if (!sourceEvent) { onMessage('Load a retained event transcript before building the storyboard.'); return }
    if (loadingSource || claimsLoading) { onMessage('Wait for the retained event and claim list to finish loading before building.'); return }
    const selected = claimOptions.filter((option) => selectedClaimIds.includes(option.claim.claim_id) && option.evidence.length > 0)
    if (!selected.length) { onMessage('Select at least one retained claim with a verified transcript span.'); return }
    setSaving(true)
    try {
      const refs = selected.flatMap(({ claim, evidence: spans }) => spans.flatMap((span) => [
        { evidence_kind: 'claim' as const, evidence_id: claim.claim_id, start_offset: span.start_offset, end_offset: span.end_offset, quote: span.quote },
        { evidence_kind: 'event' as const, evidence_id: sourceEvent.event_id, start_offset: span.start_offset, end_offset: span.end_offset, quote: span.quote },
      ]))
      const uniqueRefs = [...new Map(refs.map((ref) => [evidenceKey(ref), ref])).values()]
      const currentEvidence = await videoApi.listEvidence(episode.episode_id, episode.revision)
      const currentKeys = new Set(currentEvidence.map(evidenceKey))
      for (const ref of uniqueRefs) {
        if (!currentKeys.has(evidenceKey(ref))) await videoApi.linkEvidence(episode.episode_id, episode.revision, ref)
      }
      setEvidence((items) => [...new Map([...items, ...currentEvidence, ...uniqueRefs].map((ref) => [evidenceKey(ref), ref])).values()])
      const draft = buildSelectedClaimsStoryboard(sourceEvent, selected, project, episode, id, now())
      await saveDraft(draft)
      onMessage(`Storyboard saved from ${selected.length} explicitly selected retained claim${selected.length === 1 ? '' : 's'}, with exact claim/event evidence spans pinned to each visual spec.`)
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Storyboard save failed.')
    } finally {
      setSaving(false)
    }
  }

  const pollJob = async (initial: VideoJob) => {
    setActiveJob(initial)
    let current = initial
    for (let attempt = 0; attempt < 600 && !['succeeded', 'failed', 'cancelled'].includes(current.status); attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_000))
      current = await videoApi.getJob(initial.job_id)
      setActiveJob(current)
    }
    if (current.status === 'succeeded' && current.output_manifest?.asset) {
      const asset = current.output_manifest.asset
      const narrated = current.output_manifest.narrated === true
      const completedTtsEngine = typeof current.output_manifest.tts_engine === 'string' ? current.output_manifest.tts_engine : null
      const completedMode = current.output_manifest.capture_mode ?? current.resource_estimate?.capture_mode ?? captureMode
      const modeLabel = completedMode === 'full' ? 'Full deterministic' : 'Flash real-time preview'
      setProjectAssets((items) => [asset, ...items.filter((item) => item.asset_id !== asset.asset_id)])
      setPreviewAsset(asset)
      const label = `${narrated ? `Narrated${completedTtsEngine ? ` (${completedTtsEngine})` : ''}` : 'Silent'} commentary MP4 ready · ${asset.asset_id} · ${modeLabel}`
      setJobNotice(label)
      onMessage(label)
    } else if (current.status === 'cancelled') {
      setJobNotice(`Video job ${current.job_id} was cancelled. The attempt remains inspectable.`)
    } else if (current.status === 'failed') {
      setJobNotice(current.safe_error_message ?? `Video job ${current.job_id} failed.`)
    } else {
      setJobNotice(`Video job ${current.job_id} remains ${current.status}; reopen the workspace to inspect it.`)
    }
  }

  const renderLinkZag = async () => {
    const visualSpecs = storyboard?.slides.map((slide) => ({ spec_id: slide.visual_spec.spec_id, revision: slide.visual_spec.revision }))
      ?? persistedSpecs.map((spec) => ({ spec_id: spec.spec_id, revision: spec.revision }))
    if (!visualSpecs.length) { onMessage('Build and save the slides storyboard before rendering.'); return }
    // Step 4 (§d.1): before rendering, read back every pinned VisualSpec
    // and confirm its event refs match the verified receipt event IDs and
    // its backtest refs match recorded backtest_ids.
    if (storyboard) {
      const shapeErrors = validateStoryboardForLinkZag(storyboard)
      if (shapeErrors.length) { onMessage(`Render blocked: storyboard failed the LinkZag shape check: ${shapeErrors.join(' ')}`); return }
      if (episode?.origin === 'thesis' && thesisBundle) {
        const recorded = new Set(thesisBundle.backtests.map((record) => record.backtest_id))
        const unresolvable = (storyboard.backtest_refs ?? []).filter((ref) => !recorded.has(ref))
        if (unresolvable.length) { onMessage(`Render blocked: storyboard cites backtest(s) ${unresolvable.join(', ')} with no recorded backtest-evidence row.`); return }
      }
    }
    setRendering(true)
    setJobNotice(null)
    const shouldNarrate = narrate && capabilities?.tts === 'ready'
    try {
      const result = await videoApi.renderLinkZag(visualSpecs, captureMode, shouldNarrate)
      onMessage(`Video job ${result.job_id} queued for all ${visualSpecs.length} saved slides in ${captureMode} mode${shouldNarrate ? ' with local Qwen3-TTS narration' : ' (silent)'}.`)
      await pollJob(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'LinkZag render failed.'
      setJobNotice(`${message} Check the job list or renderer configuration.`)
      onMessage(message)
    } finally {
      setRendering(false)
    }
  }

  const cancelActiveJob = async () => {
    if (!activeJob) return
    try { const job = await videoApi.cancelJob(activeJob.job_id); setActiveJob(job); setJobNotice(`Cancellation requested for ${job.job_id}.`) } catch (error) { setJobNotice(error instanceof Error ? error.message : 'Cancellation request failed.') }
  }

  const retryActiveJob = async () => {
    if (!activeJob) return
    setRendering(true)
    setJobNotice(null)
    try {
      const retry = await videoApi.retryJob(activeJob.job_id)
      await pollJob(retry)
    } catch (error) {
      setJobNotice(error instanceof Error ? error.message : 'Retry failed.')
    } finally {
      setRendering(false)
    }
  }

  /** Step 6 (§d.1): build the deterministic EDL timeline from the saved storyboard. */
  const buildTimeline = async () => {
    if (!episode || !storyboard) { onMessage('Build and save the storyboard in this session before building the timeline.'); return }
    if (!previewAsset) { onMessage('Render the storyboard first: timeline clips reference the rendered MP4 asset.'); return }
    setTimelineBuilding(true)
    try {
      const fps = 30
      const clips = storyboard.slides.flatMap((slide) => slide.shots.map((shot) => ({
        shot_ref: { id: shot.shot_id, revision: shot.revision },
        asset_ref: { id: previewAsset.asset_id, revision: previewAsset.revision },
        duration_frames: Math.max(1, Math.round(((slide.scene.duration_ms ?? 6_000) / 1_000) * fps)),
        source_in_frame: 0,
        fit: 'contain',
        evidence_refs: slide.evidence.map((ref) => ({ kind: ref.evidence_kind, id: ref.evidence_id })),
      })))
      const result = await videoApi.buildTimeline({
        project_ref: { id: project.project_id, revision: project.revision },
        episode_ref: { id: episode.episode_id, revision: episode.revision },
        storyboard_ref: { id: storyboard.storyboard_id, revision: 1 },
        output_profile_id: VIDEO_PREVIEW_PROFILE_ID,
        video_tracks: [{ track_id: 'video-1', ordinal: 0, clips }],
        audio_tracks: [],
        caption_tracks: [],
        gap_policy: 'block',
        request_id: id('timeline-request'),
      })
      setTimelineResult(result)
      onMessage(result.status === 'ready'
        ? `Timeline ready · ${result.timeline_ref?.id ?? 'unknown'} · hash ${result.timeline_hash?.slice(0, 12) ?? 'unknown'} · ${result.summary?.video_clips ?? 0} clips.`
        : `Timeline build ${result.status}: ${result.findings.map((finding) => `${finding.code}: ${finding.message}`).join(' ')}`)
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Timeline build failed.')
    } finally {
      setTimelineBuilding(false)
    }
  }

  /** Step 5 (§d.1): run the deterministic evaluator QA against the ready timeline. */
  const runQa = async () => {
    const ref = timelineResult?.timeline_ref
    if (!ref) { onMessage('Build a ready timeline first.'); return }
    setQaRunning(true)
    try {
      const job = await videoApi.runQa(ref.id, ref.revision, VIDEO_PREVIEW_PROFILE_ID, id('qa-request'))
      let current = job
      for (let attempt = 0; attempt < 60 && !['succeeded', 'failed', 'cancelled'].includes(current.status); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000))
        current = await videoApi.getJob(job.job_id)
      }
      if (current.status !== 'succeeded') throw new Error(current.safe_error_message ?? `QA job ${job.job_id} ended ${current.status}.`)
      const manifest = current.output_manifest as { report_ref?: { id: string; revision: number } } | null
      const reportId = manifest?.report_ref?.id
      if (!reportId) throw new Error('QA job succeeded but returned no report ref.')
      const report = await videoApi.getQaReportByRef(reportId)
      setQaReport(report)
      onMessage(`QA report ${reportId}: decision ${String(report.decision ?? 'unknown')}, execution ${String(report.executionState ?? 'unknown')}.`)
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'QA run failed.')
    } finally {
      setQaRunning(false)
    }
  }

  const loadExportProfiles = async () => {
    try {
      const { profiles } = await videoApi.listExportProfiles()
      setExportProfiles(profiles)
      if (profiles.length && !exportProfileId) setExportProfileId(profiles[0].id)
      if (!profiles.length) onMessage('No installed export profile is available for preview export.')
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Export profiles could not be listed.')
    }
  }

  const qaReportId = typeof qaReport?.reportRef === 'object' && qaReport.reportRef !== null
    ? String((qaReport.reportRef as { id?: unknown }).id ?? '')
    : ''

  /** Step 6 (§d.1): preflight, then start the profile-gated export. */
  const runExportPreflight = async () => {
    const ref = timelineResult?.timeline_ref
    if (!ref || !qaReportId || !exportProfileId) { onMessage('Timeline, QA report, and export profile are all required before preflight.'); return }
    setExportBusy(true)
    try {
      const result = await videoApi.exportPreflight(ref.id, ref.revision, qaReportId, exportProfileId)
      setPreflight(result)
      onMessage('Export preflight complete; see the export section for the authorization result.')
    } catch (error) {
      setPreflight(null)
      onMessage(error instanceof Error ? error.message : 'Export preflight failed.')
    } finally {
      setExportBusy(false)
    }
  }

  const startExport = async () => {
    const ref = timelineResult?.timeline_ref
    if (!ref || !qaReportId || !exportProfileId) { onMessage('Timeline, QA report, and export profile are all required before export.'); return }
    setExportBusy(true)
    try {
      const result = await videoApi.exportStart(ref.id, ref.revision, qaReportId, exportProfileId, id('export-request'))
      const job = result.job as { jobId?: unknown; job_id?: unknown } | undefined
      const jobId = String(job?.jobId ?? job?.job_id ?? '')
      if (!jobId) throw new Error('Export start returned no job handle.')
      let current = await videoApi.getJob(jobId)
      for (let attempt = 0; attempt < 600 && !['succeeded', 'failed', 'cancelled'].includes(current.status); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000))
        current = await videoApi.getJob(jobId)
      }
      if (current.status !== 'succeeded') throw new Error(current.safe_error_message ?? `Export job ${jobId} ended ${current.status}.`)
      const manifest = current.output_manifest as { manifest_ref?: { id: string }; manifest_id?: string } | null
      const manifestId = manifest?.manifest_ref?.id ?? manifest?.manifest_id
      if (manifestId) {
        setExportManifest(await videoApi.getExportManifestV1(manifestId))
        onMessage(`Export manifest ${manifestId} read back and verified.`)
      } else {
        setExportManifest(current.output_manifest ?? {})
        onMessage('Export job succeeded; the producer manifest ref was not in the job output, so the raw job manifest is shown instead.')
      }
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Export failed.')
    } finally {
      setExportBusy(false)
    }
  }

  // Step 7 (§d.1) publish gate. Thesis video: every condition must hold.
  // Event explainer: its own weaker gate, labelled as such (§f.4).
  const isThesisEpisode = episode?.origin === 'thesis'
  const verification = thesisBundle?.verification ?? null
  const verificationBlockers = verification?.blockers ?? []
  const qaCheckSummary = (qaReport?.checkSummary ?? {}) as { passed?: number; warnings?: number; blockers?: number; notRun?: number }
  const qaDecision = typeof qaReport?.decision === 'string' ? qaReport.decision : null
  const qaExecution = typeof qaReport?.executionState === 'string' ? qaReport.executionState : null
  const qaPassed = qaReport !== null && qaExecution === 'complete' && (qaDecision === 'allow' || qaDecision === 'allow_with_warnings')
    && (qaCheckSummary.blockers ?? 0) === 0 && (qaCheckSummary.notRun ?? 0) === 0
  const exportManifestId = typeof exportManifest?.manifestId === 'string' ? exportManifest.manifestId
    : typeof exportManifest?.manifest_id === 'string' ? exportManifest.manifest_id
    : typeof (exportManifest as { id?: unknown } | null)?.id === 'string' ? String((exportManifest as { id: unknown }).id) : ''
  const backtestGateOk = verification !== null
    && (verification.deltaShown || (verification.backtestAbsenceRecorded && backtestAbsenceAcknowledged))
  const thesisPublishBlockers: string[] = []
  if (isThesisEpisode) {
    if (!thesisBundle) thesisPublishBlockers.push('no thesis loaded for this episode')
    if (thesisBundle && thesisBundle.thesis.thesis_basis !== 'llm_verified_only') thesisPublishBlockers.push('thesis basis is not llm_verified_only')
    if (verificationBlockers.length) thesisPublishBlockers.push(`verification has ${verificationBlockers.length} blocker(s): ${verificationBlockers.map((finding) => finding.code).join(', ')}`)
    if (!qaPassed) thesisPublishBlockers.push(qaReport === null ? 'deterministic QA has not run' : `QA did not pass (decision ${qaDecision ?? 'unknown'}, execution ${qaExecution ?? 'unknown'}, blockers ${qaCheckSummary.blockers ?? '?'}, not run ${qaCheckSummary.notRun ?? '?'})`)
    if (!visualReviewDone) thesisPublishBlockers.push('visual review not marked done by a human')
    if (!exportManifestId) thesisPublishBlockers.push('no export manifest read back')
    if (verification && !backtestGateOk) thesisPublishBlockers.push(verification.backtestAbsenceRecorded ? 'backtest absence recorded but not acknowledged' : 'backtest delta is not shown')
    if (!publishApproval) thesisPublishBlockers.push('human publish approval not checked')
  }
  const explainerPublishBlockers: string[] = []
  if (!isThesisEpisode) {
    if (!storyboard && persistedSpecs.length === 0) explainerPublishBlockers.push('no saved storyboard')
    if (!visualReviewDone) explainerPublishBlockers.push('visual review not marked done by a human')
    if (!publishApproval) explainerPublishBlockers.push('human publish approval not checked')
  }
  const publishBlockers = isThesisEpisode ? thesisPublishBlockers : explainerPublishBlockers
  const canPublish = publishBlockers.length === 0

  /** Step 7 (§d.1): human approval only — no auto-publish, ever. */
  const publish = async () => {
    if (!episode || !canPublish) return
    setPublishing(true)
    try {
      const receipt = {
        type: isThesisEpisode ? 'thesis_video' : 'event_explainer_internal_review_only',
        approvedAt: now(),
        thesisId: episode.thesis_id ?? null,
        transcriptHash: episode.transcript_hash ?? null,
        storyboardId: storyboard?.storyboard_id ?? null,
        qaReportId: qaReportId || null,
        exportManifestId: exportManifestId || null,
        backtestIds: thesisBundle?.verification.resolvedBacktests.map((record) => record.backtest_id) ?? [],
      }
      if (isThesisEpisode && thesisBundle) {
        // Record the publish on the thesis pipeline itself (store-enforced).
        await thesisApi.saveThesis({ ...thesisBundle.thesis, status: 'published', updated_at: now() })
      }
      setPublishReceipt(receipt)
      onMessage(isThesisEpisode
        ? `Thesis video published by human approval at ${receipt.approvedAt}. Receipt: thesis ${receipt.thesisId}, transcript ${receipt.transcriptHash ?? 'none'}, storyboard ${receipt.storyboardId ?? 'none'}, QA ${receipt.qaReportId ?? 'none'}, export ${receipt.exportManifestId ?? 'none'}.`
        : `Event explainer published as internal_review_only by human approval at ${receipt.approvedAt}. It is not a thesis video.`)
    } catch (error) {
      onMessage(error instanceof Error ? error.message : 'Publish failed; nothing was recorded as published.')
    } finally {
      setPublishing(false)
    }
  }

  const storyboardJson = storyboard ? JSON.stringify(storyboard, null, 2) : ''
  const downloadHref = storyboard ? `data:application/json;charset=utf-8,${encodeURIComponent(storyboardJson)}` : undefined
  const jobLineage = activeJob?.output_manifest?.lineage ?? []
  const normalizedClaimFilter = claimFilter.trim().toLocaleLowerCase()
  const filteredClaimOptions = claimOptions.filter(({ claim }) => [claim.claim_text, claim.speaker_or_author, claim.provider, claim.model, claim.claim_id].some((value) => value?.toLocaleLowerCase().includes(normalizedClaimFilter)))
  const ttsReady = capabilities?.tts === 'ready'
  const ttsReason = capabilities?.tts_reason || capabilities?.tts_detail?.blockers?.[0] || 'local Qwen3-TTS is not configured'
  const ttsEngine = capabilities?.tts_detail?.tts_engine ?? null
  const ttsEngineLabel = capabilities?.tts_detail?.engines?.find((entry) => entry.id === ttsEngine)?.label ?? ttsEngine ?? 'Qwen3-TTS'

  return <div className="video-page" data-testid="video-episode-workspace">
    <header className="video-hero"><div><button type="button" className="video-back" onClick={onBack}>← Projects</button><p className="eyebrow">Project v{project.revision} · {project.status}</p><h1>{project.title}</h1><p>Episode → narrative → slides → scenes, shots, and audio cues. Source text remains in NIP.</p></div><span className="video-chip video-chip-strong">{capabilities?.planning ?? 'planning'}</span></header>
    {message ? <p className="video-alert" role="alert">{message}</p> : null}
    {episodesLoading || episodes.length ? <section className="video-episode-bar" aria-label="Project episodes" data-testid="video-episode-bar">
      {episodesLoading ? <span className="video-footnote" role="status">Loading persisted episodes…</span> : <>
        <label className="video-episode-select">Episode<select aria-label="Select episode" data-testid="video-episode-select" value={activeEpisodeId ?? ''} onChange={(event) => setActiveEpisodeId(event.target.value || undefined)}>{episodes.map((item) => <option key={item.episode_id} value={item.episode_id}>v{item.revision} · {item.title}</option>)}</select></label>
        <span className="video-chip">{episodes.length} episode{episodes.length === 1 ? '' : 's'} saved</span>
        <span className="video-footnote">{persistedSpecs.length ? `${persistedSpecs.length} saved slide spec${persistedSpecs.length === 1 ? '' : 's'} ready to render.` : 'No saved slides for this episode yet.'}</span>
      </>}
    </section> : null}
    <section className="video-capability-grid"><Capability label="Planning" state={capabilities?.planning} /><Capability label="Evidence linkage" state={capabilities?.evidence_linkage} /><Capability label="Capture modes" state="Flash default · Full available" /><Capability label="TTS / narration audio" state={capabilities?.tts} /></section>
    {jobNotice ? <section className={`video-job-banner ${activeJob?.status === 'succeeded' ? 'is-success' : activeJob?.status === 'failed' || activeJob?.status === 'cancelled' ? 'is-error' : 'is-info'}`} role={activeJob?.status === 'failed' ? 'alert' : 'status'}><div><strong>Video job {activeJob?.status ?? 'notice'}</strong><p>{jobNotice}</p>{activeJob ? <small>{activeJob.job_id} · {Math.round(activeJob.progress_millis / 1000)}% · {activeJob.cancellation_requested ? 'cancellation requested' : 'durable state persisted'}</small> : null}</div><div className="video-job-actions">{activeJob && !['succeeded', 'failed', 'cancelled'].includes(activeJob.status) ? <button type="button" className="video-secondary-button" onClick={() => void cancelActiveJob()}>Cancel</button> : null}{activeJob && ['failed', 'cancelled'].includes(activeJob.status) ? <button type="button" className="video-primary-button" onClick={() => void retryActiveJob()} disabled={rendering}>Retry job</button> : null}<button type="button" className="video-secondary-button" onClick={() => setJobNotice(null)}>Dismiss</button></div></section> : null}
    {activeJob?.status === 'succeeded' && jobLineage.length ? <p className="video-footnote" data-testid="video-job-lineage">Final asset retains {jobLineage.length} upstream links: {jobLineage.filter((item) => item.upstream_kind === 'visual_spec').length} saved slide specs and {jobLineage.filter((item) => item.upstream_kind === 'event' || item.upstream_kind === 'claim').length} canonical event/claim sources.</p> : null}
    {episode ? <section className="video-card">
      <div className="video-card-head"><div><p className="eyebrow">Episode v{episode.revision}</p><h2>{episode.title}</h2></div><span className="video-chip">{episode.status}</span></div>
      <section className="video-thesis-panel" aria-labelledby="video-thesis-heading" data-testid="thesis-entry">
        <div className="video-card-head"><div><p className="eyebrow">Step 0 · entry point</p><h3 id="video-thesis-heading">Start from a thesis — or from an event</h3><p>A thesis video states a falsifiable thesis, shows its evidence and its ablation backtest, and states what would invalidate it. An event explainer has no thesis and no backtest, and can only ever publish as internal review.</p></div><span className="video-chip video-chip-strong">{episode.origin === 'thesis' ? 'Thesis video' : 'Event explainer (no thesis, no backtest)'}</span></div>
        {thesesLoading ? <p className="video-footnote" role="status">Loading recorded theses…</p> : theses.length ? <>
          <label className="video-episode-select">Thesis<select aria-label="Select thesis" data-testid="thesis-select" value={selectedThesisId} onChange={(event) => setSelectedThesisId(event.target.value)}><option value="">Choose a recorded thesis…</option>{theses.map((thesis) => <option key={thesis.thesis_id} value={thesis.thesis_id}>{thesis.thesis_basis === 'provisional_fast_glance' ? 'PROVISIONAL — ' : ''}{thesis.title} · {thesis.entity_symbol ?? 'no symbol'} · {thesis.status}</option>)}</select></label>
          <div className="video-inline-actions">
            <button className="video-secondary-button" type="button" data-testid="thesis-load-button" onClick={() => void loadThesisBundle(selectedThesisId)} disabled={!selectedThesisId || thesisLoading}>{thesisLoading ? 'Verifying…' : 'Load and re-verify thesis'}</button>
            {thesisBundle && episode.origin !== 'thesis' ? <button className="video-primary-button" type="button" data-testid="thesis-start-episode" onClick={() => void createThesisEpisode()} disabled={saving || thesisBundle.verification.blockers.some((finding) => finding.code === 'thesis_provisional')}>Start thesis episode from this thesis</button> : null}
            {thesisBundle && episode.origin === 'thesis' && episode.thesis_id === thesisBundle.thesis.thesis_id ? <button className="video-primary-button" type="button" data-testid="thesis-build-storyboard" onClick={() => void saveThesisStoryboard()} disabled={saving || !thesisBundle.verification.ready}>{saving ? 'Saving…' : `Build thesis storyboard (${thesisBundle.verification.verifiedClaims.length} verified claim${thesisBundle.verification.verifiedClaims.length === 1 ? '' : 's'})`}</button> : null}
          </div>
        </> : <p className="video-footnote">No theses are recorded yet. Record one in the Thesis tab first; a thesis video cannot start from claims alone.</p>}
        {thesisError ? <p className="video-alert" role="alert">{thesisError}</p> : null}
        {thesisBundle ? <div className="video-thesis-card" data-testid="thesis-card">
          <div><strong>{thesisBundle.thesis.title}</strong><small>{thesisBundle.thesis.entity_symbol ?? 'no symbol'} · {thesisBundle.thesis.direction} · horizon {thesisBundle.thesis.horizon ?? 'not stated'} · as_of {thesisBundle.thesis.as_of}</small></div>
          <span className={`video-chip ${thesisBundle.thesis.thesis_basis === 'llm_verified_only' ? 'video-chip-strong' : ''}`}>{thesisBundle.thesis.thesis_basis === 'llm_verified_only' ? 'llm_verified_only' : 'PROVISIONAL — NOT THESIS-GRADE'}</span>
          <span className="video-chip">{thesisBundle.thesis.status}</span>
          <p>{thesisBundle.thesis.reason ?? 'No reason recorded.'}</p>
          <p><strong>Invalidation:</strong> {thesisBundle.thesis.invalidation_condition ?? '— not stated —'}</p>
          <p><strong>What would change my mind:</strong> {thesisBundle.thesis.what_would_change_mind ?? '— not stated —'}</p>
          <p><strong>Transcript:</strong> {thesisBundle.transcript ? `${thesisBundle.transcript.transcript_id} · hash ${thesisBundle.transcript.transcript_hash.slice(0, 12)} · ${thesisBundle.transcript.beats.length} beats` : 'none recorded — a thesis video cannot start without one'}</p>
          <div className="video-verification" data-testid="thesis-verification">
            <strong>{thesisBundle.verification.ready ? 'Re-verification passed' : `Re-verification blocked (${thesisBundle.verification.blockers.length} blocker${thesisBundle.verification.blockers.length === 1 ? '' : 's'})`}</strong>
            <span>{thesisBundle.verification.verifiedClaims.length} of {thesisBundle.thesis.claim_ids.length} cited claim(s) re-verified (tier2_llm, llm_verified/corrected, exact spans)</span>
            {thesisBundle.verification.blockers.map((finding) => <p className="video-claim-warning" role="alert" key={finding.code} data-testid={`qa-finding-${finding.code}`}><strong>{finding.code}:</strong> {finding.message}</p>)}
            {thesisBundle.verification.advisories.map((finding) => <p className="video-footnote" key={finding.code} data-testid={`qa-finding-${finding.code}`}><strong>{finding.code}:</strong> {finding.message}</p>)}
          </div>
          <section className="video-backtest-panel" aria-labelledby="video-backtest-heading" data-testid="backtest-panel">
            <div className="video-card-head"><div><p className="eyebrow">Step 2 · ablation</p><h3 id="video-backtest-heading">Backtest: Run A vs Run B</h3></div><span className="video-chip">{thesisBundle.verification.latestBacktest ? thesisBundle.verification.latestBacktest.verdict.replaceAll('_', ' ') : 'no ablation recorded'}</span></div>
            {thesisBundle.verification.latestBacktest ? <>
              <p>{backtestVerdictText(thesisBundle.verification.latestBacktest)}</p>
              <pre className="video-backtest-table" data-testid="backtest-table">{backtestTableText(thesisBundle.verification.latestBacktest)}</pre>
              <small>Run A {thesisBundle.verification.latestBacktest.run_id_a} · Run B {thesisBundle.verification.latestBacktest.run_id_b} · source {thesisBundle.verification.latestBacktest.source} · recorded {thesisBundle.verification.latestBacktest.recorded_at}</small>
              {thesisBundle.verification.backtestAbsenceRecorded ? <label className="video-check"><input type="checkbox" data-testid="backtest-absence-acknowledge" checked={backtestAbsenceAcknowledged} onChange={(event) => setBacktestAbsenceAcknowledged(event.target.checked)} /> I acknowledge the ablation could not run and no backtest delta is claimed in this video.</label> : null}
            </> : <p className="video-claim-warning" role="alert">No ablation is recorded for this thesis. The episode cannot proceed to a thesis video until an ablation is recorded — or its failure to run is recorded with its reason. It can still proceed as an event explainer.</p>}
          </section>
        </div> : null}
      </section>
      <div className="video-evidence-panel"><div><strong>Retained transcript source</strong> <span className="video-chip">Event explainer (no thesis, no backtest)</span><p>Search for an immutable NIP event, select the matching source, then explicitly load and link it. Raw transcript text is not copied into the Video projection.</p></div><form onSubmit={addEvidence} className="video-inline-form video-event-form"><div className="video-event-picker"><label htmlFor="video-event-search">Search retained events</label><input id="video-event-search" role="combobox" aria-autocomplete="list" aria-expanded={eventSearchOpen && !selectedSearchEvent} aria-controls="video-event-options" aria-activedescendant={eventSearchOpen && eventResults[activeEventIndex] ? `video-event-option-${activeEventIndex}` : undefined} aria-label="Search retained events" placeholder="Search transcript text or source ID…" value={eventQuery} disabled={loadingSource} onFocus={() => { if (eventResults.length || eventSearchLoading || eventSearchError) setEventSearchOpen(true) }} onKeyDown={handleEventSearchKeyDown} onChange={(event) => { eventSearchRequest.current += 1; setEventResults([]); setEventSearchLoading(Boolean(event.target.value.trim())); setEventSearchError(null); setActiveEventIndex(0); setEventQuery(event.target.value); setEventId(''); setSelectedSearchEvent(null); setEventSearchOpen(true) }} />{eventSearchOpen && !selectedSearchEvent ? <div className="video-event-options" id="video-event-options" role="listbox" aria-label="Retained event search results" aria-busy={eventSearchLoading}>{eventSearchLoading ? <p className="video-event-state" role="status">Searching retained events…</p> : eventSearchError ? <p className="video-event-state is-error" role="alert">{eventSearchError}</p> : eventResults.length ? eventResults.map((result, index) => <div id={`video-event-option-${index}`} className={`video-event-option${activeEventIndex === index ? ' is-active' : ''}`} key={result.event_id} role="option" aria-selected={activeEventIndex === index} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveEventIndex(index)} onClick={() => selectSearchEvent(result)}><strong>{result.source_id} · {result.source_native_id || 'native ID unavailable'}</strong><code>{result.event_id}</code><span>{result.content_text?.trim() || 'No transcript preview available.'}</span></div>) : <p className="video-event-state">No retained events match “{eventQuery.trim()}”.</p>}</div> : null}{selectedSearchEvent ? <p className="video-selected-event" role="status">Selected: {selectedSearchEvent.source_id} · {selectedSearchEvent.source_native_id || 'native ID unavailable'} · {selectedSearchEvent.event_id}</p> : <p className="video-event-hint">Search retained transcript text or source IDs to choose an event.</p>}</div><button className="video-secondary-button" type="submit" disabled={loadingSource || !selectedSearchEvent || !eventId}>{loadingSource ? 'Loading…' : 'Load and link event'}</button></form>
        {sourceEvent ? <div className="video-evidence-row" data-testid="loaded-source-event"><FileCheck2 size={14} /><code>{sourceEvent.event_id}</code><span>{sourceEvent.content_text?.length ?? 0} transcript characters · hash {sourceEvent.content_hash.slice(0, 12)}</span></div> : null}
        {evidence.map((ref) => <div className="video-evidence-row" key={evidenceKey(ref)}><FileCheck2 size={14} /><code>{ref.evidence_id}</code><span>{ref.evidence_kind} · validated</span></div>)}
      </div>
      {sourceEvent ? <section className="video-claim-panel" aria-labelledby="video-claim-heading" data-testid="video-claim-picker">
        <div className="video-claim-toolbar"><div><p className="eyebrow">Step 2 · editorial selection</p><h3 id="video-claim-heading">Which retained claims belong in this cut?</h3><p>Claims are extracted analyses, not verbatim quotations. Exact-span checks prove the quote and offsets match the transcript; they do not prove the quote supports the claim. Review support before rendering.</p></div><button className="video-secondary-button" type="button" onClick={() => void refreshClaims(sourceEvent)} disabled={claimsLoading}><RefreshCw size={13} className={claimsLoading ? 'animate-spin' : ''} /> Refresh claims</button></div>
        {claimsError ? <p className="video-claim-warning" role="alert">{claimsError}</p> : null}
        {!claimsLoading && claimOptions.length ? <label className="video-claim-filter">Filter retained claims<input type="search" aria-label="Filter claims" placeholder="Claim text, speaker, provider, model, or claim ID…" value={claimFilter} onChange={(event) => setClaimFilter(event.target.value)} /></label> : null}
        {claimsLoading ? <p className="video-footnote" role="status">Loading claims retained in NIP…</p> : claimOptions.length && filteredClaimOptions.length ? <div className="video-claim-list">{filteredClaimOptions.map(({ claim, evidence: spans, rejectedEvidenceCount }) => {
          const selectedClaim = selectedClaimIds.includes(claim.claim_id)
          return <label className={`video-claim-option${selectedClaim ? ' is-selected' : ''}${!spans.length ? ' is-ineligible' : ''}`} key={claim.claim_id} data-testid={`video-claim-option-${claim.claim_id}`}>
            <input type="checkbox" aria-label={`Select claim: ${claim.claim_text}`} data-testid={`video-claim-select-${claim.claim_id}`} checked={selectedClaim} disabled={!spans.length || claimsLoading || loadingSource} onChange={() => setSelectedClaimIds((current) => selectedClaim ? current.filter((claimId) => claimId !== claim.claim_id) : [...current, claim.claim_id])} />
            <span className="video-claim-content"><strong>{claim.claim_text}</strong><small>Claim · {claim.speaker_or_author ?? 'speaker not recorded'} · {claim.provider}/{claim.model} · confidence {Math.round(claim.confidence_millis / 10)}% · {claim.claim_id}</small>
              {spans.map((span, index) => <span className="video-claim-evidence" key={`${span.start_offset}-${span.end_offset}-${index}`}><q>{span.quote}</q><small>Exact source span [{span.start_offset}, {span.end_offset}) · Unicode characters</small></span>)}
              {rejectedEvidenceCount > 0 ? <small className="video-claim-warning">{rejectedEvidenceCount} stored span{rejectedEvidenceCount === 1 ? '' : 's'} did not exactly match the retained transcript and cannot support this storyboard.</small> : null}
              {!spans.length ? <small className="video-claim-warning">Not selectable: this claim has no verified exact source span for the loaded event.</small> : null}
            </span>
          </label>
        })}</div> : claimOptions.length ? <p className="video-claim-empty" role="status">No claims match this filter. Try claim text, speaker or author, provider, model, or claim ID.</p> : <p className="video-claim-empty">No retained claims cite this event. Extract and review claims in NIP Narrative, then refresh here. Video will not invent claims or substitute a generic outline.</p>}
        <p className="video-footnote">{selectedClaimIds.filter((claimId) => claimOptions.some((option) => option.claim.claim_id === claimId && option.evidence.length > 0)).length} claim(s) selected · selection order follows the retained claim list.</p>
      </section> : null}
      <div className="video-card-head video-storyboard-head"><div><p className="eyebrow">Storyboard</p><h2>{episode.origin === 'thesis' ? 'Thesis beats · slides.json' : 'Selected-claim slides.json'}</h2></div><div className="video-inline-actions"><button className="video-primary-button" type="button" onClick={() => void saveStoryboard()} disabled={saving || loadingSource || claimsLoading || !sourceEvent || selectedClaimIds.length === 0}><Sparkles size={14} /> {saving ? 'Saving…' : `Build from selected claims (${selectedClaimIds.length})`}</button>{episode.origin !== 'thesis' ? <button className="video-secondary-button" type="button" data-testid="transcript-build-storyboard" onClick={() => void saveTranscriptStoryboard()} disabled={saving || loadingSource || !sourceEvent} title="Event-only transcript beats (hook/source, first-sentence quote, caveat). Not a thesis video.">Build transcript storyboard (3 beats)</button> : null}{storyboard && downloadHref ? <a className="video-secondary-button" href={downloadHref} download={`${storyboard.storyboard_id}.slides.json`}>Download slides.json</a> : null}</div></div>
      {storyboard ? <><div className="video-scene-grid">{storyboard.slides.map((slide, index) => <article className="video-scene-card" key={slide.slide_id} data-testid={`storyboard-slide-${index + 1}`}><span>0{index + 1}</span><strong>{slide.purpose}</strong><p>{slide.scene.narration_text}</p><small>{Math.round((slide.scene.duration_ms ?? 0) / 1000)}s · {slide.shots.length} shot · audio cue {slide.audio_cue.status}</small></article>)}</div><details className="video-storyboard-json"><summary>Inspect slides.json · scenes, shots, audio cues, and evidence</summary><pre data-testid="storyboard-json">{storyboardJson}</pre></details></> : persistedSpecs.length ? <><div className="video-scene-grid" data-testid="persisted-storyboard">{persistedSpecs.map((spec, index) => {
        const label = spec.payload.kind === 'evidence_card' ? spec.payload.title
          : spec.payload.kind === 'quote_card' ? spec.payload.quote
          : spec.payload.kind === 'kinetic_text' || spec.payload.kind === 'caption' ? spec.payload.text
          : spec.payload.kind === 'chart_transition' ? spec.payload.title
          : spec.payload.label ?? 'Scene transition'
        return <article className="video-scene-card" key={spec.spec_id} data-testid={`persisted-slide-${index + 1}`}><span>0{index + 1}</span><strong>{spec.template.replaceAll('_', ' ')}</strong><p>{label}</p><small>{Math.round(spec.duration_ms / 1000)}s · saved spec v{spec.revision} · {spec.sources.length} source{spec.sources.length === 1 ? '' : 's'}</small></article>
      })}</div><p className="video-footnote" role="status">These slides were saved from a previous storyboard and are ready to render. Rebuild only when you want to replace them from a new claim selection.</p></> : <p className="video-footnote">{sourceEvent ? 'Select one or more eligible claims above to build the storyboard. No event-only placeholder beats are added.' : 'Load a retained event, review its stored claims, and explicitly select which claims should appear in the storyboard.'}</p>}
      <p className="video-footnote">{ttsReady ? (narrate ? (ttsEngine === null || ttsEngine === 'comfy_qwen3' ? 'Narration: each scene’s audio cue is synthesized locally with Qwen3-TTS through ComfyUI and muxed into this MP4.' : `Narration: each scene’s audio cue is synthesized locally with ${ttsEngineLabel} (fallback — ComfyUI Qwen3 unavailable) and muxed into this MP4.`) : 'Narration is off for this render; the MP4 will be silent.') : `Narration unavailable: ${ttsReason}. The MP4 will be silent.`}</p>
      <div className="video-card-head video-storyboard-head"><div><p className="eyebrow">LinkZag renderer</p><h2>Commentary video capture</h2></div><div className="video-render-controls"><label className="video-render-mode">Capture mode<select aria-label="Capture mode" data-testid="video-capture-mode" value={captureMode} onChange={(event) => setCaptureMode(event.target.value as 'flash' | 'full')} disabled={rendering}><option value="flash">Flash · real-time preview (Canvas)</option><option value="full">Full · deterministic screenshots (SVG)</option></select></label><label className="video-render-mode video-narrate-toggle" title={ttsReady ? `Synthesize each audio cue locally with ${ttsEngineLabel}` : ttsReason}><input type="checkbox" aria-label={`Narrate with ${ttsEngineLabel}`} data-testid="video-narrate-toggle" checked={narrate && ttsReady} disabled={!ttsReady || rendering} onChange={(event) => setNarrate(event.target.checked)} /> Narration ({ttsEngineLabel})</label><button className="video-primary-button" type="button" data-testid="video-render-button" onClick={() => void renderLinkZag()} disabled={rendering || (!storyboard && persistedSpecs.length === 0)}><Clapperboard size={14} /> {rendering ? 'Rendering…' : storyboard ? (ttsReady && narrate ? 'Render narrated MP4' : 'Render silent MP4') : `Render ${persistedSpecs.length || ''} saved slide${persistedSpecs.length === 1 ? '' : 's'} · MP4`}</button></div></div>
      <p className="video-footnote">Flash is the speed-first default and may drop frames on a slow CPU. Choose Full when you need deterministic frame-by-frame capture or Flash motion/text quality is not acceptable.</p>
      <section className="video-card" aria-labelledby="video-qa-heading" data-testid="qa-section">
        <div className="video-card-head"><div><p className="eyebrow">Step 5 · QA</p><h2 id="video-qa-heading">QA + visual review</h2></div><span className="video-chip">{qaReport ? `QA ${qaDecision ?? 'unknown'}` : verificationBlockers.length ? `${verificationBlockers.length} gate blocker${verificationBlockers.length === 1 ? '' : 's'}` : 'QA not run'}</span></div>
        <p>Thesis/backtest gates (computed in this workspace from re-verified evidence; codes match revamp §d.2):</p>
        {verification ? <>
          {verification.blockers.length ? verification.blockers.map((finding: VideoQaFinding) => <p className="video-claim-warning" role="alert" key={finding.code} data-testid={`qa-finding-${finding.code}`}><strong>{finding.code} (blocker):</strong> {finding.message}</p>) : <p className="video-footnote" role="status">No thesis/backtest gate blockers.</p>}
          {verification.advisories.map((finding: VideoQaFinding) => <p className="video-footnote" key={finding.code} data-testid={`qa-finding-${finding.code}`}><strong>{finding.code}:</strong> {finding.message}</p>)}
        </> : <p className="video-footnote">{isThesisEpisode ? 'Load the thesis above to run the thesis/backtest gates.' : 'Event explainer: no thesis gates apply. Deterministic QA below still applies once a timeline exists.'}</p>}
        <p>Deterministic QA (evaluator-produced, never authored here) runs against the ready timeline:</p>
        <div className="video-inline-actions">
          <button className="video-secondary-button" type="button" data-testid="qa-run-button" onClick={() => void runQa()} disabled={qaRunning || !timelineResult || timelineResult.status !== 'ready'}>{qaRunning ? 'Running QA…' : 'Run deterministic QA'}</button>
          {qaReport ? <span className="video-chip video-chip-strong">decision {qaDecision ?? 'unknown'} · execution {qaExecution ?? 'unknown'} · passed {qaCheckSummary.passed ?? '?'} · warnings {qaCheckSummary.warnings ?? '?'} · blockers {qaCheckSummary.blockers ?? '?'} · not run {qaCheckSummary.notRun ?? '?'}</span> : <span className="video-footnote">Build a ready timeline first.</span>}
        </div>
        {qaReport && Array.isArray(qaReport.findings) ? <div className="video-qa-findings">{(qaReport.findings as Array<{ code?: string; severity?: string; message?: string }>).map((finding, index) => <p key={`${finding.code ?? 'finding'}-${index}`} className={finding.severity === 'blocker' ? 'video-claim-warning' : 'video-footnote'} data-testid={`qa-evaluator-finding-${finding.code ?? index}`}><strong>{finding.code ?? 'finding'} ({finding.severity ?? 'unknown'}):</strong> {finding.message ?? ''}</p>)}</div> : null}
        <p>QA does not replace manual visual review — both are shown separately:</p>
        <p><strong>Native QA:</strong> {qaPassed ? 'passed' : qaReport ? `not passed (decision ${qaDecision ?? 'unknown'})` : 'not run'}</p>
        <label className="video-check"><input type="checkbox" data-testid="visual-review-checkbox" checked={visualReviewDone} onChange={(event) => setVisualReviewDone(event.target.checked)} /> Visual review done by a human — I watched the rendered MP4 and it is acceptable.</label>
      </section>
      <section className="video-card" aria-labelledby="video-timeline-heading" data-testid="timeline-section">
        <div className="video-card-head"><div><p className="eyebrow">Step 6 · timeline</p><h2 id="video-timeline-heading">Timeline (native EDL)</h2></div><span className="video-chip">{timelineResult ? timelineResult.status : 'not built'}</span></div>
        <p>Built from the exact project / episode / storyboard refs with <code>gap_policy: "block"</code> and a unique request id. A blocked build is never persisted as ready. Clips reference the rendered MP4 asset, so render before building the timeline.</p>
        <div className="video-inline-actions">
          <button className="video-secondary-button" type="button" data-testid="timeline-build-button" onClick={() => void buildTimeline()} disabled={timelineBuilding || !storyboard || !previewAsset}>{timelineBuilding ? 'Building…' : 'Build timeline'}</button>
          {timelineResult ? <span className="video-footnote" data-testid="timeline-result">timeline {timelineResult.timeline_ref?.id ?? 'unknown'} · hash {timelineResult.timeline_hash?.slice(0, 12) ?? 'unknown'} · {timelineResult.summary?.video_clips ?? 0} clips · {timelineResult.summary?.duration_ms ? `${Math.round(timelineResult.summary.duration_ms / 1000)}s` : 'duration unknown'}</span> : <span className="video-footnote">{!storyboard ? 'Build and save the storyboard in this session first.' : !previewAsset ? 'Render the storyboard first.' : ''}</span>}
        </div>
        {timelineResult?.findings.length ? timelineResult.findings.map((finding, index) => <p key={`${finding.code}-${index}`} className={finding.severity === 'blocker' ? 'video-claim-warning' : 'video-footnote'}><strong>{finding.code} ({finding.severity}):</strong> {finding.message}</p>) : null}
      </section>
      <section className="video-card" aria-labelledby="video-export-heading" data-testid="export-section">
        <div className="video-card-head"><div><p className="eyebrow">Step 6 · export</p><h2 id="video-export-heading">Export</h2></div><span className="video-chip">{exportManifest ? 'manifest read back' : preflight ? 'preflight done' : 'not exported'}</span></div>
        <p>Preflight is read-only; export starts only when preflight authorizes it, against the exact timeline and evaluator QA refs and the installed preview profile.</p>
        <div className="video-inline-actions">
          <button className="video-secondary-button" type="button" data-testid="export-profiles-button" onClick={() => void loadExportProfiles()} disabled={exportBusy}>Discover export profiles</button>
          {exportProfiles.length ? <label className="video-episode-select">Export profile<select aria-label="Export profile" data-testid="export-profile-select" value={exportProfileId} onChange={(event) => setExportProfileId(event.target.value)}>{exportProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.id}</option>)}</select></label> : null}
          <button className="video-secondary-button" type="button" data-testid="export-preflight-button" onClick={() => void runExportPreflight()} disabled={exportBusy || !timelineResult || !qaReportId || !exportProfileId}>{exportBusy ? 'Working…' : 'Run preflight'}</button>
          <button className="video-primary-button" type="button" data-testid="export-start-button" onClick={() => void startExport()} disabled={exportBusy || !timelineResult || !qaReportId || !exportProfileId || !preflight}>{exportBusy ? 'Exporting…' : 'Start export'}</button>
        </div>
        {preflight ? <details className="video-storyboard-json"><summary>Preflight result</summary><pre>{JSON.stringify(preflight, null, 2)}</pre></details> : null}
        {exportManifest ? <details className="video-storyboard-json" open><summary>Export manifest (read back)</summary><pre data-testid="export-manifest">{JSON.stringify(exportManifest, null, 2)}</pre></details> : null}
      </section>
      <section className="video-card" aria-labelledby="video-publish-heading" data-testid="publish-section">
        <div className="video-card-head"><div><p className="eyebrow">Step 7 · publish</p><h2 id="video-publish-heading">Publish — human approval only</h2></div><span className="video-chip video-chip-strong">{isThesisEpisode ? 'Thesis video' : 'Event explainer · internal_review_only'}</span></div>
        {isThesisEpisode
          ? <p>A thesis video publishes only when: thesis basis is <code>llm_verified_only</code>, QA passed with zero blockers, visual review marked done by a human, export manifest exists, and the backtest delta is shown — or its absence is explicitly recorded and acknowledged. No auto-publish, ever.</p>
          : <p>An event explainer has no thesis, no backtest, and no thesis gate. It publishes only as <code>internal_review_only</code> / explainer — never as a thesis video.</p>}
        {publishBlockers.length ? <ul className="video-publish-blockers" data-testid="publish-blockers">{publishBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : <p className="video-footnote" role="status" data-testid="publish-blockers">All publish conditions are met.</p>}
        <label className="video-check"><input type="checkbox" data-testid="publish-approval-checkbox" checked={publishApproval} onChange={(event) => setPublishApproval(event.target.checked)} /> I am a human approving this publication, and I have reviewed the thesis, evidence, backtest, QA, and rendered video.</label>
        <div className="video-inline-actions">
          <button className="video-primary-button" type="button" data-testid="publish-button" onClick={() => void publish()} disabled={!canPublish || publishing}>{publishing ? 'Publishing…' : isThesisEpisode ? 'Publish thesis video' : 'Publish as internal review only'}</button>
        </div>
        {publishReceipt ? <p className="video-footnote" role="status" data-testid="publish-receipt">Published {publishReceipt.type} at {publishReceipt.approvedAt} · thesis {publishReceipt.thesisId ?? 'none'} · transcript {publishReceipt.transcriptHash ?? 'none'} · storyboard {publishReceipt.storyboardId ?? 'none'} · QA {publishReceipt.qaReportId ?? 'none'} · export {publishReceipt.exportManifestId ?? 'none'} · backtests {publishReceipt.backtestIds.join(', ') || 'none'}</p> : null}
      </section>
      <section className="video-preview-panel" data-testid="video-final-preview" aria-label="Final rendered video">
        <div className="video-card-head"><div><p className="eyebrow">Final video</p><h2>Rendered MP4</h2></div>{previewAsset ? <span className="video-chip video-chip-strong">{previewAsset.capability_state.replaceAll('_', ' ')}</span> : null}</div>
        {previewAsset ? <>
          <div className="video-preview-stage">
            {previewUrl ? <video ref={previewRef} className="video-preview-player" data-testid="video-preview-player" src={previewUrl} controls playsInline preload="metadata" /> : previewError ? <div className="video-preview-fallback is-error" role="alert"><VideoIcon size={22} /><strong>Inline preview unavailable</strong><p>{previewError}</p></div> : <div className="video-preview-fallback" role="status"><RefreshCw size={18} className="animate-spin" /><span>Resolving rendered MP4…</span></div>}
          </div>
          <div className="video-preview-meta" data-testid="video-preview-meta">
            <span><strong>{previewAsset.asset_id}</strong> · v{previewAsset.revision}</span>
            <span>{formatDuration(previewAsset.duration_ms)} · {previewAsset.width && previewAsset.height ? `${previewAsset.width}×${previewAsset.height}` : 'resolution unknown'}</span>
            <span>hash {previewAsset.content_hash?.slice(0, 12) ?? 'not recorded'}</span>
          </div>
          <div className="video-preview-actions">
            {previewUrl ? <button type="button" className="video-primary-button" onClick={() => { const player = previewRef.current; if (!player) return; player.currentTime = 0; void player.play().catch(() => undefined) }}><VideoIcon size={14} /> Play</button> : null}
            {previewUrl ? <a className="video-secondary-button" href={previewUrl} download={`${previewAsset.asset_id}.mp4`}><Download size={14} /> Save MP4</a> : null}
            <span className="video-footnote">{previewAsset.mime_type ?? 'video/mp4'} · {previewAsset.provider} · {previewAsset.reproducibility.replaceAll('_', ' ')}</span>
          </div>
        </> : <div className="video-preview-empty"><VideoIcon size={22} /><p>No rendered MP4 for this episode yet. Render the saved slides and the result appears here — playable, with its hash and stored lineage.</p></div>}
      </section>
      <div className="video-asset-summary"><span>{projectAssets.length} project asset{projectAssets.length === 1 ? '' : 's'} linked to saved slides</span><span>{workflows.length} workflow{workflows.length === 1 ? '' : 's'} registered</span><span>Flash default · Full quality fallback · source lineage retained</span></div>
      {projectAssets.length ? <div className="video-asset-list">{projectAssets.slice(0, 5).map((asset) => <div className={`video-asset-row${previewAsset?.asset_id === asset.asset_id ? ' is-active' : ''}`} data-testid="video-asset-row" data-asset-hash={asset.content_hash ?? ''} data-asset-path={asset.relative_path ?? ''} key={`${asset.asset_id}-${asset.revision}`}><Film size={14} /><span className="min-w-0 flex-1"><strong>{asset.asset_id}</strong><small>{asset.asset_kind} · {asset.provider} · {asset.mime_type ?? 'unknown format'} · {formatDuration(asset.duration_ms)} · {asset.content_hash?.slice(0, 12) ?? 'no hash'}</small></span>{asset.relative_path ? <button type="button" className="video-secondary-button" onClick={() => setPreviewAsset(asset)} aria-label={`Preview asset ${asset.asset_id}`}>{previewAsset?.asset_id === asset.asset_id ? 'Previewing' : 'Preview'}</button> : <span className="video-chip">{asset.capability_state}</span>}</div>)}</div> : null}
      <p className="video-footnote">All saved slides render in order and assemble into one MP4. {ttsReady && narrate ? 'Narration is synthesized locally per scene and fitted to each slide; the output manifest records the TTS workflow and audio timeline.' : 'This render is silent; the output manifest records capture mode and determinism.'}</p>
    </section> : episodesLoading ? <section className="video-card video-empty" role="status"><RefreshCw size={24} className="animate-spin" /><h2>Loading saved episodes…</h2><p>Checking this project for existing episode revisions and saved slides before offering a new episode.</p></section> : activeEpisodeId || episodeId ? <section className="video-card video-empty" role={hydrationFailed ? 'alert' : 'status'}><Clapperboard size={24} /><h2>{hydrating ? 'Loading persisted episode…' : 'Episode could not be loaded'}</h2><p>{hydrating ? 'Validating this episode and its retained evidence for the selected project.' : 'The persisted episode was not opened. Check the workspace message and reopen the episode; no replacement episode was created.'}</p></section> : <section className="video-card video-empty"><Clapperboard size={24} /><h2>Create the first episode revision</h2><p>This project has no saved episodes. This creates production metadata only; then link a retained event transcript before drafting candidate narration.</p><button className="video-primary-button" type="button" onClick={() => void createEpisode()} disabled={saving}>{saving ? 'Creating…' : 'Create episode'}</button></section>}
    <p className="video-status" role="status">{project.title} · source truth stays in NIP</p>
  </div>
}

function Capability({ label, state }: { label: string; state?: string }) {
  return <div className="video-capability"><span>{label}</span><strong>{state?.replaceAll('_', ' ') ?? 'unknown'}</strong></div>
}
