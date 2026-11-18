import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { nipMediaUrl } from '../../../api/nipTransport'
import { AsrReadiness, CachedMediaPanel, JobProgress, TranscriptionActivity } from '../components/TranscriptionReview'
import type { NipAsrStatus, NipMediaArtifact, NipTranscriptionJob } from '../types'

const job: NipTranscriptionJob = {
  job_id: 'job-1',
  source_id: 'fixture-show',
  source_native_id: 'episode-1',
  canonical_url: null,
  title: 'Policy outlook fixture',
  state: 'transcribe',
  step: 'transcribe',
  detail: 'transcribing chunk 3/7',
  error_code: null,
  error_message: null,
  audio_bytes: 33_400_000,
  audio_content_type: 'audio/mpeg',
  audio_path: '/tmp/nip/asr-staging/job-1/source.mp3',
  audio_url_path: 'job-1/source.mp3',
  audio_duration_seconds: 2532,
  chunks_total: 7,
  chunks_completed: 3,
  transcript_characters: null,
  transcript_preview: null,
  transcript_path: null,
  event_id: 'event-1',
  warnings: [],
  started_at: '2026-11-18T01:00:00Z',
  updated_at: '2026-11-18T01:02:00Z',
  finished_at: null,
  events: [
    { at: '2026-11-18T01:00:00Z', level: 'info', step: 'download', detail: 'downloading the episode enclosure' },
    { at: '2026-11-18T01:00:10Z', level: 'info', step: 'downloaded', detail: 'downloaded 31.9 MB of audio/mpeg audio · 2532s' },
    { at: '2026-11-18T01:02:00Z', level: 'info', step: 'transcribe', detail: 'transcribing chunk 3/7' },
  ],
}

const mediaBase = 'http://127.0.0.1:49152/media'

describe('JobProgress', () => {
  it('shows the live chunk stage, cached audio and the reviewable step log', () => {
    render(<JobProgress job={job} mediaBase={mediaBase} onCancel={vi.fn()} />)
    expect(screen.getByText(/Transcribing · chunk 3\/7/)).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('43')
    expect(screen.getByText(/Audio 31\.9 MB · 42m 12s/)).toBeTruthy()
    const player = screen.getByTestId('cached-audio-player') as HTMLAudioElement
    expect(player.getAttribute('src')).toBe(`${mediaBase}/job-1/source.mp3`)
    fireEvent.click(screen.getByText('3 steps'))
    expect(screen.getByText(/downloaded 31.9 MB/)).toBeTruthy()
  })

  it('names the exact failing step and keeps the error visible', () => {
    render(<JobProgress job={{ ...job, state: 'failed', step: 'transcribe', error_code: 'transcription_oom', error_message: 'local ASR ran out of GPU memory', chunks_completed: 2, warnings: ['chunk 2/7 may be truncated'] }} mediaBase={mediaBase} />)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('transcription_oom')
    expect(alert.textContent).toContain('ran out of GPU memory')
    expect(screen.getByText('chunk 2/7 may be truncated')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull()
  })

  it('offers cancel only while a job is active', () => {
    const onCancel = vi.fn()
    render(<JobProgress job={job} mediaBase={mediaBase} onCancel={onCancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledWith(job)
  })

  it('shows the committed transcript size without implying remote processing', () => {
    render(<JobProgress job={{ ...job, state: 'transcribed', chunks_completed: 7, transcript_characters: 5226, transcript_preview: 'Thousands of businesses…' }} mediaBase={mediaBase} />)
    expect(screen.getByText('Transcript committed')).toBeTruthy()
    expect(screen.getByText(/5,226 transcript characters/)).toBeTruthy()
  })
})

const artifact: NipMediaArtifact = {
  job_id: 'job-1',
  name: 'source.mp3',
  url_path: 'job-1/source.mp3',
  kind: 'audio',
  mime: 'audio/mpeg',
  bytes: 33_400_000,
  modified_at: '2026-11-18T01:00:00Z',
  title: 'Policy outlook fixture',
  source_id: 'fixture-show',
}

describe('CachedMediaPanel', () => {
  it('renders a playable tile card for cached audio and links the file', () => {
    render(<CachedMediaPanel artifacts={[artifact]} mediaBase={mediaBase} loading={false} message={null} onRefresh={vi.fn()} onDelete={vi.fn()} />)
    const tile = screen.getByLabelText('Cached audio and video')
    const player = tile.querySelector('audio') as HTMLAudioElement
    expect(player.getAttribute('src')).toBe(`${mediaBase}/job-1/source.mp3`)
    expect(screen.getByText('31.9 MB', { exact: false })).toBeTruthy()
    expect(screen.getByTitle('Download the cached file')).toBeTruthy()
  })

  it('renders a video player when the pack produced a video artifact', () => {
    const video = { ...artifact, name: 'commentary.mp4', url_path: 'job-1/commentary.mp4', kind: 'video', mime: 'video/mp4' }
    const { container } = render(<CachedMediaPanel artifacts={[video]} mediaBase={mediaBase} loading={false} message={null} onRefresh={vi.fn()} onDelete={vi.fn()} />)
    expect(container.querySelector('video')?.getAttribute('src')).toBe(`${mediaBase}/job-1/commentary.mp4`)
  })

  it('deletes only after the tile action is used', () => {
    const onDelete = vi.fn()
    render(<CachedMediaPanel artifacts={[artifact]} mediaBase={mediaBase} loading={false} message={null} onRefresh={vi.fn()} onDelete={onDelete} />)
    fireEvent.click(screen.getByLabelText('Delete source.mp3'))
    expect(onDelete).toHaveBeenCalledWith(artifact)
  })

  it('explains an empty cache instead of showing a dead player', () => {
    render(<CachedMediaPanel artifacts={[]} mediaBase={null} loading={false} message={null} onRefresh={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText(/No cached media yet/)).toBeTruthy()
  })
})

const status: NipAsrStatus = {
  ready: false,
  configured: true,
  comfyui_url: 'http://127.0.0.1:8190',
  workspace: '/repo/modules/comfy',
  workspace_present: true,
  render_script: '/repo/modules/comfy/scripts/render.py',
  render_script_present: true,
  repo_url: 'https://github.com/haymant/comfyui-flows.git',
  chunk_seconds: 45,
  python: 'python3',
  python_present: true,
  ffmpeg_present: true,
  server_reachable: true,
  server_device: 'cuda:0 NVIDIA GeForce RTX 3060 Ti',
  asr_nodes_present: false,
  pack_commit: '3de8194',
  blockers: ['ComfyUI is running but the ComfyUI-Qwen3-ASR nodes are not loaded'],
  next_actions: ['Install the ComfyUI-Qwen3-ASR custom node in ComfyUI Manager, restart ComfyUI, then retry.'],
}

describe('AsrReadiness', () => {
  it('lists every blocker and the exact next action', () => {
    render(<AsrReadiness status={status} preparing={false} message={null} onPrepare={vi.fn()} onRefresh={vi.fn()} />)
    expect(screen.getByTestId('asr-blockers').textContent).toContain('Qwen3-ASR nodes are not loaded')
    expect(screen.getByText(/Install the ComfyUI-Qwen3-ASR custom node/)).toBeTruthy()
    expect(screen.getByText(/Workspace \/repo\/modules\/comfy/)).toBeTruthy()
  })

  it('shows a ready state with the pack commit and chunk size', () => {
    render(<AsrReadiness status={{ ...status, ready: true, blockers: [], next_actions: [] }} preparing={false} message={null} onPrepare={vi.fn()} onRefresh={vi.fn()} />)
    expect(screen.getByText(/Local ASR ready · cuda:0/)).toBeTruthy()
    expect(screen.getByText(/comfy 3de8194 · 45s chunks/)).toBeTruthy()
  })
})

describe('TranscriptionActivity', () => {
  it('keeps failed runs visible for review with their transcript preview', () => {
    render(<TranscriptionActivity jobs={[{ ...job, state: 'failed', error_code: 'transcription_failed', error_message: 'ComfyUI execution failed: node type mismatch', transcript_preview: 'Partial transcript preview' }]} mediaBase={mediaBase} onCancel={vi.fn()} />)
    expect(screen.getByText(/ComfyUI execution failed: node type mismatch/)).toBeTruthy()
    expect(screen.getByText('Partial transcript preview')).toBeTruthy()
  })
})

describe('nipMediaUrl', () => {
  it('encodes each artifact path segment', () => {
    expect(nipMediaUrl('/nip-media', 'job-1/source one.mp3')).toBe('/nip-media/job-1/source%20one.mp3')
    expect(nipMediaUrl('http://127.0.0.1:1/media', '../secret')).toBe('')
    expect(nipMediaUrl('http://127.0.0.1:1/media', 'job-1/../../etc/passwd')).toBe('')
  })
})
