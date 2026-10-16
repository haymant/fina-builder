// riga-flow market-data input (§6.3). A new key (`fina-riga-market`); the demo
// `fina-market-data` store is untouched (I-6).
//
// This holds the *effective* market mapped from `tac-engine` (§6.6): the raw
// fetch lives in `tacMarketStore`, manipulations are applied by the pure
// selector, and the result is written here and sent to `riga-flow`.

import { create } from 'zustand'
import type {
  RigaImpliedVolGrid,
  RigaMarketSnapshot,
  RigaSimulationConfig,
} from '../features/riga/types'

const KEY = 'fina-riga-market'

export const DEFAULT_RIGA_MARKET: RigaMarketSnapshot = {
  asOf: '2026-09-07',
  spots: [239.97, 260.0],
  vols: [0.467214, 0.355738],
  riskFreeRate: 0.041398,
  dividendYields: [0.0, 0.002979],
  correlation: [
    [1.0, 0.4593248180905],
    [0.4593248180905, 1.0],
  ],
}

export type RigaSimulationInputs = Omit<RigaSimulationConfig, 'traceLevel'>

export const DEFAULT_RIGA_SIMULATION: RigaSimulationInputs = {
  paths: 30000,
  pathBlockSize: 4096,
  seed: 1729,
  varianceReduction: { kind: 'none' },
}

type RigaMarketState = {
  market: RigaMarketSnapshot
  localVol: RigaImpliedVolGrid | null
  simulation: RigaSimulationInputs
  updateMarket: (patch: Partial<RigaMarketSnapshot>) => void
  updateLocalVol: (grid: RigaImpliedVolGrid | null) => void
  updateSimulation: (patch: Partial<RigaSimulationInputs>) => void
  resetMarket: () => void
}

function load(): Partial<Pick<RigaMarketState, 'market' | 'localVol' | 'simulation'>> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<
      Pick<RigaMarketState, 'market' | 'localVol' | 'simulation'>
    >
  } catch {
    return {}
  }
}

const saved = typeof window !== 'undefined' ? load() : {}

function persist(state: Pick<RigaMarketState, 'market' | 'localVol' | 'simulation'>) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ market: state.market, localVol: state.localVol, simulation: state.simulation }),
    )
  } catch {
    /* optional */
  }
}

export const useRigaMarketStore = create<RigaMarketState>((set, get) => ({
  market: saved.market ?? DEFAULT_RIGA_MARKET,
  localVol: saved.localVol ?? null,
  simulation: saved.simulation ?? DEFAULT_RIGA_SIMULATION,
  updateMarket: (patch) => {
    const market = { ...get().market, ...patch }
    set({ market })
    persist({ ...get(), market })
  },
  updateLocalVol: (localVol) => {
    set({ localVol })
    persist({ ...get(), localVol })
  },
  updateSimulation: (patch) => {
    const simulation = { ...get().simulation, ...patch }
    set({ simulation })
    persist({ ...get(), simulation })
  },
  resetMarket: () => {
    set({ market: DEFAULT_RIGA_MARKET, localVol: null, simulation: DEFAULT_RIGA_SIMULATION })
    persist({ market: DEFAULT_RIGA_MARKET, localVol: null, simulation: DEFAULT_RIGA_SIMULATION })
  },
}))
