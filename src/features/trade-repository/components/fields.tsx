// Generic field renderer for product-template field descriptors (terms and event params).
// One code path for every product: types map to inputs; percent fields edit in % units.
import { Minus, Plus } from 'lucide-react'
import type { FieldDef, FieldIssue, Reference } from '../types'
import { getIn, setIn } from '../products'
import { FieldErrors } from './common'

export const testIdFor = (prefix: string, path: string) => `${prefix}-${path.replace(/[.[\]]+/g, '-').replace(/-$/, '')}`
const labelOf = (f: FieldDef) => f.label ?? f.path.split('.').at(-1)!.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())

interface Props {
  fields: FieldDef[]
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  issues: FieldIssue[]
  /** Error-path prefix, e.g. 'terms' or 'params'. */
  base: string
  /** data-testid prefix, e.g. 't' for terms, 'p' for params. */
  tid: string
  reference?: Reference
  changed?: (path: string) => boolean
  disabled?: (path: string) => boolean
}

export function TemplateFields(props: Props) {
  return <>{props.fields.map((f) => <Field key={f.path} f={f} {...props} />)}</>
}

function Field({ f, value, onChange, issues, base, tid, reference, changed, disabled }: Props & { f: FieldDef }) {
  const v = getIn(value, f.path)
  const errPath = `${base}.${f.path}`
  const set = (x: unknown) => onChange(setIn(value, f.path, x))
  const cls = `tr-input ${changed?.(f.path) ? 'tr-changed' : ''}`
  const common = { 'data-testid': testIdFor(tid, f.path), 'aria-invalid': issues.some((i) => i.path === errPath), disabled: disabled?.(f.path), name: f.path }
  let control: React.ReactNode
  switch (f.type) {
    case 'boolean':
      control = <input type="checkbox" {...common} checked={!!v} onChange={(e) => set(e.target.checked)} />
      break
    case 'enum':
      control = <select {...common} className={`control-select w-full ${changed?.(f.path) ? 'tr-changed' : ''}`} value={(v as string) ?? ''} onChange={(e) => set(e.target.value || undefined)}><option value="">—</option>{(f.values ?? []).map((o) => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}</select>
      break
    case 'ref': {
      const opts = f.ref === 'book' ? (reference?.books ?? []).map((b) => [b.bookId, `${b.bookId} — ${b.name}`]) : (reference?.parties ?? []).map((p) => [p.partyId, `${p.name} (${p.partyId})`])
      control = <select {...common} className="control-select w-full" value={(v as string) ?? ''} onChange={(e) => set(e.target.value || undefined)}><option value="">—</option>{opts.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      break
    }
    case 'percent':
      control = <div className="tr-suffix"><input type="number" step="0.01" {...common} className={cls} value={typeof v === 'number' ? Math.round(v * 1e8) / 1e6 : ''} onChange={(e) => set(e.target.value === '' ? undefined : Number(e.target.value) / 100)} /><span>%</span></div>
      break
    case 'number': case 'integer':
      control = <input type="number" step={f.type === 'integer' ? 1 : 'any'} {...common} className={cls} value={typeof v === 'number' ? v : ''} onChange={(e) => set(e.target.value === '' ? undefined : Number(e.target.value))} />
      break
    case 'date':
      control = <input type="date" {...common} className={cls} value={(v as string) ?? ''} onChange={(e) => set(e.target.value || undefined)} />
      break
    case 'map': {
      const keys = f.keys ?? Object.keys((v as object) ?? {})
      control = (
        <div className="tr-map" data-testid={testIdFor(tid, f.path)}>
          {keys.map((k) => (
            <label key={k} className="flex items-center gap-2 text-xs"><span className="w-20 font-mono">{k}</span>
              <input type="number" step="any" data-testid={testIdFor(tid, `${f.path}.${k}`)} className="tr-input" value={(getIn(v, k) as number) ?? ''} onChange={(e) => set({ ...((v as object) ?? {}), [k]: e.target.value === '' ? undefined : Number(e.target.value) })} />
            </label>
          ))}
        </div>
      )
      break
    }
    case 'array': {
      const rows = (Array.isArray(v) ? v : []) as Record<string, unknown>[]
      const cols = f.items ?? []
      control = (
        <div className="tr-array" data-testid={testIdFor(tid, f.path)}>
          <table className="tr-table">
            <thead><tr>{cols.map((c) => <th key={c.path}>{labelOf(c)}{c.required ? ' *' : ''}</th>)}<th /></tr></thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c.path}>
                      <input type={c.type === 'number' || c.type === 'percent' || c.type === 'integer' ? 'number' : 'text'} step="any"
                        data-testid={testIdFor(tid, `${f.path}.${i}.${c.path}`)} className={`tr-input ${issues.some((x) => x.path === `${errPath}[${i}].${c.path}`) ? 'tr-invalid' : ''}`}
                        value={(row?.[c.path] as string | number | undefined) ?? ''}
                        onChange={(e) => { const next = rows.slice(); next[i] = { ...row, [c.path]: c.type === 'string' ? e.target.value.toUpperCase() === e.target.value || c.path !== 'symbol' ? e.target.value : e.target.value.toUpperCase() : e.target.value === '' ? undefined : Number(e.target.value) }; set(next) }} />
                      <FieldErrors issues={issues} path={`${errPath}[${i}].${c.path}`} />
                    </td>
                  ))}
                  <td><button type="button" className="icon-button" aria-label="Remove row" data-testid={testIdFor(tid, `${f.path}.${i}.remove`)} disabled={f.minItems !== undefined && rows.length <= f.minItems} onClick={() => set(rows.filter((_, k) => k !== i))}><Minus size={12} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {f.maxItems === undefined || rows.length < f.maxItems ? <button type="button" className="add-tile-button tr-sm mt-1" data-testid={testIdFor(tid, `${f.path}.add`)} onClick={() => set([...rows, {}])}><Plus size={12} /> Add</button> : null}
        </div>
      )
      break
    }
    default:
      control = <input type="text" {...common} className={cls} value={(v as string) ?? ''} onChange={(e) => set(e.target.value || undefined)} />
  }
  return (
    <label className={`tr-field ${f.type === 'array' || f.type === 'map' ? 'tr-field-wide' : ''} ${f.type === 'boolean' ? 'tr-field-check' : ''}`} title={f.help}>
      <span>{labelOf(f)}{f.required ? ' *' : ''}</span>
      {control}
      <FieldErrors issues={issues} path={errPath} />
    </label>
  )
}
