import { describe, expect, it } from 'vitest'
import {
  allowedThesisStatuses,
  canAdvanceThesis,
  hasSufficientData,
  thesisGateReason,
  tierLabel,
  zScoreDisplay,
  MIN_SIGNAL_N,
} from '../thesisGates'
import type { NipThesis } from '../types'

function thesis(overrides: Partial<NipThesis>): Pick<NipThesis, 'thesis_basis' | 'status'> {
  return { thesis_basis: 'llm_verified_only', status: 'draft', ...overrides }
}

describe('thesis gates (revamp §c.5, decision §f.3)', () => {
  it('a provisional thesis can never advance past draft', () => {
    const provisional = thesis({ thesis_basis: 'provisional_fast_glance', status: 'draft' })
    expect(allowedThesisStatuses(provisional)).toEqual(['draft', 'rejected'])
    for (const target of ['llm_reviewed', 'backtested', 'transcript_ready', 'video_ready', 'published'] as const) {
      expect(canAdvanceThesis(provisional, target)).toBe(false)
      expect(thesisGateReason(provisional, target)).toMatch(/Provisional thesis/)
    }
    expect(canAdvanceThesis(provisional, 'rejected')).toBe(true)
  })

  it('an llm_verified_only thesis can walk the whole pipeline', () => {
    const verified = thesis({ status: 'draft' })
    for (const target of ['llm_reviewed', 'backtested', 'transcript_ready', 'video_ready', 'published'] as const) {
      expect(canAdvanceThesis(verified, target)).toBe(true)
      expect(thesisGateReason(verified, target)).toBeNull()
    }
  })

  it('an invalidated thesis cannot advance', () => {
    const invalidated = thesis({ status: 'invalidated' })
    expect(canAdvanceThesis(invalidated, 'backtested')).toBe(false)
  })
})

describe('signal sufficiency (S6 rule: n < 5 is insufficient data)', () => {
  it('treats n < 5 as insufficient, never a signal', () => {
    expect(MIN_SIGNAL_N).toBe(5)
    expect(hasSufficientData(4)).toBe(false)
    expect(hasSufficientData(5)).toBe(true)
    expect(hasSufficientData(null)).toBe(false)
    expect(zScoreDisplay(3.42, 3)).toBe('insufficient data (n=3 < 5)')
  })

  it('renders a z-score only when the data is sufficient', () => {
    expect(zScoreDisplay(3.42, 12)).toBe('z=+3.42')
    expect(zScoreDisplay(-0.74, 12)).toBe('z=-0.74')
    expect(zScoreDisplay(null, 12, 'insufficient_baseline')).toBe('z unavailable: insufficient_baseline')
  })

  it('labels an unlabelled claim as invalid, not as a normal tier', () => {
    expect(tierLabel(null)).toBe('no tier — unlabelled')
    expect(tierLabel('tier2_llm')).toBe('tier2 · LLM')
    expect(tierLabel('tier0_lexicon')).toBe('tier0 · fast glance (lexicon)')
  })
})
