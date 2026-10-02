import clsx from 'clsx'
import { memo } from 'react'

interface StatsBadgeProps {
  label: string
  value: string | number
  tone?: 'default' | 'primary' | 'success' | 'danger' | 'warning'
}

const tones: Record<NonNullable<StatsBadgeProps['tone']>, string> = {
  default: 'border-slate-600 bg-slate-800/80 text-slate-200',
  primary: 'border-primary/40 bg-primary/10 text-primary',
  success: 'border-success/40 bg-success/10 text-success',
  danger: 'border-danger/40 bg-danger/10 text-danger',
  warning: 'border-warning/40 bg-warning/10 text-warning',
}

export const StatsBadge = memo(function StatsBadge({
  label,
  value,
  tone = 'default',
}: StatsBadgeProps) {
  return (
    <div
      className={clsx(
        'inline-flex min-w-[72px] flex-col rounded border px-2 py-1',
        tones[tone],
      )}
    >
      <span className="text-[9px] tracking-wider text-muted uppercase">{label}</span>
      <span className="font-mono text-xs font-semibold tabular-nums">{value}</span>
    </div>
  )
})
