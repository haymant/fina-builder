import { describe, expect, it } from 'vitest'
import { buildThesisStoryboard, validateStoryboardForLinkZag, verifyThesisForVideo, backtestTableText } from './thesis'
import type { ThesisVideoVerificationInput } from './thesis'
import type { NipBacktestEvidence, NipClaim, NipThesis, NipTranscript } from '../narrative/types'
import type { VideoEpisode, VideoProject, VideoSourceEvent } from './types'

const timestamp = '2026-11-24T16:00:00.000Z'

const eventText = 'NVDA data-center revenue beat expectations. Guidance was raised for next quarter. Supply constraints eased in October.'
const event: VideoSourceEvent = {
  event_id: 'event-nvda-1',
  source_id: 'source-alpaca',
  source_native_id: 'nvda-news-1',
  canonical_url: null,
  content_hash: 'hash-nvda-1',
  content_text: eventText,
}

function span(quote: string) {
  const start = eventText.indexOf(quote)
  return { event_id: event.event_id, quote, start_offset: start, end_offset: start + Array.from(quote).length }
}

function makeClaim(id: string, text: string, quote: string): NipClaim {
  return {
    claim_id: id,
    claim_text: text,
    speaker_or_author: 'NVDA earnings call',
    confidence_millis: 920,
    extraction_run_id: 'run-llm-1',
    provider: 'fixture-llm',
    model: 'fixture-model',
    prompt_version: 'fixture-v1',
    extracted_at: timestamp,
    extraction_tier: 'tier2_llm',
    review_status: 'llm_verified',
    evidence: [span(quote)],
  }
}

const claims = [
  makeClaim('claim-nvda-1', 'NVDA data-center revenue beat expectations.', 'data-center revenue beat expectations'),
  makeClaim('claim-nvda-2', 'NVDA raised guidance for next quarter.', 'Guidance was raised for next quarter'),
  makeClaim('claim-nvda-3', 'Supply constraints eased in October.', 'Supply constraints eased in October'),
]

const thesis: NipThesis = {
  thesis_id: 'thesis-nvda-1',
  title: 'NVDA long 1–3 days on the data-center beat and raised guidance',
  entity_symbol: 'NVDA',
  direction: 'long',
  horizon: '1-3 days',
  as_of: timestamp,
  thesis_basis: 'llm_verified_only',
  confidence_millis: 780,
  reason: 'Beat plus raised guidance, corroborated across three verified claims.',
  status: 'transcript_ready',
  invalidation_condition: 'NVDA closes below the pre-earnings range on heavy volume.',
  what_would_change_mind: 'A guidance cut or a demand warning from a hyperscaler.',
  claim_ids: claims.map((claim) => claim.claim_id),
  rejected_claims: [{ claim_id: 'claim-nvda-rejected', reason: 'Single-source, unverified.' }],
  created_at: timestamp,
  updated_at: timestamp,
}

const transcript: NipTranscript = {
  transcript_id: 'transcript-nvda-1',
  thesis_id: thesis.thesis_id,
  transcript_hash: 'transcript-hash-abc',
  summary: 'NVDA beat and raised guidance; the ablation favours the narrative leg.',
  beats: [
    { ordinal: 0, title: 'Hook', script: 'NVDA just beat and raised guidance — here is the thesis in one sentence.', evidence_refs: [{ kind: 'claim', claim_id: 'claim-nvda-1' }] },
    { ordinal: 1, title: 'What changed', script: 'Data-center revenue beat expectations and guidance went up.', evidence_refs: [{ kind: 'claim', claim_id: 'claim-nvda-1' }] },
    { ordinal: 2, title: 'Evidence 1', script: 'Data-center revenue beat expectations.', evidence_refs: [{ kind: 'claim', claim_id: 'claim-nvda-1' }] },
    { ordinal: 3, title: 'Evidence 2', script: 'Guidance was raised for next quarter.', evidence_refs: [{ kind: 'claim', claim_id: 'claim-nvda-2' }] },
    { ordinal: 4, title: 'Evidence 3', script: 'Supply constraints eased in October.', evidence_refs: [{ kind: 'claim', claim_id: 'claim-nvda-3' }] },
    { ordinal: 5, title: 'The test', script: 'The ablation favours the narrative leg.', evidence_refs: [{ kind: 'backtest', backtest_id: 'backtest-nvda-1' }] },
  ],
  fina_import_path: null,
  created_at: timestamp,
}

const backtest: NipBacktestEvidence = {
  backtest_id: 'backtest-nvda-1',
  thesis_id: thesis.thesis_id,
  run_id_a: 'run-a-1',
  run_id_b: 'run-b-1',
  config_fingerprint: 'fp-1',
  metrics_a: { ic: 0.02, icir: 0.4, sharpe: 0.9, total_return: 0.05, max_drawdown: -0.08 },
  metrics_b: { ic: 0.05, icir: 0.9, sharpe: 1.7, total_return: 0.11, max_drawdown: -0.06 },
  delta: { ic: 0.03, icir: 0.5, sharpe: 0.8, total_return: 0.06, max_drawdown: 0.02 },
  verdict: 'supported',
  could_not_run_reason: null,
  recorded_at: timestamp,
  source: 'fina-builder:tac-qlib-rd',
}

const project: VideoProject = {
  project_id: 'project-1', revision: 1, title: 'NVDA thesis', language: 'en', target_platform: 'youtube',
  target_duration_ms: 90_000, audience: null, style_profile: 'evidence_first', status: 'draft', created_at: timestamp, updated_at: timestamp,
}
const episode: VideoEpisode = {
  episode_id: 'episode-1', project_id: project.project_id, revision: 1, title: 'NVDA thesis episode', as_of: timestamp,
  disclosure: null, status: 'draft', origin: 'thesis', thesis_id: thesis.thesis_id, transcript_id: transcript.transcript_id,
  transcript_hash: transcript.transcript_hash, created_at: timestamp, updated_at: timestamp,
}

function idFactory() {
  let value = 0
  return (prefix: string) => `${prefix}-${++value}`
}

function input(overrides: Partial<ThesisVideoVerificationInput> = {}): ThesisVideoVerificationInput {
  return {
    thesis,
    transcript,
    claims,
    events: new Map([[event.event_id, event]]),
    backtests: [backtest],
    ...overrides,
  }
}

describe('verifyThesisForVideo', () => {
  it('passes a fully verified thesis with a supported ablation delta', () => {
    const result = verifyThesisForVideo(input())
    expect(result.ready).toBe(true)
    expect(result.blockers).toEqual([])
    expect(result.verifiedClaims).toHaveLength(3)
    expect(result.deltaShown).toBe(true)
    expect(result.latestBacktest?.backtest_id).toBe('backtest-nvda-1')
  })

  it('blocks a provisional thesis with thesis_provisional and never advances it', () => {
    const result = verifyThesisForVideo(input({ thesis: { ...thesis, thesis_basis: 'provisional_fast_glance' } }))
    expect(result.ready).toBe(false)
    expect(result.blockers.map((finding) => finding.code)).toContain('thesis_provisional')
  })

  it('blocks a claim that is not tier2_llm llm_verified', () => {
    const fastGlance = { ...claims[0], extraction_tier: 'tier0_lexicon' as const, review_status: 'fast_glance' as const }
    const result = verifyThesisForVideo(input({ claims: [fastGlance, claims[1], claims[2]] }))
    expect(result.blockers.map((finding) => finding.code)).toContain('thesis_claim_not_llm_verified')
  })

  it('blocks a cited claim that is missing from the retained list', () => {
    const result = verifyThesisForVideo(input({ claims: claims.slice(1) }))
    expect(result.blockers.map((finding) => finding.code)).toContain('thesis_claim_missing')
  })

  it('blocks a span that no longer exactly matches the retained event', () => {
    const drifted = { ...claims[0], evidence: [{ ...claims[0].evidence[0], quote: 'revenue missed expectations' }] }
    const result = verifyThesisForVideo(input({ claims: [drifted, claims[1], claims[2]] }))
    expect(result.blockers.map((finding) => finding.code)).toContain('span_unverified')
  })

  it('blocks a transcript backtest ref with no recorded backtest row', () => {
    const result = verifyThesisForVideo(input({ backtests: [] }))
    expect(result.blockers.map((finding) => finding.code)).toContain('backtest_ref_missing')
    expect(result.missingBacktestRefs).toEqual(['backtest-nvda-1'])
  })

  it('records could_not_run as an advisory, not a silent pass, and shows no delta', () => {
    const couldNotRun: NipBacktestEvidence = {
      ...backtest,
      verdict: 'could_not_run',
      could_not_run_reason: 'No price data in the TAC lake for the backtest window.',
      delta: {},
      metrics_b: {},
    }
    const noBeatRefs: NipTranscript = { ...transcript, beats: transcript.beats.filter((beat) => beat.ordinal < 5) }
    const result = verifyThesisForVideo(input({ backtests: [couldNotRun], transcript: noBeatRefs }))
    expect(result.ready).toBe(true)
    expect(result.deltaShown).toBe(false)
    expect(result.backtestAbsenceRecorded).toBe(true)
    expect(result.advisories.map((finding) => finding.code)).toContain('backtest_could_not_run')
  })

  it('blocks when the ablation ran but did not support the thesis', () => {
    const notSupported: NipBacktestEvidence = { ...backtest, verdict: 'not_supported' }
    const result = verifyThesisForVideo(input({ backtests: [notSupported] }))
    expect(result.ready).toBe(false)
    expect(result.blockers.map((finding) => finding.code)).toContain('backtest_not_supported')
  })

  it('blocks a thesis with no invalidation condition and no transcript', () => {
    const result = verifyThesisForVideo(input({ thesis: { ...thesis, invalidation_condition: null }, transcript: null }))
    expect(result.blockers.map((finding) => finding.code)).toEqual(expect.arrayContaining(['invalidation_missing', 'transcript_missing']))
  })
})

describe('buildThesisStoryboard', () => {
  it('builds the 8-beat thesis table with real thesis content, not a disclaimer', () => {
    const draft = buildThesisStoryboard(input(), project, episode, idFactory(), timestamp)
    expect(draft.document.slides).toHaveLength(8)
    expect(draft.document.slides.map((slide) => slide.purpose)).toEqual([
      'Beat 1 — Hook + thesis',
      'Beat 2 — What changed',
      'Beat 3 — Evidence 1 of 3',
      'Beat 4 — Evidence 2 of 3',
      'Beat 5 — Evidence 3 of 3',
      'Beat 6 — The test (ablation A vs B)',
      'Beat 7 — What would change my mind',
      'Beat 8 — Caveat + disclosure',
    ])
    expect(draft.narrative.thesis).toContain(thesis.title)
    expect(draft.narrative.thesis).not.toContain('not independent verification')
    expect(draft.narrative.analysis_mode).toBe('thesis_backtest')
    expect(draft.narrative.thesis_id).toBe(thesis.thesis_id)
    expect(draft.narrative.thesis_basis).toBe('llm_verified_only')
    expect(draft.narrative.backtest_ids).toEqual(['backtest-nvda-1'])
    expect(draft.narrative.transcript_hash).toBe(transcript.transcript_hash)
    expect(draft.document.thesis_id).toBe(thesis.thesis_id)
    expect(draft.document.backtest_refs).toEqual(['backtest-nvda-1'])
    expect(draft.document.source_transcript_hash).toBe(transcript.transcript_hash)
    // Beat order is the transcript's beat order, not the claim list's order.
    expect(draft.document.slides[2].scene.narration_text).toContain('Data-center revenue beat expectations')
    expect(draft.document.slides[5].visual_spec.payload).toMatchObject({ kind: 'evidence_card' })
    expect(backtestTableText(backtest)).toContain('Run A run-a-1 vs Run B run-b-1')
    expect(draft.document.slides[5].evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidence_kind: 'backtest', evidence_id: 'backtest-nvda-1' }),
      expect.objectContaining({ evidence_kind: 'thesis', evidence_id: thesis.thesis_id }),
    ]))
    // Every slide keeps claim+event refs where it cites a claim.
    expect(draft.document.slides[2].evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidence_kind: 'claim', evidence_id: 'claim-nvda-1' }),
      expect.objectContaining({ evidence_kind: 'event', evidence_id: event.event_id }),
    ]))
    // Invalidation and disclosure come from the thesis, verbatim.
    expect(draft.document.slides[6].scene.narration_text).toContain(thesis.invalidation_condition as string)
    expect(draft.document.slides[7].scene.narration_text).toContain('not investment advice')
    // Audio cues are contiguous from zero.
    expect(draft.document.slides[0].audio_cue.start_ms).toBe(0)
    expect(draft.document.slides.map((slide) => slide.audio_cue.start_ms)).toEqual(
      draft.document.slides.reduce<number[]>((starts, _slide, index) => {
        if (index === 0) return [0]
        return [...starts, starts[index - 1] + draft.document.slides[index - 1].scene.duration_ms!]
      }, []),
    )
  })

  it('passes the linkzag shape validation (compile_scene mirror, no render)', () => {
    const draft = buildThesisStoryboard(input(), project, episode, idFactory(), timestamp)
    expect(validateStoryboardForLinkZag(draft.document)).toEqual([])
  })

  it('refuses to build when verification blocks, naming the gate code', () => {
    expect(() => buildThesisStoryboard(input({ thesis: { ...thesis, thesis_basis: 'provisional_fast_glance' } }), project, episode, idFactory(), timestamp))
      .toThrow('thesis_provisional')
  })

  it('states could_not_run honestly on the test slide instead of inventing a delta', () => {
    const couldNotRun: NipBacktestEvidence = {
      ...backtest,
      verdict: 'could_not_run',
      could_not_run_reason: 'No price data in the TAC lake for the backtest window.',
      delta: {},
      metrics_b: {},
    }
    const noBeatRefs: NipTranscript = { ...transcript, beats: transcript.beats.filter((beat) => beat.ordinal < 5) }
    const draft = buildThesisStoryboard(input({ backtests: [couldNotRun], transcript: noBeatRefs }), project, episode, idFactory(), timestamp)
    const testSlide = draft.document.slides.find((slide) => slide.purpose.startsWith('Beat 6'))
    expect(testSlide?.scene.narration_text).toContain('could not run')
    expect(testSlide?.scene.narration_text).not.toContain('beat Run A')
    expect(validateStoryboardForLinkZag(draft.document)).toEqual([])
  })
})

describe('validateStoryboardForLinkZag', () => {
  it('rejects an unsupported payload kind and a slide without evidence', () => {
    const draft = buildThesisStoryboard(input(), project, episode, idFactory(), timestamp)
    const broken = structuredClone(draft.document)
    broken.slides[0].visual_spec.payload = { kind: 'hologram', text: 'nope' } as never
    broken.slides[1].evidence = []
    const errors = validateStoryboardForLinkZag(broken)
    expect(errors.some((error) => error.includes('unsupported visual payload kind'))).toBe(true)
    expect(errors.some((error) => error.includes('no evidence ref'))).toBe(true)
  })
})
