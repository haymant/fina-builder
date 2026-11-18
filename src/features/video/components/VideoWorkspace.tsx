import { Clapperboard, FileCheck2, Film, Plus, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { videoApi } from '../api'
import type { VideoAsset, VideoCapabilities, VideoEpisode, VideoEvidenceRef, VideoJob, VideoProject, VideoScene, VideoShot, VideoStoryboard, VideoWorkflow } from '../types'
import type { VideoView } from '../../workspace/navigation'
import './video.css'

const id = (prefix: string) => `${prefix}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 14)}`
const now = () => new Date().toISOString()
const blankProject = (): VideoProject => ({ project_id: id('project'), revision: 1, title: '', language: 'en', target_platform: 'youtube', target_duration_ms: 90_000, audience: '', style_profile: 'evidence_first', status: 'draft', created_at: now(), updated_at: now() })

export function VideoWorkspace({ view, projectId, onNavigate }: { view: VideoView; projectId?: string; onNavigate: (view: VideoView, projectId?: string) => void }) {
  const [projects, setProjects] = useState<VideoProject[]>([])
  const [capabilities, setCapabilities] = useState<VideoCapabilities | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [selected, setSelected] = useState<VideoProject | null>(null)

  const load = async () => {
    setLoading(true)
    try {
      const [items, caps] = await Promise.all([videoApi.listProjects(), videoApi.capabilities()])
      setProjects(items)
      setCapabilities(caps)
      const next = projectId ? items.find((item) => item.project_id === projectId) : null
      setSelected(next ?? null)
      setMessage(null)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Video service is unavailable.')
    } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [projectId])

  if (view === 'workspace' && selected) {
    return <EpisodeWorkspace project={selected} capabilities={capabilities} onBack={() => onNavigate('projects')} onMessage={setMessage} />
  }
  return <ProjectList projects={projects} loading={loading} message={message} onRefresh={() => void load()} onOpen={(project) => onNavigate('workspace', project.project_id)} onCreated={(project) => { setProjects((items) => [project, ...items]); onNavigate('workspace', project.project_id) }} />
}

function ProjectList({ projects, loading, message, onRefresh, onOpen, onCreated }: { projects: VideoProject[]; loading: boolean; message: string | null; onRefresh: () => void; onOpen: (project: VideoProject) => void; onCreated: (project: VideoProject) => void }) {
  const [draft, setDraft] = useState(blankProject)
  const [creating, setCreating] = useState(false)
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!draft.title.trim()) return
    setCreating(true)
    try { onCreated(await videoApi.createProject({ ...draft, title: draft.title.trim(), audience: draft.audience?.trim() || null })) } catch { /* surfaced by the next refresh */ } finally { setCreating(false) }
  }
  return <div className="video-page" data-testid="video-workspace">
    <header className="video-hero"><div><p className="eyebrow">Bounded production domain</p><h1>Video Workspace</h1><p>Turn retained evidence into a reviewable project, episode, storyboard, shot plan, and deterministic render plan.</p></div><button type="button" className="ghost-button" onClick={onRefresh} disabled={loading}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh</button></header>
    <section className="video-capability-strip"><ShieldCheck size={16} /><span>Evidence and planning are local and deterministic. Model generation is never implied.</span><span className="video-state">{projects.length} project{projects.length === 1 ? '' : 's'}</span></section>
    {message ? <p className="video-alert" role="alert">{message}</p> : null}
    <div className="video-columns">
      <section className="video-card"><div className="video-card-head"><div><p className="eyebrow">Projects</p><h2>Production queue</h2></div><span className="video-chip">revisioned</span></div>
        {projects.length ? <div className="video-project-list">{projects.map((project) => <button type="button" className="video-project-row" key={project.project_id} onClick={() => onOpen(project)}><span className="video-project-icon"><Film size={16} /></span><span className="min-w-0 flex-1 text-left"><strong>{project.title}</strong><small>{project.target_platform} · {Math.round((project.target_duration_ms ?? 0) / 1000)}s · v{project.revision}</small></span><span className="video-chip">{project.status}</span></button>)}</div> : <div className="video-empty"><Clapperboard size={22} /><p>{loading ? 'Loading projects…' : 'No projects yet.'}</p><span>Create a project from a retained event or document, then keep every production revision inspectable.</span></div>}
      </section>
      <form className="video-card video-form" onSubmit={submit}><div className="video-card-head"><div><p className="eyebrow">New project</p><h2>Start a reviewable cut</h2></div><Plus size={18} /></div><label>Project title<input aria-label="Project title" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Q4 margin story" required /></label><div className="video-form-grid"><label>Platform<select value={draft.target_platform} onChange={(event) => setDraft({ ...draft, target_platform: event.target.value })}><option value="youtube">YouTube</option><option value="shorts">Shorts</option><option value="internal_review">Internal review</option></select></label><label>Length (seconds)<input type="number" min="10" value={Math.round((draft.target_duration_ms ?? 90_000) / 1000)} onChange={(event) => setDraft({ ...draft, target_duration_ms: Number(event.target.value) * 1000 })} /></label></div><label>Audience<input aria-label="Audience" value={draft.audience ?? ''} onChange={(event) => setDraft({ ...draft, audience: event.target.value })} placeholder="Research analysts" /></label><label>Style profile<input value={draft.style_profile ?? ''} onChange={(event) => setDraft({ ...draft, style_profile: event.target.value })} /></label><button className="video-primary-button" type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create project'}</button><p className="video-footnote">The first revision stores metadata only. Source text stays in the immutable NIP event ledger.</p></form>
    </div>
  </div>
}

function EpisodeWorkspace({ project, capabilities, onBack, onMessage }: { project: VideoProject; capabilities: VideoCapabilities | null; onBack: () => void; onMessage: (message: string | null) => void }) {
  const [episode, setEpisode] = useState<VideoEpisode | null>(null)
  const [evidence, setEvidence] = useState<VideoEvidenceRef[]>([])
  const [eventId, setEventId] = useState('')
  const [saving, setSaving] = useState(false)
  const [storyboardSaved, setStoryboardSaved] = useState(false)
  const [assets, setAssets] = useState<VideoAsset[]>([])
  const [workflows, setWorkflows] = useState<VideoWorkflow[]>([])
  const [rendering, setRendering] = useState(false)
  const [activeJob, setActiveJob] = useState<VideoJob | null>(null)
  const [jobNotice, setJobNotice] = useState<string | null>(null)
  useEffect(() => {
    void Promise.all([videoApi.listAssets(), videoApi.listWorkflows()]).then(([nextAssets, nextWorkflows]) => {
      setAssets(nextAssets)
      setWorkflows(nextWorkflows)
    }).catch(() => undefined)
  }, [])
  const createEpisode = async () => {
    setSaving(true)
    const created: VideoEpisode = { episode_id: id('episode'), project_id: project.project_id, revision: 1, title: `${project.title} · Episode 1`, as_of: now(), disclosure: 'Fixture/planning output; source evidence remains authoritative.', status: 'draft', created_at: now(), updated_at: now() }
    try { await videoApi.createEpisode(created); setEpisode(created); onMessage('Episode created. Add retained event or claim IDs before writing narration.') } catch (error) { onMessage(error instanceof Error ? error.message : 'Episode creation failed.') } finally { setSaving(false) }
  }
  const addEvidence = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!episode || !eventId.trim()) return
    const ref: VideoEvidenceRef = { evidence_kind: 'event', evidence_id: eventId.trim(), start_offset: null, end_offset: null, quote: null }
    try { await videoApi.linkEvidence(episode.episode_id, episode.revision, ref); setEvidence((items) => [...items, ref]); setEventId(''); onMessage('Evidence link saved and validated against the canonical NIP ledger.') } catch (error) { onMessage(error instanceof Error ? error.message : 'Evidence link rejected.') }
  }
  const saveStoryboard = async () => {
    if (!episode) return
    setSaving(true)
    const timestamp = now()
    const storyboard: VideoStoryboard = { storyboard_id: id('storyboard'), narrative_id: id('narrative'), revision: 1, schema_version: 'video-storyboard-v1', review_status: 'draft', created_at: timestamp, updated_at: timestamp }
    try {
      await videoApi.saveStoryboard(storyboard)
      const scenes: VideoScene[] = ['Hook and source', 'What changed', 'Why it matters'].map((purpose, index) => ({ scene_id: id('scene'), storyboard_id: storyboard.storyboard_id, revision: 1, ordinal: index, purpose, narration_text: index === 0 ? 'This is a fixture narration candidate tied to retained evidence.' : null, visual_intent: index === 1 ? 'evidence_card' : 'kinetic_text', duration_ms: index === 0 ? 12_000 : 18_000, created_at: timestamp, updated_at: timestamp }))
      await Promise.all(scenes.map((scene) => videoApi.saveScene(scene)))
      const shots: VideoShot[] = scenes.flatMap((scene, sceneIndex) => [{ shot_id: id('shot'), scene_id: scene.scene_id, revision: 1, ordinal: 0, shot_type: sceneIndex === 1 ? 'chart' : 'evidence_card', duration_ms: Math.max(1000, Math.round((scene.duration_ms ?? 10_000) / 2)), camera_motion: 'static', visual_prompt: scene.visual_intent, status: 'planned', created_at: timestamp, updated_at: timestamp }])
      await Promise.all(shots.map((shot) => videoApi.saveShot(shot)))
      setStoryboardSaved(true); onMessage('Three scenes and three planned shots saved as immutable production records.')
    } catch (error) { onMessage(error instanceof Error ? error.message : 'Storyboard save failed.') } finally { setSaving(false) }
  }
  const renderLinkZag = async () => {
    setRendering(true)
    setJobNotice(null)
    try {
      const result = await videoApi.renderLinkZag({ scene_id: id('commentary'), title: project.title, subtitle: 'Evidence-linked deterministic commentary', quote: evidence[0]?.quote ?? 'Fixture visual: source evidence remains authoritative.', visual_kind: 'evidence_card', duration_ms: 12_000, width: 1280, height: 720, evidence_ids: evidence.map((item) => item.evidence_id) })
      setActiveJob(result)
      onMessage(`Video job ${result.job_id} queued. Progress is durable and restart-safe.`)
      let current = result
      for (let attempt = 0; attempt < 240 && !['succeeded', 'failed', 'cancelled'].includes(current.status); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500))
        current = await videoApi.getJob(result.job_id)
        setActiveJob(current)
      }
      if (current.status === 'succeeded' && current.output_manifest?.asset) {
        const asset = current.output_manifest.asset
        setAssets((items) => [asset, ...items.filter((item) => item.asset_id !== asset.asset_id)])
        setJobNotice(`Video job succeeded · asset ${asset.asset_id}`)
        onMessage(`Video job succeeded · asset ${asset.asset_id}`)
      } else if (current.status === 'cancelled') { setJobNotice(`Video job ${current.job_id} was cancelled. You can retry it without losing the original attempt.`); onMessage(`Video job ${current.job_id} was cancelled.`) }
      else if (current.status === 'failed') { setJobNotice(current.safe_error_message ?? `Video job ${current.job_id} failed. Retry is available.`); onMessage(current.safe_error_message ?? `Video job ${current.job_id} failed.`) }
      else { setJobNotice(`Video job ${current.job_id} remains ${current.status}; reopen the workspace to inspect it.`); onMessage(`Video job ${current.job_id} remains ${current.status}.`) }
    } catch (error) { const message = error instanceof Error ? error.message : 'LinkZag render failed.'; setJobNotice(`${message} Check the job list or retry after fixing the renderer configuration.`); onMessage(message) } finally { setRendering(false) }
  }
  const cancelActiveJob = async () => { if (!activeJob) return; try { const job = await videoApi.cancelJob(activeJob.job_id); setActiveJob(job); setJobNotice(`Cancellation requested for ${job.job_id}. The renderer will stop at its next safe boundary.`) } catch (error) { setJobNotice(error instanceof Error ? error.message : 'Cancellation request failed.') } }
  const retryActiveJob = async () => { if (!activeJob) return; setRendering(true); setJobNotice(null); try { const retry = await videoApi.retryJob(activeJob.job_id); setActiveJob(retry); setJobNotice(`Retry ${retry.job_id} queued from ${activeJob.job_id}.`); let current = retry; for (let attempt = 0; attempt < 240 && !['succeeded', 'failed', 'cancelled'].includes(current.status); attempt += 1) { await new Promise((resolve) => window.setTimeout(resolve, 500)); current = await videoApi.getJob(retry.job_id); setActiveJob(current) } if (current.status === 'succeeded' && current.output_manifest?.asset) { const asset = current.output_manifest.asset; setAssets((items) => [asset, ...items.filter((item) => item.asset_id !== asset.asset_id)]); setJobNotice(`Retry succeeded · asset ${asset.asset_id}`) } else if (current.status === 'failed' || current.status === 'cancelled') setJobNotice(current.safe_error_message ?? `Retry ended in ${current.status}.`) } catch (error) { setJobNotice(error instanceof Error ? error.message : 'Retry failed.') } finally { setRendering(false) } }
  return <div className="video-page" data-testid="video-episode-workspace"><header className="video-hero"><div><button type="button" className="video-back" onClick={onBack}>← Projects</button><p className="eyebrow">Project v{project.revision} · {project.status}</p><h1>{project.title}</h1><p>Episode → narrative → storyboard → scenes → shots. Every production record stays linked to source evidence.</p></div><span className="video-chip video-chip-strong">{capabilities?.planning ?? 'planning'}</span></header><section className="video-capability-grid"><Capability label="Planning" state={capabilities?.planning} /><Capability label="Evidence linkage" state={capabilities?.evidence_linkage} /><Capability label="Deterministic renderer" state={capabilities?.deterministic_renderer} /><Capability label="Generative video" state={capabilities?.generative_video} /></section>{jobNotice ? <section className={`video-job-banner ${activeJob?.status === 'succeeded' ? 'is-success' : activeJob?.status === 'failed' || activeJob?.status === 'cancelled' ? 'is-error' : 'is-info'}`} role={activeJob?.status === 'failed' ? 'alert' : 'status'}><div><strong>Video job {activeJob?.status ?? 'notice'}</strong><p>{jobNotice}</p>{activeJob ? <small>{activeJob.job_id} · {Math.round(activeJob.progress_millis / 1000)}% · {activeJob.cancellation_requested ? 'cancellation requested' : 'durable state persisted'}</small> : null}</div><div className="video-job-actions">{activeJob && !['succeeded', 'failed', 'cancelled'].includes(activeJob.status) ? <button type="button" className="video-secondary-button" onClick={() => void cancelActiveJob()}>Cancel</button> : null}{activeJob && ['failed', 'cancelled'].includes(activeJob.status) ? <button type="button" className="video-primary-button" onClick={() => void retryActiveJob()} disabled={rendering}>Retry job</button> : null}<button type="button" className="video-secondary-button" onClick={() => setJobNotice(null)}>Dismiss</button></div></section> : null}{episode ? <section className="video-card"><div className="video-card-head"><div><p className="eyebrow">Episode v{episode.revision}</p><h2>{episode.title}</h2></div><span className="video-chip">{episode.status}</span></div><div className="video-evidence-panel"><div><strong>Evidence links</strong><p>Use immutable event or claim IDs. Raw transcript text is not copied into the Video projection.</p></div><form onSubmit={addEvidence} className="video-inline-form"><input aria-label="Canonical event or claim ID" placeholder="event-… or claim-…" value={eventId} onChange={(event) => setEventId(event.target.value)} /><button className="video-secondary-button" type="submit">Link evidence</button></form>{evidence.length ? evidence.map((ref) => <div className="video-evidence-row" key={`${ref.evidence_kind}-${ref.evidence_id}`}><FileCheck2 size={14} /><code>{ref.evidence_id}</code><span>{ref.evidence_kind} · validated</span></div>) : <p className="video-footnote">No evidence linked in this session.</p>}</div><div className="video-card-head video-storyboard-head"><div><p className="eyebrow">Storyboard</p><h2>Three-scene planning scaffold</h2></div><button className="video-primary-button" type="button" onClick={() => void saveStoryboard()} disabled={saving}><Sparkles size={14} /> {saving ? 'Saving…' : storyboardSaved ? 'Saved · create new revision' : 'Save 3 scenes / 3 shots'}</button></div><div className="video-scene-grid">{['Hook and source', 'What changed', 'Why it matters'].map((scene, index) => <article className="video-scene-card" key={scene}><span>0{index + 1}</span><strong>{scene}</strong><p>{index === 0 ? 'Evidence card + disclosure' : index === 1 ? 'Chart or claim visual' : 'Deterministic takeaway'}</p><small>{index === 0 ? 12 : 18}s · shot planned</small></article>)}</div><div className="video-card-head video-storyboard-head"><div><p className="eyebrow">LinkZag renderer</p><h2>Deterministic commentary segment</h2></div><button className="video-secondary-button" type="button" onClick={() => void renderLinkZag()} disabled={rendering}><Clapperboard size={14} /> {rendering ? 'Rendering…' : 'Render evidence card'}</button></div><div className="video-asset-summary"><span>{assets.length} reusable asset{assets.length === 1 ? '' : 's'}</span><span>{workflows.length} workflow{workflows.length === 1 ? '' : 's'} registered</span><span>LinkZag output is labeled deterministic</span></div>{assets.length ? <div className="video-asset-list">{assets.slice(0, 5).map((asset) => <div className="video-asset-row" key={`${asset.asset_id}-${asset.revision}`}><Film size={14} /><span className="min-w-0 flex-1"><strong>{asset.asset_id}</strong><small>{asset.asset_kind} · {asset.provider} · {asset.reproducibility}</small></span><span className="video-chip">{asset.capability_state}</span></div>)}</div> : null}<p className="video-footnote">Renderer state: deterministic templates are not model-generated footage. Assets retain checksums, provider revision, managed paths, and license state.</p></section> : <section className="video-card video-empty"><Clapperboard size={24} /><h2>Create the first episode revision</h2><p>This creates production metadata only. Link a retained event or claim before approving narration.</p><button className="video-primary-button" type="button" onClick={() => void createEpisode()} disabled={saving}>{saving ? 'Creating…' : 'Create episode'}</button></section>}<p className="video-status" role="status">{project.title} · source truth stays in NIP</p></div>
}

function Capability({ label, state }: { label: string; state?: string }) { return <div className="video-capability"><span>{label}</span><strong>{state ?? 'unknown'}</strong></div> }
