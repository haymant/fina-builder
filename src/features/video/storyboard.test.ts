import { describe, expect, it } from 'vitest'
import { buildTranscriptStoryboard } from './storyboard'
import type { VideoEpisode, VideoProject, VideoSourceEvent } from './types'

const timestamp = '2026-11-19T00:00:00.000Z'
const event: VideoSourceEvent = {
  event_id: 'event-fixture-1',
  source_id: 'source-fixture-1',
  source_native_id: 'episode-1',
  canonical_url: null,
  content_hash: 'abcd1234',
  content_text: '  The fixture research team expects policy to remain restrictive.\nThey cite uncertainty in the outlook.  ',
}
const project: VideoProject = {
  project_id: 'project-1', revision: 1, title: 'Policy outlook', language: 'en', target_platform: 'youtube',
  target_duration_ms: 90_000, audience: null, style_profile: 'evidence_first', status: 'draft', created_at: timestamp, updated_at: timestamp,
}
const episode: VideoEpisode = {
  episode_id: 'episode-1', project_id: project.project_id, revision: 1, title: 'Episode 1', as_of: timestamp,
  disclosure: null, status: 'draft', created_at: timestamp, updated_at: timestamp,
}

function idFactory() {
  let value = 0
  return (prefix: string) => `${prefix}-${++value}`
}

describe('buildTranscriptStoryboard', () => {
  it('builds coordinated scene, shot, visual, evidence, and audio cue records from one retained transcript', () => {
    const draft = buildTranscriptStoryboard(event, project, episode, idFactory(), timestamp)
    expect(draft.document.schema_version).toBe('fina-slides-v1')
    expect(draft.document.source_event_id).toBe(event.event_id)
    expect(draft.document.slides).toHaveLength(3)
    expect(draft.scenes).toHaveLength(3)
    expect(draft.shots).toHaveLength(3)
    expect(draft.visualSpecs).toHaveLength(3)
    expect(draft.document.slides.map((slide) => slide.ordinal)).toEqual([0, 1, 2])
    expect(draft.document.slides.map((slide) => slide.audio_cue.start_ms)).toEqual([
      0,
      draft.document.slides[0].scene.duration_ms!,
      draft.document.slides[0].scene.duration_ms! + draft.document.slides[1].scene.duration_ms!,
    ])
    expect(draft.document.slides.every((slide) => slide.audio_cue.status === 'not_configured')).toBe(true)
    expect(draft.document.audio_provider_state).toBe('not_configured')
    expect(draft.document.slides[0].scene.narration_text).toContain('retained event transcript')
  })

  it('keeps the excerpt offset exact against the original transcript, including leading whitespace', () => {
    const slide = buildTranscriptStoryboard(event, project, episode, idFactory(), timestamp).document.slides[1]
    const ref = slide.evidence[0]
    expect(ref.start_offset).not.toBeNull()
    expect(ref.end_offset).not.toBeNull()
    expect(event.content_text?.slice(ref.start_offset!, ref.end_offset!)).toBe(ref.quote)
    expect(slide.visual_spec.sources[0].source_id).toBe(event.event_id)
    expect(slide.visual_spec.payload.kind).toBe('quote_card')
  })

  it('rejects an event without transcript text instead of fabricating narration', () => {
    expect(() => buildTranscriptStoryboard({ ...event, content_text: null }, project, episode, idFactory(), timestamp))
      .toThrow('no transcript text')
  })
})
