import { useEffect, useMemo, useRef, useState } from 'react'
import { Clapperboard, RefreshCw } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { videoApi } from '../../video/api'
import { claimsForEvent } from '../../video/claim-selection'
import type { NipClaim, NipClaimEvidence } from '../types'
import type { VideoEpisode, VideoEvidenceRef, VideoProject, VideoSourceEvent } from '../../video/types'

const id = (prefix: string) => `${prefix}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 14)}`
const now = () => new Date().toISOString()
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)

interface EventCandidate {
  eventId: string
  event: VideoSourceEvent | null
  evidence: NipClaimEvidence[]
  rejectedEvidenceCount: number
  error: string | null
}

export function CreateVideoEpisodeDialog({ claim, onClose, onOpenVideoEpisode }: { claim: NipClaim; onClose: () => void; onOpenVideoEpisode?: (projectId: string, episodeId: string, claimId: string) => void }) {
  const [projects, setProjects] = useState<VideoProject[]>([])
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<EventCandidate[]>([])
  const [eventsLoading, setEventsLoading] = useState(true)
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [projectChoice, setProjectChoice] = useState('new')
  const [projectTitle, setProjectTitle] = useState(`Claim: ${claim.claim_text.slice(0, 64)}`)
  const [selectedEventId, setSelectedEventId] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [messageIsError, setMessageIsError] = useState(false)
  const firstFocus = useRef<HTMLSelectElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const busyRef = useRef(busy)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    busyRef.current = busy
    onCloseRef.current = onClose
  }, [busy, onClose])

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    firstFocus.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) { onCloseRef.current(); return }
      if (event.key !== 'Tab') return
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
      if (!focusable?.length) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus()
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void videoApi.listProjects().then((result) => {
      if (cancelled) return
      setProjects(result)
    }).catch((reason: unknown) => {
      if (!cancelled) setProjectsError(`Existing projects could not be loaded: ${errorText(reason)}`)
    }).finally(() => { if (!cancelled) setProjectsLoading(false) })

    const eventIds = [...new Set(claim.evidence.map((item) => item.event_id))]
    void Promise.all(eventIds.map(async (eventId): Promise<EventCandidate> => {
      try {
        const event = await videoApi.getEvent(eventId)
        const option = claimsForEvent(event, [claim])[0]
        return { eventId, event, evidence: option?.evidence ?? [], rejectedEvidenceCount: option?.rejectedEvidenceCount ?? 0, error: null }
      } catch (reason) {
        return { eventId, event: null, evidence: [], rejectedEvidenceCount: claim.evidence.filter((item) => item.event_id === eventId).length, error: errorText(reason) }
      }
    })).then((result) => {
      if (cancelled) return
      setCandidates(result)
      setSelectedEventId(result.find((candidate) => candidate.evidence.length > 0)?.eventId ?? '')
    }).finally(() => { if (!cancelled) setEventsLoading(false) })
    return () => { cancelled = true }
  }, [claim])

  const eligibleCandidates = useMemo(() => candidates.filter((candidate) => candidate.event && candidate.evidence.length > 0), [candidates])
  const canCreate = !busy && !eventsLoading && !projectsLoading && Boolean(selectedEventId) && (projectChoice !== 'new' || Boolean(projectTitle.trim()))

  const create = async () => {
    const candidate = eligibleCandidates.find((item) => item.eventId === selectedEventId)
    if (!candidate?.event || !candidate.evidence.length) {
      setMessageIsError(true)
      setMessage('Choose a source event with at least one exact matching transcript quote/span. No project or episode was created.')
      return
    }
    setBusy(true)
    setMessage(null)
    setMessageIsError(false)
    let createdProjectId: string | null = null
    let episodePersisted = false
    let episode: VideoEpisode | null = null
    try {
      let project = projects.find((item) => item.project_id === projectChoice)
      if (projectChoice === 'new') {
        if (!projectTitle.trim()) throw new Error('Enter a title for the new Video project.')
        const timestamp = now()
        project = await videoApi.createProject({
          project_id: id('project'), revision: 1, title: projectTitle.trim(), language: 'en', target_platform: 'youtube',
          target_duration_ms: 90_000, audience: null, style_profile: 'evidence_first', status: 'draft', created_at: timestamp, updated_at: timestamp,
        })
        createdProjectId = project.project_id
      }
      if (!project) throw new Error('Select a Video project or create a new one.')

      const timestamp = now()
      episode = {
        episode_id: id('episode'), project_id: project.project_id, revision: 1,
        title: `${project.title} · ${claim.claim_text.slice(0, 72)}`, as_of: timestamp,
        disclosure: 'Draft seeded from one verified claim span; source evidence remains authoritative.',
        status: 'draft', created_at: timestamp, updated_at: timestamp,
      }
      episode = await videoApi.createEpisode(episode)
      episodePersisted = true

      const refs: VideoEvidenceRef[] = [
        { evidence_kind: 'event', evidence_id: candidate.event.event_id, start_offset: null, end_offset: null, quote: null },
        ...candidate.evidence.map((evidence) => ({
          evidence_kind: 'claim', evidence_id: claim.claim_id, start_offset: evidence.start_offset,
          end_offset: evidence.end_offset, quote: evidence.quote,
        })),
      ]
      for (let index = 0; index < refs.length; index += 1) {
        try {
          await videoApi.linkEvidence(episode.episode_id, episode.revision, refs[index]!)
        } catch (reason) {
          throw new Error(`Episode ${episode.episode_id} was created, but evidence link ${index + 1} of ${refs.length} failed: ${errorText(reason)}. The draft remains in the selected project; open it in Video Workspace to review and finish linking evidence.`)
        }
      }
      setMessageIsError(false)
      setMessage(`Draft episode ${episode.episode_id} created with the immutable source event and ${candidate.evidence.length} verified claim span${candidate.evidence.length === 1 ? '' : 's'}.`)
      onOpenVideoEpisode?.(project.project_id, episode.episode_id, claim.claim_id)
    } catch (reason) {
      setMessageIsError(true)
      const partialProject = createdProjectId && !episodePersisted ? `Project ${createdProjectId} was created, but the episode could not be completed. ` : ''
      setMessage(`${partialProject}${errorText(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  const activeCandidate = eligibleCandidates.find((candidate) => candidate.eventId === selectedEventId)
  return (
    <div className="narrative-dialog-backdrop" data-testid="create-video-episode-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section ref={dialogRef} className="narrative-dialog" role="dialog" aria-modal="true" aria-labelledby="create-video-episode-title" aria-describedby="create-video-episode-description" onMouseDown={(event) => event.stopPropagation()}>
        <header className="narrative-dialog-head">
          <div className="min-w-0"><p className="eyebrow">Claim Explorer · quick create</p><h2 id="create-video-episode-title" className="mt-1 text-sm font-semibold text-main">Create video episode</h2><p id="create-video-episode-description" className="mt-1 text-[10px] text-muted">Start a draft from this claim and one exact transcript span. The transcript is not copied into the Video project.</p></div>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>Close</Button>
        </header>
        <div className="space-y-4 p-4">
          <div className="evidence-card"><p className="eyebrow">Selected claim</p><p className="mt-1 text-xs text-main">{claim.claim_text}</p><code className="mt-2 block break-all text-[9px] text-muted">{claim.claim_id}</code></div>
          <div className="space-y-2">
            <label className="block text-[11px] font-semibold text-main" htmlFor="quick-create-project">Video project</label>
            <select ref={firstFocus} id="quick-create-project" className="w-full" value={projectChoice} onChange={(event) => setProjectChoice(event.target.value)} disabled={busy || projectsLoading}>
              <option value="new">Create a new project…</option>
              {projects.map((project) => <option key={project.project_id} value={project.project_id}>{project.title} · {project.status}</option>)}
            </select>
            {projectChoice === 'new' ? <label className="block text-[10px] text-muted">New project title<input className="mt-1 w-full" value={projectTitle} onChange={(event) => setProjectTitle(event.target.value)} maxLength={120} disabled={busy} /></label> : null}
            {projectsLoading ? <p className="text-[10px] text-muted" role="status"><RefreshCw size={12} className="inline animate-spin" /> Loading projects…</p> : null}
            {projectsError ? <p className="text-[10px] text-amber-700" role="status">{projectsError} You can still create a new project.</p> : null}
          </div>
          <fieldset className="space-y-2">
            <legend className="text-[11px] font-semibold text-main">Source event with an exact claim span</legend>
            {eventsLoading ? <p className="text-[10px] text-muted" role="status"><RefreshCw size={12} className="inline animate-spin" /> Checking retained transcript spans…</p> : null}
            {!eventsLoading && candidates.length === 0 ? <p className="text-[10px] text-amber-700" role="status">This claim has no source-event citations to check.</p> : null}
            {!eventsLoading ? candidates.map((candidate) => {
              const eligible = Boolean(candidate.event && candidate.evidence.length)
              const nativeId = candidate.event?.source_native_id || candidate.eventId
              const preview = candidate.event?.content_text?.replace(/\s+/g, ' ').slice(0, 180)
              return <label key={candidate.eventId} className={`block rounded border p-2 text-[10px] ${eligible ? 'cursor-pointer' : 'opacity-75'}`}>
                <span className="flex items-start gap-2"><input type="radio" name="quick-create-source-event" value={candidate.eventId} checked={selectedEventId === candidate.eventId} onChange={() => setSelectedEventId(candidate.eventId)} disabled={!eligible || busy} /><span className="min-w-0"><strong className="text-main">{nativeId}</strong><span className="ml-2 narrative-chip">{candidate.event?.source_id ?? 'unavailable'}</span><code className="mt-1 block break-all text-[9px] text-muted">{candidate.eventId}</code>
                {candidate.error ? <span className="mt-1 block text-amber-700">Source event could not be loaded: {candidate.error}</span> : eligible ? <><span className="mt-1 block text-muted">{preview || 'No transcript text available.'}</span><span className="mt-1 block text-emerald-700">{candidate.evidence.length} exact matching span{candidate.evidence.length === 1 ? '' : 's'} verified</span></> : <span className="mt-1 block text-amber-700">No exact transcript span: {candidate.rejectedEvidenceCount ? 'the saved quote does not match the transcript at its stored offsets, or the quote/offset is missing or invalid.' : 'no evidence citation points to this event.'} Episode creation is disabled for this source.</span>}
                </span></span>
              </label>
            }) : null}
            {!eventsLoading && candidates.length > 0 && !eligibleCandidates.length ? <p className="text-[10px] text-amber-700" role="alert">No source event has a claim quote that exactly matches the retained transcript at its stored span. No project or episode can be created from this claim.</p> : null}
          </fieldset>
          {activeCandidate ? <div className="space-y-1 text-[10px] text-muted" role="status"><p>Will link event <code>{activeCandidate.eventId}</code> and claim <code>{claim.claim_id}</code> using these stored exact spans:</p>{activeCandidate.evidence.map((evidence, index) => <blockquote className="rounded border-l-2 border-primary pl-2" key={`${evidence.start_offset}-${evidence.end_offset}-${index}`}>“{evidence.quote}” <code>({evidence.start_offset}–{evidence.end_offset})</code></blockquote>)}</div> : null}
          {message ? <p className={`text-[10px] ${messageIsError ? 'text-red-700' : 'text-emerald-700'}`} role={messageIsError ? 'alert' : 'status'}>{message}</p> : null}
          <footer className="flex flex-wrap justify-end gap-2 border-t border-line pt-3">
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button type="button" disabled={!canCreate} onClick={() => void create()}><Clapperboard size={13} />{busy ? 'Creating draft…' : 'Create video episode'}</Button>
          </footer>
        </div>
      </section>
    </div>
  )
}
