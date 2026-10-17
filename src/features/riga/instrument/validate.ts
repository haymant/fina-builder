// Structural validation recomputed on every edit (docs/46 §6). Findings are
// surfaced verbatim in the trade tile — never a silent drop and never a
// UI-local pricing rule (the engine remains the authority on validity).

import type { InstrumentDocument, InstrumentIssue } from './schema'

function railIssues(doc: InstrumentDocument): InstrumentIssue[] {
  const out: InstrumentIssue[] = []
  doc.legs.forEach((leg, index) => {
    const rails = leg.put?.rails
    if (!rails) return
    const nonDefault = (key: string, value: unknown, expected: unknown) => {
      if (value !== null && value !== expected) {
        out.push({
          severity: 'warn',
          code: 'engine.unsupported_rail',
          path: `/legs/${index}/put/rails/${key}`,
          message: `${key}=${String(value)} is not modelled by riga-engine (expected ${String(expected)})`,
        })
      }
    }
    nonDefault('PRUp', rails.PRUp, 0)
    nonDefault('PRKI1', rails.PRKI1, 0)
    nonDefault('capKI2', rails.capKI2, false)
    nonDefault('floorKI2', rails.floorKI2, false)
    nonDefault('PRNOKI1', rails.PRNOKI1, 0)
    nonDefault('PRNOKI2', rails.PRNOKI2, 0)
  })
  return out
}

export function validateDocument(doc: InstrumentDocument): InstrumentIssue[] {
  const issues: InstrumentIssue[] = []
  const put = doc.legs.find((leg) => leg.kind === 'put' && leg.put)?.put

  if (!put) {
    issues.push({
      severity: 'error',
      code: 'engine.no_put_leg',
      path: '/legs',
      message: 'no PUT leg; riga-engine prices the put leg only',
    })
    return issues
  }
  if (put.initialSpots.length !== 2) {
    issues.push({
      severity: 'error',
      code: 'engine.factor_count',
      path: '/legs/0/put/initialSpots',
      message: `riga-flow is 2-factor; found ${put.initialSpots.length} initial fixings`,
    })
  }
  if (doc.market.spots.length !== put.initialSpots.length) {
    issues.push({
      severity: 'error',
      code: 'market.spot_count',
      path: '/market/spots',
      message: 'market.spots must align with the put leg initial fixings',
    })
  }
  if (doc.market.correlation.length !== 2 || doc.market.correlation[0]?.length !== 2) {
    issues.push({
      severity: 'warn',
      code: 'market.correlation_shape',
      path: '/market/correlation',
      message: 'correlation must be 2x2 for the 2-factor engine',
    })
  }
  if (!doc.market.asOf || Number.isNaN(Date.parse(doc.market.asOf))) {
    issues.push({
      severity: 'error',
      code: 'market.as_of',
      path: '/market/asOf',
      message: 'market.asOf must be an ISO date; the engine never reads the wall clock',
    })
  }
  if (!(put.maturityYears > 0)) {
    issues.push({
      severity: 'error',
      code: 'engine.maturity',
      path: '/legs/0/put/maturityYears',
      message: 'maturityYears must be > 0',
    })
  }
  issues.push(...railIssues(doc))
  return issues
}
