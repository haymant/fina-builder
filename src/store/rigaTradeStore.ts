// riga-flow trade economics input (§6.2). A new key (`fina-riga-trade`); the
// demo `fina-trade-economics` store is untouched (I-6).
//
// The field set is exactly `RigaPhoenixTrade` — the only product `riga-flow`
// prices today. `price_trade` remains the authority on validity: an invalid
// combination is rejected with a structured `{code,message}` and surfaced by
// the panel, never re-validated in the UI.

import { create } from 'zustand'
import type { RigaPhoenixTrade } from '../features/riga/types'

const KEY = 'fina-riga-trade'

/** Defaults derived from the pinned `termsheet1` fixture. */
export const DEFAULT_RIGA_TRADE: RigaPhoenixTrade = {
  tradeId: 'termsheet1',
  initialSpots: [239.97, 260.0],
  maturityYears: 0.75,
  steps: 9,
  strike: 1.0,
  knockInBarrier: 0.7,
  knockOutBarrier: 1.1,
  couponBarrier: 0.1,
  couponRate: 0.009642,
  memoryCoupon: true,
  couponPeriods: 9,
  fixedFirstCoupon: true,
  callStartStep: 1,
}

export const RIGA_TRADE_PRESETS: Record<string, RigaPhoenixTrade> = {
  'Termsheet 1': DEFAULT_RIGA_TRADE,
  'Defensive Phoenix': { ...DEFAULT_RIGA_TRADE, knockInBarrier: 0.6, knockOutBarrier: 1.05, couponRate: 0.008 },
  'Aggressive Yield': { ...DEFAULT_RIGA_TRADE, knockInBarrier: 0.8, knockOutBarrier: 1.15, couponRate: 0.015 },
  'No Memory': { ...DEFAULT_RIGA_TRADE, memoryCoupon: false, couponBarrier: 0.9 },
}

function load(): { trade?: RigaPhoenixTrade } {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as { trade?: RigaPhoenixTrade }
  } catch {
    return {}
  }
}

const saved = typeof window !== 'undefined' ? load() : {}

type RigaTradeState = {
  trade: RigaPhoenixTrade
  updateTrade: (patch: Partial<RigaPhoenixTrade>) => void
  applyPreset: (name: string) => void
  resetTrade: () => void
}

function persist(trade: RigaPhoenixTrade) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ trade }))
  } catch {
    /* optional */
  }
}

export const useRigaTradeStore = create<RigaTradeState>((set, get) => ({
  trade: saved.trade ?? DEFAULT_RIGA_TRADE,
  updateTrade: (patch) => {
    const trade = { ...get().trade, ...patch }
    set({ trade })
    persist(trade)
  },
  applyPreset: (name) => {
    const trade = RIGA_TRADE_PRESETS[name]
    if (!trade) return
    set({ trade })
    persist(trade)
  },
  resetTrade: () => {
    set({ trade: DEFAULT_RIGA_TRADE })
    persist(DEFAULT_RIGA_TRADE)
  },
}))

export function rigaTradeSnapshot(): RigaPhoenixTrade {
  return useRigaTradeStore.getState().trade
}
