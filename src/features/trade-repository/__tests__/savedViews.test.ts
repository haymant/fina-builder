import { describe, expect, it } from 'vitest'
import { BUILTIN_VIEWS, deleteView, groupRows, loadViews, saveView } from '../savedViews'

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } }

describe('saved views', () => {
  it('returns builtins, persists, updates and deletes user views', () => {
    const s = mem()
    expect(loadViews(s)).toEqual(BUILTIN_VIEWS)
    saveView({ id: 'v1', name: 'Mine', filter: { statuses: ['LIVE'] }, hiddenColumns: ['uti'], groupBy: 'bookId' }, s)
    saveView({ id: 'v1', name: 'Renamed', filter: {}, hiddenColumns: [], groupBy: null }, s)
    const views = loadViews(s)
    expect(views.filter((v) => !v.builtin)).toEqual([{ id: 'v1', name: 'Renamed', filter: {}, hiddenColumns: [], groupBy: null, builtin: false }])
    expect(deleteView('v1', s)).toEqual(BUILTIN_VIEWS)
  })
  it('survives corrupt storage', () => {
    expect(loadViews({ getItem: () => '{not json' })).toEqual(BUILTIN_VIEWS)
  })
})

describe('groupRows', () => {
  const rows = [
    { tradeId: 'A', bookId: 'B1', side: 'BUY', notional: 10 },
    { tradeId: 'B', bookId: 'B1', side: 'SELL', notional: 4 },
    { tradeId: 'C', bookId: 'B0', side: 'BUY', notional: 1 },
  ]
  it('passes rows through without a group field', () => expect(groupRows(rows, null, new Set())).toBe(rows))
  it('emits sorted group headers with signed net and expands on demand', () => {
    const g = groupRows(rows, 'bookId', new Set(['B1']))
    expect(g.map((r) => ('__group' in r ? `g:${r.groupKey}:${r.count}:${r.netNotional}` : r.tradeId))).toEqual(['g:B0:1:1', 'g:B1:2:6', 'A', 'B'])
  })
})
