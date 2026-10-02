import dayjs from 'dayjs'
import type {
  BranchStats,
  DistributionStats,
  NodeDetailSnapshot,
  PathAttribution,
  PathObservation,
  PayoffNodeId,
  ProductBarriers,
  SimulationBundle,
  SimulationPath,
} from '../features/shared/types'

/** Mulberry32 — deterministic PRNG from a fixed seed. */
function createRng(seed: number) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

const PATH_COUNT = 100
const OBSERVATIONS = 60
const SEED = 42

export const BARRIERS: ProductBarriers = {
  kiBarrier: 0.7,
  koBarrier: 1.0,
  couponLower: 0.75,
  couponUpper: 1.0,
  couponRate: 0.008, // monthly coupon ~0.8%
  notional: 100,
}

type PathScenario = 'ko' | 'alive_ki_cash' | 'alive_ki_physical' | 'alive_no_ki'

function assignScenarios(rng: () => number): PathScenario[] {
  // Target mix approximating population: KO 65%, Alive 35% (KI 20%, NoKI 15%)
  // Within KI: ~half cash / half physical for demo clarity
  const scenarios: PathScenario[] = []
  for (let i = 0; i < PATH_COUNT; i++) {
    const u = rng()
    if (u < 0.65) scenarios.push('ko')
    else if (u < 0.75) scenarios.push('alive_ki_cash')
    else if (u < 0.85) scenarios.push('alive_ki_physical')
    else scenarios.push('alive_no_ki')
  }
  return scenarios
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

function generateDates(): string[] {
  const start = dayjs('2024-01-15')
  return Array.from({ length: OBSERVATIONS }, (_, i) =>
    start.add(i, 'month').format('YYYY-MM-DD'),
  )
}

/**
 * Build a worst-of performance series that is internally consistent
 * with the assigned scenario flags (KO / KI crossings).
 */
function generatePerformanceSeries(
  scenario: PathScenario,
  rng: () => number,
): {
  aapl: number[]
  msft: number[]
  nvda: number[]
  worstOf: number[]
  koIndex: number | null
  kiIndex: number | null
} {
  const aapl: number[] = []
  const msft: number[] = []
  const nvda: number[] = []
  const worstOf: number[] = []

  let a = 1.0 + (rng() - 0.5) * 0.04
  let m = 1.0 + (rng() - 0.5) * 0.04
  let n = 1.0 + (rng() - 0.5) * 0.04

  let koIndex: number | null = null
  let kiIndex: number | null = null

  // Pre-pick event dates so barriers are actually crossed
  const koEvent =
    scenario === 'ko' ? 6 + Math.floor(rng() * 40) : null
  const kiEvent =
    scenario === 'alive_ki_cash' || scenario === 'alive_ki_physical'
      ? 8 + Math.floor(rng() * 35)
      : null

  for (let t = 0; t < OBSERVATIONS; t++) {
    // Drift / noise by scenario
    let drift = 0
    let vol = 0.035

    if (scenario === 'ko') {
      drift = 0.004
      vol = 0.03
      if (koEvent !== null && t === koEvent) {
        // Force worst-of through KO barrier
        const lift = BARRIERS.koBarrier + 0.01 + rng() * 0.08
        const target = lift
        // Lift the current worst underlying enough so min >= KO
        const currentMin = Math.min(a, m, n)
        const scale = target / Math.max(currentMin, 0.01)
        a *= scale
        m *= scale * (0.98 + rng() * 0.04)
        n *= scale * (0.98 + rng() * 0.04)
      }
    } else if (scenario === 'alive_no_ki') {
      // Stay above KI for entire life, never hit KO
      drift = 0.001
      vol = 0.025
    } else {
      // Alive + KI: must cross KI, must not hit KO
      drift = -0.003
      vol = 0.04
      if (kiEvent !== null && t === kiEvent) {
        const plunge = BARRIERS.kiBarrier - 0.02 - rng() * 0.12
        // Drive the worst name down through KI
        const names = [a, m, n]
        const worstIdx = names.indexOf(Math.min(...names))
        names[worstIdx] = plunge
        ;[a, m, n] = names as [number, number, number]
      }
    }

    if (!(scenario === 'ko' && koEvent === t)) {
      a *= 1 + drift + (rng() - 0.5) * vol
      m *= 1 + drift * 0.9 + (rng() - 0.5) * vol
      n *= 1 + drift * 1.1 + (rng() - 0.5) * vol * 1.2
    }

    // Soft constraints after each step to keep scenario valid
    if (scenario === 'alive_no_ki') {
      a = clamp(a, BARRIERS.kiBarrier + 0.02, BARRIERS.koBarrier - 0.01)
      m = clamp(m, BARRIERS.kiBarrier + 0.02, BARRIERS.koBarrier - 0.01)
      n = clamp(n, BARRIERS.kiBarrier + 0.02, BARRIERS.koBarrier - 0.01)
    } else if (scenario === 'alive_ki_cash' || scenario === 'alive_ki_physical') {
      // Cap below KO; after KI event allow deep lows
      a = Math.min(a, BARRIERS.koBarrier - 0.005)
      m = Math.min(m, BARRIERS.koBarrier - 0.005)
      n = Math.min(n, BARRIERS.koBarrier - 0.005)
      if (kiEvent !== null && t < kiEvent) {
        // Before KI, stay above barrier so crossing is clear
        const floor = BARRIERS.kiBarrier + 0.01
        a = Math.max(a, floor)
        m = Math.max(m, floor)
        n = Math.max(n, floor)
      }
    } else if (scenario === 'ko' && koEvent !== null && t < koEvent) {
      // Before KO, keep below KO so the event is the first crossing
      a = Math.min(a, BARRIERS.koBarrier - 0.01)
      m = Math.min(m, BARRIERS.koBarrier - 0.01)
      n = Math.min(n, BARRIERS.koBarrier - 0.01)
    }

    a = clamp(a, 0.25, 1.45)
    m = clamp(m, 0.25, 1.45)
    n = clamp(n, 0.25, 1.45)

    const w = Math.min(a, m, n)
    aapl.push(round4(a))
    msft.push(round4(m))
    nvda.push(round4(n))
    worstOf.push(round4(w))

    if (koIndex === null && w >= BARRIERS.koBarrier) {
      koIndex = t
    }
    if (kiIndex === null && w <= BARRIERS.kiBarrier) {
      kiIndex = t
    }

    // After KO, freeze path (note redeems early)
    if (scenario === 'ko' && koIndex !== null && t >= koIndex) {
      // Fill remaining with last KO level
      for (let k = t + 1; k < OBSERVATIONS; k++) {
        aapl.push(aapl[t]!)
        msft.push(msft[t]!)
        nvda.push(nvda[t]!)
        worstOf.push(worstOf[t]!)
      }
      break
    }
  }

  // Consistency enforcement — never ship inconsistent flags
  if (scenario === 'ko') {
    if (koIndex === null) {
      const forceAt = Math.min(30, OBSERVATIONS - 1)
      const lift = BARRIERS.koBarrier + 0.02
      worstOf[forceAt] = lift
      aapl[forceAt] = lift + 0.01
      msft[forceAt] = lift + 0.02
      nvda[forceAt] = lift
      koIndex = forceAt
      for (let k = forceAt + 1; k < OBSERVATIONS; k++) {
        aapl[k] = aapl[forceAt]!
        msft[k] = msft[forceAt]!
        nvda[k] = nvda[forceAt]!
        worstOf[k] = worstOf[forceAt]!
      }
    }
  } else {
    // Alive paths must never hit KO
    for (let t = 0; t < OBSERVATIONS; t++) {
      if (worstOf[t]! >= BARRIERS.koBarrier) {
        const capped = BARRIERS.koBarrier - 0.01
        worstOf[t] = capped
        aapl[t] = Math.min(aapl[t]!, capped + 0.02)
        msft[t] = Math.min(msft[t]!, capped + 0.02)
        nvda[t] = Math.min(nvda[t]!, capped)
      }
    }
    koIndex = null
  }

  if (scenario === 'alive_ki_cash' || scenario === 'alive_ki_physical') {
    if (kiIndex === null) {
      const forceAt = Math.min(25, OBSERVATIONS - 1)
      const plunge = BARRIERS.kiBarrier - 0.05
      worstOf[forceAt] = plunge
      nvda[forceAt] = plunge
      aapl[forceAt] = Math.max(aapl[forceAt]!, plunge + 0.08)
      msft[forceAt] = Math.max(msft[forceAt]!, plunge + 0.1)
      kiIndex = forceAt
    }
  } else if (scenario === 'alive_no_ki') {
    // Ensure never below KI
    for (let t = 0; t < OBSERVATIONS; t++) {
      if (worstOf[t]! <= BARRIERS.kiBarrier) {
        const lift = BARRIERS.kiBarrier + 0.03
        worstOf[t] = lift
        aapl[t] = Math.max(aapl[t]!, lift)
        msft[t] = Math.max(msft[t]!, lift)
        nvda[t] = Math.max(nvda[t]!, lift)
      }
    }
    kiIndex = null
  } else if (scenario === 'ko') {
    // KO paths may or may not have KI; leave as computed
  }

  return { aapl, msft, nvda, worstOf, koIndex, kiIndex }
}

function round4(v: number) {
  return Math.round(v * 10000) / 10000
}

function round2(v: number) {
  return Math.round(v * 100) / 100
}

function buildObservations(
  dates: string[],
  series: ReturnType<typeof generatePerformanceSeries>,
  scenario: PathScenario,
): {
  observations: PathObservation[]
  couponValue: number
  memoryCouponValue: number
} {
  const observations: PathObservation[] = []
  let memory = 0
  let couponPaid = 0
  let memoryPaid = 0
  let knockedIn = false
  const endIndex =
    scenario === 'ko' && series.koIndex !== null ? series.koIndex : OBSERVATIONS - 1

  for (let t = 0; t <= endIndex; t++) {
    const w = series.worstOf[t]!
    const knockInAtDate = !knockedIn && w <= BARRIERS.kiBarrier
    if (knockInAtDate) knockedIn = true
    const knockOutAtDate = w >= BARRIERS.koBarrier

    let couponAccrued = 0
    if (w >= BARRIERS.couponLower && w <= BARRIERS.couponUpper) {
      couponAccrued = BARRIERS.notional * BARRIERS.couponRate
      // Pay memory + current
      couponPaid += couponAccrued
      memoryPaid += memory
      memory = 0
    } else {
      memory += BARRIERS.notional * BARRIERS.couponRate
    }

    if (knockOutAtDate) {
      // Phoenix autocall: pay accrued memory on KO
      memoryPaid += memory
      memory = 0
    }

    observations.push({
      date: dates[t]!,
      dateIndex: t,
      aapl: series.aapl[t]!,
      msft: series.msft[t]!,
      nvda: series.nvda[t]!,
      worstOfPerformance: w,
      couponAccrued: round2(couponAccrued),
      couponMemoryBalance: round2(memory),
      knockInAtDate,
      knockOutAtDate,
    })
  }

  // Pad remaining dates for KO early exit (frozen levels)
  for (let t = endIndex + 1; t < OBSERVATIONS; t++) {
    const last = observations[endIndex]!
    observations.push({
      ...last,
      date: dates[t]!,
      dateIndex: t,
      couponAccrued: 0,
      knockInAtDate: false,
      knockOutAtDate: false,
    })
  }

  return {
    observations,
    couponValue: round2(couponPaid),
    memoryCouponValue: round2(memoryPaid),
  }
}

function computePayoff(
  scenario: PathScenario,
  series: ReturnType<typeof generatePerformanceSeries>,
  couponValue: number,
  memoryCouponValue: number,
): {
  redemptionValue: number
  putValue: number
  payoff: number
  settlementType: 'cash' | 'physical' | 'none'
  attribution: PathAttribution
} {
  let redemptionValue = BARRIERS.notional
  let putValue = 0
  let settlementType: 'cash' | 'physical' | 'none' = 'none'

  if (scenario === 'ko') {
    redemptionValue = BARRIERS.notional
    putValue = 0
    settlementType = 'none'
  } else if (scenario === 'alive_no_ki') {
    redemptionValue = BARRIERS.notional
    putValue = 0
    settlementType = 'none'
  } else {
    // KI triggered at maturity — Down & In Put loss
    const finalW = series.worstOf[OBSERVATIONS - 1]!
    putValue = round2(-BARRIERS.notional * Math.max(0, 1 - finalW))
    redemptionValue = round2(BARRIERS.notional + putValue)
    settlementType = scenario === 'alive_ki_cash' ? 'cash' : 'physical'
  }

  // For attribution waterfall we show put separately from par
  const parRedemption = BARRIERS.notional
  const attributionBase: PathAttribution = {
    parRedemption,
    coupon: couponValue,
    memoryCoupon: memoryCouponValue,
    downAndInPut: putValue,
    funding: -2,
    discounting: -1.5,
    totalPv: 0,
  }
  attributionBase.totalPv = round2(
    attributionBase.parRedemption +
      attributionBase.coupon +
      attributionBase.memoryCoupon +
      attributionBase.downAndInPut +
      attributionBase.funding +
      attributionBase.discounting,
  )

  const payoff = round2(redemptionValue + couponValue + memoryCouponValue)

  return {
    redemptionValue,
    putValue,
    payoff,
    settlementType,
    attribution: attributionBase,
  }
}

function refineAttribution(
  attribution: PathAttribution,
  rng: () => number,
): PathAttribution {
  const funding = round2(-1.5 - rng() * 1.5)
  const discounting = round2(-0.8 - rng() * 1.2)
  const next = { ...attribution, funding, discounting }
  next.totalPv = round2(
    next.parRedemption +
      next.coupon +
      next.memoryCoupon +
      next.downAndInPut +
      next.funding +
      next.discounting,
  )
  return next
}

function buildTraversal(scenario: PathScenario): PayoffNodeId[] {
  const base: PayoffNodeId[] = [
    'PathCube',
    'FixingSchedule',
    'WorstOfPerformance',
  ]

  if (scenario === 'ko') {
    return [
      ...base,
      'GlobalKOGate',
      'CouponStrip',
      'MemoryCarry',
      'Redemption',
      'Discount',
      'AggregatePV',
    ]
  }

  if (scenario === 'alive_no_ki') {
    return [
      ...base,
      'KnockInGate',
      'GlobalKOGate',
      'RangeAccrual',
      'CouponStrip',
      'MemoryCarry',
      'Redemption',
      'Discount',
      'AggregatePV',
    ]
  }

  // Alive + KI
  return [
    ...base,
    'KnockInGate',
    'GlobalKOGate',
    'RangeAccrual',
    'CouponStrip',
    'MemoryCarry',
    'DownAndInPut',
    'Redemption',
    'Discount',
    'AggregatePV',
  ]
}

function buildNodeDetails(
  path: Omit<SimulationPath, 'nodeDetails'>,
  scenario: PathScenario,
  population: { ko: number; ki: number; noKi: number },
): Record<PayoffNodeId, NodeDetailSnapshot> {
  const finalW = path.worstOfPerformance[path.worstOfPerformance.length - 1]!
  const selectedW =
    path.observations[Math.min(path.observations.length - 1, 30)]!.worstOfPerformance

  const mk = (
    nodeId: PayoffNodeId,
    partial: Omit<NodeDetailSnapshot, 'nodeId'>,
  ): NodeDetailSnapshot => ({ nodeId, ...partial })

  const details: Record<PayoffNodeId, NodeDetailSnapshot> = {
    PathCube: mk('PathCube', {
      name: 'PathCube',
      description: 'Monte Carlo path cube sample for this simulation draw.',
      inputValue: path.id,
      decisionRule: 'Uniform sample from path cube',
      output: `Path #${path.pathIndex}`,
      affectedPaths: PATH_COUNT,
      probability: 1,
      conditionalExpectedPayoff: 96,
      isLossRelated: false,
    }),
    FixingSchedule: mk('FixingSchedule', {
      name: 'FixingSchedule',
      description: 'Monthly observation schedule across three underlyings.',
      inputValue: `${OBSERVATIONS} dates`,
      decisionRule: 'Business-day monthly fixings',
      output: path.dates[0] + ' → ' + path.dates[path.dates.length - 1],
      affectedPaths: PATH_COUNT,
      probability: 1,
      conditionalExpectedPayoff: 96,
      isLossRelated: false,
    }),
    WorstOfPerformance: mk('WorstOfPerformance', {
      name: 'WorstOfPerformance',
      description: 'min(AAPL, MSFT, NVDA) performance vs strike.',
      inputValue: `Wo = ${pct(selectedW)}`,
      decisionRule: 'worstOf = min(S_i / S_i0)',
      output: pct(finalW),
      affectedPaths: PATH_COUNT,
      probability: 1,
      conditionalExpectedPayoff: 96,
      isLossRelated: finalW < BARRIERS.kiBarrier,
    }),
    KnockInGate: mk('KnockInGate', {
      name: 'KnockInGate',
      description: 'European-style KI monitor on worst-of performance.',
      inputValue: pct(
        path.knockInDateIndex !== null
          ? path.worstOfPerformance[path.knockInDateIndex]!
          : Math.min(...path.worstOfPerformance),
      ),
      decisionRule: `Wo ≤ ${pct(BARRIERS.kiBarrier)}`,
      output: path.knockInTriggered ? 'TRUE' : 'FALSE',
      affectedPaths: population.ki,
      probability: population.ki / PATH_COUNT,
      conditionalExpectedPayoff: path.knockInTriggered ? 89.5 : 104.2,
      isLossRelated: path.knockInTriggered,
    }),
    GlobalKOGate: mk('GlobalKOGate', {
      name: 'GlobalKOGate',
      description: 'Autocall / global knock-out on worst-of.',
      inputValue: pct(
        path.knockOutDateIndex !== null
          ? path.worstOfPerformance[path.knockOutDateIndex]!
          : Math.max(...path.worstOfPerformance),
      ),
      decisionRule: `Wo ≥ ${pct(BARRIERS.koBarrier)}`,
      output: path.knockedOut ? 'TRUE' : 'FALSE',
      affectedPaths: population.ko,
      probability: population.ko / PATH_COUNT,
      conditionalExpectedPayoff: path.knockedOut ? 108.4 : 91.2,
      isLossRelated: false,
    }),
    RangeAccrual: mk('RangeAccrual', {
      name: 'RangeAccrual',
      description: 'Coupon accrues when Wo is inside the coupon range.',
      inputValue: `${pct(BARRIERS.couponLower)} – ${pct(BARRIERS.couponUpper)}`,
      decisionRule: 'Accrue if couponLower ≤ Wo ≤ couponUpper',
      output: `${path.couponValue.toFixed(2)} accrued`,
      affectedPaths: PATH_COUNT - population.ko,
      probability: (PATH_COUNT - population.ko) / PATH_COUNT,
      conditionalExpectedPayoff: 98.1,
      isLossRelated: false,
    }),
    CouponStrip: mk('CouponStrip', {
      name: 'CouponStrip',
      description: 'Paid coupon cashflows along the path.',
      inputValue: path.couponValue.toFixed(2),
      decisionRule: 'Pay coupon when in range',
      output: path.couponValue.toFixed(2),
      affectedPaths: PATH_COUNT,
      probability: 0.82,
      conditionalExpectedPayoff: 97.5,
      isLossRelated: false,
    }),
    MemoryCarry: mk('MemoryCarry', {
      name: 'MemoryCarry',
      description: 'Unpaid coupons carried forward until next in-range or KO.',
      inputValue: path.memoryCouponValue.toFixed(2),
      decisionRule: 'Memory += coupon if out of range',
      output: path.memoryCouponValue.toFixed(2),
      affectedPaths: PATH_COUNT,
      probability: 0.61,
      conditionalExpectedPayoff: 97.8,
      isLossRelated: false,
    }),
    DownAndInPut: mk('DownAndInPut', {
      name: 'DownAndInPut',
      description: 'Capital loss if KI triggered and held to maturity.',
      inputValue: pct(finalW),
      decisionRule: 'Put = −N × max(0, 1 − Wo_T) if KI',
      output: path.putValue.toFixed(2),
      affectedPaths: population.ki,
      probability: population.ki / PATH_COUNT,
      conditionalExpectedPayoff: 89.5,
      isLossRelated: true,
    }),
    Redemption: mk('Redemption', {
      name: 'Redemption',
      description: 'Final notional redemption after put adjustment.',
      inputValue: BARRIERS.notional.toFixed(2),
      decisionRule: 'N + Put (if KI) else N',
      output: path.redemptionValue.toFixed(2),
      affectedPaths: PATH_COUNT,
      probability: 1,
      conditionalExpectedPayoff: 96.0,
      isLossRelated: path.putValue < 0,
    }),
    Discount: mk('Discount', {
      name: 'Discount',
      description: 'Funding and discounting from payoff date to PV.',
      inputValue: path.attribution.discounting.toFixed(2),
      decisionRule: 'DF(t) × cashflows',
      output: path.attribution.totalPv.toFixed(2),
      affectedPaths: PATH_COUNT,
      probability: 1,
      conditionalExpectedPayoff: 96.0,
      isLossRelated: false,
    }),
    AggregatePV: mk('AggregatePV', {
      name: 'AggregatePV',
      description: 'Path present value after all payoff graph nodes.',
      inputValue: 'Σ attribution',
      decisionRule: 'Par + Coupons + Put + Funding + DF',
      output: path.attribution.totalPv.toFixed(2),
      affectedPaths: 1,
      probability: 1 / PATH_COUNT,
      conditionalExpectedPayoff: path.attribution.totalPv,
      isLossRelated: path.attribution.totalPv < 100,
    }),
  }

  // Soften unused nodes for KO short-circuit
  if (scenario === 'ko') {
    details.KnockInGate = {
      ...details.KnockInGate,
      output: 'SKIPPED',
      description: 'Skipped — path knocked out before KI evaluation at maturity.',
    }
    details.DownAndInPut = {
      ...details.DownAndInPut,
      output: 'SKIPPED',
      description: 'Skipped — autocall redeems par before put exposure.',
    }
    details.RangeAccrual = {
      ...details.RangeAccrual,
      output: 'PARTIAL',
      description: 'Accrual until KO date only.',
    }
  }

  return details
}

function pct(v: number) {
  return `${(v * 100).toFixed(1)}%`
}

function computeDistribution(values: number[]): DistributionStats {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mean = values.reduce((s, v) => s + v, 0) / n
  const median =
    n % 2 === 0
      ? (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2
      : sorted[Math.floor(n / 2)]!
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n
  const stdDev = Math.sqrt(variance)
  const p05 = sorted[Math.floor(0.05 * (n - 1))]!
  const p95 = sorted[Math.floor(0.95 * (n - 1))]!
  return {
    mean: round2(mean),
    median: round2(median),
    stdDev: round2(stdDev),
    p05: round2(p05),
    p95: round2(p95),
    values,
  }
}

function buildBranchStats(paths: SimulationPath[]): BranchStats {
  const koTriggered = paths.filter((p) => p.knockedOut).length
  const alive = paths.length - koTriggered
  const knockIn = paths.filter((p) => !p.knockedOut && p.knockInTriggered).length
  const noKnockIn = paths.filter((p) => !p.knockedOut && !p.knockInTriggered).length
  const cashSettlement = paths.filter(
    (p) => !p.knockedOut && p.knockInTriggered && p.settlementType === 'cash',
  ).length
  const physicalDelivery = paths.filter(
    (p) => !p.knockedOut && p.knockInTriggered && p.settlementType === 'physical',
  ).length

  return {
    totalPaths: 100_000, // display population scale
    koTriggered: Math.round((koTriggered / paths.length) * 100_000),
    alive: Math.round((alive / paths.length) * 100_000),
    knockIn: Math.round((knockIn / paths.length) * 100_000),
    noKnockIn: Math.round((noKnockIn / paths.length) * 100_000),
    cashSettlement: Math.round((cashSettlement / paths.length) * 100_000),
    physicalDelivery: Math.round((physicalDelivery / paths.length) * 100_000),
  }
}

export function generateSimulationBundle(): SimulationBundle {
  const rng = createRng(SEED)
  const dates = generateDates()
  const scenarios = assignScenarios(rng)

  const paths: SimulationPath[] = scenarios.map((scenario, i) => {
    const series = generatePerformanceSeries(scenario, rng)
    const { observations, couponValue, memoryCouponValue } = buildObservations(
      dates,
      series,
      scenario,
    )

    // Derive flags strictly from the series (source of truth)
    const knockedOut = series.koIndex !== null
    const knockInTriggered = series.kiIndex !== null && !knockedOut
      ? true
      : series.kiIndex !== null && knockedOut
        ? series.kiIndex < (series.koIndex ?? Infinity)
        : scenario === 'alive_ki_cash' || scenario === 'alive_ki_physical'

    // Re-align flags to scenario for alive paths
    const finalKnockIn =
      scenario === 'alive_ki_cash' || scenario === 'alive_ki_physical'
        ? true
        : scenario === 'alive_no_ki'
          ? false
          : knockInTriggered
    const finalKnockOut = scenario === 'ko'

    let payoffParts = computePayoff(
      scenario,
      series,
      couponValue,
      memoryCouponValue,
    )
    payoffParts = {
      ...payoffParts,
      attribution: refineAttribution(payoffParts.attribution, rng),
    }

    const pathPartial: Omit<SimulationPath, 'nodeDetails'> = {
      id: `path-${String(i + 1).padStart(3, '0')}`,
      pathIndex: i + 1,
      dates,
      observations,
      worstOfPerformance: series.worstOf,
      couponMemoryBalance: observations.map((o) => o.couponMemoryBalance),
      knockInTriggered: finalKnockIn,
      knockedOut: finalKnockOut,
      knockOutDateIndex: series.koIndex,
      knockInDateIndex: series.kiIndex,
      payoff: payoffParts.payoff,
      redemptionValue: payoffParts.redemptionValue,
      couponValue,
      putValue: payoffParts.putValue,
      memoryCouponValue,
      settlementType: payoffParts.settlementType,
      traversal: buildTraversal(scenario),
      attribution: payoffParts.attribution,
    }

    return pathPartial as SimulationPath
  })

  const population = {
    ko: paths.filter((p) => p.knockedOut).length,
    ki: paths.filter((p) => !p.knockedOut && p.knockInTriggered).length,
    noKi: paths.filter((p) => !p.knockedOut && !p.knockInTriggered).length,
  }

  const fullPaths = paths.map((p, i) => {
    const scenario = scenarios[i]!
    return {
      ...p,
      nodeDetails: buildNodeDetails(p, scenario, population),
    }
  })

  // Final consistency assertions (dev-time safety)
  for (const p of fullPaths) {
    if (p.knockedOut) {
      const crossed = p.worstOfPerformance.some((w) => w >= BARRIERS.koBarrier)
      if (!crossed) {
        console.warn(`Inconsistent KO path ${p.id}`)
      }
    }
    if (p.knockInTriggered) {
      const crossed = p.worstOfPerformance.some((w) => w <= BARRIERS.kiBarrier)
      if (!crossed) {
        console.warn(`Inconsistent KI path ${p.id}`)
      }
    }
    if (!p.knockInTriggered && !p.knockedOut) {
      const breached = p.worstOfPerformance.some((w) => w <= BARRIERS.kiBarrier)
      if (breached) {
        console.warn(`Inconsistent No-KI path ${p.id}`)
      }
    }
  }

  return {
    productName: 'Worst Of Phoenix Autocall',
    tagline: 'Debugging Monte Carlo Paths Like Source Code',
    underlyings: ['AAPL', 'MSFT', 'NVDA'],
    barriers: BARRIERS,
    paths: fullPaths,
    branchStats: buildBranchStats(fullPaths),
    distributions: {
      totalPayoff: computeDistribution(fullPaths.map((p) => p.payoff)),
      couponPv: computeDistribution(
        fullPaths.map((p) => round2(p.couponValue + p.memoryCouponValue)),
      ),
      putPv: computeDistribution(fullPaths.map((p) => p.putValue)),
      worstOfFinal: computeDistribution(
        fullPaths.map((p) => {
          const idx = p.knockOutDateIndex ?? OBSERVATIONS - 1
          return round2(p.worstOfPerformance[idx]! * 100)
        }),
      ),
    },
  }
}

export const simulationBundle = generateSimulationBundle()
