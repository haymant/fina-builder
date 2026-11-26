import type { ClaimReviewStatus, ExtractionTier, NipThesis, ThesisBasis, ThesisStatus } from './types'

/**
 * Thesis pipeline gates + tier/review presentation helpers (revamp §c.5,
 * §f.3). The gate lives in the data — the NIP store refuses to record a
 * provisional thesis past `draft` (save_thesis enforces it) and refuses to
 * write a transcript for one — and these helpers are the UI's mirror of
 * that rule, so a disabled button can never be the only thing stopping an
 * advance. Keep them pure and unit-tested; components only render them.
 */

export const THESIS_PIPELINE: ThesisStatus[] = [
  'draft',
  'llm_reviewed',
  'backtested',
  'transcript_ready',
  'video_ready',
  'published',
]

export const THESIS_TERMINAL: ThesisStatus[] = ['rejected', 'invalidated']

/** Stages a thesis may enter, given its basis. Provisional never advances. Terminal states never move. */
export function allowedThesisStatuses(thesis: Pick<NipThesis, 'thesis_basis' | 'status'>): ThesisStatus[] {
  if (thesis.status === 'rejected' || thesis.status === 'invalidated' || thesis.status === 'published') return [thesis.status]
  if (thesis.thesis_basis === 'provisional_fast_glance') return ['draft', 'rejected']
  return [...THESIS_PIPELINE, ...THESIS_TERMINAL]
}

export function canAdvanceThesis(
  thesis: Pick<NipThesis, 'thesis_basis' | 'status'>,
  target: ThesisStatus,
): boolean {
  return allowedThesisStatuses(thesis).includes(target)
}

/** Why an advance is blocked, for the exact message the UI shows. */
export function thesisGateReason(thesis: Pick<NipThesis, 'thesis_basis' | 'status'>, target: ThesisStatus): string | null {
  if (canAdvanceThesis(thesis, target)) return null
  if (thesis.thesis_basis === 'provisional_fast_glance') {
    return `Provisional thesis (fast glance only) can never advance to ${target}. Deep-dive the claims, record LLM reviews, and re-issue the thesis as llm_verified_only.`
  }
  return `Thesis in status ${thesis.status} cannot move to ${target}.`
}

export function thesisBasisLabel(basis: ThesisBasis): string {
  return basis === 'llm_verified_only' ? 'llm_verified_only — thesis-grade' : 'PROVISIONAL — fast glance only, NOT thesis-grade'
}

export function thesisStatusLabel(status: ThesisStatus): string {
  return status.replace('_', ' ')
}

export function tierLabel(tier: ExtractionTier | null | undefined): string {
  if (!tier) return 'no tier — unlabelled'
  if (tier === 'tier0_lexicon') return 'tier0 · fast glance (lexicon)'
  if (tier === 'tier1_onnx') return 'tier1 · fast glance (FinBERT)'
  return 'tier2 · LLM'
}

export function reviewStatusLabel(status: ClaimReviewStatus | null | undefined): string {
  if (!status) return 'unreviewed'
  return status.replace('_', ' ')
}

/** S6 rule: a signal with n < 5 is not a signal — show "insufficient data". */
export const MIN_SIGNAL_N = 5

export function hasSufficientData(n: number | null | undefined): boolean {
  return typeof n === 'number' && n >= MIN_SIGNAL_N
}

/**
 * Render a z-score, or the insufficient-data reason when the signal is
 * thin. `n` is the n of the window the z describes (the last bucket's n
 * for a radar row). S6 rule: n < 5 is never a signal — a non-null z on
 * thin data is still shown as insufficient data, never ranked.
 */
export function zScoreDisplay(zScore: number | null | undefined, n: number | null | undefined, reason?: string | null): string {
  if (typeof n === 'number' && !hasSufficientData(n)) return `insufficient data (n=${n} < ${MIN_SIGNAL_N})`
  if (zScore === null || zScore === undefined) {
    if (!hasSufficientData(n)) return `insufficient data (n=${n ?? 0} < ${MIN_SIGNAL_N})`
    return reason ? `z unavailable: ${reason}` : 'z unavailable'
  }
  return `z=${zScore >= 0 ? '+' : ''}${zScore.toFixed(2)}`
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return value.toFixed(digits)
}
