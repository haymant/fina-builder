import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SchedulesView } from '../components/SchedulesView'
import type { ScraperStatus } from '../scraperTypes'

const scraperApiMock = vi.hoisted(() => ({
  scrapeSchedule: vi.fn(async () => ({ status: 'recorded' })),
  scrapeTrigger: vi.fn(async () => ({})),
  scrapeBackload: vi.fn(async () => ({ windows: 3, dry_run: true })),
}))
vi.mock('../scraperApi', () => ({ scraperApi: scraperApiMock }))

const status: ScraperStatus = {
  last_run: null,
  lake: { items: 120, entities: 9, claims: 40, edges: 60, prices: 0, backtests: 1, max_ingested_at: '2026-11-24T16:00:00Z' },
  schedules: [
    { site_id: 'alpaca-news', poll_interval_min: 5, enabled: true, llm_daily_budget: 15, thesis_daily_budget: 3, last_run: { run_id: 'run-1', started_at: '2026-11-24T15:55:00Z', finished_at: '2026-11-24T15:58:00Z', status: 'finished', summary: { new: 4 }, outputs: null, error: null }, next_run: '2026-11-24T16:03:00Z' },
  ],
  budgets: { date: '2026-11-24', llm_daily_budget: 15, llm_reviews_today: 7, thesis_daily_budget: 3, theses_today: 1 },
}

describe('SchedulesView (revamp §c.3)', () => {
  it('shows budget bars and per-schedule last/next run', () => {
    render(<SchedulesView status={status} sidecarError={null} resource={null} onChanged={vi.fn(async () => {})} />)
    expect(screen.getByTestId('budget-llm').textContent).toContain('7/15')
    expect(screen.getByTestId('budget-thesis').textContent).toContain('1/3')
    const row = screen.getByTestId('schedule-row-alpaca-news')
    expect(row.textContent).toContain('every 5 min')
    expect(row.textContent).toContain('finished')
    expect(row.textContent).toContain('new 4')
  })

  it('run-now triggers the schedule’s site', async () => {
    render(<SchedulesView status={status} sidecarError={null} resource={null} onChanged={vi.fn(async () => {})} />)
    fireEvent.click(screen.getByTestId('schedule-run-now-alpaca-news'))
    await waitFor(() => expect(scraperApiMock.scrapeTrigger).toHaveBeenCalledWith({ sites: ['alpaca-news'] }))
  })

  it('creating a schedule records it with the chosen interval and budgets', async () => {
    render(<SchedulesView status={status} sidecarError={null} resource={null} onChanged={vi.fn(async () => {})} />)
    fireEvent.change(screen.getByLabelText('Site ID'), { target: { value: 'nasdaq' } })
    fireEvent.change(screen.getByTestId('schedule-interval'), { target: { value: '30' } })
    fireEvent.click(screen.getByTestId('schedule-save'))
    await waitFor(() => expect(scraperApiMock.scrapeSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'nasdaq', pollIntervalMin: 30, llmDailyBudget: 15, thesisDailyBudget: 3 }),
    ))
  })

  it('backload dry-run lists windows without writing', async () => {
    render(<SchedulesView status={status} sidecarError={null} resource={null} onChanged={vi.fn(async () => {})} />)
    fireEvent.change(screen.getByTestId('backload-days'), { target: { value: '90' } })
    fireEvent.click(screen.getByTestId('backload-dry-run'))
    await waitFor(() => expect(scraperApiMock.scrapeBackload).toHaveBeenCalledWith(
      expect.objectContaining({ days: 90, dryRun: true }),
    ))
    expect(screen.getByTestId('backload-result').textContent).toContain('Dry run')
  })

  it('says plainly when the sidecar is down', () => {
    render(<SchedulesView status={null} sidecarError={'connect ECONNREFUSED 127.0.0.1:8798'} resource={null} onChanged={vi.fn(async () => {})} />)
    expect(screen.getByText(/sidecar unavailable/)).toBeTruthy()
  })
})
