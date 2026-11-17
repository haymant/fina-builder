import { expect, test } from './fixtures/test'
import { TAG } from './support/tags'
import { WorkspacePage } from './pages/WorkspacePage'

const startedAt = Date.now()

function mark(label: string) {
  console.log(`[demo-cue] ${((Date.now() - startedAt) / 1000).toFixed(2)}s ${label}`)
}

test('sets up NIP, approves a feed, transcribes, extracts evidence, and reviews the derived workspace', {
  tag: [TAG.demo.any, TAG.demo.narrativeResearch, TAG.journey.narrativeSetup, TAG.journey.narrativeIngestion, TAG.journey.narrativeEvidenceReview, TAG.feature.narrativeSetup, TAG.feature.narrativeSources, TAG.feature.narrativeEvents, TAG.feature.narrativeClaims, TAG.dependency.nip, TAG.priority.p1],
}, async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_NIP !== 'on', 'run with PLAYWRIGHT_NIP=on for the real loopback NIP service')
  test.setTimeout(180_000)

  const workspace = new WorkspacePage(page)
  const checklist = page.getByTestId('nip-setup-checklist')

  await test.step('Open Narrative Intelligence from the desktop menu', async () => {
    mark('open-workspace')
    await workspace.open()
    await page.getByTestId('menu-narrative').click()
    await page.getByTestId('menuitem-narrative-overview').click()
    await expect(page.getByRole('heading', { name: 'Narrative Intelligence' })).toBeVisible()
    await page.waitForTimeout(4_000)
  })

  await test.step('Review first-run setup and source boundaries', async () => {
    mark('review-setup')
    await expect(checklist).toBeVisible()
    await expect(checklist).toContainText('DuckDB schema v9')
    await expect(checklist).toContainText('Extraction provider')
    await expect(page.getByText('Approved sources')).toBeVisible()
    await page.waitForTimeout(5_500)
  })

  await test.step('Approve one podcast feed with rights confirmation', async () => {
    mark('approve-feed')
    await page.getByLabel('Source ID').fill('demo-fixture-feed')
    await page.getByLabel('Podcast feed URL').fill('http://127.0.0.1:8795/fixture/feed.xml')
    await page.getByLabel('Show name').fill('Illustrative Test Corpus')
    await page.getByLabel('Rights statement').fill('Synthetic fixture approved for local processing and retention.')
    await page.getByLabel(/I confirm access and retention rights/).check()
    await page.waitForTimeout(1_000)
    await page.getByRole('button', { name: 'Approve and sync' }).click()
    await expect(page.getByText('Feed approved and initial sync requested.')).toBeVisible()
    await expect(page.getByText('Illustrative Test Corpus').first()).toBeVisible()
    await page.waitForTimeout(5_500)
  })

  await test.step('Inspect the automatically discovered episode', async () => {
    mark('inspect-episode')
    await expect(page.getByText('Policy outlook fixture')).toBeVisible()
    await expect(page.getByText('awaiting local transcription')).toBeVisible()
    await page.waitForTimeout(5_000)
  })

  await test.step('Transcribe the episode locally', async () => {
    mark('transcribe')
    await page.getByRole('button', { name: 'Transcribe locally' }).click()
    await expect(page.getByText('Episode transcribed locally.')).toBeVisible()
    await expect(page.getByRole('button', { name: /nip-fixture-episode-1/ })).toBeVisible()
    await page.waitForTimeout(5_500)
  })

  await test.step('Open the retained transcript and its provenance', async () => {
    mark('open-transcript')
    await page.getByRole('button', { name: /nip-fixture-episode-1/ }).click()
    await expect(page.getByText(/Source-linked record/)).toBeVisible()
    await expect(page.locator('.event-detail').getByText(/fixture research team expects policy/)).toBeVisible()
    await page.waitForTimeout(6_000)
  })

  await test.step('Grant NIP consent for the remote extraction provider', async () => {
    mark('grant-consent')
    const consent = page.getByTestId('event-consent-grant')
    if (await consent.isVisible()) {
      await consent.click()
      await expect(page.getByTestId('event-consent')).toHaveCount(0)
    }
    await page.waitForTimeout(5_500)
  })

  await test.step('Extract evidence-linked claims from the transcript', async () => {
    mark('extract-claims')
    await page.getByRole('button', { name: 'Extract claims' }).click()
    await expect(page.getByText('1 claim committed with source evidence.')).toBeVisible()
    await expect(checklist).toContainText('5/5 complete')
    await page.waitForTimeout(5_000)
  })

  await test.step('Review the claim and its source evidence', async () => {
    mark('review-claim')
    await page.getByRole('tab', { name: 'Claim Explorer' }).click()
    await expect(page.getByRole('heading', { name: /Policy is expected to remain restrictive/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Source evidence' })).toBeVisible()
    await expect(page.getByText('riga_bridge', { exact: true })).toBeVisible()
    await page.waitForTimeout(6_500)
  })

  await test.step('Rebuild the cluster and graph projections', async () => {
    mark('rebuild-derived')
    await page.getByRole('tab', { name: 'Graph' }).click()
    await page.getByRole('button', { name: 'Rebuild clusters' }).click()
    await expect(page.getByText(/narrative cluster.* rebuilt from canonical events/)).toBeVisible()
    await page.getByRole('button', { name: 'Rebuild graph' }).click()
    await expect(page.getByText(/evidence-linked edges/)).toBeVisible()
    await page.waitForTimeout(5_500)
  })

  await test.step('Follow a graph edge back to the immutable source event', async () => {
    mark('graph-evidence')
    await page.getByRole('button', { name: /Evidence event-/ }).first().click()
    await expect(page.getByText(/Source-linked record/)).toBeVisible()
    await page.waitForTimeout(5_000)
  })

  await test.step('Review the descriptive Radar and Timeline windows', async () => {
    mark('radar-timeline')
    await page.getByRole('tab', { name: 'Radar' }).click()
    await expect(page.getByRole('heading', { name: 'Narrative Radar' })).toBeVisible()
    await expect(page.getByText(/unknown coverage/)).toBeVisible()
    await page.waitForTimeout(6_000)
    await page.getByRole('tab', { name: 'Timeline' }).click()
    await expect(page.getByRole('heading', { name: 'Narrative Timeline' })).toBeVisible()
    await page.waitForTimeout(6_000)
  })

  await test.step('Review the ETF and editorial research boundaries', async () => {
    mark('boundaries')
    await page.getByRole('tab', { name: 'ETF Themes' }).click()
    await expect(page.getByRole('heading', { name: 'ETF Themes' })).toBeVisible()
    await expect(page.getByText(/No manual ETF mappings yet/)).toBeVisible()
    await page.waitForTimeout(5_500)
    await page.getByRole('tab', { name: 'Editorial' }).click()
    await expect(page.getByRole('heading', { name: 'Editorial Planning' })).toBeVisible()
    await expect(page.getByText(/Awaiting human review|No editorial candidates yet/)).toBeVisible()
    await page.waitForTimeout(5_500)
  })

  await test.step('Return to the completed setup checklist', async () => {
    mark('close')
    await page.getByRole('tab', { name: 'Event review' }).click()
    await expect(checklist).toContainText('5/5 complete')
    await page.waitForTimeout(8_500)
  })
})
