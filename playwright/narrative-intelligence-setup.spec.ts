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
  evidence: [{ event_id: event.event_id, quote: 'policy to remain restrictive until inflation cools', start_offset: 34, end_offset: 84 }],
}

async function stubSetupJourney(page: Page, options: { directLocal?: boolean; retainedClaim?: boolean; legacyCapabilities?: boolean } = {}) {
  const state = {
    subscribed: false,
    transcribed: Boolean(options.retainedClaim),
    consent: 'missing' as 'missing' | 'granted',
    claims: (options.retainedClaim ? [claim] : []) as Array<typeof claim>,
    videoProjects: [] as Array<Record<string, unknown>>,
    videoEpisode: null as Record<string, unknown> | null,
    videoEvidence: [] as Array<Record<string, unknown>>,
  }

  // Stub only NIP: RIGA has a separate transport and must not receive NIP fixture payloads.
  await page.route('**/nip/mcp', async (route) => {
    const body = route.request().postDataJSON() as { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }
    if (body.method === 'notifications/initialized') {
      await route.fulfill({ status: 202, body: '' })
      return
    }
    let result: Record<string, unknown> = {}
    if (body.method === 'initialize') {
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'nip-e2e', version: '0.1.0' } }
    } else if (body.method === 'tools/call') {
      const name = body.params?.name
      const args = body.params?.arguments ?? {}
      if (['list_video_projects', 'create_video_project', 'create_video_episode', 'link_video_evidence', 'get_video_episode', 'list_video_evidence', 'video_capabilities', 'list_video_assets', 'list_video_workflows', 'get_event'].includes(name ?? '')) {
        let videoResult: unknown = {}
        if (name === 'list_video_projects') videoResult = state.videoProjects
        else if (name === 'create_video_project') {
          const project = args.project as Record<string, unknown>
          state.videoProjects = [project, ...state.videoProjects.filter((item) => item.project_id !== project.project_id)]
          videoResult = project
        } else if (name === 'create_video_episode') {
          state.videoEpisode = args.episode as Record<string, unknown>
          videoResult = state.videoEpisode
        } else if (name === 'link_video_evidence') {
          state.videoEvidence.push(args.evidence as Record<string, unknown>)
          videoResult = args
        } else if (name === 'get_video_episode') videoResult = state.videoEpisode?.episode_id === args.episode_id ? state.videoEpisode : null
        else if (name === 'list_video_evidence') videoResult = state.videoEvidence
        else if (name === 'video_capabilities') videoResult = { planning: 'ready', evidence_linkage: 'ready', deterministic_renderer: 'linkzag_adapter', generative_video: 'not_configured', tts: 'not_configured', asr: 'not_configured', disclosure: 'Fixture-backed deterministic test.' }
        else if (name === 'list_video_assets' || name === 'list_video_workflows') videoResult = []
        else if (name === 'get_event') videoResult = args.event_id === event.event_id ? event : null
        result = { structuredContent: videoResult, content: [{ type: 'text', text: JSON.stringify(videoResult) }] }
        await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Mcp-Session-Id': 'setup-session' }, body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) })
        return
      }
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
      const completedJob = {
        job_id: 'job-setup-transcription', source_id: episode.source_id, source_native_id: episode.source_native_id,
        canonical_url: episode.canonical_url, title: episode.title, state: 'transcribed', step: 'complete',
        detail: 'Fixture transcript committed.', error_code: null, error_message: null, audio_bytes: 128,
        audio_content_type: 'audio/mpeg', audio_path: '/tmp/fixture.mp3', audio_url_path: null,
        audio_duration_seconds: 60, chunks_total: 1, chunks_completed: 1,
        transcript_characters: event.content_text.length, transcript_preview: event.content_text,
        transcript_path: '/tmp/fixture-transcript.txt', event_id: event.event_id, warnings: [],
        started_at: '2026-11-16T09:01:00Z', updated_at: '2026-11-16T09:02:00Z',
        finished_at: '2026-11-16T09:02:00Z', events: [],
      }
      const asrStatus = {
        ready: true, configured: true, comfyui_url: 'http://127.0.0.1:8188', workspace: '/tmp/comfy',
        workspace_present: true, render_script: '/tmp/comfy/render.py', render_script_present: true,
        repo_url: null, chunk_seconds: 45, python: 'python3', python_present: true, ffmpeg_present: true,
        server_reachable: true, server_device: 'local', asr_nodes_present: true, pack_commit: 'fixture',
        blockers: [], next_actions: [],
      }
      const provider = options.directLocal
        ? {
            configured: true,
            bridge_state: 'ready',
            provider_kind: 'local',
            provider_id: 'direct-local',
            model: 'fixture-local-model',
            reasoning_effort: null,
            provider_api: 'chat_completions',
            remote: false,
            consent: 'not_required',
            consent_recorded_at: null,
            disclosure: 'Transcript text stays on the machine; direct local extraction has no RIGA or remote fallback.',
            extraction_state: 'available',
            warnings: [],
          }
        : {
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
      const structuredContent = name === 'capabilities'
        ? options.legacyCapabilities
          ? { service: 'nip-engine', service_version: 'older-sidecar', api_version: 1, schema_version: 8 }
          : { service: 'nip-engine', service_version: 'fixture', api_version: 1, schema_version: 9, features: { duckdb_store: true, podcast_rss_subscriptions: true, local_audio_transcription: true, claim_extraction: true, parquet_export: true, semantic_search: false } }
        : name === 'health'
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
            : name === 'list_episode_page'
              ? { episodes: state.subscribed ? [episode] : [], total: state.subscribed ? 1 : 0, limit: 50, offset: 0, next_offset: null }
            : name === 'subscribe_podcast_feed'
              ? (state.subscribed = true, { source_id: subscription.source_id, state: 'active' })
            : name === 'transcribe_podcast_episode'
                ? (state.transcribed = true, { transcript_text: event.content_text, content_hash: event.content_hash })
                : name === 'start_podcast_transcription'
                  ? (state.transcribed = true, completedJob)
                : name === 'search_events'
                  ? { events: state.transcribed ? [event] : [], next_cursor: null }
                  : name === 'list_claims'
                    ? state.claims
                    : name === 'nip_provider_status'
                      ? provider
                      : name === 'nip_asr_status'
                        ? asrStatus
                      : name === 'nip_grant_remote_consent'
                        ? (state.consent = 'granted', { action: 'granted', scope: 'remote_transcript_extraction' })
                        : name === 'find_podcast_episode_event'
                          ? { event: state.transcribed ? event : null }
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
                                  : name === 'list_podcast_transcription_jobs'
                                    ? state.transcribed ? [completedJob] : []
                                    : name === 'list_media_artifacts'
                                      ? []
                                      : name === 'rebuild_narrative_clusters'
                                        ? []
                                        : name === 'rebuild_narrative_graph'
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
  test('creates and opens a Video episode from a retained Claim Explorer span', {
    tag: [TAG.journey.narrativeEvidenceReview, TAG.feature.narrativeClaims, TAG.feature.videoWorkspace, TAG.priority.p1],
  }, async ({ page }) => {
    const state = await stubSetupJourney(page, { retainedClaim: true })
    const workspace = new WorkspacePage(page)
    await workspace.open()
    await page.getByTestId('menu-narrative').click()
    await page.getByTestId('menuitem-narrative-overview').click()
    await page.getByRole('tab', { name: 'Claim Explorer' }).click()
    await expect(page.getByRole('heading', { name: claim.claim_text })).toBeVisible()
    await page.getByRole('button', { name: 'Create video episode' }).click()

    const dialog = page.getByRole('dialog', { name: 'Create video episode' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Video project')).toHaveValue('new')
    await expect(dialog.getByRole('radio', { name: /nip-fixture-episode-1/ })).toBeChecked()
    await expect(dialog.getByRole('textbox')).toHaveCount(1)
    await expect(dialog.getByText('1 exact matching span verified')).toBeVisible()
    await expect(dialog.getByRole('status')).toContainText('34–84')
    await expect(dialog.getByRole('status')).toContainText(claim.evidence[0]!.quote)
    await dialog.getByRole('button', { name: 'Create video episode' }).click()

    await expect(page.getByTestId('video-episode-workspace')).toBeVisible()
    await expect.poll(() => state.videoEpisode).not.toBeNull()
    const createdProject = state.videoProjects[0]!
    const createdEpisode = state.videoEpisode!
    await expect(page.getByRole('heading', { level: 1, name: String(createdProject.title) })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: String(createdEpisode.title) })).toBeVisible()
    await expect.poll(() => state.videoEvidence.length).toBe(2)
    expect(state.videoEvidence).toEqual([
      { evidence_kind: 'event', evidence_id: event.event_id, start_offset: null, end_offset: null, quote: null },
      { evidence_kind: 'claim', evidence_id: claim.claim_id, start_offset: claim.evidence[0]!.start_offset, end_offset: claim.evidence[0]!.end_offset, quote: claim.evidence[0]!.quote },
    ])
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('fina.location.v1') ?? 'null'))).toEqual({
      kind: 'video', view: 'workspace', projectId: createdProject.project_id, episodeId: createdEpisode.episode_id, claimId: claim.claim_id,
    })
    const selectedClaim = page.getByTestId(`video-claim-select-${claim.claim_id}`)
    await expect(selectedClaim).toBeChecked()
    await expect(page.getByTestId(`video-claim-option-${claim.claim_id}`)).toContainText(`Exact source span [${claim.evidence[0]!.start_offset}, ${claim.evidence[0]!.end_offset})`)
    await expect(page.getByTestId('loaded-source-event')).toContainText(event.event_id)
  })

  test('shows a ready direct-local provider without RIGA consent state', {
    tag: [TAG.journey.narrativeSetup, TAG.feature.narrativeSetup, TAG.priority.p1],
  }, async ({ page }) => {
    await stubSetupJourney(page, { directLocal: true })
    const workspace = new WorkspacePage(page)
    await workspace.open()
    await page.getByTestId('menu-narrative').click()
    await page.getByTestId('menuitem-narrative-overview').click()

    const checklist = page.getByTestId('nip-setup-checklist')
    await expect(checklist).toContainText('fixture-local-model · direct local · extraction available')
    await expect(checklist).not.toContainText('Consent needed')
    await expect(page.getByText(/NIP calls this model directly/)).toBeVisible()
    await expect(page.getByText(/Transcript text stays on the machine/)).toBeVisible()
    await expect(page.getByText(/no RIGA or remote fallback/)).toBeVisible()
  })

  test('keeps Narrative usable when an older NIP sidecar omits optional capabilities', {
    tag: [TAG.journey.narrativeSetup, TAG.feature.narrativeSetup, TAG.priority.p1],
  }, async ({ page }) => {
    await stubSetupJourney(page, { legacyCapabilities: true })
    const workspace = new WorkspacePage(page)
    await workspace.open()
    await page.getByTestId('menu-narrative').click()
    await page.getByTestId('menuitem-narrative-overview').click()

    await expect(page.getByTestId('nip-setup-checklist')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Discovered episodes' })).toBeVisible()
  })

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
    const transcriptDialog = page.getByRole('dialog', { name: 'Retained transcript' })
    await expect(transcriptDialog).toBeVisible()
    await expect(transcriptDialog).toContainText(event.content_text)
    await page.getByRole('button', { name: 'Show in event list' }).click()
    await expect(page.getByText(/Source-linked record/)).toBeVisible()
    await expect(page.getByTestId('canonical-event-id')).toHaveText(event.event_id)
    await expect(page.getByTestId('event-consent')).toBeVisible()
    await page.getByTestId('event-consent-grant').click()
    await expect.poll(() => state.consent).toBe('granted')
    await expect(page.getByTestId('event-consent')).toHaveCount(0)
    await page.getByRole('button', { name: 'Extract claims' }).click()
    await expect(page.locator('.event-detail').getByText('1 claim committed with source evidence.')).toBeVisible()

    await page.getByRole('tab', { name: 'Claim Explorer' }).click()
    await expect(page.getByRole('heading', { name: /Policy is expected to remain restrictive/ })).toBeVisible()
    await expect(page.getByText('riga_bridge', { exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Source evidence' })).toBeVisible()
    await expect(page.getByTestId('nip-setup-checklist')).toContainText('5/5 complete')
  })
})
