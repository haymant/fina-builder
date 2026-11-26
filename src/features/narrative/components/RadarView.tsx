import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { PanelCard } from '../../shared/components/PanelCard'
import { scraperApi } from '../scraperApi'
import type { NoveltyResult, ScraperEntityRow, SentimentTrend } from '../scraperTypes'
import type { NipNarrativeSignal } from '../types'
import { formatNumber, hasSufficientData, zScoreDisplay } from '../thesisGates'

export interface RadarRow {
  entity: ScraperEntityRow
  trend: SentimentTrend | null
  novelty: NoveltyResult | null
  /** Last 1h bucket n — the S6 rule discards the row's z when this is < 5. */
  lastBucketN: number | null
}

function bucketMean(buckets: Array<{ n: number; mean_sentiment: number | null; mentions: number }>, count: number): { mean: number | null; n: number } {
  const slice = buckets.slice(-count)
  const n = slice.reduce((sum, bucket) => sum + bucket.n, 0)
  const weighted = slice.reduce((sum, bucket) => sum + (bucket.mean_sentiment ?? 0) * bucket.n, 0)
  return { mean: n > 0 ? weighted / n : null, n }
}

export function buildRadarRows(
  entities: ScraperEntityRow[],
  trends: Map<string, SentimentTrend>,
  novelties: Map<string, NoveltyResult>,
): RadarRow[] {
  return entities
    .map((entity) => {
      const trend = trends.get(entity.entity) ?? null
      const novelty = novelties.get(entity.entity) ?? null
      const lastBucketN = trend?.buckets.length ? trend.buckets[trend.buckets.length - 1].n : null
      return { entity, trend, novelty, lastBucketN }
    })
    .sort((a, b) => {
      const za = Math.abs(a.trend?.z_score ?? 0)
      const zb = Math.abs(b.trend?.z_score ?? 0)
      return zb - za || (b.novelty?.burst_ratio ?? 0) - (a.novelty?.burst_ratio ?? 0) || b.entity.mentions - a.entity.mentions
    })
}

/**
 * Hourly per-entity radar (revamp §c.4, decision §f.5) — the default tab.
 * One row per entity: 1h/4h/24h sentiment buckets with n, z-score vs the
 * 30d baseline, burst ratio, novelty. Sorted by |z| / burst, not by count.
 * The weekly narrative-cluster radar is kept as the secondary tab.
 */
export function RadarView({
  asOf,
  signals,
  signalWeek,
  onOpenEntity,
}: {
  asOf: string | null
  signals: NipNarrativeSignal[]
  signalWeek: string | null
  onOpenEntity?: (entity: string) => void
}) {
  const [tab, setTab] = useState<'hourly' | 'weekly'>('hourly')
  const [rows, setRows] = useState<RadarRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!asOf) {
      setError('No as_of set — the radar needs the last completed scrape (or a chosen as_of) before it can query the lake.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const response = await scraperApi.queryEntities({ asOf, limit: 50, includeTrend: true })
      const top = [...(response.entities ?? [])].sort((a, b) => b.mentions - a.mentions).slice(0, 8)
      const trends = new Map<string, SentimentTrend>()
      const novelties = new Map<string, NoveltyResult>()
      await Promise.all(top.map(async (entity) => {
        try {
          trends.set(entity.entity, await scraperApi.querySentimentTrend({ asOf, entity: entity.entity, bucket: '1h', windowHours: 24 }))
        } catch { /* one entity's trend failing must not blank the radar */ }
        try {
          novelties.set(entity.entity, await scraperApi.queryNovelty({ asOf, entity: entity.entity, windowMin: 60 }))
        } catch { /* same */ }
      }))
      setRows(buildRadarRows(response.entities ?? [], trends, novelties))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The fina-scraper sidecar could not be reached.')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [asOf])

  useEffect(() => { void load() }, [load])

  const insufficient = useMemo(() => rows.filter((row) => !hasSufficientData(row.lastBucketN)).length, [rows])

  return (
    <div data-testid="radar-view">
      <PanelCard title="Radar — hourly, per entity" subtitle={`MFT radar · as_of ${asOf ?? 'not set'} · z vs 30d baseline · n < 5 is insufficient data, never a signal`} collapsible={false} bodyClassName="narrative-card-body" actions={<Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</Button>}>
        <div className="flex gap-1" role="tablist" aria-label="Radar tabs">
          <button type="button" role="tab" aria-selected={tab === 'hourly'} className={`narrative-chip ${tab === 'hourly' ? 'is-active' : ''}`} onClick={() => setTab('hourly')} data-testid="radar-tab-hourly">Hourly per-entity (default)</button>
          <button type="button" role="tab" aria-selected={tab === 'weekly'} className={`narrative-chip ${tab === 'weekly' ? 'is-active' : ''}`} onClick={() => setTab('weekly')} data-testid="radar-tab-weekly">Weekly narrative radar</button>
        </div>
        {tab === 'weekly' ? (
          <div className="mt-3" data-testid="radar-weekly">
            <p className="text-[11px] text-muted">Weekly narrative-cluster radar — good for editorial planning, not the MFT radar. Counts only, over the last completed UTC week{signalWeek ? ` (${signalWeek})` : ''}.</p>
            {signals.length ? (
              <div className="mt-2 space-y-2">{[...signals].sort((a, b) => b.current_count - a.current_count).map((signal) => (
                <article className="evidence-card" key={signal.narrative_id} data-testid={`radar-weekly-row-${signal.narrative_id}`}>
                  <strong className="text-xs text-main">{signal.label}</strong>
                  <p className="mt-1 text-[10px] text-muted">Current week {signal.current_count} · prior {signal.prior_count} · Δ/day {signal.delta_mentions_per_day.toFixed(2)} · persistence {signal.persistence_complete_weeks} wk · {signal.distinct_source_categories} categories</p>
                </article>
              ))}</div>
            ) : <p className="mt-2 text-[11px] text-muted">No weekly signals for the last completed UTC week.</p>}
          </div>
        ) : error ? (
          <div className="narrative-empty" data-testid="radar-empty"><p>{error}</p><span>Restart desktop with <code>node scripts/fina.mjs desktop</code>, or run <code>npm run mcp:http:fina-scraper</code> in browser mode, then refresh. NIP views keep working without it.</span></div>
        ) : loading && !rows.length ? (
          <p className="mt-3 text-[11px] text-muted">Loading hourly entity signals…</p>
        ) : rows.length ? (
          <>
            {insufficient ? <p className="mt-2 text-[10px] text-amber-700" role="status">{insufficient} {insufficient === 1 ? 'row has' : 'rows have'} n &lt; 5 in the last hour — shown as insufficient data, not ranked as signals.</p> : null}
            <div className="mt-2 overflow-x-auto">
              <table className="narrative-table" data-testid="radar-table">
                <thead><tr><th>Entity</th><th>Tickers</th><th>1h sentiment (n)</th><th>4h sentiment (n)</th><th>24h sentiment (n)</th><th>z-score vs 30d</th><th>Burst</th><th>Novelty</th></tr></thead>
                <tbody>
                  {rows.map((row) => {
                    const buckets = row.trend?.buckets ?? []
                    const oneHour = bucketMean(buckets, 1)
                    const fourHour = bucketMean(buckets, 4)
                    const day = bucketMean(buckets, 24)
                    const z = hasSufficientData(row.lastBucketN) ? zScoreDisplay(row.trend?.z_score, row.lastBucketN, row.trend?.reason) : `insufficient data (n=${row.lastBucketN ?? 0} < 5)`
                    return (
                      <tr key={row.entity.entity} data-testid={`radar-row-${row.entity.entity}`} onClick={() => onOpenEntity?.(row.entity.entity)} className={onOpenEntity ? 'cursor-pointer' : undefined}>
                        <td><strong className="text-xs text-main">{row.entity.entity_text ?? row.entity.entity}</strong><span className="block text-[10px] text-muted">{row.entity.entity}</span></td>
                        <td>{(row.entity.tickers ?? []).join(', ') || '—'}</td>
                        <td data-testid={`radar-1h-${row.entity.entity}`}>{formatNumber(oneHour.mean)} (n={oneHour.n})</td>
                        <td>{formatNumber(fourHour.mean)} (n={fourHour.n})</td>
                        <td>{formatNumber(day.mean)} (n={day.n})</td>
                        <td data-testid={`radar-z-${row.entity.entity}`}>{z}</td>
                        <td data-testid={`radar-burst-${row.entity.entity}`}>{row.novelty ? `${row.novelty.burst_ratio.toFixed(2)}×` : '—'}</td>
                        <td>{row.novelty?.is_first_in_baseline ? `first seen ${row.novelty.first_seen_at ?? ''}` : row.novelty?.first_seen_at ? `seen since ${row.novelty.first_seen_at}` : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[10px] text-muted">Sorted by |z| then burst. z is null when the baseline has fewer than 5 buckets or std = 0. Corroboration per claim lives in the Claim Explorer — the radar ranks, it does not verify.</p>
          </>
        ) : <p className="mt-3 text-[11px] text-muted">No entity mentions at this as_of.</p>}
      </PanelCard>
    </div>
  )
}
