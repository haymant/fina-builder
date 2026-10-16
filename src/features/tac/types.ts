// tac-engine market-data mirror (§3A of the build handoff).
//
// `tac-engine` is stdio-only and its tool schemas are advertised at runtime;
// these types cover the fields the workbench reads. When a tool schema drifts,
// prefer the advertised schema and widen here — never hardcode a shape that
// the engine does not return.

export interface TacBar {
  t: string
  o: number
  h: number
  l: number
  c: number
  v: number
}

export type TacLakeSource = 'lake' | 'partial' | 'fetched'

export interface TacBarsResponse {
  source: TacLakeSource
  symbol?: string
  timeframe?: string
  bars: TacBar[]
  summary?: { count?: number; start?: string; end?: string }
}

export interface TacSnapshot {
  symbol: string
  price: number
  asOf: string
  changePct?: number
}

export interface TacCorrMatrix {
  legs: string[]
  matrix: number[][]
  pairs: Array<{ legA: string; legB: string; rho0: number; rho: number }>
}

export interface TacVolSurface {
  underlying: string
  strikeType: 'absolute' | 'relative' | string
  reference: number
  maturities: Array<string | number>
  strikes: number[]
  volatility: number[][]
  model?: string
  calibratedAt?: string
  source?: TacLakeSource | string
  stale?: boolean
  /** The engine's own calibration verdict, surfaced verbatim (e.g. "calendar violation …"). */
  arbitrage?: string[]
}

export interface TacCurvePillar {
  date: string | number
  rate: number
  tenor?: string
}

export interface TacCurve {
  id: string
  dayCount: string
  pillars: TacCurvePillar[]
}

export interface TacFxRate {
  pair: string
  bid?: number
  ask?: number
  rate: number
  asOf: string
}

export interface TacFxVolRow {
  pair: string
  windowDays: number
  realizedVol: number
  asOf?: string
}

export interface TacCorporateAction {
  symbol: string
  type: string
  exDate: string
  amount: number
  currency?: string
}

export interface TacCoverageRow {
  symbol: string
  timeframe: string
  start: string
  end: string
  rows: number
}

export interface TacLakeStatus {
  source: TacLakeSource
  symbols?: number
  rows?: number
  stale?: boolean
}

export interface TacTaSeries {
  symbol: string
  indicators: Record<string, Array<number | null>>
}

export interface TacSpSeries {
  symbol: string
  features: Record<string, number>
}

export interface TacMarketRaw {
  bars: Record<string, TacBarsResponse>
  snapshots: Record<string, TacSnapshot>
  correlations?: TacCorrMatrix
  volSurfaces: Record<string, TacVolSurface>
  curve?: TacCurve
  fx: Record<string, TacFxRate>
  fxVol: Record<string, TacFxVolRow[]>
  corporateActions: TacCorporateAction[]
  ta: Record<string, TacTaSeries>
  sp: Record<string, TacSpSeries>
  coverage: TacCoverageRow[]
}

// ---------------------------------------------------------------------------
// Manipulation model (§6.6) — mirrors finap's RiskCube
// ---------------------------------------------------------------------------

export type ManipulationType =
  | 'spot'
  | 'volatility'
  | 'correlation'
  | 'interest_rate'
  | 'dividend'
  | 'fx_spot'
  | 'fx_volatility'

export type ManipulationOperation = 'absolute' | 'relative' | 'set' | 'parallel'

export interface MarketManipulation {
  type: ManipulationType
  operation: ManipulationOperation
  /** Shift (absolute/relative) or level (set); basis points for rates/vol. */
  value: number
  /** Underlying id, FX pair, curve/surface id, or `*`. */
  target?: string
  surfaceParameter?: 'atm' | 'skew' | 'curvature' | 'term'
  filter?: Record<string, unknown>
}

export interface TacMarketState {
  raw: TacMarketRaw
  manipulations: MarketManipulation[]
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  /** Monotonic counter bumped whenever the raw fetch completes. */
  revision: number
}
