// Trade-edit propagation (the "trade economics is watched" contract): editing
// the trade — directly or through the instrument document — must reach EVERY
// tile's tool call as the new `request`.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useRigaAttribution,
  useRigaBranchStats,
  useRigaDistributions,
  useRigaExecutionNet,
  useRigaExecutionTape,
  useRigaLedger,
  useRigaMcDiagnostics,
  useRigaPathCube,
  useRigaPlExplain,
  useRigaRiskBatch,
  useRigaRiskNet,
  useRigaScenario,
  useRigaStressBands,
  useRigaTradePrice,
  useRigaValidateGreeks,
  useRigaValuationExplain,
} from '../hooks'
import { useRigaTradeStore } from '../../../store/rigaTradeStore'
import { useInstrumentStore } from '../../../store/instrumentStore'
import { useObservabilityStore } from '../../../store/observabilityStore'
import {
  installRigaTranscript,
  resetTranscripts,
  type CallRecorder,
} from '../../../tests/mocks/transcripts'

/** Every tile that watches the trade, and the riga-mcp tool it calls. */
const WATCHERS: Array<[string, () => unknown]> = [
  ['get_ledger', useRigaLedger],
  ['query_risk_net', useRigaRiskNet],
  ['query_execution_net', useRigaExecutionNet],
  ['get_branch_stats', useRigaBranchStats],
  ['get_distributions', useRigaDistributions],
  ['get_mc_diagnostics', useRigaMcDiagnostics],
  ['explain_pv_attribution', useRigaAttribution],
  ['risk_batch', useRigaRiskBatch],
  ['scenario', useRigaScenario],
  ['validate_greeks', useRigaValidateGreeks],
  ['recommend_scenarios', useRigaStressBands],
  ['query_path_cube', () => useRigaPathCube(0.05)],
  ['execution_events', () => useRigaExecutionTape(16)],
  ['price_trade', useRigaTradePrice],
  ['pl_explain', useRigaPlExplain],
  ['valuation_explain', useRigaValuationExplain],
]

let recorder: CallRecorder

beforeEach(() => {
  vi.useFakeTimers()
  recorder = installRigaTranscript()
  useObservabilityStore.getState().setLevel('full')
  localStorage.removeItem('fina-instrument')
  useRigaTradeStore.getState().resetTrade()
  useInstrumentStore.getState().reset()
})
afterEach(() => {
  resetTranscripts()
  vi.useRealTimers()
})

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
}

function lastRequestTrade(tool: string): { strike?: number; knockInBarrier?: number } | undefined {
  const call = recorder.calls.filter((c) => c.tool === tool).at(-1)
  return (call?.args as { request?: { trade?: { strike?: number; knockInBarrier?: number } } })
    ?.request?.trade
}

describe('trade edit propagation', () => {
  it('reaches every watching tile with the edited strike', async () => {
    renderHook(() => WATCHERS.map(([, hook]) => hook()))
    await settle()
    // Every watcher has fired once.
    for (const [tool] of WATCHERS) {
      expect(lastRequestTrade(tool), `${tool} did not fire`).toBeTruthy()
    }

    await act(async () => {
      useRigaTradeStore.getState().updateTrade({ strike: 0.42 })
    })
    await settle()

    for (const [tool] of WATCHERS) {
      expect(lastRequestTrade(tool)?.strike, `${tool} did not see the new strike`).toBe(0.42)
    }
  })

  it('propagates an edit made through the instrument document', async () => {
    renderHook(() => WATCHERS.map(([, hook]) => hook()))
    await settle()

    await act(async () => {
      useInstrumentStore.getState().patch('/legs/0/put/strike', 0.33)
      useInstrumentStore.getState().patch('/legs/0/put/knockInBarrier', 0.61)
    })
    await settle()

    for (const [tool] of WATCHERS) {
      expect(lastRequestTrade(tool)?.strike, `${tool} strike`).toBe(0.33)
      expect(lastRequestTrade(tool)?.knockInBarrier, `${tool} barrier`).toBe(0.61)
    }
  })
})
