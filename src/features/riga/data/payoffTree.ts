// The Phoenix terminal-outcome tree from `PheonixPayoff.md` Diagram 2, expressed
// as a Petri net: places are states (paths, coupon leg, intermediate gates and
// the P01–P08 payoff buckets), transitions are the decisions that move a path
// between them.
//
// Traversal is not path-only. Three determinants are kept separate so the view
// can show them honestly:
//   1. the trade's rails decide which terminal buckets are reachable at all;
//   2. the population decides how many paths flow through each arc;
//   3. the selected path decides which single route is traced.
// This module owns (1) and (3); the tile overlays (2) from
// `query_execution_net` and never invents a split the engine does not report.

import type { PathRecord } from '../types'

/** The Murex sentinel for a disabled call strike / barrier. */
export const DISABLED_STRIKE = 900

export type KoKind = 'global' | 'local' | 'none'

/** The terminal bucket a KO lands in: P01/P02 with memory, P03/P04 without. */
export function koPayoffId(kind: KoKind, memory: boolean): PayoffId | null {
  if (kind === 'none') return null
  if (kind === 'global') return memory ? 'P01' : 'P03'
  return memory ? 'P02' : 'P04'
}

export type PayoffId = 'P01' | 'P02' | 'P03' | 'P04' | 'P05' | 'P06' | 'P07' | 'P08'

export const PAYOFF_LABELS: Record<PayoffId, string> = {
  P01: 'P01 Global Memory KO',
  P02: 'P02 Local Memory KO',
  P03: 'P03 Global KO',
  P04: 'P04 Local KO',
  P05: 'P05 Call region',
  P06: 'P06 KI above maturity barrier',
  P07: 'P07 KI below maturity barrier',
  P08: 'P08 No-KI region',
}

/** The trade rails that decide which branches exist (not which path took one). */
export interface PayoffRails {
  /** The reachable KO bucket, or null when the trade has no knock-out. */
  koPayoffId: PayoffId | null
  /** Lower call strike, or null when it is disabled (P05 unreachable). */
  callStrike: number | null
  knockInBarrier: number
  /** Maturity barrier, or null when disabled (every KI is "above"). */
  maturityBarrier: number | null
}

/** Which terminal buckets this trade can reach, independent of any path. */
export function reachableTerminals(rails: PayoffRails): Record<PayoffId, boolean> {
  const above = rails.maturityBarrier === null ? true : rails.maturityBarrier <= rails.knockInBarrier
  return {
    P01: rails.koPayoffId === 'P01',
    P02: rails.koPayoffId === 'P02',
    P03: rails.koPayoffId === 'P03',
    P04: rails.koPayoffId === 'P04',
    P05: rails.callStrike !== null,
    P06: above,
    P07: rails.maturityBarrier !== null,
    P08: true,
  }
}

export interface PayoffRoute {
  payoffId: PayoffId
  /** The tree arcs this path crossed, in order (edge ids from PAYOFF_TREE). */
  edges: string[]
}

/**
 * The single route a path took, derived from its terminal state (`knockedOut`,
 * `kiHit`, `worstFinal`) and the trade rails. The engine does not return a
 * per-path gate trace, so this is the finest decomposition that is provable —
 * the coupon leg and the gates it skipped are constant across paths.
 */
export function resolvePayoffRoute(
  path: Pick<PathRecord, 'knockedOut' | 'kiHit' | 'worstFinal'> | null,
  rails: PayoffRails,
): PayoffRoute | null {
  if (!path) return null
  const edges = ['paths->coupon_leg', 'coupon_leg->coupon', 'coupon->ko_event']
  if (path.knockedOut && rails.koPayoffId !== null) {
    return { payoffId: rails.koPayoffId, edges: [...edges, `ko_event->${rails.koPayoffId}`] }
  }
  edges.push('ko_event->no_ko', 'no_ko->call_check')
  if (rails.callStrike !== null && path.worstFinal >= rails.callStrike) {
    return { payoffId: 'P05', edges: [...edges, 'call_check->P05'] }
  }
  edges.push('call_check->below_call', 'below_call->ki_check')
  if (!path.kiHit) return { payoffId: 'P08', edges: [...edges, 'ki_check->P08'] }
  edges.push('ki_check->ki', 'ki->maturity_barrier_check')
  return rails.maturityBarrier !== null && path.worstFinal >= rails.maturityBarrier
    ? { payoffId: 'P06', edges: [...edges, 'maturity_barrier_check->P06'] }
    : { payoffId: 'P07', edges: [...edges, 'maturity_barrier_check->P07'] }
}

export interface PayoffTreeNode {
  id: string
  kind: 'place' | 'transition'
  label: string
  position: { x: number; y: number }
  /** Terminal payoff buckets carry `P01`…`P08`. */
  payoffId?: PayoffId
}

export type PayoffPopulation = 'ko' | 'survive' | 'ki' | 'no-ki'

export interface PayoffTreeEdge {
  id: string
  from: string
  to: string
  /** The population the engine reports for this arc, when it reports one. */
  population?: PayoffPopulation
}

const COL = 165
const ROW = 72
const at = (col: number, row: number) => ({ x: col * COL, y: row * ROW })

const nodes: PayoffTreeNode[] = [
  { id: 'paths', kind: 'place', label: 'Paths', position: at(0, 3) },
  { id: 'coupon_leg', kind: 'transition', label: 'Coupon leg (C01–C03)', position: at(1, 3) },
  { id: 'coupon', kind: 'place', label: 'Coupon', position: at(2, 3) },
  { id: 'ko_event', kind: 'transition', label: 'KO event?', position: at(3, 3) },
  { id: 'P01', kind: 'place', label: PAYOFF_LABELS.P01, position: at(4, 0), payoffId: 'P01' },
  { id: 'P02', kind: 'place', label: PAYOFF_LABELS.P02, position: at(4, 1.5), payoffId: 'P02' },
  { id: 'P03', kind: 'place', label: PAYOFF_LABELS.P03, position: at(4, 3), payoffId: 'P03' },
  { id: 'P04', kind: 'place', label: PAYOFF_LABELS.P04, position: at(4, 4.5), payoffId: 'P04' },
  { id: 'no_ko', kind: 'place', label: 'No KO', position: at(4, 6) },
  { id: 'call_check', kind: 'transition', label: 'WPS ≥ call strike?', position: at(5, 6) },
  { id: 'P05', kind: 'place', label: PAYOFF_LABELS.P05, position: at(6, 4.75), payoffId: 'P05' },
  { id: 'below_call', kind: 'place', label: 'Below call', position: at(6, 7.4) },
  { id: 'ki_check', kind: 'transition', label: 'Knock-in?', position: at(7, 7.4) },
  { id: 'P08', kind: 'place', label: PAYOFF_LABELS.P08, position: at(8, 6), payoffId: 'P08' },
  { id: 'ki', kind: 'place', label: 'KI hit', position: at(8, 8.8) },
  { id: 'maturity_barrier_check', kind: 'transition', label: 'WPS ≥ maturity barrier?', position: at(9, 8.8) },
  { id: 'P06', kind: 'place', label: PAYOFF_LABELS.P06, position: at(10, 7.5), payoffId: 'P06' },
  { id: 'P07', kind: 'place', label: PAYOFF_LABELS.P07, position: at(10, 9.4), payoffId: 'P07' },
]

const edges: PayoffTreeEdge[] = [
  { id: 'paths->coupon_leg', from: 'paths', to: 'coupon_leg' },
  { id: 'coupon_leg->coupon', from: 'coupon_leg', to: 'coupon' },
  { id: 'coupon->ko_event', from: 'coupon', to: 'ko_event' },
  { id: 'ko_event->P01', from: 'ko_event', to: 'P01', population: 'ko' },
  { id: 'ko_event->P02', from: 'ko_event', to: 'P02', population: 'ko' },
  { id: 'ko_event->P03', from: 'ko_event', to: 'P03', population: 'ko' },
  { id: 'ko_event->P04', from: 'ko_event', to: 'P04', population: 'ko' },
  { id: 'ko_event->no_ko', from: 'ko_event', to: 'no_ko', population: 'survive' },
  { id: 'no_ko->call_check', from: 'no_ko', to: 'call_check' },
  { id: 'call_check->P05', from: 'call_check', to: 'P05' },
  { id: 'call_check->below_call', from: 'call_check', to: 'below_call' },
  { id: 'below_call->ki_check', from: 'below_call', to: 'ki_check' },
  { id: 'ki_check->P08', from: 'ki_check', to: 'P08', population: 'no-ki' },
  { id: 'ki_check->ki', from: 'ki_check', to: 'ki', population: 'ki' },
  { id: 'ki->maturity_barrier_check', from: 'ki', to: 'maturity_barrier_check' },
  { id: 'maturity_barrier_check->P06', from: 'maturity_barrier_check', to: 'P06' },
  { id: 'maturity_barrier_check->P07', from: 'maturity_barrier_check', to: 'P07' },
]

export const PAYOFF_TREE: { nodes: PayoffTreeNode[]; edges: PayoffTreeEdge[] } = { nodes, edges }
