// Product templates are fetched once per session and cached — the UI renders forms, term
// sheets, blotter columns and event dialogs from them (no product-specific UI code paths).
import { useEffect, useState } from 'react'
import { tradeRepo } from './api'
import type { FieldDef, ProductSummary, ProductTemplate } from './types'

const cache = new Map<string, Promise<ProductTemplate>>()
let listCache: Promise<{ items: ProductSummary[] }> | null = null

export function getProduct(id: string, version?: number): Promise<ProductTemplate> {
  const key = `${id}@${version ?? 'latest'}`
  if (!cache.has(key)) cache.set(key, tradeRepo.call<ProductTemplate>('tr_product_get', { id, version }).catch((e) => { cache.delete(key); throw e }))
  return cache.get(key)!
}
export function listProducts() {
  listCache ??= tradeRepo.call<{ items: ProductSummary[] }>('tr_product_list').catch((e) => { listCache = null; throw e })
  return listCache
}
export function resetProductCache() { cache.clear(); listCache = null }

export function useProducts() {
  const [items, setItems] = useState<ProductSummary[]>([])
  const [templates, setTemplates] = useState<ProductTemplate[]>([])
  useEffect(() => {
    let live = true
    listProducts().then(async (l) => {
      const latest = [...new Map(l.items.map((p) => [p.id, p])).values()]
      const ts = await Promise.all(latest.map((p) => getProduct(p.id)))
      if (live) { setItems(latest); setTemplates(ts) }
    }).catch(() => {})
    return () => { live = false }
  }, [])
  return { items, templates }
}

export function useProduct(id: string | undefined, version?: number) {
  const [tpl, setTpl] = useState<ProductTemplate | null>(null)
  const [error, setError] = useState<unknown>(null)
  useEffect(() => {
    if (!id) return
    let live = true
    getProduct(id, version).then((t) => { if (live) setTpl(t) }).catch((e) => { if (live) setError(e) })
    return () => { live = false }
  }, [id, version])
  return { tpl, error }
}

export function fieldByPath(tpl: ProductTemplate, path: string): FieldDef | undefined {
  return tpl.terms.fields.find((f) => f.path === path)
}

/** Nested get/set on plain objects by dotted path. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getIn(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setIn<T extends Record<string, any>>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.')
  const root = structuredClone(obj ?? {}) as T
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let o: any = root
  for (const k of keys.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k] }
  if (value === undefined) delete o[keys.at(-1)!]; else o[keys.at(-1)!] = value
  return root
}

/** Seed terms with the template's declared defaults (generic). */
export function defaultTerms(tpl: ProductTemplate): Record<string, unknown> {
  let t: Record<string, unknown> = {}
  for (const f of tpl.terms.fields) if (f.default !== undefined) t = setIn(t, f.path, f.default)
  return t
}

export const pctStr = (x: unknown) => (typeof x === 'number' ? `${Math.round(x * 1e6) / 1e4}%` : '—')
