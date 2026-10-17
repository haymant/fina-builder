// P5 — every fixture tool must carry the live composed `request` (docs/46 §7.1),
// so the engine prices what the tiles show rather than the on-disk fixture.
// `health` takes no params; `price_trade` already carries the request itself.

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRigaHealth, useRigaLedger, useRigaRiskBatch, useRigaTradePrice } from '../hooks'
import { useRigaTradeStore } from '../../../store/rigaTradeStore'
import {
  installRigaTranscript,
  resetTranscripts,
  type CallRecorder,
} from '../../../tests/mocks/transcripts'

let recorder: CallRecorder

beforeEach(() => {
  vi.useFakeTimers()
  recorder = installRigaTranscript()
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

function latestArgs(tool: string): Record<string, unknown> | undefined {
  return recorder.calls.filter((call) => call.tool === tool).at(-1)?.args as
    | Record<string, unknown>
    | undefined
}

type RequestShape = { trade: { strike: number }; market: { spots: number[] } }

describe('riga fixture-request injection', () => {
  it('sends the composed request to get_ledger', async () => {
    renderHook(() => useRigaLedger())
    await settle()
    const args = latestArgs('get_ledger')
    expect(args?.request).toBeTruthy()
    const request = args?.request as RequestShape
    expect(request.trade).toBeTruthy()
    expect(request.market?.spots).toHaveLength(2)
  })

  it('sends the request to risk_batch and follows a trade edit', async () => {
    renderHook(() => useRigaRiskBatch())
    await settle()
    const before = (latestArgs('risk_batch')?.request as RequestShape).trade.strike

    await act(async () => {
      useRigaTradeStore.getState().updateTrade({ strike: 0.5 })
    })
    await settle()

    const after = (latestArgs('risk_batch')?.request as RequestShape).trade.strike
    expect(after).toBe(0.5)
    expect(after).not.toBe(before)
  })

  it('does not send a request to health (no params)', async () => {
    renderHook(() => useRigaHealth())
    await settle()
    expect(latestArgs('health')).toEqual({})
  })

  it('leaves price_trade carrying exactly one request', async () => {
    renderHook(() => useRigaTradePrice())
    await settle()
    const args = latestArgs('price_trade')
    expect(Object.keys(args ?? {})).toEqual(['request'])
  })
})
