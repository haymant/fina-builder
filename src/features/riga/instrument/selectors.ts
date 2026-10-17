// Flat, engine-shaped views derived from the canonical document (docs/46 §6.1).

import type {
  RigaImpliedVolGrid,
  RigaMarketSnapshot,
  RigaPhoenixTrade,
  RigaSimulationConfig,
} from '../types'
import type { InstrumentDocument } from './schema'
import { toRequest } from './toRequest'

export function tradeFromDocument(doc: InstrumentDocument): RigaPhoenixTrade {
  return toRequest(doc).trade
}
export function marketFromDocument(doc: InstrumentDocument): RigaMarketSnapshot {
  return toRequest(doc).market
}
export function simulationFromDocument(doc: InstrumentDocument): RigaSimulationConfig {
  return toRequest(doc).config
}
export function localVolGridsFromDocument(doc: InstrumentDocument): RigaImpliedVolGrid[] | null {
  const localVol = toRequest(doc).localVol
  return localVol ? localVol.grids : null
}
