import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThesisView } from '../components/ThesisView'
import type { NipBacktestEvidence, NipClaim, NipEvent, NipNarrativeGraph, NipThesis, NipTranscript } from '../types'

const narrativeApiMock = vi.hoisted(() => ({
  listBacktestEvidence: vi.fn(),
  listTranscripts: vi.fn(),
  saveThesis: vi.fn(async (thesis: NipThesis) => thesis),
}))
const scraperApiMock = vi.hoisted(() => ({
  querySymbolFeatures: vi.fn(),
  queryTriage: vi.fn(),
}))
vi.mock('../api', () => ({ narrativeApi: narrativeApiMock }))
vi.mock('../scraperApi', () => ({ scraperApi: scraperApiMock }))

const claim1: NipClaim = {
  claim_id: 'claim-1', claim_text: 'NVDA guides above consensus.', speaker_or_author: 'CFO', confidence_millis: 910,
  extraction_run_id: 'run-1', provider: 'llm', model: 'm', prompt_version: 'v1', extracted_at: '2026-11-24T15:00:00Z',
  extraction_tier: 'tier2_llm', review_status: 'llm_verified',
  evidence: [{ event_id: 'event-1', quote: 'We guide above consensus.', start_offset: 0, end_offset: 26 }],
}
const claim2: NipClaim = {
  claim_id: 'claim-2', claim_text: 'Supply constraints ease next quarter.', speaker_or_author: 'CFO', confidence_millis: 600,
  extraction_run_id: 'run-1', provider: 'lexicon', model: 'm', prompt_version: 'v1', extracted_at: '2026-11-24T15:00:00Z',
  extraction_tier: 'tier0_lexicon', review_status: 'fast_glance',
  evidence: [{ event_id: 'event-2', quote: 'Constraints ease.', start_offset: 0, end_offset: 17 }],
}
const event1: NipEvent = {
  schema_version: 1, event_id: 'event-1', source_id: 'alpaca-news', source_native_id: 'nvda-call', canonical_url: null,
  content_hash: 'h1', content_text: 'We guide above consensus.',
  times: { published_at: '2026-11-24T14:00:00Z', source_updated_at: null, captured_at: '2026-11-24T15:00:00Z', ingested_at: '2026-11-24T15:01:00Z' }, revision_of: null,
}
const event2: NipEvent = {
  ...event1, event_id: 'event-2', source_id: 'nasdaq', source_native_id: 'nvda-note', content_text: 'Constraints ease.',
  times: { ...event1.times, published_at: '2026-11-23T14:00:00Z' },
}

function thesis(overrides: Partial<NipThesis> & { thesis_id: string }): NipThesis {
  return {
    title: 'NVDA long 1–3d', entity_symbol: 'NVDA', direction: 'long', horizon: '1–3 days',
    as_of: '2026-11-24T16:00:00Z', thesis_basis: 'llm_verified_only', confidence_millis: 800,
    reason: 'Guides above consensus with easing supply.', status: 'transcript_ready',
    invalidation_condition: 'Guide cut in the next print.', what_would_change_mind: 'A guide cut.',
    claim_ids: ['claim-1'], rejected_claims: [], created_at: '2026-11-24T16:00:00Z', updated_at: '2026-11-24T16:00:00Z',
    ...overrides,
  }
}

const verified = thesis({ thesis_id: 'thesis-verified' })
const provisional = thesis({
  thesis_id: 'thesis-provisional', thesis_basis: 'provisional_fast_glance', status: 'draft',
  as_of: '2026-11-23T16:00:00Z', claim_ids: ['claim-1', 'claim-2'],
})

const graph: NipNarrativeGraph = {
  graph_id: 'g1', derivation_run_id: 'run-g', algorithm_version: 'nip-graph-v1', created_at: '2026-11-24T16:00:00Z',
  nodes: [
    { node_id: 'event:event-1', node_type: 'event', label: 'nvda-call', evidence_event_ids: ['event-1'] },
    { node_id: 'claim:claim-1', node_type: 'claim', label: 'NVDA guides above consensus.', evidence_event_ids: ['event-1'] },
  ],
  edges: [],
}

const backtest: NipBacktestEvidence = {
  backtest_id: 'bt-1', thesis_id: 'thesis-verified', run_id_a: 'run-a', run_id_b: 'run-b',
  config_fingerprint: 'fp-1',
  metrics_a: { ic: 0.02, icir: 0.3, sharpe: 0.4, total_return: 0.03, max_drawdown: -0.05 },
  metrics_b: { ic: 0.06, icir: 0.9, sharpe: 1.2, total_return: 0.09, max_drawdown: -0.04 },
  delta: { ic: 0.04, icir: 0.6, sharpe: 0.8, total_return: 0.06, max_drawdown: 0.01 },
  verdict: 'supported', could_not_run_reason: null, recorded_at: '2026-11-24T17:00:00Z', source: 'fina-builder:tac-qlib-rd',
}

const transcript: NipTranscript = {
  transcript_id: 'tx-1', thesis_id: 'thesis-verified', transcript_hash: 'hash-abc',
  summary: 'NVDA guides above consensus.',
  beats: [{ ordinal: 1, title: 'Hook', script: 'NVDA guides above consensus.', evidence_refs: [{ kind: 'claim', claim_id: 'claim-1' }] }],
  fina_import_path: '/lake/_transcripts/thesis-verified.fina.json', created_at: '2026-11-24T17:00:00Z',
}

describe('ThesisView (revamp §c.5)', () => {
  it('shows the ablation delta and unlocks Send to Video for a verified thesis', async () => {
    narrativeApiMock.listBacktestEvidence.mockResolvedValue([backtest])
    narrativeApiMock.listTranscripts.mockResolvedValue([transcript])
    scraperApiMock.querySymbolFeatures.mockResolvedValue({
      entity: 'NVIDIA Corporation', symbol: 'NVDA', as_of: '2026-11-24T16:00:00Z',
      features_by_tier: { tier2_llm: { sentiment_24h: 0.6 } }, llm_verified_coverage: 0.8, mostly_fast_glance: false,
    })
    render(<ThesisView theses={[verified, provisional]} claims={[claim1, claim2]} events={[event1, event2]} graph={graph} asOf="2026-11-24T16:00:00Z" onChanged={vi.fn(async () => {})} onSendToVideo={vi.fn()} />)
    await waitFor(() => expect(screen.getByTestId('thesis-backtest-bt-1')).toBeTruthy())
    expect(screen.getByText(/thesis SUPPORTED by the backtest/)).toBeTruthy()
    expect(screen.getByTestId('thesis-backtest-bt-1').textContent).toContain('0.800')
    expect(screen.getByTestId('thesis-graph-coverage').textContent).toContain('Graph coverage: 1 of 1 cited claims appear in the NIP graph.')
    const send = screen.getByTestId('thesis-send-to-video')
    expect((send as HTMLButtonElement).disabled).toBe(false)
  })

  it('a provisional thesis is listed and badged but can never advance', async () => {
    narrativeApiMock.listBacktestEvidence.mockResolvedValue([])
    narrativeApiMock.listTranscripts.mockResolvedValue([])
    scraperApiMock.querySymbolFeatures.mockResolvedValue({
      entity: 'NVIDIA Corporation', symbol: 'NVDA', as_of: '2026-11-23T16:00:00Z',
      features_by_tier: {}, llm_verified_coverage: 0, mostly_fast_glance: true,
    })
    render(<ThesisView theses={[verified, provisional]} claims={[claim1, claim2]} events={[event1, event2]} graph={graph} asOf="2026-11-24T16:00:00Z" onChanged={vi.fn(async () => {})} onSendToVideo={vi.fn()} />)
    fireEvent.click(screen.getByTestId('thesis-row-thesis-provisional'))
    await waitFor(() => expect(screen.getByTestId('thesis-provisional-gate')).toBeTruthy())
    expect(screen.getByTestId('thesis-provisional-gate').textContent).toContain('can never enter backtested')
    const advance = screen.getByTestId('thesis-advance-llm_reviewed')
    expect((advance as HTMLButtonElement).disabled).toBe(true)
    // The baseline-e2e rule: the graph holds only 1 of the 2 cited claims.
    expect(screen.getByTestId('thesis-graph-coverage').textContent).toContain('Graph coverage: 1 of 2 cited claims appear in the NIP graph.')
    expect(screen.getByTestId('thesis-graph-coverage').textContent).toContain('Supply constraints ease next quarter.')
    expect(screen.getByTestId('thesis-graph-coverage').textContent).toContain('not complete corroboration')
    expect(screen.getByTestId('thesis-send-to-video').textContent).toBe('Send to Video')
    expect((screen.getByTestId('thesis-send-to-video') as HTMLButtonElement).disabled).toBe(true)
  })
})
