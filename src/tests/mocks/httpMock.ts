// MSW handlers for the HTTP transport under test (§6.2).
//
// The default handler **throws** for un-stubbed commands, so a missing mock
// fails loudly instead of silently returning `undefined`. Tests stub specific
// commands with `server.use(...)`.

import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { golden } from './goldenBundle'

export const server = setupServer(
  http.post('http://127.0.0.1:8787/api/cmd/generate_paths', () =>
    HttpResponse.json(golden().simulationBundle),
  ),
  // The streaming endpoint the transport's `generatePaths` uses.
  http.post('http://127.0.0.1:8787/api/stream/generate_paths', () => {
    const progress = { phase: 'generate_series', completed: 100, total: 100, message: 'done' }
    const body = `data: ${JSON.stringify(progress)}\n\ndata: ${JSON.stringify(golden().simulationBundle)}\n\n`
    return HttpResponse.text(body, {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }),
  http.post('http://127.0.0.1:8787/api/cmd/get_path', async ({ request }) => {
    const body = (await request.json()) as { pathIndex?: number }
    const index = body.pathIndex ?? 1
    const path = golden().simulationBundle.paths.find((p) => p.pathIndex === index)
    return path ? HttpResponse.json(path) : HttpResponse.json({ code: 'PATH_OUT_OF_RANGE', message: `path index ${index} out of range (bundle has ${golden().simulationBundle.paths.length})` }, { status: 404 })
  }),
  http.post('http://127.0.0.1:8787/api/cmd/get_branch_stats', () =>
    HttpResponse.json(golden().simulationBundle.branchStats),
  ),
  http.post('http://127.0.0.1:8787/api/cmd/get_distributions', () =>
    HttpResponse.json(golden().simulationBundle.distributions),
  ),
  http.post('http://127.0.0.1:8787/api/cmd/compute_trade_analytics', () =>
    HttpResponse.json(golden().trade.analytics),
  ),
  http.post('http://127.0.0.1:8787/api/cmd/compute_risk', () =>
    HttpResponse.json(golden().risk.base),
  ),
  http.post('http://127.0.0.1:8787/api/cmd/get_mc_diagnostics', () =>
    HttpResponse.json({
      points: golden().mc.mcDiagnostics,
      efficiency: golden().mc.mcEfficiency,
      final: golden().mc.finalMC,
    }),
  ),
  http.post('http://127.0.0.1:8787/api/cmd/build_cashflows', () =>
    HttpResponse.json(cashflowResponse()),
  ),
  http.post('http://127.0.0.1:8787/api/cmd/valuation_explain', () =>
    HttpResponse.json(valuationResponse()),
  ),
  http.post('http://127.0.0.1:8787/api/cmd/explain_ledger', () =>
    HttpResponse.json({
      entries: [
        { id: 'cashflow-coupon', timestamp: '2026-01-15', source: 'cashflow', category: 'coupon', contribution: 2, currency: 'USD', description: 'Realized coupon cashflows' },
      ],
      reconciliation: {
        totalMarket: 1.468,
        totalPLVA: 1.0000000000000002,
        totalCashflow: 2,
        totalValuation: -18.11,
        totalRisk: 0,
        explained: -13.642,
        actualPnL: 1.7999999999999972,
        residual: 15.441999999999997,
      },
    }),
  ),
  http.post('http://127.0.0.1:8787/api/cmd/execution_events', () =>
    HttpResponse.json([]),
  ),
  http.post('*/api/cmd/:command', () =>
    HttpResponse.json(
      { code: 'UNKNOWN_COMMAND', message: 'no mock registered for this command' },
      { status: 400 },
    ),
  ),
)

export const NODE_MSG = 'node: http handler'

/// The §5.0 `build_cashflows` envelope from the golden cashflow section; the
/// analytics fields the fixture does not carry are the documented Phase 4
/// values. Shared by the MSW handler and the parity test so both transports
/// serve identical objects.
export function cashflowResponse(): Record<string, unknown> {
  const cf = golden().cashflow
  const notional = 100
  const presentValue = cf.presentValue
  const mtm = presentValue - notional
  return {
    cashflows: cf.rows,
    analytics: {
      grossCashflow: cf.grossCashflow,
      presentValue,
      realized: cf.realized,
      future: cf.grossCashflow - cf.realized,
      realizedPnL: 0,
      unrealizedPnL: mtm,
      mtmPnL: mtm,
      carryPnL: 12.04,
      totalPnL: 6.93,
    },
  }
}

/// The full `valuation_explain` wire shape: the fixture carries previousPV /
/// currentPV / taylor / plva / plvaPnL, and `state` is the documented Phase 4
/// double-pinned object.
export function valuationResponse(): Record<string, unknown> {
  const v = golden().valuation
  return {
    previousPV: v.previousPV,
    currentPV: v.currentPV,
    taylor: v.taylor,
    plva: (v as unknown as { plva: unknown[] }).plva ?? [],
    plvaPnL: v.plvaPnL,
    state: {
      previousPV: v.previousPV,
      currentPV: v.currentPV,
      marketExplainedPnL: v.taylor.predicted,
      plvaPnL: v.plvaPnL,
      residualPnL: -0.8860000000000035,
      totalPnL: 1.7999999999999972,
    },
  }
}
