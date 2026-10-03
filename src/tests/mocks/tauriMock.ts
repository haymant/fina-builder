// Test double for `@tauri-apps/api/core` (PHASE1_MIGRATION_PROMPT.md §6.2).
//
// Any test importing `tauriTransport` resolves this module via the
// `resolve.alias` in `vite.config.ts`. The `invoke` spy **throws by default**
// for unknown commands, so a missing mock fails loudly instead of silently
// returning `undefined`.

import { vi } from 'vitest'

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

export const invoke = vi.fn<Invoke>(async () => {
  throw new Error('unmocked tauri command: register a mock in the test')
})

export class Channel<T> {
  onmessage: ((message: T) => void) | null = null
  onerror: ((error: string) => void) | null = null

  send(message: T): void {
    this.onmessage?.(message)
  }
}