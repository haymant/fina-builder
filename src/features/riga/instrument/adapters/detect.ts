import type { InstrumentAdapterId } from '../schema'

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Which adapter understands this raw JSON, or null for an unrecognised shape. */
export function detectAdapter(raw: unknown): InstrumentAdapterId | null {
  const doc = raw as any
  if (Array.isArray(doc?.Chunk?.Jobs)) return 'murex-chunk@1'
  if (doc?.trade_economics && doc?.market_data) return 'riga-fixture@1'
  return null
}
