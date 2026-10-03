// Loading / error panels for tiles whose data arrives from the backend
// (FEATURES.md §5d.5): a tile must not crash while the response
// is in flight, and it must render a compact error strip carrying the error
// message from the transport layer.

import type { ReactNode } from 'react'
import { PanelCard } from './PanelCard'

export function PanelLoading({
  title,
  subtitle,
}: {
  title: string
  subtitle?: string
}): ReactNode {
  return (
    <PanelCard title={title} subtitle={subtitle} className="h-full">
      <div className="flex h-full items-center justify-center p-3 text-xs text-muted">
        Loading…
      </div>
    </PanelCard>
  )
}

export function PanelError({
  title,
  subtitle,
  error,
  onRetry,
}: {
  title: string
  subtitle?: string
  error: string | null
  onRetry?: () => void
}): ReactNode {
  return (
    <PanelCard title={title} subtitle={subtitle} className="h-full">
      <div className="flex h-full flex-col items-start justify-center gap-2 p-3">
        <div className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[10px] font-semibold text-danger">
          ERROR
        </div>
        <div className="text-xs text-muted">{error ?? 'Unknown error'}</div>
        {onRetry ? (
          <button type="button" className="shock-button" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    </PanelCard>
  )
}