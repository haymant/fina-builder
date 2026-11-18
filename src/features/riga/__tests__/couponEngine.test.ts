// Coupon-strip helpers: step→period mapping, frequency label, dates, totals.

import { describe, expect, it } from 'vitest'
import {
  activeLedger,
  couponFrequencyLabel,
  couponTotals,
  periodEndDate,
  periodForStep,
} from '../data/couponEngine'
import type { CouponLedgerRow } from '../types'

const row = (overrides: Partial<CouponLedgerRow> = {}): CouponLedgerRow => ({
  period: 0,
  years: 0.25,
  qualifiedSteps: 1,
  periodSteps: 1,
  accrual: 0.01,
  memoryPaid: 0,
  paid: 0.01,
  memoryAccrued: 0,
  discountFactor: 0.99,
  pv: 0.0099,
  knockedOut: false,
  ...overrides,
})

describe('coupon engine helpers', () => {
  it('maps a fixing step onto its coupon period like the engine does', () => {
    // 9 fixings over 9 periods: one per period.
    expect(periodForStep(0, 9, 9)).toBe(0)
    expect(periodForStep(8, 9, 9)).toBe(8)
    // 105 fixings over 5 periods: 21 steps each.
    expect(periodForStep(0, 105, 5)).toBe(0)
    expect(periodForStep(20, 105, 5)).toBe(0)
    expect(periodForStep(21, 105, 5)).toBe(1)
    expect(periodForStep(104, 105, 5)).toBe(4)
    // Out-of-range steps clamp to the last period.
    expect(periodForStep(999, 105, 5)).toBe(4)
  })

  it('labels the schedule frequency', () => {
    expect(couponFrequencyLabel(9, 0.75)).toBe('monthly · 9 periods')
    expect(couponFrequencyLabel(4, 1)).toBe('quarterly · 4 periods')
    expect(couponFrequencyLabel(2, 1)).toBe('semi-annual · 2 periods')
    expect(couponFrequencyLabel(1, 1)).toBe('annual · 1 periods')
    expect(couponFrequencyLabel(252, 1)).toBe('daily (252) · 252 periods')
  })

  it('derives period-end dates from the snapshot as-of', () => {
    expect(periodEndDate('2026-09-07', 0)).toBe('2026-09-07')
    expect(periodEndDate('2026-09-07', 0.25)).toMatch(/^2026-12-0/)
    expect(periodEndDate(undefined, 0.25)).toBe('—')
    expect(periodEndDate('2026-09-07', Number.NaN)).toBe('—')
  })

  it('drops periods after termination and totals the strip', () => {
    const rows = [row(), row({ period: 1, paid: 0.02, memoryPaid: 0.005, pv: 0.019 }), row({ period: 2, years: 0, paid: 0, pv: 0 })]
    expect(activeLedger(rows).map((entry) => entry.period)).toEqual([0, 1])
    const totals = couponTotals(activeLedger(rows))
    expect(totals.paid).toBeCloseTo(0.03)
    expect(totals.memory).toBeCloseTo(0.005)
    expect(totals.pv).toBeCloseTo(0.0289)
    expect(totals.periodsPaid).toBe(2)
    expect(activeLedger(undefined)).toEqual([])
  })
})
