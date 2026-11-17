import { nip } from '../../api/nipTransport'
import { toSnakeKeys } from '../../api/keyCase'
import type { NipClaim, NipEditorialCandidate, NipEmbeddingManifest, NipEtfMapping, NipEventSearchPage, NipExtractionStatus, NipHealth, NipNarrativeCluster, NipNarrativeGraph, NipNarrativeSignalSnapshot, NipPodcastEpisode, NipPodcastSubscription, NipResourceStatus, NipSemanticResult } from './types'

function fromTransport<T>(value: unknown): T {
  return toSnakeKeys(value) as T
}

export const narrativeApi = {
  health: async () => fromTransport<NipHealth>(await nip.callTool('health')),
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
  subscribePodcastFeed: (args: { sourceId: string; feedUrl: string; showName: string; rightsStatement: string; userConfirmedRights: boolean }) =>
    nip.callTool('subscribe_podcast_feed', {
      source_id: args.sourceId,
      feed_url: args.feedUrl,
      show_name: args.showName,
      rights_statement: args.rightsStatement,
      user_confirmed_rights: args.userConfirmedRights,
    }).then((value) => fromTransport<Record<string, unknown>>(value)),
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
  signalSnapshot: (asOf?: string) => nip.callTool('narrative_signal_snapshot', { as_of: asOf }).then((value) => fromTransport<NipNarrativeSignalSnapshot>(value)),
  listEtfMappings: () => nip.callTool('list_etf_mappings').then((value) => fromTransport<NipEtfMapping[]>(value)),
  saveEtfMapping: (mapping: NipEtfMapping) => nip.callTool('save_etf_mapping', { mapping }).then((value) => fromTransport<NipEtfMapping>(value)),
  listEditorialCandidates: () => nip.callTool('list_editorial_candidates').then((value) => fromTransport<NipEditorialCandidate[]>(value)),
  reviewEditorialCandidate: (args: { candidateId: string; status: string; reason: string; reviewer: string; reviewedAt: string }) => nip.callTool('review_editorial_candidate', { candidate_id: args.candidateId, status: args.status, reason: args.reason, reviewer: args.reviewer, reviewed_at: args.reviewedAt }),
}
