import { expect, test } from './fixtures/test'
import { TAG } from './support/tags'
import { WorkspacePage } from './pages/WorkspacePage'

const { journey, feature } = TAG

const event = {
  schema_version: 1,
  event_id: 'event-e2e-1',
  source_id: 'e2e-fixture-source',
  source_native_id: 'episode-e2e-1',
  canonical_url: 'fixture://episode-e2e-1',
  content_hash: 'e2e-hash-123',
  content_text: 'The committee expects policy to remain restrictive until inflation cools.',
  times: {
    published_at: '2026-11-15T12:00:00Z',
    source_updated_at: null,
    captured_at: '2026-11-16T09:00:00Z',
    ingested_at: '2026-11-16T09:00:01Z',
  },
  revision_of: null,
}

const claim = {
  claim_id: 'claim-e2e-1',
  claim_text: 'Policy is expected to remain restrictive.',
  speaker_or_author: 'Synthetic analyst',
  confidence_millis: 920,
  extraction_run_id: 'run-e2e-1',
  provider: 'deterministic_fake',
  model: 'fixture-claim-model',
  prompt_version: 'nip-claims-v1',
  extracted_at: '2026-11-16T09:01:00Z',
  evidence: [{ event_id: event.event_id, quote: 'policy to remain restrictive until inflation cools', start_offset: 18, end_offset: 67 }],
}

async function stubNip(page: import('@playwright/test').Page) {
  await page.route('**/nip/mcp', async (route) => {
    const request = route.request()
    const body = request.postDataJSON() as { id?: number; method?: string; params?: { name?: string } }
    if (body.method === 'notifications/initialized') {
      await route.fulfill({ status: 202, body: '' })
      return
    }
    let result: Record<string, unknown> = {}
    if (body.method === 'initialize') {
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'nip-e2e', version: '0.1.0' } }
    } else if (body.method === 'tools/call') {
      const name = body.params?.name
      const structuredContent = name === 'health'
        ? { service: 'nip-engine', api_version: 1, readiness: 'ready', schema_version: 4 }
        : name === 'search_events'
          ? { events: [event], next_cursor: null }
          : name === 'list_claims'
            ? [claim]
            : {}
      result = { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Mcp-Session-Id': 'e2e-session' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) })
  })
}

test('reviews retained events and opens an evidence-linked claim', {
  tag: [journey.narrativeReview, feature.narrative, TAG.smoke],
}, async ({ page }) => {
  await stubNip(page)
  const workspace = new WorkspacePage(page)
  await workspace.open()

  await page.getByTestId('menu-narrative').click()
  await page.getByTestId('menuitem-narrative-overview').click()
  await expect(page.getByRole('heading', { name: 'Narrative Intelligence' })).toBeVisible()
  await expect(page.getByText('episode-e2e-1')).toBeVisible()
  await expect(page.getByText(/Ready for local review/)).toBeVisible()

  await page.getByRole('tab', { name: 'Claim Explorer' }).click()
  await expect(page.getByRole('heading', { name: 'Policy is expected to remain restrictive.' })).toBeVisible()
  await expect(page.getByText('“policy to remain restrictive until inflation cools”')).toBeVisible()
  await expect(page.getByText('deterministic_fake')).toBeVisible()

  await expect(page.getByText('Event event-e2e-1')).toBeVisible()
  await expect(page.getByText('Source evidence')).toBeVisible()
})
