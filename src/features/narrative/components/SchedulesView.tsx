import { useState, type FormEvent } from 'react'
import { Button } from '../../../components/ui/button'
import { PanelCard } from '../../shared/components/PanelCard'
import { scraperApi } from '../scraperApi'
import type { ScraperStatus } from '../scraperTypes'
import type { NipResourceStatus } from '../types'

function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function runSummary(run: NonNullable<import('../scraperTypes').ScraperSchedule['last_run']>): string {
  const summary = run.summary as Record<string, unknown> | null
  const counts = summary ? Object.entries(summary).map(([key, value]) => `${key} ${String(value)}`).join(' · ') : ''
  return `${run.status} · started ${formatDate(run.started_at)} · finished ${formatDate(run.finished_at)}${counts ? ` · ${counts}` : ''}${run.error ? ` · error: ${run.error}` : ''}`
}

const INTERVAL_PRESETS: Array<{ label: string; minutes: number }> = [
  { label: 'Tier A — Alpaca news · 5 min', minutes: 5 },
  { label: 'Tier B — news / podcasts · 15 min', minutes: 15 },
  { label: 'Tier B — news / podcasts · 30 min', minutes: 30 },
  { label: 'Tier B — news / podcasts · 60 min', minutes: 60 },
  { label: 'Tier C — meetings / research · 1 h', minutes: 60 },
  { label: 'Tier D — slow data · daily', minutes: 1440 },
  { label: 'Tier D — slow data · weekly', minutes: 10080 },
]

function BudgetBar({ label, used, budget, testId }: { label: string; used: number; budget: number; testId: string }) {
  const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0
  return (
    <div data-testid={testId}>
      <div className="flex items-center justify-between gap-2 text-[11px]"><span className="text-main">{label}</span><strong className="text-main">{used}/{budget}</strong></div>
      <div className="mt-1 h-2 overflow-hidden rounded" role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={budget} aria-label={label} style={{ background: 'color-mix(in srgb, var(--theme-muted) 18%, transparent)' }}>
        <div className="h-full rounded" style={{ width: `${pct}%`, background: 'var(--theme-primary)' }} />
      </div>
    </div>
  )
}

export function SchedulesView({
  status,
  sidecarError,
  resource,
  onChanged,
}: {
  status: ScraperStatus | null
  sidecarError: string | null
  resource: NipResourceStatus | null
  onChanged: () => Promise<void>
}) {
  const [siteId, setSiteId] = useState('')
  const [intervalMin, setIntervalMin] = useState('15')
  const [preset, setPreset] = useState('15')
  const [llmBudget, setLlmBudget] = useState('15')
  const [thesisBudget, setThesisBudget] = useState('3')
  const [enabled, setEnabled] = useState(true)
  const [editingSite, setEditingSite] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [messageIsError, setMessageIsError] = useState(false)
  const [backloadSite, setBackloadSite] = useState('')
  const [backloadDays, setBackloadDays] = useState('90')
  const [backloadResult, setBackloadResult] = useState<string | null>(null)
  const [backloadBusy, setBackloadBusy] = useState(false)

  const schedules = status?.schedules ?? []

  const submitSchedule = async (event: FormEvent) => {
    event.preventDefault()
    const id = (editingSite ?? siteId).trim()
    const minutes = Number(intervalMin)
    if (!id || !Number.isFinite(minutes) || minutes <= 0) {
      setMessageIsError(true)
      setMessage('A site id and a positive poll interval (minutes) are required.')
      return
    }
    setBusy(true)
    setMessage(null)
    setMessageIsError(false)
    try {
      await scraperApi.scrapeSchedule({
        siteId: id,
        pollIntervalMin: minutes,
        enabled,
        llmDailyBudget: Number(llmBudget) || 15,
        thesisDailyBudget: Number(thesisBudget) || 3,
      })
      setMessage(`Schedule ${editingSite ? 'updated' : 'recorded'} for ${id} — every ${minutes} min, LLM ${llmBudget}/day, theses ${thesisBudget}/day.`)
      setEditingSite(null)
      setSiteId('')
      await onChanged()
    } catch (reason) {
      setMessageIsError(true)
      setMessage(reason instanceof Error ? reason.message : 'The schedule could not be recorded.')
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (site: string, interval: number, llm: number, thesis: number, isEnabled: boolean) => {
    setEditingSite(site)
    setSiteId(site)
    setIntervalMin(String(interval))
    setPreset(String(interval))
    setLlmBudget(String(llm))
    setThesisBudget(String(thesis))
    setEnabled(isEnabled)
  }

  const toggleEnabled = async (site: string, interval: number, llm: number, thesis: number, next: boolean) => {
    setBusy(true)
    setMessage(null)
    setMessageIsError(false)
    try {
      await scraperApi.scrapeSchedule({ siteId: site, pollIntervalMin: interval, enabled: next, llmDailyBudget: llm, thesisDailyBudget: thesis })
      setMessage(`Schedule for ${site} ${next ? 'enabled' : 'paused'}.`)
      await onChanged()
    } catch (reason) {
      setMessageIsError(true)
      setMessage(reason instanceof Error ? reason.message : 'The schedule could not be updated.')
    } finally {
      setBusy(false)
    }
  }

  const runNow = async (site: string) => {
    setBusy(true)
    setMessage(null)
    setMessageIsError(false)
    try {
      await scraperApi.scrapeTrigger({ sites: [site] })
      setMessage(`Scrape triggered for ${site}.`)
      await onChanged()
    } catch (reason) {
      setMessageIsError(true)
      setMessage(reason instanceof Error ? reason.message : 'Run now failed.')
    } finally {
      setBusy(false)
    }
  }

  const backload = async (dryRun: boolean) => {
    const days = Math.min(180, Math.max(1, Number(backloadDays) || 90))
    setBackloadDays(String(days))
    setBackloadBusy(true)
    setBackloadResult(null)
    try {
      const result = await scraperApi.scrapeBackload({ days, sites: backloadSite.trim() ? [backloadSite.trim()] : undefined, dryRun })
      setBackloadResult(`${dryRun ? 'Dry run' : 'Backload'} (${days} days, max 180): ${JSON.stringify(result)}`)
      if (!dryRun) await onChanged()
    } catch (reason) {
      setBackloadResult(`Backload failed: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBackloadBusy(false)
    }
  }

  return (
    <div className="space-y-3" data-testid="schedules-view">
      <PanelCard title="Schedules" subtitle="The desktop timer owns execution · system cron remains a supported alternative on the same schedule record" collapsible={false} bodyClassName="narrative-card-body">
        <p className="text-[11px] text-muted">
          Desktop scheduler: {resource ? `every ${resource.scheduler_interval_seconds / 3600}h · ${resource.scheduler_state}` : 'unknown — start the NIP sidecar to read it.'}{' '}
          Schedules are recorded with <code>scrape_schedule</code> and executed by the desktop timer (or <code>fina-scraper run --loop</code> / system cron for headless use).
          The 6h desktop refresh loop does not yet execute per-schedule scrapes — until the nip-engine timer is generalised, a recorded schedule's next run is computed from its last run, not driven by the desktop timer.
        </p>
        {sidecarError ? <p className="mt-2 text-[11px] text-amber-700" role="alert">fina-scraper sidecar unavailable: {sidecarError}. Schedules below are the last known state; nothing here can run until the sidecar is back.</p> : null}
        {status?.budgets ? (
          <div className="mt-3 grid gap-3 sm:grid-cols-2" data-testid="schedule-budgets">
            <BudgetBar label="LLM deep-dives used today" used={status.budgets.llm_reviews_today} budget={status.budgets.llm_daily_budget} testId="budget-llm" />
            <BudgetBar label="Theses used today" used={status.budgets.theses_today} budget={status.budgets.thesis_daily_budget} testId="budget-thesis" />
            <p className="text-[10px] text-muted sm:col-span-2">Budget date {status.budgets.date}. A run that finds nothing moving stops — budgets never silently expand (PIPELINE_STRATEGY §2).</p>
          </div>
        ) : null}
        {schedules.length ? (
          <div className="mt-3 space-y-2">
            {schedules.map((schedule) => (
              <article className="evidence-card" key={schedule.site_id} data-testid={`schedule-row-${schedule.site_id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-xs text-main">{schedule.site_id}</strong>
                  <span className="flex flex-wrap gap-1"><span className="narrative-chip">scrape</span><span className="narrative-chip">{schedule.enabled ? 'enabled' : 'paused'}</span><span className="narrative-chip">every {schedule.poll_interval_min} min</span></span>
                </div>
                <dl className="narrative-provenance mt-2">
                  <div><dt>Next run</dt><dd>{schedule.enabled ? formatDate(schedule.next_run) : 'paused — no next run'}</dd></div>
                  <div><dt>Last run</dt><dd>{schedule.last_run ? runSummary(schedule.last_run) : 'no covering run yet'}</dd></div>
                  <div><dt>Budgets</dt><dd>LLM {schedule.llm_daily_budget}/day · theses {schedule.thesis_daily_budget}/day</dd></div>
                </dl>
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void runNow(schedule.site_id)} data-testid={`schedule-run-now-${schedule.site_id}`}>Run now</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void toggleEnabled(schedule.site_id, schedule.poll_interval_min, schedule.llm_daily_budget, schedule.thesis_daily_budget, !schedule.enabled)} data-testid={`schedule-toggle-${schedule.site_id}`}>{schedule.enabled ? 'Pause' : 'Enable'}</Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => startEdit(schedule.site_id, schedule.poll_interval_min, schedule.llm_daily_budget, schedule.thesis_daily_budget, schedule.enabled)}>Edit</Button>
                </div>
              </article>
            ))}
          </div>
        ) : <p className="mt-3 text-[11px] text-muted">No schedules recorded yet. Create one below — the first schedule makes its source scraper-managed in the Sources view.</p>}
        {message ? <p className={`mt-2 text-[10px] ${messageIsError ? 'text-red-600' : 'text-muted'}`} role={messageIsError ? 'alert' : 'status'}>{message}</p> : null}
      </PanelCard>

      <PanelCard title={editingSite ? `Edit schedule — ${editingSite}` : 'Create schedule'} subtitle="Interval presets follow the plan's tiers · budgets default to 15 LLM deep-dives and 3 theses per day" collapsible={false} bodyClassName="narrative-card-body">
        <form className="space-y-2" onSubmit={(event) => void submitSchedule(event)} data-testid="schedule-form">
          <input className="w-full" aria-label="Site ID" placeholder="Site ID (e.g. alpaca-news)" value={editingSite ?? siteId} disabled={Boolean(editingSite)} onChange={(event) => setSiteId(event.target.value)} required />
          <label className="block text-[10px] text-muted">Interval preset
            <select className="w-full" aria-label="Interval preset" value={preset} onChange={(event) => { setPreset(event.target.value); setIntervalMin(event.target.value) }} data-testid="schedule-preset">
              {INTERVAL_PRESETS.map((option) => <option key={option.minutes + option.label} value={option.minutes}>{option.label}</option>)}
            </select>
          </label>
          <label className="block text-[10px] text-muted">Custom interval (minutes)
            <input className="w-full" aria-label="Poll interval (minutes)" type="number" min={1} value={intervalMin} onChange={(event) => { setIntervalMin(event.target.value); setPreset('custom') }} data-testid="schedule-interval" />
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-[10px] text-muted">LLM daily budget<input className="w-full" aria-label="LLM daily budget" type="number" min={0} value={llmBudget} onChange={(event) => setLlmBudget(event.target.value)} data-testid="schedule-llm-budget" /></label>
            <label className="block text-[10px] text-muted">Thesis daily budget<input className="w-full" aria-label="Thesis daily budget" type="number" min={0} value={thesisBudget} onChange={(event) => setThesisBudget(event.target.value)} data-testid="schedule-thesis-budget" /></label>
          </div>
          <label className="flex items-center gap-2 text-[11px] text-muted"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} data-testid="schedule-enabled" /> Enabled</label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy} data-testid="schedule-save">{busy ? 'Saving…' : editingSite ? 'Update schedule' : 'Create schedule'}</Button>
            {editingSite ? <Button type="button" size="sm" variant="ghost" onClick={() => { setEditingSite(null); setSiteId('') }}>Cancel edit</Button> : null}
          </div>
        </form>
      </PanelCard>

      <PanelCard title="Backload" subtitle="Backload a source — 90 days by default, 180 max · dry-run first, then run, resume from the last day" collapsible={false} bodyClassName="narrative-card-body">
        <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void backload(false) }} data-testid="backload-form">
          <input className="w-full" aria-label="Backload site ID" placeholder="Site ID (blank = all enabled sites)" value={backloadSite} onChange={(event) => setBackloadSite(event.target.value)} data-testid="backload-site" />
          <label className="block text-[10px] text-muted">Days of history (max 180)
            <input className="w-full" aria-label="Backload days" type="number" min={1} max={180} value={backloadDays} onChange={(event) => setBackloadDays(event.target.value)} data-testid="backload-days" />
          </label>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="outline" disabled={backloadBusy} onClick={() => void backload(true)} data-testid="backload-dry-run">{backloadBusy ? 'Working…' : 'Dry run'}</Button>
            <Button type="submit" size="sm" disabled={backloadBusy} data-testid="backload-run">{backloadBusy ? 'Working…' : 'Run backload'}</Button>
          </div>
          {backloadResult ? <p className="text-[10px] text-muted" role="status" data-testid="backload-result">{backloadResult}</p> : null}
        </form>
      </PanelCard>
    </div>
  )
}
