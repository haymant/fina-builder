import { createHash } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { expect, test } from './fixtures/test'
import { TAG } from './support/tags'
import { WorkspacePage } from './pages/WorkspacePage'

type RpcResponse = { result?: { structuredContent?: unknown; content?: Array<{ text?: string }>; isError?: boolean }; error?: { message?: string } }

async function connectNip(request: APIRequestContext) {
  let sessionId: string | null = null
  let nextId = 1
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const notification = method.startsWith('notifications/')
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }
    if (sessionId) headers['mcp-session-id'] = sessionId
    const response = await request.post('http://127.0.0.1:4173/nip/mcp', {
      headers,
      data: { jsonrpc: '2.0', ...(notification ? {} : { id: nextId++ }), method, params },
      timeout: 30_000,
    })
    const returnedSessionId = response.headers()['mcp-session-id']
    if (returnedSessionId) sessionId = returnedSessionId
    const body = await response.text()
    expect(response.ok(), `NIP MCP ${method} failed: HTTP ${response.status()} ${body}`).toBe(true)
    if (notification) return {}
    const parsed = JSON.parse(body) as RpcResponse
    if (parsed.error) throw new Error(`NIP MCP ${method}: ${parsed.error.message ?? body}`)
    return parsed.result ?? {}
  }

  await rpc('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'playwright-nip-thesis-journey', version: '1.0.0' },
  })
  await rpc('notifications/initialized')
  return async <T,>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await rpc('tools/call', { name, arguments: args })
    if (result.isError) {
      const detail = result.content?.map((item) => item.text ?? '').join('\n')
      throw new Error(`NIP tool ${name} failed: ${detail}`)
    }
    if (result.structuredContent !== undefined) return result.structuredContent as T
    const text = result.content?.find((item) => item.text)?.text
    return (text ? JSON.parse(text) : null) as T
  }
}

async function stubEmptyScraperInventory(page: Page) {
  // NIP is the system under test; keep its separate ownership source a known,
  // empty inventory so podcast registration can prove it is NIP-owned.
  await page.route('**/fina-scraper/mcp', async (route) => {
    const body = route.request().postDataJSON() as { id?: number; method?: string; params?: { name?: string } }
    if (body.method === 'notifications/initialized') {
      await route.fulfill({ status: 202, body: '' })
      return
    }
    let result: Record<string, unknown> = {}
    if (body.method === 'initialize') {
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'scraper-empty-inventory-fixture', version: '0.1.0' } }
    } else if (body.method === 'tools/call' && body.params?.name === 'scrape_status') {
      result = { structuredContent: { last_run: null, lake: { items: 0, entities: 0, claims: 0, edges: 0, prices: 0, backtests: 0, max_ingested_at: null }, schedules: [], budgets: { date: '2026-11-27', llm_daily_budget: 0, llm_reviews_today: 0, thesis_daily_budget: 0, theses_today: 0 }, site_inventory: [] } }
    } else if (body.method === 'tools/call' && body.params?.name === 'query_claim_corroboration') {
      result = { structuredContent: { claim: {}, source_count: 0, distinct_source_count: 0, corroboration_score: 0, agreeing: [], contradicting: [] } }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Mcp-Session-Id': 'scraper-empty-inventory-session' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) })
  })
}

async function addFixtureFeed(page: Page, sourceId: string) {
  await page.getByTestId('tab-sources').click()
  await page.getByTestId('add-source-open').click()
  const dialog = page.getByRole('dialog', { name: 'Add a source' })
  const form = dialog.getByTestId('add-source-form')
  await form.getByLabel('Source ID').fill(sourceId)
  await form.getByLabel('Podcast feed URL').fill('http://127.0.0.1:8795/fixture/feed.xml')
  await form.getByLabel('Show name').fill('E2E Journey Corpus')
  await form.getByLabel('Rights statement').fill('Synthetic fixture approved for local processing and retention.')
  const approve = form.getByRole('button', { name: 'Approve and sync' })
  await expect(approve).toBeDisabled()
  await form.getByLabel(/I confirm access and retention rights/).check()
  await expect(approve).toBeEnabled()
  await approve.click()
  await expect(page.getByText('Feed approved and initial sync requested.')).toBeVisible()
  await expect(page.getByTestId(`source-table-row-${sourceId}`)).toContainText('E2E Journey Corpus')
  await page.getByTestId('tab-overview').click()
}

async function recordUpstreamTestArtifacts(
  nip: Awaited<ReturnType<typeof connectNip>>,
  eventId: string,
  claimId: string,
) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const thesisId = `playwright-test-thesis-${suffix}`
  const transcriptId = `playwright-test-transcript-${suffix}`
  const backtestId = `playwright-test-backtest-${suffix}`
  const timestamp = new Date().toISOString()
  const scripts = [
    'Synthetic Playwright fixture only; no investment conclusion is asserted.',
    'The extracted source claim has not been reviewed and remains ineligible for thesis-grade use.',
  ]
  const transcriptHash = createHash('sha256').update(scripts.join('\n')).digest('hex')

  // These are explicit upstream test fixtures, not artifacts produced by the UI journey.
  // The test deliberately cites the still-unreviewed extracted claim so Video must block it.
  const thesis = {
    thesis_id: thesisId,
    title: `TEST FIXTURE — not an investment conclusion (${suffix})`,
    entity_symbol: null,
    direction: 'neutral',
    horizon: null,
    as_of: timestamp,
    thesis_basis: 'llm_verified_only',
    confidence_millis: null,
    reason: 'Synthetic upstream artifact for testing Narrative → Video handoff only; its cited claim is intentionally unreviewed.',
    status: 'transcript_ready',
    invalidation_condition: 'This test fixture expires when the Playwright run ends; it makes no market assertion.',
    what_would_change_mind: 'Only a real upstream research/review run could change this fixture; none is claimed here.',
    claim_ids: [claimId],
    rejected_claims: [],
    created_at: timestamp,
    updated_at: timestamp,
  }
  const transcript = {
    transcript_id: transcriptId,
    thesis_id: thesisId,
    transcript_hash: transcriptHash,
    summary: 'Synthetic UI contract fixture; it explicitly states that the extracted claim remains unreviewed.',
    beats: scripts.map((script, index) => ({
      ordinal: index + 1,
      title: index === 0 ? 'Test-only disclosure' : 'Review boundary',
      script,
      evidence_refs: index === 0
        ? [{ kind: 'event', item_id: eventId }]
        : [{ kind: 'claim', claim_id: claimId, evidence_span: 'unreviewed claim; not thesis-grade' }],
    })),
    fina_import_path: null,
    created_at: timestamp,
  }
  const backtestEvidence = {
    backtest_id: backtestId,
    thesis_id: thesisId,
    run_id_a: `not-executed-a-${suffix}`,
    run_id_b: `not-executed-b-${suffix}`,
    config_fingerprint: null,
    metrics_a: {},
    metrics_b: {},
    delta: {},
    verdict: 'could_not_run',
    could_not_run_reason: 'The Playwright fixture intentionally did not execute a strategy backtest; no performance metrics or delta are claimed.',
    recorded_at: timestamp,
    source: 'playwright:e2e-upstream-fixture-not-a-backtest-result',
  }

  await nip('save_thesis', { thesis })
  await nip('save_transcript', { transcript })
  await nip('save_backtest_evidence', { backtest_evidence: backtestEvidence })
  return { thesis, transcript, backtestEvidence }
}

test('an empty disposable NIP lake reaches a thesis-origin video episode without upgrading an unreviewed claim', {
  tag: [TAG.journey.narrativeSetup, TAG.journey.narrativeIngestion, TAG.journey.narrativeEvidenceReview, TAG.feature.narrativeSetup, TAG.feature.narrativeSources, TAG.feature.narrativeClaims, TAG.feature.videoWorkspace, TAG.dependency.nip, TAG.priority.p0],
}, async ({ page, request }) => {
  test.skip(process.env.PLAYWRIGHT_NIP !== 'on', 'run with PLAYWRIGHT_NIP=on and a fresh NIP_E2E_RUN_ID for the real loopback NIP service')
  test.setTimeout(240_000)
  const runId = process.env.NIP_E2E_RUN_ID
  expect(runId, 'PLAYWRIGHT_NIP=on requires the launcher-provided fresh NIP_E2E_RUN_ID').toBeTruthy()

  const nip = await connectNip(request)
  await stubEmptyScraperInventory(page)
  const initialResource = await nip<{ event_count: number; claim_count: number; database_path: string }>('nip_resource_status')
  expect(initialResource.event_count, 'the disposable NIP lake must be empirically empty before UI ingestion').toBe(0)
  expect(initialResource.claim_count).toBe(0)
  expect(initialResource.database_path).toContain(`${runId}/_nip`)
  expect(await nip<unknown[]>('list_sources', { include_removed: true })).toEqual([])
  expect(await nip<unknown[]>('list_theses')).toEqual([])

  const provider = await nip<{ provider_kind: string; provider_id: string; model: string; remote: boolean; consent: string }>('nip_provider_status')
  expect(provider.provider_kind).toBe('remote')
  expect(provider.provider_id).toBe('riga-fixture-provider')
  expect(provider.model).toBe('fixture-claim-model')
  expect(provider.remote).toBe(true)
  expect(provider.consent).not.toBe('granted')

  const workspace = new WorkspacePage(page)
  await workspace.open()
  await page.getByTestId('menu-narrative').click()
  await page.getByTestId('menuitem-narrative-overview').click()
  await expect(page.getByRole('heading', { name: 'Narrative Intelligence' })).toBeVisible()

  const checklist = page.getByTestId('nip-setup-checklist')
  await expect(checklist).toContainText(/DuckDB schema v20/)
  await expect(checklist).toContainText('Extraction provider')
  await expect(checklist).toContainText('Approved source')
  await expect(page.getByTestId('canonical-event-id')).toHaveCount(0)
  await expect(page.getByTestId('tab-sources')).toHaveAttribute('aria-selected', 'false')

  const sourceId = `e2e-journey-${runId}`
  await addFixtureFeed(page, sourceId)
  await expect(page.getByText('Policy outlook fixture')).toBeVisible()
  await page.getByRole('button', { name: 'Transcribe locally' }).click()
  await expect(page.getByText('Transcript committed.', { exact: false })).toBeVisible({ timeout: 120_000 })
  await expect(page.getByRole('button', { name: /Open retained transcript/ }).first()).toBeVisible()

  await page.getByRole('button', { name: /Open retained transcript/ }).first().click()
  const transcriptDialog = page.getByRole('dialog', { name: 'Retained transcript' })
  await expect(transcriptDialog).toContainText(/fixture research team expects policy/)
  await page.getByRole('button', { name: 'Show in event list' }).click()
  await expect(page.getByText(/Source-linked record/)).toBeVisible()
  const eventId = (await page.getByTestId('canonical-event-id').innerText()).trim()
  expect(eventId).not.toBe('')

  const consentPanel = page.getByTestId('event-consent')
  await expect(consentPanel).toBeVisible()
  await expect(consentPanel).toContainText('fixture-claim-model')
  await page.getByTestId('event-consent-grant').click()
  await expect(page.getByTestId('event-consent')).toHaveCount(0)
  await expect.poll(async () => (await nip<{ consent: string }>('nip_provider_status')).consent).toBe('granted')

  await page.getByRole('button', { name: 'Extract claims' }).click()
  await expect(page.locator('.event-detail').getByText('1 claim committed with source evidence.')).toBeVisible()
  const event = await nip<{ event_id: string; content_text: string }>('get_event', { event_id: eventId })
  expect(event.event_id).toBe(eventId)
  expect(event.content_text).toContain('fixture research team expects policy')
  const claims = await nip<Array<{ claim_id: string; claim_text: string; extraction_tier?: string | null; review_status?: string | null; evidence: Array<{ event_id: string; quote: string | null; start_offset: number | null; end_offset: number | null }> }>>('list_claims')
  const claim = claims.find((item) => item.evidence.some((span) => span.event_id === eventId))
  expect(claim, 'the transcript must produce a persisted claim linked to its canonical event').toBeTruthy()
  expect(claim!.evidence[0]!.quote).toBeTruthy()
  expect(event.content_text.slice(claim!.evidence[0]!.start_offset!, claim!.evidence[0]!.end_offset!)).toBe(claim!.evidence[0]!.quote)
  expect(['llm_verified', 'llm_corrected']).not.toContain(claim!.review_status)
  expect(claim!.extraction_tier).not.toBe('tier2_llm')

  const { thesis, transcript, backtestEvidence } = await recordUpstreamTestArtifacts(nip, eventId, claim!.claim_id)
  expect((await nip<Array<Record<string, unknown>>>('list_theses')).some((item) => item.thesis_id === thesis.thesis_id)).toBe(true)
  expect(await nip('list_transcripts', { thesis_id: thesis.thesis_id })).toMatchObject([{ transcript_id: transcript.transcript_id, thesis_id: thesis.thesis_id, transcript_hash: transcript.transcript_hash }])
  expect(await nip('list_backtest_evidence', { thesis_id: thesis.thesis_id })).toMatchObject([{ backtest_id: backtestEvidence.backtest_id, verdict: 'could_not_run', delta: {} }])

  await page.reload()
  await expect(page.getByRole('heading', { name: 'Narrative Intelligence' })).toBeVisible()
  await page.getByTestId('nav-thesis').click()
  const thesisRow = page.getByTestId(`thesis-row-${thesis.thesis_id}`)
  await expect(thesisRow).toContainText('TEST FIXTURE')
  await expect(page.getByTestId(`thesis-transcript-${transcript.transcript_id}`)).toBeVisible()
  await expect(page.getByTestId(`thesis-backtest-${backtestEvidence.backtest_id}`)).toContainText('could not run')
  await expect(page.getByTestId('thesis-send-to-video')).toBeEnabled()
  await page.getByTestId('thesis-send-to-video').click()

  await expect(page.getByRole('heading', { name: 'Video Workspace' })).toBeVisible()
  const handoff = await page.evaluate(() => JSON.parse(localStorage.getItem('fina.location.v1') ?? 'null')) as Record<string, unknown>
  expect(handoff).toMatchObject({ kind: 'video', view: 'projects', thesisId: thesis.thesis_id, transcriptId: transcript.transcript_id })
  const projectTitle = `Test-only thesis video ${runId}`
  await page.getByLabel('Project title').fill(projectTitle)
  await page.getByLabel('Audience').fill('Playwright UI contract test; not for publication')
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByRole('heading', { level: 1, name: projectTitle })).toBeVisible()
  await page.getByRole('button', { name: 'Create episode' }).click()
  await expect(page.getByRole('heading', { name: `${projectTitle} · Episode 1` })).toBeVisible()

  const thesisCard = page.getByTestId('thesis-card')
  await expect(thesisCard).toContainText(transcript.transcript_id)
  await expect(page.getByTestId('thesis-verification')).toContainText('thesis_claim_not_llm_verified')
  await expect(page.getByTestId('thesis-verification')).toContainText('0 of 1 cited claim(s) re-verified')
  await expect(page.getByTestId('backtest-table')).toContainText('The Playwright fixture intentionally did not execute a strategy backtest')
  await expect(page.getByTestId('backtest-table')).not.toContainText('Δ 0')

  await page.getByTestId('thesis-start-episode').click()
  await expect(page.getByTestId('video-episode-workspace')).toBeVisible()
  await expect(page.getByTestId('thesis-entry')).toContainText('Thesis video')
  await expect(page.getByTestId('thesis-verification')).toContainText('thesis_claim_not_llm_verified')
  await expect(page.getByTestId('thesis-build-storyboard')).toBeDisabled()
  await expect(page.getByTestId('video-render-button')).toBeDisabled()

  const projects = await nip<Array<{ project_id: string; title: string }>>('list_video_projects')
  const project = projects.find((item) => item.title === projectTitle)
  expect(project).toBeTruthy()
  const episodes = await nip<Array<{ episode_id: string; project_id: string; origin: string; thesis_id: string; transcript_id: string; transcript_hash: string }>>('list_video_episodes', { project_id: project!.project_id })
  const thesisEpisode = episodes.find((item) => item.origin === 'thesis')
  expect(thesisEpisode).toMatchObject({
    project_id: project!.project_id,
    thesis_id: thesis.thesis_id,
    transcript_id: transcript.transcript_id,
    transcript_hash: transcript.transcript_hash,
  })
  expect(await nip('list_video_episode_visual_specs', { project_id: project!.project_id, episode_id: thesisEpisode!.episode_id })).toEqual([])
  expect(await nip('list_video_evidence', { episode_id: thesisEpisode!.episode_id, episode_revision: 1 })).toEqual([])

  // Verify the claim is still unreviewed in NIP after the entire handoff.
  const finalClaims = await nip<Array<{ claim_id: string; extraction_tier?: string | null; review_status?: string | null }>>('list_claims')
  const finalClaim = finalClaims.find((item) => item.claim_id === claim!.claim_id)
  expect(finalClaim?.review_status).not.toBe('llm_verified')
  expect(finalClaim?.review_status).not.toBe('llm_corrected')
  expect(finalClaim?.extraction_tier).not.toBe('tier2_llm')
})
