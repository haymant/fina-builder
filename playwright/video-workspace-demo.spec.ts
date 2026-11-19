import { expect, test, type Page } from './fixtures/test'
import { WorkspacePage } from './pages/WorkspacePage'
import { TAG } from './support/tags'

const event = { event_id: 'event-video-demo-1', title: 'Policy outlook fixture', source_id: 'podcast-demo', source_native_id: 'episode-1', canonical_url: null, content_hash: 'demo-event-hash', content_text: 'The retained research team expects policy to remain restrictive until inflation cools.' }
const claimQuote = 'policy to remain restrictive until inflation cools'
const claimStart = Array.from(event.content_text).join('').indexOf(claimQuote)
const claim = { claim_id: 'claim-video-demo-1', claim_text: 'Policy is expected to remain restrictive until inflation cools.', speaker_or_author: 'retained research team', confidence_millis: 900, extraction_run_id: 'fixture-run-1', provider: 'fixture-only', model: 'fixture-model', prompt_version: 'fixture-v1', extracted_at: '2026-11-18T09:00:00Z', evidence: [{ event_id: event.event_id, quote: claimQuote, start_offset: claimStart, end_offset: claimStart + Array.from(claimQuote).length }] }
const claim2Quote = 'until inflation cools'
const claim2Start = Array.from(event.content_text).join('').indexOf(claim2Quote)
const claim2 = { claim_id: 'claim-video-demo-2', claim_text: 'The policy stance is tied to inflation cooling.', speaker_or_author: 'retained research team', confidence_millis: 850, extraction_run_id: 'fixture-run-2', provider: 'fixture-only', model: 'fixture-model', prompt_version: 'fixture-v1', extracted_at: '2026-11-18T09:01:00Z', evidence: [{ event_id: event.event_id, quote: claim2Quote, start_offset: claim2Start, end_offset: claim2Start + Array.from(claim2Quote).length }] }

async function stubVideoJourney(page: Page) {
  const state = { project: null as Record<string, unknown> | null, projectDeleted: false, episode: null as Record<string, unknown> | null, jobPolls: 0, captureModes: [] as string[], evidenceLinks: [] as Record<string, unknown>[], visualSpecs: [] as Record<string, unknown>[] }
  await page.route('**/nip/mcp', async (route) => {
    const body = route.request().postDataJSON() as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }
    if (body.method === 'notifications/initialized') return route.fulfill({ status: 202, body: '' })
    let value: unknown = {}
    if (body.method === 'initialize') value = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'nip-video-demo', version: '0.1.0' } }
    if (body.method === 'tools/call') {
      const name = body.params?.name
      const args = body.params?.arguments ?? {}
      if (name === 'list_video_projects') value = state.project && !state.projectDeleted ? [state.project] : []
      else if (name === 'video_capabilities') value = { planning: 'ready', evidence_linkage: 'ready', deterministic_renderer: 'linkzag_adapter', generative_video: 'not_configured', tts: 'not_configured', asr: 'not_configured', disclosure: 'Fixture-backed deterministic demo.' }
      else if (name === 'list_video_assets') value = []
      else if (name === 'list_video_workflows') value = [{ workflow_id: 'linkzag.commentary.v1', revision: 1, capability: 'deterministic_segment', provider_adapter: 'linkzag', schema_version: '1', model_identity: null, parameters: {}, created_at: '2026-11-18T09:00:00Z' }]
      else if (name === 'create_video_project') { state.project = args.project as Record<string, unknown>; value = state.project }
      else if (name === 'delete_video_project') { state.projectDeleted = true; value = { project_id: args.project_id, deleted: true, retained_global_media_and_job_history: true, retention_note: 'Shared global media assets and job history were retained.' } }
      else if (name === 'create_video_episode') { state.episode = args.episode as Record<string, unknown>; value = state.episode }
      else if (name === 'get_event') value = event
      else if (name === 'list_video_episodes') value = state.episode ? [state.episode] : []
      else if (name === 'list_video_evidence') value = [{ evidence_kind: 'event', evidence_id: event.event_id, start_offset: null, end_offset: null, quote: event.content_text }]
      else if (name === 'link_video_evidence') { state.evidenceLinks.push(args.evidence as Record<string, unknown>); value = args }
      else if (name === 'save_video_visual_spec') { state.visualSpecs.push(args.spec as Record<string, unknown>); value = args.spec }
      else if (name?.startsWith('save_video_')) value = args
      else if (name === 'render_video_linkzag') { state.captureModes.push(String(args.capture_mode ?? 'flash')); value = { job_id: 'video-demo-job-1', operation: 'linkzag.segment', status: 'queued', input_revision: args.visual_spec_revision, progress_millis: 0, cancellation_requested: false, resource_estimate: args, output_manifest: null, safe_error_message: null, started_at: null, finished_at: null, created_at: '2026-11-18T09:00:00Z' } }
      else if (name === 'video_job_status') { state.jobPolls += 1; value = state.jobPolls < 2 ? { job_id: 'video-demo-job-1', operation: 'linkzag.segment', status: 'running', input_revision: 1, progress_millis: 42000, cancellation_requested: false, resource_estimate: {}, output_manifest: null, safe_error_message: null, started_at: '2026-11-18T09:00:00Z', finished_at: null, created_at: '2026-11-18T09:00:00Z' } : { job_id: 'video-demo-job-1', operation: 'linkzag.segment', status: 'succeeded', input_revision: 1, progress_millis: 100000, cancellation_requested: false, resource_estimate: {}, output_manifest: { asset: { asset_id: 'linkzag-commentary-demo', revision: 1, asset_kind: 'linkzag_segment', relative_path: 'video/linkzag/video-demo-job-1/output/commentary.mp4', mime_type: 'video/mp4', content_hash: 'demo-checksum', width: 1280, height: 720, duration_ms: 12000, provider: 'linkzag', workflow_id: 'linkzag.commentary.v1', model: null, reproducibility: 'deterministic', capability_state: 'ready', license_state: 'fixture_only', job_id: 'video-demo-job-1', created_at: '2026-11-18T09:00:00Z' } }, safe_error_message: null, started_at: '2026-11-18T09:00:00Z', finished_at: '2026-11-18T09:00:10Z', created_at: '2026-11-18T09:00:00Z' } }
      else if (name === 'list_podcast_episodes') value = [{ title: event.title, state: 'transcribed', source_id: 'podcast-demo' }]
      else if (name === 'search_events') value = { events: [event], next_cursor: null }
      else if (name === 'list_claims') value = [claim, claim2]
      else if (name === 'transcribe_podcast_episode' || name === 'extract_claims_from_event') value = { state: 'succeeded', event_id: event.event_id, claim_id: claim.claim_id }
      const result = { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] }
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Mcp-Session-Id': 'video-demo-session' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }) })
  })
  return state
}

async function callFixtureTool(page: Page, name: string, args: Record<string, unknown>) {
  await page.evaluate(async ({ name, args }) => {
    await fetch('/nip/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }) })
  }, { name, args })
}

test('takes retained podcast evidence through configurable Video capture', { tag: [TAG.demo.any, TAG.demo.videoWorkspace, TAG.journey.videoProduction, TAG.feature.videoWorkspace, TAG.feature.narrativeEvents, TAG.feature.narrativeClaims] }, async ({ page, demo }) => {
  test.setTimeout(120_000)
  const state = await stubVideoJourney(page)
  const workspace = new WorkspacePage(page)
  await workspace.open()
  await demo.cue('Open the evidence-first production workspace')
  await demo.pause(4_000)

  await test.step('Fetch podcast episode, commit transcription, and extract claims', async () => {
    await callFixtureTool(page, 'list_podcast_episodes', {})
    await callFixtureTool(page, 'transcribe_podcast_episode', { source_id: 'podcast-demo', source_native_id: 'episode-1' })
    await callFixtureTool(page, 'search_events', { query: 'policy outlook' })
    await callFixtureTool(page, 'extract_claims_from_event', { event_id: event.event_id })
    await callFixtureTool(page, 'list_claims', {})
    await demo.cue('Podcast event, transcript, and evidence-linked claim are ready')
    await demo.pause(4_500)
  })

  await page.getByTestId('menu-video').click()
  await page.getByTestId('menuitem-video-projects').click()
  await expect(page.getByRole('heading', { name: 'Video Workspace' })).toBeVisible()
  const root = page.locator('html')
  if (await root.getAttribute('data-theme') !== 'dark') await page.getByRole('button', { name: 'Toggle theme' }).click()
  await expect(root).toHaveAttribute('data-theme', 'dark')
  const buttonColors = await page.getByRole('button', { name: 'Create project' }).evaluate((element) => {
    const style = getComputedStyle(element)
    const context = document.createElement('canvas').getContext('2d')
    if (!context) throw new Error('Canvas color evaluation is unavailable')
    const luminance = (color: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
      const pixel = context.getImageData(0, 0, 1, 1).data
      const channels = [pixel[0]!, pixel[1]!, pixel[2]!].map((value) => {
        const channel = value / 255
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2
      })
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
    }
    const foreground = style.color
    const background = style.backgroundColor
    const first = luminance(foreground)
    const second = luminance(background)
    return { foreground, background, ratio: (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05) }
  })
  expect(buttonColors.ratio, `${buttonColors.foreground} on ${buttonColors.background}`).toBeGreaterThanOrEqual(4.5)
  await demo.cue('Create a revisioned Video project')
  await page.getByLabel('Project title').fill('Policy outlook commentary')
  await page.getByLabel('Audience').fill('Research analysts')
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { name: 'Policy outlook commentary' })).toBeVisible()
  await demo.pause(3_500)

  await test.step('Create episode, link evidence, select a claim, and save claim-driven storyboard', async () => {
    await page.getByRole('button', { name: 'Create episode' }).click()
    await expect(page.getByRole('heading', { name: /Policy outlook commentary · Episode 1/ })).toBeVisible()
    const eventSearch = page.getByRole('combobox', { name: 'Search retained events' })
    await eventSearch.fill('policy outlook')
    const eventOption = page.locator('.video-event-option[role="option"]')
    await expect(eventOption).toContainText('podcast-demo · episode-1')
    await expect(eventOption).toContainText(event.content_text)
    await eventSearch.press('ArrowDown')
    await eventSearch.press('Enter')
    await expect(page.locator('.video-selected-event')).toContainText(`Selected: podcast-demo · episode-1 · ${event.event_id}`)
    await page.getByRole('button', { name: 'Load and link event' }).click()
    await expect(page.getByTestId('video-claim-picker')).toContainText(claim.claim_text)
    await expect(page.getByTestId('video-claim-picker')).toContainText(claimQuote)
    await expect(page.getByTestId('video-claim-picker')).toContainText(claim2.claim_text)
    await expect(page.getByTestId('video-claim-picker')).toContainText(claim2Quote)
    const build = page.getByRole('button', { name: 'Build from selected claims (0)' })
    await expect(build).toBeDisabled()
    const claimFilter = page.getByRole('searchbox', { name: 'Filter claims' })
    await claimFilter.fill('no matching claim')
    await expect(page.getByTestId('video-claim-picker')).toContainText('No claims match this filter.')
    await claimFilter.fill('fixture-only')
    await expect(page.getByTestId(`video-claim-option-${claim.claim_id}`)).toBeVisible()
    await expect(page.getByTestId(`video-claim-option-${claim2.claim_id}`)).toBeVisible()
    await page.getByTestId(`video-claim-select-${claim.claim_id}`).check()
    await page.getByTestId(`video-claim-select-${claim2.claim_id}`).check()
    await page.getByRole('button', { name: 'Build from selected claims (2)' }).click()
    await expect(page.getByTestId('storyboard-slide-1')).toBeVisible()
    await expect(page.getByTestId('storyboard-slide-2')).toBeVisible()
    await expect(page.getByTestId('storyboard-slide-3')).toHaveCount(0)
    await expect(page.getByTestId('storyboard-slide-1')).toContainText(claim.claim_text)
    await expect(page.getByTestId('storyboard-slide-2')).toContainText(claim2.claim_text)
    await expect(page.getByText('Audio cue scripts are in the storyboard, but TTS is not configured')).toBeVisible()
    await page.getByText(/Inspect slides.json/).click()
    await expect(page.getByTestId('storyboard-json')).toContainText(claim.claim_id)
    await expect(page.getByTestId('storyboard-json')).toContainText(claim2.claim_id)
    await expect(page.getByTestId('storyboard-json')).toContainText(claimQuote)
    await expect(page.getByTestId('storyboard-json')).toContainText(claim2Quote)
    expect(state.evidenceLinks).toEqual(expect.arrayContaining([
      expect.objectContaining({ evidence_kind: 'claim', evidence_id: claim.claim_id, start_offset: claimStart, end_offset: claimStart + Array.from(claimQuote).length, quote: claimQuote }),
      expect.objectContaining({ evidence_kind: 'event', evidence_id: event.event_id, start_offset: claimStart, end_offset: claimStart + Array.from(claimQuote).length, quote: claimQuote }),
      expect.objectContaining({ evidence_kind: 'claim', evidence_id: claim2.claim_id, start_offset: claim2Start, end_offset: claim2Start + Array.from(claim2Quote).length, quote: claim2Quote }),
      expect.objectContaining({ evidence_kind: 'event', evidence_id: event.event_id, start_offset: claim2Start, end_offset: claim2Start + Array.from(claim2Quote).length, quote: claim2Quote }),
    ]))
    expect(state.visualSpecs.flatMap((spec) => Array.isArray(spec.sources) ? spec.sources : [])).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_kind: 'claim', source_id: claim.claim_id, start_offset: claimStart, end_offset: claimStart + Array.from(claimQuote).length, quote: claimQuote }),
      expect.objectContaining({ source_kind: 'event', source_id: event.event_id, start_offset: claimStart, end_offset: claimStart + Array.from(claimQuote).length, quote: claimQuote }),
      expect.objectContaining({ source_kind: 'claim', source_id: claim2.claim_id, start_offset: claim2Start, end_offset: claim2Start + Array.from(claim2Quote).length, quote: claim2Quote }),
      expect.objectContaining({ source_kind: 'event', source_id: event.event_id, start_offset: claim2Start, end_offset: claim2Start + Array.from(claim2Quote).length, quote: claim2Quote }),
    ]))
    await demo.cue('Both explicitly selected, exact-span-backed claims drive separate slides, visuals, and evidence lineage')
    await demo.pause(4_000)
  })

  await test.step('Switch from default Flash to Full and complete the video job', async () => {
    const captureMode = page.getByLabel('Capture mode')
    await expect(captureMode).toHaveValue('flash')
    await captureMode.selectOption('full')
    await expect(captureMode).toHaveValue('full')
    await page.getByRole('button', { name: 'Render slides · silent MP4' }).click()
    await expect.poll(() => state.captureModes).toEqual(['full'])
    await expect(page.locator('.video-job-banner').getByText(/Silent commentary MP4 ready ·/)).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.video-job-banner')).toContainText('Full deterministic')
    await expect(page.locator('.video-asset-list').getByText('linkzag-commentary-demo', { exact: true })).toBeVisible()
    await demo.cue('LinkZag verifies the segment manifest and registers the final video asset')
    await demo.pause(2_500)
  })

  await test.step('Require an exact project-name confirmation before deletion', async () => {
    await page.getByRole('button', { name: '← Projects' }).click()
    const projectId = String(state.project?.project_id)
    const deleteButton = page.getByTestId(`delete-project-${projectId}`)
    await expect(deleteButton).toBeVisible()
    await deleteButton.click()
    const dialog = page.getByRole('dialog', { name: 'Delete “Policy outlook commentary”?' })
    const confirm = dialog.getByRole('button', { name: 'Delete project permanently' })
    await expect(confirm).toBeDisabled()
    const name = dialog.getByRole('textbox', { name: 'Project name confirmation' })
    await name.fill('Policy outlook')
    await expect(confirm).toBeDisabled()
    await name.fill('Policy outlook commentary')
    await expect(confirm).toBeEnabled()
    await confirm.click()
    await expect(dialog).toHaveCount(0)
    await expect(deleteButton).toHaveCount(0)
    await expect(page.locator('.video-delete-notice')).toContainText('Shared global media assets and job history were retained.')
    expect(state.projectDeleted).toBe(true)
  })
})
