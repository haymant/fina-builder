import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { buildTranscriptStoryboard } from '../src/features/video/storyboard'
import { NipMcpClient } from './support/nipMcpClient'

test.describe('External-agent commentary MCP journey (local fixtures)', () => {
  test.describe.configure({ mode: 'serial' })

  function client(): NipMcpClient {
    return new NipMcpClient(process.env.NIP_MCP_URL ?? 'http://127.0.0.1:8794/mcp')
  }

  async function pollDurableVideoJob(mcp: NipMcpClient, jobId: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs
    let latest: Record<string, unknown> | undefined
    while (Date.now() < deadline) {
      latest = await mcp.callTool<Record<string, unknown>>('video_job_status', { job_id: jobId })
      if (latest.status === 'succeeded' || latest.status === 'failed' || latest.status === 'cancelled') return latest
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error(`Video job ${jobId} did not reach a terminal state: ${JSON.stringify(latest)}`)
  }

  test('MCP discovery reports the currently executable and missing video capabilities', async () => {
    test.skip(process.env.PLAYWRIGHT_NIP !== 'on', 'run with PLAYWRIGHT_NIP=on to start the isolated NIP MCP fixture')
    const mcp = client()
    const tools = await mcp.listTools()
    const names = new Set(tools.map((tool) => tool.name))

    for (const name of [
      'health', 'capabilities', 'create_source', 'list_episode_page', 'start_podcast_transcription',
      'podcast_transcription_status', 'find_podcast_episode_event', 'get_event', 'extract_claims_from_event',
      'rebuild_narrative_clusters', 'rebuild_narrative_graph', 'list_narrative_graph', 'narrative_signal_snapshot',
      'build_agent_narrative_graph',
      'list_agent_narrative_analyses',
      'create_video_project', 'create_video_episode', 'link_video_evidence', 'save_video_narrative',
      'save_video_storyboard', 'save_video_scene', 'save_video_shot', 'save_video_visual_spec',
      'register_video_asset', 'link_video_asset_lineage', 'register_video_audio_cue',
      'get_video_audio_cue', 'list_video_audio_cues', 'render_video_linkzag', 'video_job_status', 'list_video_asset_lineage',
      'fina_video_timeline_build', 'fina_video_timeline_get', 'fina_video_timeline_list',
      'fina_video_qa_run', 'fina_video_qa_get', 'fina_video_export_profiles_list',
      'fina_video_export_preflight', 'fina_video_export_start', 'fina_video_export_get', 'fina_video_export_list',
    ]) expect(names.has(name), `MCP tool ${name} is advertised`).toBe(true)
    expect(names.has('extract_claims'), 'fixture-only fake extraction must not be advertised in production').toBe(false)

    const health = await mcp.callTool<Record<string, unknown>>('health')
    expect(health.readiness).toBe('ready')
    const caps = await mcp.callTool<Record<string, unknown>>('video_capabilities')
    expect(caps.deterministic_renderer).toBe('linkzag_adapter')
    expect(caps.tts).toBe('not_configured')
    expect(caps.generative_video).toBe('not_configured')

    // Legacy compatibility writers remain visible but reject caller-authored
    // QA/export success; production uses the evaluator and verified producer.
    expect(names.has('save_video_qa_report')).toBe(true)
    expect(names.has('save_video_timeline')).toBe(true)
    expect(names.has('save_video_export_manifest')).toBe(true)
    expect(names.has('run_video_qa')).toBe(false)
    expect(names.has('build_video_timeline')).toBe(false)
    expect(names.has('fina_video_timeline_build')).toBe(true)
    expect(names.has('fina_video_timeline_get')).toBe(true)
    expect(names.has('fina_video_timeline_list')).toBe(true)
    expect(names.has('start_video_export')).toBe(false)
    expect(names.has('resolve_entities')).toBe(false)
    expect(names.has('build_entity_graph')).toBe(false)
    expect(names.has('extract_entities')).toBe(false)
  })

  test('a simulated external agent preserves multi-speaker evidence and completes native QA-gated preview export', async () => {
    test.skip(process.env.PLAYWRIGHT_NIP !== 'on', 'run with PLAYWRIGHT_NIP=on to start the isolated NIP MCP fixture')
    test.setTimeout(600_000)

    const mcp = client()
    const runId = process.env.NIP_E2E_RUN_ID ?? 'e2e-run'
    const runRoot = path.resolve('playwright/.data/nip', runId)
    const mediaRoot = path.join(runRoot, 'media')
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const sourceId = `agent-commentary-${suffix}`
    const feedUrl = 'http://127.0.0.1:8795/fixture/multi-speaker-feed.xml'
    const rightsStatement = 'Synthetic fixture approved for local test processing and retention.'

    const toolNames = new Set((await mcp.listTools()).map((tool) => tool.name))
    expect(toolNames.has('render_video_linkzag')).toBe(true)

    // A simulated caller must not treat an unchecked rights boolean as optional.
    const rightsDenied = await mcp.callToolRaw('create_source', {
      source_id: `${sourceId}-denied`,
      kind: 'podcast',
      display_name: 'Unapproved fixture source',
      locator: feedUrl,
      rights_statement: rightsStatement,
      user_confirmed_rights: false,
    })
    expect(rightsDenied.isError).toBe(true)

    await mcp.callTool('create_source', {
      source_id: sourceId,
      kind: 'podcast',
      display_name: `External Agent Commentary ${suffix}`,
      locator: feedUrl,
      rights_statement: rightsStatement,
      user_confirmed_rights: true,
      topics: ['macro policy', 'test fixture'],
      per_scan_limit: 5,
    })

    const episodePage = await mcp.callTool<{ episodes?: Array<Record<string, unknown>> }>('list_episode_page', {
      source_id: sourceId,
      sort: 'published_desc',
      limit: 10,
      offset: 0,
    })
    const podcastEpisodes = (episodePage.episodes ?? []).filter((episode) =>
      String(episode.source_native_id ?? '').startsWith('nip-fixture-multi-'))
    expect(podcastEpisodes).toHaveLength(3)
    expect(new Set(podcastEpisodes.map((episode) => episode.source_native_id))).toEqual(new Set([
      'nip-fixture-multi-1', 'nip-fixture-multi-2', 'nip-fixture-multi-3',
    ]))

    const transcribedEpisodes: Array<{
      sourceNativeId: string
      eventId: string
      transcript: string
    }> = []
    for (const podcastEpisode of podcastEpisodes) {
      const sourceNativeId = podcastEpisode.source_native_id as string
      const canonicalUrl = podcastEpisode.canonical_url as string
      const started = await mcp.callTool<{ job_id: string; state: string }>('start_podcast_transcription', {
        source_id: sourceId,
        source_native_id: sourceNativeId,
        canonical_url: canonicalUrl,
      })
      expect(started.job_id).toBeTruthy()
      const transcriptionDeadline = Date.now() + 120_000
      let transcription: Record<string, unknown> | undefined
      while (Date.now() < transcriptionDeadline) {
        transcription = await mcp.callTool<Record<string, unknown>>('podcast_transcription_status', { job_id: started.job_id })
        if (transcription.state === 'transcribed' || transcription.state === 'failed' || transcription.state === 'cancelled') break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      expect(transcription?.state, JSON.stringify(transcription)).toBe('transcribed')
      expect(transcription?.event_id).toBeTruthy()

      const retained = await mcp.callTool<{ event?: Record<string, unknown> | null }>('find_podcast_episode_event', {
        source_id: sourceId,
        source_native_id: sourceNativeId,
        canonical_url: canonicalUrl,
      })
      const event = retained.event
      expect(event).toBeTruthy()
      const eventId = event?.event_id as string
      const transcript = event?.content_text as string
      expect(transcript.toLowerCase()).toContain('fixture research team expects policy')
      expect(transcript).toContain('Host Maya Chen:')
      expect(transcript).toContain('Guest Arun Patel:')
      expect(transcript.split('\n').filter(Boolean)).toHaveLength(3)
      expect(eventId).toBe(transcription?.event_id)
      transcribedEpisodes.push({ sourceNativeId, eventId, transcript })
    }

    const primaryEpisode = transcribedEpisodes.find((episode) => episode.sourceNativeId === 'nip-fixture-multi-1')
    expect(primaryEpisode).toBeTruthy()
    const sourceNativeId = primaryEpisode!.sourceNativeId
    const eventId = primaryEpisode!.eventId
    const transcript = primaryEpisode!.transcript
    const eventIds = transcribedEpisodes.map((episode) => episode.eventId)
    const eventIdSet = new Set(eventIds)

    // Test the real NIP provider-consent gate, then use the local fixture bridge
    // (never a public model endpoint) for evidence-linked claim extraction.
    const provider = await mcp.callTool<Record<string, unknown>>('nip_provider_status')
    expect(provider.provider_kind).toBe('remote')
    const blockedExtraction = await mcp.callToolRaw('extract_claims_from_event', { event_id: eventId })
    expect(blockedExtraction.isError).toBe(true)
    await mcp.callTool('nip_grant_remote_consent', {
      actor: 'external-agent-e2e-user',
      reason: 'Explicit test-only approval for the local deterministic provider bridge.',
    })
    for (const transcribed of transcribedEpisodes) {
      await mcp.callTool('extract_claims_from_event', { event_id: transcribed.eventId })
    }
    const allClaims = await mcp.callTool<Array<Record<string, unknown>>>('list_claims')
    const journeyClaims = allClaims.filter((item) => Array.isArray(item.evidence)
      && (item.evidence as Array<Record<string, unknown>>).some((evidence) => eventIdSet.has(String(evidence.event_id))))
    expect(journeyClaims).toHaveLength(9)
    const primaryClaims = journeyClaims.filter((item) =>
      (item.evidence as Array<Record<string, unknown>>).some((evidence) => evidence.event_id === eventId))
    expect(primaryClaims).toHaveLength(3)
    let verifiedEvidenceSpanCount = 0
    for (const transcribed of transcribedEpisodes) {
      const claimsForEpisode = journeyClaims.filter((item) =>
        (item.evidence as Array<Record<string, unknown>>).some((evidence) => evidence.event_id === transcribed.eventId))
      expect(claimsForEpisode).toHaveLength(3)
      expect(new Set(claimsForEpisode.map((item) => item.speaker_or_author))).toEqual(new Set([
        'Host Maya Chen', 'Guest Arun Patel',
      ]))
      for (const claimRecord of claimsForEpisode) {
        const evidence = (claimRecord.evidence as Array<Record<string, unknown>>)
          .find((item) => item.event_id === transcribed.eventId)
        const quote = evidence?.quote as string
        const startOffset = evidence?.start_offset as number
        const endOffset = evidence?.end_offset as number
        expect(quote.length).toBeGreaterThan(0)
        expect(Number.isInteger(startOffset)).toBe(true)
        expect(Number.isInteger(endOffset)).toBe(true)
        expect(transcribed.transcript.slice(startOffset, endOffset)).toBe(quote)
        verifiedEvidenceSpanCount += 1
      }
    }
    expect(verifiedEvidenceSpanCount).toBe(journeyClaims.length)
    const claimTexts = journeyClaims.map((item) => String(item.claim_text)).join('\n')
    for (const entityName of ['Federal Reserve', 'Acme Energy', 'Treasury']) {
      expect(claimTexts).toContain(entityName)
    }
    const claim = primaryClaims.find((item) => item.speaker_or_author === 'Guest Arun Patel') ?? primaryClaims[0]
    expect(claim).toBeTruthy()
    const claimId = claim?.claim_id as string

    // First verify the existing corpus-wide projection from clusters and claims.
    const clusters = await mcp.callTool<Array<{ members: Array<{ event_id: string }> }>>('rebuild_narrative_clusters')
    const clusteredEventIds = new Set(clusters.flatMap((cluster) => cluster.members.map((member) => member.event_id)))
    expect(clusteredEventIds).toEqual(eventIdSet)
    const graph = await mcp.callTool<{
      graph_id: string
      nodes: Array<{ node_id: string; node_type: string; label: string; evidence_event_ids: string[] }>
      edges: Array<{ edge_id: string; from_node_id: string; to_node_id: string; edge_type: string; evidence_event_ids: string[] }>
    }>('rebuild_narrative_graph')
    const eventNodes = graph.nodes.filter((node) => node.node_type === 'event' && eventIdSet.has(node.node_id.slice('event:'.length)))
    const claimNodes = graph.nodes.filter((node) => node.node_type === 'claim')
    const narrativeNodes = graph.nodes.filter((node) => node.node_type === 'narrative')
    expect(eventNodes).toHaveLength(3)
    expect(claimNodes).toHaveLength(9)
    expect(narrativeNodes.length).toBeGreaterThan(0)
    expect(graph.nodes.some((node) => node.node_type === 'entity')).toBe(false)
    for (const entityName of ['Federal Reserve', 'Acme Energy', 'Treasury']) {
      expect(claimNodes.some((node) => node.label.includes(entityName))).toBe(true)
    }
    const membershipEdges = graph.edges.filter((edge) => edge.edge_type === 'narrative_membership')
    const claimSupportEdges = graph.edges.filter((edge) => edge.edge_type === 'claim_support')
    expect(membershipEdges.length).toBeGreaterThanOrEqual(3)
    expect(claimSupportEdges).toHaveLength(9)
    for (const edge of [...membershipEdges, ...claimSupportEdges]) {
      expect(edge.evidence_event_ids.length).toBeGreaterThan(0)
      expect(edge.evidence_event_ids.every((id) => eventIdSet.has(id))).toBe(true)
    }
    const persistedGraph = await mcp.callTool<{ graph_id: string; edges: unknown[] }>('list_narrative_graph')
    expect(persistedGraph.graph_id).toBe(graph.graph_id)
    expect(persistedGraph.edges).toHaveLength(graph.edges.length)

    // This is deliberately fixture-only input: unlike the real production run,
    // the MCP tool itself validates and stores externally supplied analysis but
    // does not invoke a model. Its source quotes must still match exactly.
    const agentGraphResult = await mcp.callTool<{
      analysis: { analysis_id: string; provenance_status: string; entities: Array<{ entity_id: string; resolution_status: string }> }
      claims: Array<{ claim_id: string }>
      graph: {
        graph_id: string
        nodes: Array<{ node_id: string; node_type: string; label: string; evidence_event_ids: string[] }>
        edges: Array<{ edge_id: string; from_node_id: string; to_node_id: string; edge_type: string; evidence_event_ids: string[] }>
      }
    }>('build_agent_narrative_graph', {
      event_id: eventId,
      producer: 'Playwright deterministic test fixture',
      model: 'test-fixture-not-a-model',
      prompt_version: 'external-agent-graph-test-v1',
      narrative_title: 'Policy uncertainty and company-specific refinancing',
      narrative_thesis: 'A cautious policy outlook coexists with one company’s conditional refinancing optimism.',
      narrative_summary: 'Fixture-only test narrative, not a real analysis result.',
      entities: [
        {
          canonical_name: 'Federal Reserve',
          entity_type: 'organization',
          surface_form: 'Federal Reserve',
          evidence_quote: 'The Federal Reserve has not independently confirmed the outlook',
        },
        {
          canonical_name: 'Acme Energy',
          entity_type: 'company',
          surface_form: 'Acme Energy',
          evidence_quote: 'Acme Energy expects refinancing costs to ease next quarter',
        },
      ],
      claims: [
        {
          claim_text: 'The guest says the Federal Reserve has not independently confirmed the outlook.',
          claim_type: 'fact',
          speaker_or_author: 'Guest Arun Patel',
          confidence_millis: 850,
          evidence_quote: 'The Federal Reserve has not independently confirmed the outlook',
          entity_names: ['Federal Reserve'],
          polarity: 'neutral',
          horizon: null,
        },
        {
          claim_text: 'Acme Energy expects refinancing costs to ease next quarter.',
          claim_type: 'forecast',
          speaker_or_author: 'Guest Arun Patel',
          confidence_millis: 800,
          evidence_quote: 'Acme Energy expects refinancing costs to ease next quarter',
          entity_names: ['Acme Energy'],
          polarity: 'positive',
          horizon: 'next quarter',
        },
      ],
    })
    expect(agentGraphResult.analysis.provenance_status).toBe('caller_declared_external_agent_unattested')
    expect(agentGraphResult.analysis.entities).toHaveLength(2)
    expect(agentGraphResult.analysis.entities.every((entity) => entity.resolution_status === 'unresolved_candidate')).toBe(true)
    expect(agentGraphResult.claims).toHaveLength(2)
    const entityCandidates = agentGraphResult.graph.nodes.filter((node) => node.node_type === 'entity_candidate')
    expect(entityCandidates).toHaveLength(2)
    expect(agentGraphResult.graph.nodes.some((node) => node.node_type === 'entity')).toBe(false)
    const candidateLinks = agentGraphResult.graph.edges.filter((edge) => edge.edge_type === 'claim_about_entity_candidate')
    expect(candidateLinks).toHaveLength(2)
    expect(candidateLinks.every((edge) => edge.evidence_event_ids.length === 1 && edge.evidence_event_ids[0] === eventId)).toBe(true)
    const persistedAgentGraph = await mcp.callTool<{ graph_id: string; nodes: Array<{ node_type: string }> }>('list_narrative_graph')
    expect(persistedAgentGraph.graph_id).toBe(agentGraphResult.graph.graph_id)
    expect(persistedAgentGraph.nodes.filter((node) => node.node_type === 'entity_candidate')).toHaveLength(2)
    const persistedAnalyses = await mcp.callTool<Array<{ analysis_id: string; source_content_hash: string }>>('list_agent_narrative_analyses')
    const persistedAnalysis = persistedAnalyses.find((analysis) => analysis.analysis_id === agentGraphResult.analysis.analysis_id)
    expect(persistedAnalysis?.source_content_hash).toBe((await mcp.callTool<{ content_hash: string }>('get_event', { event_id: eventId })).content_hash)

    const signalSnapshot = await mcp.callTool<{
      coverage: string
      signals: Array<{ current_count: number; evidence_event_ids: string[]; coverage: string; data_quality_flags: string[] }>
    }>('narrative_signal_snapshot', { as_of: new Date().toISOString() })
    expect(signalSnapshot.coverage).toBe('unknown')
    const signalsForJourney = signalSnapshot.signals.filter((signal) =>
      signal.evidence_event_ids.some((id) => eventIdSet.has(id)))
    expect(signalsForJourney.length).toBeGreaterThan(0)
    expect(signalsForJourney.reduce((sum, signal) => sum + signal.current_count, 0)).toBe(3)
    expect(new Set(signalsForJourney.flatMap((signal) => signal.evidence_event_ids.filter((id) => eventIdSet.has(id)))))
      .toEqual(eventIdSet)
    expect(signalsForJourney.every((signal) => signal.coverage === 'unknown'
      && signal.data_quality_flags.includes('coverage_manifest_missing'))).toBe(true)

    const createdAt = new Date().toISOString()
    const projectId = `agent-project-${suffix}`
    const episodeId = `agent-episode-${suffix}`
    const project = await mcp.callTool<Record<string, unknown>>('create_video_project', {
      project: {
        project_id: projectId,
        revision: 1,
        title: `Commentary from ${sourceNativeId}`,
        language: 'en',
        target_platform: 'internal_review',
        target_duration_ms: null,
        audience: 'Research analysts',
        style_profile: 'evidence-first',
        status: 'draft',
        created_at: createdAt,
        updated_at: createdAt,
      },
    })
    expect(project.project_id).toBe(projectId)
    const episode = await mcp.callTool<Record<string, unknown>>('create_video_episode', {
      episode: {
        episode_id: episodeId,
        project_id: projectId,
        revision: 1,
        title: 'Policy outlook commentary',
        as_of: createdAt,
        disclosure: 'Single retained transcript; commentary candidate, not independent confirmation.',
        status: 'draft',
        created_at: createdAt,
        updated_at: createdAt,
      },
    })
    expect(episode.episode_id).toBe(episodeId)

    const eventEvidence = {
      evidence_kind: 'event', evidence_id: eventId,
      start_offset: null, end_offset: null, quote: null,
    }
    const claimEvidence = {
      evidence_kind: 'claim', evidence_id: claimId,
      start_offset: null, end_offset: null, quote: null,
    }
    await mcp.callTool('link_video_evidence', { episode_id: episodeId, episode_revision: 1, evidence: eventEvidence })
    await mcp.callTool('link_video_evidence', { episode_id: episodeId, episode_revision: 1, evidence: claimEvidence })

    const transcriptEvent = await mcp.callTool<Record<string, unknown>>('get_event', { event_id: eventId })
    const generatedIds = new Map<string, number>()
    const draft = buildTranscriptStoryboard(
      transcriptEvent as never,
      project as never,
      episode as never,
      (prefix) => {
        const index = (generatedIds.get(prefix) ?? 0) + 1
        generatedIds.set(prefix, index)
        return `${prefix}-${suffix}-${index}`
      },
      createdAt,
    )
    await mcp.callTool('save_video_narrative', { narrative: draft.narrative })
    await mcp.callTool('save_video_storyboard', { storyboard: draft.storyboard })
    for (const scene of draft.scenes) await mcp.callTool('save_video_scene', { scene })
    for (const shot of draft.shots) await mcp.callTool('save_video_shot', { shot })

    const claimRecord = claim as Record<string, unknown>
    const verifiedClaimEvidence = Array.isArray(claimRecord.evidence)
      ? claimRecord.evidence[0] as Record<string, unknown> | undefined
      : undefined
    const claimQuote = verifiedClaimEvidence?.quote as string | undefined
    const claimParentEventId = verifiedClaimEvidence?.event_id as string | undefined
    expect(claimParentEventId).toBe(eventId)
    for (const [index, originalSpec] of draft.visualSpecs.entries()) {
      const spec = structuredClone(originalSpec)
      if (index === 1) {
        spec.sources.push({
          source_kind: 'claim',
          source_id: claimId,
          source_revision: null,
          start_offset: typeof verifiedClaimEvidence?.start_offset === 'number' ? verifiedClaimEvidence.start_offset : null,
          end_offset: typeof verifiedClaimEvidence?.end_offset === 'number' ? verifiedClaimEvidence.end_offset : null,
          quote: claimQuote ?? null,
        })
        expect(spec.sources.some((source) => source.source_kind === 'event' && source.source_id === claimParentEventId)).toBe(true)
      }
      await mcp.callTool('save_video_visual_spec', { spec })
    }

    const pinnedSpecs = draft.visualSpecs.map((spec) => ({ spec_id: spec.spec_id, revision: spec.revision }))
    const render = await mcp.callTool<{ job_id: string; status: string }>('render_video_linkzag', { visual_specs: pinnedSpecs })
    expect(render.job_id).toBeTruthy()
    const renderDeadline = Date.now() + 540_000
    let videoJob: Record<string, unknown> | undefined
    while (Date.now() < renderDeadline) {
      videoJob = await mcp.callTool<Record<string, unknown>>('video_job_status', { job_id: render.job_id })
      if (videoJob.status === 'succeeded' || videoJob.status === 'failed' || videoJob.status === 'cancelled') break
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    expect(videoJob?.status, JSON.stringify(videoJob)).toBe('succeeded')

    const outputManifest = videoJob?.output_manifest as Record<string, unknown> | undefined
    const asset = outputManifest?.asset as Record<string, unknown> | undefined
    expect(asset?.asset_kind).toBe('commentary_video')
    expect(asset?.mime_type).toBe('video/mp4')
    expect(asset?.capability_state).toBe('ready')
    expect(asset?.content_hash).toMatch(/^[0-9a-f]{64}$/u)
    expect(asset?.relative_path).toMatch(/^video\/linkzag\/.+\.mp4$/u)

    const mediaPath = path.resolve(mediaRoot, asset?.relative_path as string)
    expect(mediaPath.startsWith(`${mediaRoot}${path.sep}`)).toBe(true)
    expect(existsSync(mediaPath)).toBe(true)
    expect(statSync(mediaPath).size).toBeGreaterThan(0)
    const actualHash = createHash('sha256').update(readFileSync(mediaPath)).digest('hex')
    expect(actualHash).toBe(asset?.content_hash)
    const probe = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=format_name,duration:stream=codec_type,width,height',
      '-of', 'json',
      mediaPath,
    ], { encoding: 'utf8' })) as {
      format?: { format_name?: string; duration?: string }
      streams?: Array<{ codec_type?: string; width?: number; height?: number }>
    }
    expect(probe.format?.format_name?.split(',')).toContain('mp4')
    expect(Number(probe.format?.duration)).toBeGreaterThan(15)
    expect(probe.streams?.some((stream) => stream.codec_type === 'video' && stream.width === 1280 && stream.height === 720)).toBe(true)
    expect(probe.streams?.some((stream) => stream.codec_type === 'audio')).toBe(false)

    const lineage = await mcp.callTool<Array<Record<string, unknown>>>('list_video_asset_lineage', {
      asset_id: asset?.asset_id as string,
      asset_revision: asset?.revision as number,
    })
    const visualLineage = lineage.filter((link) => link.upstream_kind === 'visual_spec')
    expect(new Set(visualLineage.map((link) => link.upstream_id))).toEqual(new Set(pinnedSpecs.map((spec) => spec.spec_id)))
    expect(lineage.some((link) => link.upstream_kind === 'event' && link.upstream_id === eventId)).toBe(true)
    expect(lineage.some((link) => link.upstream_kind === 'claim' && link.upstream_id === claimId)).toBe(true)

    // Build the native immutable EDL from revision-pinned canonical records.
    // The installed preview profile is the frame-rate contract (30/1); every
    // clip has an explicit frame start and source trim, with gaps prohibited.
    const projectRevision = project.revision as number
    const episodeRevision = episode.revision as number
    const storyboardRef = { id: draft.storyboard.storyboard_id, revision: draft.storyboard.revision }
    let sourceInFrame = 0
    let timelineStartFrame = 0
    const videoClips = draft.shots.map((shot) => {
      const spec = draft.visualSpecs.find((candidate) => candidate.shot_id === shot.shot_id)
      expect(spec, `VisualSpec for native shot ${shot.shot_id}`).toBeTruthy()
      // Flooring each duration to whole 30-fps frames keeps concatenated
      // source trims within the rendered MP4's verified duration.
      const durationFrames = Math.floor(shot.duration_ms * 30 / 1_000)
      expect(durationFrames).toBeGreaterThan(0)
      const clip = {
        shot_ref: { id: shot.shot_id, revision: shot.revision },
        asset_ref: { id: asset?.asset_id as string, revision: asset?.revision as number },
        start_frame: timelineStartFrame,
        duration_frames: durationFrames,
        source_in_frame: sourceInFrame,
        fit: 'contain',
        evidence_refs: [],
      }
      sourceInFrame += durationFrames
      timelineStartFrame += durationFrames
      return clip
    })
    const timelineRequest = {
      project_ref: { id: projectId, revision: projectRevision },
      episode_ref: { id: episodeId, revision: episodeRevision },
      storyboard_ref: storyboardRef,
      output_profile_id: 'mp4-h264-720p30-preview-v1',
      video_tracks: [{ track_id: 'V1', ordinal: 0, clips: videoClips }],
      audio_tracks: [],
      caption_tracks: [],
      gap_policy: 'block',
      request_id: `external-agent-edl-${projectId}`,
    }
    const builtTimeline = await mcp.callTool<{
      status: string
      timeline_ref?: { id: string; revision: number }
      timeline_hash?: string
      findings: Array<{ code: string; severity: string }>
    }>('fina_video_timeline_build', timelineRequest)
    expect(builtTimeline.status, JSON.stringify(builtTimeline)).toBe('ready')
    expect(builtTimeline.timeline_ref).toEqual({ id: expect.any(String), revision: 1 })
    expect(builtTimeline.timeline_hash).toMatch(/^sha256:[a-f0-9]{64}$/u)
    expect(builtTimeline.findings.some((finding) => finding.severity === 'blocker')).toBe(false)

    const timelineRef = builtTimeline.timeline_ref!
    const savedTimeline = await mcp.callTool<{
      timeline_id: string
      revision: number
      build_status: string
      timeline_hash: string
      edl: {
        project_ref: { id: string; revision: number }
        episode_ref: { id: string; revision: number }
        storyboard_ref: { id: string; revision: number }
        output_profile_ref: { id: string; revision: number }
        sequence: { frame_rate: { num: number; den: number } }
        video_tracks: Array<{ clips: Array<{
          shot_ref: { id: string; revision: number }
          visual_spec_ref?: { id: string; revision: number }
          asset_ref: { id: string; revision: number }
          start_frame: number
          source_in_frame: number
          duration_frames: number
        }> }>
        timeline_hash: string
      }
    }>('fina_video_timeline_get', { timeline_ref: timelineRef })
    expect(savedTimeline.timeline_id).toBe(timelineRef.id)
    expect(savedTimeline.revision).toBe(timelineRef.revision)
    expect(savedTimeline.build_status).toBe('ready')
    expect(savedTimeline.timeline_hash).toBe(builtTimeline.timeline_hash)
    expect(savedTimeline.edl.timeline_hash).toBe(builtTimeline.timeline_hash)
    expect(savedTimeline.edl.project_ref).toEqual(timelineRequest.project_ref)
    expect(savedTimeline.edl.episode_ref).toEqual(timelineRequest.episode_ref)
    expect(savedTimeline.edl.storyboard_ref).toEqual(storyboardRef)
    expect(savedTimeline.edl.output_profile_ref).toEqual({ id: 'mp4-h264-720p30-preview-v1', revision: 1 })
    expect(savedTimeline.edl.sequence.frame_rate).toEqual({ num: 30, den: 1 })
    const savedClips = savedTimeline.edl.video_tracks.flatMap((track) => track.clips)
    expect(savedClips).toHaveLength(draft.shots.length)
    for (const [index, shot] of draft.shots.entries()) {
      const savedClip = savedClips[index]
      expect(savedClip.shot_ref).toEqual({ id: shot.shot_id, revision: shot.revision })
      expect(savedClip.visual_spec_ref?.id).toBeTruthy()
      expect(pinnedSpecs.some((spec) => spec.spec_id === savedClip.visual_spec_ref?.id
        && spec.revision === savedClip.visual_spec_ref?.revision)).toBe(true)
      expect(savedClip.asset_ref).toEqual({ id: asset?.asset_id, revision: asset?.revision })
      expect(savedClip.start_frame).toBe(videoClips[index].start_frame)
      expect(savedClip.source_in_frame).toBe(videoClips[index].source_in_frame)
      expect(savedClip.duration_frames).toBe(videoClips[index].duration_frames)
    }
    const timelineList = await mcp.callTool<{
      timelines: Array<{
        timeline_ref: { id: string; revision: number }
        project_ref: { id: string; revision: number }
        build_status: string
        timeline_hash: string
      }>
    }>('fina_video_timeline_list', { project_ref: timelineRequest.project_ref, limit: 20 })
    expect(timelineList.timelines).toContainEqual({
      timeline_ref: timelineRef,
      project_ref: timelineRequest.project_ref,
      episode_ref: timelineRequest.episode_ref,
      storyboard_ref: storyboardRef,
      output_profile_ref: { id: 'mp4-h264-720p30-preview-v1', revision: 1 },
      build_status: 'ready',
      timeline_hash: builtTimeline.timeline_hash,
      input_fingerprint: expect.any(String),
      created_at: expect.any(String),
    })

    // A missing selected asset is a stable native blocker and must not yield a
    // timeline revision. This does not fabricate any QA report or status.
    const blockedRequest = structuredClone(timelineRequest)
    blockedRequest.request_id = `external-agent-edl-missing-${projectId}`
    blockedRequest.video_tracks[0].clips[0].asset_ref = {
      id: `missing-edl-asset-${suffix}`,
      revision: 1,
    }
    const blockedTimeline = await mcp.callTool<{
      status: string
      timeline_ref?: { id: string; revision: number }
      findings: Array<{ code: string; severity: string }>
    }>('fina_video_timeline_build', blockedRequest)
    expect(blockedTimeline.status).toBe('blocked')
    expect(blockedTimeline.timeline_ref).toBeUndefined()
    expect(blockedTimeline.findings.some((finding) => finding.code === 'asset.missing'
      && finding.severity === 'blocker')).toBe(true)

    // Run the deterministic evaluator on the exact persisted EDL revision.
    // Poll its durable job, then read the immutable report back rather than
    // trusting the immediate response's embedded report as persisted state.
    const qaStart = await mcp.callTool<{
      job: { job_id: string }
      report_ref: { id: string; revision: number }
    }>('fina_video_qa_run', {
      timeline_ref: timelineRef,
      qa_profile_id: timelineRequest.output_profile_id,
      request_id: `external-agent-qa-${projectId}`,
    })
    expect(qaStart.job.job_id).toBeTruthy()
    expect(qaStart.report_ref).toEqual({ id: expect.any(String), revision: 1 })
    const qaJob = await pollDurableVideoJob(mcp, qaStart.job.job_id, 120_000)
    expect(qaJob.status, JSON.stringify(qaJob)).toBe('succeeded')
    const persistedQa = await mcp.callTool<{
      report_ref: { id: string; revision: number }
      timeline_ref: { id: string; revision: number }
      timeline_hash: string
      profile_ref: { id: string; revision: number }
      execution_state: string
      decision: string
      check_summary: { passed: number; warnings: number; blockers: number; not_run: number }
      findings: Array<{ code: string; severity: string; state: string; subject_ref?: { id: string } | null }>
    }>('fina_video_qa_get', { report_ref: qaStart.report_ref })
    expect(persistedQa.report_ref).toEqual(qaStart.report_ref)
    expect(persistedQa.timeline_ref).toEqual(timelineRef)
    expect(persistedQa.timeline_hash).toBe(builtTimeline.timeline_hash)
    expect(persistedQa.profile_ref).toEqual({ id: timelineRequest.output_profile_id, revision: 1 })
    expect(qaJob.output_manifest).toMatchObject({
      report_ref: qaStart.report_ref,
      decision: persistedQa.decision,
    })

    const previewProfiles = await mcp.callTool<{
      profiles: Array<{ profile_ref: { id: string; revision: number }; purpose: string; capability_state?: string }>
    }>('fina_video_export_profiles_list', { purpose: 'preview' })
    const previewProfile = previewProfiles.profiles.find((profile) =>
      profile.profile_ref.id === timelineRequest.output_profile_id && profile.purpose === 'preview')
    expect(previewProfile, JSON.stringify(previewProfiles)).toBeTruthy()
    const exportProfileId = previewProfile!.profile_ref.id
    const projectRef = timelineRequest.project_ref
    let exportStatus: 'blocked_by_qa' | 'succeeded'
    let exportManifestRef: { id: string; revision: number } | undefined
    let exportLineageAssertionCount = 0
    let exportLineageAssertionStatus: 'not_run' | 'passed' = 'not_run'

    if (persistedQa.decision === 'block') {
      // Any deterministic blocker must prevent export. Internal-review-only is
      // a preview warning, never a rights clearance or a substitute for QA.
      expect(persistedQa.check_summary.blockers).toBeGreaterThan(0)
      expect(persistedQa.findings.some((finding) => finding.severity === 'blocker')).toBe(true)
      if (asset?.license_state === 'internal_review_only') {
        const previewRightsFinding = persistedQa.findings.find((finding) => finding.code === 'rights.internal_review_only')
        expect(previewRightsFinding).toMatchObject({ severity: 'warning', state: 'passed' })
      }

      const preflight = await mcp.callTool<{
        decision: string
        blockers: Array<{ code: string; message: string }>
        warnings: Array<{ code?: string; message?: string }>
      }>('fina_video_export_preflight', {
        timeline_ref: timelineRef,
        qa_report_ref: qaStart.report_ref,
        export_profile_id: exportProfileId,
      })
      expect(preflight.decision).toBe('block')
      expect(preflight.blockers.some((blocker) => blocker.code === 'blocked_by_qa')).toBe(true)

      const rejectedStart = await mcp.callToolRaw('fina_video_export_start', {
        timeline_ref: timelineRef,
        qa_report_ref: qaStart.report_ref,
        export_profile_id: exportProfileId,
        request_id: `external-agent-export-${projectId}`,
      })
      expect(rejectedStart.isError).toBe(true)
      expect(JSON.stringify(rejectedStart.data ?? rejectedStart.raw)).toContain('blocked_by_qa')
      expect(JSON.stringify(rejectedStart.data ?? rejectedStart.raw)).not.toMatch(/"job_id"\s*:/u)
      const exports = await mcp.callTool<{ manifests: Array<Record<string, unknown>> }>('fina_video_export_list', {
        project_ref: projectRef,
        limit: 20,
      })
      expect(exports.manifests).toHaveLength(0)
      exportStatus = 'blocked_by_qa'
    } else {
      // A successful path is exercised only if trusted current facts produce a
      // complete, blocker-free report; no rights or findings are edited here.
      expect(['approved', 'internal_review_only']).toContain(asset?.license_state)
      expect(['allow', 'allow_with_warnings']).toContain(persistedQa.decision)
      expect(persistedQa.execution_state).toBe('complete')
      expect(persistedQa.check_summary.blockers).toBe(0)
      expect(persistedQa.check_summary.not_run).toBe(0)
      const preflight = await mcp.callTool<{
        decision: string
        blockers: Array<{ code: string; message: string }>
        warnings: unknown[]
      }>('fina_video_export_preflight', {
        timeline_ref: timelineRef,
        qa_report_ref: qaStart.report_ref,
        export_profile_id: exportProfileId,
      })
      expect(['allow', 'allow_with_warnings']).toContain(preflight.decision)
      expect(preflight.blockers).toHaveLength(0)

      const exportStart = await mcp.callTool<{ job: { job_id: string } }>('fina_video_export_start', {
        timeline_ref: timelineRef,
        qa_report_ref: qaStart.report_ref,
        export_profile_id: exportProfileId,
        request_id: `external-agent-export-${projectId}`,
      })
      expect(exportStart.job.job_id).toBeTruthy()
      const exportJob = await pollDurableVideoJob(mcp, exportStart.job.job_id, 540_000)
      expect(exportJob.status, JSON.stringify(exportJob)).toBe('succeeded')
      const jobOutput = exportJob.output_manifest as Record<string, unknown> | undefined
      exportManifestRef = jobOutput?.export_manifest_ref as { id: string; revision: number } | undefined
      expect(exportManifestRef).toEqual({ id: expect.any(String), revision: 1 })

      const exportManifest = await mcp.callTool<{
        manifest_ref: { id: string; revision: number }
        state: string
        project_ref: { id: string; revision: number }
        episode_ref: { id: string; revision: number }
        timeline_ref: { id: string; revision: number }
        timeline_hash: string
        qa_report_ref: { id: string; revision: number }
        export_profile_ref: { id: string; revision: number }
        output_asset_ref: { id: string; revision: number }
        output_sha256: string
        probe: { container: string; video_codec: string; width: number; height: number; frame_rate_num: number; frame_rate_den: number; byte_size: number; has_audio: boolean; has_captions: boolean }
        files: Array<{ kind: string; asset_ref: { id: string; revision: number }; sha256: string }>
        preview_only: boolean
        deterministic: boolean
        lineage_refs: Array<{ kind: string; id: string; revision?: number | null }>
      }>('fina_video_export_get', { manifest_ref: exportManifestRef! })
      expect(exportManifest.manifest_ref).toEqual(exportManifestRef)
      expect(exportManifest.state).toBe('succeeded')
      expect(exportManifest.project_ref).toEqual(projectRef)
      expect(exportManifest.episode_ref).toEqual(timelineRequest.episode_ref)
      expect(exportManifest.timeline_ref).toEqual(timelineRef)
      expect(exportManifest.timeline_hash).toBe(builtTimeline.timeline_hash)
      expect(exportManifest.qa_report_ref).toEqual(qaStart.report_ref)
      expect(exportManifest.export_profile_ref).toEqual({ id: exportProfileId, revision: 1 })
      expect(exportManifest.output_sha256).toMatch(/^sha256:[0-9a-f]{64}$/u)
      expect(exportManifest.probe).toMatchObject({
        container: 'mp4', video_codec: 'h264', width: 1280, height: 720,
        frame_rate_num: 30, frame_rate_den: 1, has_audio: false, has_captions: false,
      })
      expect(exportManifest.probe.byte_size).toBeGreaterThan(0)
      expect(exportManifest.preview_only).toBe(true)
      expect(exportManifest.deterministic).toBe(true)
      expect(exportManifest.files).toContainEqual({
        kind: 'master', asset_ref: exportManifest.output_asset_ref, sha256: exportManifest.output_sha256,
      })

      const outputAssets = await mcp.callTool<Array<{
        asset_id: string; revision: number; content_hash?: string | null; relative_path?: string | null
      }>>('list_video_assets', { limit: 100 })
      const outputAsset = outputAssets.find((candidate) =>
        candidate.asset_id === exportManifest.output_asset_ref.id
        && candidate.revision === exportManifest.output_asset_ref.revision)
      expect(outputAsset, JSON.stringify(outputAssets)).toBeTruthy()
      expect(outputAsset?.content_hash).toBe(exportManifest.output_sha256)
      expect(outputAsset?.relative_path).toBeTruthy()
      const exportedMediaPath = path.resolve(mediaRoot, outputAsset!.relative_path!)
      expect(exportedMediaPath.startsWith(`${mediaRoot}${path.sep}`)).toBe(true)
      expect(existsSync(exportedMediaPath)).toBe(true)
      expect(statSync(exportedMediaPath).size).toBe(exportManifest.probe.byte_size)
      const exportedHash = createHash('sha256').update(readFileSync(exportedMediaPath)).digest('hex')
      expect(`sha256:${exportedHash}`).toBe(exportManifest.output_sha256)
      const exportedProbe = JSON.parse(execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=format_name:stream=codec_type,width,height,codec_name', '-of', 'json', exportedMediaPath,
      ], { encoding: 'utf8' })) as { format?: { format_name?: string }; streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }> }
      expect(exportedProbe.format?.format_name?.split(',')).toContain('mp4')
      expect(exportedProbe.streams?.some((stream) => stream.codec_type === 'video'
        && stream.codec_name === 'h264' && stream.width === 1280 && stream.height === 720)).toBe(true)
      expect(exportedProbe.streams?.some((stream) => stream.codec_type === 'audio')).toBe(false)

      const exportLineage = exportManifest.lineage_refs
      for (const [kind, id] of [
        ['timeline', timelineRef.id], ['qa_report', qaStart.report_ref.id], ['project', projectId],
        ['episode', episodeId], ['storyboard', storyboardRef.id], ['event', eventId], ['claim', claimId],
      ]) {
        expect(exportLineage.some((reference) => reference.kind === kind && reference.id === id)).toBe(true)
        exportLineageAssertionCount += 1
      }
      for (const shot of draft.shots) {
        expect(exportLineage.some((reference) => reference.kind === 'shot' && reference.id === shot.shot_id)).toBe(true)
        exportLineageAssertionCount += 1
      }
      const listedExports = await mcp.callTool<{
        manifests: Array<{
          manifest_ref: { id: string; revision: number }
          timeline_ref: { id: string; revision: number }
          qa_report_ref: { id: string; revision: number }
          output_sha256: string
        }>
      }>('fina_video_export_list', {
        project_ref: projectRef,
        limit: 20,
      })
      expect(listedExports.manifests).toContainEqual(expect.objectContaining({
        manifest_ref: exportManifestRef,
        timeline_ref: timelineRef,
        qa_report_ref: qaStart.report_ref,
        output_sha256: exportManifest.output_sha256,
      }))
      exportStatus = 'succeeded'
      exportLineageAssertionStatus = 'passed'
    }

    const receipt = {
      contract: 'local-mcp-tool-journey-v1',
      completion_state: exportStatus === 'succeeded'
        ? 'preview_export_succeeded_with_native_edl_and_persisted_qa'
        : 'preview_ready_with_native_edl_qa_blocked_export_not_started',
      source_id: sourceId,
      event_id: eventId,
      event_ids: eventIds,
      claim_id: claimId,
      speaker_labels: ['Host Maya Chen', 'Guest Arun Patel'],
      speaker_claim_count: journeyClaims.length,
      entity_terms_in_claims: ['Federal Reserve', 'Acme Energy', 'Treasury'],
      graph_node_counts: {
        event: eventNodes.length,
        claim: claimNodes.length,
        narrative: narrativeNodes.length,
        entity: graph.nodes.filter((node) => node.node_type === 'entity').length,
        entity_candidate: entityCandidates.length,
      },
      agent_analysis_id: agentGraphResult.analysis.analysis_id,
      agent_claim_count: agentGraphResult.claims.length,
      agent_graph_id: agentGraphResult.graph.graph_id,
      graph_edge_counts: {
        narrative_membership: membershipEdges.length,
        claim_support: claimSupportEdges.length,
      },
      radar_timeline_event_count: signalsForJourney.reduce((sum, signal) => sum + signal.current_count, 0),
      graph_id: graph.graph_id,
      project_id: projectId,
      episode_id: episodeId,
      narrative_id: draft.narrative.narrative_id,
      storyboard_id: draft.storyboard.storyboard_id,
      visual_specs: pinnedSpecs,
      render_job_id: render.job_id,
      asset_id: asset?.asset_id,
      asset_revision: asset?.revision,
      timeline_id: timelineRef.id,
      timeline_revision: timelineRef.revision,
      timeline_hash: builtTimeline.timeline_hash,
      qa_job_id: qaStart.job.job_id,
      qa_report_ref: qaStart.report_ref,
      qa_execution_state: persistedQa.execution_state,
      qa_decision: persistedQa.decision,
      qa_check_summary: persistedQa.check_summary,
      qa_findings: persistedQa.findings.map(({ code, severity, state }) => ({ code, severity, state })),
      export_status: exportStatus,
      export_manifest_ref: exportManifestRef ?? null,
      evidence_span_verification: {
        status: 'passed',
        verified_claim_count: verifiedEvidenceSpanCount,
        method: 'transcript.slice(start_offset, end_offset) equals the retained evidence quote',
      },
      export_lineage_verification: {
        status: exportLineageAssertionStatus,
        asserted_reference_count: exportLineageAssertionCount,
      },
      export_profile_id: exportProfileId,
      production_coverage: 'synthetic_fixture_only; real_NPR_pilot_not_covered',
      sha256: actualHash,
      duration_seconds: Number(probe.format?.duration),
      has_audio: probe.streams?.some((stream) => stream.codec_type === 'audio') ?? false,
      diarization_segments: 'not_available; speaker labels preserved as transcript text and claim attribution',
      entity_graph_projection: 'event_scoped_unresolved_entity_candidates; no global canonical resolution or review registry',
      qa_evaluator: 'deterministic_fina.edl.v1; persisted report readback exercised',
      timeline_builder: 'native_fina.edl.v1',
      export_producer: exportStatus === 'succeeded'
        ? 'installed_preview_profile; durable job, verified manifest, media hash/probe, list and lineage readback'
        : 'installed_preview_profile; deterministic preflight blocked by persisted QA findings; no export job or manifest',
      external_auth_bridge: 'not_under_test',
    }
    mkdirSync(runRoot, { recursive: true })
    writeFileSync(path.join(runRoot, 'external-agent-commentary-result.json'), `${JSON.stringify(receipt, null, 2)}\n`)
    test.info().annotations.push({
      type: 'journey-state',
      description: exportStatus === 'succeeded'
        ? 'Preview export succeeded from native immutable EDL after persisted deterministic QA; multi-event claims and event-scoped unresolved entity candidates remain; synthetic fixture only, not the real NPR pilot.'
        : `Native immutable EDL and persisted deterministic QA completed (${persistedQa.decision}; ${persistedQa.findings.find((finding) => finding.severity === 'blocker')?.code ?? 'see receipt'}); preview export correctly blocked with no export job/manifest. Multi-event claims and event-scoped unresolved entity candidates remain; synthetic fixture only, not the real NPR pilot.`,
    })

    expect(receipt.completion_state).toBe(exportStatus === 'succeeded'
      ? 'preview_export_succeeded_with_native_edl_and_persisted_qa'
      : 'preview_ready_with_native_edl_qa_blocked_export_not_started')
    expect(receipt.has_audio).toBe(false)
  })
})
