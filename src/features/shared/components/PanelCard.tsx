import clsx from 'clsx'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { memo, useState } from 'react'

interface PanelCardProps {
  title: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  /** Collapse the body from the header. Default true. */
  collapsible?: boolean
  defaultCollapsed?: boolean
}

export const PanelCard = memo(function PanelCard({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
  collapsible = true,
  defaultCollapsed = false,
}: PanelCardProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  // Body scrolls vertically by default; a caller that sets its own `overflow-*`
  // keeps it (avoids the overflow-hidden/overflow-auto precedence surprise).
  const scroll = bodyClassName && /(^|\s)overflow-/.test(bodyClassName) ? '' : 'overflow-y-auto'
  const open = !collapsible || !collapsed

  return (
    <section
      className={clsx(
        'flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-sm',
        className,
      )}
    >
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-line px-3 py-2">
        {collapsible ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setCollapsed((previous) => !previous)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            {open ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted" />
            )}
            <span className="min-w-0">
              <span className="block truncate text-xs font-semibold tracking-wide text-main uppercase">
                {title}
              </span>
              {subtitle ? <span className="block truncate text-[11px] text-muted">{subtitle}</span> : null}
            </span>
          </button>
        ) : (
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xs font-semibold tracking-wide text-main uppercase">{title}</h2>
            {subtitle ? <p className="truncate text-[11px] text-muted">{subtitle}</p> : null}
          </div>
        )}
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      {open ? (
        <div className={clsx('min-h-0 flex-1 text-main', scroll, bodyClassName)}>{children}</div>
      ) : null}
    </section>
  )
})
