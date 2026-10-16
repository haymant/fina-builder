// Trace-level / observability selector (§10). The UI level is authoritative for
// what the user sees; it also sets `SimulationConfig.trace_level`. Persisted to
// the new `fina-observability` key (§9.4).

import { create } from 'zustand'
import type { RigaTraceLevel } from '../features/riga/types'

/** UI level → the `trace_level` sent in `SimulationConfig`. */
export const LEVEL_TO_TRACE: Record<ObservabilityLevel, RigaTraceLevel> = {
  off: 'off',
  sampled: 'sampled',
  full: 'full',
}

export type ObservabilityLevel = 'off' | 'sampled' | 'full'

const KEY = 'fina-observability'

function load(): { level?: ObservabilityLevel } {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as { level?: ObservabilityLevel }
  } catch {
    return {}
  }
}

const saved = typeof window !== 'undefined' ? load() : {}

type ObservabilityState = {
  level: ObservabilityLevel
  setLevel: (level: ObservabilityLevel) => void
}

export const useObservabilityStore = create<ObservabilityState>((set) => ({
  level: saved.level ?? 'sampled',
  setLevel: (level) => {
    set({ level })
    try {
      localStorage.setItem(KEY, JSON.stringify({ level }))
    } catch {
      /* optional */
    }
  },
}))

/** The `trace_level` to send with the current UI level. */
export function currentTraceLevel(): RigaTraceLevel {
  return LEVEL_TO_TRACE[useObservabilityStore.getState().level]
}

/** Path-dependent UI (switcher / timeline / token tape) is available at or above this level. */
export function pathUiAvailable(level: ObservabilityLevel = useObservabilityStore.getState().level): boolean {
  return level !== 'off'
}

/** The optional tools each UI level may call (§10.2). */
export function levelAllows(tool: string, level: ObservabilityLevel = useObservabilityStore.getState().level): boolean {
  if (level === 'off') return !OFF_TOOLS.has(tool)
  return true
}

const OFF_TOOLS = new Set([
  'execution_events',
  'get_path',
  'replay_path',
  'query_path_cube',
  'export_governance_evidence',
  'pl_explain',
  'valuation_explain',
  'root_cause',
])
