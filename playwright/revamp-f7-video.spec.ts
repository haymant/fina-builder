// Revamp F7 — Playwright UI tests for the thesis-first video journey
// (NIP_DASHBOARD_REVAMP.md §e.2): thesis entry → 8-beat storyboard →
// QA blocker on an unverified span → publish gated on QA + visual review.
// Runs headless against the Vite dev server with the NIP MCP sidecar
// stubbed (see support/revamp-f7.ts). Render/QA/export are the stubbed
// deterministic producers, not a real LinkZag render: the test proves the
// UI gate chain, not the renderer binary.
import { expect, test } from './fixtures/test'
import { openVideo, stubF7 } from './support/revamp-f7'

async function createProjectAndEpisode(page: import('@playwright/test').Page, title: string) {
  await page.getByLabel('Project title').fill(title)
  await page.getByLabel('Audience').fill('Research analysts')
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await page.getByRole('button', { name: 'Create episode' }).click()
  await expect(page.getByRole('heading', { name: `${title} · Episode 1` })).toBeVisible()
  await expect(page.getByTestId('thesis-entry')).toBeVisible()
}

test.describe('F7 thesis-first video', () => {
  test('thesis entry builds an 8-beat storyboard and publish unlocks only after QA + visual review', async ({ page }) => {
    test.setTimeout(180_000)
    const state = await stubF7(page)
    await openVideo(page)
    await createProjectAndEpisode(page, 'F7 Thesis Video')

    // Step 0: load and re-verify the thesis — 3 of 3 claims re-verify, delta shown.
    await page.getByTestId('thesis-select').selectOption('thesis-f7-good')
    await page.getByTestId('thesis-load-button').click()
    await expect(page.getByTestId('thesis-card')).toBeVisible()
    await expect(page.getByTestId('thesis-verification')).toContainText('Re-verification passed')
    await expect(page.getByTestId('thesis-verification')).toContainText('3 of 3 cited claim(s) re-verified')
    await expect(page.getByTestId('backtest-table')).toContainText('Sharpe: A 1.1 · B 1.22 · Δ 0.12')

    // Before the thesis episode starts this is an event explainer, with the
    // weaker explainer gate (§f.4): no storyboard yet, no visual review.
    await expect(page.getByTestId('publish-button')).toBeDisabled()
    await expect(page.getByTestId('publish-blockers')).toContainText('no saved storyboard')
    await expect(page.getByTestId('publish-blockers')).toContainText('visual review not marked done by a human')

    // Start the thesis episode, then build the storyboard: exactly 8 thesis beats.
    await page.getByTestId('thesis-start-episode').click()
    // Now the thesis gate applies: QA has not run yet.
    await expect(page.getByTestId('publish-blockers')).toContainText('deterministic QA has not run')
    await expect(page.getByTestId('publish-blockers')).toContainText('no export manifest read back')
    await expect(page.getByTestId('thesis-build-storyboard')).toBeVisible()
    await expect(page.getByTestId('thesis-build-storyboard')).toContainText('Build thesis storyboard (3 verified claims)')
    await page.getByTestId('thesis-build-storyboard').click()
    await expect(page.getByTestId('storyboard-slide-1')).toContainText('Beat 1 — Hook + thesis')
    await expect(page.getByTestId('storyboard-slide-2')).toContainText('Beat 2 — What changed')
    await expect(page.getByTestId('storyboard-slide-3')).toContainText('Beat 3 — Evidence 1 of 3')
    await expect(page.getByTestId('storyboard-slide-4')).toContainText('Beat 4 — Evidence 2 of 3')
    await expect(page.getByTestId('storyboard-slide-5')).toContainText('Beat 5 — Evidence 3 of 3')
    await expect(page.getByTestId('storyboard-slide-6')).toContainText('Beat 6 — The test (ablation A vs B)')
    await expect(page.getByTestId('storyboard-slide-7')).toContainText('Beat 7 — What would change my mind')
    await expect(page.getByTestId('storyboard-slide-8')).toContainText('Beat 8 — Caveat + disclosure')
    await expect(page.getByTestId('storyboard-slide-9')).toHaveCount(0)

    // Render the saved slides (stubbed LinkZag job), then build the timeline.
    await page.getByTestId('video-render-button').click()
    await expect(page.locator('.video-job-banner')).toContainText('Silent commentary MP4 ready · linkzag-commentary-f7', { timeout: 30_000 })
    await page.getByTestId('timeline-build-button').click()
    await expect(page.getByTestId('timeline-result')).toContainText('timeline timeline-f7-1')

    // Deterministic QA passes; publish is still blocked on visual review + approval.
    await page.getByTestId('qa-run-button').click()
    await expect(page.getByTestId('qa-section')).toContainText('decision allow · execution complete · passed 12 · warnings 0 · blockers 0 · not run 0', { timeout: 30_000 })
    await expect(page.getByTestId('publish-blockers')).not.toContainText('deterministic QA has not run')
    await expect(page.getByTestId('publish-button')).toBeDisabled()

    // Export: profile → preflight → start → manifest read back.
    // KNOWN APP DEFECT (F7 finding, not a stub problem): startExport in
    // VideoWorkspace.tsx reads `(result.job)?.job_id`, but nip.callTool
    // camelCases structuredContent (rigaTransport unwrapToolResult), so the
    // key is `jobId` — and the real nip-engine returns
    // result["job"]["job_id"] (main.rs fina_video_export_start). The read is
    // therefore always undefined and startExport throws 'Export start
    // returned no job handle.' The export-manifest assertion below fails
    // until that one-line read is fixed (jobId with a job_id fallback).
    // App code was NOT changed: F7's brief forbids it (test ids only).
    await page.getByTestId('export-profiles-button').click()
    await expect(page.getByTestId('export-profile-select')).toHaveValue('mp4-h264-720p30-preview-v1')
    await page.getByTestId('export-preflight-button').click()
    await page.getByTestId('export-start-button').click()
    await expect(page.getByTestId('export-manifest')).toContainText('export-manifest-f7-1', { timeout: 30_000 })

    // Visual review + human approval clear the last blockers; publish records.
    await page.getByTestId('visual-review-checkbox').check()
    await expect(page.getByTestId('publish-blockers')).not.toContainText('visual review not marked done by a human')
    await page.getByTestId('publish-approval-checkbox').check()
    await expect(page.getByTestId('publish-blockers')).toContainText('All publish conditions are met.')
    await expect(page.getByTestId('publish-button')).toBeEnabled()
    await page.getByTestId('publish-button').click()
    await expect(page.getByTestId('publish-receipt')).toContainText('Published thesis_video')
    await expect(page.getByTestId('publish-receipt')).toContainText('thesis thesis-f7-good')
    await expect(page.getByTestId('publish-receipt')).toContainText('QA qa-report-f7-1')
    await expect(page.getByTestId('publish-receipt')).toContainText('export export-manifest-f7-1')
    expect(state.theses.find((t) => t.thesis_id === 'thesis-f7-good')?.status).toBe('published')
  })

  test('an unverified span blocks the thesis video at QA and publish stays disabled', async ({ page }) => {
    const state = await stubF7(page)
    await openVideo(page)
    await createProjectAndEpisode(page, 'F7 Blocked Video')

    // The bad claim's stored span does not match the retained event text.
    await page.getByTestId('thesis-select').selectOption('thesis-f7-badspan')
    await page.getByTestId('thesis-load-button').click()
    await expect(page.getByTestId('thesis-card')).toBeVisible()
    const verification = page.getByTestId('thesis-verification')
    // Three blockers: no transcript recorded for this thesis, the span does
    // not match the retained event, and no ablation is recorded. The
    // span_unverified finding is the one F7 names — it must be shown with
    // the exact failing ref, not silently dropped.
    await expect(verification).toContainText('Re-verification blocked (3 blockers)')
    await expect(verification.getByTestId('qa-finding-span_unverified')).toContainText('span [0, 50) no longer exactly matches retained event event-f7-1')
    // The same blocker is shown in the QA section, not silently dropped.
    await expect(page.getByTestId('qa-section').getByTestId('qa-finding-span_unverified')).toContainText('span_unverified (blocker)')

    // Starting the episode is allowed (only provisional theses are refused
    // there), but building the storyboard is gated on verification.
    await page.getByTestId('thesis-start-episode').click()
    const build = page.getByTestId('thesis-build-storyboard')
    await expect(build).toBeVisible()
    await expect(build).toBeDisabled()
    await expect(page.getByTestId('storyboard-slide-1')).toHaveCount(0)

    // Publish stays disabled with the verification blocker named.
    await expect(page.getByTestId('publish-button')).toBeDisabled()
    await expect(page.getByTestId('publish-blockers')).toContainText('verification has 3 blocker(s): transcript_missing, span_unverified, backtest_delta_absent')
    expect(state.theses.find((t) => t.thesis_id === 'thesis-f7-badspan')?.status).toBe('backtested')
  })
})
