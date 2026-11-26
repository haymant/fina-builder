import type {
  VideoAudioCue,
  VideoEvidenceRef,
  VideoEpisode,
  VideoNarrative,
  VideoProject,
  VideoScene,
  VideoShot,
  VideoSourceEvent,
  VideoStoryboard,
  VideoStoryboardDocument,
  VideoStoryboardSlide,
  VideoVisualSpec,
} from './types'
import type { NipClaimEvidence } from '../narrative/types'
import { exactClaimEvidenceForEvent } from './claim-selection'

export interface VideoStoryboardDraft {
  narrative: VideoNarrative
  storyboard: VideoStoryboard
  document: VideoStoryboardDocument
  scenes: VideoScene[]
  shots: VideoShot[]
  visualSpecs: VideoVisualSpec[]
}

export interface SelectedVideoClaim {
  claim: import('../narrative/types').NipClaim
  evidence: NipClaimEvidence[]
}

/** Build a claim-only storyboard from explicit user selections and verified source spans. */
export function buildSelectedClaimsStoryboard(
  event: VideoSourceEvent,
  selectedClaims: SelectedVideoClaim[],
  project: VideoProject,
  episode: VideoEpisode,
  makeId: (prefix: string) => string,
  timestamp: string,
): VideoStoryboardDraft {
  if (!event.content_text?.trim()) throw new Error('The retained event has no transcript text to plan from.')
  if (!selectedClaims.length) throw new Error('Select at least one retained claim with verified transcript evidence.')

  const normalized = selectedClaims.map(({ claim, evidence: inputEvidence }) => {
    const evidence = exactClaimEvidenceForEvent(event, inputEvidence)
    if (!evidence.length) throw new Error(`Claim ${claim.claim_id} has no exact matching transcript span and cannot be storyboarded.`)
    if (!claim.claim_text.trim()) throw new Error(`Claim ${claim.claim_id} has no claim text.`)
    return { claim, evidence }
  })

  const narrativeId = makeId('narrative')
  const storyboardId = makeId('storyboard')
  const selectedRunIds = [...new Set(normalized.map(({ claim }) => claim.extraction_run_id))]
  const narrative: VideoNarrative = {
    narrative_id: narrativeId,
    episode_id: episode.episode_id,
    revision: 1,
    summary: `Storyboard draft from ${normalized.length} explicitly selected retained NIP claim${normalized.length === 1 ? '' : 's'}; claims remain unreviewed.`,
    thesis: 'Use only selected claim text and its exact transcript citations; this is not independent verification.',
    analysis_mode: 'deterministic_candidate',
    review_status: 'candidate',
    derivation_run_id: selectedRunIds.length === 1 ? selectedRunIds[0] : null,
    created_at: timestamp,
    updated_at: timestamp,
  }
  const storyboard: VideoStoryboard = {
    storyboard_id: storyboardId,
    narrative_id: narrativeId,
    revision: 1,
    schema_version: 'fina-slides-v1',
    review_status: 'draft',
    created_at: timestamp,
    updated_at: timestamp,
  }

  let startMs = 0
  const slides: VideoStoryboardSlide[] = normalized.map(({ claim, evidence: claimEvidence }, ordinal) => {
    const primary = claimEvidence[0]
    const speaker = claim.speaker_or_author?.trim() || null
    const attribution = speaker ? `an extracted claim attributed to ${speaker}` : 'an extracted claim'
    const narration = `${attribution[0].toUpperCase()}${attribution.slice(1)} states: ${claim.claim_text}. Supporting transcript excerpt: “${primary.quote}”.`
    const duration = fullNarrationDuration(narration)
    const sceneId = makeId('scene')
    const shotId = makeId('shot')
    const specId = makeId('visual-spec')
    const scene: VideoScene = {
      scene_id: sceneId,
      storyboard_id: storyboardId,
      revision: 1,
      ordinal,
      purpose: `Selected claim ${ordinal + 1}`,
      narration_text: narration,
      visual_intent: 'evidence_card',
      duration_ms: duration,
      created_at: timestamp,
      updated_at: timestamp,
    }
    const shot: VideoShot = {
      shot_id: shotId,
      scene_id: sceneId,
      revision: 1,
      ordinal: 0,
      shot_type: 'evidence_card',
      duration_ms: duration,
      camera_motion: 'static',
      visual_prompt: 'Show the selected extracted claim beside its exact transcript evidence.',
      status: 'planned',
      created_at: timestamp,
      updated_at: timestamp,
    }
    const sources = claimEvidence.flatMap((item) => [
      {
        source_kind: 'claim' as const,
        source_id: claim.claim_id,
        source_revision: null,
        start_offset: item.start_offset,
        end_offset: item.end_offset,
        quote: item.quote,
      },
      {
        source_kind: 'event' as const,
        source_id: event.event_id,
        source_revision: null,
        start_offset: item.start_offset,
        end_offset: item.end_offset,
        quote: item.quote,
      },
    ])
    const visualSpec: VideoVisualSpec = {
      spec_id: specId,
      revision: 1,
      schema_version: 'video-visual-spec-v1',
      project_id: project.project_id,
      episode_id: episode.episode_id,
      scene_id: sceneId,
      shot_id: shotId,
      template: 'evidence_card',
      duration_ms: duration,
      width: 1280,
      height: 720,
      fps: 30,
      payload: {
        kind: 'evidence_card',
        title: speaker ? `Claim attributed to ${speaker}` : 'Selected extracted claim',
        body: `Claim: ${claim.claim_text}\n\nSupporting transcript quote: “${primary.quote}”`,
        disclosure: 'Exact quote matched; claim support unverified.',
      },
      sources,
      deterministic: true,
      created_at: timestamp,
    }
    const slideEvidence: VideoEvidenceRef[] = claimEvidence.flatMap((item) => [
      { evidence_kind: 'claim', evidence_id: claim.claim_id, start_offset: item.start_offset, end_offset: item.end_offset, quote: item.quote },
      { evidence_kind: 'event', evidence_id: event.event_id, start_offset: item.start_offset, end_offset: item.end_offset, quote: item.quote },
    ])
    const audioCue: VideoAudioCue = {
      cue_id: makeId('audio-cue'),
      narration_text: narration,
      start_ms: startMs,
      duration_ms: duration,
      status: 'not_configured',
      asset_id: null,
    }
    startMs += duration
    return {
      slide_id: `slide-${ordinal + 1}`,
      ordinal,
      purpose: `Selected claim ${ordinal + 1}`,
      scene,
      shots: [shot],
      audio_cue: audioCue,
      visual_spec: visualSpec,
      evidence: slideEvidence,
    }
  })

  return {
    narrative,
    storyboard,
    document: {
      schema_version: 'fina-slides-v1',
      storyboard_id: storyboardId,
      narrative_id: narrativeId,
      source_event_id: event.event_id,
      audio_provider_state: 'not_configured',
      slides,
    },
    scenes: slides.map((slide) => slide.scene),
    shots: slides.flatMap((slide) => slide.shots),
    visualSpecs: slides.map((slide) => slide.visual_spec),
  }
}

export function buildTranscriptStoryboard(
  event: VideoSourceEvent,
  project: VideoProject,
  episode: VideoEpisode,
  makeId: (prefix: string) => string,
  timestamp: string,
): VideoStoryboardDraft {
  const transcript = event.content_text ?? ''
  if (!transcript.trim()) throw new Error('The retained event has no transcript text to plan from.')

  const narrativeId = makeId('narrative')
  const storyboardId = makeId('storyboard')
  const narrative: VideoNarrative = {
    narrative_id: narrativeId,
    episode_id: episode.episode_id,
    revision: 1,
    summary: 'Deterministic commentary candidate grounded in one retained event transcript.',
    // Event explainer: there is no thesis here. A null thesis is honest;
    // the old hardcoded disclaimer string pretended to be one.
    thesis: null,
    analysis_mode: 'deterministic_candidate',
    review_status: 'candidate',
    derivation_run_id: null,
    created_at: timestamp,
    updated_at: timestamp,
  }
  const storyboard: VideoStoryboard = {
    storyboard_id: storyboardId,
    narrative_id: narrativeId,
    revision: 1,
    schema_version: 'fina-slides-v1',
    review_status: 'draft',
    created_at: timestamp,
    updated_at: timestamp,
  }

  const { text: excerpt, start: excerptStart } = firstSentence(transcript)
  const excerptEnd = excerptStart + excerpt.length
  const sourceLabel = event.source_native_id?.trim() || event.event_id
  const beatSpecs = [
    {
      purpose: 'Hook and source',
      narration: 'Today, we are reviewing one retained event transcript—not treating it as independently verified.',
      visualIntent: 'evidence_card' as const,
      payload: {
        kind: 'evidence_card' as const,
        title: project.title,
        body: `A source-linked commentary draft · ${sourceLabel}`,
        disclosure: 'Candidate narration · source truth remains in NIP',
      },
      evidence: evidence(event.event_id),
    },
    {
      purpose: 'What the transcript says',
      narration: `The transcript states: “${excerpt}”`,
      visualIntent: 'quote_card' as const,
      payload: {
        kind: 'quote_card' as const,
        quote: excerpt,
        speaker: null,
        source_label: sourceLabel,
      },
      evidence: evidence(event.event_id, excerptStart, excerptEnd, excerpt),
    },
    {
      purpose: 'Commentary and caveat',
      narration: 'A single transcript is not independent confirmation. Compare this account with other retained evidence before reaching a conclusion.',
      visualIntent: 'kinetic_text' as const,
      payload: {
        kind: 'kinetic_text' as const,
        text: 'One transcript is a starting point—not a conclusion.',
      },
      evidence: evidence(event.event_id),
    },
  ]

  let startMs = 0
  const slides: VideoStoryboardSlide[] = beatSpecs.map((beat, ordinal) => {
    const sceneId = makeId('scene')
    const shotId = makeId('shot')
    const specId = makeId('visual-spec')
    const sceneDuration = narrationDuration(beat.narration)
    const scene: VideoScene = {
      scene_id: sceneId,
      storyboard_id: storyboardId,
      revision: 1,
      ordinal,
      purpose: beat.purpose,
      narration_text: beat.narration,
      visual_intent: beat.visualIntent,
      duration_ms: sceneDuration,
      created_at: timestamp,
      updated_at: timestamp,
    }
    const shot: VideoShot = {
      shot_id: shotId,
      scene_id: sceneId,
      revision: 1,
      ordinal: 0,
      shot_type: beat.visualIntent,
      duration_ms: sceneDuration,
      camera_motion: 'static',
      visual_prompt: beat.purpose,
      status: 'planned',
      created_at: timestamp,
      updated_at: timestamp,
    }
    const spec: VideoVisualSpec = {
      spec_id: specId,
      revision: 1,
      schema_version: 'video-visual-spec-v1',
      project_id: project.project_id,
      episode_id: episode.episode_id,
      scene_id: sceneId,
      shot_id: shotId,
      template: beat.visualIntent,
      duration_ms: sceneDuration,
      width: 1280,
      height: 720,
      fps: 30,
      payload: beat.payload,
      sources: [{
        source_kind: 'event',
        source_id: event.event_id,
        source_revision: null,
        start_offset: beat.evidence[0].start_offset,
        end_offset: beat.evidence[0].end_offset,
        quote: beat.evidence[0].quote,
      }],
      deterministic: true,
      created_at: timestamp,
    }
    const audioCue: VideoAudioCue = {
      cue_id: makeId('audio-cue'),
      narration_text: beat.narration,
      start_ms: startMs,
      duration_ms: sceneDuration,
      status: 'not_configured',
      asset_id: null,
    }
    startMs += sceneDuration
    return {
      slide_id: `slide-${ordinal + 1}`,
      ordinal,
      purpose: beat.purpose,
      scene,
      shots: [shot],
      audio_cue: audioCue,
      visual_spec: spec,
      evidence: beat.evidence,
    }
  })

  return {
    narrative,
    storyboard,
    document: {
      schema_version: 'fina-slides-v1',
      storyboard_id: storyboardId,
      narrative_id: narrativeId,
      source_event_id: event.event_id,
      audio_provider_state: 'not_configured',
      slides,
    },
    scenes: slides.map((slide) => slide.scene),
    shots: slides.flatMap((slide) => slide.shots),
    visualSpecs: slides.map((slide) => slide.visual_spec),
  }
}

function firstSentence(transcript: string): { text: string; start: number } {
  const match = /[^.!?]+(?:[.!?]+|$)/u.exec(transcript)
  const raw = match?.[0] ?? transcript
  const leading = raw.length - raw.trimStart().length
  const start = (match?.index ?? 0) + leading
  const sentence = raw.trim()
  if (sentence.length <= 220) return { text: sentence, start }
  const truncated = sentence.slice(0, 220)
  const lastSpace = truncated.lastIndexOf(' ')
  const text = truncated.slice(0, lastSpace > 120 ? lastSpace : 220).replace(/[\s,;:]+$/u, '')
  return { text, start }
}

function narrationDuration(text: string): number {
  const words = text.trim().split(/\s+/u).length
  return Math.max(6_000, Math.min(14_000, Math.ceil((words / 2.4 + 1.5) * 1_000)))
}

function fullNarrationDuration(text: string): number {
  const words = text.trim().split(/\s+/u).length
  return Math.max(6_000, Math.ceil((words / 2.4 + 1.5) * 1_000))
}

function evidence(eventId: string, start?: number, end?: number, quote?: string): VideoEvidenceRef[] {
  return [{
    evidence_kind: 'event',
    evidence_id: eventId,
    start_offset: start ?? null,
    end_offset: end ?? null,
    quote: quote ?? null,
  }]
}
