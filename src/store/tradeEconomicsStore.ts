import { create } from 'zustand'

export type TradeEconomics = { strike: number; knockInBarrier: number; knockOutBarrier: number; couponLowerBarrier: number; couponUpperBarrier: number; couponRate: number; memoryCouponEnabled: boolean; physicalSettlementEnabled: boolean; maturityYears: number; notional: number }
export type PresetName = 'Base Case' | 'Defensive Phoenix' | 'Aggressive Yield' | 'Deep Barrier' | 'High Coupon' | 'Capital Protected'
export const DEFAULT_TRADE_ECONOMICS: TradeEconomics = { strike: 1, knockInBarrier: .6, knockOutBarrier: 1, couponLowerBarrier: .7, couponUpperBarrier: 1.2, couponRate: .12, memoryCouponEnabled: true, physicalSettlementEnabled: true, maturityYears: 5, notional: 100 }
export const TRADE_PRESETS: Record<PresetName, TradeEconomics> = {
  'Base Case': DEFAULT_TRADE_ECONOMICS,
  'Defensive Phoenix': { ...DEFAULT_TRADE_ECONOMICS, knockInBarrier: .5, knockOutBarrier: .95, couponRate: .09 },
  'Aggressive Yield': { ...DEFAULT_TRADE_ECONOMICS, knockInBarrier: .7, knockOutBarrier: 1.1, couponRate: .18 },
  'Deep Barrier': { ...DEFAULT_TRADE_ECONOMICS, knockInBarrier: .4, knockOutBarrier: 1.15, couponRate: .08 },
  'High Coupon': { ...DEFAULT_TRADE_ECONOMICS, couponRate: .18, couponLowerBarrier: .8, knockInBarrier: .65 },
  'Capital Protected': { ...DEFAULT_TRADE_ECONOMICS, knockInBarrier: .3, couponRate: .06, physicalSettlementEnabled: false },
}

type TradeState = TradeEconomics & { sensitivityMode: boolean; updateEconomics: (patch: Partial<TradeEconomics>) => void; applyPreset: (preset: PresetName) => void; resetEconomics: () => void; toggleSensitivity: () => void }
function load(): Partial<TradeState> { try { return JSON.parse(localStorage.getItem('fina-trade-economics') ?? '{}') as Partial<TradeState> } catch { return {} } }
const saved = typeof window !== 'undefined' ? load() : {}
function persist(state: TradeState) { try { localStorage.setItem('fina-trade-economics', JSON.stringify({ strike: state.strike, knockInBarrier: state.knockInBarrier, knockOutBarrier: state.knockOutBarrier, couponLowerBarrier: state.couponLowerBarrier, couponUpperBarrier: state.couponUpperBarrier, couponRate: state.couponRate, memoryCouponEnabled: state.memoryCouponEnabled, physicalSettlementEnabled: state.physicalSettlementEnabled, maturityYears: state.maturityYears, notional: state.notional, sensitivityMode: state.sensitivityMode })) } catch { /* optional persistence */ } }
export const useTradeEconomicsStore = create<TradeState>((set, get) => ({ ...DEFAULT_TRADE_ECONOMICS, ...saved, sensitivityMode: saved.sensitivityMode ?? false, updateEconomics: (patch) => { set(patch); persist({ ...get(), ...patch }) }, applyPreset: (preset) => { const next = TRADE_PRESETS[preset]; set(next); persist({ ...get(), ...next }) }, resetEconomics: () => { set(DEFAULT_TRADE_ECONOMICS); persist({ ...get(), ...DEFAULT_TRADE_ECONOMICS }) }, toggleSensitivity: () => { const sensitivityMode = !get().sensitivityMode; set({ sensitivityMode }); persist({ ...get(), sensitivityMode }) } }))

export function deriveTradeAnalytics(economics: TradeEconomics) {
  const kiProbability = Math.max(4, Math.min(55, 22.1 + (economics.knockInBarrier - .6) * 62 + (economics.strike - 1) * 12))
  const koProbability = Math.max(25, Math.min(85, 65 - (economics.knockOutBarrier - 1) * 42 - (economics.knockInBarrier - .6) * 8))
  const couponPv = 11.6 * (economics.couponRate / .12) * (economics.memoryCouponEnabled ? 1.05 : .9) * (economics.maturityYears / 5)
  const putPv = 7.2 + (economics.knockInBarrier - .6) * 34 + (economics.strike - 1) * 18
  const redemption = economics.notional * (economics.physicalSettlementEnabled ? 1 : .985)
  const expectedPv = redemption + couponPv - putPv - (economics.knockOutBarrier - 1) * 12 - kiProbability * .08
  return { expectedPv: +expectedPv.toFixed(2), couponPv: +couponPv.toFixed(2), putPv: +putPv.toFixed(2), redemption: +redemption.toFixed(2), kiProbability: +kiProbability.toFixed(1), koProbability: +koProbability.toFixed(1), ciWidth: +(0.43 * Math.sqrt(100000 / 100000)).toFixed(2) }
}
export function economicsSnapshot() { const s = useTradeEconomicsStore.getState(); return { strike: s.strike, knockInBarrier: s.knockInBarrier, knockOutBarrier: s.knockOutBarrier, couponLowerBarrier: s.couponLowerBarrier, couponUpperBarrier: s.couponUpperBarrier, couponRate: s.couponRate, memoryCouponEnabled: s.memoryCouponEnabled, physicalSettlementEnabled: s.physicalSettlementEnabled, maturityYears: s.maturityYears, notional: s.notional } }
