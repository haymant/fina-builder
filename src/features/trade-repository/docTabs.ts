// IDE-style document tabs for the trade repository: open trades (optionally pinned to a
// version), with pin, close, dirty (unsaved amend draft) markers; persisted in localStorage.
import type { TradeInput } from './types'

export interface DocTab {
  id: string
  tradeId: string
  /** Explicit version; undefined = follow latest. */
  version?: number
  pinned: boolean
  draft?: Partial<TradeInput>
  draftReason?: string
}
export interface TabsState { tabs: DocTab[]; active: string }
export const HOME = 'home'
const KEY = 'fina.trade-repo.tabs.v1'

export const tabId = (tradeId: string, version?: number) => (version ? `${tradeId}@v${version}` : tradeId)
export const tabLabel = (t: DocTab) => (t.version ? `${t.tradeId} · v${t.version}` : t.tradeId)

export function loadTabs(storage: Pick<Storage, 'getItem'> = localStorage): TabsState {
  try {
    const s = JSON.parse(storage.getItem(KEY) ?? 'null') as TabsState | null
    if (s && Array.isArray(s.tabs)) return { tabs: s.tabs.filter((t) => t && t.tradeId), active: s.tabs.some((t) => t.id === s.active) ? s.active : HOME }
  } catch { /* ignore */ }
  return { tabs: [], active: HOME }
}
export function saveTabs(s: TabsState, storage: Pick<Storage, 'setItem'> = localStorage) {
  try { storage.setItem(KEY, JSON.stringify(s)) } catch { /* optional */ }
}

/** Pinned tabs sort first (stable), like IDEs. */
const order = (tabs: DocTab[]) => [...tabs.filter((t) => t.pinned), ...tabs.filter((t) => !t.pinned)]

export function openTab(s: TabsState, tradeId: string, version?: number): TabsState {
  const id = tabId(tradeId, version)
  if (s.tabs.some((t) => t.id === id)) return { ...s, active: id }
  return { tabs: order([...s.tabs, { id, tradeId, version, pinned: false }]), active: id }
}
export function closeTab(s: TabsState, id: string): TabsState {
  const idx = s.tabs.findIndex((t) => t.id === id)
  if (idx < 0) return s
  const tabs = s.tabs.filter((t) => t.id !== id)
  const active = s.active !== id ? s.active : (tabs[idx] ?? tabs[idx - 1])?.id ?? HOME
  return { tabs, active }
}
export function closeOthers(s: TabsState, keep: string): TabsState {
  const tabs = s.tabs.filter((t) => t.id === keep || t.pinned || t.draft)
  return { tabs, active: tabs.some((t) => t.id === s.active) ? s.active : keep }
}
export function togglePin(s: TabsState, id: string): TabsState {
  return { ...s, tabs: order(s.tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t))) }
}
export function setVersion(s: TabsState, id: string, version?: number): TabsState {
  const t = s.tabs.find((x) => x.id === id)
  if (!t) return s
  const nid = tabId(t.tradeId, version)
  if (nid !== id && s.tabs.some((x) => x.id === nid)) return { ...closeTab(s, id), active: nid }
  return { tabs: s.tabs.map((x) => (x.id === id ? { ...x, id: nid, version } : x)), active: s.active === id ? nid : s.active }
}
export function setDraft(s: TabsState, id: string, draft?: Partial<TradeInput>, reason?: string): TabsState {
  return { ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, draft, draftReason: reason } : t)) }
}
export function cycle(s: TabsState, dir: 1 | -1): TabsState {
  const ids = [HOME, ...s.tabs.map((t) => t.id)]
  const i = ids.indexOf(s.active)
  return { ...s, active: ids[(i + dir + ids.length) % ids.length]! }
}
