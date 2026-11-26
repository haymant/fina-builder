// Shared Playwright stub for revamp F7 (NIP_DASHBOARD_REVAMP.md §e.2).
//
// The narrative + video UIs talk to two MCP sidecars over Streamable HTTP:
//   - NIP:            /nip/mcp          (narrative ledger, theses, video records)
//   - fina-scraper:   /fina-scraper/mcp (lake status, schedules, radar signals)
//
// In the browser both are same-origin Vite proxies; `page.route` intercepts
// them before any network happens, so no sidecar, credential, or live call
// is needed. Every test gets a fresh `F7State` (mutable, so tests can
// assert what the UI sent: scrape_trigger args, save_thesis payloads, …).
import type { Page } from '@playwright/test'

export const AS_OF = '2026-11-24T16:00:00Z'

export const EVENT_TEXT =
  'The retained research team expects policy to remain restrictive until inflation cools. ' +
  'Demand for AI accelerators remains strong as data center spending grows. ' +
  'Supply constraints are easing as new fabrication capacity comes online.'

const charIndex = (quote: string): number => EVENT_TEXT.indexOf(quote)

const Q1 = 'policy to remain restrictive until inflation cools'
const Q2 = 'Demand for AI accelerators remains strong'
const Q3 = 'Supply constraints are easing'

export const SPANS = {
  q1: { start: charIndex(Q1), end: charIndex(Q1) + Q1.length, quote: Q1 },
  q2: { start: charIndex(Q2), end: charIndex(Q2) + Q2.length, quote: Q2 },
  q3: { start: charIndex(Q3), end: charIndex(Q3) + Q3.length, quote: Q3 },
}

export const eventF7 = {
  schema_version: 1,
  event_id: 'event-f7-1',
  source_id: 'src-pod-alpha',
  source_native_id: 'episode-f7-1',
  canonical_url: 'fixture://episode-f7-1',
  content_hash: 'f7-hash-123',
  content_text: EVENT_TEXT,
  times: {
    published_at: '2026-11-22T12:00:00Z',
    source_updated_at: null,
    captured_at: '2026-11-23T09:00:00Z',
    ingested_at: '2026-11-23T09:00:01Z',
  },
  revision_of: null,
}

function claim(id: string, text: string, tier: string, review: string, span: { start: number; end: number; quote: string }) {
  return {
    claim_id: id,
    claim_text: text,
    speaker_or_author: 'Retained research team',
    confidence_millis: 920,
    extraction_run_id: 'run-f7-1',
    provider: 'deterministic_fake',
    model: 'fixture-claim-model',
    prompt_version: 'nip-claims-v1',
    extracted_at: '2026-11-23T09:01:00Z',
    extraction_tier: tier,
    review_status: review,
    evidence: [{ event_id: eventF7.event_id, quote: span.quote, start_offset: span.start, end_offset: span.end }],
  }
}

export const claimsF7 = [
  claim('claim-f7-1', 'Policy is expected to remain restrictive until inflation cools.', 'tier2_llm', 'llm_verified', SPANS.q1),
  claim('claim-f7-2', 'Demand for AI accelerators remains strong.', 'tier2_llm', 'llm_verified', SPANS.q2),
  claim('claim-f7-3', 'Supply constraints are easing as new capacity comes online.', 'tier2_llm', 'llm_corrected', SPANS.q3),
  claim('claim-f7-t0', 'Policy is expected to remain restrictive (fast glance).', 'tier0_lexicon', 'fast_glance', SPANS.q1),
  claim('claim-f7-t1', 'Demand for AI accelerators remains strong (fast glance).', 'tier1_onnx', 'fast_glance', SPANS.q2),
  // Deliberately unverifiable span: the stored offsets point at the start of
  // the transcript, not at the quote, so video re-verification must block it.
  claim('claim-f7-bad', 'Policy is expected to remain restrictive until inflation cools.', 'tier2_llm', 'llm_verified', { start: 0, end: Q1.length, quote: Q1 }),
]

function thesis(id: string, title: string, basis: string, status: string, asOf: string, claimIds: string[]) {
  return {
    thesis_id: id,
    title,
    entity_symbol: 'NVDA',
    direction: 'long',
    horizon: '1-3d',
    as_of: asOf,
    thesis_basis: basis,
    confidence_millis: 780,
    reason: 'Three llm-verified claims agree that demand stays strong while policy stays restrictive.',
    status,
    invalidation_condition: 'NVDA guides data-center revenue down more than 10% next quarter.',
    what_would_change_mind: 'A material guide-down or a policy pivot.',
    claim_ids: claimIds,
    rejected_claims: [],
    created_at: asOf,
    updated_at: asOf,
  }
}

export const thesesF7 = [
  thesis('thesis-f7-good', 'NVDA long 1–3d on AI accelerator demand', 'llm_verified_only', 'backtested', '2026-11-24T16:00:00Z', ['claim-f7-1', 'claim-f7-2', 'claim-f7-3']),
  thesis('thesis-f7-prov', 'NVDA long (provisional, fast glance only)', 'provisional_fast_glance', 'draft', '2026-11-23T16:00:00Z', ['claim-f7-1']),
  thesis('thesis-f7-badspan', 'NVDA long on an unverifiable span', 'llm_verified_only', 'backtested', '2026-11-22T16:00:00Z', ['claim-f7-bad']),
]

export const transcriptF7Good = {
  transcript_id: 'transcript-f7-good',
  thesis_id: 'thesis-f7-good',
  transcript_hash: 'tx-hash-f7-good',
  summary: 'NVDA long 1–3d: demand strong, policy restrictive, supply easing.',
  beats: [
    { ordinal: 0, title: 'Hook', script: 'NVDA demand is strong while policy stays restrictive.', evidence_refs: [{ kind: 'claim', claim_id: 'claim-f7-1' }] },
    { ordinal: 1, title: 'What changed', script: 'Accelerator demand grew as data-center spending rose.', evidence_refs: [{ kind: 'claim', claim_id: 'claim-f7-2' }] },
    { ordinal: 2, title: 'Evidence 1', script: 'Policy is expected to remain restrictive until inflation cools.', evidence_refs: [{ kind: 'claim', claim_id: 'claim-f7-1' }] },
    { ordinal: 3, title: 'Evidence 2', script: 'Demand for AI accelerators remains strong.', evidence_refs: [{ kind: 'claim', claim_id: 'claim-f7-2' }] },
    { ordinal: 4, title: 'Evidence 3', script: 'Supply constraints are easing as new fabrication capacity comes online.', evidence_refs: [{ kind: 'claim', claim_id: 'claim-f7-3' }] },
    { ordinal: 5, title: 'The test', script: 'The ablation ran: Run B beat Run A out-of-sample by 0.12 Sharpe.', evidence_refs: [{ kind: 'backtest', backtest_id: 'backtest-f7-1' }] },
    { ordinal: 6, title: 'Invalidation', script: 'What would change my mind: NVDA guides data-center revenue down more than 10%.', evidence_refs: [] },
    { ordinal: 7, title: 'Caveat', script: 'This video states a thesis, not investment advice.', evidence_refs: [] },
  ],
  fina_import_path: null,
  created_at: '2026-11-24T16:00:00Z',
}

export const backtestF7Good = {
  backtest_id: 'backtest-f7-1',
  thesis_id: 'thesis-f7-good',
  run_id_a: 'run-a-f7',
  run_id_b: 'run-b-f7',
  config_fingerprint: 'cfg-f7-abc',
  metrics_a: { ic: 0.05, icir: 0.4, sharpe: 1.1, total_return: 0.08, max_drawdown: -0.06 },
  metrics_b: { ic: 0.13, icir: 0.9, sharpe: 1.22, total_return: 0.114, max_drawdown: -0.049 },
  delta: { ic: 0.08, icir: 0.5, sharpe: 0.12, total_return: 0.034, max_drawdown: 0.011 },
  verdict: 'supported',
  could_not_run_reason: null,
  recorded_at: '2026-11-24T16:00:00Z',
  source: 'tac-qlib ablation',
}

function source(id: string, kind: string, name: string, locator: string | null, state: string, topics: string[] = []) {
  return {
    source_id: id,
    kind,
    display_name: name,
    locator,
    rights_status: 'confirmed',
    rights_statement: 'Fixture rights confirmed.',
    topics,
    state,
    poll_interval_minutes: 15,
    per_scan_limit: 10,
    notes: null,
    created_at: '2026-11-20T09:00:00Z',
    updated_at: '2026-11-23T09:00:00Z',
    event_count: id === 'src-pod-alpha' ? 1 : 0,
    episode_count: 0,
  }
}

export const sourcesF7 = [
  source('src-pod-alpha', 'podcast', 'Alpha Podcast', 'https://example.test/alpha-feed.xml', 'active', ['macro', 'rates']),
  source('src-pod-beta', 'podcast', 'Beta Markets Daily', 'https://example.test/beta-feed.xml', 'active', ['markets']),
  source('src-pod-gamma', 'podcast', 'Gamma Earnings Calls', 'https://example.test/gamma-feed.xml', 'paused', ['earnings']),
  source('src-pod-delta', 'podcast', 'Delta Macro Weekly', 'https://example.test/delta-feed.xml', 'active', ['macro']),
  source('src-pod-epsilon', 'podcast', 'Epsilon Tech Talk', 'https://example.test/epsilon-feed.xml', 'active', ['tech']),
  source('src-mtg-nvda', 'company_meeting', 'NVDA Q3 Earnings Call', null, 'active', ['NVDA']),
  source('src-mtg-aapl', 'company_meeting', 'AAPL Q4 Earnings Call', null, 'active', ['AAPL']),
  source('src-fil-10k', 'filing', 'SEC 10-K Filings', 'https://example.test/sec-10k', 'active', ['filings']),
  source('src-fil-8k', 'filing', 'SEC 8-K Filings', 'https://example.test/sec-8k', 'active', ['filings']),
  source('alpaca-news', 'web', 'Alpaca News', 'https://example.test/alpaca-news', 'active', ['news']),
  source('nasdaq-news', 'web', 'Nasdaq News', 'https://example.test/nasdaq-news', 'active', ['news']),
  source('src-reddit-wsb', 'reddit', 'r/wallstreetbets', 'https://example.test/r-wsb', 'active', ['sentiment']),
  source('src-doc-local', 'local_document', 'Local Research Notes', null, 'active', ['research']),
]

export const subscriptionsF7 = ['src-pod-alpha', 'src-pod-beta', 'src-pod-gamma', 'src-pod-delta', 'src-pod-epsilon'].map((id, index) => ({
  source_id: id,
  feed_url: `https://example.test/${id.replace('src-pod-', '')}-feed.xml`,
  show_name: sourcesF7.find((s) => s.source_id === id)!.display_name,
  rights_statement: 'Fixture rights confirmed.',
  rights_confirmed_at: '2026-11-20T09:00:00Z',
  state: id === 'src-pod-gamma' ? 'paused' : 'active',
  last_checked_at: '2026-11-24T15:00:00Z',
  next_poll_at: '2026-11-24T16:00:00Z',
  last_error_code: null,
  consecutive_failures: 0,
  _index: index,
})).map(({ _index, ...rest }) => rest)

export function scraperStatusF7(schedules: Array<Record<string, unknown>>) {
  return {
    last_run: { run_id: 'run-f7-1', started_at: '2026-11-24T15:55:00Z', finished_at: '2026-11-24T15:58:00Z', status: 'succeeded', summary: { items: 12 }, outputs: null, error: null },
    lake: { items: 120, entities: 34, claims: 56, edges: 210, prices: 900, backtests: 3, max_ingested_at: AS_OF },
    schedules,
    budgets: { date: '2026-11-24', llm_daily_budget: 15, llm_reviews_today: 2, thesis_daily_budget: 3, theses_today: 1 },
  }
}

export function schedulesF7(): Array<Record<string, unknown>> {
  return [
    {
      site_id: 'alpaca-news', poll_interval_min: 5, enabled: true, llm_daily_budget: 15, thesis_daily_budget: 3,
      last_run: { run_id: 'run-f7-1', started_at: '2026-11-24T15:55:00Z', finished_at: '2026-11-24T15:58:00Z', status: 'succeeded', summary: { items: 12 }, outputs: null, error: null },
      next_run: '2026-11-24T16:05:00Z',
    },
    {
      site_id: 'nasdaq-news', poll_interval_min: 15, enabled: true, llm_daily_budget: 15, thesis_daily_budget: 3,
      last_run: null, next_run: '2026-11-24T16:15:00Z',
    },
  ]
}

function trendBuckets(lastN: number, mean: number) {
  const buckets = []
  for (let i = 0; i < 24; i += 1) {
    const last = i === 23
    buckets.push({
      bucket_start: `2026-11-24T${String(i).padStart(2, '0')}:00:00Z`,
      n: last ? lastN : 10,
      mean_sentiment: last ? mean : 0.2,
      mentions: last ? lastN : 10,
    })
  }
  return buckets
}

export const entitiesF7 = [
  { entity: 'nvda', entity_text: 'NVIDIA', entity_type: 'company', tickers: ['NVDA'], mention_count: 42, mentions: 42, mean_sentiment: 0.42, first_seen: '2026-11-20T09:00:00Z', last_seen: AS_OF, extraction_tiers: ['tier2_llm'], review_statuses: ['llm_verified'], top_co_occurring: [] },
  { entity: 'aapl', entity_text: 'Apple', entity_type: 'company', tickers: ['AAPL'], mention_count: 30, mentions: 30, mean_sentiment: -0.1, first_seen: '2026-11-20T09:00:00Z', last_seen: AS_OF, extraction_tiers: ['tier2_llm'], review_statuses: ['llm_verified'], top_co_occurring: [] },
  { entity: 'msft', entity_text: 'Microsoft', entity_type: 'company', tickers: ['MSFT'], mention_count: 12, mentions: 12, mean_sentiment: 0.3, first_seen: '2026-11-23T09:00:00Z', last_seen: AS_OF, extraction_tiers: ['tier0_lexicon'], review_statuses: ['fast_glance'], top_co_occurring: [] },
]

export const trendsF7: Record<string, Record<string, unknown>> = {
  nvda: { entity: 'nvda', ticker: 'NVDA', bucket: '1h', window_hours: 24, buckets: trendBuckets(12, 0.45), baseline_mean: 0.1, baseline_std: 0.1, baseline_n: 30, z_score: 3.42, reason: null, n: 252 },
  aapl: { entity: 'aapl', ticker: 'AAPL', bucket: '1h', window_hours: 24, buckets: trendBuckets(8, -0.12), baseline_mean: 0.05, baseline_std: 0.1, baseline_n: 30, z_score: -1.2, reason: null, n: 200 },
  // High z on thin data: the S6 rule must show this as insufficient, never a signal.
  msft: { entity: 'msft', ticker: 'MSFT', bucket: '1h', window_hours: 24, buckets: trendBuckets(3, 0.31), baseline_mean: 0.05, baseline_std: 0.05, baseline_n: 30, z_score: 5.0, reason: null, n: 36 },
}

export const noveltyF7: Record<string, Record<string, unknown>> = {
  nvda: { entity: 'nvda', ticker: 'NVDA', topic: null, window_min: 60, mentions_window: 25, mentions_baseline_per_window: 5, burst_ratio: 5.0, first_seen_at: null, is_first_in_baseline: true, n: 25 },
  aapl: { entity: 'aapl', ticker: 'AAPL', topic: null, window_min: 60, mentions_window: 6, mentions_baseline_per_window: 5, burst_ratio: 1.2, first_seen_at: '2026-11-20T09:00:00Z', is_first_in_baseline: false, n: 6 },
  msft: { entity: 'msft', ticker: 'MSFT', topic: null, window_min: 60, mentions_window: 10, mentions_baseline_per_window: 5, burst_ratio: 2.0, first_seen_at: '2026-11-23T09:00:00Z', is_first_in_baseline: false, n: 10 },
}

export interface F7State {
  sources: Array<Record<string, unknown>>
  theses: Array<Record<string, unknown>>
  schedules: Array<Record<string, unknown>>
  project: Record<string, unknown> | null
  episodes: Array<Record<string, unknown>>
  jobPolls: Record<string, number>
  calls: Array<{ tool: string; args: Record<string, unknown> }>
}

export function freshF7State(): F7State {
  return {
    sources: JSON.parse(JSON.stringify(sourcesF7)) as Array<Record<string, unknown>>,
    theses: JSON.parse(JSON.stringify(thesesF7)) as Array<Record<string, unknown>>,
    schedules: schedulesF7(),
    project: null,
    episodes: [],
    jobPolls: {},
    calls: [],
  }
}

function mcpResult(value: unknown, id?: number) {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? 1, result: { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] } })
}

function videoJob(jobId: string, status: string, outputManifest: Record<string, unknown> | null) {
  return {
    job_id: jobId, operation: 'linkzag.segment', status, input_revision: 1, progress_millis: status === 'succeeded' ? 100000 : 42000,
    cancellation_requested: false, resource_estimate: {}, output_manifest: outputManifest,
    safe_error_message: null, started_at: '2026-11-24T16:00:00Z',
    finished_at: status === 'succeeded' ? '2026-11-24T16:00:10Z' : null, created_at: '2026-11-24T16:00:00Z',
  }
}

/** Install the NIP + fina-scraper MCP stubs and return the mutable state. */
export async function stubF7(page: Page): Promise<F7State> {
  const state = freshF7State()

  await page.route('**/nip/mcp', async (route) => {
    const body = route.request().postDataJSON() as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }
    if (body.method === 'notifications/initialized') return route.fulfill({ status: 202, body: '' })
    let value: unknown = {}
    if (body.method === 'initialize') {
      value = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'nip-f7', version: '0.1.0' } }
    } else if (body.method === 'tools/call') {
      const name = body.params?.name ?? ''
      const args = body.params?.arguments ?? {}
      state.calls.push({ tool: name, args })
      switch (name) {
        case 'health': value = { service: 'nip-engine', api_version: 1, readiness: 'ready', schema_version: 4 }; break
        case 'capabilities': value = { service: 'nip-engine', service_version: '0.1.0', api_version: 1, schema_version: 4, features: { duckdb_store: true, podcast_rss_subscriptions: true, local_audio_transcription: false } }; break
        case 'search_events': value = { events: [eventF7], next_cursor: null }; break
        case 'list_claims': value = claimsF7; break
        case 'list_podcast_subscriptions': value = subscriptionsF7; break
        case 'list_narrative_clusters': value = []; break
        case 'narrative_signal_snapshot': value = { formula_version: '1', source_category_taxonomy_version: '1', derivation_run_id: 'run-f7', as_of: AS_OF, current_week_start: '2026-11-16T00:00:00Z', current_week_end: '2026-11-23T00:00:00Z', coverage: 'test', signals: [{ narrative_id: 'narr-f7-1', label: 'AI accelerator demand', current_week_start: '2026-11-16T00:00:00Z', current_week_end: '2026-11-23T00:00:00Z', prior_week_start: '2026-11-09T00:00:00Z', prior_week_end: '2026-11-16T00:00:00Z', current_count: 12, prior_count: 4, mentions_per_day: 1.71, prior_mentions_per_day: 0.57, delta_mentions_per_day: 1.14, percent_change: 200, persistence_complete_weeks: 2, distinct_source_categories: 3 }] }; break
        case 'list_etf_mappings': value = []; break
        case 'list_editorial_candidates': value = []; break
        case 'nip_resource_status': value = { observed_at: AS_OF, database_path: ':memory:', database_bytes: 12345, event_count: 1, claim_count: 6, extraction_run_count: 1, cluster_count: 0, graph_edge_count: 0, scheduler_interval_seconds: 21600, scheduler_state: 'running', semantic_index_state: 'disabled', semantic_model: null, warnings: [] }; break
        case 'list_narrative_graph': value = { graph_id: 'graph-f7', derivation_run_id: 'run-f7', algorithm_version: 'nip-graph-v1', created_at: AS_OF, nodes: [{ node_id: 'event:event-f7-1', node_type: 'event', label: 'episode-f7-1', evidence_event_ids: ['event-f7-1'] }, { node_id: 'claim:claim-f7-1', node_type: 'claim', label: 'Policy is expected to remain restrictive until inflation cools.', evidence_event_ids: ['event-f7-1'] }], edges: [] }; break
        case 'nip_provider_status': value = { configured: true, bridge_state: 'ready', provider_kind: 'local', provider_id: 'direct-local', model: 'fixture-local', reasoning_effort: null, provider_api: null, provider_type: 'direct_local', remote: false, consent: 'not_required', consent_recorded_at: null, disclosure: null, extraction_state: 'available', warnings: [] }; break
        case 'list_sources': value = state.sources; break
        case 'set_source_state': {
          const row = state.sources.find((s) => s.source_id === args.source_id)
          if (row) row.state = args.state as string
          value = row ?? {}
          break
        }
        case 'list_episode_page': value = { episodes: [], total: 0, next_offset: null }; break
        case 'list_podcast_transcription_jobs': value = []; break
        case 'nip_asr_status': value = { ready: false, configured: false, comfyui_url: null, workspace: '', workspace_present: false, render_script: '', render_script_present: false, repo_url: null, chunk_seconds: 60, python: '', python_present: false, ffmpeg_present: true, server_reachable: false, server_device: null, asr_nodes_present: false, pack_commit: null, blockers: ['ComfyUI not configured'], next_actions: [] }; break
        case 'list_media_artifacts': value = []; break
        case 'list_theses': value = state.theses; break
        case 'get_thesis': value = state.theses.find((t) => t.thesis_id === args.thesis_id) ?? {}; break
        case 'save_thesis': {
          const next = args.thesis as Record<string, unknown>
          const index = state.theses.findIndex((t) => t.thesis_id === next.thesis_id)
          if (index >= 0) state.theses[index] = next
          else state.theses.push(next)
          value = next
          break
        }
        case 'list_transcripts': value = (args.thesis_id === 'thesis-f7-good' ? [transcriptF7Good] : []); break
        case 'list_backtest_evidence': value = (args.thesis_id === 'thesis-f7-good' ? [backtestF7Good] : []); break
        case 'get_event': value = eventF7; break
        case 'video_capabilities': value = { planning: 'ready', evidence_linkage: 'ready', deterministic_renderer: 'linkzag_adapter', generative_video: 'not_configured', tts: 'not_configured', asr: 'not_configured', disclosure: 'Fixture-backed F7 run.' }; break
        case 'list_video_projects': value = state.project ? [state.project] : []; break
        case 'create_video_project': state.project = args.project as Record<string, unknown>; value = state.project; break
        case 'list_video_episodes': value = state.episodes; break
        case 'create_video_episode': {
          const episode = args.episode as Record<string, unknown>
          state.episodes = [episode, ...state.episodes.filter((e) => e.episode_id !== episode.episode_id)]
          value = episode
          break
        }
        case 'get_video_episode': value = state.episodes.find((e) => e.episode_id === args.episode_id) ?? {}; break
        case 'list_video_evidence': value = []; break
        case 'list_video_episode_visual_specs': value = []; break
        case 'list_video_project_assets': value = []; break
        case 'list_video_assets': value = []; break
        case 'list_video_workflows': value = []; break
        case 'list_video_jobs': value = []; break
        case 'render_video_linkzag': value = videoJob('video-job-f7-1', 'queued', null); break
        case 'video_job_status': {
          const jobId = String(args.job_id ?? 'video-job-f7-1')
          state.jobPolls[jobId] = (state.jobPolls[jobId] ?? 0) + 1
          const polls = state.jobPolls[jobId]
          if (jobId === 'video-job-f7-1') {
            value = polls < 2
              ? videoJob(jobId, 'running', null)
              : videoJob(jobId, 'succeeded', { asset: { asset_id: 'linkzag-commentary-f7', revision: 1, asset_kind: 'commentary_video', relative_path: 'video/linkzag/video-job-f7-1/output/commentary.mp4', mime_type: 'video/mp4', content_hash: 'f7-checksum', width: 1280, height: 720, duration_ms: 64000, provider: 'linkzag', workflow_id: 'linkzag.commentary.v1', model: null, reproducibility: 'deterministic', capability_state: 'ready', license_state: 'fixture_only', job_id: jobId, created_at: AS_OF }, capture_mode: 'flash', narrated: false })
          } else if (jobId === 'qa-job-f7-1') {
            value = polls < 2
              ? videoJob(jobId, 'running', null)
              : videoJob(jobId, 'succeeded', { report_ref: { id: 'qa-report-f7-1', revision: 1 } })
          } else if (jobId === 'export-job-f7-1') {
            value = polls < 2
              ? videoJob(jobId, 'running', null)
              : videoJob(jobId, 'succeeded', { manifest_ref: { id: 'export-manifest-f7-1' } })
          } else {
            value = videoJob(jobId, 'succeeded', null)
          }
          break
        }
        case 'fina_video_timeline_build': value = { status: 'ready', timeline_ref: { id: 'timeline-f7-1', revision: 1 }, timeline_hash: 'abc123hashf7', summary: { video_clips: 8, audio_clips: 0, caption_tracks: 0, total_frames: 1920, duration_ms: 64000 }, findings: [] }; break
        case 'fina_video_qa_run': value = videoJob('qa-job-f7-1', 'queued', null); break
        case 'fina_video_qa_get': value = { decision: 'allow', executionState: 'complete', checkSummary: { passed: 12, warnings: 0, blockers: 0, notRun: 0 }, reportRef: { id: 'qa-report-f7-1', revision: 1 }, findings: [] }; break
        case 'fina_video_export_profiles_list': value = { profiles: [{ id: 'mp4-h264-720p30-preview-v1', revision: 1 }] }; break
        case 'fina_video_export_preflight': value = { authorized: true, timeline_ref: { id: 'timeline-f7-1', revision: 1 }, qa_report_ref: { id: 'qa-report-f7-1', revision: 1 }, export_profile_id: 'mp4-h264-720p30-preview-v1' }; break
        case 'fina_video_export_start': value = { job: { job_id: 'export-job-f7-1' } }; break
        case 'fina_video_export_get': value = { manifestId: 'export-manifest-f7-1', manifest_id: 'export-manifest-f7-1' }; break
        default:
          if (name.startsWith('save_video_')) {
            const first = Object.values(args)[0]
            value = (first && typeof first === 'object' ? first : args) as Record<string, unknown>
          } else {
            value = {}
          }
      }
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Mcp-Session-Id': 'f7-session' }, body: mcpResult(value, body.id) })
  })

  await page.route('**/fina-scraper/mcp', async (route) => {
    const body = route.request().postDataJSON() as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }
    if (body.method === 'notifications/initialized') return route.fulfill({ status: 202, body: '' })
    let value: unknown = {}
    if (body.method === 'initialize') {
      value = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fina-scraper-f7', version: '0.1.0' } }
    } else if (body.method === 'tools/call') {
      const name = body.params?.name ?? ''
      const args = body.params?.arguments ?? {}
      state.calls.push({ tool: name, args })
      switch (name) {
        case 'scrape_status': value = scraperStatusF7(state.schedules); break
        case 'scrape_schedule': {
          const siteId = String(args.site_id ?? '')
          const existing = state.schedules.find((s) => s.site_id === siteId)
          const record: Record<string, unknown> = {
            site_id: siteId,
            poll_interval_min: args.poll_interval_min,
            enabled: args.enabled ?? true,
            llm_daily_budget: args.llm_daily_budget ?? 15,
            thesis_daily_budget: args.thesis_daily_budget ?? 3,
            last_run: existing?.last_run ?? null,
            next_run: '2026-11-26T12:00:00Z',
          }
          if (existing) Object.assign(existing, record)
          else state.schedules.push(record)
          value = { status: 'recorded', ...record }
          break
        }
        case 'scrape_trigger': {
          const sites = (args.sites as string[] | undefined) ?? []
          for (const siteId of sites) {
            const schedule = state.schedules.find((s) => s.site_id === siteId)
            if (schedule) {
              schedule.last_run = { run_id: 'run-f7-triggered', started_at: '2026-11-26T10:00:00Z', finished_at: '2026-11-26T10:00:05Z', status: 'triggered', summary: { items: 0 }, outputs: null, error: null }
            }
          }
          value = { triggered: sites, status: 'ok' }
          break
        }
        case 'query_entities': value = { entities: entitiesF7, next_cursor: null }; break
        case 'query_sentiment_trend': value = trendsF7[String(args.entity ?? '')] ?? { entity: args.entity ?? null, ticker: null, bucket: '1h', window_hours: 24, buckets: [], baseline_mean: null, baseline_std: null, baseline_n: 0, z_score: null, reason: 'no baseline', n: 0 }; break
        case 'query_novelty': value = noveltyF7[String(args.entity ?? '')] ?? { entity: args.entity ?? null, ticker: null, topic: null, window_min: 60, mentions_window: 0, mentions_baseline_per_window: 0, burst_ratio: 0, first_seen_at: null, is_first_in_baseline: false, n: 0 }; break
        case 'query_claim_corroboration': value = { claim: {}, source_count: 2, distinct_source_count: 2, corroboration_score: 0.9, agreeing: [], contradicting: [] }; break
        case 'query_symbol_features': value = { entity: 'nvda', symbol: 'NVDA', as_of: AS_OF, features_by_tier: { tier2_llm: { narr_sentiment_1d: 0.42 } }, llm_verified_coverage: 0.8, mostly_fast_glance: false }; break
        case 'query_triage': value = { candidates: [], n: 0, rejected_count: 0, rejected_reasons: [], tiers_included: ['tier2_llm'], llm_verified_only: false, include_fast_glance: true }; break
        default: value = {}
      }
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Mcp-Session-Id': 'f7-scraper-session' }, body: mcpResult(value, body.id) })
  })

  return state
}

/** Open the app and navigate to the Narrative workspace overview. */
export async function openNarrative(page: Page) {
  await page.goto('/')
  await page.getByTestId('menu-narrative').click()
  await page.getByTestId('menuitem-narrative-overview').click()
  await page.getByRole('heading', { name: 'Narrative Intelligence' }).waitFor()
}

/** Open the Video workspace project list. */
export async function openVideo(page: Page) {
  await page.goto('/')
  await page.getByTestId('menu-video').click()
  await page.getByTestId('menuitem-video-projects').click()
  await page.getByRole('heading', { name: 'Video Workspace' }).waitFor()
}
