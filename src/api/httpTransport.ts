// HTTP transport: `POST /api/cmd/{command}` (JSON) and
// `POST /api/stream/{command}` (SSE) against the fina-server.
//
// The base URL defaults to the Vite dev origin's backend; override with
// `VITE_FINA_BASE_URL` when the server runs elsewhere.

import type { FinaTransport } from './transport'
import { toApiError } from './transport'

const BASE = (import.meta.env.VITE_FINA_BASE_URL as string | undefined) ?? 'http://127.0.0.1:8787'

async function parseBody<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (response.ok) return JSON.parse(text) as T
  // Non-2xx: the server sends the wire error shape; fall back to a generic one.
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  if (typeof parsed === 'object' && parsed !== null && 'code' in (parsed as object)) {
    throw parsed
  }
  throw { code: 'INVALID_REQUEST', message: `HTTP ${response.status}: ${text}` }
}

export const httpTransport: FinaTransport = {
  async call<T>(command: string, request: unknown): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${BASE}/api/cmd/${command}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request ?? {}),
      })
    } catch (e) {
      throw toApiError(e)
    }
    return parseBody<T>(response)
  },

  async generatePaths(request, onProgress): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(`${BASE}/api/stream/generate_paths`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request ?? {}),
      })
    } catch (e) {
      throw toApiError(e)
    }
    if (!response.ok || !response.body) {
      return parseBody(response)
    }

    // SSE framing: `data: {json}\n\n` frames. Progress frames carry a
    // ProgressEvent; the final frame carries the response.
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '))
        if (!line) continue
        const payload = JSON.parse(line.slice('data: '.length)) as unknown
        const event = payload as { phase?: string; completed?: number }
        if (event && typeof event === 'object' && 'phase' in event) {
          onProgress(payload)
        } else {
          return payload
        }
      }
    }
    throw { code: 'INVALID_REQUEST', message: 'stream closed without a result frame' }
  },
}