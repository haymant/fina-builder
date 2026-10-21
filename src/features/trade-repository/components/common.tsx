import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community'
import { AlertTriangle, Inbox, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { TradeRepoApiError } from '../api'

ModuleRegistry.registerModules([AllCommunityModule])

// ag-grid theme bound to the app's design tokens so light/dark follow the workspace theme.
export const gridTheme = themeQuartz.withParams({
  backgroundColor: 'var(--theme-panel)',
  foregroundColor: 'var(--theme-text)',
  headerBackgroundColor: 'var(--theme-background)',
  borderColor: 'var(--theme-grid)',
  accentColor: 'var(--theme-primary)',
  rowHoverColor: 'color-mix(in oklab, var(--theme-primary) 8%, transparent)',
  selectedRowBackgroundColor: 'color-mix(in oklab, var(--theme-primary) 16%, transparent)',
  fontFamily: 'var(--font-sans)',
  fontSize: 12,
  headerFontSize: 11,
  rowHeight: 30,
  headerHeight: 32,
  spacing: 5,
  wrapperBorderRadius: 6,
})

const STATUS_TONE: Record<string, string> = {
  LIVE: 'tr-badge-success', CANCELLED: 'tr-badge-danger', TERMINATED: 'tr-badge-muted', EXERCISED: 'tr-badge-info', MATURED: 'tr-badge-muted', NOVATED: 'tr-badge-warning',
  OPEN: 'tr-badge-danger', INVESTIGATING: 'tr-badge-warning', RESOLVED: 'tr-badge-success', WAIVED: 'tr-badge-muted',
  OK: 'tr-badge-success', ERROR: 'tr-badge-danger', ECONOMIC: 'tr-badge-warning', NON_ECONOMIC: 'tr-badge-info',
}

export function Badge({ value, testId }: { value: string; testId?: string }) {
  return <span data-testid={testId} className={`tr-badge ${STATUS_TONE[value] ?? 'tr-badge-muted'}`}>{value.replace(/_/g, ' ')}</span>
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="tr-state" data-testid="tr-empty">
      <Inbox size={22} className="text-muted" />
      <p className="text-sm font-semibold text-main">{title}</p>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      {action}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = error instanceof TradeRepoApiError ? error : null
  return (
    <div className="tr-state" role="alert" data-testid="tr-error">
      <AlertTriangle size={22} className="text-danger" />
      <p className="text-sm font-semibold text-main">{e?.code === 'UNAVAILABLE' ? 'Trade repository unavailable' : 'Something went wrong'}</p>
      <p className="max-w-md text-xs text-muted">{(error as Error)?.message}</p>
      {e?.code === 'UNAVAILABLE' ? <code className="tr-code">npm run mcp:http:trade-repo</code> : null}
      {e?.correlationId ? <p className="text-[10px] text-muted">Correlation id: {e.correlationId}</p> : null}
      {onRetry ? <button type="button" className="add-tile-button" onClick={onRetry}><RefreshCw size={13} /> Retry</button> : null}
    </div>
  )
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="tr-state" data-testid="tr-loading" aria-busy="true">
      <Loader2 size={20} className="animate-spin text-primary" />
      <p className="text-xs text-muted">{label}</p>
    </div>
  )
}

export function FieldErrors({ issues, path }: { issues: { path: string; message: string }[]; path: string }) {
  const mine = issues.filter((i) => i.path === path)
  if (!mine.length) return null
  return <p className="tr-field-error" data-testid={`err-${path}`}>{mine.map((i) => i.message).join('; ')}</p>
}

export function Modal({ title, eyebrow, onClose, children, footer, testId, wide }: { title: string; eyebrow?: string; onClose: () => void; children: ReactNode; footer?: ReactNode; testId?: string; wide?: boolean }) {
  // Escape closes the dialog wherever focus is; the latest onClose is kept in a ref.
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose }, [onClose])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); close.current() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div role="dialog" aria-label={title} data-testid={testId} className={`tr-modal ${wide ? 'tr-modal-wide' : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div>
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            <h2 className="text-sm font-semibold text-main">{title}</h2>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="Close">×</button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-line px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  )
}

export const fmtTs = (s?: string | null) => (s ? s.replace('T', ' ').slice(0, 19) + 'Z' : '—')
