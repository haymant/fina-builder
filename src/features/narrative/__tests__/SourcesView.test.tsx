import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SourcesView } from '../components/SourcesView'
import type { NipEvent, NipPodcastSubscription, NipSource } from '../types'
import type { ScraperSchedule } from '../scraperTypes'

const narrativeApiMock = vi.hoisted(() => ({ setSourceState: vi.fn(async () => ({})) }))
const scraperApiMock = vi.hoisted(() => ({ scrapeTrigger: vi.fn(async () => ({})) }))
vi.mock('../api', () => ({ narrativeApi: narrativeApiMock }))
vi.mock('../scraperApi', () => ({ scraperApi: scraperApiMock }))

const sources: NipSource[] = [
  { source_id: 'alpaca-news', kind: 'web', display_name: 'Alpaca News', locator: 'https://data.alpaca.markets', rights_status: 'confirmed', rights_statement: null, topics: ['NVDA'], state: 'active', poll_interval_minutes: 5, per_scan_limit: 10, notes: null, created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z', event_count: 12, episode_count: 0 },
  { source_id: 'ttu-podcast', kind: 'podcast', display_name: 'TTU Podcast', locator: 'https://example.com/feed.xml', rights_status: 'confirmed', rights_statement: null, topics: [], state: 'active', poll_interval_minutes: 60, per_scan_limit: 3, notes: null, created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z', event_count: 4, episode_count: 9 },
  { source_id: 'local-notes', kind: 'local_document', display_name: 'Local notes', locator: null, rights_status: 'confirmed', rights_statement: null, topics: [], state: 'removed', poll_interval_minutes: 0, per_scan_limit: 3, notes: null, created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z', event_count: 0, episode_count: 0 },
]
const subscriptions: NipPodcastSubscription[] = [
  { source_id: 'ttu-podcast', feed_url: 'https://example.com/feed.xml', show_name: 'TTU Podcast', rights_statement: '', rights_confirmed_at: '2026-11-20T00:00:00Z', state: 'active', last_checked_at: '2026-11-24T10:00:00Z', next_poll_at: '2026-11-24T11:00:00Z', last_error_code: 'FEED_500', consecutive_failures: 2 },
]
const schedules: ScraperSchedule[] = [
  { site_id: 'alpaca-news', poll_interval_min: 5, enabled: true, llm_daily_budget: 15, thesis_daily_budget: 3, last_run: null, next_run: null },
]
const events: NipEvent[] = []

function renderView() {
  return render(<SourcesView sources={sources} subscriptions={subscriptions} events={events} scraperSchedules={schedules} onChanged={vi.fn(async () => {})} />)
}

describe('SourcesView (revamp §c.2)', () => {
  it('renders a table (not cards) with the managed-by badge per row', () => {
    renderView()
    expect(screen.getByTestId('source-table-row-alpaca-news')).toBeTruthy()
    expect(screen.getByTestId('source-managed-by-alpaca-news').textContent).toBe('fina-scraper')
    expect(screen.getByTestId('source-managed-by-ttu-podcast').textContent).toBe('nip-engine')
    expect(screen.getByTestId('source-managed-by-local-notes').textContent).toBe('nip-engine')
  })

  it('joins feed health into the row, so a failing source is visible where it is managed', () => {
    renderView()
    expect(screen.getByTestId('source-table-row-ttu-podcast').textContent).toContain('error FEED_500 · 2 failures')
  })

  it('search filters rows and the Errors filter finds the failing feed', () => {
    renderView()
    fireEvent.change(screen.getByTestId('sources-search'), { target: { value: 'alpaca' } })
    expect(screen.queryByTestId('source-table-row-ttu-podcast')).toBeNull()
    expect(screen.getByTestId('source-table-row-alpaca-news')).toBeTruthy()
    fireEvent.change(screen.getByTestId('sources-search'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('sources-filter-errors'))
    expect(screen.queryByTestId('source-table-row-alpaca-news')).toBeNull()
    expect(screen.getByTestId('source-table-row-ttu-podcast')).toBeTruthy()
  })

  it('favourites pin and bulk pause acts on the selection', async () => {
    renderView()
    const star = screen.getByTestId('source-favourite-alpaca-news')
    expect(star.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(star)
    expect(star.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('source-select-ttu-podcast'))
    expect(screen.getByTestId('sources-bulk-bar')).toBeTruthy()
    fireEvent.click(screen.getByTestId('sources-bulk-pause'))
    await waitFor(() => expect(narrativeApiMock.setSourceState).toHaveBeenCalledWith('ttu-podcast', 'paused'))
  })

  it('bulk run-now only triggers scraper-managed sources', async () => {
    renderView()
    fireEvent.click(screen.getByTestId('source-select-alpaca-news'))
    fireEvent.click(screen.getByTestId('source-select-ttu-podcast'))
    fireEvent.click(screen.getByTestId('sources-bulk-run-now'))
    await waitFor(() => expect(scraperApiMock.scrapeTrigger).toHaveBeenCalledWith({ sites: ['alpaca-news'] }))
  })
})
