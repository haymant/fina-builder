// Simulation data store: the bundle arrives from the backend, exactly once.
//
// `simulationStore` replaces the module-level `simulationBundle` singleton from
// `mock-data/generatePaths.ts` (PHASE1_MIGRATION_PROMPT.md §5d.2): the bundle is
// no longer computed in the browser; it is fetched from fina-kernel via the
// active transport.

import { create } from 'zustand'
import { fina } from '../api'
import type { SimulationBundle, SimulationConfig } from '../api/types'

/** The config that reproduces `golden.json`: seed 42, 100 paths, 60 months. */
export const DEFAULT_SIMULATION_CONFIG: SimulationConfig = {
  seed: 42,
  pathCount: 100,
  observations: 60,
  startDate: '2024-01-15',
  barriers: {
    kiBarrier: 0.7,
    koBarrier: 1,
    couponLower: 0.75,
    couponUpper: 1,
    couponRate: 0.008,
    notional: 100,
  },
}

export type SimulationStatus = 'idle' | 'loading' | 'ready' | 'error'

interface SimulationState {
  status: SimulationStatus
  bundle: SimulationBundle | null
  error: string | null
  selectedPathIndex: number
  load: () => Promise<void>
  nextPath: (d: 1 | -1) => void
  randomPath: () => void
  selectPath: (i: number) => void
}

export const useSimulationStore = create<SimulationState>((set, get) => ({
  status: 'idle',
  bundle: null,
  error: null,
  selectedPathIndex: 0,

  /** Idempotent: no duplicate in-flight call. Called once from `App.tsx`. */
  load: async () => {
    if (get().status === 'loading') return
    set({ status: 'loading', error: null })
    try {
      // `generate_paths` is the streaming command: its Tauri channel is
      // required, so it must go through `generatePaths` (which supplies one).
      // Progress is ignored here; under HTTP this uses the SSE endpoint.
      const bundle = (await fina.generatePaths(
        { config: DEFAULT_SIMULATION_CONFIG },
        () => {},
      )) as SimulationBundle
      set({ status: 'ready', bundle })
    } catch (e) {
      const message = (e as { message?: string }).message ?? String(e)
      set({ status: 'error', error: message })
    }
  },

  nextPath: (d) => {
    const bundle = get().bundle
    if (!bundle || bundle.paths.length === 0) return // no throw while loading
    const next =
      (get().selectedPathIndex + d + bundle.paths.length) % bundle.paths.length
    set({ selectedPathIndex: next })
  },

  randomPath: () => {
    const bundle = get().bundle
    if (!bundle || bundle.paths.length === 0) return
    const pick = Math.floor(Math.random() * bundle.paths.length)
    set({ selectedPathIndex: pick })
  },

  selectPath: (i) => set({ selectedPathIndex: i }),
}))

/** The currently generated paths, empty while the bundle loads. */
export function simulationStorePaths() {
  return useSimulationStore.getState().bundle?.paths ?? []
}

/** The currently selected path, or null while the bundle is loading. */
export function useSelectedSimulationPath() {
  const bundle = useSimulationStore((s) => s.bundle)
  const index = useSimulationStore((s) => s.selectedPathIndex)
  return bundle?.paths.at(index) ?? null
}