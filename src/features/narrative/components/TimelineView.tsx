import { useMemo, useState } from 'react'
import { PanelCard } from '../../shared/components/PanelCard'
import type { NipClaim, NipEvent } from '../types'
import { reviewStatusLabel, tierLabel } from '../thesisGates'

function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function eventTime(event: NipEvent): string {
  return event.times.published_at ?? event.times.captured_at
}

/**
 * A real timeline (revamp §c.4): retained events + their claims, ordered
 * by published_at, with tier badges and ingested_at shown so look-ahead
 * is visible. This replaces the old view, which was the weekly signal
 * list with a different heading. Claims sit under the event they cite;
 * a claim with no tier is rendered as an error state, not a normal claim.
 */
export function TimelineView({
  events,
  claims,
  asOf,
  onOpenEvent,
}: {
  events: NipEvent[]
  claims: NipClaim[]
  asOf: string | null
  onOpenEvent?: (event: NipEvent) => void
}) {
  const [subjectFilter, setSubjectFilter] = useState('')
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null)

  const claimsByEvent = useMemo(() => {
    const map = new Map<string, NipClaim[]>()
    for (const claim of claims) {
      for (const evidence of claim.evidence) {
        if (!map.has(evidence.event_id)) map.set(evidence.event_id, [])
        map.get(evidence.event_id)!.push(claim)
      }
    }
    return map
  }, [claims])

  const ordered = useMemo(() => {
    const needle = subjectFilter.trim().toLowerCase()
    return [...events]
      .filter((event) => !needle || [event.source_id, event.source_native_id ?? '', event.content_text ?? ''].join(' ').toLowerCase().includes(needle))
      .sort((a, b) => eventTime(b).localeCompare(eventTime(a)))
  }, [events, subjectFilter])

  return (
    <div data-testid="timeline-view">
      <PanelCard title="Timeline" subtitle={`Time-ordered events + claims · as_of ${asOf ?? 'not set'} · ingested_at shown so look-ahead is visible`} collapsible={false} bodyClassName="narrative-card-body">
        <label className="flex items-center gap-2 text-[11px] text-muted">Filter <input type="search" aria-label="Filter timeline" placeholder="Source, episode, or text…" value={subjectFilter} onChange={(event) => setSubjectFilter(event.target.value)} data-testid="timeline-filter" className="min-w-0 flex-1" /></label>
        {ordered.length ? (
          <ol className="mt-3 space-y-2">
            {ordered.map((event) => {
              const eventClaims = claimsByEvent.get(event.event_id) ?? []
              const expanded = expandedEventId === event.event_id
              return (
                <li key={event.event_id} className="evidence-card" data-testid={`timeline-row-${event.event_id}`}>
                  <button type="button" className="flex w-full items-start justify-between gap-2 text-left" onClick={() => setExpandedEventId(expanded ? null : event.event_id)} aria-expanded={expanded}>
                    <span className="min-w-0">
                      <span className="block text-[10px] text-muted">{formatDate(event.times.published_at)} · published</span>
                      <strong className="mt-1 block truncate text-xs text-main">{event.source_native_id || event.event_id}</strong>
                      <span className="mt-1 block text-[10px] text-muted">{event.source_id} · ingested {formatDate(event.times.ingested_at)} · {eventClaims.length} claim{eventClaims.length === 1 ? '' : 's'}</span>
                    </span>
                    <span className="narrative-chip">{expanded ? 'Hide claims' : 'Show claims'}</span>
                  </button>
                  {expanded ? (
                    <div className="mt-2 space-y-2 border-t border-line pt-2">
                      <p className="whitespace-pre-wrap text-[11px] leading-5 text-main">{event.content_text ?? 'No retained content text.'}</p>
                      {eventClaims.length ? eventClaims.map((claim) => (
                        <div key={claim.claim_id} className="rounded border border-line p-2" data-testid={`timeline-claim-${claim.claim_id}`}>
                          <p className="text-[11px] text-main">{claim.claim_text}</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <span className="narrative-chip" data-testid={`timeline-claim-tier-${claim.claim_id}`}>{tierLabel(claim.extraction_tier)}</span>
                            <span className="narrative-chip">{reviewStatusLabel(claim.review_status)}</span>
                            <span className="narrative-chip">{Math.round(claim.confidence_millis / 10)}% confidence</span>
                          </div>
                          {!claim.extraction_tier ? <p className="mt-1 text-[10px] text-red-600" role="alert">Unlabelled claim: no extraction tier recorded. A claim without its tier is invalid — do not use it as evidence.</p> : null}
                        </div>
                      )) : <p className="text-[10px] text-muted">No claims extracted from this event yet.</p>}
                      {onOpenEvent ? <button type="button" className="text-[11px] underline" onClick={() => onOpenEvent(event)}>Open event detail</button> : null}
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ol>
        ) : <p className="mt-3 text-[11px] text-muted">No retained events match this view.</p>}
      </PanelCard>
    </div>
  )
}
