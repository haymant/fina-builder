// Coupon-strip helpers for the Diagram 1 view. The engine returns the nominal
// ledger (`couponLedger`); these functions only map steps→periods, label the
// schedule frequency and roll up totals, so the tile has no accounting logic of
// its own.

import type { CouponLedgerRow } from '../types'

/** The engine's step→period mapping: `floor(step * periods / steps)`. */
export function periodForStep(step: number, steps: number, periods: number): number {
  if (steps <= 0 || periods <= 0 || !Number.isFinite(step)) return 0
  return Math.min(Math.floor((step * periods) / steps), periods - 1)
}

/** Human label for the coupon frequency implied by the schedule. */
export function couponFrequencyLabel(periods: number, maturityYears: number): string {
  if (!Number.isFinite(maturityYears) || maturityYears <= 0 || periods <= 0) return `${periods} periods`
  const perYear = periods / maturityYears
  const known: Array<[number, string]> = [
    [365, 'daily'],
    [252, 'daily (252)'],
    [52, 'weekly'],
    [12, 'monthly'],
    [4, 'quarterly'],
    [2, 'semi-annual'],
    [1, 'annual'],
  ]
  for (const [value, label] of known) {
    if (Math.abs(perYear - value) <= value * 0.08) return `${label} · ${periods} periods`
  }
  return `${perYear.toFixed(1)} periods/yr · ${periods} periods`
}

/** Period-end calendar date from the snapshot's as-of date and the year offset. */
export function periodEndDate(asOf: string | null | undefined, years: number): string {
  const base = asOf ? Date.parse(asOf) : Number.NaN
  if (Number.isNaN(base) || !Number.isFinite(years)) return '—'
  return new Date(base + years * 365.25 * 86_400_000).toISOString().slice(0, 10)
}

/** Rows up to the path's termination (the engine zeroes later periods). */
export function activeLedger(ledger: readonly CouponLedgerRow[] | undefined): CouponLedgerRow[] {
  return (ledger ?? []).filter((row) => row.years > 0 || row.paid > 0 || row.memoryAccrued > 0)
}

export interface CouponTotals {
  paid: number
  memory: number
  pv: number
  periodsPaid: number
}

export function couponTotals(rows: readonly CouponLedgerRow[]): CouponTotals {
  return rows.reduce<CouponTotals>(
    (totals, row) => ({
      paid: totals.paid + row.paid,
      memory: totals.memory + row.memoryPaid,
      pv: totals.pv + row.pv,
      periodsPaid: totals.periodsPaid + (row.paid > 0 ? 1 : 0),
    }),
    { paid: 0, memory: 0, pv: 0, periodsPaid: 0 },
  )
}
