import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalFeedUrl,
  createSource,
  resolveSourceOwnership,
  setSourceLifecycle,
} from '../repository'
import type { ScraperSchedule, ScraperSiteInventory } from '../scraperTypes'
import type { NipPodcastSubscription, NipSource } from '../types'

const nipApi = vi.hoisted(() => ({
  createSource: vi.fn(async () => ({})),
  setSourceState: vi.fn(async () => ({})),
  deleteSource: vi.fn(async () => ({})),
}))
const scraperApi = vi.hoisted(() => ({
  scrapeSchedule: vi.fn(async () => ({})),
  scrapeTrigger: vi.fn(async () => ({})),
}))
vi.mock('../api', () => ({ narrativeApi: nipApi }))
vi.mock('../scraperApi', () => ({ scraperApi }))

const podcast: NipSource = {
  source_id: 'compat-show',
  kind: 'podcast',
  display_name: 'Compatibility show',
  locator: 'HTTPS://Example.COM:443/pod/feed.xml?source=registry#legacy-fragment',
  rights_status: 'approved',
  rights_statement: 'Synthetic fixture rights',
  topics: [],
  state: 'active',
  poll_interval_minutes: 60,
  per_scan_limit: 3,
  notes: null,
  created_at: '2026-11-20T00:00:00Z',
  updated_at: '2026-11-20T00:00:00Z',
  event_count: 2,
  episode_count: 4,
}
const subscription: NipPodcastSubscription = {
  source_id: podcast.source_id,
  feed_url: 'https://example.com/pod/feed.xml?source=registry',
  show_name: podcast.display_name,
  rights_statement: 'Synthetic fixture rights',
  rights_confirmed_at: '2026-11-20T00:00:00Z',
  state: 'active',
  last_checked_at: null,
  next_poll_at: null,
  last_error_code: null,
  consecutive_failures: 0,
}
const site: ScraperSiteInventory = {
  site_id: 'scraper-podcast-native-id',
  display_name: 'Scraper feed',
  kind: 'podcast',
  enabled: true,
  poll_interval_min: 15,
  feed_url: 'https://example.com/pod/feed.xml?source=registry',
  source_seed_status: 'seeded',
  schedule_seed_status: 'recorded',
  credential_status: 'not_required',
}
const schedule: ScraperSchedule = {
  site_id: site.site_id,
  poll_interval_min: 15,
  enabled: true,
  llm_daily_budget: 15,
  thesis_daily_budget: 3,
  last_run: null,
  next_run: null,
}

beforeEach(() => vi.clearAllMocks())

describe('narrative repository ownership', () => {
  it('normalizes HTTP(S) feed identity without query loss or fragment identity', () => {
    expect(canonicalFeedUrl('HTTPS://Example.COM:443/pod/feed.xml?source=registry#episode'))
      .toBe('https://example.com/pod/feed.xml?source=registry')
    expect(canonicalFeedUrl('file:///tmp/feed.xml')).toBeNull()
  })

  it('joins compatibility rows by canonical feed URL, not their text ID or seed marker', () => {
    const ownership = resolveSourceOwnership({
      source: podcast,
      subscription,
      scraperSchedules: [schedule],
      scraperSites: [site],
      scraperInventoryKnown: true,
    })
    expect(ownership).toMatchObject({
      owner: 'fina-scraper',
      persistedOrigin: 'nip_store_compatibility',
      reference: { origin: 'scraper_site', siteId: site.site_id },
      compatibilitySourceId: podcast.source_id,
      writable: false,
    })
  })

  it('marks a same-text-ID collision unresolved when no feed match proves identity', () => {
    const source: NipSource = { ...podcast, source_id: 'shared-id', kind: 'web', locator: 'https://nip.example/source' }
    const collidingSite: ScraperSiteInventory = { ...site, site_id: 'shared-id', kind: 'news', feed_url: null }
    const ownership = resolveSourceOwnership({
      source,
      scraperSchedules: [],
      scraperSites: [collidingSite],
      scraperInventoryKnown: true,
    })
    expect(ownership.owner).toBe('unresolved')
    expect(ownership.reference).toMatchObject({ origin: 'source_id_collision', conflictingSiteIds: ['shared-id'] })
    expect(ownership.writable).toBe(false)
  })

  it('fails closed for podcast ownership when the sidecar inventory is unavailable', () => {
    const ownership = resolveSourceOwnership({
      source: podcast,
      subscription,
      scraperSchedules: [],
      scraperSites: [],
      scraperInventoryKnown: false,
    })
    expect(ownership.owner).toBe('unresolved')
    expect(ownership.writable).toBe(false)
  })

  it('routes writes to exactly one owner and refuses unresolved/no-schedule fallbacks', async () => {
    const nipOwnership = resolveSourceOwnership({
      source: { ...podcast, source_id: 'nip-only', kind: 'web', locator: 'https://nip.example/feed' },
      scraperSchedules: [],
      scraperSites: [],
      scraperInventoryKnown: true,
    })
    await setSourceLifecycle({ ownership: nipOwnership }, 'paused')
    expect(nipApi.setSourceState).toHaveBeenCalledWith('nip-only', 'paused')
    expect(scraperApi.scrapeSchedule).not.toHaveBeenCalled()

    const scraperOwnership = resolveSourceOwnership({
      source: podcast,
      subscription,
      scraperSchedules: [schedule],
      scraperSites: [site],
      scraperInventoryKnown: true,
    })
    await setSourceLifecycle({ ownership: scraperOwnership, schedule }, 'paused')
    expect(scraperApi.scrapeSchedule).toHaveBeenCalledWith({
      siteId: site.site_id,
      pollIntervalMin: schedule.poll_interval_min,
      enabled: false,
      llmDailyBudget: schedule.llm_daily_budget,
      thesisDailyBudget: schedule.thesis_daily_budget,
    })
    expect(nipApi.setSourceState).toHaveBeenCalledTimes(1)

    await expect(setSourceLifecycle({ ownership: scraperOwnership }, 'active')).rejects.toThrow(/no scraper schedule/i)
    await expect(setSourceLifecycle({ ownership: { ...nipOwnership, owner: 'unresolved', writable: false, reason: 'ambiguous', persistedOrigin: 'nip_store', reference: { origin: 'source_id_collision', sourceId: 'nip-only', conflictingSiteIds: ['nip-only'] } } }, 'active')).rejects.toThrow('ambiguous')
    expect(nipApi.setSourceState).toHaveBeenCalledTimes(1)
    expect(scraperApi.scrapeSchedule).toHaveBeenCalledTimes(1)
  })

  it('preflights podcast feed and namespaced source ID before any NIP creation', async () => {
    const draft = {
      sourceId: 'new-podcast',
      kind: 'podcast' as const,
      displayName: 'New show',
      locator: 'https://example.com/pod/feed.xml?source=registry#ignored',
      rightsStatement: 'Synthetic rights',
      userConfirmedRights: true,
    }
    await expect(createSource(draft, { scraperInventoryKnown: true, scraperSites: [site] }))
      .rejects.toThrow(/owned by fina-scraper/)
    await expect(createSource({ ...draft, sourceId: site.site_id }, { scraperInventoryKnown: true, scraperSites: [site] }))
      .rejects.toThrow(/Native IDs are namespaced/)
    await expect(createSource(draft, { scraperInventoryKnown: false, scraperSites: [] }))
      .rejects.toThrow(/inventory is unavailable/)
    expect(nipApi.createSource).not.toHaveBeenCalled()
  })

  it('allows NIP podcast creation only after known inventory excludes the feed', async () => {
    const draft = {
      sourceId: 'independent-show',
      kind: 'podcast' as const,
      displayName: 'Independent show',
      locator: 'https://independent.example/feed.xml',
      rightsStatement: 'Synthetic rights',
      userConfirmedRights: true,
    }
    await createSource(draft, { scraperInventoryKnown: true, scraperSites: [site] })
    expect(nipApi.createSource).toHaveBeenCalledTimes(1)
  })
})
