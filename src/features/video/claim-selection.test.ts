import { describe, expect, it } from 'vitest'
import { claimsForEvent } from './claim-selection'
import type { NipClaim } from '../narrative/types'
import type { VideoSourceEvent } from './types'

const event: VideoSourceEvent = {
  event_id: 'event-claims-1',
  source_id: 'podcast-1',
  source_native_id: 'episode-1',
  canonical_url: null,
  content_hash: 'hash-1',
  content_text: '🛰️ Policy remains restrictive until inflation cools.',
}

function makeClaim(evidence: NipClaim['evidence'], claimId = 'claim-1'): NipClaim {
  return {
    claim_id: claimId,
    claim_text: 'Policy is expected to remain restrictive.',
    speaker_or_author: 'Research team',
    confidence_millis: 900,
    extraction_run_id: 'run-1',
    provider: 'local-test',
    model: 'fixture-model',
    prompt_version: 'claims-v1',
    extracted_at: '2026-11-19T00:00:00Z',
    evidence,
  }
}

describe('claimsForEvent', () => {
  it('filters by event and verifies quote spans with Unicode scalar offsets', () => {
    const quote = 'Policy remains restrictive'
    const start = 3 // 🛰️ is two Unicode scalar values, followed by one space.
    const valid = { event_id: event.event_id, quote, start_offset: start, end_offset: start + Array.from(quote).length }
    const otherEvent = { event_id: 'event-other', quote, start_offset: start, end_offset: start + Array.from(quote).length }
    const mismatch = { event_id: event.event_id, quote: 'different words', start_offset: start, end_offset: start + 4 }

    const options = claimsForEvent(event, [
      makeClaim([valid, mismatch]),
      makeClaim([otherEvent], 'claim-other-event'),
    ])

    expect(options).toHaveLength(1)
    expect(options[0].claim.claim_id).toBe('claim-1')
    expect(options[0].evidence).toEqual([valid])
    expect(options[0].rejectedEvidenceCount).toBe(1)
  })

  it('keeps an event claim visible but unselectable when every stored span is invalid', () => {
    const options = claimsForEvent(event, [makeClaim([{
      event_id: event.event_id,
      quote: 'Policy remains restrictive',
      start_offset: 0,
      end_offset: 5,
    }, {
      event_id: event.event_id,
      quote: ' ',
      start_offset: 2,
      end_offset: 3,
    }])])

    expect(options).toHaveLength(1)
    expect(options[0].evidence).toEqual([])
    expect(options[0].rejectedEvidenceCount).toBe(2)
  })
})
