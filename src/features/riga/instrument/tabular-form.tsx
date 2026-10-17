// finap-style tabular form: a container-query grid (1 / 6 / 12 columns) of
// bordered Field | Value cells, with the last cell of each row filling the
// remainder — the layout finap's `SchemaFormBlock` / `.fina-form-grid` uses.
// Cells reuse the deep-form's built-in renderers, so inputs stay consistent.

import { useId } from 'react'
import { builtInRenderers } from '../../../components/deep-form'
import type { DeepFormRendererProps } from '../../../components/deep-form'
import { cn } from '../../../lib/utils'

export interface TabularField {
  /** JSON pointer into the form root, e.g. `/meta/name` or `/market/spots/0`. */
  path: string
  label: string
  renderer?: keyof typeof builtInRenderers
  readOnly?: boolean
  /** Span the whole row (long values). */
  full?: boolean
  placeholder?: string
}

export interface TabularSection {
  title: string
  fields: TabularField[]
}

export function getAtPointer(root: unknown, pointer: string): unknown {
  return pointer
    .split('/')
    .filter(Boolean)
    .reduce<unknown>(
      (acc, key) => (acc == null ? acc : (acc as Record<string, unknown>)[key]),
      root,
    )
}

function inferRenderer(value: unknown): keyof typeof builtInRenderers {
  if (typeof value === 'boolean') return 'switch'
  if (typeof value === 'number') return 'number-input'
  return 'text-input'
}

function fillSpan(index: number, size: number): Record<string, number> {
  const medium = size - (index % 6)
  const large = size - (index % 12)
  return {
    '--fina-form-small-span': 1,
    '--fina-form-medium-span': medium <= 0 ? 6 : medium,
    '--fina-form-large-span': large <= 0 ? 12 : large,
  }
}

function FieldCell({
  field,
  value,
  last,
  size,
  onChange,
}: {
  field: TabularField
  value: unknown
  last: boolean
  size: number
  onChange: (pointer: string, next: unknown) => void
}) {
  const id = useId()
  const rendererName = field.renderer ?? inferRenderer(value)
  const Renderer = builtInRenderers[rendererName] ?? builtInRenderers['text-input']!
  const props: DeepFormRendererProps = {
    id,
    path: field.path,
    segments: field.path.split('/').filter(Boolean),
    value,
    label: field.label,
    readOnly: field.readOnly ?? false,
    invalid: false,
    placeholder: field.placeholder,
    onChange: (next) => onChange(field.path, next),
  }
  return (
    <div
      data-tabular-path={field.path}
      style={last ? (field.full ? fillSpan(0, size) : fillSpan(size - 1, size)) : undefined}
      className={cn(
        'min-w-0 border-border/70 border-r border-b px-3 py-2 align-top',
        field.full && 'col-span-full',
        last && !field.full && 'fina-form-fill-right',
      )}
    >
      <label htmlFor={id} className="block text-[10px] font-medium text-muted-foreground">
        {field.label}
      </label>
      <div className="mt-1">
        <Renderer {...props} />
      </div>
    </div>
  )
}

export function TabularForm({
  value,
  sections,
  onChange,
  className,
}: {
  value: Record<string, unknown>
  sections: TabularSection[]
  onChange: (pointer: string, next: unknown) => void
  className?: string
}) {
  return (
    <div className={cn('fina-form-container w-full overflow-hidden rounded-lg border border-border', className)}>
      {sections.map((section) => (
        <section key={section.title} className="border-border border-b last:border-b-0">
          <h4 className="border-border border-b bg-muted/40 px-3 py-1.5 font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
            {section.title}
          </h4>
          <div className="fina-form-grid">
            {section.fields.map((field, index) => (
              <FieldCell
                key={field.path}
                field={field}
                value={getAtPointer(value, field.path)}
                last={index === section.fields.length - 1}
                size={section.fields.length}
                onChange={onChange}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
