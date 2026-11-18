// Fixing-marker geometry: KO is engine-reported (nearest fixing), KI is derived
// (first breach), and the post-KO tail is hypothetical (split).

import { describe, expect, it } from 'vitest'
import { firstStepBelow, nearestFixingStep, splitAtStep } from '../data/pathMarkers'

const points = [
  { time: 0, years: 0, worstOf: 1 },
  { time: 1, years: 0.1, worstOf: 0.95 },
  { time: 2, years: 0.2, worstOf: 0.65 },
  { time: 3, years: 0.3, worstOf: 0.72 },
  { time: 4, years: 0.4, worstOf: 0.55 },
]

describe('path markers', () => {
  it('snaps an engine-reported KO time to the nearest fixing', () => {
    expect(nearestFixingStep(points, 0.21)).toBe(2)
    expect(nearestFixingStep(points, 0.38)).toBe(4)
    expect(nearestFixingStep(points, Number.NaN)).toBeNull()
    expect(nearestFixingStep([], 0.2)).toBeNull()
  })

  it('derives the first KI breach from the series and barrier', () => {
    expect(firstStepBelow(points, 0.7)).toBe(2)
    expect(firstStepBelow(points, 0.6)).toBe(4)
    expect(firstStepBelow(points, 0.1)).toBeNull()
    expect(firstStepBelow(points, null)).toBeNull()
  })

  it('splits at the KO fixing and keeps it on both halves', () => {
    const { before, after } = splitAtStep(points, 2)
    expect(before).toHaveLength(3)
    expect(after).toHaveLength(3)
    expect(before.at(-1)).toBe(points[2])
    expect(after[0]).toBe(points[2])
    // Alive path → one solid series; KO on the final fixing → no tail.
    expect(splitAtStep(points, null).after).toHaveLength(0)
    expect(splitAtStep(points, 4).after).toHaveLength(0)
    expect(splitAtStep([], 0)).toEqual({ before: [], after: [] })
  })
})
