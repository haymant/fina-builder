// Trade economics INPUTS and presets only.
//
// §5d.3: the domain derivation `deriveTradeAnalytics` no longer lives in the
// browser — the `useTradeAnalytics` hook fetches it from fina-kernel. This
// store keeps exactly what is input: the editable trade terms, the six
// presets, their `fina-trade-economics` localStorage persistence, and
// `economicsSnapshot()` for the workspace.

import { create } from 'zustand'
import type { TradeEconomics } from '../api/types'

export type PresetName =
  | 'Base Case'
  | 'Defensive Phoenix'
  | 'Aggressive Yield'
  | 'Deep Barrier'
  | 'High Coupon'
  | 'Capital Protected'

export const DEFAULT_TRADE_ECONOMICS: TradeEconomics = {
  strike: 1,
  knockInBarrier: 0.6,
  knockOutBarrier: 1,
  couponLowerBarrier: 0.7,
  couponUpperBarrier: 1.2,
  couponRate: 0.12,
  memoryCouponEnabled: true,
  physicalSettlementEnabled: true,
  maturityYears: 5,
  notional: 100,
}

export const TRADE_PRESETS: Record<PresetName, TradeEconomics> = {
  'Base Case': DEFAULT_TRADE_ECONOMICS,
  'Defensive Phoenix': { ...DEFAULT_TRADE_ECONOMICS, knockInBarrier: 0.5, knockOutBarrier: 0.95, couponRate: 0.09 },
  'Aggressive Yield': { ...DEFAULT_TRADE_ECONOMICS, knockInBarrier: 0.7, knockOutBarrier: 1.1, couponRate: 0.18 },
  'Deep Barrier': { ...DEFAULT_TRADE_ECONOMICS, knockInBarrier: 0.4, knockOutBarrier: 1.15, couponRate: 0.08 },
  'High Coupon': { ...DEFAULT_TRADE_ECONOMICS, couponRate: 0.18, couponLowerBarrier: 0.8, knockInBarrier: 0.65 },
  'Capital Protected': { ...DEFAULT_TRADE_ECONOMICS, knockInBarrier: 0.3, couponRate: 0.06, physicalSettlementEnabled: false },
}

type TradeState = TradeEconomics & {
  sensitivityMode: boolean
  updateEconomics: (patch: Partial<TradeEconomics>) => void
  applyPreset: (preset: PresetName) => void
  resetEconomics: () => void
  toggleSensitivity: () => void
}

function load(): Partial<TradeState> {
  try {
    return JSON.parse(localStorage.getItem('fina-trade-economics') ?? '{}') as Partial<TradeState>
  } catch {
    return {}
  }
}

const saved = typeof window !== 'undefined' ? load() : {}

function persist(state: TradeState) {
  try {
    localStorage.setItem(
      'fina-trade-economics',
      JSON.stringify({
        strike: state.strike,
        knockInBarrier: state.knockInBarrier,
        knockOutBarrier: state.knockOutBarrier,
        couponLowerBarrier: state.couponLowerBarrier,
        couponUpperBarrier: state.couponUpperBarrier,
        couponRate: state.couponRate,
        memoryCouponEnabled: state.memoryCouponEnabled,
        physicalSettlementEnabled: state.physicalSettlementEnabled,
        maturityYears: state.maturityYears,
        notional: state.notional,
        sensitivityMode: state.sensitivityMode,
      }),
    )
  } catch {
    /* persistence is optional */
  }
}

export const useTradeEconomicsStore = create<TradeState>((set, get) => ({
  ...DEFAULT_TRADE_ECONOMICS,
  ...saved,
  sensitivityMode: saved.sensitivityMode ?? false,
  updateEconomics: (patch) => {
    set(patch)
    persist({ ...get(), ...patch })
  },
  applyPreset: (preset) => {
    const next = TRADE_PRESETS[preset]
    set(next)
    persist({ ...get(), ...next })
  },
  resetEconomics: () => {
    set(DEFAULT_TRADE_ECONOMICS)
    persist({ ...get(), ...DEFAULT_TRADE_ECONOMICS })
  },
  toggleSensitivity: () => {
    const sensitivityMode = !get().sensitivityMode
    set({ sensitivityMode })
    persist({ ...get(), sensitivityMode })
  },
}))

/** The trade inputs without the store's actions — what the workspace persists. */
export function economicsSnapshot(): TradeEconomics {
  const s = useTradeEconomicsStore.getState()
  return {
    strike: s.strike,
    knockInBarrier: s.knockInBarrier,
    knockOutBarrier: s.knockOutBarrier,
    couponLowerBarrier: s.couponLowerBarrier,
    couponUpperBarrier: s.couponUpperBarrier,
    couponRate: s.couponRate,
    memoryCouponEnabled: s.memoryCouponEnabled,
    physicalSettlementEnabled: s.physicalSettlementEnabled,
    maturityYears: s.maturityYears,
    notional: s.notional,
  }
}