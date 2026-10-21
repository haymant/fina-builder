// Saved blotter views (user preference, not business data) persisted in localStorage.
export interface BlotterView {
  id: string
  name: string
  builtin?: boolean
  filter: { text?: string; statuses?: string[]; productTypes?: string[]; bookIds?: string[] }
  hiddenColumns: string[]
  groupBy: string | null
}

const KEY = 'fina.trade-repo.views.v1'

export const BUILTIN_VIEWS: BlotterView[] = [
  { id: 'all', name: 'All trades', builtin: true, filter: {}, hiddenColumns: [], groupBy: null },
  { id: 'live', name: 'Live only', builtin: true, filter: { statuses: ['LIVE'] }, hiddenColumns: [], groupBy: null },
  { id: 'by-book', name: 'Live by book', builtin: true, filter: { statuses: ['LIVE'] }, hiddenColumns: ['legalEntityId'], groupBy: 'bookId' },
  { id: 'rates', name: 'Rates desk', builtin: true, filter: { productTypes: ['IRS'] }, hiddenColumns: ['strike', 'optionType'], groupBy: null },
]

export function loadViews(storage: Pick<Storage, 'getItem'> = localStorage): BlotterView[] {
  try {
    const user = JSON.parse(storage.getItem(KEY) ?? '[]') as BlotterView[]
    return [...BUILTIN_VIEWS, ...user.filter((v) => v && v.id && !v.builtin)]
  } catch {
    return BUILTIN_VIEWS
  }
}

export function saveView(view: BlotterView, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): BlotterView[] {
  const user = loadViews(storage).filter((v) => !v.builtin && v.id !== view.id)
  const next = [...user, { ...view, builtin: false }]
  storage.setItem(KEY, JSON.stringify(next))
  return [...BUILTIN_VIEWS, ...next]
}

export function deleteView(id: string, storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): BlotterView[] {
  const user = loadViews(storage).filter((v) => !v.builtin && v.id !== id)
  storage.setItem(KEY, JSON.stringify(user))
  return [...BUILTIN_VIEWS, ...user]
}

/** Client-side grouping for the community ag-grid (row grouping is an enterprise feature). */
export interface GroupRow { __group: true; groupKey: string; groupField: string; count: number; netNotional: number; expanded: boolean }
export function groupRows<T extends Record<string, unknown>>(rows: T[], field: string | null, expanded: Set<string>): (T | GroupRow)[] {
  if (!field) return rows
  const groups = new Map<string, T[]>()
  for (const r of rows) {
    const k = String(r[field] ?? '—')
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(r)
  }
  const out: (T | GroupRow)[] = []
  for (const [k, items] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const net = items.reduce((s, t) => s + (t.side === 'SELL' ? -1 : 1) * Number(t.notional ?? 0), 0)
    out.push({ __group: true, groupKey: k, groupField: field, count: items.length, netNotional: net, expanded: expanded.has(k) })
    if (expanded.has(k)) out.push(...items)
  }
  return out
}
