import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './fixtures/test'
import { WorkspacePage } from './pages/WorkspacePage'
import { TAG } from './support/tags'

test.use({ video: 'off' })

const transcriptNeedle = 'fixture research team expects policy'

// This only exercises the UI's lossy fina-slides-v1 projection and silent renderer smoke.
// The canonical native storyboard → EDL → QA → export journey lives in video-commentary-e2e.spec.ts.
test('UI projection smoke: fina-slides-v1 is not the canonical storyboard or final video model', {
  tag: [TAG.journey.videoProduction, TAG.feature.videoWorkspace, TAG.feature.narrativeEvents, TAG.dependency.nip, TAG.priority.p0],
}, async ({ page }) => {
  test.info().annotations.push({
    type: 'scope',
    description: 'Lossy fina-slides-v1 UI projection and silent LinkZag smoke only; canonical production is covered by video-commentary-e2e.spec.ts.',
  })
  test.skip(process.env.PLAYWRIGHT_NIP !== 'on', 'run with PLAYWRIGHT_NIP=on for the real NIP engine and LinkZag renderer')
  test.setTimeout(600_000)
  const runId = process.env.NIP_E2E_RUN_ID
  expect(runId, 'PLAYWRIGHT_NIP=on requires the launcher's explicit fresh NIP_E2E_RUN_ID').toBeTruthy()
  const runOutput = path.resolve('playwright/.data/nip', runId)

  const workspace = new WorkspacePage(page)
  await workspace.open()
  await page.getByTestId('menu-narrative').click()
  await page.getByTestId('menuitem-narrative-overview').click()
  await expect(page.getByRole('heading', { name: 'Narrative Intelligence' })).toBeVisible()

  const sourceId = `video-commentary-${Date.now()}`
  await page.getByTestId('tab-sources').click()
  await page.getByTestId('add-source-open').click()
  const sourceDialog = page.getByRole('dialog', { name: 'Add a source' })
  const sourceForm = sourceDialog.getByTestId('add-source-form')
  await sourceForm.getByLabel('Source ID').fill(sourceId)
  await sourceForm.getByLabel('Podcast feed URL').fill('http://127.0.0.1:8795/fixture/feed.xml')
  await sourceForm.getByLabel('Show name').fill(`Video Commentary E2E ${sourceId}`)
  await sourceForm.getByLabel('Rights statement').fill('Synthetic fixture approved for local processing and retention.')
  await sourceForm.getByLabel(/I confirm access and retention rights/).check()
  await sourceForm.getByRole('button', { name: 'Approve and sync' }).click()
  await page.getByTestId('tab-overview').click()
  await expect(page.getByTestId(`source-row-${sourceId}`)).toContainText(`Video Commentary E2E ${sourceId}`)
  await expect(page.getByText('Policy outlook fixture')).toBeVisible()
  await page.getByLabel('Filter episodes by source').selectOption(sourceId)

  await page.getByRole('button', { name: 'Transcribe locally' }).first().click()
  await expect(page.getByText('Transcript committed.', { exact: true })).toBeVisible({ timeout: 180_000 })
  await page.getByRole('button', { name: /Open retained transcript/ }).first().click()
  const transcriptDialog = page.getByRole('dialog', { name: 'Retained transcript' })
  await expect(transcriptDialog.getByText(new RegExp(transcriptNeedle))).toBeVisible()
  const eventId = (await transcriptDialog.getByTestId('retained-event-id').innerText()).trim()
  expect(eventId).not.toBe('')
  await transcriptDialog.getByRole('button', { name: 'Close' }).click()

  await page.getByTestId('menu-video').click()
  await page.getByTestId('menuitem-video-projects').click()
  await expect(page.getByRole('heading', { name: 'Video Workspace' })).toBeVisible()
  const projectTitle = `Commentary from ${sourceId}`
  await page.getByLabel('Project title').fill(projectTitle)
  await page.getByLabel('Audience').fill('Research analysts')
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: projectTitle })).toBeVisible()
  await page.getByRole('button', { name: 'Create episode' }).click()
  await expect(page.getByRole('heading', { name: `${projectTitle} · Episode 1` })).toBeVisible()

  await page.getByLabel('Canonical event ID').fill(eventId)
  await page.getByRole('button', { name: 'Load and link event' }).click()
  await expect(page.getByTestId('loaded-source-event')).toContainText(eventId)
  await expect(page.getByTestId('loaded-source-event')).toContainText('transcript characters')
  await page.getByRole('button', { name: 'Build slides.json' }).click()
  await expect(page.getByTestId('storyboard-slide-1')).toBeVisible()
  await expect(page.getByTestId('storyboard-slide-2')).toContainText(transcriptNeedle)
  await expect(page.getByTestId('storyboard-slide-3')).toContainText('not independent confirmation')
  await expect(page.getByText('Audio cue scripts are in the storyboard, but TTS is not configured')).toBeVisible()
  await page.getByText(/Inspect slides.json/).click()
  const jsonInspector = page.getByTestId('storyboard-json')
  await expect(jsonInspector).toContainText(eventId)
  await expect(jsonInspector).toContainText('audio_cue')
  const storyboardDownload = page.getByRole('link', { name: 'Download slides.json' })
  await expect(storyboardDownload).toHaveAttribute('download', /\.slides\.json$/)
  const [download] = await Promise.all([page.waitForEvent('download'), storyboardDownload.click()])
  const slidesJsonPath = path.join(runOutput, 'first-commentary.slides.json')
  await download.saveAs(slidesJsonPath)
  const slidesJson = JSON.parse(readFileSync(slidesJsonPath, 'utf8')) as { source_event_id?: string; slides?: unknown[] }
  expect(slidesJson.source_event_id).toBe(eventId)
  expect(slidesJson.slides).toHaveLength(3)

  await page.getByRole('button', { name: 'Render slides · silent MP4' }).click()
  const jobBanner = page.locator('.video-job-banner')
  await expect(jobBanner).toContainText(/Video job (succeeded|failed)/, { timeout: 540_000 })
  await expect(jobBanner).toContainText('Video job succeeded')
  await expect(jobBanner).toContainText('Silent commentary MP4 ready')
  await expect(page.getByTestId('video-job-lineage')).toContainText('4 upstream links: 3 saved slide specs and 1 canonical event/claim sources')
  const assetRow = page.getByTestId('video-asset-row').first()
  await expect(assetRow).toContainText('video/mp4')
  await expect(assetRow).toContainText('commentary_video')
  await expect(assetRow).toContainText('ready')
  const assetHash = await assetRow.getAttribute('data-asset-hash')
  const relativePath = await assetRow.getAttribute('data-asset-path')
  expect(assetHash).toMatch(/^[0-9a-f]{64}$/)
  expect(relativePath).toMatch(/^video\/linkzag\/.+\.mp4$/)

  const mediaRoot = path.join(runOutput, '_nip', 'media')
  const mediaFile = path.resolve(mediaRoot, relativePath!)
  expect(mediaFile.startsWith(`${mediaRoot}${path.sep}`)).toBe(true)
  expect(existsSync(mediaFile)).toBe(true)
  expect(statSync(mediaFile).size).toBeGreaterThan(0)
  expect(createHash('sha256').update(readFileSync(mediaFile)).digest('hex')).toBe(assetHash)

  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=format_name,duration:stream=codec_type,width,height',
    '-of', 'json',
    mediaFile,
  ], { encoding: 'utf8' })) as { format?: { format_name?: string; duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> }
  expect(probe.format?.format_name?.split(',')).toContain('mp4')
  expect(Number(probe.format?.duration)).toBeGreaterThan(15)
  expect(probe.streams?.some((stream) => stream.codec_type === 'video' && stream.width === 1280 && stream.height === 720)).toBe(true)
  expect(probe.streams?.some((stream) => stream.codec_type === 'audio')).toBe(false)
})
