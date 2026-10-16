// Composes the live riga-flow `PriceRequest` from the trade, market, effective
// tac-engine market and observability config (§9.1). The **stable selector key**
// (`JSON.stringify(request)`) is what the hooks depend on, so any change to any
// input re-runs every affected tile — including a pure market-data change.

import { create } from 'zustand'
import type { RigaPriceRequest } from '../features/riga/types'
import { applyManipulations } from '../features/tac/manipulations'
import { effectiveRigaMarket } from '../features/tac/mapping'
import { useRigaTradeStore } from './rigaTradeStore'
import { useRigaMarketStore } from './rigaMarketStore'
import { useObservabilityStore, currentTraceLevel } from './observabilityStore'
import { useTacMarketStore } from './tacMarketStore'

/** Assemble the request from current store state. */
export function composeRigaRequest(): RigaPriceRequest {
  const trade = useRigaTradeStore.getState().trade
  const marketState = useRigaMarketStore.getState()
  const config = { ...marketState.simulation, traceLevel: currentTraceLevel() }
  const localVol = marketState.localVol ? { grids: [marketState.localVol] } : null
  try {
    const tac = useTacMarketStore.getState()
    const effective = applyManipulations(tac.raw, tac.manipulations)
    const market = effectiveRigaMarket(marketState.market, effective)
    return { trade, market, config, asOf: market.asOf, localVol }
  } catch {
    // A partial/corrupt tac store must never break the trade request.
    return { trade, market: marketState.market, config, asOf: marketState.market.asOf, localVol }
  }
}

export function rigaRequestKey(): string {
  return JSON.stringify(composeRigaRequest())
}

type RigaRequestState = {
  request: RigaPriceRequest
  key: string
  /** Monotonic counter, incremented whenever the key changes. */
  requestId: number
  refresh: () => void
}

const initial = composeRigaRequest()

export const useRigaRequestStore = create<RigaRequestState>((set, get) => ({
  request: initial,
  key: JSON.stringify(initial),
  requestId: 0,
  refresh: () => {
    const request = composeRigaRequest()
    const key = JSON.stringify(request)
    if (key !== get().key) set({ request, key, requestId: get().requestId + 1 })
  },
}))

// Re-evaluate whenever an input store changes (trade, market, tac market,
// observability). Subscribing at module scope is what closes the "pure
// market-data change does not re-run" gap (§9.2).
for (const store of [useRigaTradeStore, useRigaMarketStore, useTacMarketStore, useObservabilityStore]) {
  store.subscribe(() => useRigaRequestStore.getState().refresh())
}
