// Transport-agnostic command surface over fina-kernel (`PHASE1_MIGRATION_PROMPT.md` §5d).
//
// Two implementations exist: Tauri IPC and HTTP. Both speak the same commands
// (names equal to the kernel's `CommandId` wire names), take a request object,
// and return a response typed as `T` — or throw an `ApiError`.

import type { WireError } from './types'

export interface FinaTransport {
  /** One command, one JSON response. Rejects with `ApiError` on failure. */
  call<T>(command: string, request: unknown): Promise<T>
  /** Streaming progress + final result for `generate_paths`. */
  generatePaths(
    request: unknown,
    onProgress: (event: unknown) => void,
  ): Promise<unknown>
}

export function isApiError(e: unknown): e is WireError {
  return typeof e === 'object' && e !== null && 'code' in e && 'message' in e
}

/** Normalises any rejection into the wire error shape. */
export function toApiError(reason: unknown): WireError {
  if (isApiError(reason)) return reason
  if (reason instanceof Error) {
    return { code: 'INVALID_REQUEST', message: reason.message }
  }
  return { code: 'INVALID_REQUEST', message: String(reason) }
}