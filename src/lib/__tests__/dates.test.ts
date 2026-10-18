// The date-format heuristic (src/lib/dates.ts): externally-sourced dates arrive
// as Excel serials, Unix seconds/milliseconds, ISO, `YYYYMMDD`, or ambiguous
// `a/b/yyyy`, with no declared format.

import { describe, expect, it } from 'vitest'
import { formatDateLabel, looksLikeDate, toIsoDate } from '../dates'

describe('toIsoDate', () => {
  it('reads Excel/Murex serials', () => {
    expect(toIsoDate(46419)).toBe('2027-02-01')
    expect(toIsoDate('46419')).toBe('2027-02-01')
    expect(toIsoDate(46419.75)).toBe('2027-02-01') // time-of-day is dropped
  })

  it('reads Unix seconds and milliseconds', () => {
    expect(toIsoDate(1757203200)).toBe('2025-09-07')
    expect(toIsoDate(1757203200000)).toBe('2025-09-07')
  })

  it('reads ISO, YYYY/MM/DD and YYYYMMDD', () => {
    expect(toIsoDate('2026-09-07')).toBe('2026-09-07')
    expect(toIsoDate('2026-09-07T12:00:00Z')).toBe('2026-09-07')
    expect(toIsoDate('2026/09/07')).toBe('2026-09-07')
    expect(toIsoDate(20260907)).toBe('2026-09-07')
  })

  it('reads DD-Mon-YYYY', () => {
    expect(toIsoDate('07-Sep-2026')).toBe('2026-09-07')
    expect(toIsoDate('7 Sep 2026')).toBe('2026-09-07')
  })

  it('resolves ambiguous a/b/yyyy (US by default, day-first on request)', () => {
    expect(toIsoDate('09/07/2026')).toBe('2026-09-07') // MM/DD
    expect(toIsoDate('07/09/2026')).toBe('2026-07-09')
    expect(toIsoDate('07/09/2026', { dayFirst: true })).toBe('2026-09-07')
    // Unambiguous cases ignore the flag.
    expect(toIsoDate('13/09/2026')).toBe('2026-09-13')
    expect(toIsoDate('09/13/2026')).toBe('2026-09-13')
  })

  it('returns null for empty or non-date input', () => {
    for (const value of [null, undefined, '', '   ', 'not a date', 42, {}, []]) {
      expect(toIsoDate(value), String(value)).toBeNull()
    }
  })

  it('rejects impossible calendar dates', () => {
    expect(toIsoDate('2026-02-30')).toBeNull()
    expect(toIsoDate('2026-13-01')).toBeNull()
  })

  it('looksLikeDate mirrors toIsoDate', () => {
    expect(looksLikeDate('2026-09-07')).toBe(true)
    expect(looksLikeDate('nope')).toBe(false)
  })

  it('formats a date label compactly and passes non-dates through', () => {
    // The tac vol-surface maturities are Excel serials.
    expect(formatDateLabel(46318)).toBe('23 Oct 26')
    expect(formatDateLabel(46311)).toBe('16 Oct 26')
    expect(formatDateLabel('2026-10-16')).toBe('16 Oct 26')
    // Tenors / year-fractions are not dates and must stay verbatim.
    expect(formatDateLabel('3M')).toBe('3M')
    expect(formatDateLabel(0.25)).toBe('0.25')
    expect(formatDateLabel(1)).toBe('1')
    expect(formatDateLabel(null)).toBe('')
  })
})
