// rigaRequestStore (§9.1): one composed request, a stable selector key, and a
// requestId that increments on any input change (trade, market, config).

import { beforeEach, describe, expect, it } from 'vitest'
import { composeRigaRequest, useRigaRequestStore } from '../rigaRequestStore'
import { useRigaMarketStore } from '../rigaMarketStore'
import { useRigaTradeStore } from '../rigaTradeStore'
import { useObservabilityStore } from '../observabilityStore'
import { useTacMarketStore } from '../tacMarketStore'
import { preloadTacMarket, resetTranscripts } from '../../tests/mocks/transcripts'
import { effectiveRigaMarket } from '../../features/tac/mapping'
import { applyManipulations } from '../../features/tac/manipulations'

beforeEach(() => {
  useRigaMarketStore.getState().resetMarket()
  useRigaTradeStore.getState().resetTrade()
  useObservabilityStore.getState().setLevel('sampled')
  resetTranscripts()
})

describe('composeRigaRequest', () => {
  it('carries the trace level from the observability store', () => {
    useObservabilityStore.getState().setLevel('full')
    expect(composeRigaRequest().config.traceLevel).toBe('full')
    useObservabilityStore.getState().setLevel('off')
    expect(composeRigaRequest().config.traceLevel).toBe('off')
  })

  it('treats a pure market change as a new request key', () => {
    useRigaRequestStore.getState().refresh()
    const before = useRigaRequestStore.getState()
    useRigaMarketStore.getState().updateMarket({ spots: [250, 265] })
    const after = useRigaRequestStore.getState()
    expect(after.key).not.toBe(before.key)
    expect(after.requestId).toBeGreaterThan(before.requestId)
  })
})

describe('effectiveRigaMarket', () => {
  it('maps the effective tac market onto the riga snapshot', () => {
    preloadTacMarket()
    const tac = useTacMarketStore.getState()
    const effective = applyManipulations(tac.raw, [])
    const base = useRigaMarketStore.getState().market
    const mapped = effectiveRigaMarket(base, effective)
    // Spot comes from the tac snapshot, correlation from the tac matrix.
    expect(mapped.spots[0]).toBeCloseTo(tac.raw.snapshots.ADBE.price, 3)
    expect(mapped.spots[1]).toBeCloseTo(tac.raw.snapshots.AMZN.price, 3)
    expect(mapped.correlation[0]![1]).toBeCloseTo(tac.raw.correlations!.matrix[0]![1]!, 6)
    // Vol comes from the front ATM read of the surface.
    expect(mapped.vols[0]).toBeGreaterThan(0)
  })

  it('falls back to base when there is no fetch', () => {
    useTacMarketStore.setState({ raw: { bars: {}, snapshots: {}, volSurfaces: {}, fx: {}, fxVol: {}, corporateActions: [], ta: {}, sp: {}, coverage: [] }, manipulations: [] })
    const base = useRigaMarketStore.getState().market
    expect(effectiveRigaMarket(base, useTacMarketStore.getState().raw)).toEqual(base)
  })
})
