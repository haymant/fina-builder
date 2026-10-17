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

/**
 * Remember the editor a field resolved to while it held a value, so clearing a
 * numeric field (value -> null) keeps a numeric input instead of flipping to a
 * text input (which is what let stray strings reach the engine).
 */
const rendererMemory = new Map<string, keyof typeof builtInRenderers>()

function resolveRendererName(path: string, value: unknown): keyof typeof builtInRenderers {
  if (value !== null && value !== undefined) {
    const inferred = inferRenderer(value)
    rendererMemory.set(path, inferred)
    return inferred
  }
  return rendererMemory.get(path) ?? 'text-input'
}

/** A numeric field may only ever emit a finite number, or null (cleared). */
function coerceCellValue(next: unknown): unknown {
  if (typeof next !== 'string') return next
  const trimmed = next.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  // Promote numeric-looking input to a number so a stray string can never reach
  // a numeric engine field (e.g. typing "0.6" - or a value that was cleared and
  // re-typed - stays a number); genuine strings (symbols, dates, ids) pass through.
  return Number.isFinite(parsed) ? parsed : next
}

/** `raw` blocks are verbatim source provenance — shown, never edited. */
function isRawPath(path: string): boolean {
  return path.split('/').includes('raw')
}

function Cell({
  path,
  label,
  value,
  onChange,
}: {
  path: string
  label: string
  value: unknown
  onChange: (pointer: string, next: unknown) => void
}) {
  const id = useId()
  const readOnly = isRawPath(path)
  const rendererName = readOnly ? 'readonly' : resolveRendererName(path, value)
  const Renderer = builtInRenderers[rendererName] ?? builtInRenderers['text-input']!
  const props: DeepFormRendererProps = {
    id,
    path,
    segments: path.split('/').filter(Boolean),
    value,
    label,
    readOnly,
    invalid: false,
    onChange: (next) => onChange(path, coerceCellValue(next)),
  }
  return (
    <div
      data-tabular-path={path}
      className="min-w-0 border-border/70 border-r border-b px-3 py-2 align-top"
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
      {entries.map(([key, value]) => {
        const path = `${basePath}/${key}`
        return (
          <Cell
            key={key}
            path={path}
            label={labels?.[path] ?? humanizeKey(key)}
            value={value}
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

  // Primitives (and any null/mixed entries) render as tabular cells; containers
  // render as a collapsible card each. A mixed array is split accordingly.
  const indexed = items.map((item, index) => [String(index), item] as [string, unknown])
  const primitives = indexed.filter(([, item]) => !isContainer(item))
  const containers = indexed.filter(([, item]) => isContainer(item))

  return (
    <div className="space-y-2">
      {primitives.length > 0 && (
        <Grid entries={primitives} basePath={path} labels={labels} onChange={onChange} />
      )}
      {containers.map(([key, item]) => {
        const itemPath = `${path}/${key}`
        const summary = Array.isArray(item) ? item.length : Object.keys(item as object).length
        return (
          <CollapsibleCard
            key={key}
            title={leafLabel(labels, itemPath, `#${key}`)}
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
    <div className={cn('w-full', className)}>
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
