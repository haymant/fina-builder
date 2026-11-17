import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ClaimExplorer, EpisodePanel, OperationalMonitor, ProviderStatusPanel, SetupChecklist } from '../components/NarrativeWorkspace'
import type { NipClaim, NipEvent, NipExtractionStatus, NipPodcastEpisode, NipPodcastSubscription, NipProviderStatus, NipResourceStatus } from '../types'

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

const providerStatus: NipProviderStatus = {
  configured: true,
  bridge_state: 'ready',
  provider_kind: 'remote',
  provider_id: 'provider-a',
  model: 'model-a',
  reasoning_effort: 'low',
  provider_api: 'chat',
  remote: true,
  consent: 'missing',
  consent_recorded_at: null,
  disclosure: 'Transcript text and the claim-extraction prompt will be sent to provider-a (model-a) for remote claim extraction.',
  extraction_state: 'consent_required',
  warnings: ['remote_consent_missing'],
}

describe('ProviderStatusPanel', () => {
  it('shows the selected remote binding, disclosure, and consent action before extraction', () => {
    render(<ProviderStatusPanel status={providerStatus} busy={false} onGrant={vi.fn()} onRevoke={vi.fn()} />)
    expect(screen.getByText('model-a')).toBeTruthy()
    expect(screen.getByText('provider-a')).toBeTruthy()
    expect(screen.getByText('remote')).toBeTruthy()
    expect(screen.getByText(/will be sent to provider-a \(model-a\)/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Allow remote extraction/ })).toBeTruthy()
  })

  it('shows unavailable bridge state without falling back to a fake provider', () => {
    render(<ProviderStatusPanel status={{ ...providerStatus, configured: false, bridge_state: 'not_configured', provider_kind: null, provider_id: null, model: null, remote: false, consent: 'not_required', extraction_state: 'unavailable', warnings: ['riga_bridge_not_configured'] }} busy={false} onGrant={vi.fn()} onRevoke={vi.fn()} />)
    expect(screen.getByText('Provider bridge not configured')).toBeTruthy()
    expect(screen.getByText(/does not fall back/)).toBeTruthy()
    expect(screen.getByText(/riga_bridge_not_configured/)).toBeTruthy()
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

const subscription: NipPodcastSubscription = {
  source_id: 'fixture-show',
  feed_url: 'http://127.0.0.1:8795/fixture/feed.xml',
  show_name: 'Illustrative Test Corpus',
  rights_statement: 'Approved for local processing.',
  rights_confirmed_at: '2026-11-16T09:00:00Z',
  state: 'active',
  last_checked_at: '2026-11-16T09:00:00Z',
  next_poll_at: '2026-11-16T15:00:00Z',
  last_error_code: null,
  consecutive_failures: 0,
}

const episode: NipPodcastEpisode = {
  source_id: 'fixture-show',
  source_native_id: 'nip-fixture-episode-1',
  canonical_url: 'http://127.0.0.1:8795/fixture/episode-1',
  title: 'Policy outlook fixture',
  enclosure_url: 'http://127.0.0.1:8795/fixture/episode-1.mp3',
  published_at: '2026-11-15T12:00:00Z',
  discovered_at: '2026-11-16T09:00:00Z',
  state: 'awaiting_local_transcription',
}

const health = { service: 'nip-engine', api_version: 1, readiness: 'ready' as const, schema_version: 8 }

describe('SetupChecklist', () => {
  it('shows the first-run steps and the next action when the provider needs consent', () => {
    render(<SetupChecklist health={health} provider={providerStatus} subscriptions={[]} events={[]} claims={[]} />)
    expect(screen.getByRole('region', { name: 'NIP setup checklist' })).toBeTruthy()
    expect(screen.getByText('Local service')).toBeTruthy()
    expect(screen.getByText('Extraction provider')).toBeTruthy()
    expect(screen.getByText('Consent needed')).toBeTruthy()
    expect(screen.getByText('Next')).toBeTruthy()
    expect(screen.getByText('1/5 complete')).toBeTruthy()
  })

  it('marks every step complete once claims retain source evidence', () => {
    render(<SetupChecklist health={health} provider={{ ...providerStatus, consent: 'granted', extraction_state: 'available' }} subscriptions={[subscription]} events={[event]} claims={[claim]} />)
    expect(screen.getByText('5/5 complete')).toBeTruthy()
    expect(screen.getAllByText('Complete')).toHaveLength(5)
  })
})

describe('EpisodePanel', () => {
  function renderPanel(overrides: Record<string, unknown> = {}) {
    const props = {
      subscriptions: [subscription],
      episodes: [episode],
      total: 1,
      loading: false,
      hasMore: false,
      filters: { sort: 'published_desc' as const, sourceId: 'all', title: '' },
      onFiltersChange: vi.fn(),
      onLoadMore: vi.fn(),
      busyKey: null,
      message: null,
      onTranscribe: vi.fn(),
      transcriptionAvailable: true,
      ...overrides,
    }
    return { props, ...render(<EpisodePanel {...props} />) }
  }

  it('offers local transcription for a discovered episode without implying a remote ASR fallback', () => {
    const { props } = renderPanel()
    expect(screen.getByText('Policy outlook fixture')).toBeTruthy()
    expect(screen.getByText('awaiting local transcription')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Transcribe locally/ }))
    expect(props.onTranscribe).toHaveBeenCalledWith(episode)
  })

  it('does not offer a dead transcribe action when local ASR is not configured', () => {
    renderPanel({ transcriptionAvailable: false })
    expect(screen.getByText(/Local ASR is not configured/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Transcribe locally/ })).toBeNull()
  })

  it('offers a retry after the local provider reported unavailable', () => {
    renderPanel({ episodes: [{ ...episode, state: 'transcription_unavailable' }] })
    expect(screen.getByRole('button', { name: /Retry local transcription/ })).toBeTruthy()
    expect(screen.queryByText(/will not upload audio/)).toBeNull()
  })

  it('explains a non-retryable transcription state without implying a remote fallback', () => {
    renderPanel({ episodes: [{ ...episode, state: 'not_eligible' }] })
    expect(screen.getByText(/will not upload audio or substitute a remote ASR service/)).toBeTruthy()
  })

  it('sends sort, source and title changes to the server-side query', () => {
    const { props } = renderPanel({ filters: { sort: 'published_desc', sourceId: 'all', title: '' } })
    fireEvent.change(screen.getByLabelText('Sort episodes'), { target: { value: 'title_asc' } })
    expect(props.onFiltersChange).toHaveBeenCalledWith({ sort: 'title_asc', sourceId: 'all', title: '' })
    fireEvent.change(screen.getByLabelText('Filter episodes by source'), { target: { value: 'fixture-show' } })
    expect(props.onFiltersChange).toHaveBeenCalledWith({ sort: 'published_desc', sourceId: 'fixture-show', title: '' })
    fireEvent.change(screen.getByLabelText('Filter episodes by title'), { target: { value: 'policy' } })
    expect(props.onFiltersChange).toHaveBeenCalledWith({ sort: 'published_desc', sourceId: 'all', title: 'policy' })
  })

  it('shows the next-page sentinel and reports the page count', () => {
    renderPanel({ total: 128, hasMore: true })
    expect(screen.getByText(/Showing 1 of 128 episodes/)).toBeTruthy()
    expect(screen.getByText(/Scroll for more episodes/)).toBeTruthy()
  })
})
