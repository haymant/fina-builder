// tac-engine → riga-flow mapping (§6.3, §6.6).
//
// The effective market (raw fetch + manipulations) is mapped onto the
// `riga-flow` market inputs. `riga-flow` is 2-factor only, so the first two
// resolved symbols/pairs are used; anything else stays visible in the
// workbench but is not priced (§6.4).

import type { RigaImpliedVolGrid, RigaMarketSnapshot } from '../riga/types'
import type { TacMarketRaw, TacVolSurface } from './types'

/** Approximate continuous dividend yield from the corporate-action feed. */
export function dividendYield(symbol: string, spot: number, raw: TacMarketRaw): number | null {
  const dividends = raw.corporateActions.filter(
    (action) => action.type === 'dividend' && action.symbol.toUpperCase() === symbol.toUpperCase(),
  )
  if (dividends.length === 0 || spot <= 0) return null
  const total = dividends.reduce((sum, action) => sum + action.amount, 0)
  return total / spot
}

/** Flat ATM vol for the front maturity of a surface (the `vols[]` scalar). */
export function atmScalar(surface: TacVolSurface | undefined): number | null {
  if (!surface || surface.volatility.length === 0) return null
  const front = surface.volatility[0]!
  if (front.length === 0) return null
  const mid = front[Math.floor(front.length / 2)]!
  return Number.isFinite(mid) ? mid : null
}

/**
 * Map the effective tac-engine market onto a `RigaMarketSnapshot`.
 * Falls back to `base` for any field the fetch does not cover.
 */
export function effectiveRigaMarket(base: RigaMarketSnapshot, raw: TacMarketRaw): RigaMarketSnapshot {
  const symbols = Object.keys(raw.snapshots ?? {})
  if (symbols.length === 0) return base
  const snapshots = raw.snapshots ?? {}
  const corporateActions = raw.corporateActions ?? []
  const volSurfaces = raw.volSurfaces ?? {}
  const spots = base.spots.map((value, index) => snapshots[symbols[index]!]?.price ?? value)
  const dividendYields = base.dividendYields.map((value, index) => {
    const symbol = symbols[index]
    if (!symbol) return value
    const yieldFromActions = dividendYield(symbol, spots[index] ?? 0, { ...raw, corporateActions })
    return yieldFromActions ?? value
  })
  const vols = base.vols.map((value, index) => {
    const symbol = symbols[index]
    if (!symbol) return value
    return atmScalar(volSurfaces[symbol]) ?? value
  })
  const correlation =
    raw.correlations && raw.correlations.matrix?.length === 2
      ? raw.correlations.matrix
      : base.correlation
  const rate = raw.curve?.pillars?.[0]?.rate ?? base.riskFreeRate
  const asOf = snapshots[symbols[0]!]?.asOf ?? base.asOf
  return { asOf, spots, vols, riskFreeRate: rate, dividendYields, correlation }
}

/** Convert a tac-engine vol surface into a riga-flow implied-vol grid. */
export function toImpliedVolGrid(
  surface: TacVolSurface,
  maturitiesYears: number[],
): RigaImpliedVolGrid {
  return {
    maturitiesYears,
    strikes: surface.strikes.slice(),
    vols: surface.volatility.map((row) => row.slice()),
  }
}
