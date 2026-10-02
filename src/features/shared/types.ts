export type ThemeMode = 'dark' | 'light'

export type NodeState = 'idle' | 'visited' | 'active' | 'skipped'

export type PayoffNodeId =
  | 'PathCube'
  | 'FixingSchedule'
  | 'WorstOfPerformance'
  | 'KnockInGate'
  | 'GlobalKOGate'
  | 'RangeAccrual'
  | 'CouponStrip'
  | 'MemoryCarry'
  | 'DownAndInPut'
  | 'Redemption'
  | 'Discount'
  | 'AggregatePV'

export interface ProductBarriers {
  kiBarrier: number
  koBarrier: number
  couponLower: number
  couponUpper: number
  couponRate: number
  notional: number
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
  settlementType: 'cash' | 'physical' | 'none'
  traversal: PayoffNodeId[]
  attribution: PathAttribution
  nodeDetails: Record<PayoffNodeId, NodeDetailSnapshot>
}

export interface NodeDetailSnapshot {
  nodeId: PayoffNodeId
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

export interface SimulationBundle {
  productName: string
  tagline: string
  underlyings: string[]
  barriers: ProductBarriers
  paths: SimulationPath[]
  branchStats: BranchStats
  distributions: {
    totalPayoff: DistributionStats
    couponPv: DistributionStats
    putPv: DistributionStats
    worstOfFinal: DistributionStats
  }
}
