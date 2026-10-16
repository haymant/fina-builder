// tac-engine fetch layer (§3A / §6.7). Plain functions (usable outside React
// for the one-shot bootstrap) plus thin hooks. Fetches write `tacMarketStore`;
// the lake is never mutated and no mutating tool is called.

import { useEffect } from 'react'
import { tac, TacUnavailableError } from '../../api/tacTransport'
import { useTacMarketStore } from '../../store/tacMarketStore'
import { useObservabilityStore } from '../../store/observabilityStore'
import {
  toBars,
  toCorrelations,
  toCorporateActions,
  toCoverage,
  toCurve,
  toFxRates,
  toFxVol,
  toSnapshot,
  toSpSeries,
  toTaSeries,
  toVolSurface,
} from './normalize'

/** FRED tenors used to build the discount curve (T-EXT-1). */
export const FRED_TENORS = [
  'FRED_DGS3MO',
  'FRED_DGS6MO',
  'FRED_DGS1',
  'FRED_DGS2',
  'FRED_DGS5',
  'FRED_DGS10',
  'FRED_DGS30',
]

/** The default two-factor basket the workbench loads. */
export const TAC_SYMBOLS = ['ADBE', 'AMZN']

function reportError(error: unknown): string {
  if (error instanceof TacUnavailableError) return error.message
  return (error as { message?: string }).message ?? String(error)
}

async function run<T>(label: string, execute: () => Promise<T>, apply: (value: T) => void): Promise<T> {
  const store = useTacMarketStore.getState()
  store.setStatus('loading')
  try {
    const value = await execute()
    apply(value)
    useTacMarketStore.getState().setStatus('ready')
    return value
  } catch (error) {
    useTacMarketStore.getState().setStatus('error', `${label}: ${reportError(error)}`)
    throw error
  }
}

export function fetchTacBars(symbol: string, timeframe = '1d') {
  return run('get_lake_bars', () => tac.callTool<unknown>('get_lake_bars', { symbols: symbol, timeframe, lazy: true }), (value) =>
    useTacMarketStore.getState().setRaw({ bars: { ...useTacMarketStore.getState().raw.bars, ...toBars(value) } }),
  )
}

export function fetchTacSnapshot(symbol: string) {
  return run('get_stock_snapshot', () => tac.callTool<unknown>('get_stock_snapshot', { symbol }), (value) =>
    useTacMarketStore.getState().setRaw({ snapshots: { ...useTacMarketStore.getState().raw.snapshots, [symbol]: toSnapshot(symbol, value) } }),
  )
}

export function fetchTacCorrelations(legs: string[], windowDays = 252) {
  return run(
    'corr_matrix',
    () => tac.callTool<unknown>('corr_matrix', { legs: legs.join(','), window_days: windowDays }),
    (value) => {
      const correlations = toCorrelations(value)
      if (correlations) useTacMarketStore.getState().setRaw({ correlations })
    },
  )
}

export function fetchTacVolSurface(underlying: string) {
  return run('vol_surface', () => tac.callTool<unknown>('vol_surface', { underlying }), (value) => {
    const surface = toVolSurface(value)
    if (surface) useTacMarketStore.getState().setRaw({ volSurfaces: { ...useTacMarketStore.getState().raw.volSurfaces, [underlying]: surface } })
  })
}

export function fetchTacCurve(currency = 'USD') {
  return run('get_macro_bars', () => tac.callTool<unknown>('get_macro_bars', { symbols: FRED_TENORS.join(',') }), (value) => {
    const curve = toCurve(value, currency)
    if (curve) useTacMarketStore.getState().setRaw({ curve })
  })
}

export function fetchTacFx(pairs: string[]) {
  return run('get_forex_latest_rates', () => tac.callTool<unknown>('get_forex_latest_rates', { currency_pairs: pairs.join(',') }), (value) => {
    const fx = { ...useTacMarketStore.getState().raw.fx }
    for (const rate of toFxRates(value)) fx[rate.pair] = rate
    useTacMarketStore.getState().setRaw({ fx })
  })
}

export function fetchTacFxVol(pair: string) {
  return run('get_lake_fx_vol', () => tac.callTool<unknown>('get_lake_fx_vol', { pair }), (value) =>
    useTacMarketStore.getState().setRaw({ fxVol: { ...useTacMarketStore.getState().raw.fxVol, [pair]: toFxVol(value) } }),
  )
}

export function fetchTacCorporateActions(symbol: string) {
  return run('get_corporate_actions', () => tac.callTool<unknown>('get_corporate_actions', { symbols: symbol, types: 'dividend' }), (value) =>
    useTacMarketStore.getState().setRaw({ corporateActions: toCorporateActions(value) }),
  )
}

export function fetchTacCoverage() {
  return run('get_lake_coverage', () => tac.callTool<unknown>('get_lake_coverage', {}), (value) =>
    useTacMarketStore.getState().setRaw({ coverage: toCoverage(value) }),
  )
}

export function fetchTacTa(symbol: string) {
  return run('get_lake_ta', () => tac.callTool<unknown>('get_lake_ta', { symbols: symbol }), (value) => {
    const series = toTaSeries(symbol, value)
    if (series) useTacMarketStore.getState().setRaw({ ta: { ...useTacMarketStore.getState().raw.ta, [symbol]: series } })
  })
}

export function fetchTacSp(symbol: string) {
  return run('get_lake_sp', () => tac.callTool<unknown>('get_lake_sp', { symbols: symbol }), (value) => {
    const series = toSpSeries(symbol, value)
    if (series) useTacMarketStore.getState().setRaw({ sp: { ...useTacMarketStore.getState().raw.sp, [symbol]: series } })
  })
}

async function settled(label: string, promise: Promise<unknown>): Promise<void> {
  try {
    await promise
  } catch {
    // `run` already recorded the error on the store.
    void label
  }
}

/** Pull the full market update for the basket. Individual failures are tolerated. */
export async function fetchTacAll(symbols: string[] = TAC_SYMBOLS): Promise<void> {
  await Promise.all([
    ...symbols.map((symbol) => settled('bars', fetchTacBars(symbol))),
    ...symbols.map((symbol) => settled('snapshot', fetchTacSnapshot(symbol))),
    ...symbols.map((symbol) => settled('vol_surface', fetchTacVolSurface(symbol))),
    ...symbols.map((symbol) => settled('get_lake_ta', fetchTacTa(symbol))),
    ...symbols.map((symbol) => settled('get_lake_sp', fetchTacSp(symbol))),
    settled('corr_matrix', fetchTacCorrelations(symbols)),
    settled('get_macro_bars', fetchTacCurve()),
    settled('get_lake_coverage', fetchTacCoverage()),
    settled('get_forex_latest_rates', fetchTacFx(['EURUSD', 'USDJPY'])),
    settled('get_lake_fx_vol', fetchTacFxVol('EURUSD')),
    settled('get_lake_fx_vol', fetchTacFxVol('USDJPY')),
    settled('get_corporate_actions', fetchTacCorporateActions('ADBE')),
  ])
}

// ---------------------------------------------------------------------------
// Auto-bootstrap (single-flight)
// ---------------------------------------------------------------------------

let bootstrap: Promise<void> | null = null

/** Fetch the workbench data once, unless it is already loaded. */
export function ensureTacBootstrap(symbols: string[] = TAC_SYMBOLS): Promise<void> {
  const raw = useTacMarketStore.getState().raw
  if (Object.keys(raw.snapshots).length > 0 || Object.keys(raw.bars).length > 0) return Promise.resolve()
  if (!bootstrap) {
    bootstrap = fetchTacAll(symbols).catch(() => undefined).finally(() => {
      // Keep the resolved promise so a failed bootstrap is not retried in a loop.
    })
  }
  return bootstrap
}

/** Test helper: allow a fresh bootstrap. */
export function resetTacBootstrap(): void {
  bootstrap = null
}

/** Kick the one-shot bootstrap when a market-data tile mounts. */
export function useTacAutoFetch(symbols: string[] = TAC_SYMBOLS): void {
  useEffect(() => {
    void ensureTacBootstrap(symbols)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

/** Stable action set for the workbench UI. */
export function useTacActions() {
  return {
    fetchBars: fetchTacBars,
    fetchSnapshot: fetchTacSnapshot,
    fetchCorrelations: fetchTacCorrelations,
    fetchVolSurface: fetchTacVolSurface,
    fetchCurve: fetchTacCurve,
    fetchFx: fetchTacFx,
    fetchFxVol: fetchTacFxVol,
    fetchCorporateActions: fetchTacCorporateActions,
    fetchCoverage: fetchTacCoverage,
    fetchTa: fetchTacTa,
    fetchSp: fetchTacSp,
    fetchAll: fetchTacAll,
  }
}

export function useTraceLevelForTac(): string {
  return useObservabilityStore((s) => s.level)
}
