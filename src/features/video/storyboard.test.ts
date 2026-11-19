import { describe, expect, it } from 'vitest'
import { claimsForEvent } from './claim-selection'
import { buildSelectedClaimsStoryboard, buildTranscriptStoryboard } from './storyboard'
import type { NipClaim } from '../narrative/types'
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

const selectedClaimText = 'The fixture research team expects policy to remain restrictive.'
const selectedQuote = 'expects policy to remain restrictive'
const selectedStart = Array.from(event.content_text ?? '').join('').indexOf(selectedQuote)
const selectedClaim: NipClaim = {
  claim_id: 'claim-policy-1',
  claim_text: selectedClaimText,
  speaker_or_author: 'fixture research team',
  confidence_millis: 900,
  extraction_run_id: 'claim-run-1',
  provider: 'fixture-only',
  model: 'fixture-model',
  prompt_version: 'fixture-v1',
  extracted_at: timestamp,
  evidence: [{ event_id: event.event_id, quote: selectedQuote, start_offset: selectedStart, end_offset: selectedStart + Array.from(selectedQuote).length }],
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

describe('buildSelectedClaimsStoryboard', () => {
  it('creates slides only for explicit selections and carries exact claim and event spans', () => {
    const unrelatedClaim: NipClaim = { ...selectedClaim, claim_id: 'claim-unselected', claim_text: 'This claim was not selected.' }
    const options = claimsForEvent(event, [selectedClaim, unrelatedClaim])
    const selected = options.filter((option) => option.claim.claim_id === selectedClaim.claim_id)
    const draft = buildSelectedClaimsStoryboard(event, selected, project, episode, idFactory(), timestamp)

    expect(draft.document.slides).toHaveLength(1)
    expect(draft.document.slides[0].scene.narration_text).toContain(selectedClaimText)
    expect(draft.document.slides[0].scene.narration_text).not.toContain('This claim was not selected')
    expect(draft.document.slides[0].evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidence_kind: 'claim', evidence_id: selectedClaim.claim_id, start_offset: selectedStart, end_offset: selectedStart + Array.from(selectedQuote).length, quote: selectedQuote }),
      expect.objectContaining({ evidence_kind: 'event', evidence_id: event.event_id, start_offset: selectedStart, end_offset: selectedStart + Array.from(selectedQuote).length, quote: selectedQuote }),
    ]))
    expect(draft.visualSpecs[0].sources.map((source) => [source.source_kind, source.source_id])).toEqual([
      ['claim', selectedClaim.claim_id],
      ['event', event.event_id],
    ])
    expect(draft.visualSpecs[0].payload).toMatchObject({ kind: 'evidence_card', disclosure: 'Exact quote matched; claim support unverified.' })
  })

  it('rejects empty selection or an evidence span that no longer matches the retained event', () => {
    expect(() => buildSelectedClaimsStoryboard(event, [], project, episode, idFactory(), timestamp))
      .toThrow('Select at least one retained claim')
    expect(() => buildSelectedClaimsStoryboard(event, [{ claim: selectedClaim, evidence: [{ ...selectedClaim.evidence[0], quote: 'not the source' }] }], project, episode, idFactory(), timestamp))
      .toThrow('no exact matching transcript span')
  })
})
