import { useCallback, useEffect, useState } from 'react'
import { Button } from '../../../components/ui/button'
import { PanelCard } from '../../shared/components/PanelCard'
import { scraperApi } from '../scraperApi'
import type { ScraperEntityRow, SymbolFeatures } from '../scraperTypes'
import { formatNumber, reviewStatusLabel, tierLabel } from '../thesisGates'

function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

interface EntityDetail {
  claims: Array<Record<string, unknown>>
  claimsError: string | null
  features: SymbolFeatures | null
  featuresError: string | null
}

/**
 * Entities view (revamp §c.4, new): the MFT workflow lives here.
 * Table from `query_entities` at as_of (24h window), row click opens the
 * detail: sentiment trend buckets, top claims with tiers, co-entities,
 * and — for a ticker-mapped entity — the `query_symbol_features` vector
 * with llm_verified_coverage and the mostly_fast_glance label.
 */
export function EntitiesView({ asOf, initialEntity }: { asOf: string | null; initialEntity?: string | null }) {
  const [entities, setEntities] = useState<ScraperEntityRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(initialEntity ?? null)
  const [detail, setDetail] = useState<EntityDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const load = useCallback(async () => {
    if (!asOf) {
      setError('No as_of set — entities need the last completed scrape (or a chosen as_of).')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const start = new Date(new Date(asOf).getTime() - 24 * 60 * 60 * 1000).toISOString()
      const response = await scraperApi.queryEntities({ asOf, start, limit: 100, includeTrend: true })
      setEntities(response.entities ?? [])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The fina-scraper sidecar could not be reached.')
      setEntities([])
    } finally {
      setLoading(false)
    }
  }, [asOf])

  useEffect(() => { void load() }, [load])
  // initialEntity may be a FIBO id (fibo:NVDA) or a ticker (NVDA) — the
  // Watchlist rail navigates by ticker.
  useEffect(() => {
    if (!initialEntity) return
    const match = entities.find((entity) => entity.entity === initialEntity || (entity.tickers ?? []).includes(initialEntity))
    if (match) setSelectedId(match.entity)
  }, [initialEntity, entities])

  const loadDetail = useCallback(async (entity: ScraperEntityRow) => {
    if (!asOf) return
    setDetailLoading(true)
    setDetail(null)
    const next: EntityDetail = { claims: [], claimsError: null, features: null, featuresError: null }
    try {
      const result = await scraperApi.queryClaims({ asOf, subject: entity.entity_text ?? entity.entity, limit: 5, corroboration: true })
      next.claims = result.claims ?? []
    } catch (reason) {
      next.claimsError = reason instanceof Error ? reason.message : 'Claims could not be loaded.'
    }
    const ticker = entity.tickers?.[0]
    if (ticker) {
      try {
        next.features = await scraperApi.querySymbolFeatures({ symbol: ticker, asOf })
      } catch (reason) {
        next.featuresError = reason instanceof Error ? reason.message : 'Symbol features could not be loaded.'
      }
    }
    setDetail(next)
    setDetailLoading(false)
  }, [asOf])

  useEffect(() => {
    const entity = entities.find((candidate) => candidate.entity === selectedId)
    if (entity) void loadDetail(entity)
  }, [selectedId, entities, loadDetail])

  const selected = entities.find((entity) => entity.entity === selectedId) ?? null

  return (
    <div className="space-y-3" data-testid="entities-view">
      <PanelCard title="Entities" subtitle={`Per-entity mentions, sentiment and tiers · 24h window ending at as_of ${asOf ?? 'not set'}`} collapsible={false} bodyClassName="narrative-card-body" actions={<Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</Button>}>
        {error ? <div className="narrative-empty" data-testid="entities-empty"><p>{error}</p><span>Start the fina-scraper sidecar (npm run mcp:http:fina-scraper) and refresh.</span></div>
        : loading && !entities.length ? <p className="mt-2 text-[11px] text-muted">Loading entities…</p>
        : entities.length ? (
          <div className="overflow-x-auto">
            <table className="narrative-table" data-testid="entities-table">
              <thead><tr><th>Entity</th><th>FIBO id</th><th>Tickers</th><th>Type</th><th>24h mentions</th><th>Mean sentiment</th><th>Tiers present</th><th>Review statuses</th><th>First / last seen</th></tr></thead>
              <tbody>
                {[...entities].sort((a, b) => b.mentions - a.mentions).map((entity) => (
                  <tr key={entity.entity} data-testid={`entity-row-${entity.entity}`} onClick={() => setSelectedId(entity.entity)} className={selectedId === entity.entity ? 'is-selected cursor-pointer' : 'cursor-pointer'}>
                    <td><strong className="text-xs text-main">{entity.entity_text ?? entity.entity}</strong></td>
                    <td>{entity.entity}</td>
                    <td>{(entity.tickers ?? []).join(', ') || '—'}</td>
                    <td>{entity.entity_type ?? '—'}</td>
                    <td data-testid={`entity-mentions-${entity.entity}`}>{entity.mentions}</td>
                    <td>{formatNumber(entity.mean_sentiment)}</td>
                    <td>{entity.extraction_tiers.join(', ') || '—'}</td>
                    <td>{entity.review_statuses.map(reviewStatusLabel).join(', ') || '—'}</td>
                    <td>{formatDate(entity.first_seen)} / {formatDate(entity.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="mt-2 text-[11px] text-muted">No entity mentions in the last 24h at this as_of.</p>}
      </PanelCard>
      {selected ? (
        <PanelCard title={`Entity — ${selected.entity_text ?? selected.entity}`} subtitle="Sentiment trend, top claims, co-entities, symbol features at the decision as_of" collapsible={false} bodyClassName="narrative-card-body" actions={<Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>Close</Button>}>
          <div data-testid={`entity-detail-${selected.entity}`}>
            <section><h3 className="text-xs font-semibold text-main">Sentiment trend (last 3 buckets)</h3>
              {selected.trend?.length ? <ul className="mt-1 space-y-1">{selected.trend.map((bucket) => <li key={bucket.bucket_start} className="text-[11px] text-main">{formatDate(bucket.bucket_start)} · mean {formatNumber(bucket.mean_sentiment)} · n={bucket.n} · mentions {bucket.mentions}{bucket.mixed_tiers ? ' · mixed tiers' : ''}</li>)}</ul> : <p className="mt-1 text-[10px] text-muted">No trend buckets returned.</p>}
            </section>
            <section className="mt-3"><h3 className="text-xs font-semibold text-main">Co-entities</h3>
              {selected.top_co_occurring.length ? <p className="mt-1 text-[11px] text-main">{selected.top_co_occurring.map((co) => `${co.entity} (${co.count})`).join(' · ')}</p> : <p className="mt-1 text-[10px] text-muted">No co-occurring entities.</p>}
            </section>
            <section className="mt-3"><h3 className="text-xs font-semibold text-main">Top claims</h3>
              {detailLoading ? <p className="mt-1 text-[10px] text-muted">Loading claims…</p>
              : detail?.claimsError ? <p className="mt-1 text-[10px] text-amber-700">{detail.claimsError}</p>
              : detail?.claims.length ? <ul className="mt-1 space-y-2">{detail.claims.map((claim, index) => {
                const text = (claim.claim_text as string | undefined) ?? (claim.object as string | undefined) ?? JSON.stringify(claim)
                const tier = (claim.extraction_tier as string | undefined) ?? null
                const review = (claim.review_status as string | undefined) ?? null
                const agreeing = claim.agreeing_source_count as number | undefined
                return <li key={(claim.claim_id as string | undefined) ?? index} className="rounded border border-line p-2" data-testid={`entity-claim-${index}`}><p className="text-[11px] text-main">{text}</p><div className="mt-1 flex flex-wrap gap-1"><span className="narrative-chip">{tierLabel(tier as never)}</span><span className="narrative-chip">{reviewStatusLabel(review as never)}</span>{typeof agreeing === 'number' ? <span className="narrative-chip">{agreeing} agreeing source{agreeing === 1 ? '' : 's'}</span> : null}</div></li>
              })}</ul> : <p className="mt-1 text-[10px] text-muted">No claims for this entity at this as_of.</p>}
            </section>
            <section className="mt-3"><h3 className="text-xs font-semibold text-main">Symbol features {selected.tickers?.[0] ? `(${selected.tickers[0]})` : ''}</h3>
              {!selected.tickers?.length ? <p className="mt-1 text-[10px] text-muted">No ticker mapped to this entity — symbol features need a mapped ticker.</p>
              : detailLoading ? <p className="mt-1 text-[10px] text-muted">Loading features…</p>
              : detail?.featuresError ? <p className="mt-1 text-[10px] text-amber-700">{detail.featuresError}</p>
              : detail?.features ? detail.features.error === 'symbol_unmapped' ? <p className="mt-1 text-[10px] text-amber-700">Symbol unmapped: the lake has no entity for {selected.tickers[0]}. No feature vector was guessed.</p>
              : <div className="mt-1" data-testid={`entity-features-${selected.entity}`}>
                <p className="text-[11px] text-main">LLM-verified coverage: {detail.features.llm_verified_coverage === null || detail.features.llm_verified_coverage === undefined ? '—' : `${Math.round(detail.features.llm_verified_coverage * 100)}%`}</p>
                {detail.features.mostly_fast_glance ? <p className="mt-1 text-[10px] text-amber-700" role="status">mostly_fast_glance — over half of these features come from fast glance, not LLM verification. Treat as triage input, not thesis-grade evidence.</p> : null}
                {detail.features.features_by_tier ? <dl className="narrative-provenance mt-2">{Object.entries(detail.features.features_by_tier).map(([tier, features]) => <div key={tier}><dt>{tier}</dt><dd>{Object.entries(features).map(([key, value]) => `${key}: ${value === null || value === undefined ? '—' : value}`).join(' · ')}</dd></div>)}</dl> : <p className="mt-1 text-[10px] text-muted">No feature vector returned for this symbol at this as_of.</p>}
              </div> : null}
            </section>
          </div>
        </PanelCard>
      ) : null}
    </div>
  )
}
