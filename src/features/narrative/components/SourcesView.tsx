import { useEffect, useMemo, useState } from 'react'
import { Search, Star } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { PanelCard } from '../../shared/components/PanelCard'
import { narrativeApi } from '../api'
import { scraperApi } from '../scraperApi'
import type { NipPodcastSubscription, NipEvent, NipSource, NipSourceKind } from '../types'
import type { ScraperSchedule } from '../scraperTypes'
import { AddSourceForm, EditSourceForm, KIND_LABELS, kindLabel } from './SourceRegistry'

const FAVOURITES_KEY = 'fina.nip.source-favourites.v1'

function loadFavourites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVOURITES_KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

function saveFavourites(favourites: Set<string>): void {
  try {
    localStorage.setItem(FAVOURITES_KEY, JSON.stringify([...favourites]))
  } catch {
    /* favourites are a convenience; losing them is not an error */
  }
}

/**
 * Which side owns the fetch for this row (revamp §c.2, decision §f.1):
 * two registries behind one view, never merged. A source with a recorded
 * fina-scraper schedule is scraper-managed; everything else — including
 * NIP-only kinds such as local documents and company-meeting uploads —
 * is nip-engine-managed.
 */
export function managedBy(source: NipSource, scraperSiteIds: Set<string>): 'fina-scraper' | 'nip-engine' {
  return scraperSiteIds.has(source.source_id) ? 'fina-scraper' : 'nip-engine'
}

const KIND_GROUPS: Array<{ id: string; label: string; kinds: NipSourceKind[] }> = [
  { id: 'podcast', label: 'Podcast', kinds: ['podcast'] },
  { id: 'meeting', label: 'Company meeting', kinds: ['company_meeting'] },
  { id: 'filing', label: 'Filing', kinds: ['filing'] },
  { id: 'news-api', label: 'News + API', kinds: ['reddit', 'x', 'web'] },
  { id: 'other', label: 'Other', kinds: ['local_document', 'other'] },
]

function kindGroupOf(kind: NipSourceKind): string {
  return KIND_GROUPS.find((group) => group.kinds.includes(kind))?.id ?? 'other'
}

type SourceFilter = 'all' | 'active' | 'paused' | 'errors' | 'removed'
type SourceSort = 'name' | 'last-checked' | 'errors'

function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function SourcesView({
  sources,
  subscriptions,
  events,
  scraperSchedules,
  onChanged,
}: {
  sources: NipSource[]
  subscriptions: NipPodcastSubscription[]
  events: NipEvent[]
  scraperSchedules: ScraperSchedule[]
  onChanged: () => Promise<void>
}) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<SourceFilter>('all')
  const [sort, setSort] = useState<SourceSort>('name')
  const [favourites, setFavourites] = useState<Set<string>>(loadFavourites)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [messageIsError, setMessageIsError] = useState(false)

  const subscriptionBySource = useMemo(
    () => new Map(subscriptions.map((subscription) => [subscription.source_id, subscription])),
    [subscriptions],
  )
  const scraperSiteIds = useMemo(() => new Set(scraperSchedules.map((schedule) => schedule.site_id)), [scraperSchedules])
  const scheduleBySite = useMemo(
    () => new Map(scraperSchedules.map((schedule) => [schedule.site_id, schedule])),
    [scraperSchedules],
  )

  useEffect(() => { saveFavourites(favourites) }, [favourites])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    const rows = sources.filter((source) => {
      if (filter === 'active' && source.state !== 'active') return false
      if (filter === 'paused' && source.state !== 'paused') return false
      if (filter === 'removed' && source.state !== 'removed') return false
      if (filter === 'errors') {
        const subscription = subscriptionBySource.get(source.source_id)
        if (!subscription?.last_error_code && (subscription?.consecutive_failures ?? 0) === 0) return false
      }
      if (needle && ![source.display_name, source.locator ?? '', source.topics.join(' ')].join(' ').toLowerCase().includes(needle)) return false
      return true
    })
    const byName = (a: NipSource, b: NipSource) => a.display_name.localeCompare(b.display_name)
    const byErrors = (a: NipSource, b: NipSource) =>
      (subscriptionBySource.get(b.source_id)?.consecutive_failures ?? 0) - (subscriptionBySource.get(a.source_id)?.consecutive_failures ?? 0) || byName(a, b)
    const byLastChecked = (a: NipSource, b: NipSource) =>
      (subscriptionBySource.get(b.source_id)?.last_checked_at ?? '').localeCompare(subscriptionBySource.get(a.source_id)?.last_checked_at ?? '') || byName(a, b)
    const sorted = [...rows].sort(sort === 'errors' ? byErrors : sort === 'last-checked' ? byLastChecked : byName)
    // Favourites pin to the top of their group.
    return sorted.sort((a, b) => Number(favourites.has(b.source_id)) - Number(favourites.has(a.source_id)))
  }, [sources, filter, search, sort, favourites, subscriptionBySource])

  const groups = useMemo(() => {
    const map = new Map<string, NipSource[]>()
    for (const source of filtered) {
      const group = kindGroupOf(source.kind)
      if (!map.has(group)) map.set(group, [])
      map.get(group)!.push(source)
    }
    return KIND_GROUPS.filter((group) => map.has(group.id)).map((group) => ({ ...group, rows: map.get(group.id)! }))
  }, [filtered])

  const toggleFavourite = (sourceId: string) => {
    setFavourites((current) => {
      const next = new Set(current)
      if (next.has(sourceId)) next.delete(sourceId)
      else next.add(sourceId)
      return next
    })
  }

  const toggleSelected = (sourceId: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(sourceId)) next.delete(sourceId)
      else next.add(sourceId)
      return next
    })
  }

  const bulk = async (action: 'pause' | 'resume' | 'remove' | 'run-now') => {
    const ids = [...selected]
    if (!ids.length) return
    setBusy(true)
    setMessage(null)
    setMessageIsError(false)
    try {
      if (action === 'run-now') {
        const scraperIds = ids.filter((id) => scraperSiteIds.has(id))
        const skipped = ids.length - scraperIds.length
        if (!scraperIds.length) throw new Error('None of the selected sources is managed by fina-scraper. NIP-owned sources refresh on the desktop timer — see the Schedules view.')
        await scraperApi.scrapeTrigger({ sites: scraperIds })
        setMessage(`Scrape triggered for ${scraperIds.length} scraper-managed source${scraperIds.length === 1 ? '' : 's'}${skipped ? ` · ${skipped} NIP-owned source${skipped === 1 ? '' : 's'} skipped (desktop timer owns those)` : ''}.`)
      } else {
        const state = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'removed'
        for (const id of ids) await narrativeApi.setSourceState(id, state)
        setMessage(`${ids.length} source${ids.length === 1 ? '' : 's'} ${action === 'remove' ? 'removed' : action === 'pause' ? 'paused' : 'resumed'}.`)
      }
      setSelected(new Set())
      await onChanged()
    } catch (reason) {
      setMessageIsError(true)
      setMessage(reason instanceof Error ? reason.message : 'The bulk action failed.')
    } finally {
      setBusy(false)
    }
  }

  const drawerSource = drawerId ? sources.find((source) => source.source_id === drawerId) ?? null : null
  const drawerSchedule = drawerSource ? scheduleBySite.get(drawerSource.source_id) ?? null : null
  const drawerEvents = drawerSource ? events.filter((event) => event.source_id === drawerSource.source_id).slice(0, 5) : []

  return (
    <div className="space-y-3" data-testid="sources-view">
      <PanelCard title="Sources" subtitle="Two registries, one view · fina-scraper owns scraper kinds, nip-engine owns local kinds · rights gate unchanged" collapsible={false} bodyClassName="narrative-card-body" actions={<Button size="sm" onClick={() => setAddOpen(true)} data-testid="add-source-open">Add source</Button>}>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-52 flex-1 items-center gap-2 text-[11px] text-muted"><Search size={13} /><input type="search" aria-label="Search sources" placeholder="Search name, locator, topics…" value={search} onChange={(event) => setSearch(event.target.value)} data-testid="sources-search" className="min-w-0 flex-1" /></label>
          <label className="text-[11px] text-muted">Sort <select aria-label="Sort sources" value={sort} onChange={(event) => setSort(event.target.value as SourceSort)} data-testid="sources-sort"><option value="name">Name</option><option value="last-checked">Last checked</option><option value="errors">Error count</option></select></label>
        </div>
        <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Source filter">
          {(['all', 'active', 'paused', 'errors', 'removed'] as SourceFilter[]).map((option) => (
            <button key={option} type="button" className={`narrative-chip ${filter === option ? 'is-active' : ''}`} aria-pressed={filter === option} onClick={() => setFilter(option)} data-testid={`sources-filter-${option}`}>{option[0].toUpperCase()}{option.slice(1)}</button>
          ))}
          <span className="ml-auto text-[10px] text-muted">{filtered.length} of {sources.length} sources</span>
        </div>
        {selected.size ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-line bg-panel p-2" data-testid="sources-bulk-bar">
            <span className="text-[11px] text-main">{selected.size} selected</span>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void bulk('pause')} data-testid="sources-bulk-pause">Pause</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void bulk('resume')} data-testid="sources-bulk-resume">Resume</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void bulk('remove')} data-testid="sources-bulk-remove">Remove</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void bulk('run-now')} data-testid="sources-bulk-run-now">Run now</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        ) : null}
        {message ? <p className={`mt-2 text-[10px] ${messageIsError ? 'text-red-600' : 'text-muted'}`} role={messageIsError ? 'alert' : 'status'}>{message}</p> : null}
        {groups.length ? groups.map((group) => (
          <section key={group.id} className="mt-3" data-testid={`sources-group-${group.id}`}>
            <button type="button" className="flex w-full items-center gap-2 text-left text-xs font-semibold text-main" aria-expanded={!collapsedGroups.has(group.id)} onClick={() => setCollapsedGroups((current) => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next })}>
              <span>{collapsedGroups.has(group.id) ? '▸' : '▾'}</span> {group.label} <span className="narrative-chip">{group.rows.length}</span>
            </button>
            {collapsedGroups.has(group.id) ? null : (
              <div className="mt-2 overflow-x-auto">
                <table className="narrative-table" data-testid={`sources-table-${group.id}`}>
                  <thead><tr><th aria-label="Select" /><th aria-label="Favourite" /><th>Name</th><th>Kind</th><th>Managed by</th><th>State</th><th>Health</th><th>Events</th><th>Episodes</th><th>Last checked</th><th>Next poll</th><th>Poll interval</th><th>Per-scan</th><th>Topics</th></tr></thead>
                  <tbody>
                    {group.rows.map((source) => {
                      const subscription = subscriptionBySource.get(source.source_id)
                      const health = subscription?.last_error_code
                        ? `error ${subscription.last_error_code} · ${subscription.consecutive_failures} failure${subscription.consecutive_failures === 1 ? '' : 's'}`
                        : subscription ? 'ok' : 'no feed record'
                      return (
                        <tr key={source.source_id} data-testid={`source-table-row-${source.source_id}`} onClick={() => setDrawerId(source.source_id)} className="cursor-pointer">
                          <td onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`Select ${source.display_name}`} checked={selected.has(source.source_id)} onChange={() => toggleSelected(source.source_id)} data-testid={`source-select-${source.source_id}`} /></td>
                          <td onClick={(event) => event.stopPropagation()}><button type="button" aria-label={`Favourite ${source.display_name}`} aria-pressed={favourites.has(source.source_id)} onClick={() => toggleFavourite(source.source_id)} data-testid={`source-favourite-${source.source_id}`}><Star size={13} fill={favourites.has(source.source_id) ? 'currentColor' : 'none'} /></button></td>
                          <td><strong className="text-xs text-main">{source.display_name}</strong><span className="block max-w-44 truncate text-[10px] text-muted" title={source.locator ?? undefined}>{source.locator ?? 'No locator'}</span></td>
                          <td>{kindLabel(source.kind)}</td>
                          <td><span className="narrative-chip" data-testid={`source-managed-by-${source.source_id}`}>{managedBy(source, scraperSiteIds)}</span></td>
                          <td><span className="narrative-chip" data-testid={`source-state-${source.source_id}`}>{source.state}</span></td>
                          <td className={subscription?.last_error_code ? 'text-red-600' : undefined}>{health}</td>
                          <td>{source.event_count}</td>
                          <td>{source.episode_count}</td>
                          <td>{formatDate(subscription?.last_checked_at)}</td>
                          <td>{formatDate(subscription?.next_poll_at)}</td>
                          <td>{source.poll_interval_minutes} min</td>
                          <td>{source.per_scan_limit}/scan</td>
                          <td>{source.topics.join(' · ') || '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )) : <p className="mt-3 text-[11px] text-muted">No sources match the current search or filter.</p>}
      </PanelCard>
      {addOpen ? (
        <div className="narrative-dialog-backdrop" data-testid="add-source-dialog" onMouseDown={() => setAddOpen(false)}>
          <div className="narrative-dialog" role="dialog" aria-modal="true" aria-label="Add a source" onMouseDown={(event) => event.stopPropagation()}>
            <div className="narrative-dialog-body">
              <AddSourceForm onSubmitted={async () => { await onChanged(); setAddOpen(false) }} />
              <Button variant="ghost" size="sm" onClick={() => setAddOpen(false)}>Close</Button>
            </div>
          </div>
        </div>
      ) : null}
      {drawerSource ? (
        <div className="narrative-dialog-backdrop" data-testid="source-drawer" onMouseDown={() => setDrawerId(null)}>
          <div className="narrative-dialog" role="dialog" aria-modal="true" aria-label={`Source ${drawerSource.display_name}`} onMouseDown={(event) => event.stopPropagation()}>
            <header className="narrative-dialog-head">
              <div className="min-w-0"><p className="eyebrow">Source detail</p><h2 className="mt-1 truncate text-sm font-semibold text-main">{drawerSource.display_name}</h2><p className="mt-1 text-[10px] text-muted">{KIND_LABELS[drawerSource.kind]} · managed by {managedBy(drawerSource, scraperSiteIds)} · {drawerSource.state} · rights {drawerSource.rights_status}</p></div>
              <Button variant="ghost" size="sm" onClick={() => setDrawerId(null)}>Close</Button>
            </header>
            <div className="narrative-dialog-body">
            <dl className="narrative-provenance">
              <div><dt>Locator</dt><dd>{drawerSource.locator ?? 'No locator (local reference)'}</dd></div>
              <div><dt>Poll interval</dt><dd>{drawerSource.poll_interval_minutes} min</dd></div>
              <div><dt>Per-scan limit</dt><dd>{drawerSource.per_scan_limit}</dd></div>
              <div><dt>Topics</dt><dd>{drawerSource.topics.join(' · ') || '—'}</dd></div>
              <div><dt>Events / episodes</dt><dd>{drawerSource.event_count} / {drawerSource.episode_count}</dd></div>
            </dl>
            {drawerSchedule ? (
              <section className="mt-3"><h3 className="text-xs font-semibold text-main">Scraper schedule</h3><dl className="narrative-provenance mt-1"><div><dt>Enabled</dt><dd>{drawerSchedule.enabled ? 'yes' : 'no'}</dd></div><div><dt>Interval</dt><dd>{drawerSchedule.poll_interval_min} min</dd></div><div><dt>Next run</dt><dd>{formatDate(drawerSchedule.next_run)}</dd></div><div><dt>Last run</dt><dd>{drawerSchedule.last_run ? `${drawerSchedule.last_run.status} · finished ${formatDate(drawerSchedule.last_run.finished_at)}${drawerSchedule.last_run.error ? ` · ${drawerSchedule.last_run.error}` : ''}` : 'no covering run yet'}</dd></div><div><dt>Budgets</dt><dd>LLM {drawerSchedule.llm_daily_budget}/day · theses {drawerSchedule.thesis_daily_budget}/day</dd></div></dl></section>
            ) : <p className="mt-3 text-[10px] text-muted">No fina-scraper schedule recorded for this source. NIP-owned sources refresh on the desktop timer; add a schedule in the Schedules view to make it scraper-managed.</p>}
            <section className="mt-3"><h3 className="text-xs font-semibold text-main">Recent items</h3>{drawerEvents.length ? <ul className="mt-1 space-y-1">{drawerEvents.map((event) => <li key={event.event_id} className="text-[11px] text-main">{event.source_native_id ?? event.event_id} · published {formatDate(event.times.published_at)}</li>)}</ul> : <p className="mt-1 text-[10px] text-muted">No retained events for this source in the current page.</p>}</section>
            <EditSourceForm source={drawerSource} onDone={() => setDrawerId(null)} onChanged={onChanged} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
