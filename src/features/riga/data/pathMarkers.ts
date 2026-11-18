// Fixing-marker geometry for the Path Timeline. Kept pure so the chart only
// positions markers; the honesty rules live here:
//   • a KO time is engine-reported (`get_path.ko_time`, years) → nearest fixing;
//   • a KI time is NOT reported, so it is derived as the first fixing below the
//     KI barrier and labelled as such by the tile;
//   • after a knock-out the remaining series is hypothetical → split it.

export interface FixingPoint {
  time: number
  years: number
  worstOf: number
}

/** Index of the fixing closest to `years`, or null for an empty series. */
export function nearestFixingStep(points: readonly FixingPoint[], years: number): number | null {
  if (points.length === 0 || !Number.isFinite(years)) return null
  let best = 0
  let bestDistance = Math.abs(points[0]!.years - years)
  for (let index = 1; index < points.length; index++) {
    const distance = Math.abs(points[index]!.years - years)
    if (distance < bestDistance) {
      best = index
      bestDistance = distance
    }
  }
  return best
}

/** First fixing strictly below `level`, or null when the path never breaches it. */
export function firstStepBelow(points: readonly FixingPoint[], level: number | null | undefined): number | null {
  if (level === null || level === undefined || !Number.isFinite(level)) return null
  for (let index = 0; index < points.length; index++) {
    if (points[index]!.worstOf < level) return index
  }
  return null
}

/**
 * Split the series at a knock-out step. Both halves include the KO fixing so the
 * dashed tail connects to the solid line instead of starting a gap later.
 */
export function splitAtStep(
  points: readonly FixingPoint[],
  step: number | null,
): { before: FixingPoint[]; after: FixingPoint[] } {
  if (points.length === 0) return { before: [], after: [] }
  if (step === null || step >= points.length - 1) return { before: [...points], after: [] }
  return { before: points.slice(0, step + 1), after: points.slice(step) }
}
