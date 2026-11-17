import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ClaimExplorer, OperationalMonitor } from '../components/NarrativeWorkspace'
import type { NipClaim, NipEvent, NipExtractionStatus, NipResourceStatus } from '../types'

const event: NipEvent = {
  schema_version: 1,
  event_id: 'event-fixture-1',
  source_id: 'fixture-show',
  source_native_id: 'episode-1',
  canonical_url: 'fixture://episode-1',
  content_hash: 'abc123',
  content_text: 'Rates remain restrictive until inflation cools.',
  times: { published_at: '2026-11-15T12:00:00Z', source_updated_at: null, captured_at: '2026-11-16T09:00:00Z', ingested_at: '2026-11-16T09:00:01Z' },
  revision_of: null,
}

const claim: NipClaim = {
  claim_id: 'claim-fixture-1',
  claim_text: 'Policy remains restrictive.',
  speaker_or_author: 'Synthetic analyst',
  confidence_millis: 920,
  extraction_run_id: 'run-fixture-1',
  provider: 'deterministic_fake',
  model: 'fixture-claim-model',
  prompt_version: 'nip-claims-v1',
  extracted_at: '2026-11-16T09:01:00Z',
  evidence: [{ event_id: 'event-fixture-1', quote: 'Rates remain restrictive until inflation cools.', start_offset: 0, end_offset: 48 }],
}

describe('ClaimExplorer', () => {
  it('renders provenance and evidence for the selected claim', () => {
    render(<ClaimExplorer claims={[claim]} events={[event]} onSelectClaim={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'Policy remains restrictive.' })).toBeTruthy()
    expect(screen.getByText('“Rates remain restrictive until inflation cools.”')).toBeTruthy()
    expect(screen.getByText('deterministic_fake')).toBeTruthy()
    expect(screen.getByText('fixture-show')).toBeTruthy()
  })

  it('selects another claim from the list', () => {
    const second = { ...claim, claim_id: 'claim-fixture-2', claim_text: 'Inflation is cooling.', evidence: [] }
    const onSelectClaim = vi.fn()
    render(<ClaimExplorer claims={[claim, second]} events={[event]} onSelectClaim={onSelectClaim} />)
    fireEvent.click(screen.getByRole('button', { name: /Inflation is cooling/ }))
    expect(onSelectClaim).toHaveBeenCalledWith(second)
  })
})

const resource: NipResourceStatus = {
  observed_at: '2026-11-17T12:00:00Z', database_path: '/tmp/nip.duckdb', database_bytes: 4096,
  event_count: 12, claim_count: 4, extraction_run_count: 2, cluster_count: 2, graph_edge_count: 7,
  scheduler_interval_seconds: 21600, scheduler_state: 'process_lifetime', semantic_index_state: 'ready',
  semantic_model: 'benchmark-financial-hash', warnings: [],
}

const extraction: NipExtractionStatus = {
  observed_at: '2026-11-17T12:00:00Z', state: 'succeeded', claim_count: 4, extraction_run_count: 2,
  latest_run_id: 'run-2', latest_provider: 'deterministic_fake', latest_model: 'fixture-claim-model',
  latest_prompt_version: 'nip-claims-v1', latest_extracted_at: '2026-11-17T11:59:00Z',
  evidence_linked_claim_count: 4, warnings: [],
}

describe('OperationalMonitor', () => {
  it('shows local resource counts, extraction provenance, graph edges, and scheduler cadence', () => {
    render(<OperationalMonitor resource={resource} extraction={extraction} />)
    expect(screen.getByText('12 events · 4096 B')).toBeTruthy()
    expect(screen.getByText('4 claims · 2 runs')).toBeTruthy()
    expect(screen.getByText('7 evidence edges')).toBeTruthy()
    expect(screen.getByText('Every 6h · process_lifetime')).toBeTruthy()
    expect(screen.getByText(/deterministic_fake \/ fixture-claim-model/)).toBeTruthy()
  })

  it('shows safe unavailable and warning states instead of fabricated success', () => {
    render(<OperationalMonitor resource={{ ...resource, semantic_index_state: 'not_built', warnings: ['semantic_index_not_built', 'graph_projection_not_built'] }} extraction={{ ...extraction, state: 'idle', claim_count: 0, extraction_run_count: 0, latest_run_id: null, latest_provider: null, latest_model: null, warnings: [] }} />)
    expect(screen.getByText('0 claims · 0 runs')).toBeTruthy()
    expect(screen.getByText('No extraction run has committed claims yet.')).toBeTruthy()
    expect(screen.getByText(/semantic_index_not_built · graph_projection_not_built/)).toBeTruthy()
  })

  it('renders a loading state when both status calls are pending', () => {
    render(<OperationalMonitor resource={null} extraction={null} />)
    expect(screen.getAllByText('Checking…')).toHaveLength(4)
    expect(screen.getByText('No extraction run has committed claims yet.')).toBeTruthy()
  })
})
