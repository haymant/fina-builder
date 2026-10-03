// Picks the transport and exports the `fina` command client.
//
// Detection: Tauri v2 exposes `__TAURI_INTERNALS__` on `window`. Override with
// `VITE_FINA_TRANSPORT=tauri|http` (used by tests and by forced modes).

import type { FinaTransport } from './transport'
import { httpTransport } from './httpTransport'
import { tauriTransport } from './tauriTransport'

function detectTransport(): FinaTransport {
  const override = import.meta.env.VITE_FINA_TRANSPORT as string | undefined
  if (override === 'http') return httpTransport
  if (override === 'tauri') return tauriTransport
  const inTauri =
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  return inTauri ? tauriTransport : httpTransport
}

export const fina: FinaTransport = detectTransport()