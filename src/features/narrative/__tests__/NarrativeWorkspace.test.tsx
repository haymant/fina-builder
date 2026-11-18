import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ClaimExplorer, EpisodePanel, GraphExplorer, NarrativeWorkspace, OperationalMonitor, ProviderStatusPanel, SetupChecklist, TranscriptDialog } from '../components/NarrativeWorkspace'
import type { NipClaim, NipEvent, NipExtractionStatus, NipNarrativeGraph, NipPodcastEpisode, NipPodcastSubscription, NipProviderStatus, NipResourceStatus } from '../types'

const narrativeApiMock = vi.hoisted(() => ({
  health: vi.fn(), capabilities: vi.fn(), searchEvents: vi.fn(), listClaims: vi.fn(),
  listPodcastSubscriptions: vi.fn(), listSources: vi.fn(), listNarrativeClusters: vi.fn(),
  signalSnapshot: vi.fn(), listEtfMappings: vi.fn(), listEditorialCandidates: vi.fn(),
  resourceStatus: vi.fn(), extractionStatus: vi.fn(), listNarrativeGraph: vi.fn(),
  providerStatus: vi.fn(), listPodcastTranscriptionJobs: vi.fn(), asrStatus: vi.fn(),
  extractClaimsFromEvent: vi.fn(),
  listMediaArtifacts: vi.fn(), listEpisodePage: vi.fn(), rebuildNarrativeClusters: vi.fn(),
  rebuildNarrativeGraph: vi.fn(), refreshDuePodcastFeeds: vi.fn(),
}))

vi.mock('../api', () => ({ narrativeApi: narrativeApiMock }))

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

  it('documents how to start the OpenCode adapter when that provider type cannot run', () => {
    render(<ProviderStatusPanel status={{ ...providerStatus, provider_type: 'opencode_open_ai_compatible', consent: 'granted', extraction_state: 'unavailable' }} busy={false} onGrant={vi.fn()} onRevoke={vi.fn()} />)
    expect(screen.getByText('How to start the OpenCode adapter')).toBeTruthy()
    expect(screen.getByText(/npm run build --workspace @rigai\/opencode/)).toBeTruthy()
    expect(screen.getByText(/RIGA_OPENCODE_PORT=8791/)).toBeTruthy()
    expect(screen.getByText(/127\.0\.0\.1:8791\/v1/)).toBeTruthy()
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
    expect(screen.getByText(/Local ASR is unavailable/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Transcribe locally/ })).toBeNull()
  })

  it('offers a publisher transcript even when local ASR is unavailable', () => {
    const onTranscribe = vi.fn()
    renderPanel({ episodes: [{ ...episode, transcript_url: 'https://cdn.test/episode-1.vtt', transcript_type: 'text/vtt' }], transcriptionAvailable: false, onTranscribe })
    expect(screen.getByText(/can still be transcribed without it/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Use publisher transcript/ }))
    expect(onTranscribe).toHaveBeenCalled()
  })

  it('shows the exact ASR blockers instead of the button when the capability is stale', () => {
    const asrStatus = {
      ready: false, configured: true, comfyui_url: 'http://127.0.0.1:8190', workspace: '/repo/modules/comfy',
      workspace_present: true, render_script: '/repo/modules/comfy/scripts/render.py', render_script_present: true,
      repo_url: 'https://github.com/haymant/comfyui-flows.git', chunk_seconds: 45, python: 'python3',
      python_present: true, ffmpeg_present: true, server_reachable: false, server_device: null,
      asr_nodes_present: false, pack_commit: '3de8194',
      blockers: ['ComfyUI is not reachable at http://127.0.0.1:8190'],
      next_actions: ['Start ComfyUI Desktop (or scripts/open_comfyui.sh) and retry.'],
    }
    renderPanel({ asrStatus, onPrepareWorkspace: vi.fn(), onRefreshAsr: vi.fn() })
    expect(screen.getByTestId('asr-blockers').textContent).toContain('ComfyUI is not reachable')
    expect(screen.queryByRole('button', { name: /Transcribe locally/ })).toBeNull()
  })

  it('shows the failing step and cached audio for a job attached to the episode', () => {
    const job = {
      job_id: 'job-9', source_id: 'fixture-show', source_native_id: 'nip-fixture-episode-1', canonical_url: null,
      title: 'Policy outlook fixture', state: 'failed', step: 'transcribe', detail: 'chunk 3/7',
      error_code: 'transcription_oom', error_message: 'local ASR ran out of GPU memory', audio_bytes: 31457280,
      audio_content_type: 'audio/mpeg', audio_path: '/tmp/source.mp3', audio_url_path: 'job-9/source.mp3',
      audio_duration_seconds: 1500, chunks_total: 7, chunks_completed: 2, transcript_characters: null,
      transcript_preview: null, transcript_path: null, event_id: null, warnings: [], started_at: '2026-11-18T01:00:00Z',
      updated_at: '2026-11-18T01:01:00Z', finished_at: '2026-11-18T01:01:00Z', events: [],
    }
    renderPanel({ jobs: [job], mediaBase: 'http://127.0.0.1:1/media' })
    expect(screen.getByText(/Failed at transcribe/)).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('local ASR ran out of GPU memory')
    expect(screen.getByTestId('cached-audio-player').getAttribute('src')).toBe('http://127.0.0.1:1/media/job-9/source.mp3')
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

  it('links a transcribed episode to its retained transcript event', () => {
    const onOpenTranscript = vi.fn()
    renderPanel({ episodes: [{ ...episode, state: 'transcribed' }], onOpenTranscript })
    fireEvent.click(screen.getByRole('button', { name: /Open retained transcript/ }))
    expect(onOpenTranscript).toHaveBeenCalledWith({ ...episode, state: 'transcribed' })
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

const graph: NipNarrativeGraph = {
  graph_id: 'graph-1',
  derivation_run_id: 'graph-run-1',
  algorithm_version: 'nip-graph-v1',
  created_at: '2026-11-18T01:00:00Z',
  nodes: [
    { node_id: 'event:event-fixture-1', node_type: 'event', label: 'episode-1', evidence_event_ids: ['event-fixture-1'] },
    { node_id: 'claim:claim-fixture-1', node_type: 'claim', label: 'Policy remains restrictive.', evidence_event_ids: ['event-fixture-1'] },
  ],
  edges: [
    { edge_id: 'edge:claim:1', from_node_id: 'claim:claim-fixture-1', to_node_id: 'event:event-fixture-1', edge_type: 'claim_support', evidence_event_ids: ['event-fixture-1'], confidence_millis: 920, derivation_run_id: 'graph-run-1' },
  ],
}

describe('GraphExplorer', () => {
  it('shows retained origins and links each node and edge back to its event', () => {
    const onOpenEvent = vi.fn()
    render(<GraphExplorer graph={graph} events={[event]} onOpenEvent={onOpenEvent} />)
    expect(screen.getByText('Retained origins')).toBeTruthy()
    expect(screen.getByText('1 retained origins')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'episode-1' }))
    expect(onOpenEvent).toHaveBeenCalledWith('event-fixture-1')
    fireEvent.click(screen.getAllByRole('button', { name: /Origin episode-1/ })[0])
    expect(onOpenEvent).toHaveBeenCalledWith('event-fixture-1')
  })

  it('explains the prerequisites when the projection has no origin nodes', () => {
    const onBackToEvents = vi.fn()
    render(<GraphExplorer graph={{ ...graph, nodes: [], edges: [] }} events={[event]} onOpenEvent={vi.fn()} onBackToEvents={onBackToEvents} />)
    expect(screen.getByTestId('graph-empty').textContent).toContain('no origin nodes yet')
    fireEvent.click(screen.getByRole('button', { name: /Open retained events/ }))
    expect(onBackToEvents).toHaveBeenCalled()
  })

  it('renders an interactive map and keeps edge labels quiet until asked', () => {
    render(<GraphExplorer graph={graph} events={[event]} onOpenEvent={vi.fn()} />)
    expect(screen.getByTestId('narrative-graph')).toBeTruthy()
    const nodeLabels = screen.getByRole('button', { name: 'Node labels' })
    const edgeLabels = screen.getByRole('button', { name: 'Edge labels' })
    const colourByCluster = screen.getByRole('button', { name: 'Colour by cluster' })
    expect(nodeLabels.getAttribute('aria-pressed')).toBe('true')
    expect(edgeLabels.getAttribute('aria-pressed')).toBe('false')
    expect(colourByCluster.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(edgeLabels)
    fireEvent.click(nodeLabels)
    fireEvent.click(colourByCluster)
    expect(edgeLabels.getAttribute('aria-pressed')).toBe('true')
    expect(nodeLabels.getAttribute('aria-pressed')).toBe('false')
    expect(colourByCluster.getAttribute('aria-pressed')).toBe('false')
  })
})

describe('TranscriptDialog', () => {
  it('shows the full transcript in a card and closes on Escape', () => {
    const onClose = vi.fn()
    render(<TranscriptDialog event={event} busy={false} status={null} extractionAvailable={false} onClose={onClose} onExtract={vi.fn()} onOpenInList={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'Retained transcript' })).toBeTruthy()
    expect(screen.getByText('Rates remain restrictive until inflation cools.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Extract claims/ })).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('offers extraction and a link to the event list only when available', () => {
    const onExtract = vi.fn()
    const onOpenInList = vi.fn()
    render(<TranscriptDialog event={event} busy={false} status="3 claims committed" extractionAvailable onClose={vi.fn()} onExtract={onExtract} onOpenInList={onOpenInList} />)
    fireEvent.click(screen.getByRole('button', { name: 'Extract claims' }))
    fireEvent.click(screen.getByRole('button', { name: 'Show in event list' }))
    expect(onExtract).toHaveBeenCalled()
    expect(onOpenInList).toHaveBeenCalled()
    expect(screen.getByText('3 claims committed')).toBeTruthy()
  })
})

const completedJob = {
  job_id: 'job-1', source_id: 'fixture-show', source_native_id: 'episode-1', canonical_url: null,
  title: 'Policy outlook fixture', state: 'transcribed', step: 'transcribed', detail: null,
  error_code: null, error_message: null, audio_bytes: null, audio_content_type: null, audio_path: null,
  audio_url_path: null, audio_duration_seconds: null, chunks_total: null, chunks_completed: 0,
  transcript_characters: 120, transcript_preview: 'Rates remain restrictive…', transcript_path: '/tmp/transcript.txt',
  event_id: 'event-fixture-1', warnings: [], started_at: '2026-11-18T01:00:00Z',
  updated_at: '2026-11-18T01:01:00Z', finished_at: '2026-11-18T01:01:00Z', events: [],
}

function stubWorkspaceApi() {
  narrativeApiMock.health.mockResolvedValue({ schema_version: 10, api_version: '0.1.0' })
  narrativeApiMock.capabilities.mockResolvedValue({ features: { local_audio_transcription: true } })
  narrativeApiMock.searchEvents.mockResolvedValue({ events: [event], next_cursor: null })
  narrativeApiMock.listClaims.mockResolvedValue([])
  narrativeApiMock.listPodcastSubscriptions.mockResolvedValue([])
  narrativeApiMock.listSources.mockResolvedValue([])
  narrativeApiMock.listNarrativeClusters.mockResolvedValue([])
  narrativeApiMock.signalSnapshot.mockResolvedValue(null)
  narrativeApiMock.listEtfMappings.mockResolvedValue([])
  narrativeApiMock.listEditorialCandidates.mockResolvedValue([])
  narrativeApiMock.resourceStatus.mockResolvedValue(null)
  narrativeApiMock.extractionStatus.mockResolvedValue(null)
  narrativeApiMock.listNarrativeGraph.mockResolvedValue(null)
  narrativeApiMock.providerStatus.mockResolvedValue(null)
  narrativeApiMock.asrStatus.mockResolvedValue({ ready: true })
  narrativeApiMock.listMediaArtifacts.mockResolvedValue([])
  narrativeApiMock.listEpisodePage.mockResolvedValue({ episodes: [], total: 0, limit: 50, offset: 0, next_offset: null })
  narrativeApiMock.rebuildNarrativeClusters.mockResolvedValue([])
  narrativeApiMock.rebuildNarrativeGraph.mockResolvedValue(null)
  narrativeApiMock.extractClaimsFromEvent.mockResolvedValue([])
  narrativeApiMock.listPodcastTranscriptionJobs.mockResolvedValue([])
}

const availableProvider = {
  configured: true, bridge_state: 'ready' as const, provider_kind: 'remote', provider_id: 'provider-a',
  model: 'gpt-test', reasoning_effort: 'low', provider_api: 'chat', remote: true,
  consent: 'granted' as const, consent_recorded_at: '2026-11-18T01:00:00Z', disclosure: null,
  extraction_state: 'available' as const, warnings: [],
}

describe('claim extraction feedback', () => {
  it('reports a provider failure next to the action instead of failing silently', async () => {
    stubWorkspaceApi()
    narrativeApiMock.providerStatus.mockResolvedValue(availableProvider)
    narrativeApiMock.extractClaimsFromEvent.mockRejectedValueOnce(new Error('the provider run did not complete'))
    render(<NarrativeWorkspace />)
    await waitFor(() => expect(screen.getByText('episode-1')).toBeTruthy())
    fireEvent.click(screen.getByText('episode-1'))
    const extract = await screen.findByRole('button', { name: 'Extract claims' })
    fireEvent.click(extract)
    const alerts = await screen.findAllByRole('alert')
    const alert = alerts.find((node) => node.textContent?.includes('provider run did not complete'))!
    expect(alert.textContent).toContain('the provider run did not complete')
    expect(alert.textContent).toContain('Check that the active provider')
    // The failed run re-reads the provider state instead of leaving the panel
    // claiming extraction is ready.
    await waitFor(() => expect(narrativeApiMock.providerStatus).toHaveBeenCalledTimes(2))
  })

  it('shows a failed extraction inside the transcript dialog as an alert', () => {
    render(<TranscriptDialog event={event} busy={false} status="the provider run did not complete" statusIsError extractionAvailable onClose={vi.fn()} onExtract={vi.fn()} onOpenInList={vi.fn()} />)
    expect(screen.getByRole('alert').textContent).toContain('the provider run did not complete')
  })
})

describe('NarrativeWorkspace derived projections', () => {
  it('rebuilds clusters and the graph after a background transcription commits', async () => {
    stubWorkspaceApi()
    const running = { ...completedJob, state: 'download', step: 'download', transcript_characters: null, event_id: null }
    narrativeApiMock.listPodcastTranscriptionJobs.mockResolvedValueOnce([running]).mockResolvedValue([completedJob])
    render(<NarrativeWorkspace />)
    await waitFor(() => expect(narrativeApiMock.rebuildNarrativeClusters).toHaveBeenCalled(), { timeout: 4000 })
    expect(narrativeApiMock.rebuildNarrativeGraph).toHaveBeenCalled()
    await waitFor(() => expect(screen.getByTestId('derived-refresh').textContent).toContain('Radar, Timeline, Graph and clusters'))
  }, 10000)

  it('does not re-derive jobs that finished before the workspace opened', async () => {
    stubWorkspaceApi()
    narrativeApiMock.listPodcastTranscriptionJobs.mockResolvedValue([completedJob])
    render(<NarrativeWorkspace />)
    await waitFor(() => expect(narrativeApiMock.listPodcastTranscriptionJobs).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(narrativeApiMock.rebuildNarrativeClusters).not.toHaveBeenCalled()
    expect(narrativeApiMock.rebuildNarrativeGraph).not.toHaveBeenCalled()
  })
})
