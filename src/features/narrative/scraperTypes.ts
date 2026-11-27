import type { ClaimReviewStatus, ExtractionTier } from './types'

/**
 * Response shapes from the fina-scraper MCP sidecar (revamp §b/§c.4).
 * Field names are the sidecar's snake_case JSON, mirrored — never
 * re-derived here. Tiers and review statuses come from the lake rows;
 * the UI only displays them.
 */

/** One recorded scrape schedule, as returned by `scrape_status` (S3). */
export interface ScraperSchedule {
  site_id: string
  poll_interval_min: number
  enabled: boolean
  llm_daily_budget: number
  thesis_daily_budget: number
  last_run: {
    run_id: string
    started_at: string
    finished_at: string
    status: string
    summary: Record<string, unknown> | null
    outputs: Record<string, unknown> | null
    error: string | null
  } | null
  next_run: string | null
}

export interface ScraperBudgets {
  date: string
  llm_daily_budget: number
  llm_reviews_today: number
  thesis_daily_budget: number
  theses_today: number
}

export interface ScraperStorage {
  lake_dir: string
  data_dir: string
  config_dir: string
  schedules_dir: string
  state_path: string
  output_dir: string
  initialized: boolean
  initialization_status?: string
  schema_version?: string | null
}

/** One YAML-configured site; this inventory is separate from NIP sources and schedules. */
export interface ScraperSiteInventory {
  site_id: string
  display_name: string
  kind: string
  enabled: boolean
  poll_interval_min: number
  feed_url: string | null
  source_seed_status: string
  schedule_seed_status: string
  credential_status: string
}

export interface ScraperStatus {
  last_run: Record<string, unknown> | null
  lake: {
    items: number
    entities: number
    claims: number
    edges: number
    prices: number
    backtests: number
    max_ingested_at: string | null
  }
  schedules: ScraperSchedule[]
  budgets: ScraperBudgets
  /** Optional on older sidecar responses. */
  storage?: ScraperStorage
  /** YAML inventory only; does not imply a source row or that the site is probeable. */
  site_inventory?: ScraperSiteInventory[]
}

export interface ScraperScheduleRecord {
  status: string
  site_id?: string
  poll_interval_min?: number
  enabled?: boolean
  llm_daily_budget?: number
  thesis_daily_budget?: number
  path?: string
  note?: string
}

/** One aggregated entity row from `query_entities`. */
export interface ScraperEntityRow {
  entity: string
  entity_text: string | null
  entity_type: string | null
  tickers: string[] | null
  mention_count: number
  mentions: number
  mean_sentiment: number | null
  first_seen: string | null
  last_seen: string | null
  extraction_tiers: ExtractionTier[]
  review_statuses: ClaimReviewStatus[]
  top_co_occurring: Array<{ entity: string; count: number }>
  /** Last 3 buckets ending at as_of; only when `include_trend` was set. */
  trend?: Array<{
    bucket_start: string
    n: number
    mean_sentiment: number | null
    mentions: number
    tiers: Record<string, { n: number; mean_sentiment: number | null; mentions: number }>
    mixed_tiers: boolean
  }>
}

export interface ScraperEntitiesResponse {
  entities: ScraperEntityRow[]
  n?: number
  as_of?: string
}

export interface SentimentBucket {
  bucket_start: string
  n: number
  mean_sentiment: number | null
  mentions: number
  tiers?: Record<string, { n: number; mean_sentiment: number | null; mentions: number }>
  mixed_tiers?: boolean
}

/** `query_sentiment_trend`: z is null when the baseline is too thin. */
export interface SentimentTrend {
  entity: string | null
  ticker: string | null
  bucket: string
  window_hours: number
  buckets: SentimentBucket[]
  baseline_mean: number | null
  baseline_std: number | null
  baseline_n: number
  z_score: number | null
  reason: string | null
  n: number
}

export interface NoveltyResult {
  entity: string | null
  ticker: string | null
  topic: string | null
  window_min: number
  mentions_window: number
  mentions_baseline_per_window: number
  burst_ratio: number
  first_seen_at: string | null
  is_first_in_baseline: boolean
  n: number
}

export interface WatchlistTickerChange {
  ticker: string
  new_items: number
  new_item_ids: string[]
  sentiment_now: number | null
  sentiment_prev: number | null
  sentiment_delta: number | null
  mention_delta: number
  mentions_now: number
  mentions_prev: number
  top_claims: Array<Record<string, unknown>>
}

export interface WatchlistChanges {
  as_of_prev: string
  tickers: WatchlistTickerChange[]
  n: number
}

/** One `query_triage` candidate (S2: rejected_count + reasons included). */
export interface TriageCandidate {
  entity?: string | null
  ticker?: string | null
  z_score?: number | null
  burst_ratio?: number | null
  n?: number
  llm_worth_it?: boolean
  reason?: string | null
  [key: string]: unknown
}

export interface TriageResponse {
  candidates: TriageCandidate[]
  n: number
  budget?: Record<string, unknown>
  rejected_count: number
  rejected_reasons: Array<{ entity?: string | null; ticker?: string | null; reason: string }>
  tiers_included?: string[]
  llm_verified_only?: boolean
  include_fast_glance?: boolean
  note?: string
}

export interface ClaimTimelineEntry {
  claim_id?: string
  subject?: string
  predicate?: string
  object?: string
  claim_text?: string
  published_at?: string | null
  ingested_at?: string | null
  extraction_tier?: ExtractionTier | null
  review_status?: ClaimReviewStatus | null
  confidence?: number | null
  [key: string]: unknown
}

export interface ClaimTimelineResponse {
  subject: string
  predicate: string
  window_days: number
  claims: ClaimTimelineEntry[]
  n: number
}

export interface ClaimCorroboration {
  claim: Record<string, unknown>
  source_count: number
  distinct_source_count: number
  corroboration_score: number
  agreeing: Array<{ source_id: string; item_id: string; [key: string]: unknown }>
  contradicting: Array<Record<string, unknown>>
}

/** One row of `list_transcripts` (S4). */
export interface ScraperTranscriptListItem {
  thesis_id: string
  title: string
  thesis_basis: string
  as_of: string
  created_at: string
  beat_count: number
  evidence_ref_count: number
  backtest_ids: string[]
  transcript_path: string
  has_fina_import: boolean
}

/** `query_symbol_features` feature vector at an as_of (S1). */
export interface SymbolFeatures {
  entity: string | null
  error?: string | null
  symbol: string
  as_of: string
  features_by_tier?: Record<string, Record<string, number | null>>
  llm_verified_coverage?: number | null
  mostly_fast_glance?: boolean
  [key: string]: unknown
}
