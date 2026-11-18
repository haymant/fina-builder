// The payoff tree's three determinants: trade reachability, terminal route.
// These are pure functions so the tile only overlays populations and styling.

import { describe, expect, it } from 'vitest'
import {
  PAYOFF_TREE,
  koPayoffId,
  reachableTerminals,
  resolvePayoffRoute,
  type PayoffRails,
} from '../data/payoffTree'

const rails = (overrides: Partial<PayoffRails> = {}): PayoffRails => ({
  koPayoffId: 'P01',
  callStrike: null,
  knockInBarrier: 0.7,
  maturityBarrier: 0.8,
  ...overrides,
})

const path = (overrides: Partial<{ knockedOut: boolean; kiHit: boolean; worstFinal: number }> = {}) => ({
  knockedOut: false,
  kiHit: false,
  worstFinal: 0.9,
  ...overrides,
})

describe('payoff tree rails', () => {
  it('maps KO kind + memory to the P0x bucket', () => {
    expect(koPayoffId('global', true)).toBe('P01')
    expect(koPayoffId('global', false)).toBe('P03')
    expect(koPayoffId('local', true)).toBe('P02')
    expect(koPayoffId('local', false)).toBe('P04')
    expect(koPayoffId('none', true)).toBeNull()
  })

  it('marks terminal buckets the trade cannot reach', () => {
    const reachable = reachableTerminals(rails())
    expect(reachable.P01).toBe(true)
    expect(reachable.P02).toBe(false)
    expect(reachable.P05).toBe(false) // call strike disabled
    expect(reachable.P06).toBe(false) // maturity barrier above the KI barrier
    expect(reachable.P07).toBe(true)
    expect(reachable.P08).toBe(true)

    const withCall = reachableTerminals(rails({ callStrike: 1, maturityBarrier: 0.6 }))
    expect(withCall.P05).toBe(true)
    expect(withCall.P06).toBe(true)
  })
})

describe('payoff tree route', () => {
  it('returns null without a selected path', () => {
    expect(resolvePayoffRoute(null, rails())).toBeNull()
  })

  it('routes a knocked-out path to its trade KO bucket', () => {
    const route = resolvePayoffRoute(path({ knockedOut: true }), rails({ koPayoffId: 'P02' }))
    expect(route?.payoffId).toBe('P02')
    expect(route?.edges.at(-1)).toBe('ko_event->P02')
    expect(route?.edges).toContain('paths->coupon_leg')
  })

  it('routes the no-KO branches: call, no-KI, KI above/below the maturity barrier', () => {
    expect(resolvePayoffRoute(path({ worstFinal: 1.1 }), rails({ callStrike: 1 }))?.payoffId).toBe('P05')
    expect(resolvePayoffRoute(path({ kiHit: false }), rails())?.payoffId).toBe('P08')
    expect(resolvePayoffRoute(path({ kiHit: true, worstFinal: 0.9 }), rails({ maturityBarrier: 0.8 }))?.payoffId).toBe('P06')
    expect(resolvePayoffRoute(path({ kiHit: true, worstFinal: 0.5 }), rails({ maturityBarrier: 0.8 }))?.payoffId).toBe('P07')
  })

  it('only follows arcs that exist in the tree', () => {
    const ids = new Set(PAYOFF_TREE.edges.map((edge) => edge.id))
    const route = resolvePayoffRoute(path({ kiHit: true, worstFinal: 0.5 }), rails())
    expect(route).not.toBeNull()
    for (const edge of route!.edges) expect(ids.has(edge)).toBe(true)
  })
})
