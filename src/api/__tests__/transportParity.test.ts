// Frontend mirror of invariant I-3 (§6.2): the same request must produce the
// identical object through both transports — the Tauri mock and MSW both serve
// the golden baseline, so the two implementations cannot drift apart.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { tauriTransport } from '../tauriTransport'
import { httpTransport } from '../httpTransport'
import { invoke } from '../../tests/mocks/tauriMock'
import { server } from '../../tests/mocks/httpMock'
import { golden } from '../../tests/mocks/goldenBundle'
import { cashflowResponse, valuationResponse } from '../../tests/mocks/httpMock'
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterAll(() => server.close())

describe('transport parity (I-3)', () => {
  beforeEach(() => vi.resetAllMocks())

  // The Tauri mock serves exactly what the MSW handlers serve, per command —
  // so both transports must return identical objects.
  const tauriStub = (cmd: string, req: unknown): unknown => {
    const g = golden()
    const request = (req ?? {}) as { pathIndex?: number; trade?: unknown; market?: unknown }
    switch (cmd) {
      case 'get_path': {
        const index = request.pathIndex ?? 1
        return g.simulationBundle.paths.find((p) => p.pathIndex === index)
      }
      case 'get_branch_stats':
        return g.simulationBundle.branchStats
      case 'get_distributions':
        return g.simulationBundle.distributions
      case 'compute_risk':
        return g.risk.base
      case 'get_mc_diagnostics':
        return { points: g.mc.mcDiagnostics, efficiency: g.mc.mcEfficiency, final: g.mc.finalMC }
      case 'build_cashflows':
        return cashflowResponse()
      case 'valuation_explain':
        return valuationResponse()
      default:
        throw new Error(`unmocked tauri command: ${cmd}`)
    }
  }

  const cases: Array<{ command: string; request: unknown }> = [
    { command: 'get_path', request: { pathIndex: 1 } },
    { command: 'get_branch_stats', request: {} },
    { command: 'get_distributions', request: {} },
    { command: 'compute_risk', request: { trade: {}, market: {} } },
    { command: 'get_mc_diagnostics', request: {} },
    { command: 'build_cashflows', request: { trade: {}, pathIndex: 1 } },
    { command: 'valuation_explain', request: { trade: {}, market: {}, pathIndex: 1, asOf: '2026-01-15' } },
  ]

  for (const { command, request } of cases) {
    it(`${command}: tauri === http`, async () => {
      vi.mocked(invoke).mockImplementation(async (cmd: string, args: Record<string, unknown> | undefined) =>
        tauriStub(cmd, args?.req),
      )
      const viaTauri = await tauriTransport.call(command, request)
      const viaHttp = await httpTransport.call(command, request)
      expect(viaTauri).toEqual(viaHttp)
    })
  }

  it('both transports deliver the same bundle for generate_paths', async () => {
    // MSW serves the golden bundle; make the tauri mock serve the same object.
    vi.mocked(invoke).mockResolvedValue(golden().simulationBundle)
    const viaTauri = await tauriTransport.call('generate_paths', { config: {} })
    const viaHttp = await httpTransport.call('generate_paths', { config: {} })
    expect(viaTauri).toEqual(viaHttp)
    expect(viaHttp).toEqual(golden().simulationBundle)
  })
})