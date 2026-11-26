import { describe, expect, it, vi, beforeEach } from 'vitest'
import { setScraperTransport, type ScraperTransport } from '../../../api/scraperTransport'
import { scraperApi } from '../scraperApi'

const calls: Array<{ name: string; args: unknown }> = []
const callToolMock = vi.fn(async (name: string, args?: unknown): Promise<unknown> => {
  calls.push({ name, args })
  // Echo the args back so the test can assert the wire shape.
  return { echo: args }
})

describe('scraperApi (service layer — components never call the sidecar directly)', () => {
  beforeEach(() => {
    calls.length = 0
    callToolMock.mockClear()
    setScraperTransport({ callTool: callToolMock } as unknown as ScraperTransport)
  })

  it('scrape_status is called with no run_id by default', async () => {
    await scraperApi.scrapeStatus()
    expect(calls).toEqual([{ name: 'scrape_status', args: {} }])
  })

  it('scrape_schedule sends snake_case args with budgets', async () => {
    await scraperApi.scrapeSchedule({ siteId: 'alpaca-news', pollIntervalMin: 5, enabled: true, llmDailyBudget: 15, thesisDailyBudget: 3 })
    expect(calls[0]).toEqual({
      name: 'scrape_schedule',
      args: { site_id: 'alpaca-news', poll_interval_min: 5, enabled: true, llm_daily_budget: 15, thesis_daily_budget: 3 },
    })
  })

  it('scrape_trigger passes the selected site ids', async () => {
    await scraperApi.scrapeTrigger({ sites: ['alpaca-news', 'nasdaq'] })
    expect(calls[0]).toEqual({ name: 'scrape_trigger', args: { sites: ['alpaca-news', 'nasdaq'], force: undefined } })
  })

  it('scrape_backload caps are the caller’s job — the args carry days and dry_run', async () => {
    await scraperApi.scrapeBackload({ days: 90, dryRun: true })
    expect(calls[0]).toEqual({ name: 'scrape_backload', args: { days: 90, sites: undefined, dry_run: true, end_date: undefined } })
  })

  it('query_entities defaults to a 1h bucket with the trend', async () => {
    await scraperApi.queryEntities({ asOf: '2026-11-24T16:00:00Z' })
    expect(calls[0]).toEqual({
      name: 'query_entities',
      args: { as_of: '2026-11-24T16:00:00Z', entity: undefined, ticker: undefined, start: undefined, limit: 50, bucket: '1h', include_trend: true, llm_verified_only: undefined },
    })
  })

  it('query_triage passes tickers and the as_of', async () => {
    await scraperApi.queryTriage({ asOf: '2026-11-24T16:00:00Z', tickers: ['NVDA'] })
    expect(calls[0].name).toBe('query_triage')
    expect((calls[0].args as Record<string, unknown>).tickers).toEqual(['NVDA'])
  })
})
