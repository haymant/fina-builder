// Parse an imported/pasted instrument JSON into a `fina.instrument/v1`
// document via the matching adapter (shared by the store and the CLI).

import { detectAdapter } from './adapters/detect'
import { blankDocument } from './adapters/manual'
import { decodeMurexChunk } from './adapters/murexChunk'
import { decodeRigaFixture } from './adapters/rigaFixture'
import type { InstrumentAdapterId, InstrumentDocument } from './schema'

export interface ParseResult {
  ok: boolean
  document?: InstrumentDocument
  adapter?: InstrumentAdapterId
  error?: string
}

export function parseInstrumentText(text: string, fileName: string | null = null): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${(error as Error).message}` }
  }
  const adapter = detectAdapter(raw)
  if (!adapter) {
    return {
      ok: false,
      error: 'unrecognised instrument JSON (expected a Murex chunk or the termsheet1 fixture)',
    }
  }
  const document =
    adapter === 'murex-chunk@1' ? decodeMurexChunk(raw, fileName) : decodeRigaFixture(raw, fileName)
  return { ok: true, document, adapter }
}

export { blankDocument }
