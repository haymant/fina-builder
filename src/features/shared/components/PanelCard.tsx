import clsx from 'clsx'
import type { ReactNode } from 'react'
import { memo } from 'react'

interface PanelCardProps {
  title: string
  subtitle?: string
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}

export const PanelCard = memo(function PanelCard({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
}: PanelCardProps) {
  return (
    <section
      className={clsx(
        'flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-panel shadow-lg shadow-black/20',
        className,
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-line px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-xs font-semibold tracking-wide text-main uppercase">
            {title}
          </h2>
          {subtitle ? (
            <p className="truncate text-[11px] text-muted">{subtitle}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      <div className={clsx('min-h-0 flex-1 overflow-hidden text-main', bodyClassName)}>{children}</div>
    </section>
  )
})
