// finap-style tabular form with a heuristic layout, generated from JSON:
//  - an object's primitive fields render as tabular Field | Value cells in a
//    `.fina-form-grid` (1 / 6 / 12 columns by container width);
//  - a field whose value is a nested object or array renders as a separate
//    collapsible card (recursing), never as a cell;
//  - every card is collapse/expand-able from its header.
// Cells reuse the deep-form's built-in renderers, so inputs stay consistent.

import { useId, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { builtInRenderers, humanizeKey, isContainer } from '../../../components/deep-form'
import type { DeepFormRendererProps } from '../../../components/deep-form'
import { cn } from '../../../lib/utils'

export type TabularLabels = Record<string, string>

export function getAtPointer(root: unknown, pointer: string): unknown {
  return pointer
    .split('/')
    .filter(Boolean)
    .reduce<unknown>(
      (acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]),
      root,
    )
}

function leafLabel(labels: TabularLabels | undefined, path: string, fallback: string): string {
  return labels?.[path] ?? humanizeKey(fallback)
}

function inferRenderer(value: unknown): keyof typeof builtInRenderers {
  if (typeof value === 'boolean') return 'switch'
  if (typeof value === 'number') return 'number-input'
  return 'text-input'
}

/** Last visible cell of a row spans the remaining 6/12 columns. */
function fillSpan(index: number, size: number): Record<string, number> {
  const medium = size - (index % 6)
  const large = size - (index % 12)
  return {
    '--fina-form-small-span': 1,
    '--fina-form-medium-span': medium <= 0 ? 6 : medium,
    '--fina-form-large-span': large <= 0 ? 12 : large,
  }
}

function Cell({
  path,
  label,
  value,
  last,
  size,
  onChange,
}: {
  path: string
  label: string
  value: unknown
  last: boolean
  size: number
  onChange: (pointer: string, next: unknown) => void
}) {
  const id = useId()
  const Renderer = builtInRenderers[inferRenderer(value)] ?? builtInRenderers['text-input']!
  const props: DeepFormRendererProps = {
    id,
    path,
    segments: path.split('/').filter(Boolean),
    value,
    label,
    readOnly: false,
    invalid: false,
    onChange: (next) => onChange(path, next),
  }
  return (
    <div
      data-tabular-path={path}
      style={last ? fillSpan(size - 1, size) : undefined}
      className={cn(
        'min-w-0 border-border/70 border-r border-b px-3 py-2 align-top',
        last && 'fina-form-fill-right',
      )}
    >
      <label htmlFor={id} className="block text-[10px] font-medium text-muted-foreground">
        {label}
      </label>
      <div className="mt-1">
        <Renderer {...props} />
      </div>
    </div>
  )
}

function Grid({
  entries,
  basePath,
  labels,
  onChange,
}: {
  entries: Array<[string, unknown]>
  basePath: string
  labels?: TabularLabels
  onChange: (pointer: string, next: unknown) => void
}) {
  return (
    <div className="fina-form-grid overflow-hidden rounded-lg border border-border">
      {entries.map(([key, value], index) => {
        const path = `${basePath}/${key}`
        return (
          <Cell
            key={key}
            path={path}
            label={labels?.[path] ?? humanizeKey(key)}
            value={value}
            last={index === entries.length - 1}
            size={entries.length}
            onChange={onChange}
          />
        )
      })}
    </div>
  )
}

/** Collapsible card used for every nested object / array (and array item). */
export function CollapsibleCard({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string
  summary?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <section className="overflow-hidden rounded-lg border border-border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((previous) => !previous)}
        className="flex w-full items-center gap-2 bg-muted/40 px-3 py-1.5 text-left hover:bg-muted/60"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
          {title}
        </span>
        {summary != null && summary !== 0 ? (
          <span className="shrink-0 rounded border border-border px-1.5 text-[10px] text-muted-foreground">
            {summary}
          </span>
        ) : null}
      </button>
      {open ? <div id={id} className="p-2">{children}</div> : null}
    </section>
  )
}

function ObjectBlock({
  path,
  value,
  labels,
  onChange,
  depth,
  openDepth,
}: {
  path: string
  value: Record<string, unknown>
  labels?: TabularLabels
  onChange: (pointer: string, next: unknown) => void
  depth: number
  openDepth: number
}) {
  const entries = Object.entries(value)
  const flat = entries.filter(([, child]) => !isContainer(child))
  const nested = entries.filter(([, child]) => isContainer(child))
  return (
    <div className="space-y-2">
      {flat.length > 0 && <Grid entries={flat} basePath={path} labels={labels} onChange={onChange} />}
      {nested.map(([key, child]) => {
        const childPath = `${path}/${key}`
        const summary = Array.isArray(child) ? child.length : Object.keys(child as object).length
        return (
          <CollapsibleCard
            key={key}
            title={leafLabel(labels, childPath, key)}
            summary={summary}
            defaultOpen={!key.endsWith('raw') && depth < openDepth}
          >
            {Array.isArray(child) ? (
              <ArrayBlock
                path={childPath}
                items={child}
                labels={labels}
                onChange={onChange}
                depth={depth + 1}
                openDepth={openDepth}
              />
            ) : (
              <ObjectBlock
                path={childPath}
                value={child as Record<string, unknown>}
                labels={labels}
                onChange={onChange}
                depth={depth + 1}
                openDepth={openDepth}
              />
            )}
          </CollapsibleCard>
        )
      })}
      {flat.length === 0 && nested.length === 0 && (
        <p className="px-1 text-muted-foreground text-xs">Empty.</p>
      )}
    </div>
  )
}

function ArrayBlock({
  path,
  items,
  labels,
  onChange,
  depth,
  openDepth,
}: {
  path: string
  items: unknown[]
  labels?: TabularLabels
  onChange: (pointer: string, next: unknown) => void
  depth: number
  openDepth: number
}) {
  if (items.length === 0) return <p className="px-1 text-muted-foreground text-xs">No items.</p>

  // Array of primitives -> a tabular grid of value cells.
  if (items.every((item) => !isContainer(item))) {
    return (
      <Grid
        entries={items.map((item, index) => [String(index), item])}
        basePath={path}
        labels={labels}
        onChange={onChange}
      />
    )
  }

  // Array of objects/arrays -> a collapsible card per item.
  return (
    <div className="space-y-2">
      {items.map((item, index) => {
        const itemPath = `${path}/${index}`
        const summary = Array.isArray(item) ? item.length : isContainer(item) ? Object.keys(item as object).length : 0
        return (
          <CollapsibleCard
            key={index}
            title={leafLabel(labels, itemPath, `#${index + 1}`)}
            summary={summary}
            defaultOpen={depth < openDepth}
          >
            {Array.isArray(item) ? (
              <ArrayBlock
                path={itemPath}
                items={item}
                labels={labels}
                onChange={onChange}
                depth={depth + 1}
                openDepth={openDepth}
              />
            ) : (
              <ObjectBlock
                path={itemPath}
                value={item as Record<string, unknown>}
                labels={labels}
                onChange={onChange}
                depth={depth + 1}
                openDepth={openDepth}
              />
            )}
          </CollapsibleCard>
        )
      })}
    </div>
  )
}

export function TabularForm({
  value,
  onChange,
  labels,
  pathPrefix = '',
  defaultOpenDepth = 3,
  className,
}: {
  value: Record<string, unknown>
  onChange: (pointer: string, next: unknown) => void
  labels?: TabularLabels
  /** Prefix emitted pointers when `value` is a sub-object of the real document. */
  pathPrefix?: string
  /** How many card levels to expand on first render. */
  defaultOpenDepth?: number
  className?: string
}) {
  return (
    <div className={cn('fina-form-container w-full', className)}>
      <ObjectBlock
        path={pathPrefix}
        value={value}
        labels={labels}
        onChange={onChange}
        depth={0}
        openDepth={defaultOpenDepth}
      />
    </div>
  )
}
