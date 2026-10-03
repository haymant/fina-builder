// Tauri IPC transport: `@tauri-apps/api/core` `invoke` + `Channel`.
//
// The Rust command names are the kernel wire names (`compute_risk`, …), so the
// frontend spells one name regardless of transport (invariant I-3). Errors come
// back as `{ code, message }` because every Rust command returns
// `Result<_, FinaErrorWire>`.

import { invoke, Channel } from '@tauri-apps/api/core'
import type { FinaTransport } from './transport'
import { toApiError } from './transport'

export const tauriTransport: FinaTransport = {
  async call<T>(command: string, request: unknown): Promise<T> {
    try {
      // No `onEvent`: the kernel commands that stream take an optional channel,
      // and `call` is the non-streaming path. `generatePaths` supplies one.
      return await invoke<T>(command, { req: request ?? {} })
    } catch (e) {
      throw toApiError(e)
    }
  },

  async generatePaths(request, onProgress): Promise<unknown> {
    try {
      const onEvent = new Channel<unknown>()
      onEvent.onmessage = (event) => onProgress(event)
      return await invoke('generate_paths', { req: request, onEvent })
    } catch (e) {
      throw toApiError(e)
    }
  },
}