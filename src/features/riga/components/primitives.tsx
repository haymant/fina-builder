// Shared presentation primitives for the riga-flow / tac-engine tiles.
//
// Every tile shows a defined loading state, a defined error state, and a
// defined empty state (trace off / source unavailable) — never a crash, never
// fake numbers (house rules §2). Provenance (tool name + run/snapshot id) is
// rendered in the footer of every riga tile.

import type { ReactNode } from 'react'
import type { AsyncState } from '../../../hooks/useAsync'
import { PanelCard } from '../../shared/components/PanelCard'
import { PanelError, PanelLoading } from '../../shared/components/AsyncPanel'
import type { useTheme } from '../../themes/ThemeProvider'

type ReturnTypeTheme = ReturnType<typeof useTheme>['tokens']

export function chartBase(tokens: ReturnTypeTheme): Record<string, unknown> {
  return {
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'axis',
      backgroundColor: tokens.panel,
      borderColor: tokens.border,
      textStyle: { color: tokens.text, fontSize: 11 },
    },
    grid: { left: 48, right: 18, top: 28, bottom: 34 },
    xAxis: {
      axisLabel: { color: tokens.muted, fontSize: 9 },
      axisLine: { lineStyle: { color: tokens.border } },
    },
    yAxis: {
      axisLabel: { color: tokens.muted, fontSize: 9 },
      splitLine: { lineStyle: { color: tokens.grid } },
    },
  }
}

/** Live-data provenance strip. */
export function Provenance({ tool, runId }: { tool: string; runId?: string }) {
  return (
    <div className="flex items-center justify-between border-t border-line/60 px-3 py-1 text-[9px] text-muted">
      <span className="font-mono">{tool}</span>
      {runId ? <span className="truncate font-mono">run {runId}</span> : null}
    </div>
  )
}

/** A static reference formula, visually distinct from live data (§5.4). */
export function FormulaTag({ children }: { children: ReactNode }) {
  return (
    <div className="rounded border border-dashed border-warning/50 bg-warning/5 px-2 py-1">
      <span className="mr-1 rounded bg-warning/20 px-1 text-[8px] font-semibold tracking-wide text-warning uppercase">
        formula (static)
      </span>
      <code className="font-mono text-[10px] text-main">{children}</code>
    </div>
  )
}

export function EmptyTile({
  title,
  subtitle,
  message,
  actions,
}: {
  title: string
  subtitle?: string
  message: string
  actions?: ReactNode
}) {
  return (
    <PanelCard title={title} subtitle={subtitle} className="h-full" actions={actions}>
      <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center">
        <div className="rounded border border-line bg-surface px-2 py-1 text-[9px] font-semibold tracking-wide text-muted uppercase">
          no data
        </div>
        <p className="max-w-[22rem] text-xs text-muted">{message}</p>
      </div>
    </PanelCard>
  )
}

export interface RigaPanelProps<T> {
  title: string
  subtitle?: string
  tool: string
  runId?: string
  state: AsyncState<T>
  /** Render the empty state instead of the loader (trace off / not configured). */
  empty?: string | null
  actions?: ReactNode
  className?: string
  bodyClassName?: string
  children: (data: T) => ReactNode
}

/** Loading / error / empty / ready shell shared by nearly every new tile. */
export function RigaPanel<T>({
  title,
  subtitle,
  tool,
  runId,
  state,
  empty,
  actions,
  className,
  bodyClassName,
  children,
}: RigaPanelProps<T>) {
  if (empty) return <EmptyTile title={title} subtitle={subtitle} message={empty} actions={actions} />
  if (state.status === 'error') {
    return <PanelError title={title} subtitle={subtitle} error={state.error} onRetry={state.refresh} />
  }
  if (!state.data) return <PanelLoading title={title} subtitle={subtitle} />
  return (
    <PanelCard
      title={title}
      subtitle={subtitle}
      className={`h-full ${className ?? ''}`}
      actions={actions}
      bodyClassName={bodyClassName}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-auto text-main">{children(state.data)}</div>
        <Provenance tool={tool} runId={runId} />
      </div>
    </PanelCard>
  )
}

export function Kpi({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  const toneClass =
    tone === 'primary'
      ? 'text-primary'
      : tone === 'success'
        ? 'text-success'
        : tone === 'danger'
          ? 'text-danger'
          : tone === 'warning'
            ? 'text-warning'
            : 'text-main'
  const testId = `kpi-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`
  return (
    <div data-testid={testId} className="rounded border border-line bg-surface px-2 py-1">
      <div className="text-[9px] tracking-wide text-muted uppercase">{label}</div>
      <div data-testid="kpi-value" className={`font-mono text-xs font-semibold tabular-nums ${toneClass}`}>{value}</div>
    </div>
  )
}

export interface Column<Row> {
  key: string
  label: string
  render?: (row: Row, index: number) => ReactNode
}

export function DataTable<Row>({
  columns,
  rows,
  empty = 'No rows',
  onRowClick,
}: {
  columns: Array<Column<Row>>
  rows: Row[]
  empty?: string
  onRowClick?: (row: Row, index: number) => void
}) {
  if (rows.length === 0) return <div className="p-3 text-xs text-muted">{empty}</div>
  return (
    <table className="w-full text-left text-[10px] text-main">
      <thead className="sticky top-0 bg-panel text-muted">
        <tr>
          {columns.map((column) => (
            <th key={column.key} className="px-2 py-1.5 font-semibold whitespace-nowrap">
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr
            key={index}
            className={`border-t border-line/60 ${onRowClick ? 'cursor-pointer hover:bg-surface' : ''}`}
            onClick={onRowClick ? () => onRowClick(row, index) : undefined}
          >
            {columns.map((column) => (
              <td key={column.key} className="px-2 py-1.5 align-top">
                {column.render ? column.render(row, index) : String((row as Record<string, unknown>)[column.key] ?? '')}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function num(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toFixed(digits)
}

/**
 * Path identity in either shape the engine returns: nested
 * (`PathRecord.identity.{path_id,…}` from `query_path_cube`/`replay_path`) or
 * flat (`sampled_paths[].{path_id,…}` from `export_governance_evidence`).
 */
export function pathIdentity(row: unknown): { pathId: unknown; rngSeed: unknown; sobolIndex: unknown } {
  const record = (row ?? {}) as Record<string, unknown>
  const nested = (record.identity ?? record) as Record<string, unknown>
  return {
    pathId: nested.pathId ?? nested.path_id ?? record.pathId ?? record.path_id,
    rngSeed: nested.rngSeed ?? nested.rng_seed ?? record.rngSeed ?? record.rng_seed,
    sobolIndex: nested.sobolIndex ?? nested.sobol_index ?? record.sobolIndex ?? record.sobol_index,
  }
}

export function pct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}
