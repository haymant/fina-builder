// Reactivity + debounce (§9.2/§9.3, §14.1): a pure market-data change must
// re-run the risk / valuation / ledger hooks, and rapid edits must coalesce.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRigaLedger, useRigaRiskNet, useRigaValuationExplain } from '../hooks'
import { useRigaMarketStore } from '../../../store/rigaMarketStore'
import { installRigaTranscript, resetTranscripts, type CallRecorder } from '../../../tests/mocks/transcripts'

let recorder: CallRecorder

function count(recorder: CallRecorder, tool: string): number {
  return recorder.calls.filter((call) => call.tool === tool).length
}

beforeEach(() => {
  vi.useFakeTimers()
  recorder = installRigaTranscript()
  useRigaMarketStore.getState().resetMarket()
})
afterEach(() => {
  resetTranscripts()
  vi.useRealTimers()
})

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
}

describe('riga reactivity', () => {
  it('re-runs risk, valuation and ledger when only the market changes', async () => {
    const { result } = renderHook(() => ({
      risk: useRigaRiskNet(),
      valuation: useRigaValuationExplain(),
      ledger: useRigaLedger(),
    }))
    await settle()
    expect(result.current.risk.data).toBeTruthy()
    expect(result.current.valuation.data).toBeTruthy()
    expect(result.current.ledger.data).toBeTruthy()

    const baseline = {
      risk: count(recorder, 'query_risk_net'),
      valuation: count(recorder, 'valuation_explain'),
      ledger: count(recorder, 'get_ledger'),
    }

    // A pure market-data change (no trade edit).
    await act(async () => {
      useRigaMarketStore.getState().updateMarket({ vols: [0.5, 0.42] })
    })
    await settle()

    expect(count(recorder, 'query_risk_net')).toBeGreaterThan(baseline.risk)
    expect(count(recorder, 'valuation_explain')).toBeGreaterThan(baseline.valuation)
    expect(count(recorder, 'get_ledger')).toBeGreaterThan(baseline.ledger)
  })

  it('coalesces rapid market edits into one call (debounce)', async () => {
    const { result } = renderHook(() => useRigaRiskNet())
    await settle()
    const baseline = count(recorder, 'query_risk_net')

    await act(async () => {
      for (let i = 0; i < 7; i++) {
        useRigaMarketStore.getState().updateMarket({ spots: [239 + i, 260 + i] })
      }
    })
    await settle()

    expect(count(recorder, 'query_risk_net') - baseline).toBe(1)
    expect(result.current.data).toBeTruthy()
  })
})
