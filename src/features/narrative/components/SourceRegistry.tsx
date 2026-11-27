import { useState } from 'react'
import { Button } from '../../../components/ui/button'
import { PanelCard } from '../../shared/components/PanelCard'
import { narrativeRepository } from '../repository'
import type { ScraperSchedule, ScraperSiteInventory } from '../scraperTypes'
import type { NipPodcastSubscription, NipSource, NipSourceKind } from '../types'

export const KIND_LABELS: Record<NipSourceKind, string> = {
  podcast: 'Podcast',
  company_meeting: 'Company meeting',
  filing: 'Filing',
  reddit: 'Reddit',
  x: 'X / Twitter',
  web: 'Web',
  local_document: 'Local document',
  other: 'Other',
}

const KIND_OPTIONS: NipSourceKind[] = ['podcast', 'company_meeting', 'filing', 'web', 'reddit', 'x', 'local_document', 'other']

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

export function kindLabel(kind: NipSourceKind): string {
  return KIND_LABELS[kind]
}

export function AddSourceForm({ onSubmitted, scraperSites = [], scraperInventoryKnown = false }: { onSubmitted: () => Promise<void>; scraperSites?: ScraperSiteInventory[]; scraperInventoryKnown?: boolean }) {
  const [kind, setKind] = useState<NipSourceKind>('podcast')
  const [sourceId, setSourceId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [locator, setLocator] = useState('')
  const [rightsStatement, setRightsStatement] = useState('')
  const [topics, setTopics] = useState('')
  const [perScanLimit, setPerScanLimit] = useState('3')
  const [confirmed, setConfirmed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const needsLocator = kind !== 'local_document' && kind !== 'other'
  const isPodcast = kind === 'podcast'

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setMessage(null)
    try {
      await narrativeRepository.createSource({
        sourceId: sourceId.trim(),
        kind,
        displayName: displayName.trim(),
        locator: locator.trim() || null,
        rightsStatement,
        userConfirmedRights: confirmed,
        topics: topics.split(',').map((topic) => topic.trim()).filter(Boolean),
        perScanLimit: Number(perScanLimit) || undefined,
      }, { scraperInventoryKnown, scraperSites })
      setSourceId('')
      setDisplayName('')
      setLocator('')
      setRightsStatement('')
      setTopics('')
      setConfirmed(false)
      setMessage(isPodcast ? 'Feed approved and initial sync requested.' : 'Source registered. No fetch ran for this kind yet.')
      await onSubmitted()
    } catch (reason) {
      setMessage(messageOf(reason))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <PanelCard title="Add a source" subtitle="Rights confirmation is required for every kind · podcasts sync immediately" collapsible={false} bodyClassName="narrative-card-body">
      <form className="space-y-2" onSubmit={submit} data-testid="add-source-form">
        <label className="block text-[10px] text-muted">Source kind
          <select className="w-full" aria-label="Source kind" value={kind} onChange={(event) => setKind(event.target.value as NipSourceKind)} data-testid="source-kind">
            {KIND_OPTIONS.map((option) => <option key={option} value={option}>{kindLabel(option)}</option>)}
          </select>
        </label>
        <input className="w-full" aria-label="Source ID" value={sourceId} onChange={(event) => setSourceId(event.target.value)} placeholder="Source ID" required />
        <input className="w-full" aria-label={isPodcast ? 'Show name' : 'Display name'} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={isPodcast ? 'Show name' : 'Source name'} required />
        <input
          className="w-full"
          aria-label={isPodcast ? 'Podcast feed URL' : 'Source locator'}
          type="url"
          value={locator}
          onChange={(event) => setLocator(event.target.value)}
          placeholder={isPodcast ? 'https://example.com/feed.xml' : 'https://example.com/source'}
          required={needsLocator}
        />
        <textarea className="w-full" aria-label="Rights statement" value={rightsStatement} onChange={(event) => setRightsStatement(event.target.value)} placeholder="Describe your rights to access and retain this source." rows={2} required />
        <input className="w-full" aria-label="Topics" value={topics} onChange={(event) => setTopics(event.target.value)} placeholder="Topics (comma separated)" />
        <input className="w-full" aria-label="Per-scan limit" type="number" min={1} max={10} value={perScanLimit} onChange={(event) => setPerScanLimit(event.target.value)} />
        <label className="flex items-start gap-2 text-[11px] text-muted"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} required /><span>I confirm access and retention rights for this source.</span></label>
        <Button type="submit" size="sm" disabled={submitting || !confirmed}>{submitting ? 'Saving…' : isPodcast ? 'Approve and sync' : 'Register source'}</Button>
        {message ? <p className="text-[10px] text-muted" role="status">{message}</p> : null}
      </form>
    </PanelCard>
  )
}

export function EditSourceForm({ source, onDone, onChanged }: { source: NipSource; onDone: () => void; onChanged: () => Promise<void> }) {
  const [displayName, setDisplayName] = useState(source.display_name)
  const [locator, setLocator] = useState(source.locator ?? '')
  const [rightsStatement, setRightsStatement] = useState(source.rights_statement ?? '')
  const [topics, setTopics] = useState(source.topics.join(', '))
  const [perScanLimit, setPerScanLimit] = useState(String(source.per_scan_limit))
  const [pollIntervalMinutes, setPollIntervalMinutes] = useState(String(source.poll_interval_minutes))
  const [sync, setSync] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      await narrativeRepository.nip.updateSource({
        sourceId: source.source_id,
        displayName: displayName.trim(),
        locator: locator.trim(),
        rightsStatement,
        topics: topics.split(',').map((topic) => topic.trim()).filter(Boolean),
        perScanLimit: Number(perScanLimit) || undefined,
        pollIntervalMinutes: Number(pollIntervalMinutes) || undefined,
        sync,
      })
      await onChanged()
      onDone()
    } catch (reason) {
      setMessage(messageOf(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="mt-2 space-y-2 border-t border-line pt-2" onSubmit={save} data-testid={`edit-source-${source.source_id}`}>
      <input className="w-full" aria-label="Display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required />
      <input className="w-full" aria-label="Source locator" type="url" value={locator} onChange={(event) => setLocator(event.target.value)} />
      <textarea className="w-full" aria-label="Rights statement" value={rightsStatement} onChange={(event) => setRightsStatement(event.target.value)} rows={2} />
      <input className="w-full" aria-label="Topics" value={topics} onChange={(event) => setTopics(event.target.value)} />
      <input className="w-full" aria-label="Per-scan limit" type="number" min={1} max={10} value={perScanLimit} onChange={(event) => setPerScanLimit(event.target.value)} />
      <input className="w-full" aria-label="Poll interval (minutes)" type="number" min={0} value={pollIntervalMinutes} onChange={(event) => setPollIntervalMinutes(event.target.value)} />
      {source.kind === 'podcast' ? <label className="flex items-center gap-2 text-[10px] text-muted"><input type="checkbox" checked={sync} onChange={(event) => setSync(event.target.checked)} /> Refresh the corrected feed now</label> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
      {message ? <p className="text-[10px] text-red-600" role="alert">{message}</p> : null}
    </form>
  )
}

export function SourceRegistry({ sources, subscriptions = [], scraperSites = [], scraperSchedules = [], scraperInventoryKnown = false, onChanged }: { sources: NipSource[]; subscriptions?: NipPodcastSubscription[]; scraperSites?: ScraperSiteInventory[]; scraperSchedules?: ScraperSchedule[]; scraperInventoryKnown?: boolean; onChanged: () => Promise<void> }) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showRemoved, setShowRemoved] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const visible = sources.filter((source) => showRemoved || source.state !== 'removed')
  const subscriptionBySource = new Map(subscriptions.map((subscription) => [subscription.source_id, subscription]))
  const scheduleBySite = new Map(scraperSchedules.map((schedule) => [schedule.site_id, schedule]))
  const ownershipFor = (source: NipSource) => narrativeRepository.resolveSourceOwnership({
    source,
    subscription: subscriptionBySource.get(source.source_id),
    scraperSchedules,
    scraperSites,
    scraperInventoryKnown,
  })

  const change = async (source: NipSource, state: 'active' | 'paused' | 'removed') => {
    setBusyId(source.source_id)
    setMessage(null)
    try {
      const ownership = ownershipFor(source)
      const schedule = ownership.owner === 'fina-scraper' ? scheduleBySite.get(ownership.reference.siteId) ?? null : null
      await narrativeRepository.setSourceLifecycle({ ownership, schedule }, state)
      await onChanged()
    } catch (reason) {
      setMessage(messageOf(reason))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (source: NipSource) => {
    setBusyId(source.source_id)
    setMessage(null)
    try {
      const ownership = ownershipFor(source)
      const schedule = ownership.owner === 'fina-scraper' ? scheduleBySite.get(ownership.reference.siteId) ?? null : null
      await narrativeRepository.deleteSource({ ownership, schedule })
      await onChanged()
    } catch (reason) {
      setMessage(messageOf(reason))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <PanelCard
      title="Sources"
      subtitle="Every approved source kind · rights, lifecycle and bounded scan caps"
      collapsible={false}
      actions={<label className="flex items-center gap-1 text-[10px] text-muted"><input type="checkbox" checked={showRemoved} onChange={(event) => setShowRemoved(event.target.checked)} data-testid="show-removed" /> Removed</label>}
      bodyClassName="narrative-card-body"
    >
      <div className="space-y-2" data-testid="source-registry">
        {visible.length ? visible.map((source) => (
          <div className="evidence-card" key={source.source_id} data-testid={`source-row-${source.source_id}`}>
            {(() => {
              const ownership = ownershipFor(source)
              const canEdit = ownership.owner === 'nip-engine' && ownership.writable
              return <>
            <div className="flex items-center justify-between gap-2">
              <strong className="min-w-0 truncate text-xs text-main">{source.display_name}</strong>
              <span className="flex gap-1"><span className="narrative-chip">{kindLabel(source.kind)}</span><span className="narrative-chip" data-testid={`source-owner-${source.source_id}`}>{ownership.owner}</span></span>
            </div>
            <p className="mt-1 truncate text-[10px] text-muted" title={source.locator ?? undefined}>{source.locator ?? 'No locator (local reference)'}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted">
              <span className="narrative-chip" data-testid={`source-state-${source.source_id}`}>{source.state}</span>
              <span className="narrative-chip">rights {source.rights_status}</span>
              <span className="narrative-chip">{source.per_scan_limit}/scan</span>
              <span>{source.event_count} events · {source.episode_count} episodes</span>
            </div>
            {source.topics.length ? <p className="mt-1 text-[10px] text-muted">Topics: {source.topics.join(' · ')}</p> : null}
            <div className="mt-2 flex flex-wrap gap-1">
              <Button size="sm" variant="outline" disabled={busyId === source.source_id || source.state === 'removed' || !canEdit} onClick={() => setEditingId(editingId === source.source_id ? null : source.source_id)}>Edit</Button>
              {source.state === 'active'
                ? <Button size="sm" variant="outline" disabled={busyId === source.source_id || !ownership.writable} onClick={() => void change(source, 'paused')}>Pause</Button>
                : source.state === 'paused'
                  ? <Button size="sm" variant="outline" disabled={busyId === source.source_id || !ownership.writable} onClick={() => void change(source, 'active')}>Resume</Button>
                  : <Button size="sm" variant="outline" disabled={busyId === source.source_id || !ownership.writable} onClick={() => void change(source, 'active')}>Restore</Button>}
              {source.state !== 'removed' ? <Button size="sm" variant="ghost" disabled={busyId === source.source_id || !ownership.writable} onClick={() => void change(source, 'removed')}>Remove</Button> : null}
              <Button size="sm" variant="ghost" disabled={busyId === source.source_id || source.event_count > 0 || !canEdit} title={source.event_count > 0 ? 'Sources with retained events must be marked removed' : !canEdit ? 'Source owner is not verified as NIP' : 'Delete source'} onClick={() => void remove(source)}>Delete</Button>
            </div>
            {editingId === source.source_id && canEdit ? <EditSourceForm source={source} onDone={() => setEditingId(null)} onChanged={onChanged} /> : null}
              </>
            })()}
          </div>
        )) : <p className="text-[11px] text-muted">No sources registered. Add a podcast, company meeting, filing, Reddit/X reference or local document after reviewing access and retention rights.</p>}
        {message ? <p className="text-[10px] text-red-600" role="alert">{message}</p> : null}
      </div>
    </PanelCard>
  )
}
