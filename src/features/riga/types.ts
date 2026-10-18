// riga-flow domain mirror (§4 of 45-fina-builder-build-handoff-prompt.md).
//
// These are the camelCase shapes `riga-mcp` serialises. They are intentionally
// separate from the `fina-kernel` demo types in `src/api/types.ts`: the two
// systems must not be merged (40 §3). Every field name here must match the
// `riga-mcp` `structuredContent` payload — the golden transcript test pins the
// ones the UI reads.

// ---------------------------------------------------------------------------
// Request inputs (`PriceRequest` fragment)
// ---------------------------------------------------------------------------

/** The only product `riga-flow` prices today: worst-of Phoenix autocall. */
export interface RigaPhoenixTrade {
  tradeId: string
  initialSpots: number[] // length 2
  maturityYears: number
  steps: number
  strike: number
  knockInBarrier: number
  knockOutBarrier: number | null
  couponBarrier: number | null
  couponRate: number | null
  memoryCoupon: boolean
  couponPeriods: number | null
  fixedFirstCoupon: boolean
  callStartStep: number | null
}

/** Market inputs, 2-factor only (`spots`/`vols`/`dividendYields` length 2). */
export interface RigaMarketSnapshot {
  asOf: string // never the UI clock — the fetch's as_of
  spots: number[]
  vols: number[] // flat ATM
  riskFreeRate: number
  dividendYields: number[]
  correlation: number[][] // 2x2
}

/** Optional local-vol grid (the Dupire smile read). */
export interface RigaImpliedVolGrid {
  maturitiesYears: number[]
  strikes: number[]
  vols: number[][] // [nMaturity][nStrike]
}

export type RigaTraceLevel = 'off' | 'aggregated' | 'sampled' | 'full'

export interface RigaSimulationConfig {
  paths: number
  pathBlockSize: number
  seed: number
  traceLevel: RigaTraceLevel
  varianceReduction: { kind: 'none' | 'halton' | 'sobol'; dimension?: number }
}

/** The assembled request the UI sends to `price_trade` (riga-engine `PriceRequest`). */
export interface RigaPriceRequest {
  trade: RigaPhoenixTrade
  market: RigaMarketSnapshot
  /** riga-engine names this block `config` (not `simulation`). */
  config: RigaSimulationConfig
  /** Explicit valuation date; the engine never reads the wall clock. */
  asOf: string
  /** Optional Dupire local-vol surfaces, one per factor. */
  localVol?: { grids: RigaImpliedVolGrid[] } | null
}

// ---------------------------------------------------------------------------
// Shared output shapes (§4)
// ---------------------------------------------------------------------------

export interface LegAttribution {
  parRedemption: number
  coupon: number
  memoryCoupon: number
  downAndInPut: number
  funding: number
  discounting: number
  total: number
}

export interface TransitionStats {
  transitionId: string
  inputCount: number
  outputCount: number
  probability: number
  meanPayoff: number
  variancePayoff: number
  meanDelta: number
  meanVega: number
}

export interface LedgerEntry {
  transitionId: string
  condition: string
  populationBefore: number
  populationAfter: number
  pvImpact: number
  deltaImpact: number
  vegaImpact: number
  evidenceRefs: string[]
}

export interface PathIdentity {
  pathId: string
  rngSeed: number
  sobolIndex: number | null
}

export interface PathRecord {
  identity: PathIdentity
  worstFinal: number
  knockedOut: boolean
  koTime: number | null
  kiHit: boolean
  putPayoff: number
  couponPv: number
  couponByPeriod: number[]
  funding: number
  pv: number
}

export interface DeterminismEnvelope {
  seed: number
  asOf: string
  marketSnapshotId: string
}

// ---------------------------------------------------------------------------
// Pricing / attribution
// ---------------------------------------------------------------------------

export interface RigaHealth {
  status: string
  version: string
  gitSha: string
  engine: string
  features: { cpuGbm: boolean; gpu: boolean; aad: boolean }
}

export interface RigaMarketEntry {
  id: string
  asOf: string
  spots: number[]
  vols: number[]
  correlation: number[][]
  riskFreeRate: number
}

export interface RigaPriceResult {
  pv: number
  legs: LegAttribution
  determinism: DeterminismEnvelope
  engineModel: string
  [key: string]: unknown
}

/** `price_put` wraps the result with the fixture it priced and its acceptance. */
export interface RigaPricePut {
  result: RigaPriceResult
  fixture: string
  fixtureAcceptance: unknown
}

export interface ExplainPvAttribution {
  legs: LegAttribution
  ledger: LedgerEntry[]
  stats: TransitionStats[]
  kiProbability: number
  determinism: DeterminismEnvelope
  engineModel: string
}

// ---------------------------------------------------------------------------
// Nets (Layers 1–3)
// ---------------------------------------------------------------------------

export interface NetPlace {
  id: string
  tokens: number
}

export interface NetTransition {
  id: string
  condition: string
  populationBefore: number
  populationAfter: number
  probability: number
  pvImpact: number
}

export interface ExecutionNet {
  places: NetPlace[]
  transitions: NetTransition[]
  stats: unknown
  runId: string
}

export interface RiskNetTransition {
  id: string
  pvImpact: number
  deltaImpact: number
  vegaImpact: number
}

export interface RiskNetAsset {
  assetIndex: number
  delta: number
  gamma: number
  vega: number
}

export interface RiskNet {
  transitions: RiskNetTransition[]
  perAsset: RiskNetAsset[]
  dv01: number
  correlationSensitivity: number
}

export interface LedgerPayload {
  ledger: LedgerEntry[]
  determinism: DeterminismEnvelope
}

// ---------------------------------------------------------------------------
// Paths / cube / events
// ---------------------------------------------------------------------------

export interface PathCubeQueryResponse {
  percentile: number
  sample: PathRecord[]
  /** Selected path id (the corpus sample index). */
  selected: number
  /** Worst-final threshold at this percentile. */
  thresholdWorstFinal: number
  /** Number of paths in the run. */
  total: number
}

export interface ExecutionTapeEvent {
  kind: string
  t?: number
  worstFinal?: number
}

export interface ExecutionTapeEntry {
  pathId: string
  events: ExecutionTapeEvent[]
  pv: number
}

export interface ExecutionTape {
  totalPaths: number
  tapeSize: number
  tape: ExecutionTapeEntry[]
}

// ---------------------------------------------------------------------------
// Statistics / diagnostics / risk
// ---------------------------------------------------------------------------

export interface RigaDistributions {
  count: number
  worstFinalDeciles: number[] // length 10
  kiRate: number
  meanPut: number
}

export interface RigaMcDiagnostics {
  pv: number
  mcError: number
  relativeSe: number
  stats: TransitionStats[] | unknown
}

/** One Monte-Carlo convergence point (`mc_convergence`). */
export interface RigaConvergencePoint {
  paths: number
  pv: number
  se: number
  relativeSe: number
  lower: number
  upper: number
  ki: number
  ko: number
}

export interface RigaMcConvergence {
  points: RigaConvergencePoint[]
  final: RigaConvergencePoint | null
  traceLevel: string
}

/** `build_cashflows`: mean leg PV, sampled paths, and the coupon timeline. */
export interface RigaCashflowMean {
  couponPv: number
  funding: number
  putPayoff: number
}

export interface RigaCashflowTimelinePoint {
  period: number
  expectedCouponPv: number
  paidProbability: number
}

export interface RigaCashflowSamplePath {
  pathId: number
  pv: number
  couponPv: number
  funding: number
  putPayoff: number
}

export interface RigaCashflows {
  mean: RigaCashflowMean
  paths: number
  samplePaths: RigaCashflowSamplePath[]
  timeline: RigaCashflowTimelinePoint[]
}

/** One equal-width histogram bin (`distributions_histogram`). */
export interface RigaDistributionBin {
  lo: number
  hi: number
  count: number
}

export interface RigaMetricDistribution {
  metric: string
  count: number
  mean: number
  median: number
  stdDev: number
  p05: number
  p50: number
  p95: number
  min: number
  max: number
  bins: RigaDistributionBin[]
}

export interface RigaDistributionsHistogram {
  count: number
  binCount: number
  metrics: RigaMetricDistribution[]
}

export interface RigaRiskAsset {
  assetIndex: number
  delta: number
  gamma: number
  vega: number
}

export interface RigaBucketVega {
  bucket: string
  vega: number
}

export interface RigaRiskDetailed {
  basePv: number
  assets: RigaRiskAsset[]
  dv01: number
  rho: number
  correlationSensitivity: number
  theta: number
  fxDelta: number
  crossGamma: number[][]
  bucketVegas: RigaBucketVega[]
}

export interface RigaAssetGreeks {
  assetIndex: number
  delta: number
  gamma: number
  vega: number
  deltaMcError: number
  vegaMcError: number
}

export interface RigaRiskBatch {
  basePv: number
  scenarioCount: number
  seed: number
  pvMcError: number
  dv01: number
  correlationSensitivity: number
  assets: RigaAssetGreeks[]
}

export interface RigaBookRisk {
  trades: number
  pv: number
  delta: number[]
  gamma: number[]
  vega: number[]
  dv01: number
  correlationSensitivity: number
}

export interface RigaScenario {
  basePv: number
  scenarioCount: number
  rateUpPv: number
  rateDownPv: number
  correlationUpPv: number
  correlationDownPv: number
  assets: Array<{ assetIndex: number; delta: number; gamma: number; vega: number }>
}

export interface RigaFactorContribution {
  factor: string
  contribution: number
}

export interface RigaPlExplain {
  contributions: RigaFactorContribution[]
  total: number
}

export interface RigaValuationExplain {
  basePv: number
  currentPv: number
  deltaPv: number
  predictedDpv: number
  residual: number
  contributions: RigaFactorContribution[]
}

export interface RigaGovernanceEvidence {
  model: string
  sourceModel: string
  assumptions: string[]
  limitations: string[]
  stressMethodology: string
  lineage: RigaLineage
  evidence: unknown
  legs: LegAttribution
}

export interface RigaLineage {
  determinism: DeterminismEnvelope
  legs: LegAttribution
  ledger: LedgerEntry[]
  stats: TransitionStats[]
  traceEvents: unknown[]
  sampledPaths: PathRecord[]
  evidenceRefs: string[]
}

export interface RigaRootCause {
  trade: string
  marketSnapshotId: string
  engineModel: string
  finding: string
  evidenceRefs: string[]
  /** Baseline-vs-current change log (shape is engine-defined). */
  changeLog?: Record<string, unknown> | null
  note: string
}

export interface RigaValidationFlag {
  severity: string
  message: string
}

export interface RigaStressBand {
  spotBand: [number, number]
  reason: string
}

export interface RigaRegressionResult {
  name: string
  exceptions: Array<{ family?: string; transitionId?: string; message: string; delta?: number }>
  count: number
  withinTolerance?: boolean
}

export interface RigaBaseline {
  name: string
  frozen: {
    pv: number
    assets: RigaAssetGreeks[]
    dv01: number
    correlationSensitivity: number
    frozenAtUnix: number
  }
}

export type RigaSource = 'demo' | 'riga'
