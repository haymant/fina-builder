export interface NipHealth {
  service: string
  api_version: number
  readiness: 'ready'
  schema_version: number
}

export interface NipCapabilities {
  service: string
  service_version: string
  api_version: number
  schema_version: number
  features: {
    duckdb_store: boolean
    podcast_rss_subscriptions: boolean
    local_audio_transcription: boolean
    claim_extraction: boolean
    parquet_export: boolean
    semantic_search: boolean
  }
}

export interface NipEventTimes {
  published_at: string | null
  source_updated_at: string | null
  captured_at: string
  ingested_at: string
}

export interface NipEvent {
  schema_version: number
  event_id: string
  source_id: string
  source_native_id: string | null
  canonical_url: string | null
  content_hash: string
  content_text: string | null
  times: NipEventTimes
  revision_of: string | null
}

export interface NipEventSearchPage {
  events: NipEvent[]
  next_cursor: string | null
}

export interface NipClaimEvidence {
  event_id: string
  quote: string | null
  start_offset: number | null
  end_offset: number | null
}

export interface NipClaim {
  claim_id: string
  claim_text: string
  speaker_or_author: string | null
  confidence_millis: number
  extraction_run_id: string
  provider: string
  model: string
  prompt_version: string
  provider_kind?: string | null
  provider_profile_id?: string | null
  reasoning_effort?: string | null
  extracted_at: string
  evidence: NipClaimEvidence[]
}

export interface NipProviderStatus {
  configured: boolean
  bridge_state: 'not_configured' | 'unavailable' | 'ready' | string
  provider_kind: string | null
  provider_id: string | null
  model: string | null
  reasoning_effort: string | null
  provider_api: string | null
  remote: boolean
  consent: 'granted' | 'missing' | 'revoked' | 'not_required' | string
  consent_recorded_at: string | null
  disclosure: string | null
  extraction_state: 'available' | 'consent_required' | 'unavailable' | string
  warnings: string[]
}

export interface NipProviderConsent {
  consent_id: string
  action: 'granted' | 'revoked' | string
  provider_kind: string
  provider_id: string | null
  model: string
  scope: string
  disclosure: string
  actor: string
  reason: string | null
  recorded_at: string
}

export interface NipEditorialReviewAudit {
  review_id: string
  candidate_id: string
  review_status: string
  review_reason: string
  reviewer: string
  reviewed_at: string
  recorded_at: string
}

export interface NipApiError {
  code: string
  message: string
}

export type NipSubscriptionState = 'active' | 'paused' | 'removed'

export interface NipPodcastSubscription {
  source_id: string
  feed_url: string
  show_name: string
  rights_statement: string
  rights_confirmed_at: string
  state: NipSubscriptionState
  last_checked_at: string | null
  next_poll_at: string | null
  last_error_code: string | null
  consecutive_failures: number
}

export interface NipPodcastEpisode {
  source_id: string
  source_native_id: string | null
  canonical_url: string | null
  title: string | null
  enclosure_url: string | null
  published_at: string | null
  discovered_at: string
  state: string
  /** Publisher-provided transcript advertised by `<podcast:transcript>`. */
  transcript_url?: string | null
  transcript_type?: string | null
}

export interface NipEpisodePage {
  episodes: NipPodcastEpisode[]
  total: number
  limit: number
  offset: number
  next_offset: number | null
}

export interface NipSemanticResult {
  event: NipEvent
  score: number
  index_id: string
}

export interface NipEmbeddingManifest {
  index_id: string
  model_id: string
  model_revision: string
  dimensions: number
  chunking_version: string
  collection_name: string
  status: string
  event_count: number
  created_at: string
  completed_at: string | null
}

export interface NipNarrativeClusterMember {
  event_id: string
  similarity_millis: number
  rank: number
}

export interface NipNarrativeCluster {
  cluster_id: string
  derivation_run_id: string
  label: string
  algorithm_version: string
  member_count: number
  created_at: string
  members: NipNarrativeClusterMember[]
}

export interface NipNarrativeGraphNode {
  node_id: string
  node_type: string
  label: string
  evidence_event_ids: string[]
}

export interface NipNarrativeGraphEdge {
  edge_id: string
  from_node_id: string
  to_node_id: string
  edge_type: string
  evidence_event_ids: string[]
  confidence_millis: number
  derivation_run_id: string
}

export interface NipNarrativeGraph {
  graph_id: string
  derivation_run_id: string
  algorithm_version: string
  created_at: string
  nodes: NipNarrativeGraphNode[]
  edges: NipNarrativeGraphEdge[]
}

export interface NipResourceStatus {
  observed_at: string
  database_path: string
  database_bytes: number
  event_count: number
  claim_count: number
  extraction_run_count: number
  cluster_count: number
  graph_edge_count: number
  scheduler_interval_seconds: number
  scheduler_state: string
  semantic_index_state: string
  semantic_model: string | null
  warnings: string[]
}

export interface NipExtractionStatus {
  observed_at: string
  state: string
  claim_count: number
  extraction_run_count: number
  latest_run_id: string | null
  latest_provider: string | null
  latest_model: string | null
  latest_prompt_version: string | null
  latest_extracted_at: string | null
  evidence_linked_claim_count: number
  warnings: string[]
}

export interface NipNarrativeSignal {
  narrative_id: string
  label: string
  current_week_start: string
  current_week_end: string
  prior_week_start: string
  prior_week_end: string
  current_count: number
  prior_count: number
  mentions_per_day: number
  prior_mentions_per_day: number
  delta_mentions_per_day: number
  percent_change: number | null
  distinct_source_categories: number
  category_counts: Record<string, number>
  persistence_complete_weeks: number
  first_published_at: string | null
  first_ingested_at: string | null
  evidence_event_ids: string[]
  coverage: string
  data_quality_flags: string[]
}

export interface NipNarrativeSignalSnapshot {
  formula_version: string
  source_category_taxonomy_version: string
  derivation_run_id: string
  as_of: string
  current_week_start: string
  current_week_end: string
  coverage: string
  signals: NipNarrativeSignal[]
}

export interface NipEtfMapping {
  mapping_id: string
  narrative_id: string
  ticker: string
  rationale: string
  evidence_event_ids: string[]
  author: string
  reviewer: string | null
  version: number
  effective_from: string
  effective_to: string | null
  known_at: string
  review_status: string
  ticker_status: string
  market_data_coverage: string
  mapping_validity: string
  supersedes_mapping_id: string | null
  created_at: string
}

export interface NipEditorialCandidate {
  candidate_id: string
  title_angle: string
  narrative_ids: string[]
  claim_ids: string[]
  evidence_event_ids: string[]
  rank: number
  component_values: Record<string, number>
  derivation_run_id: string
  review_status: string
  review_reason: string | null
  reviewer: string | null
  reviewed_at: string | null
  created_at: string
}

export type NipSourceKind = 'podcast' | 'company_meeting' | 'filing' | 'reddit' | 'x' | 'web' | 'local_document' | 'other'

export type NipSourceState = 'active' | 'paused' | 'removed'

/** Registry view of a source, independent of the fetch adapter. */
export interface NipSource {
  source_id: string
  kind: NipSourceKind
  display_name: string
  locator: string | null
  rights_status: string
  rights_statement: string | null
  topics: string[]
  state: NipSourceState
  poll_interval_minutes: number
  per_scan_limit: number
  notes: string | null
  created_at: string
  updated_at: string
  event_count: number
  episode_count: number
}

export interface NipAsrStatus {
  ready: boolean
  configured: boolean
  comfyui_url: string | null
  workspace: string
  workspace_present: boolean
  render_script: string
  render_script_present: boolean
  repo_url: string | null
  chunk_seconds: number
  python: string
  python_present: boolean
  ffmpeg_present: boolean
  server_reachable: boolean
  server_device: string | null
  asr_nodes_present: boolean
  pack_commit: string | null
  blockers: string[]
  next_actions: string[]
}

export interface NipTranscriptionJobEvent {
  at: string
  level: string
  step: string
  detail: string
}

export interface NipTranscriptionJob {
  job_id: string
  source_id: string
  source_native_id: string | null
  canonical_url: string | null
  title: string | null
  state: string
  step: string
  detail: string | null
  error_code: string | null
  error_message: string | null
  audio_bytes: number | null
  audio_content_type: string | null
  audio_path: string | null
  audio_url_path: string | null
  audio_duration_seconds: number | null
  chunks_total: number | null
  chunks_completed: number
  transcript_characters: number | null
  transcript_preview: string | null
  transcript_path: string | null
  event_id: string | null
  warnings: string[]
  started_at: string
  updated_at: string
  finished_at: string | null
  events: NipTranscriptionJobEvent[]
}

export interface NipMediaArtifact {
  job_id: string
  name: string
  url_path: string
  kind: 'audio' | 'video' | string
  mime: string
  bytes: number
  modified_at: string
  title: string | null
  source_id: string | null
}

export interface NipComfyWorkspaceReport {
  workspace: string
  render_script: string
  cloned: boolean
  commit: string | null
  message: string
}

export interface NipEpisodeEventLookup {
  event: NipEvent | null
}
