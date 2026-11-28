import { narrativeApi } from './api'
import { scraperApi } from './scraperApi'
import type { ScraperSchedule, ScraperSiteInventory } from './scraperTypes'
import type { NipPodcastSubscription, NipSource, NipSourceState } from './types'

export type NarrativeSourceOwner = 'fina-scraper' | 'nip-engine' | 'unresolved'

export type NarrativeSourceReference =
  | { origin: 'nip_source'; sourceId: string }
  | { origin: 'scraper_site'; siteId: string }
  | { origin: 'source_id_collision'; sourceId: string; conflictingSiteIds: string[] }

/** A NIP-store row and its authoritative writer are deliberately distinct concepts. */
export type NarrativeSourceOwnership =
  | {
      owner: 'nip-engine'
      persistedOrigin: 'nip_store'
      reference: Extract<NarrativeSourceReference, { origin: 'nip_source' }>
      writable: true
      reason: null
    }
  | {
      owner: 'fina-scraper'
      persistedOrigin: 'nip_store_compatibility'
      reference: Extract<NarrativeSourceReference, { origin: 'scraper_site' }>
      compatibilitySourceId: string
      writable: false
      reason: string
    }
  | {
      owner: 'unresolved'
      persistedOrigin: 'nip_store'
      reference: Extract<NarrativeSourceReference, { origin: 'source_id_collision' }>
      writable: false
      reason: string
    }

export interface SourceOwnershipInput {
  source: NipSource
  subscription?: NipPodcastSubscription
  scraperSchedules: readonly ScraperSchedule[]
  scraperSites: readonly ScraperSiteInventory[]
  /** False when status is unavailable or an older sidecar omitted site_inventory. */
  scraperInventoryKnown: boolean
}

/** Match Rust's URL-based feed identity: HTTP(S), normalized URL, fragment removed. */
export function canonicalFeedUrl(value: string): string | null {
  if (!value || value.trim() !== value) return null
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) return null
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

function nipOwned(sourceId: string): NarrativeSourceOwnership {
  return {
    owner: 'nip-engine',
    persistedOrigin: 'nip_store',
    reference: { origin: 'nip_source', sourceId },
    writable: true,
    reason: null,
  }
}

function unresolved(
  sourceId: string,
  conflictingSiteIds: string[],
  reason: string,
): NarrativeSourceOwnership {
  return {
    owner: 'unresolved',
    persistedOrigin: 'nip_store',
    reference: { origin: 'source_id_collision', sourceId, conflictingSiteIds },
    writable: false,
    reason,
  }
}

/**
 * Resolve the writer without treating IDs from separate stores as globally unique.
 * Feed URL equality is the only cross-store identity proof currently available.
 */
export function resolveSourceOwnership(input: SourceOwnershipInput): NarrativeSourceOwnership {
  const { source, subscription, scraperSchedules, scraperSites, scraperInventoryKnown } = input
  const isPodcast = source.kind === 'podcast' || Boolean(subscription)

  if (isPodcast && !scraperInventoryKnown) {
    return unresolved(
      source.source_id,
      [],
      'Podcast ownership cannot be verified because fina-scraper inventory is unavailable. No NIP-side write will be attempted.',
    )
  }

  if (isPodcast) {
    const feedCandidates = new Set(
      [subscription?.feed_url, source.locator]
        .filter((value): value is string => Boolean(value))
        .map((value) => canonicalFeedUrl(value))
        .filter((value): value is string => value !== null),
    )
    if (feedCandidates.size > 1) {
      return unresolved(
        source.source_id,
        [],
        'The retained NIP source locator and subscription feed URL disagree; ownership is ambiguous and the compatibility record is read-only.',
      )
    }

    const matchingSites = scraperSites.filter((site) => {
      if (site.kind.toLowerCase() !== 'podcast' || !site.feed_url) return false
      const feed = canonicalFeedUrl(site.feed_url)
      return feed !== null && feedCandidates.has(feed)
    })
    const matchingSiteIds = [...new Set(matchingSites.map((site) => site.site_id))]
    if (matchingSiteIds.length === 1) {
      return {
        owner: 'fina-scraper',
        persistedOrigin: 'nip_store_compatibility',
        reference: { origin: 'scraper_site', siteId: matchingSiteIds[0] },
        compatibilitySourceId: source.source_id,
        writable: false,
        reason: 'The canonical feed URL matches fina-scraper site configuration. The existing NIP row remains readable but is not a second feed writer.',
      }
    }
    if (matchingSiteIds.length > 1) {
      return unresolved(
        source.source_id,
        matchingSiteIds,
        'The canonical feed URL matches multiple fina-scraper site IDs. Resolve the site configuration before writing.',
      )
    }
  }

  const sameIdSiteIds = scraperSites
    .filter((site) => site.site_id === source.source_id)
    .map((site) => site.site_id)
  const sameIdScheduleIds = scraperSchedules
    .filter((schedule) => schedule.site_id === source.source_id)
    .map((schedule) => schedule.site_id)
  const conflictingSiteIds = [...new Set([...sameIdSiteIds, ...sameIdScheduleIds])]
  if (conflictingSiteIds.length) {
    return unresolved(
      source.source_id,
      conflictingSiteIds,
      'A scraper site or schedule has the same text ID as this NIP source, but no canonical feed match proves they are the same source. The NIP row is read-only until ownership is resolved.',
    )
  }

  return nipOwned(source.source_id)
}

export interface SourceLifecycleAction {
  ownership: NarrativeSourceOwnership
  schedule?: ScraperSchedule | null
}

function ensureWritableOwner(action: SourceLifecycleAction, state: NipSourceState): void {
  const { ownership, schedule } = action
  if (ownership.owner === 'unresolved') throw new Error(ownership.reason)
  if (ownership.owner === 'fina-scraper') {
    if (state === 'removed') {
      throw new Error('Removing a scraper-owned source is not supported from the NIP registry. Keep the scraper YAML site and its evidence unchanged.')
    }
    if (!schedule) {
      throw new Error(`The source is owned by fina-scraper, but no scraper schedule is recorded for ${ownership.reference.siteId}. Use Schedules to configure it; no NIP fallback was attempted.`)
    }
  }
}

/** Route lifecycle writes to exactly one owner; never fall back to the other store. */
export async function setSourceLifecycle(
  action: SourceLifecycleAction,
  state: NipSourceState,
): Promise<void> {
  ensureWritableOwner(action, state)
  if (action.ownership.owner === 'nip-engine') {
    await narrativeApi.setSourceState(action.ownership.reference.sourceId, state)
    return
  }
  if (action.ownership.owner === 'fina-scraper') {
    const schedule = action.schedule!
    await scraperApi.scrapeSchedule({
      siteId: action.ownership.reference.siteId,
      pollIntervalMin: schedule.poll_interval_min,
      enabled: state === 'active',
      llmDailyBudget: schedule.llm_daily_budget,
      thesisDailyBudget: schedule.thesis_daily_budget,
    })
  }
}

/** Preflight a bulk operation before routing any individual write. */
export async function setSourcesLifecycle(
  actions: readonly SourceLifecycleAction[],
  state: NipSourceState,
): Promise<void> {
  for (const action of actions) ensureWritableOwner(action, state)
  for (const action of actions) await setSourceLifecycle(action, state)
}

export interface TriggerSourcesResult {
  triggeredSiteIds: string[]
  skippedNipSourceCount: number
}

/** Run-now is supported only for scraper-owned sites; NIP timer behavior is unchanged. */
export async function triggerSourcesNow(
  ownerships: readonly NarrativeSourceOwnership[],
): Promise<TriggerSourcesResult> {
  const conflict = ownerships.find((ownership) => ownership.owner === 'unresolved')
  if (conflict?.owner === 'unresolved') throw new Error(conflict.reason)
  const siteIds = [...new Set(ownerships.flatMap((ownership) =>
    ownership.owner === 'fina-scraper' ? [ownership.reference.siteId] : [],
  ))]
  const skippedNipSourceCount = ownerships.filter((ownership) => ownership.owner === 'nip-engine').length
  if (siteIds.length) await scraperApi.scrapeTrigger({ sites: siteIds })
  return { triggeredSiteIds: siteIds, skippedNipSourceCount }
}

/** Add only NIP-native feeds; require a fresh-enough ownership inventory first. */
export async function createSource(
  draft: Parameters<typeof narrativeApi.createSource>[0],
  options: { scraperInventoryKnown: boolean; scraperSites: readonly ScraperSiteInventory[] },
): ReturnType<typeof narrativeApi.createSource> {
  if (options.scraperInventoryKnown && options.scraperSites.some((site) => site.site_id === draft.sourceId)) {
    throw new Error(`The source ID “${draft.sourceId}” is already used by a fina-scraper site. Native IDs are namespaced; choose a distinct NIP source ID.`)
  }
  if (draft.kind === 'podcast') {
    if (!options.scraperInventoryKnown) {
      throw new Error('Cannot verify podcast ownership because fina-scraper inventory is unavailable. Retry after the scraper sidecar reports its site inventory; no NIP source was created.')
    }
    const feed = draft.locator ? canonicalFeedUrl(draft.locator) : null
    if (!feed) throw new Error('A valid HTTP(S) feed URL is required before ownership can be checked.')
    const matchingSite = options.scraperSites.find((site) =>
      site.kind.toLowerCase() === 'podcast' && canonicalFeedUrl(site.feed_url ?? '') === feed,
    )
    if (matchingSite) {
      throw new Error(`This feed is owned by fina-scraper site “${matchingSite.site_id}”. Configure it in scraper YAML; the NIP compatibility registry will not create a second subscription or transcription path.`)
    }
  }
  return narrativeApi.createSource(draft)
}

/** Delete through the NIP adapter only after owner resolution proves NIP ownership. */
export async function deleteSource(action: SourceLifecycleAction): Promise<void> {
  ensureWritableOwner(action, 'removed')
  if (action.ownership.owner === 'nip-engine') {
    await narrativeApi.deleteSource(action.ownership.reference.sourceId)
  }
}

/**
 * Single UI-facing repository. Adapters stay namespaced so domain-specific reads
 * retain their original contracts while cross-owner source mutations route here.
 */
export const narrativeRepository = {
  nip: narrativeApi,
  scraper: scraperApi,
  canonicalFeedUrl,
  resolveSourceOwnership,
  setSourceLifecycle,
  setSourcesLifecycle,
  triggerSourcesNow,
  createSource,
  deleteSource,
}
