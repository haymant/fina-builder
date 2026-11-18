import { expect, test } from './fixtures/test'
import { TAG } from './support/tags'
import { WorkspacePage } from './pages/WorkspacePage'

test('an analyst sets up NIP, approves one feed, transcribes locally, consents, and extracts evidence', {
  tag: [TAG.journey.narrativeSetup, TAG.journey.narrativeIngestion, TAG.journey.narrativeEvidenceReview, TAG.feature.narrativeSetup, TAG.feature.narrativeSources, TAG.feature.narrativeClaims, TAG.dependency.nip, TAG.priority.p0],
}, async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_NIP !== 'on', 'run with PLAYWRIGHT_NIP=on for the real loopback NIP service')
  test.setTimeout(120_000)

  const workspace = new WorkspacePage(page)
  await workspace.open()
  await page.getByTestId('menu-narrative').click()
  await page.getByTestId('menuitem-narrative-overview').click()
  await expect(page.getByRole('heading', { name: 'Narrative Intelligence' })).toBeVisible()

  const checklist = page.getByTestId('nip-setup-checklist')
  await expect(checklist).toContainText('DuckDB schema v9')
  await expect(checklist).toContainText('Extraction provider')
  await expect(page.getByText('Approved sources')).toBeVisible()

  await page.getByLabel('Source ID').fill('e2e-journey-feed')
  await page.getByLabel('Podcast feed URL').fill('http://127.0.0.1:8795/fixture/feed.xml')
  await page.getByLabel('Show name').fill('E2E Journey Corpus')
  await page.getByLabel('Rights statement').fill('Synthetic fixture approved for local processing and retention.')
  await page.getByLabel(/I confirm access and retention rights/).check()
  await page.getByRole('button', { name: 'Approve and sync' }).click()

  await expect(page.getByText('Feed approved and initial sync requested.')).toBeVisible()
  await expect(page.getByText('E2E Journey Corpus').first()).toBeVisible()
  await expect(page.getByText('Policy outlook fixture')).toBeVisible()

  await page.getByRole('button', { name: 'Transcribe locally' }).click()
  await expect(page.getByText('Transcript committed.', { exact: false })).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('button', { name: /Open retained transcript/ }).first()).toBeVisible()

  await page.getByRole('button', { name: /Open retained transcript/ }).first().click()
  await expect(page.getByText(/Source-linked record/)).toBeVisible()
  await expect(page.locator('.event-detail').getByText(/fixture research team expects policy/)).toBeVisible()

  const consent = page.getByTestId('event-consent-grant')
  if (await consent.isVisible()) {
    await consent.click()
    await expect(page.getByTestId('event-consent')).toHaveCount(0)
  }
  await expect(page.getByRole('button', { name: 'Extract claims' })).toBeEnabled()

  await page.getByRole('button', { name: 'Extract claims' }).click()
  await expect(page.getByText('1 claim committed with source evidence.')).toBeVisible()
  await expect(checklist).toContainText('5/5 complete')

  await page.getByRole('tab', { name: 'Claim Explorer' }).click()
  await expect(page.getByRole('heading', { name: /Policy is expected to remain restrictive/ })).toBeVisible()
  await expect(page.getByText('riga_bridge', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Source evidence' })).toBeVisible()
  await expect(page.getByRole('article', { name: 'Claim details' }).getByText('fixture-claim-model', { exact: true })).toBeVisible()
})
