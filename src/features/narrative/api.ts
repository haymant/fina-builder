import { nip } from '../../api/nipTransport'
import { toSnakeKeys } from '../../api/keyCase'
import type { NipCapabilities, NipClaim, NipEditorialCandidate, NipEditorialReviewAudit, NipEmbeddingManifest, NipEpisodePage, NipEtfMapping, NipEventSearchPage, NipExtractionStatus, NipHealth, NipNarrativeCluster, NipNarrativeGraph, NipNarrativeSignalSnapshot, NipPodcastEpisode, NipPodcastSubscription, NipProviderConsent, NipProviderStatus, NipResourceStatus, NipSemanticResult, NipSource, NipSourceKind, NipSourceState } from './types'

function fromTransport<T>(value: unknown): T {
  return toSnakeKeys(value) as T
}

export const narrativeApi = {
  health: async () => fromTransport<NipHealth>(await nip.callTool('health')),
  capabilities: async () => fromTransport<NipCapabilities>(await nip.callTool('capabilities')),
  searchEvents: (args: { text?: string; sourceId?: string; asOf?: string; cursor?: string; limit?: number } = {}) =>
    nip.callTool('search_events', {
      text: args.text,
      source_id: args.sourceId,
      as_of: args.asOf,
      cursor: args.cursor,
      limit: args.limit ?? 50,
    }).then((value) => fromTransport<NipEventSearchPage>(value)),
  listClaims: () => nip.callTool('list_claims').then((value) => fromTransport<NipClaim[]>(value)),
  listPodcastSubscriptions: () => nip.callTool('list_podcast_subscriptions').then((value) => fromTransport<NipPodcastSubscription[]>(value)),
  refreshDuePodcastFeeds: () => nip.callTool('refresh_due_podcast_feeds').then((value) => fromTransport<{ results: Array<Record<string, unknown>> }>(value)),
  listPodcastEpisodes: (sourceId: string) => nip.callTool('list_podcast_episodes', { source_id: sourceId }).then((value) => fromTransport<NipPodcastEpisode[]>(value)),
  listEpisodePage: (args: { sourceId?: string; titleContains?: string; sort?: string; limit?: number; offset?: number } = {}) =>
    nip.callTool('list_episode_page', {
      source_id: args.sourceId,
      title_contains: args.titleContains,
      sort: args.sort,
      limit: args.limit ?? 50,
      offset: args.offset ?? 0,
    }).then((value) => fromTransport<NipEpisodePage>(value)),
  subscribePodcastFeed: (args: { sourceId: string; feedUrl: string; showName: string; rightsStatement: string; userConfirmedRights: boolean }) =>
    nip.callTool('subscribe_podcast_feed', {
      source_id: args.sourceId,
      feed_url: args.feedUrl,
      show_name: args.showName,
      rights_statement: args.rightsStatement,
      user_confirmed_rights: args.userConfirmedRights,
    }).then((value) => fromTransport<Record<string, unknown>>(value)),
  listSources: (includeRemoved = true) => nip.callTool('list_sources', { include_removed: includeRemoved }).then((value) => fromTransport<NipSource[]>(value)),
  createSource: (args: { sourceId: string; kind: NipSourceKind; displayName: string; locator?: string | null; rightsStatement: string; userConfirmedRights: boolean; topics?: string[]; pollIntervalMinutes?: number; perScanLimit?: number; notes?: string }) =>
    nip.callTool('create_source', {
      source_id: args.sourceId,
      kind: args.kind,
      display_name: args.displayName,
      locator: args.locator ?? undefined,
      rights_statement: args.rightsStatement,
      user_confirmed_rights: args.userConfirmedRights,
      topics: args.topics,
      poll_interval_minutes: args.pollIntervalMinutes,
      per_scan_limit: args.perScanLimit,
      notes: args.notes,
    }).then((value) => fromTransport<NipSource>(value)),
  updateSource: (args: { sourceId: string; displayName?: string; locator?: string; rightsStatement?: string; topics?: string[]; perScanLimit?: number; pollIntervalMinutes?: number; sync?: boolean }) =>
    nip.callTool('update_source', {
      source_id: args.sourceId,
      display_name: args.displayName,
      locator: args.locator,
      rights_statement: args.rightsStatement,
      topics: args.topics,
      per_scan_limit: args.perScanLimit,
      poll_interval_minutes: args.pollIntervalMinutes,
      sync: args.sync,
    }).then((value) => fromTransport<NipSource>(value)),
  setSourceState: (sourceId: string, state: NipSourceState) => nip.callTool('set_source_state', { source_id: sourceId, state }).then((value) => fromTransport<NipSource>(value)),
  deleteSource: (sourceId: string) => nip.callTool('delete_source', { source_id: sourceId, user_confirmed: true }).then((value) => fromTransport<{ source_id: string; deleted: boolean }>(value)),
  transcribePodcastEpisode: (args: { sourceId: string; sourceNativeId?: string | null; canonicalUrl?: string | null }) =>
    nip.callTool('transcribe_podcast_episode', {
      source_id: args.sourceId,
      source_native_id: args.sourceNativeId,
      canonical_url: args.canonicalUrl,
    }).then((value) => fromTransport<Record<string, unknown>>(value)),
  semanticSearch: (text: string, limit = 20) => nip.callTool('semantic_search', { text, limit }).then((value) => fromTransport<NipSemanticResult[]>(value)),
  rebuildSemanticIndex: () => nip.callTool('rebuild_semantic_index').then((value) => fromTransport<NipEmbeddingManifest>(value)),
  rebuildNarrativeClusters: () => nip.callTool('rebuild_narrative_clusters').then((value) => fromTransport<NipNarrativeCluster[]>(value)),
  listNarrativeClusters: () => nip.callTool('list_narrative_clusters').then((value) => fromTransport<NipNarrativeCluster[]>(value)),
  rebuildNarrativeGraph: () => nip.callTool('rebuild_narrative_graph').then((value) => fromTransport<NipNarrativeGraph>(value)),
  listNarrativeGraph: () => nip.callTool('list_narrative_graph').then((value) => fromTransport<NipNarrativeGraph | null>(value)),
  resourceStatus: () => nip.callTool('nip_resource_status').then((value) => fromTransport<NipResourceStatus>(value)),
  extractionStatus: () => nip.callTool('nip_extraction_status').then((value) => fromTransport<NipExtractionStatus>(value)),
  providerStatus: () => nip.callTool('nip_provider_status').then((value) => fromTransport<NipProviderStatus>(value)),
  grantRemoteConsent: (args: { actor?: string; reason?: string } = {}) =>
    nip.callTool('nip_grant_remote_consent', { actor: args.actor ?? 'local-user', reason: args.reason }).then((value) => fromTransport<NipProviderConsent>(value)),
  revokeRemoteConsent: (args: { actor?: string; reason?: string } = {}) =>
    nip.callTool('nip_revoke_remote_consent', { actor: args.actor ?? 'local-user', reason: args.reason }).then((value) => fromTransport<NipProviderConsent>(value)),
  extractClaimsFromEvent: (eventId: string) => nip.callTool('extract_claims_from_event', { event_id: eventId }).then((value) => fromTransport<NipClaim[]>(value)),
  listEditorialReviewAudit: (candidateId: string) => nip.callTool('list_editorial_review_audit', { candidate_id: candidateId }).then((value) => fromTransport<NipEditorialReviewAudit[]>(value)),
  signalSnapshot: (asOf?: string) => nip.callTool('narrative_signal_snapshot', { as_of: asOf }).then((value) => fromTransport<NipNarrativeSignalSnapshot>(value)),
  listEtfMappings: () => nip.callTool('list_etf_mappings').then((value) => fromTransport<NipEtfMapping[]>(value)),
  saveEtfMapping: (mapping: NipEtfMapping) => nip.callTool('save_etf_mapping', { mapping }).then((value) => fromTransport<NipEtfMapping>(value)),
  listEditorialCandidates: () => nip.callTool('list_editorial_candidates').then((value) => fromTransport<NipEditorialCandidate[]>(value)),
  reviewEditorialCandidate: (args: { candidateId: string; status: string; reason: string; reviewer: string; reviewedAt: string }) => nip.callTool('review_editorial_candidate', { candidate_id: args.candidateId, status: args.status, reason: args.reason, reviewer: args.reviewer, reviewed_at: args.reviewedAt }),
}
