// Pure manipulation selector (§6.6/§6.9).
//
// `applyManipulations` is the **only** place a manipulation is interpreted. It
// is pure: the raw lake fetch is never mutated, and no mutating tac-engine tool
// is ever called. Correlation stays positive-definite (off-diagonals are
// shrunk until Cholesky succeeds); vol-surface manipulations that would break
// the grid return warnings instead of silently corrupting it.

import type {
  MarketManipulation,
  ManipulationType,
  TacCorrMatrix,
  TacMarketRaw,
  TacVolSurface,
} from './types'

/** Additive delta for a manipulation, honouring the basis-point convention. */
export function absoluteDelta(type: ManipulationType, value: number): number {
  // Rates and vols are quoted in basis points for `absolute`/`parallel`; spots,
  // FX and dividends are native units.
  if (type === 'interest_rate' || type === 'volatility' || type === 'fx_volatility') {
    return value / 10_000
  }
  return value
}

/** The target level for a `set` manipulation. */
export function setLevel(type: ManipulationType, value: number): number {
  if (type === 'interest_rate' || type === 'volatility' || type === 'fx_volatility') {
    return value / 10_000
  }
  return value
}

function transform(current: number, manipulation: MarketManipulation): number {
  switch (manipulation.operation) {
    case 'absolute':
    case 'parallel':
      return current + absoluteDelta(manipulation.type, manipulation.value)
    case 'relative':
      return current * (1 + manipulation.value)
    case 'set':
      return setLevel(manipulation.type, manipulation.value)
    default:
      return current
  }
}

function normalisePairKey(key: string): string {
  return key.split(/[|,]/).map((s) => s.trim().toUpperCase()).sort().join('|')
}

function matchesPair(manipulation: MarketManipulation, legA: string, legB: string): boolean {
  if (!manipulation.target || manipulation.target === '*') return true
  return normalisePairKey(manipulation.target) === normalisePairKey(`${legA}|${legB}`)
}

/** Symmetrise + shrink off-diagonals until the matrix is positive-definite. */
export function clampCorrelation(matrix: number[][]): number[][] {
  const n = matrix.length
  const out = matrix.map((row) => row.slice())
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      out[i]![j] = i === j ? 1 : Math.max(-0.999, Math.min(0.999, out[i]![j] ?? 0))
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const value = (out[i]![j]! + out[j]![i]!) / 2
      out[i]![j] = value
      out[j]![i] = value
    }
  }
  // Shrink correlation toward the identity until Cholesky succeeds.
  for (let attempt = 0; attempt < 40 && !isPositiveDefinite(out); attempt++) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j) out[i]![j] = out[i]![j]! * 0.95
      }
    }
  }
  return out
}

export function isPositiveDefinite(matrix: number[][]): boolean {
  const n = matrix.length
  const l: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = matrix[i]![j]!
      for (let k = 0; k < j; k++) sum -= l[i]![k]! * l[j]![k]!
      if (i === j) {
        if (sum <= 0) return false
        l[i]![j] = Math.sqrt(sum)
      } else {
        l[i]![j] = sum / (l[j]![j]! || Number.EPSILON)
      }
    }
  }
  return true
}

/** Non-fatal warnings for a vol surface after manipulation (§6.9). */
export function volSurfaceWarnings(surface: TacVolSurface): string[] {
  const warnings: string[] = []
  const rows = surface.volatility ?? []
  for (const row of rows) {
    for (const value of row) {
      if (!Number.isFinite(value) || value <= 0) {
        warnings.push(`${surface.underlying}: non-positive volatility ${value}`)
        return warnings
      }
    }
  }
  // Calendar check: total variance must not decrease with maturity (per strike).
  for (let col = 0; col < (surface.strikes?.length ?? 0); col++) {
    let previous = -Infinity
    for (let row = 0; row < rows.length; row++) {
      const t = maturityYears(surface, row)
      const totalVar = (rows[row]![col]! ** 2) * t
      if (totalVar < previous - 1e-9) {
        warnings.push(`${surface.underlying}: calendar-arbitrage risk at strike index ${col}`)
        break
      }
      previous = totalVar
    }
  }
  return warnings
}

function maturityYears(surface: TacVolSurface, index: number): number {
  const maturity = surface.maturities?.[index]
  if (typeof maturity === 'number') return Math.max(maturity, 1 / 365)
  if (typeof maturity === 'string') {
    const parsed = Date.parse(maturity)
    if (!Number.isNaN(parsed)) {
      const now = Date.now()
      return Math.max((parsed - now) / (365 * 24 * 3600 * 1000), 1 / 365)
    }
  }
  return (index + 1) / 12
}

function applyToVolSurface(surface: TacVolSurface, manipulation: MarketManipulation): TacVolSurface {
  const parameter = manipulation.surfaceParameter ?? 'atm'
  const strikeMid = Math.max((surface.strikes?.length ?? 1) / 2 - 0.5, 0.5)
  const lastMaturity = Math.max(surface.volatility.length - 1, 1)
  const volatility = surface.volatility.map((row, rowIndex) =>
    row.map((value, colIndex) => {
      // `atm` shifts the whole grid; `skew`/`curvature`/`term` weight the shift
      // by moneyness / term so the surface shape can be manipulated, not just
      // parallel-shifted.
      const weight =
        parameter === 'skew'
          ? (colIndex - strikeMid) / strikeMid
          : parameter === 'curvature'
            ? ((colIndex - strikeMid) / strikeMid) ** 2
            : parameter === 'term'
              ? rowIndex / lastMaturity
              : 1
      return transform(value, { ...manipulation, value: manipulation.value * weight })
    }),
  )
  return { ...surface, volatility }
}

/** Apply every manipulation to the raw fetch, returning the effective market. */
export function applyManipulations(
  raw: TacMarketRaw,
  manipulations: MarketManipulation[],
): TacMarketRaw {
  if (manipulations.length === 0) return raw
  const snapshots = { ...(raw.snapshots ?? {}) }
  const volSurfaces = { ...(raw.volSurfaces ?? {}) }
  const fx = { ...(raw.fx ?? {}) }
  const fxVol = { ...(raw.fxVol ?? {}) }
  let correlations: TacCorrMatrix | undefined = raw.correlations
  let curve = raw.curve
  let corporateActions = raw.corporateActions ?? []

  for (const manipulation of manipulations) {
    const target = manipulation.target ?? '*'
    switch (manipulation.type) {
      case 'spot': {
        for (const [symbol, snapshot] of Object.entries(snapshots)) {
          if (target !== '*' && symbol.toUpperCase() !== target.toUpperCase()) continue
          snapshots[symbol] = { ...snapshot, price: transform(snapshot.price, manipulation) }
        }
        break
      }
      case 'volatility': {
        for (const [symbol, surface] of Object.entries(volSurfaces)) {
          if (target !== '*' && symbol.toUpperCase() !== target.toUpperCase()) continue
          volSurfaces[symbol] = applyToVolSurface(surface, manipulation)
        }
        break
      }
      case 'correlation': {
        if (!correlations) break
        const legs = correlations.legs
        const matrix = correlations.matrix.map((row) => row.slice())
        for (let i = 0; i < legs.length; i++) {
          for (let j = i + 1; j < legs.length; j++) {
            if (!matchesPair(manipulation, legs[i]!, legs[j]!)) continue
            const next = transform(matrix[i]![j]!, manipulation)
            matrix[i]![j] = next
            matrix[j]![i] = next
          }
        }
        const clamped = clampCorrelation(matrix)
        correlations = {
          ...correlations,
          matrix: clamped,
          pairs: correlations.pairs.map((pair) => {
            const i = legs.indexOf(pair.legA)
            const j = legs.indexOf(pair.legB)
            return i >= 0 && j >= 0 ? { ...pair, rho: clamped[i]![j]! } : pair
          }),
        }
        break
      }
      case 'interest_rate': {
        if (!curve) break
        const pillars = curve.pillars.map((pillar) => ({
          ...pillar,
          rate: transform(pillar.rate, manipulation),
        }))
        curve = { ...curve, pillars }
        break
      }
      case 'dividend': {
        corporateActions = corporateActions.map((action) => {
          if (action.type !== 'dividend') return action
          if (target !== '*' && action.symbol.toUpperCase() !== target.toUpperCase()) return action
          return { ...action, amount: transform(action.amount, manipulation) }
        })
        break
      }
      case 'fx_spot': {
        for (const [pair, rate] of Object.entries(fx)) {
          if (target !== '*' && pair.toUpperCase() !== target.toUpperCase()) continue
          fx[pair] = { ...rate, rate: transform(rate.rate, manipulation) }
        }
        break
      }
      case 'fx_volatility': {
        for (const [pair, rows] of Object.entries(fxVol)) {
          if (target !== '*' && pair.toUpperCase() !== target.toUpperCase()) continue
          fxVol[pair] = rows.map((row) => ({ ...row, realizedVol: transform(row.realizedVol, manipulation) }))
        }
        break
      }
      default:
        break
    }
  }

  return { ...raw, snapshots, volSurfaces, fx, fxVol, correlations, curve, corporateActions }
}
