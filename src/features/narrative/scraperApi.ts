import { getScraperTransport } from '../../api/scraperTransport'
import { toSnakeKeys } from '../../api/keyCase'
import type {
  ClaimCorroboration,
  ClaimTimelineResponse,
  NoveltyResult,
  ScraperEntitiesResponse,
  ScraperScheduleRecord,
  ScraperStatus,
  ScraperTranscriptListItem,
  SentimentTrend,
  SymbolFeatures,
  TriageResponse,
  WatchlistChanges,
} from './scraperTypes'

function fromTransport<T>(value: unknown): T {
  return toSnakeKeys(value) as T
}

function call<T>(name: string, args?: unknown): Promise<T> {
  return getScraperTransport().callTool<T>(name, args).then((value) => fromTransport<T>(value))
}

/**
 * Typed wrappers over the fina-scraper MCP sidecar (revamp §b, S1–S4).
 * Components never call the sidecar directly — they go through here, the
 * same way NIP data goes through `narrativeApi`. Every method rejects when
 * the sidecar is down; callers render that as "sidecar unavailable" and
 * keep showing the NIP-side data they already have. No tier or
 * review_status is computed here; the lake rows carry them.
 */
export const scraperApi = {
  /** S3: latest run + lake counts + schedules (each with last/next run) + today's budgets. */
  scrapeStatus: (runId?: string) =>
    call<ScraperStatus>('scrape_status', runId ? { run_id: runId } : {}),
  /** Record (create/update) a schedule. The MCP records it; it does not execute it. */
  scrapeSchedule: (args: { siteId: string; pollIntervalMin: number; enabled?: boolean; llmDailyBudget?: number; thesisDailyBudget?: number }) =>
    call<ScraperScheduleRecord>('scrape_schedule', {
      site_id: args.siteId,
      poll_interval_min: args.pollIntervalMin,
      enabled: args.enabled,
      llm_daily_budget: args.llmDailyBudget,
      thesis_daily_budget: args.thesisDailyBudget,
    }),
  /** Run a scrape now for the given sites (default: all enabled sites). */
  scrapeTrigger: (args: { sites?: string[]; force?: boolean } = {}) =>
    call<Record<string, unknown>>('scrape_trigger', { sites: args.sites, force: args.force }),
  /** Backload history (default 90 days, max 180); dryRun lists windows and writes nothing. */
  scrapeBackload: (args: { days?: number; sites?: string[]; dryRun?: boolean; endDate?: string } = {}) =>
    call<Record<string, unknown>>('scrape_backload', {
      days: args.days,
      sites: args.sites,
      dry_run: args.dryRun,
      end_date: args.endDate,
    }),
  /** Per-entity aggregation at as_of, optionally with the last-3-bucket trend. */
  queryEntities: (args: { asOf: string; entity?: string; ticker?: string; start?: string; limit?: number; bucket?: string; includeTrend?: boolean; llmVerifiedOnly?: boolean } = { asOf: '' }) =>
    call<ScraperEntitiesResponse>('query_entities', {
      as_of: args.asOf,
      entity: args.entity,
      ticker: args.ticker,
      start: args.start,
      limit: args.limit ?? 50,
      bucket: args.bucket ?? '1h',
      include_trend: args.includeTrend ?? true,
      llm_verified_only: args.llmVerifiedOnly,
    }),
  /** Hourly sentiment buckets + z-score vs the 30d baseline for one entity/ticker. */
  querySentimentTrend: (args: { asOf: string; entity?: string; ticker?: string; bucket?: string; windowHours?: number; baselineDays?: number }) =>
    call<SentimentTrend>('query_sentiment_trend', {
      as_of: args.asOf,
      entity: args.entity,
      ticker: args.ticker,
      bucket: args.bucket ?? '1h',
      window_hours: args.windowHours ?? 24,
      baseline_days: args.baselineDays ?? 30,
    }),
  /** Burst ratio + first-seen for one entity/ticker/topic. */
  queryNovelty: (args: { asOf: string; entity?: string; ticker?: string; topic?: string; windowMin?: number }) =>
    call<NoveltyResult>('query_novelty', {
      as_of: args.asOf,
      entity: args.entity,
      ticker: args.ticker,
      topic: args.topic,
      window_min: args.windowMin ?? 60,
    }),
  /** Sentiment/mention deltas between two as_ofs, per ticker. */
  queryWatchlistChanges: (args: { tickers: string[]; asOfPrev: string; asOfNow: string; includeFastGlance?: boolean }) =>
    call<WatchlistChanges>('query_watchlist_changes', {
      tickers: args.tickers,
      as_of_prev: args.asOfPrev,
      as_of_now: args.asOfNow,
      include_fast_glance: args.includeFastGlance ?? true,
    }),
  /** S2: ranked deep-dive candidates + rejected_count/rejected_reasons. */
  queryTriage: (args: { asOf: string; entity?: string; tickers?: string[]; windowHours?: number; baselineDays?: number }) =>
    call<TriageResponse>('query_triage', {
      as_of: args.asOf,
      entity: args.entity,
      tickers: args.tickers,
      window_hours: args.windowHours ?? 24,
      baseline_days: args.baselineDays ?? 30,
    }),
  /** Same claim over time, ordered by published_at. */
  queryClaimTimeline: (args: { asOf: string; subject: string; predicate: string; windowDays?: number }) =>
    call<ClaimTimelineResponse>('query_claim_timeline', {
      as_of: args.asOf,
      subject: args.subject,
      predicate: args.predicate,
      window_days: args.windowDays ?? 30,
    }),
  /** Agreeing sources + contradicting claims for one claim. */
  queryClaimCorroboration: (args: { asOf: string; claimId?: string; subject?: string; predicate?: string; object?: string }) =>
    call<ClaimCorroboration>('query_claim_corroboration', {
      as_of: args.asOf,
      claim_id: args.claimId,
      subject: args.subject,
      predicate: args.predicate,
      object: args.object,
    }),
  /** Claims for a subject, optionally with per-claim corroboration counts. */
  queryClaims: (args: { asOf: string; subject?: string; predicate?: string; limit?: number; corroboration?: boolean; llmVerifiedOnly?: boolean; reviewStatus?: string }) =>
    call<{ claims: Array<Record<string, unknown>>; n: number }>('query_claims', {
      as_of: args.asOf,
      subject: args.subject,
      predicate: args.predicate,
      limit: args.limit ?? 20,
      corroboration: args.corroboration ?? false,
      llm_verified_only: args.llmVerifiedOnly,
      review_status: args.reviewStatus,
    }),
  /** S1: narrative feature vector for one symbol at as_of, per tier. */
  querySymbolFeatures: (args: { symbol: string; asOf: string; bucket?: string }) =>
    call<SymbolFeatures>('query_symbol_features', {
      symbol: args.symbol,
      as_of: args.asOf,
      bucket: args.bucket ?? '1d',
    }),
  /** S4: transcripts the scraper wrote (one row per thesis). */
  listScraperTranscripts: () =>
    call<{ transcripts: ScraperTranscriptListItem[]; n: number }>('list_transcripts'),
  /** S4: one transcript (structured record + Markdown). */
  getScraperTranscript: (thesisId: string) =>
    call<Record<string, unknown>>('get_transcript', { thesis_id: thesisId }),
}
