// App-level navigation model: the menu bar and the command palette are the primary way to
// reach every dashboard and every trade repository view (tabs are for documents only).
export type TradeView = 'blotter' | 'positions' | 'recon' | 'audit' | 'import' | 'fixings'

export type Location =
  | { kind: 'dashboard'; dashboardId: string }
  | { kind: 'trades'; view: TradeView }

export const TRADE_VIEWS: { id: TradeView; label: string; accel: string }[] = [
  { id: 'blotter', label: 'Blotter', accel: 'Alt+Shift+1' },
  { id: 'positions', label: 'Positions', accel: 'Alt+Shift+2' },
  { id: 'recon', label: 'Reconciliation', accel: 'Alt+Shift+3' },
  { id: 'audit', label: 'Audit log', accel: 'Alt+Shift+4' },
  { id: 'import', label: 'Bulk import', accel: 'Alt+Shift+5' },
  { id: 'fixings', label: 'Fixings', accel: 'Alt+Shift+6' },
]

const KEY = 'fina.location.v1'
export function loadLocation(): Location | null {
  try { return JSON.parse(localStorage.getItem(KEY) ?? 'null') as Location | null } catch { return null }
}
export function saveLocation(l: Location) {
  try { localStorage.setItem(KEY, JSON.stringify(l)) } catch { /* optional */ }
}

/** Platform-aware accelerator label: Ctrl on Windows/Linux, ⌘ on macOS (Tauri or browser). */
export function accelLabel(accel: string, mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)): string {
  if (!mac) return accel
  return accel.replace('Mod', '⌘').replace('Alt', '⌥').replace('Shift', '⇧').replace(/\+/g, '')
}

/** Matches a KeyboardEvent against an accelerator like `Mod+K`, `Alt+Shift+2`, `Alt+C`. Uses e.code (layout/Option-safe). */
export function matchAccel(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, accel: string, mac = false): boolean {
  const parts = accel.split('+')
  const key = parts.pop()!
  const want = { mod: parts.includes('Mod'), alt: parts.includes('Alt'), shift: parts.includes('Shift') }
  const mod = mac ? e.metaKey : e.ctrlKey
  if (want.mod !== mod || want.alt !== e.altKey || want.shift !== e.shiftKey) return false
  const code = /^\d$/.test(key) ? `Digit${key}` : /^[A-Z]$/.test(key) ? `Key${key}` : key
  return e.code === code || e.key.toLowerCase() === key.toLowerCase()
}

export const PRIMARY_TILE_COUNT = 4

/** Focus mode: the first N tiles in reading order are primary; the rest are collapsed by default. */
export function splitPrimary<T extends { i: string; x: number; y: number }>(layout: T[], n = PRIMARY_TILE_COUNT) {
  const ordered = [...layout].sort((a, b) => a.y - b.y || a.x - b.x)
  const primary = new Set(ordered.slice(0, n).map((l) => l.i))
  return { primary: layout.filter((l) => primary.has(l.i)), secondary: layout.filter((l) => !primary.has(l.i)) }
}
