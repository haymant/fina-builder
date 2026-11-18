import { expect, test, type Page } from '@playwright/test'
import { TAG } from './support/tags'
import { WorkspacePage } from './pages/WorkspacePage'

const event = {
  schema_version: 1,
  event_id: 'event-setup-1',
  source_id: 'setup-fixture-source',
  source_native_id: 'nip-fixture-episode-1',
  canonical_url: 'http://127.0.0.1:8795/fixture/episode-1',
  content_hash: 'setup-hash-123',
  content_text: 'The fixture research team expects policy to remain restrictive until inflation cools.',
  times: {
    published_at: '2026-11-15T12:00:00Z',
    source_updated_at: null,
    captured_at: '2026-11-16T09:00:00Z',
    ingested_at: '2026-11-16T09:00:01Z',
  },
  revision_of: null,
}

const claim = {
  claim_id: 'claim-setup-1',
  claim_text: 'Policy is expected to remain restrictive until inflation cools.',
  speaker_or_author: 'Fixture research team',
  confidence_millis: 910,
  extraction_run_id: 'run-setup-1',
  provider: 'riga_bridge',
  model: 'fixture-claim-model',
  prompt_version: 'nip-claims-riga-bridge-v1',
  provider_kind: 'remote',
  provider_profile_id: 'riga-fixture-provider',
  reasoning_effort: 'low',
  extracted_at: '2026-11-16T09:01:00Z',
  evidence: [{ event_id: event.event_id, quote: 'policy to remain restrictive until inflation cools', start_offset: 34, end_offset: 85 }],
}

async function stubSetupJourney(page: Page) {
  const state = {
    subscribed: false,
    transcribed: false,
    consent: 'missing' as 'missing' | 'granted',
    claims: [] as Array<typeof claim>,
  }

  await page.route('**/nip/mcp', async (route) => {
    const body = route.request().postDataJSON() as { id?: number; method?: string; params?: { name?: string } }
    if (body.method === 'notifications/initialized') {
      await route.fulfill({ status: 202, body: '' })
      return
    }
    let result: Record<string, unknown> = {}
    if (body.method === 'initialize') {
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'nip-e2e', version: '0.1.0' } }
    } else if (body.method === 'tools/call') {
      const name = body.params?.name
      const subscription = {
        source_id: 'setup-fixture-source',
        feed_url: 'http://127.0.0.1:8795/fixture/feed.xml',
        show_name: 'Illustrative Test Corpus',
        rights_statement: 'Synthetic fixture approved for local processing and retention.',
        rights_confirmed_at: '2026-11-16T09:00:00Z',
        state: 'active',
        last_checked_at: '2026-11-16T09:00:00Z',
        next_poll_at: '2026-11-16T15:00:00Z',
        last_error_code: null,
        consecutive_failures: 0,
      }
      const episode = {
        source_id: 'setup-fixture-source',
        source_native_id: 'nip-fixture-episode-1',
        canonical_url: 'http://127.0.0.1:8795/fixture/episode-1',
        title: 'Policy outlook fixture',
        enclosure_url: 'http://127.0.0.1:8795/fixture/episode-1.mp3',
        published_at: '2026-11-15T12:00:00Z',
        discovered_at: '2026-11-16T09:00:00Z',
        state: state.transcribed ? 'transcribed' : 'awaiting_local_transcription',
      }
      const provider = {
        configured: true,
        bridge_state: 'ready',
        provider_kind: 'remote',
        provider_id: 'riga-fixture-provider',
        model: 'fixture-claim-model',
        reasoning_effort: 'low',
        provider_api: 'chat',
        remote: true,
        consent: state.consent,
        consent_recorded_at: state.consent === 'granted' ? '2026-11-16T09:02:00Z' : null,
        disclosure: 'Transcript text and the claim-extraction prompt will be sent to riga-fixture-provider (fixture-claim-model) for remote claim extraction.',
        extraction_state: state.consent === 'granted' ? 'available' : 'consent_required',
        warnings: state.consent === 'granted' ? [] : ['remote_consent_missing'],
      }
      const sourceRecord = {
        source_id: subscription.source_id,
        kind: 'podcast',
        display_name: subscription.show_name,
        locator: subscription.feed_url,
        rights_status: 'approved',
        rights_statement: subscription.rights_statement,
        topics: ['macro'],
        state: 'active',
        poll_interval_minutes: 360,
        per_scan_limit: 3,
        notes: null,
        created_at: subscription.rights_confirmed_at,
        updated_at: subscription.rights_confirmed_at,
        event_count: state.transcribed ? 1 : 0,
        episode_count: 1,
      }
      const structuredContent = name === 'health'
        ? { service: 'nip-engine', api_version: 1, readiness: 'ready', schema_version: 9 }
        : name === 'list_podcast_subscriptions'
          ? state.subscribed ? [subscription] : []
          : name === 'list_sources'
            ? state.subscribed ? [sourceRecord] : []
            : name === 'create_source'
              ? (state.subscribed = true, sourceRecord)
              : name === 'update_source'
                ? (state.subscribed = true, sourceRecord)
                : name === 'set_source_state'
                  ? sourceRecord
                  : name === 'delete_source'
                    ? (state.subscribed = false, { source_id: sourceRecord.source_id, deleted: true })
                : name === 'list_podcast_episodes'
            ? state.subscribed ? [episode] : []
            : name === 'subscribe_podcast_feed'
              ? (state.subscribed = true, { source_id: subscription.source_id, state: 'active' })
              : name === 'transcribe_podcast_episode'
                ? (state.transcribed = true, { transcript_text: event.content_text, content_hash: event.content_hash })
                : name === 'search_events'
                  ? { events: state.transcribed ? [event] : [], next_cursor: null }
                  : name === 'list_claims'
                    ? state.claims
                    : name === 'nip_provider_status'
                      ? provider
                      : name === 'nip_grant_remote_consent'
                        ? (state.consent = 'granted', { action: 'granted', scope: 'remote_transcript_extraction' })
                        : name === 'extract_claims_from_event'
                          ? (state.claims = [claim], state.claims)
                          : name === 'nip_resource_status'
                            ? { observed_at: '2026-11-17T12:00:00Z', database_path: '/tmp/nip.duckdb', database_bytes: 4096, event_count: state.transcribed ? 1 : 0, claim_count: state.claims.length, extraction_run_count: state.claims.length, cluster_count: 0, graph_edge_count: 0, scheduler_interval_seconds: 21600, scheduler_state: 'process_lifetime', semantic_index_state: 'not_built', semantic_model: null, warnings: [] }
                            : name === 'nip_extraction_status'
                              ? { observed_at: '2026-11-17T12:00:00Z', state: state.claims.length ? 'succeeded' : 'idle', claim_count: state.claims.length, extraction_run_count: state.claims.length, latest_run_id: state.claims.length ? 'run-setup-1' : null, latest_provider: state.claims.length ? 'riga_bridge' : null, latest_model: state.claims.length ? 'fixture-claim-model' : null, latest_prompt_version: state.claims.length ? 'nip-claims-riga-bridge-v1' : null, latest_extracted_at: null, evidence_linked_claim_count: state.claims.length, warnings: [] }
                              : name === 'narrative_signal_snapshot'
                                ? { as_of: '2026-11-17T12:00:00Z', formula_version: 'nip-signals-v1', coverage: 'unknown', current_week_start: '2026-11-09T00:00:00Z', current_week_end: '2026-11-16T00:00:00Z', signals: [] }
                                : name === 'list_narrative_graph'
                                  ? null
                                  : name === 'refresh_podcast_feeds'
                                    ? { results: [] }
                                    : ['list_narrative_clusters', 'list_etf_mappings', 'list_editorial_candidates'].includes(name ?? '')
                                      ? []
                                      : {}
      result = { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Mcp-Session-Id': 'setup-session' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) })
  })
  return state
}

test.describe('Narrative Intelligence first-run setup', () => {
  test('shows the setup checklist and the exact next action', {
    tag: [TAG.journey.narrativeSetup, TAG.feature.narrativeSetup, TAG.priority.p0, TAG.smoke],
  }, async ({ page }) => {
    await stubSetupJourney(page)
    const workspace = new WorkspacePage(page)
    await workspace.open()
    await page.getByTestId('menu-narrative').click()
    await page.getByTestId('menuitem-narrative-overview').click()

    const checklist = page.getByTestId('nip-setup-checklist')
    await expect(checklist).toBeVisible()
    await expect(checklist).toContainText('From source rights to reviewable evidence')
    await expect(checklist).toContainText('DuckDB schema v9')
    await expect(checklist).toContainText('Consent needed')
    await expect(checklist).toContainText('1/5 complete')
    await expect(page.getByText(/No sources registered/)).toBeVisible()
  })

  test('requires rights confirmation, then transcribes, consents, and extracts evidence', {
    tag: [TAG.journey.narrativeIngestion, TAG.journey.narrativeEvidenceReview, TAG.feature.narrativeSources, TAG.feature.narrativeClaims, TAG.priority.p0],
  }, async ({ page }) => {
    const state = await stubSetupJourney(page)
    const workspace = new WorkspacePage(page)
    await workspace.open()
    await page.getByTestId('menu-narrative').click()
    await page.getByTestId('menuitem-narrative-overview').click()

    await page.getByLabel('Source ID').fill('setup-fixture-source')
    await page.getByLabel('Podcast feed URL').fill('http://127.0.0.1:8795/fixture/feed.xml')
    await page.getByLabel('Show name').fill('Illustrative Test Corpus')
    await page.getByLabel('Rights statement').fill('Synthetic fixture approved for local processing and retention.')

    const approve = page.getByRole('button', { name: 'Approve and sync' })
    await expect(approve).toBeDisabled()
    await page.getByLabel(/I confirm access and retention rights/).check()
    await expect(approve).toBeEnabled()
    await approve.click()

    await expect(page.getByText('Feed approved and initial sync requested.')).toBeVisible()
    await expect(page.getByText('Illustrative Test Corpus').first()).toBeVisible()
    await expect(page.getByText('Policy outlook fixture')).toBeVisible()
    await page.getByRole('button', { name: 'Transcribe locally' }).click()
    await expect.poll(() => state.transcribed, { timeout: 120_000 }).toBe(true)
    await expect(page.getByText('Transcript committed.', { exact: false })).toBeVisible({ timeout: 120_000 })

    await page.getByRole('button', { name: /Open retained transcript/ }).first().click()
    await expect(page.getByText(/Source-linked record/)).toBeVisible()
    await expect(page.getByTestId('event-consent')).toBeVisible()
    await page.getByTestId('event-consent-grant').click()
    await expect.poll(() => state.consent).toBe('granted')
    await expect(page.getByTestId('event-consent')).toHaveCount(0)
    await page.getByRole('button', { name: 'Extract claims' }).click()
    await expect(page.getByText('1 claim committed with source evidence.')).toBeVisible()

    await page.getByRole('tab', { name: 'Claim Explorer' }).click()
    await expect(page.getByRole('heading', { name: /Policy is expected to remain restrictive/ })).toBeVisible()
    await expect(page.getByText('riga_bridge', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Source evidence' })).toBeVisible()
    await expect(page.getByTestId('nip-setup-checklist')).toContainText('5/5 complete')
  })
})
