import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateVideoEpisodeDialog } from '../components/CreateVideoEpisodeDialog'
import type { NipClaim } from '../types'
import type { VideoEpisode, VideoProject, VideoSourceEvent } from '../../video/types'

const videoApiMock = vi.hoisted(() => ({
  listProjects: vi.fn(), createProject: vi.fn(), createEpisode: vi.fn(), getEvent: vi.fn(), linkEvidence: vi.fn(),
}))
vi.mock('../../video/api', () => ({ videoApi: videoApiMock }))

const claim: NipClaim = {
  claim_id: 'claim-1', claim_text: 'Gold rose on expectations.', speaker_or_author: 'Reporter', confidence_millis: 920,
  extraction_run_id: 'run-1', provider: 'local', model: 'test', prompt_version: 'v1', extracted_at: '2026-01-01T00:00:00Z',
  evidence: [{ event_id: 'event-1', quote: 'Gold rose', start_offset: 0, end_offset: 9 }],
}
const event: VideoSourceEvent = {
  event_id: 'event-1', source_id: 'wire', source_native_id: 'native-story-1', canonical_url: null,
  content_hash: 'hash', content_text: 'Gold rose after the announcement.',
}
const project: VideoProject = {
  project_id: 'project-1', revision: 1, title: 'Market Brief', language: 'en', target_platform: 'youtube',
  target_duration_ms: 90_000, audience: null, style_profile: 'evidence_first', status: 'draft',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  vi.resetAllMocks()
  videoApiMock.listProjects.mockResolvedValue([project])
  videoApiMock.getEvent.mockResolvedValue(event)
  videoApiMock.createProject.mockImplementation(async (record: VideoProject) => record)
  videoApiMock.createEpisode.mockImplementation(async (record: VideoEpisode) => record)
  videoApiMock.linkEvidence.mockResolvedValue({})
})

describe('CreateVideoEpisodeDialog', () => {
  it('creates a draft in the chosen project and preserves event and exact claim-span lineage', async () => {
    const onOpenVideoEpisode = vi.fn()
    render(<CreateVideoEpisodeDialog claim={claim} onClose={vi.fn()} onOpenVideoEpisode={onOpenVideoEpisode} />)
    expect(await screen.findByText('1 exact matching span verified')).toBeTruthy()
    const projectSelect = screen.getByLabelText('Video project')
    expect(projectSelect).toHaveValue('new')
    fireEvent.change(projectSelect, { target: { value: project.project_id } })

    fireEvent.click(screen.getByRole('button', { name: 'Create video episode' }))
    await waitFor(() => expect(videoApiMock.createEpisode).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(videoApiMock.linkEvidence).toHaveBeenCalledTimes(2))

    const episode = videoApiMock.createEpisode.mock.calls[0]![0] as VideoEpisode
    expect(episode.project_id).toBe(project.project_id)
    expect(episode.status).toBe('draft')
    expect(videoApiMock.createProject).not.toHaveBeenCalled()
    expect(videoApiMock.linkEvidence.mock.calls[0]).toEqual([episode.episode_id, episode.revision, {
      evidence_kind: 'event', evidence_id: 'event-1', start_offset: null, end_offset: null, quote: null,
    }])
    expect(videoApiMock.linkEvidence.mock.calls[1]).toEqual([episode.episode_id, episode.revision, {
      evidence_kind: 'claim', evidence_id: 'claim-1', start_offset: 0, end_offset: 9, quote: 'Gold rose',
    }])
    expect(onOpenVideoEpisode).toHaveBeenCalledWith(project.project_id, episode.episode_id, claim.claim_id)
  })

  it('blocks creation and explains why when the stored quote does not match its transcript span', async () => {
    videoApiMock.getEvent.mockResolvedValue({ ...event, content_text: 'Prices fell after the announcement.' })
    render(<CreateVideoEpisodeDialog claim={claim} onClose={vi.fn()} />)

    expect(await screen.findByText(/No source event has a claim quote that exactly matches/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create video episode' })).toBeDisabled()
    expect(videoApiMock.createProject).not.toHaveBeenCalled()
    expect(videoApiMock.createEpisode).not.toHaveBeenCalled()
  })

  it('reports the created episode ID when an evidence-link call fails', async () => {
    videoApiMock.listProjects.mockResolvedValue([])
    videoApiMock.linkEvidence.mockRejectedValueOnce(new Error('link store unavailable'))
    render(<CreateVideoEpisodeDialog claim={claim} onClose={vi.fn()} />)
    expect(await screen.findByText('1 exact matching span verified')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Create video episode' }))
    const alert = await screen.findByRole('alert')
    const episode = videoApiMock.createEpisode.mock.calls[0]![0] as VideoEpisode
    expect(alert.textContent).toContain(`Episode ${episode.episode_id} was created`)
    expect(alert.textContent).toContain('link store unavailable')
    expect(videoApiMock.createProject).toHaveBeenCalledTimes(1)
    expect(videoApiMock.linkEvidence).toHaveBeenCalledTimes(1)
  })
})
