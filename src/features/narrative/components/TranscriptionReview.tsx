import { AlertTriangle, CheckCircle2, Clock3, Download, FileText, Loader2, RefreshCw, Trash2, XCircle } from 'lucide-react'
import { nipMediaUrl } from '../../../api/nipTransport'
import { Button } from '../../../components/ui/button'
import { jobIsActive } from '../jobs'
import type { NipAsrStatus, NipMediaArtifact, NipTranscriptionJob } from '../types'

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || seconds <= 0) return '—'
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  return hours ? `${hours}h ${minutes}m` : minutes ? `${minutes}m ${rest}s` : `${rest}s`
}

function jobStageLabel(job: NipTranscriptionJob): string {
  switch (job.state) {
    case 'queued': return 'Queued for the local ASR slot'
    case 'download': return 'Downloading episode audio'
    case 'downloaded': return 'Audio downloaded · starting the comfy pack'
    case 'transcribe': return job.chunks_total ? `Transcribing · chunk ${Math.max(job.chunks_completed, 1)}/${job.chunks_total}` : 'Transcribing locally'
    case 'commit': return 'Committing the transcript to the ledger'
    case 'transcribed': return 'Transcript committed'
    case 'failed': return job.error_code === 'interrupted' || job.step === 'interrupted' ? 'Interrupted before completion' : `Failed at ${job.step}`
    case 'cancelled': return 'Cancelled'
    default: return job.step
  }
}

/** One job's live stage, cached audio player and reviewable step log. */
export function JobProgress({ job, mediaBase, onCancel, onOpenEvent }: { job: NipTranscriptionJob; mediaBase: string | null; onCancel?: (job: NipTranscriptionJob) => void; onOpenEvent?: (job: NipTranscriptionJob) => void }) {
  const active = jobIsActive(job)
  const failed = job.state === 'failed'
  const audioUrl = mediaBase && job.audio_url_path ? nipMediaUrl(mediaBase, job.audio_url_path) : null
  const progress = job.chunks_total ? Math.round((job.chunks_completed / job.chunks_total) * 100) : null
  return (
    <div className={`transcription-job ${failed ? 'is-error' : job.state === 'transcribed' ? 'is-done' : ''}`} data-testid={`transcription-job-${job.job_id}`}>
      <div className="transcription-job-head">
        {failed ? <XCircle size={13} /> : job.state === 'transcribed' ? <CheckCircle2 size={13} /> : active ? <Loader2 size={13} className="animate-spin" /> : <Clock3 size={13} />}
        <strong>{jobStageLabel(job)}</strong>
        <span className="narrative-chip">{job.state.replaceAll('_', ' ')}</span>
      </div>
      {active && progress !== null ? <div className="transcription-progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.max(4, progress)}%` }} /></div> : null}
      <p className="transcription-job-meta">
        {job.audio_bytes ? `Audio ${formatBytes(job.audio_bytes)}` : 'Audio not downloaded yet'}
        {job.audio_duration_seconds ? ` · ${formatDuration(job.audio_duration_seconds)}` : ''}
        {job.transcript_characters ? ` · ${job.transcript_characters.toLocaleString()} transcript characters` : ''}
      </p>
      {failed ? <p className="transcription-error" role="alert"><AlertTriangle size={12} /> <span><strong>{job.error_code ?? 'transcription_failed'}:</strong> {job.error_message ?? 'the local ASR step failed'}</span></p> : null}
      {job.warnings.length ? <ul className="transcription-warnings">{job.warnings.slice(-3).map((warning, index) => <li key={`${index}-${warning.slice(0, 24)}`}>{warning}</li>)}</ul> : null}
      {audioUrl ? <audio className="media-player" controls preload="none" src={audioUrl} data-testid="cached-audio-player">Your browser cannot play this cached audio.</audio> : null}
      <div className="transcription-job-actions">
        {job.state === 'transcribed' && job.event_id && onOpenEvent ? <Button size="sm" variant="outline" onClick={() => onOpenEvent(job)}><FileText size={12} /> Open retained transcript</Button> : null}
        {active && onCancel ? <Button size="sm" variant="outline" onClick={() => onCancel(job)}>Cancel</Button> : null}
        {job.events.length ? <details className="transcription-steps"><summary>{job.events.length} step{job.events.length === 1 ? '' : 's'}</summary><ol>{[...job.events].slice(-12).map((event, index) => <li key={`${event.at}-${index}`} className={`step-${event.level}`}><time>{new Date(event.at).toLocaleTimeString()}</time> {event.detail}</li>)}</ol></details> : null}
      </div>
    </div>
  )
}

/** Exact ASR readiness: every blocker and the action that clears it. */
export function AsrReadiness({ status, preparing, message, onPrepare, onRefresh }: { status: NipAsrStatus | null; preparing: boolean; message: string | null; onPrepare: () => void; onRefresh: () => void }) {
  if (!status) return null
  if (status.ready) {
    return <p className="episode-asr-ready" role="status"><CheckCircle2 size={12} /> Local ASR ready{status.server_device ? ` · ${status.server_device}` : ''}{status.pack_commit ? ` · comfy ${status.pack_commit}` : ''}{status.chunk_seconds ? ` · ${status.chunk_seconds}s chunks` : ''}</p>
  }
  return (
    <div className="episode-empty episode-empty-error" role="alert" data-testid="asr-blockers">
      <strong>Local ASR is not ready.</strong> NIP will not upload audio or substitute a remote ASR service.
      {(status.blockers ?? []).length ? <ul>{(status.blockers ?? []).map((blocker) => <li key={blocker}>{blocker}</li>)}</ul> : null}
      {(status.next_actions ?? []).length ? <p className="asr-next">Next: {(status.next_actions ?? []).join(' ')}</p> : null}
      <div className="asr-actions">
        {status.repo_url ? <Button size="sm" disabled={preparing} onClick={onPrepare}>{preparing ? 'Preparing…' : `Clone ${status.repo_url.split('/').pop() ?? 'comfy pack'}`}</Button> : null}
        <Button size="sm" variant="outline" onClick={onRefresh}><RefreshCw size={12} /> Recheck</Button>
      </div>
      {message ? <p className="mt-2 text-[10px]">{message}</p> : null}
      <p className="asr-paths">Workspace {status.workspace} · CLI {status.render_script}</p>
    </div>
  )
}

/** Tile cards for cached audio/video, playable without leaving the app. */
export function CachedMediaPanel({ artifacts, mediaBase, loading, message, onRefresh, onDelete }: { artifacts: NipMediaArtifact[]; mediaBase: string | null; loading: boolean; message: string | null; onRefresh: () => void; onDelete: (artifact: NipMediaArtifact) => void }) {
  return (
    <section className="cached-media" aria-label="Cached audio and video">
      <div className="cached-media-head">
        <div>
          <p className="eyebrow">Local artifacts</p>
          <h3 className="text-xs font-semibold text-main">Cached audio &amp; video</h3>
        </div>
        <Button size="sm" variant="outline" disabled={loading} onClick={onRefresh}>{loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Refresh</Button>
      </div>
      {message ? <p className="text-[10px] text-muted" role="status">{message}</p> : null}
      {!artifacts.length ? <p className="episode-empty">No cached media yet. Transcribe an episode and its downloaded audio appears here for replay.</p> : <div className="media-grid">
        {artifacts.map((artifact) => {
          const url = mediaBase ? nipMediaUrl(mediaBase, artifact.url_path) : null
          return <article className="media-tile" key={`${artifact.job_id}/${artifact.name}`}>
            <header><strong title={artifact.name}>{artifact.name}</strong><span className="narrative-chip">{artifact.kind}</span></header>
            {url ? artifact.kind === 'video'
              ? <video className="media-player" controls preload="metadata" src={url}>Your browser cannot play this cached video.</video>
              : <audio className="media-player" controls preload="none" src={url}>Your browser cannot play this cached audio.</audio>
              : <p className="media-unavailable">Playback URL unavailable.</p>}
            <footer>
              <span>{formatBytes(artifact.bytes)} · {new Date(artifact.modified_at).toLocaleString()}</span>
              {artifact.title ? <span className="media-title" title={artifact.title}>{artifact.title}</span> : null}
              <span className="media-actions">
                {url ? <a href={url} download={artifact.name} title="Download the cached file"><Download size={12} /></a> : null}
                <button type="button" title="Delete this cached file" onClick={() => onDelete(artifact)} aria-label={`Delete ${artifact.name}`}><Trash2 size={12} /></button>
              </span>
            </footer>
          </article>
        })}
      </div>}
    </section>
  )
}

/** Review list of recent transcription jobs with cached audio and transcript previews. */
export function TranscriptionActivity({ jobs, mediaBase, onCancel, onOpenEvent }: { jobs: NipTranscriptionJob[]; mediaBase: string | null; onCancel: (job: NipTranscriptionJob) => void; onOpenEvent?: (job: NipTranscriptionJob) => void }) {
  return <div className="transcription-activity">
    {jobs.length ? jobs.map((job) => <article className="evidence-card" key={job.job_id}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0"><strong className="block truncate text-xs text-main">{job.title ?? job.source_native_id ?? job.job_id}</strong><p className="mt-1 text-[10px] text-muted">{job.source_id} · started {new Date(job.started_at).toLocaleString()}</p></div>
        <span className="narrative-chip">{job.state.replaceAll('_', ' ')}</span>
      </div>
      <JobProgress job={job} mediaBase={mediaBase} onCancel={onCancel} onOpenEvent={onOpenEvent} />
      {job.transcript_preview ? <blockquote className="transcription-preview">{job.transcript_preview}</blockquote> : null}
    </article>) : <p className="episode-empty">No transcription runs yet.</p>}
  </div>
}
