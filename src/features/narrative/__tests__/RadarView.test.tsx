import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RadarView } from '../components/RadarView'
import type { ScraperEntityRow, SentimentTrend, NoveltyResult } from '../scraperTypes'

const scraperApiMock = vi.hoisted(() => ({
  queryEntities: vi.fn(),
  querySentimentTrend: vi.fn(),
  queryNovelty: vi.fn(),
}))
vi.mock('../scraperApi', () => ({ scraperApi: scraperApiMock }))

function entityRow(overrides: Partial<ScraperEntityRow> & { entity: string }): ScraperEntityRow {
  return {
    entity_text: null, entity_type: 'company', tickers: null, mention_count: 10, mentions: 10,
    mean_sentiment: 0.4, first_seen: '2026-11-24T10:00:00Z', last_seen: '2026-11-24T15:00:00Z',
    extraction_tiers: ['tier2_llm'], review_statuses: ['llm_verified'], top_co_occurring: [],
    ...overrides,
  }
}

function trend(overrides: Partial<SentimentTrend>): SentimentTrend {
  return {
    entity: 'fibo:NVDA', ticker: 'NVDA', bucket: '1h', window_hours: 24,
    buckets: [{ bucket_start: '2026-11-24T15:00:00Z', n: 12, mean_sentiment: 0.8, mentions: 40 }],
    baseline_mean: 0.1, baseline_std: 0.2, baseline_n: 30, z_score: 3.42, reason: null, n: 24,
    ...overrides,
  }
}

describe('RadarView — hourly per-entity radar (revamp §c.4, §f.5)', () => {
  it('shows z-score and burst with n, and marks n < 5 as insufficient data', async () => {
    scraperApiMock.queryEntities.mockResolvedValue({
      entities: [
        entityRow({ entity: 'fibo:NVDA', entity_text: 'NVIDIA Corporation', tickers: ['NVDA'], mentions: 40 }),
        entityRow({ entity: 'fibo:AAPL', entity_text: 'Apple Inc.', tickers: ['AAPL'], mentions: 5 }),
      ],
    })
    scraperApiMock.querySentimentTrend.mockImplementation(async ({ entity }: { entity: string }) =>
      entity === 'fibo:NVDA'
        ? trend({})
        : trend({ entity: 'fibo:AAPL', ticker: 'AAPL', buckets: [{ bucket_start: '2026-11-24T15:00:00Z', n: 3, mean_sentiment: 0.1, mentions: 3 }], z_score: null, reason: 'insufficient_baseline' }),
    )
    const novelty = (entity: string, burst: number): NoveltyResult => ({
      entity, ticker: null, topic: null, window_min: 60, mentions_window: 40, mentions_baseline_per_window: 8,
      burst_ratio: burst, first_seen_at: '2026-11-20T09:00:00Z', is_first_in_baseline: false, n: 40,
    })
    scraperApiMock.queryNovelty.mockImplementation(async ({ entity }: { entity: string }) =>
      entity === 'fibo:NVDA' ? novelty(entity, 5.0) : novelty(entity, 1.1),
    )
    render(<RadarView asOf="2026-11-24T16:00:00Z" signals={[]} signalWeek={null} />)
    await waitFor(() => expect(screen.getByTestId('radar-row-fibo:NVDA')).toBeTruthy())
    expect(screen.getByTestId('radar-z-fibo:NVDA').textContent).toBe('z=+3.42')
    expect(screen.getByTestId('radar-burst-fibo:NVDA').textContent).toBe('5.00×')
    expect(screen.getByTestId('radar-1h-fibo:NVDA').textContent).toContain('n=12')
    // S6 rule: the thin row is not a signal.
    expect(screen.getByTestId('radar-z-fibo:AAPL').textContent).toBe('insufficient data (n=3 < 5)')
    expect(screen.getByText(/1 row has n < 5/)).toBeTruthy()
  })

  it('keeps the weekly radar as a secondary tab', async () => {
    scraperApiMock.queryEntities.mockResolvedValue({ entities: [] })
    render(<RadarView asOf="2026-11-24T16:00:00Z" signals={[]} signalWeek={null} />)
    expect(screen.getByTestId('radar-tab-hourly')).toBeTruthy()
    expect(screen.getByTestId('radar-tab-weekly')).toBeTruthy()
  })
})
