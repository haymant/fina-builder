// tac-engine → riga-flow mapping (§6.3, §6.6).
//
// The effective market (raw fetch + manipulations) is mapped onto the
// `riga-flow` market inputs. `riga-flow` is 2-factor only, so the first two
// resolved symbols/pairs are used; anything else stays visible in the
// workbench but is not priced (§6.4).

import type { RigaImpliedVolGrid, RigaMarketSnapshot } from '../riga/types'
import type { TacMarketRaw, TacVolSurface } from './types'

// tac-engine quotes `vol_surface.maturities` as Excel serial dates (days since
// 1899-12-30), while `riga-flow` measures tenors in years from the valuation
// date — its fixture loader does `(maturity - as_of) / 365`. Every maturity
// crosses that boundary here so the two engines agree on units.
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30)
const MS_PER_DAY = 86_400_000
const DAYS_PER_YEAR = 365
const AXIS_EPSILON = 1e-9

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

/** The symbols the effective market is keyed on, in pricing order. */
export function tacSymbols(raw: TacMarketRaw): string[] {
  return Object.keys(raw.snapshots ?? {})
}

/**
 * Convert one tac-engine maturity (Excel serial date or ISO date string) to
 * years from `asOf`. Returns `null` when it cannot be parsed or is not after
 * the valuation date.
 */
export function maturityYears(maturity: string | number, asOf: string): number | null {
  const asOfMs = Date.parse(asOf)
  if (Number.isNaN(asOfMs)) return null
  const maturityMs =
    typeof maturity === 'number' ? EXCEL_EPOCH_MS + maturity * MS_PER_DAY : Date.parse(maturity)
  if (Number.isNaN(maturityMs)) return null
  const years = (maturityMs - asOfMs) / (MS_PER_DAY * DAYS_PER_YEAR)
  return years > 0 ? years : null
}

/**
 * Convert a tac-engine vol surface into a riga-flow `ImpliedVolGrid` — the
 * input to the Dupire local-vol calibration.
 *
 * - maturities become years anchored at `asOf` (riga-flow's convention),
 * - relative surfaces are struck against their calibration reference because
 *   riga-flow wants **absolute** strikes,
 * - both axes are sorted and de-duplicated because riga-flow requires them to
 *   be strictly increasing.
 *
 * Returns `null` when the surface has no usable grid.
 */
export function surfaceToImpliedVolGrid(
  surface: TacVolSurface | undefined,
  asOf: string,
): RigaImpliedVolGrid | null {
  if (!surface || surface.strikes.length === 0 || surface.maturities.length === 0) return null
  const rows = surface.volatility ?? []
  const relative = surface.strikeType === 'relative' && Number.isFinite(surface.reference)

  // Columns: absolute, finite, strictly-increasing strikes. Keep the source
  // column index so each vol row is re-ordered with them.
  const columns = surface.strikes
    .map((strike, index) => ({ strike: relative ? strike * surface.reference : strike, index }))
    .filter((entry) => Number.isFinite(entry.strike) && entry.strike > 0)
    .sort((a, b) => a.strike - b.strike)
  const ordered: Array<{ strike: number; index: number }> = []
  for (const entry of columns) {
    const last = ordered[ordered.length - 1]
    if (last && entry.strike <= last.strike + AXIS_EPSILON) continue
    ordered.push(entry)
  }
  if (ordered.length === 0) return null

  // Rows: future maturities, in years, strictly increasing.
  const tenor: Array<{ years: number; vols: number[] }> = []
  for (let r = 0; r < Math.min(rows.length, surface.maturities.length); r++) {
    const years = maturityYears(surface.maturities[r]!, asOf)
    const vols = rows[r]
    if (years === null || !vols || vols.length !== surface.strikes.length) continue
    tenor.push({ years, vols })
  }
  tenor.sort((a, b) => a.years - b.years)
  const kept: Array<{ years: number; vols: number[] }> = []
  for (const row of tenor) {
    const last = kept[kept.length - 1]
    if (last && row.years <= last.years + AXIS_EPSILON) continue
    kept.push(row)
  }
  if (kept.length === 0) return null

  return {
    maturitiesYears: kept.map((row) => row.years),
    strikes: ordered.map((entry) => entry.strike),
    vols: kept.map((row) => ordered.map((entry) => row.vols[entry.index]!)),
  }
}

/**
 * One Dupire grid per factor, built from the effective tac vol surfaces, or
 * `null` unless *every* factor has a usable surface — riga-flow requires
 * `local_vol.grids.len() === market.spots.len()`.
 */
export function localVolGridsFromTac(raw: TacMarketRaw, asOf: string): RigaImpliedVolGrid[] | null {
  const symbols = tacSymbols(raw)
  if (symbols.length === 0) return null
  const grids: RigaImpliedVolGrid[] = []
  for (const symbol of symbols) {
    const grid = surfaceToImpliedVolGrid(raw.volSurfaces?.[symbol], asOf)
    if (!grid) return null
    grids.push(grid)
  }
  return grids
}

/**
 * Map the effective tac-engine market onto a `RigaMarketSnapshot`.
 * Falls back to `base` for any field the fetch does not cover.
 */
export function effectiveRigaMarket(base: RigaMarketSnapshot, raw: TacMarketRaw): RigaMarketSnapshot {
  const symbols = tacSymbols(raw)
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
