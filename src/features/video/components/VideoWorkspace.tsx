import { Clapperboard, FileCheck2, Film, Plus, RefreshCw, ShieldCheck, Sparkles, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { videoApi } from '../api'
import { narrativeApi } from '../../narrative/api'
import { claimsForEvent, type VideoClaimOption } from '../claim-selection'
import { buildSelectedClaimsStoryboard } from '../storyboard'
import type { NipEvent } from '../../narrative/types'
import type {
  VideoAsset,
  VideoCapabilities,
  VideoEpisode,
  VideoEvidenceRef,
  VideoJob,
  VideoProject,
  VideoSourceEvent,
  VideoStoryboardDocument,
  VideoWorkflow,
} from '../types'
import type { VideoView } from '../../workspace/navigation'
import './video.css'

const id = (prefix: string) => `${prefix}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 14)}`
const now = () => new Date().toISOString()
const evidenceKey = (ref: VideoEvidenceRef) => JSON.stringify([ref.evidence_kind, ref.evidence_id, ref.start_offset, ref.end_offset, ref.quote])
const blankProject = (): VideoProject => ({ project_id: id('project'), revision: 1, title: '', language: 'en', target_platform: 'youtube', target_duration_ms: 90_000, audience: '', style_profile: 'evidence_first', status: 'draft', created_at: now(), updated_at: now() })

export function VideoWorkspace({ view, projectId, episodeId, claimId, onNavigate }: { view: VideoView; projectId?: string; episodeId?: string; claimId?: string; onNavigate: (view: VideoView, projectId?: string) => void }) {
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
    return <EpisodeWorkspace key={`${selected.project_id}:${episodeId ?? 'new'}`} project={selected} capabilities={capabilities} episodeId={episodeId} claimId={claimId} onBack={() => onNavigate('projects')} onMessage={setMessage} />
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

function EpisodeWorkspace({ project, capabilities, episodeId, claimId, onBack, onMessage }: { project: VideoProject; capabilities: VideoCapabilities | null; episodeId?: string; claimId?: string; onBack: () => void; onMessage: (message: string | null) => void }) {
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
  const [assets, setAssets] = useState<VideoAsset[]>([])
  const [workflows, setWorkflows] = useState<VideoWorkflow[]>([])
  const [rendering, setRendering] = useState(false)
  const [captureMode, setCaptureMode] = useState<'flash' | 'full'>('flash')
  const [activeJob, setActiveJob] = useState<VideoJob | null>(null)
  const [jobNotice, setJobNotice] = useState<string | null>(null)

  useEffect(() => {
    void Promise.all([videoApi.listAssets(), videoApi.listWorkflows()]).then(([nextAssets, nextWorkflows]) => {
      setAssets(nextAssets)
      setWorkflows(nextWorkflows)
    }).catch(() => undefined)
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
    const created: VideoEpisode = { episode_id: id('episode'), project_id: project.project_id, revision: 1, title: `${project.title} · Episode 1`, as_of: timestamp, disclosure: 'Candidate planning output; source evidence remains authoritative.', status: 'draft', created_at: timestamp, updated_at: timestamp }
    try { await videoApi.createEpisode(created); setEpisode(created); onMessage('Episode created. Link a retained event, then explicitly select its eligible claims to build the storyboard.') } catch (error) { onMessage(error instanceof Error ? error.message : 'Episode creation failed.') } finally { setSaving(false) }
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
    if (!episodeId) return
    let cancelled = false
    const hydrate = async () => {
      try {
        const persistedEpisode = await videoApi.getEpisode(episodeId)
        if (persistedEpisode.project_id !== project.project_id) {
          throw new Error('The requested episode does not belong to the selected project.')
        }
        const persistedEvidence = await videoApi.listEvidence(persistedEpisode.episode_id, persistedEpisode.revision)
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
  }, [episodeId, project.project_id, claimId, refreshClaims, onMessage])

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
      await videoApi.saveNarrative(draft.narrative)
      await videoApi.saveStoryboard(draft.storyboard)
      await Promise.all(draft.scenes.map((scene) => videoApi.saveScene(scene)))
      await Promise.all(draft.shots.map((shot) => videoApi.saveShot(shot)))
      await Promise.all(draft.visualSpecs.map((spec) => videoApi.saveVisualSpec(spec)))
      setStoryboard(draft.document)
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
      const completedMode = current.output_manifest.capture_mode ?? current.resource_estimate?.capture_mode ?? captureMode
      const modeLabel = completedMode === 'full' ? 'Full deterministic' : 'Flash real-time preview'
      setAssets((items) => [asset, ...items.filter((item) => item.asset_id !== asset.asset_id)])
      setJobNotice(`Silent commentary MP4 ready · ${asset.asset_id} · ${modeLabel}`)
      onMessage(`Silent commentary MP4 ready · ${asset.asset_id} · ${modeLabel}`)
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
    if (!visualSpecs?.length) { onMessage('Build and save the slides storyboard before rendering.'); return }
    setRendering(true)
    setJobNotice(null)
    try {
      const result = await videoApi.renderLinkZag(visualSpecs, captureMode)
      onMessage(`Video job ${result.job_id} queued for all ${visualSpecs.length} saved slides in ${captureMode} mode.`)
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

  const storyboardJson = storyboard ? JSON.stringify(storyboard, null, 2) : ''
  const downloadHref = storyboard ? `data:application/json;charset=utf-8,${encodeURIComponent(storyboardJson)}` : undefined
  const jobLineage = activeJob?.output_manifest?.lineage ?? []
  const normalizedClaimFilter = claimFilter.trim().toLocaleLowerCase()
  const filteredClaimOptions = claimOptions.filter(({ claim }) => [claim.claim_text, claim.speaker_or_author, claim.provider, claim.model, claim.claim_id].some((value) => value?.toLocaleLowerCase().includes(normalizedClaimFilter)))

  return <div className="video-page" data-testid="video-episode-workspace">
    <header className="video-hero"><div><button type="button" className="video-back" onClick={onBack}>← Projects</button><p className="eyebrow">Project v{project.revision} · {project.status}</p><h1>{project.title}</h1><p>Episode → narrative → slides → scenes, shots, and audio cues. Source text remains in NIP.</p></div><span className="video-chip video-chip-strong">{capabilities?.planning ?? 'planning'}</span></header>
    <section className="video-capability-grid"><Capability label="Planning" state={capabilities?.planning} /><Capability label="Evidence linkage" state={capabilities?.evidence_linkage} /><Capability label="Capture modes" state="Flash default · Full available" /><Capability label="TTS / narration audio" state={capabilities?.tts} /></section>
    {jobNotice ? <section className={`video-job-banner ${activeJob?.status === 'succeeded' ? 'is-success' : activeJob?.status === 'failed' || activeJob?.status === 'cancelled' ? 'is-error' : 'is-info'}`} role={activeJob?.status === 'failed' ? 'alert' : 'status'}><div><strong>Video job {activeJob?.status ?? 'notice'}</strong><p>{jobNotice}</p>{activeJob ? <small>{activeJob.job_id} · {Math.round(activeJob.progress_millis / 1000)}% · {activeJob.cancellation_requested ? 'cancellation requested' : 'durable state persisted'}</small> : null}</div><div className="video-job-actions">{activeJob && !['succeeded', 'failed', 'cancelled'].includes(activeJob.status) ? <button type="button" className="video-secondary-button" onClick={() => void cancelActiveJob()}>Cancel</button> : null}{activeJob && ['failed', 'cancelled'].includes(activeJob.status) ? <button type="button" className="video-primary-button" onClick={() => void retryActiveJob()} disabled={rendering}>Retry job</button> : null}<button type="button" className="video-secondary-button" onClick={() => setJobNotice(null)}>Dismiss</button></div></section> : null}
    {activeJob?.status === 'succeeded' && jobLineage.length ? <p className="video-footnote" data-testid="video-job-lineage">Final asset retains {jobLineage.length} upstream links: {jobLineage.filter((item) => item.upstream_kind === 'visual_spec').length} saved slide specs and {jobLineage.filter((item) => item.upstream_kind === 'event' || item.upstream_kind === 'claim').length} canonical event/claim sources.</p> : null}
    {episode ? <section className="video-card">
      <div className="video-card-head"><div><p className="eyebrow">Episode v{episode.revision}</p><h2>{episode.title}</h2></div><span className="video-chip">{episode.status}</span></div>
      <div className="video-evidence-panel"><div><strong>Retained transcript source</strong><p>Search for an immutable NIP event, select the matching source, then explicitly load and link it. Raw transcript text is not copied into the Video projection.</p></div><form onSubmit={addEvidence} className="video-inline-form video-event-form"><div className="video-event-picker"><label htmlFor="video-event-search">Search retained events</label><input id="video-event-search" role="combobox" aria-autocomplete="list" aria-expanded={eventSearchOpen && !selectedSearchEvent} aria-controls="video-event-options" aria-activedescendant={eventSearchOpen && eventResults[activeEventIndex] ? `video-event-option-${activeEventIndex}` : undefined} aria-label="Search retained events" placeholder="Search transcript text or source ID…" value={eventQuery} disabled={loadingSource} onFocus={() => { if (eventResults.length || eventSearchLoading || eventSearchError) setEventSearchOpen(true) }} onKeyDown={handleEventSearchKeyDown} onChange={(event) => { eventSearchRequest.current += 1; setEventResults([]); setEventSearchLoading(Boolean(event.target.value.trim())); setEventSearchError(null); setActiveEventIndex(0); setEventQuery(event.target.value); setEventId(''); setSelectedSearchEvent(null); setEventSearchOpen(true) }} />{eventSearchOpen && !selectedSearchEvent ? <div className="video-event-options" id="video-event-options" role="listbox" aria-label="Retained event search results" aria-busy={eventSearchLoading}>{eventSearchLoading ? <p className="video-event-state" role="status">Searching retained events…</p> : eventSearchError ? <p className="video-event-state is-error" role="alert">{eventSearchError}</p> : eventResults.length ? eventResults.map((result, index) => <div id={`video-event-option-${index}`} className={`video-event-option${activeEventIndex === index ? ' is-active' : ''}`} key={result.event_id} role="option" aria-selected={activeEventIndex === index} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActiveEventIndex(index)} onClick={() => selectSearchEvent(result)}><strong>{result.source_id} · {result.source_native_id || 'native ID unavailable'}</strong><code>{result.event_id}</code><span>{result.content_text?.trim() || 'No transcript preview available.'}</span></div>) : <p className="video-event-state">No retained events match “{eventQuery.trim()}”.</p>}</div> : null}{selectedSearchEvent ? <p className="video-selected-event" role="status">Selected: {selectedSearchEvent.source_id} · {selectedSearchEvent.source_native_id || 'native ID unavailable'} · {selectedSearchEvent.event_id}</p> : <p className="video-event-hint">Search retained transcript text or source IDs to choose an event.</p>}</div><button className="video-secondary-button" type="submit" disabled={loadingSource || !selectedSearchEvent || !eventId}>{loadingSource ? 'Loading…' : 'Load and link event'}</button></form>
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
      <div className="video-card-head video-storyboard-head"><div><p className="eyebrow">Storyboard</p><h2>Selected-claim slides.json</h2></div><div className="video-inline-actions"><button className="video-primary-button" type="button" onClick={() => void saveStoryboard()} disabled={saving || loadingSource || claimsLoading || !sourceEvent || selectedClaimIds.length === 0}><Sparkles size={14} /> {saving ? 'Saving…' : `Build from selected claims (${selectedClaimIds.length})`}</button>{storyboard && downloadHref ? <a className="video-secondary-button" href={downloadHref} download={`${storyboard.storyboard_id}.slides.json`}>Download slides.json</a> : null}</div></div>
      {storyboard ? <><div className="video-scene-grid">{storyboard.slides.map((slide, index) => <article className="video-scene-card" key={slide.slide_id} data-testid={`storyboard-slide-${index + 1}`}><span>0{index + 1}</span><strong>{slide.purpose}</strong><p>{slide.scene.narration_text}</p><small>{Math.round((slide.scene.duration_ms ?? 0) / 1000)}s · {slide.shots.length} shot · audio cue {slide.audio_cue.status}</small></article>)}</div><details className="video-storyboard-json"><summary>Inspect slides.json · scenes, shots, audio cues, and evidence</summary><pre data-testid="storyboard-json">{storyboardJson}</pre></details></> : <p className="video-footnote">{sourceEvent ? 'Select one or more eligible claims above to build the storyboard. No event-only placeholder beats are added.' : 'Load a retained event, review its stored claims, and explicitly select which claims should appear in the storyboard.'}</p>}
      <p className="video-footnote">Audio cue scripts are in the storyboard, but TTS is {capabilities?.tts?.replaceAll('_', ' ') ?? 'not configured'}; the current LinkZag MP4 is silent.</p>
      <div className="video-card-head video-storyboard-head"><div><p className="eyebrow">LinkZag renderer</p><h2>Commentary video capture</h2></div><div className="video-render-controls"><label className="video-render-mode">Capture mode<select aria-label="Capture mode" data-testid="video-capture-mode" value={captureMode} onChange={(event) => setCaptureMode(event.target.value as 'flash' | 'full')} disabled={rendering}><option value="flash">Flash · real-time preview (Canvas)</option><option value="full">Full · deterministic screenshots (SVG)</option></select></label><button className="video-secondary-button" type="button" onClick={() => void renderLinkZag()} disabled={rendering || !storyboard}><Clapperboard size={14} /> {rendering ? 'Rendering…' : 'Render slides · silent MP4'}</button></div></div>
      <p className="video-footnote">Flash is the speed-first default and may drop frames on a slow CPU. Choose Full when you need deterministic frame-by-frame capture or Flash motion/text quality is not acceptable.</p>
      <div className="video-asset-summary"><span>{assets.length} reusable asset{assets.length === 1 ? '' : 's'}</span><span>{workflows.length} workflow{workflows.length === 1 ? '' : 's'} registered</span><span>Flash default · Full quality fallback · source lineage retained</span></div>
      {assets.length ? <div className="video-asset-list">{assets.slice(0, 5).map((asset) => <div className="video-asset-row" data-testid="video-asset-row" data-asset-hash={asset.content_hash ?? ''} data-asset-path={asset.relative_path ?? ''} key={`${asset.asset_id}-${asset.revision}`}><Film size={14} /><span className="min-w-0 flex-1"><strong>{asset.asset_id}</strong><small>{asset.asset_kind} · {asset.provider} · {asset.mime_type ?? 'unknown format'} · {asset.content_hash?.slice(0, 12) ?? 'no hash'}</small></span><span className="video-chip">{asset.capability_state}</span></div>)}</div> : null}
      <p className="video-footnote">All saved slides render in order and assemble into one silent MP4. TTS is not configured, so this is not a publish-ready narrated episode; the output manifest records capture mode and determinism.</p>
    </section> : episodeId ? <section className="video-card video-empty" role={hydrationFailed ? 'alert' : 'status'}><Clapperboard size={24} /><h2>{hydrating ? 'Loading persisted episode…' : 'Episode could not be loaded'}</h2><p>{hydrating ? 'Validating this episode and its retained evidence for the selected project.' : 'The persisted episode was not opened. Check the workspace message and reopen the episode; no replacement episode was created.'}</p></section> : <section className="video-card video-empty"><Clapperboard size={24} /><h2>Create the first episode revision</h2><p>This creates production metadata only. Then link a retained event transcript before drafting candidate narration.</p><button className="video-primary-button" type="button" onClick={() => void createEpisode()} disabled={saving}>{saving ? 'Creating…' : 'Create episode'}</button></section>}
    <p className="video-status" role="status">{project.title} · source truth stays in NIP</p>
  </div>
}

function Capability({ label, state }: { label: string; state?: string }) {
  return <div className="video-capability"><span>{label}</span><strong>{state?.replaceAll('_', ' ') ?? 'unknown'}</strong></div>
}
