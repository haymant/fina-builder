import type {
  NipBacktestEvidence,
  NipClaim,
  NipClaimEvidence,
  NipThesis,
  NipTranscript,
} from '../narrative/types'
import type {
  VideoAudioCue,
  VideoEpisode,
  VideoEvidenceRef,
  VideoNarrative,
  VideoProject,
  VideoQaFinding,
  VideoScene,
  VideoShot,
  VideoSourceEvent,
  VideoStoryboard,
  VideoStoryboardDocument,
  VideoStoryboardSlide,
  VideoVisualPayload,
  VideoVisualSpec,
} from './types'
import { exactClaimEvidenceForEvent } from './claim-selection'
import type { VideoStoryboardDraft } from './storyboard'

/**
 * Thesis-first video workspace (revamp §d.1–§d.2, decision §f.4).
 *
 * Pure logic, no transport: the UI loads a thesis + its transcript +
 * backtest records + claims + retained events through the MCP tools and
 * hands them here. Every gate in this file is enforced again at the
 * store level for thesis status (ThesisBasis::allows_status), but the
 * video layer must not trust a string list: `backtest_ids` /
 * `backtest_refs` are NOT resolution-validated by the store, so this
 * module resolves every backtest ref against recorded
 * `NipBacktestEvidence` rows before a slide may cite one.
 */

/** QA finding codes for the thesis/backtest gates F2 left open (§d.2). */
export type ThesisGateCode =
  | 'thesis_provisional'
  | 'thesis_claim_missing'
  | 'thesis_claim_not_llm_verified'
  | 'span_unverified'
  | 'backtest_ref_missing'
  | 'backtest_delta_absent'
  | 'backtest_not_supported'
  | 'backtest_could_not_run'
  | 'invalidation_missing'
  | 'transcript_missing'
  | 'transcript_hash_mismatch'

export const THESIS_GRADE_REVIEW_STATUSES = ['llm_verified', 'llm_corrected'] as const

export interface ThesisVerifiedClaim {
  claim: NipClaim
  /** Every stored span for this claim, re-verified against its event. */
  evidence: NipClaimEvidence[]
  event: VideoSourceEvent
}

export interface ThesisVideoVerificationInput {
  thesis: NipThesis
  /** Null when no transcript was recorded for the thesis. */
  transcript: NipTranscript | null
  /** All retained claims (the UI passes `listClaims()`; lookup is by id). */
  claims: NipClaim[]
  /** Retained events backing the cited claims, keyed by event_id. */
  events: Map<string, VideoSourceEvent>
  /** Recorded ablation rows for this thesis, newest first. */
  backtests: NipBacktestEvidence[]
}

export interface ThesisVideoVerification {
  blockers: VideoQaFinding[]
  advisories: VideoQaFinding[]
  verifiedClaims: ThesisVerifiedClaim[]
  /** Backtest refs named by transcript beats that resolve to no record. */
  missingBacktestRefs: string[]
  resolvedBacktests: NipBacktestEvidence[]
  /** Newest recorded ablation, when any record exists. */
  latestBacktest: NipBacktestEvidence | null
  /** True when a supported ablation shows a non-null out-of-sample delta. */
  deltaShown: boolean
  /** True when the only backtest state is a recorded could_not_run. */
  backtestAbsenceRecorded: boolean
  ready: boolean
}

function finding(code: ThesisGateCode, severity: 'blocker' | 'advisory', message: string, subjectId: string | null, evidence: VideoEvidenceRef[] = []): VideoQaFinding {
  return { code, severity, message, subject_id: subjectId, evidence }
}

function thesisRef(thesisId: string): VideoEvidenceRef {
  return { evidence_kind: 'thesis', evidence_id: thesisId, start_offset: null, end_offset: null, quote: null }
}

function hasDelta(record: NipBacktestEvidence): boolean {
  const delta = record.delta
  return [delta.ic, delta.icir, delta.sharpe, delta.total_return, delta.max_drawdown]
    .some((value) => value !== null && value !== undefined)
}

/**
 * Step 1 (§d.1): thesis + evidence re-verification on entry.
 * A provisional thesis, an unverified claim, an unverified span, or an
 * unresolvable backtest ref blocks the episode with the exact failing
 * ref — nothing is silently dropped.
 */
export function verifyThesisForVideo(input: ThesisVideoVerificationInput): ThesisVideoVerification {
  const { thesis, transcript, claims, events, backtests } = input
  const blockers: VideoQaFinding[] = []
  const advisories: VideoQaFinding[] = []
  const byId = new Map(claims.map((claim) => [claim.claim_id, claim]))
  const verifiedClaims: ThesisVerifiedClaim[] = []

  if (thesis.thesis_basis !== 'llm_verified_only') {
    blockers.push(finding(
      'thesis_provisional',
      'blocker',
      `Thesis ${thesis.thesis_id} has basis ${thesis.thesis_basis}; only llm_verified_only theses may enter a thesis video. Deep-dive and re-verify before video.`,
      thesis.thesis_id,
      [thesisRef(thesis.thesis_id)],
    ))
  }
  if (!thesis.invalidation_condition?.trim()) {
    blockers.push(finding(
      'invalidation_missing',
      'blocker',
      `Thesis ${thesis.thesis_id} states no invalidation condition; a thesis video must say what would change its mind.`,
      thesis.thesis_id,
      [thesisRef(thesis.thesis_id)],
    ))
  }
  if (!transcript) {
    blockers.push(finding(
      'transcript_missing',
      'blocker',
      `No commentary transcript is recorded for thesis ${thesis.thesis_id}; a thesis video starts from a transcript, not from claims.`,
      thesis.thesis_id,
      [thesisRef(thesis.thesis_id)],
    ))
  } else if (transcript.thesis_id !== thesis.thesis_id) {
    blockers.push(finding(
      'transcript_missing',
      'blocker',
      `Transcript ${transcript.transcript_id} belongs to thesis ${transcript.thesis_id}, not ${thesis.thesis_id}.`,
      transcript.transcript_id,
      [thesisRef(thesis.thesis_id)],
    ))
  }

  for (const claimId of thesis.claim_ids) {
    const claim = byId.get(claimId)
    if (!claim) {
      blockers.push(finding(
        'thesis_claim_missing',
        'blocker',
        `Thesis ${thesis.thesis_id} cites claim ${claimId}, which is not in the retained claim list.`,
        claimId,
        [thesisRef(thesis.thesis_id)],
      ))
      continue
    }
    const grade = claim.extraction_tier === 'tier2_llm'
      && claim.review_status !== null
      && claim.review_status !== undefined
      && (THESIS_GRADE_REVIEW_STATUSES as readonly string[]).includes(claim.review_status)
    if (!grade) {
      blockers.push(finding(
        'thesis_claim_not_llm_verified',
        'blocker',
        `Claim ${claimId} is ${claim.extraction_tier ?? 'unlabelled'}/${claim.review_status ?? 'unreviewed'}; a thesis video cites tier2_llm claims with review_status llm_verified or llm_corrected only.`,
        claimId,
        [{ evidence_kind: 'claim', evidence_id: claimId, start_offset: null, end_offset: null, quote: null }],
      ))
      continue
    }
    // Re-verify every stored span against its retained event text.
    let verifiedSpans: NipClaimEvidence[] = []
    let claimEvent: VideoSourceEvent | null = null
    let failed = false
    for (const span of claim.evidence) {
      const event = events.get(span.event_id)
      if (!event) {
        failed = true
        blockers.push(finding(
          'span_unverified',
          'blocker',
          `Claim ${claimId} cites event ${span.event_id}, which is not loaded as a retained event; its span cannot be re-verified.`,
          claimId,
          [{ evidence_kind: 'claim', evidence_id: claimId, start_offset: span.start_offset, end_offset: span.end_offset, quote: span.quote }],
        ))
        continue
      }
      const matched = exactClaimEvidenceForEvent(event, [span])
      if (!matched.length) {
        failed = true
        blockers.push(finding(
          'span_unverified',
          'blocker',
          `Claim ${claimId} span [${span.start_offset}, ${span.end_offset}) no longer exactly matches retained event ${span.event_id}; the episode is blocked with this ref, not silently dropped.`,
          claimId,
          [{ evidence_kind: 'claim', evidence_id: claimId, start_offset: span.start_offset, end_offset: span.end_offset, quote: span.quote }],
        ))
        continue
      }
      verifiedSpans = [...verifiedSpans, ...matched]
      claimEvent = event
    }
    if (!failed && verifiedSpans.length && claimEvent) {
      verifiedClaims.push({ claim, evidence: verifiedSpans, event: claimEvent })
    }
  }

  // Backtest refs: every backtest named by a transcript beat must resolve
  // to a recorded backtest row. `backtest_ids` string lists are not
  // resolution-validated at the store level, so this is the check.
  const beatBacktestIds = [...new Set(
    (transcript?.beats ?? []).flatMap((beat) => beat.evidence_refs
      .filter((ref) => ref.kind === 'backtest' && ref.backtest_id)
      .map((ref) => ref.backtest_id as string)),
  )]
  const byBacktestId = new Map(backtests.map((record) => [record.backtest_id, record]))
  const missingBacktestRefs = beatBacktestIds.filter((id) => !byBacktestId.has(id))
  for (const missing of missingBacktestRefs) {
    blockers.push(finding(
      'backtest_ref_missing',
      'blocker',
      `Transcript beat cites backtest ${missing}, which has no recorded backtest-evidence row for thesis ${thesis.thesis_id}.`,
      missing,
      [thesisRef(thesis.thesis_id)],
    ))
  }
  const resolvedBacktests = backtests.filter((record) => record.thesis_id === thesis.thesis_id)
  const latestBacktest = resolvedBacktests[0] ?? null
  let deltaShown = false
  let backtestAbsenceRecorded = false
  if (!latestBacktest) {
    blockers.push(finding(
      'backtest_delta_absent',
      'blocker',
      `No ablation (Run A vs Run B) is recorded for thesis ${thesis.thesis_id}; a thesis video must show the delta or record why it could not run.`,
      thesis.thesis_id,
      [thesisRef(thesis.thesis_id)],
    ))
  } else if (latestBacktest.verdict === 'could_not_run') {
    backtestAbsenceRecorded = true
    advisories.push(finding(
      'backtest_could_not_run',
      'advisory',
      `Ablation could not run: ${latestBacktest.could_not_run_reason ?? 'no reason recorded'}. The video may proceed only with the absence explicitly recorded and acknowledged; no delta is claimed.`,
      latestBacktest.backtest_id,
      [{ evidence_kind: 'backtest', evidence_id: latestBacktest.backtest_id, start_offset: null, end_offset: null, quote: null }],
    ))
  } else if (latestBacktest.verdict === 'not_supported') {
    blockers.push(finding(
      'backtest_not_supported',
      'blocker',
      `Ablation recorded for thesis ${thesis.thesis_id} did not support it (Run B did not beat Run A out-of-sample); the thesis cannot advance to a thesis video.`,
      latestBacktest.backtest_id,
      [{ evidence_kind: 'backtest', evidence_id: latestBacktest.backtest_id, start_offset: null, end_offset: null, quote: null }],
    ))
  } else if (!hasDelta(latestBacktest)) {
    blockers.push(finding(
      'backtest_delta_absent',
      'blocker',
      `Ablation ${latestBacktest.backtest_id} is recorded as supported but shows no out-of-sample delta (all delta fields are null); there is no delta to show.`,
      latestBacktest.backtest_id,
      [{ evidence_kind: 'backtest', evidence_id: latestBacktest.backtest_id, start_offset: null, end_offset: null, quote: null }],
    ))
  } else {
    deltaShown = true
  }

  return {
    blockers,
    advisories,
    verifiedClaims,
    missingBacktestRefs,
    resolvedBacktests,
    latestBacktest,
    deltaShown,
    backtestAbsenceRecorded,
    ready: blockers.length === 0,
  }
}

/** Re-check a loaded transcript against the episode's pinned hash (§d.1 step 1). */
export function verifyTranscriptHash(episode: VideoEpisode, transcript: NipTranscript): VideoQaFinding | null {
  if (!episode.transcript_hash) return null
  if (episode.transcript_hash === transcript.transcript_hash) return null
  return finding(
    'transcript_hash_mismatch',
    'blocker',
    `Transcript ${transcript.transcript_id} hash ${transcript.transcript_hash} does not match the episode's pinned hash ${episode.transcript_hash}; the transcript changed since this episode started.`,
    transcript.transcript_id,
    [thesisRef(episode.thesis_id ?? transcript.thesis_id)],
  )
}

export function formatMetric(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : String(value)
}

export function backtestTableText(record: NipBacktestEvidence): string {
  const a = record.metrics_a
  const b = record.metrics_b
  const d = record.delta
  const rows: Array<[string, number | null | undefined, number | null | undefined, number | null | undefined]> = [
    ['IC', a.ic, b.ic, d.ic],
    ['ICIR', a.icir, b.icir, d.icir],
    ['Sharpe', a.sharpe, b.sharpe, d.sharpe],
    ['Total return', a.total_return, b.total_return, d.total_return],
    ['Max drawdown', a.max_drawdown, b.max_drawdown, d.max_drawdown],
  ]
  const lines = rows.map(([name, av, bv, dv]) => `${name}: A ${formatMetric(av)} · B ${formatMetric(bv)} · Δ ${formatMetric(dv)}`)
  const verdict = record.verdict === 'supported'
    ? 'Run B beat Run A out-of-sample; the narrative features contributed to the delta shown.'
    : record.verdict === 'not_supported'
      ? 'Run B did not beat Run A out-of-sample; the thesis is NOT supported by the backtest.'
      : `Ablation could not run: ${record.could_not_run_reason ?? 'no reason recorded'}. No delta is claimed.`
  return `Ablation ${record.backtest_id} · Run A ${record.run_id_a} vs Run B ${record.run_id_b}\n${lines.join('\n')}\n${verdict}`
}

export function backtestVerdictText(record: NipBacktestEvidence): string {
  if (record.verdict === 'could_not_run') {
    return `The ablation could not run — ${record.could_not_run_reason ?? 'no reason recorded'}. No backtest delta is claimed in this video.`
  }
  if (record.verdict === 'not_supported') {
    return 'The ablation ran and Run B did not beat Run A out-of-sample. The thesis is not supported by the backtest.'
  }
  const sharpe = record.delta.sharpe
  return sharpe !== null && sharpe !== undefined
    ? `The ablation ran: Run B beat Run A out-of-sample by ${sharpe} Sharpe (delta).`
    : 'The ablation ran and Run B beat Run A out-of-sample by the delta shown.'
}

interface BeatInput {
  beat: number
  purpose: string
  narration: string
  template: 'evidence_card' | 'quote_card' | 'kinetic_text' | 'chart_transition' | 'caption'
  payload: VideoVisualPayload
  sources: VideoVisualSpec['sources']
  evidence: VideoEvidenceRef[]
  visualPrompt: string
}

function slideDurationMs(narration: string): number {
  const words = narration.trim().split(/\s+/u).length
  return Math.max(6_000, Math.min(20_000, Math.ceil((words / 2.4 + 1.5) * 1_000)))
}

/**
 * Step 3 (§d.1): thesis-shaped storyboard from the transcript beats.
 * Beat table: 1 hook+thesis, 2 what changed, 3–5 evidence (max 3 claims),
 * 6 the test (ablation), 7 invalidation, 8 caveat+disclosure.
 * Narration is the transcript's spoken text where a beat carries it, never
 * regenerated from claims; every slide keeps its transcript beat's claim
 * refs and one direct event ref per parent source event, and the backtest
 * slide keeps its backtest_id ref. No slide without an evidence ref.
 */
export function buildThesisStoryboard(
  input: ThesisVideoVerificationInput,
  project: VideoProject,
  episode: VideoEpisode,
  makeId: (prefix: string) => string,
  timestamp: string,
): VideoStoryboardDraft {
  const verification = verifyThesisForVideo(input)
  if (!verification.ready) {
    throw new Error(`Thesis video is blocked: ${verification.blockers.map((finding) => finding.code).join(', ')}.`)
  }
  const { thesis, transcript } = input
  if (!transcript) throw new Error('Thesis video is blocked: transcript_missing.')
  const evidenceClaims = verification.verifiedClaims.slice(0, 3)
  if (!evidenceClaims.length) throw new Error('Thesis video is blocked: no verified thesis-grade claim has an exact transcript span.')
  const latestBacktest = verification.latestBacktest as NipBacktestEvidence
  const beats = [...transcript.beats].sort((a, b) => a.ordinal - b.ordinal)
  const beatForClaim = (claimId: string, quote: string) => {
    const candidates = beats.filter((beat) => beat.evidence_refs.some((ref) => ref.claim_id === claimId))
    // Prefer the beat whose spoken script actually states this claim's
    // evidence (the hook beat may reference the lead claim without
    // stating it). Match case-insensitively on the exact quote.
    const needle = quote.slice(0, 30).toLocaleLowerCase()
    return candidates.find((beat) => beat.script.toLocaleLowerCase().includes(needle)) ?? candidates[0]
  }
  const beatForBacktest = (backtestId: string) => beats.find((beat) => beat.evidence_refs.some((ref) => ref.backtest_id === backtestId))
  const thesisEvidence: VideoEvidenceRef[] = [thesisRef(thesis.thesis_id)]
  const thesisSource: VideoVisualSpec['sources'] = [{ source_kind: 'thesis', source_id: thesis.thesis_id, source_revision: null, start_offset: null, end_offset: null, quote: null }]

  const beatInputs: BeatInput[] = []
  // Beat 1 — Hook + thesis.
  beatInputs.push({
    beat: 1,
    purpose: 'Beat 1 — Hook + thesis',
    narration: beats[0]?.script?.trim() || thesis.title,
    template: 'kinetic_text',
    payload: { kind: 'kinetic_text', text: thesis.title },
    sources: thesisSource,
    evidence: thesisEvidence,
    visualPrompt: 'Kinetic text: the thesis in one sentence.',
  })
  // Beat 2 — What changed.
  const whatChangedNarration = beats[1]?.script?.trim()
    || transcript.summary?.trim()
    || thesis.reason?.trim()
    || thesis.title
  beatInputs.push({
    beat: 2,
    purpose: 'Beat 2 — What changed',
    narration: whatChangedNarration,
    template: 'chart_transition',
    payload: {
      kind: 'chart_transition',
      title: `What changed · ${thesis.entity_symbol ?? 'thesis'} · as of ${thesis.as_of}`,
      x_axis_label: 'time',
      y_axis_label: 'sentiment',
      points: [],
    },
    sources: thesisSource,
    evidence: thesisEvidence,
    visualPrompt: 'Chart transition: sentiment trend / burst at the thesis as_of; numbers are spoken, not drawn from thin air.',
  })
  // Beats 3–5 — Evidence (max 3 claims).
  evidenceClaims.forEach(({ claim, evidence: spans, event }, index) => {
    const primary = spans[0]
    const speaker = claim.speaker_or_author?.trim() || null
    const attribution = speaker ? `an extracted claim attributed to ${speaker}` : 'an extracted claim'
    const narration = beatForClaim(claim.claim_id, primary.quote ?? claim.claim_text)?.script?.trim()
      || `${attribution[0].toUpperCase()}${attribution.slice(1)} states: ${claim.claim_text}. Supporting transcript excerpt: “${primary.quote}”.`
    const sources = spans.flatMap((span) => [
      { source_kind: 'claim' as const, source_id: claim.claim_id, source_revision: null, start_offset: span.start_offset, end_offset: span.end_offset, quote: span.quote },
      { source_kind: 'event' as const, source_id: event.event_id, source_revision: null, start_offset: span.start_offset, end_offset: span.end_offset, quote: span.quote },
    ])
    const slideEvidence: VideoEvidenceRef[] = spans.flatMap((span) => [
      { evidence_kind: 'claim', evidence_id: claim.claim_id, start_offset: span.start_offset, end_offset: span.end_offset, quote: span.quote },
      { evidence_kind: 'event', evidence_id: event.event_id, start_offset: span.start_offset, end_offset: span.end_offset, quote: span.quote },
    ])
    beatInputs.push({
      beat: 3 + index,
      purpose: `Beat ${3 + index} — Evidence ${index + 1} of ${evidenceClaims.length}`,
      narration,
      template: 'evidence_card',
      payload: {
        kind: 'evidence_card',
        title: speaker ? `Evidence ${index + 1} · attributed to ${speaker}` : `Evidence ${index + 1}`,
        body: `Claim: ${claim.claim_text}\n\nSupporting transcript quote: “${primary.quote}”`,
        disclosure: 'Exact quote matched; claim is llm_verified (tier2_llm).',
      },
      sources,
      evidence: slideEvidence,
      visualPrompt: 'Show the verified claim beside its exact transcript evidence.',
    })
  })
  // Beat 6 — The test (ablation A vs B).
  const testNarration = beatForBacktest(latestBacktest.backtest_id)?.script?.trim()
    || (latestBacktest.verdict === 'could_not_run'
      ? backtestVerdictText(latestBacktest)
      : `${backtestVerdictText(latestBacktest)} Run A ${latestBacktest.run_id_a} versus Run B ${latestBacktest.run_id_b}.`)
  const testSources: VideoVisualSpec['sources'] = [
    { source_kind: 'backtest', source_id: latestBacktest.backtest_id, source_revision: null, start_offset: null, end_offset: null, quote: null },
    ...thesisSource,
  ]
  const testEvidence: VideoEvidenceRef[] = [
    { evidence_kind: 'backtest', evidence_id: latestBacktest.backtest_id, start_offset: null, end_offset: null, quote: null },
    ...thesisEvidence,
  ]
  beatInputs.push({
    beat: 6,
    purpose: 'Beat 6 — The test (ablation A vs B)',
    narration: testNarration,
    template: 'evidence_card',
    payload: {
      kind: 'evidence_card',
      title: `The test · Run A vs Run B · ${latestBacktest.verdict.replaceAll('_', ' ')}`,
      body: backtestTableText(latestBacktest),
      disclosure: `Backtest ${latestBacktest.backtest_id} · ${latestBacktest.source}`,
    },
    sources: testSources,
    evidence: testEvidence,
    visualPrompt: 'Show the Run A vs Run B ablation table and its out-of-sample delta.',
  })
  // Beat 7 — What would change my mind.
  const invalidation = thesis.invalidation_condition as string
  beatInputs.push({
    beat: 7,
    purpose: 'Beat 7 — What would change my mind',
    narration: `What would change my mind: ${invalidation}`,
    template: 'kinetic_text',
    payload: { kind: 'kinetic_text', text: invalidation },
    sources: thesisSource,
    evidence: thesisEvidence,
    visualPrompt: 'Kinetic text: the invalidation condition, verbatim.',
  })
  // Beat 8 — Caveat + disclosure.
  const caveat = `Basis: llm_verified_only · as_of ${thesis.as_of} · Not investment advice.`
  beatInputs.push({
    beat: 8,
    purpose: 'Beat 8 — Caveat + disclosure',
    narration: `This video states a thesis, not investment advice. Basis: llm_verified_only at ${thesis.as_of}.`,
    template: 'caption',
    payload: { kind: 'caption', text: caveat },
    sources: thesisSource,
    evidence: thesisEvidence,
    visualPrompt: 'Caption: thesis basis, decision as_of, and the not-investment-advice disclosure.',
  })

  const narrativeId = makeId('narrative')
  const storyboardId = makeId('storyboard')
  const backtestIds = verification.resolvedBacktests.map((record) => record.backtest_id)
  const narrative: VideoNarrative = {
    narrative_id: narrativeId,
    episode_id: episode.episode_id,
    revision: 1,
    summary: transcript.summary ?? thesis.title,
    // Real thesis content (§d.2) — never the old hardcoded disclaimer.
    thesis: thesis.reason?.trim() ? `${thesis.title} — ${thesis.reason}` : thesis.title,
    analysis_mode: 'thesis_backtest',
    review_status: 'candidate',
    derivation_run_id: null,
    thesis_id: thesis.thesis_id,
    thesis_basis: thesis.thesis_basis,
    as_of: thesis.as_of,
    backtest_ids: backtestIds,
    transcript_hash: transcript.transcript_hash,
    created_at: timestamp,
    updated_at: timestamp,
  }
  const storyboard: VideoStoryboard = {
    storyboard_id: storyboardId,
    narrative_id: narrativeId,
    revision: 1,
    schema_version: 'fina-slides-v1',
    review_status: 'draft',
    thesis_id: thesis.thesis_id,
    backtest_refs: backtestIds,
    source_transcript_hash: transcript.transcript_hash,
    created_at: timestamp,
    updated_at: timestamp,
  }

  let startMs = 0
  const slides: VideoStoryboardSlide[] = beatInputs.map((beatInput, ordinal) => {
    const duration = slideDurationMs(beatInput.narration)
    const sceneId = makeId('scene')
    const shotId = makeId('shot')
    const specId = makeId('visual-spec')
    const scene: VideoScene = {
      scene_id: sceneId,
      storyboard_id: storyboardId,
      revision: 1,
      ordinal,
      purpose: beatInput.purpose,
      narration_text: beatInput.narration,
      visual_intent: beatInput.template,
      duration_ms: duration,
      created_at: timestamp,
      updated_at: timestamp,
    }
    const shot: VideoShot = {
      shot_id: shotId,
      scene_id: sceneId,
      revision: 1,
      ordinal: 0,
      shot_type: beatInput.template,
      duration_ms: duration,
      camera_motion: 'static',
      visual_prompt: beatInput.visualPrompt,
      status: 'planned',
      created_at: timestamp,
      updated_at: timestamp,
    }
    const visualSpec: VideoVisualSpec = {
      spec_id: specId,
      revision: 1,
      schema_version: 'video-visual-spec-v1',
      project_id: project.project_id,
      episode_id: episode.episode_id,
      scene_id: sceneId,
      shot_id: shotId,
      template: beatInput.template,
      duration_ms: duration,
      width: 1280,
      height: 720,
      fps: 30,
      payload: beatInput.payload,
      sources: beatInput.sources,
      deterministic: true,
      created_at: timestamp,
    }
    const audioCue: VideoAudioCue = {
      cue_id: makeId('audio-cue'),
      narration_text: beatInput.narration,
      start_ms: startMs,
      duration_ms: duration,
      status: 'not_configured',
      asset_id: null,
    }
    startMs += duration
    return {
      slide_id: `slide-${ordinal + 1}`,
      ordinal,
      purpose: beatInput.purpose,
      scene,
      shots: [shot],
      audio_cue: audioCue,
      visual_spec: visualSpec,
      evidence: beatInput.evidence,
    }
  })

  const firstEventId = evidenceClaims[0].event.event_id
  return {
    narrative,
    storyboard,
    document: {
      schema_version: 'fina-slides-v1',
      storyboard_id: storyboardId,
      narrative_id: narrativeId,
      source_event_id: firstEventId,
      audio_provider_state: 'not_configured',
      slides,
      thesis_id: thesis.thesis_id,
      backtest_refs: backtestIds,
      source_transcript_hash: transcript.transcript_hash,
    },
    scenes: slides.map((slide) => slide.scene),
    shots: slides.flatMap((slide) => slide.shots),
    visualSpecs: slides.map((slide) => slide.visual_spec),
  }
}

const LINKZAG_PAYLOAD_KINDS = ['evidence_card', 'quote_card', 'kinetic_text', 'chart_transition', 'caption', 'scene_transition'] as const

/**
 * Mirror of `compile_scene` in crates/nip-engine/src/linkzag.rs (shape
 * validation only — no render): every slide's payload kind must be one
 * `compile_scene` accepts, its required fields must be present, and every
 * slide must carry at least one evidence ref and one visual source. A
 * storyboard that passes this cannot fail render on payload shape; the
 * scene checksum itself is computed by the renderer at render time.
 */
export function validateStoryboardForLinkZag(document: VideoStoryboardDocument): string[] {
  const errors: string[] = []
  if (!document.slides.length) errors.push('Storyboard has no slides.')
  let expectedStart = 0
  document.slides.forEach((slide, index) => {
    const label = `Slide ${index + 1} (${slide.purpose})`
    const spec = slide.visual_spec
    const kind = (spec.payload as { kind?: string }).kind ?? spec.template
    if (!(LINKZAG_PAYLOAD_KINDS as readonly string[]).includes(kind)) {
      errors.push(`${label}: unsupported visual payload kind ${kind} — linkzag compile_scene rejects it.`)
    }
    if (kind === 'evidence_card') {
      const payload = spec.payload as { title?: string; body?: string }
      if (!payload.title?.trim()) errors.push(`${label}: evidence_card payload needs a title.`)
      if (!payload.body?.trim()) errors.push(`${label}: evidence_card payload needs a body.`)
    }
    if (kind === 'quote_card' && !(spec.payload as { quote?: string }).quote?.trim()) {
      errors.push(`${label}: quote_card payload needs a quote.`)
    }
    if ((kind === 'kinetic_text' || kind === 'caption') && !(spec.payload as { text?: string }).text?.trim()) {
      errors.push(`${label}: ${kind} payload needs text.`)
    }
    if (kind === 'chart_transition' && !(spec.payload as { title?: string }).title?.trim()) {
      errors.push(`${label}: chart_transition payload needs a title.`)
    }
    if (!slide.evidence.length) errors.push(`${label}: no evidence ref — every slide needs at least one.`)
    if (!spec.sources.length) errors.push(`${label}: no visual source — every spec needs at least one source.`)
    for (const ref of slide.evidence) {
      if (!['event', 'claim', 'backtest', 'thesis'].includes(ref.evidence_kind)) {
        errors.push(`${label}: evidence kind ${ref.evidence_kind} is not a validated video evidence kind.`)
      }
      if (!ref.evidence_id.trim()) errors.push(`${label}: evidence ref with an empty id.`)
    }
    if (!slide.scene.duration_ms || slide.scene.duration_ms <= 0) errors.push(`${label}: duration_ms must be positive.`)
    if (!slide.audio_cue.narration_text?.trim()) errors.push(`${label}: audio cue has no narration text.`)
    if (slide.audio_cue.start_ms !== expectedStart) errors.push(`${label}: audio cue starts at ${slide.audio_cue.start_ms}ms, expected ${expectedStart}ms.`)
    expectedStart += slide.scene.duration_ms ?? 0
  })
  return errors
}
