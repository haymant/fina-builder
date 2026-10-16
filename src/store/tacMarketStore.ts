// tac-engine market-data store (§6.6).
//
// `raw` is the immutable source of truth *as fetched from tac-engine*; the lake
// is never mutated. `manipulations` are in-memory overlays. The pure
// `applyManipulations` selector (features/tac/manipulations.ts) is the only
// place a manipulation is interpreted, and the effective market is what the
// riga-flow request consumes (§6.3/§6.9).

import { create } from 'zustand'
import type {
  ManipulationType,
  MarketManipulation,
  TacMarketRaw,
  TacMarketState,
} from '../features/tac/types'

const KEY = 'fina-tac-market'

export const EMPTY_TAC_RAW: TacMarketRaw = {
  bars: {},
  snapshots: {},
  volSurfaces: {},
  fx: {},
  fxVol: {},
  corporateActions: [],
  ta: {},
  sp: {},
  coverage: [],
}

type TacMarketStore = TacMarketState & {
  setRaw: (patch: Partial<TacMarketRaw>) => void
  replaceRaw: (raw: TacMarketRaw) => void
  setStatus: (status: TacMarketState['status'], error?: string | null) => void
  addManipulation: (m: MarketManipulation) => void
  updateManipulation: (index: number, m: Partial<MarketManipulation>) => void
  removeManipulation: (index: number) => void
  clearManipulations: () => void
}

function load(): Partial<Pick<TacMarketState, 'raw' | 'manipulations'>> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<
      Pick<TacMarketState, 'raw' | 'manipulations'>
    >
  } catch {
    return {}
  }
}

const saved = typeof window !== 'undefined' ? load() : {}

function persist(raw: TacMarketRaw, manipulations: MarketManipulation[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ raw, manipulations }))
  } catch {
    /* optional */
  }
}

export const useTacMarketStore = create<TacMarketStore>((set, get) => ({
  raw: saved.raw ?? EMPTY_TAC_RAW,
  manipulations: saved.manipulations ?? [],
  status: 'idle',
  error: null,
  revision: 0,
  setRaw: (patch) => {
    const raw = { ...get().raw, ...patch }
    set({ raw, revision: get().revision + 1 })
    persist(raw, get().manipulations)
  },
  replaceRaw: (raw) => {
    set({ raw, revision: get().revision + 1, status: 'ready', error: null })
    persist(raw, get().manipulations)
  },
  setStatus: (status, error = null) => set({ status, error }),
  addManipulation: (m) => {
    const manipulations = [...get().manipulations, m]
    set({ manipulations })
    persist(get().raw, manipulations)
  },
  updateManipulation: (index, m) => {
    const manipulations = get().manipulations.map((existing, i) =>
      i === index ? { ...existing, ...m } : existing,
    )
    set({ manipulations })
    persist(get().raw, manipulations)
  },
  removeManipulation: (index) => {
    const manipulations = get().manipulations.filter((_, i) => i !== index)
    set({ manipulations })
    persist(get().raw, manipulations)
  },
  clearManipulations: () => {
    set({ manipulations: [] })
    persist(get().raw, [])
  },
}))

export function tacRawSnapshot(): TacMarketRaw {
  return useTacMarketStore.getState().raw
}

export function tacManipulationSnapshot(): MarketManipulation[] {
  return useTacMarketStore.getState().manipulations
}

export type { ManipulationType }
