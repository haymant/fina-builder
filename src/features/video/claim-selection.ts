import type { NipClaim, NipClaimEvidence } from '../narrative/types'
import type { VideoSourceEvent } from './types'

export interface VideoClaimOption {
  claim: NipClaim
  evidence: NipClaimEvidence[]
  rejectedEvidenceCount: number
}

export function exactClaimEvidenceForEvent(event: VideoSourceEvent, evidence: NipClaimEvidence[]): NipClaimEvidence[] {
  const characters = Array.from(event.content_text ?? '')
  return evidence.filter((item) => {
    const { start_offset: start, end_offset: end, quote } = item
    if (item.event_id !== event.event_id) return false
    if (!Number.isInteger(start) || !Number.isInteger(end) || start === null || end === null) return false
    if (start < 0 || end <= start || end > characters.length || !quote?.trim()) return false
    return characters.slice(start, end).join('') === quote
  })
}

/**
 * Keep only claims that cite this retained event. A citation is selectable only
 * when its stored quote exactly matches the canonical transcript at the stored
 * Unicode-scalar offsets (Rust `char` offsets, not JavaScript UTF-16 indices).
 */
export function claimsForEvent(event: VideoSourceEvent, claims: NipClaim[]): VideoClaimOption[] {
  return claims.flatMap((claim) => {
    const related = claim.evidence.filter((item) => item.event_id === event.event_id)
    if (!related.length) return []

    const verified = exactClaimEvidenceForEvent(event, related)

    return [{ claim, evidence: verified, rejectedEvidenceCount: related.length - verified.length }]
  })
}
