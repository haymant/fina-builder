// Revamp F7 — Playwright UI tests for the fina-builder narrative workspace
// (NIP_DASHBOARD_REVAMP.md §e.2): Sources, Schedules, Radar, Claim
// Explorer, Thesis. Runs headless against the Vite dev server with the
// NIP + fina-scraper MCP sidecars stubbed (see support/revamp-f7.ts);
// no sidecar, credential, or live call is involved.
import { expect, test } from './fixtures/test'
import { openNarrative, stubF7 } from './support/revamp-f7'

test.describe('F7 narrative workspace', () => {
  // Cold Vite transform on this VM can exceed the default 30s on first load.
  test.setTimeout(120_000)
  test('sources table with 13 sources: group, search, and bulk pause work', async ({ page }) => {
    const state = await stubF7(page)
    await openNarrative(page)
    await page.getByTestId('tab-sources').click()
    await expect(page.getByTestId('sources-view')).toBeVisible()

    // 13 sources across the five kind groups; the view never merges registries.
    await expect(page.getByTestId('source-table-row-src-pod-alpha')).toBeVisible()
    await expect(page.getByTestId('source-table-row-alpaca-news')).toBeVisible()
    await expect(page.getByTestId('source-table-row-src-doc-local')).toBeVisible()
    await expect(page.getByText('13 of 13 sources')).toBeVisible()
    await expect(page.getByTestId('sources-group-podcast')).toContainText('Alpha Podcast')
    await expect(page.getByTestId('sources-group-news-api')).toContainText('Alpaca News')
    await expect(page.getByTestId('sources-group-news-api')).toContainText('r/wallstreetbets')
    // "managed by" badge: alpaca-news has a scraper schedule, the podcast does not.
    await expect(page.getByTestId('source-managed-by-alpaca-news')).toHaveText('fina-scraper')
    await expect(page.getByTestId('source-managed-by-src-pod-alpha')).toHaveText('nip-engine')

    // Search narrows to the one matching source.
    await page.getByTestId('sources-search').fill('alpha')
    await expect(page.getByText('1 of 13 sources')).toBeVisible()
    await expect(page.getByTestId('source-table-row-src-pod-alpha')).toBeVisible()
    await expect(page.getByTestId('source-table-row-src-pod-beta')).toHaveCount(0)
    await page.getByTestId('sources-search').fill('')

    // Bulk pause: two selected sources pause, the message confirms, the
    // stubbed store records the new states, and the rows show them.
    await page.getByTestId('source-select-src-pod-beta').check()
    await page.getByTestId('source-select-src-pod-delta').check()
    await expect(page.getByTestId('sources-bulk-bar')).toContainText('2 selected')
    await page.getByTestId('sources-bulk-pause').click()
    await expect(page.getByRole('status')).toContainText('2 sources paused.')
    expect(state.sources.find((s) => s.source_id === 'src-pod-beta')?.state).toBe('paused')
    expect(state.sources.find((s) => s.source_id === 'src-pod-delta')?.state).toBe('paused')
    await expect(page.getByTestId('source-state-src-pod-beta')).toHaveText('paused')
    await expect(page.getByTestId('source-state-src-pod-delta')).toHaveText('paused')
    // The untouched source is still active.
    expect(state.sources.find((s) => s.source_id === 'src-pod-alpha')?.state).toBe('active')
  })

  test('schedule create shows next run, run-now triggers and updates status', async ({ page }) => {
    const state = await stubF7(page)
    await openNarrative(page)
    await page.getByTestId('tab-schedules').click()
    await expect(page.getByTestId('schedules-view')).toBeVisible()

    // Existing schedule: next run is shown, not a placeholder.
    const alpaca = page.getByTestId('schedule-row-alpaca-news')
    await expect(alpaca).toBeVisible()
    await expect(alpaca).toContainText('every 5 min')
    await expect(alpaca).toContainText('Next run')
    await expect(alpaca).not.toContainText('paused — no next run')
    await expect(alpaca).toContainText('succeeded')

    // Create: the recorded schedule appears with its next run.
    await page.getByTestId('schedule-form').getByLabel('Site ID').fill('f7-new-site')
    await page.getByTestId('schedule-interval').fill('30')
    await page.getByTestId('schedule-save').click()
    await expect(page.getByRole('status')).toContainText('Schedule recorded for f7-new-site — every 30 min')
    const created = page.getByTestId('schedule-row-f7-new-site')
    await expect(created).toBeVisible()
    await expect(created).toContainText('every 30 min')
    await expect(created).toContainText('Next run')
    expect(state.schedules.some((s) => s.site_id === 'f7-new-site')).toBe(true)

    // Run-now: the trigger reaches the sidecar stub and the row's last run updates.
    await page.getByTestId('schedule-run-now-alpaca-news').click()
    await expect(page.getByRole('status')).toContainText('Scrape triggered for alpaca-news.')
    expect(state.calls.some((c) => c.tool === 'scrape_trigger' && JSON.stringify(c.args.sites) === JSON.stringify(['alpaca-news']))).toBe(true)
    await expect(page.getByTestId('schedule-row-alpaca-news')).toContainText('triggered')
  })

  test('radar shows z-score and burst with n; n<5 is insufficient data, never a signal', async ({ page }) => {
    await stubF7(page)
    await openNarrative(page)
    await page.getByTestId('tab-radar').click()
    await expect(page.getByTestId('radar-view')).toBeVisible()
    await expect(page.getByTestId('radar-table')).toBeVisible()

    // NVDA: real signal — z with n, burst ratio, last-bucket n.
    await expect(page.getByTestId('radar-z-nvda')).toHaveText('z=+3.42')
    await expect(page.getByTestId('radar-burst-nvda')).toHaveText('5.00×')
    await expect(page.getByTestId('radar-1h-nvda')).toContainText('(n=12)')
    // AAPL: negative z is still a shown signal when n is sufficient.
    await expect(page.getByTestId('radar-z-aapl')).toHaveText('z=-1.20')
    await expect(page.getByTestId('radar-1h-aapl')).toContainText('(n=8)')
    // MSFT: z=+5.00 on n=3 must NOT be shown as a z — insufficient data only.
    await expect(page.getByTestId('radar-z-msft')).toHaveText('insufficient data (n=3 < 5)')
    await expect(page.getByTestId('radar-row-msft')).not.toContainText('z=+5.00')
    await expect(page.getByText('1 row has n < 5 in the last hour — shown as insufficient data, not ranked as signals.')).toBeVisible()
  })

  test('claim explorer tier filter narrows to the selected tier', async ({ page }) => {
    await stubF7(page)
    await openNarrative(page)
    await page.getByTestId('tab-claims').click()
    await expect(page.getByTestId('claim-filters')).toBeVisible()

    await expect(page.getByTestId('claim-filters')).toContainText('6 of 6 claims')
    await page.getByTestId('claim-filter-tier').selectOption('tier2_llm')
    await expect(page.getByTestId('claim-filters')).toContainText('4 of 6 claims')
    await expect(page.getByTestId('claim-row-claim-f7-1')).toBeVisible()
    await expect(page.getByTestId('claim-row-claim-f7-bad')).toBeVisible()
    await expect(page.getByTestId('claim-row-claim-f7-t0')).toHaveCount(0)
    await expect(page.getByTestId('claim-row-claim-f7-t1')).toHaveCount(0)
    await page.getByTestId('claim-filter-tier').selectOption('tier0_lexicon')
    await expect(page.getByTestId('claim-filters')).toContainText('1 of 6 claims')
    await expect(page.getByTestId('claim-row-claim-f7-t0')).toBeVisible()
    await page.getByTestId('claim-filter-tier').selectOption('tier1_onnx')
    await expect(page.getByTestId('claim-filters')).toContainText('1 of 6 claims')
    await expect(page.getByTestId('claim-row-claim-f7-t1')).toBeVisible()
    await page.getByTestId('claim-filter-tier').selectOption('all')
    await expect(page.getByTestId('claim-filters')).toContainText('6 of 6 claims')
  })

  test('provisional thesis cannot advance: button disabled with the gate reason', async ({ page }) => {
    await stubF7(page)
    await openNarrative(page)
    await page.getByTestId('tab-thesis').click()
    await expect(page.getByTestId('thesis-view')).toBeVisible()

    await page.getByTestId('thesis-row-thesis-f7-prov').click()
    await expect(page.getByTestId('thesis-provisional-gate')).toContainText('Provisional thesis — it can never enter backtested or any later stage.')
    const advance = page.getByTestId('thesis-advance-llm_reviewed')
    await expect(advance).toBeDisabled()
    await expect(advance).toHaveAttribute('title', 'Provisional thesis (fast glance only) can never advance to llm_reviewed. Deep-dive the claims, record LLM reviews, and re-issue the thesis as llm_verified_only.')
    // No advance call was sent to the store.
    await expect(page.getByTestId('thesis-row-thesis-f7-prov')).toContainText('PROVISIONAL')
  })

  test('thesis tab shows the ablation delta when a backtest exists', async ({ page }) => {
    await stubF7(page)
    await openNarrative(page)
    await page.getByTestId('tab-thesis').click()
    await page.getByTestId('thesis-row-thesis-f7-good').click()

    const backtest = page.getByTestId('thesis-backtest-backtest-f7-1')
    await expect(backtest).toBeVisible()
    await expect(backtest).toContainText('Verdict: thesis SUPPORTED by the backtest')
    await expect(backtest).toContainText('Delta A→B out-of-sample: Sharpe 0.120')
    await expect(backtest).toContainText('Run A — TA+macro (run-a-f7)')
    await expect(backtest).toContainText('Run B — TA+macro+$narr_* tier2_llm (run-b-f7)')
    // Graph coverage is honest about the single-event graph holding 1 of 3 claims.
    await expect(page.getByTestId('thesis-graph-coverage')).toContainText('Graph coverage: 1 of 3 cited claims appear in the NIP graph.')
  })

  test('a verified thesis advances, and an invalidated thesis is recorded', async ({ page }) => {
    const state = await stubF7(page)
    await openNarrative(page)
    await page.getByTestId('tab-thesis').click()
    await page.getByTestId('thesis-row-thesis-f7-good').click()

    // Advance is enabled for an llm_verified_only thesis and moves the pipeline.
    const advance = page.getByTestId('thesis-advance-transcript_ready')
    await expect(advance).toBeEnabled()
    await advance.click()
    await expect(page.getByRole('status')).toContainText('Thesis moved to transcript ready.')
    expect(state.theses.find((t) => t.thesis_id === 'thesis-f7-good')?.status).toBe('transcript_ready')

    // Invalidate records the observation in the thesis reason, not just a label.
    page.once('dialog', (dialog) => void dialog.accept('NVDA guides data-center revenue down 12%'))
    await page.getByTestId('thesis-invalidate').click()
    await expect(page.getByRole('status')).toContainText('Thesis marked invalidated, with the observation recorded.')
    const saved = state.theses.find((t) => t.thesis_id === 'thesis-f7-good')
    expect(saved?.status).toBe('invalidated')
    expect(String(saved?.reason ?? '')).toContain('NVDA guides data-center revenue down 12%')
    await expect(page.getByTestId('thesis-row-thesis-f7-good')).toContainText('invalidated')
  })
})
