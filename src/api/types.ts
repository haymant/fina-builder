// Hand-written TypeScript mirrors of the `fina-kernel` wire types.
//
// These are the camelCase shapes the kernel serialises; they are the frontend's
// single source of truth for domain data (FEATURES.md §5d).
// Field names here must match the Rust `#[serde(rename_all = "camelCase")]`
// output exactly — a mismatch surfaces as `undefined` at runtime, so the golden
// parity tests exist on the Rust side to keep the kernel honest, and this file
// is kept in lockstep with it.

// ---------------------------------------------------------------------------
// Simulation bundle
// ---------------------------------------------------------------------------

export type SettlementType = 'cash' | 'physical' | 'none'

export type PayoffNodeLabel =
  | 'AggregatePV'
  | 'CouponStrip'
  | 'Discount'
  | 'DownAndInPut'
  | 'FixingSchedule'
  | 'GlobalKOGate'
  | 'KnockInGate'
  | 'MemoryCarry'
  | 'PathCube'
  | 'RangeAccrual'
  | 'Redemption'
  | 'WorstOfPerformance'

export interface ProductBarriers {
  kiBarrier: number
  koBarrier: number
  couponLower: number
  couponUpper: number
  couponRate: number
  notional: number
}

export interface SimulationConfig {
  seed: number
  pathCount: number
  observations: number
  startDate: string
  barriers: ProductBarriers
}

export interface PathObservation {
  date: string
  dateIndex: number
  aapl: number
  msft: number
  nvda: number
  worstOfPerformance: number
  couponAccrued: number
  couponMemoryBalance: number
  knockInAtDate: boolean
  knockOutAtDate: boolean
}

export interface PathAttribution {
  parRedemption: number
  coupon: number
  memoryCoupon: number
  downAndInPut: number
  funding: number
  discounting: number
  totalPv: number
}

export interface NodeDetailSnapshot {
  nodeId: string
  name: string
  description: string
  inputValue: string
  decisionRule: string
  output: string
  affectedPaths: number
  probability: number
  conditionalExpectedPayoff: number
  isLossRelated: boolean
}

export type NodeDetails = Record<string, NodeDetailSnapshot>

export interface SimulationPath {
  id: string
  pathIndex: number
  dates: string[]
  observations: PathObservation[]
  worstOfPerformance: number[]
  couponMemoryBalance: number[]
  knockInTriggered: boolean
  knockedOut: boolean
  knockOutDateIndex: number | null
  knockInDateIndex: number | null
  payoff: number
  redemptionValue: number
  couponValue: number
  putValue: number
  memoryCouponValue: number
  settlementType: SettlementType
  traversal: PayoffNodeLabel[]
  attribution: PathAttribution
  nodeDetails: NodeDetails
}

export interface BranchStats {
  totalPaths: number
  koTriggered: number
  alive: number
  knockIn: number
  noKnockIn: number
  cashSettlement: number
  physicalDelivery: number
}

export interface DistributionStats {
  mean: number
  median: number
  stdDev: number
  p05: number
  p95: number
  values: number[]
}

export interface SimulationDistributions {
  totalPayoff: DistributionStats
  couponPv: DistributionStats
  putPv: DistributionStats
  worstOfFinal: DistributionStats
}

export interface SimulationBundle {
  productName: string
  tagline: string
  underlyings: string[]
  barriers: ProductBarriers
  paths: SimulationPath[]
  branchStats: BranchStats
  distributions: SimulationDistributions
}

// ---------------------------------------------------------------------------
// Trade economics
// ---------------------------------------------------------------------------

export interface TradeEconomics {
  strike: number
  knockInBarrier: number
  knockOutBarrier: number
  couponLowerBarrier: number
  couponUpperBarrier: number
  couponRate: number
  memoryCouponEnabled: boolean
  physicalSettlementEnabled: boolean
  maturityYears: number
  notional: number
}

export interface TradeAnalytics {
  expectedPv: number
  couponPv: number
  putPv: number
  redemption: number
  kiProbability: number
  koProbability: number
  ciWidth: number
}

// ---------------------------------------------------------------------------
// Market
// ---------------------------------------------------------------------------

export interface OhlcBar {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Underlying {
  symbol: string
  spot: number
  baselineSpot: number
  dividendYield: number
  currency: string
  historicalPrices: OhlcBar[]
}

export interface FxPair {
  pair: string
  spot: number
  baselineSpot: number
  volatility: number
}

export interface VolParams {
  atmVol: number
  skew: number
  curvature: number
  termSlope: number
}

export interface MarketSnapshot {
  underlyings: Underlying[]
  fxPairs: FxPair[]
  correlations: number[][]
  vol: VolParams
}

// ---------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------

export interface BucketVega {
  bucket: string
  value: number
}

export interface CrossGamma {
  pair: string
  value: number
}

export interface RiskState {
  pv: number
  delta: number
  gamma: number
  vega: number
  theta: number
  rho: number
  fxDelta: number
  bucketVegas: BucketVega[]
  crossGamma: CrossGamma[]
}

// ---------------------------------------------------------------------------
// MC diagnostics
// ---------------------------------------------------------------------------

export interface McPoint {
  paths: number
  pv: number
  se: number
  lower: number
  upper: number
  p05: number
  p50: number
  p95: number
  ki: number
  ko: number
}

export interface McEfficiency {
  method: string
  timeMs: number
  paths: number
  efficiency: number
  label: string
}

export interface McDiagnosticsResponse {
  points: McPoint[]
  efficiency: McEfficiency[]
  final: McPoint
}

/** The ten path counts the MC series sweeps (kernel `MC_PATH_COUNTS`). */
export const MC_PATH_COUNTS = [
  1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000,
] as const

// ---------------------------------------------------------------------------
// Cashflow + valuation
// ---------------------------------------------------------------------------

export type CashflowType =
  | 'coupon'
  | 'redemption'
  | 'cash_settlement'
  | 'physical_delivery'
  | 'funding'

export interface Cashflow {
  id: string
  date: string
  type: CashflowType
  amount: number
  currency: string
  probability: number
  discountFactor: number
  presentValue: number
  realized: boolean
}

export interface CashflowAnalytics {
  grossCashflow: number
  presentValue: number
  realized: number
  future: number
  realizedPnL: number
  unrealizedPnL: number
  mtmPnL: number
  carryPnL: number
  totalPnL: number
}

export interface CashflowResponse {
  cashflows: Cashflow[]
  analytics: CashflowAnalytics
}

export interface TaylorExplain {
  delta: number
  gamma: number
  vega: number
  fx: number
  rates: number
  correlation: number
  dividend: number
  theta: number
  predicted: number
  residual: number
}

export interface PlvaContribution {
  category: string
  oldValue: number
  newValue: number
  contribution: number
}

export interface ValuationExplainState {
  previousPV: number
  currentPV: number
  marketExplainedPnL: number
  plvaPnL: number
  residualPnL: number
  totalPnL: number
}

export interface ValuationExplain {
  previousPV: number
  currentPV: number
  taylor: TaylorExplain
  plva: PlvaContribution[]
  plvaPnL: number
  state: ValuationExplainState
}

export interface ExplainEntry {
  id: string
  timestamp: string
  source: 'market' | 'plva' | 'cashflow' | 'valuation' | 'risk'
  category: string
  subCategory?: string
  contribution: number
  currency: string
  description: string
}

export interface ExplainReconciliation {
  totalMarket: number
  totalPLVA: number
  totalCashflow: number
  totalValuation: number
  totalRisk: number
  explained: number
  actualPnL: number
  residual: number
}

export interface ExplainLedger {
  entries: ExplainEntry[]
  reconciliation: ExplainReconciliation
}

// ---------------------------------------------------------------------------
// Execution events
// ---------------------------------------------------------------------------

export type ExecutionEventType =
  | 'Coupon Observation'
  | 'KO Observation'
  | 'Barrier Observation'
  | 'Final Fixing'
  | 'Settlement'

export interface ExecutionEvent {
  index: number
  date: string
  type: ExecutionEventType
  worstOf: number
  coupon: boolean
  ki: boolean
  ko: boolean
}

// ---------------------------------------------------------------------------
// Progress + errors + health
// ---------------------------------------------------------------------------

export interface ProgressEvent {
  phase: string
  completed: number
  total: number
  message: string
}

export interface WireError {
  code: string
  message: string
}

export interface HealthResponse {
  version: string
  coreVersion: string
}

export type ApiError = WireError