// Client for the trade repository MCP server (scripts/trade-repo-mcp-http.mjs).
// Browser: same-origin `/trade-repo` (Vite proxy). Desktop (Tauri): the local server on
// 127.0.0.1:8792 (it sends CORS headers). Override with VITE_TRADE_REPO_MCP_URL.
// Unlike the riga transport, keys are camelCase on the wire, so no key conversion.
import type { FieldIssue, Role } from './types'

export class TradeRepoApiError extends Error {
  code: string
  details: FieldIssue[]
  retryable: boolean
  correlationId?: string
  constructor(code: string, message: string, details: FieldIssue[] = [], retryable = false, correlationId?: string) {
    super(message)
    this.name = 'TradeRepoApiError'
    this.code = code
    this.details = details
    this.retryable = retryable
    this.correlationId = correlationId
  }
}

export interface Session { actor: string; role: Role }

export function tradeRepoBaseUrl(): string {
  const override = import.meta.env.VITE_TRADE_REPO_MCP_URL as string | undefined
  if (override) return override
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) return 'http://127.0.0.1:8792'
  return '/trade-repo'
}

type Fetch = typeof fetch
let nextId = 1

export function createTradeRepoClient(baseUrl = tradeRepoBaseUrl(), fetchImpl: Fetch = (...a) => fetch(...a)) {
  let session: Session = { actor: 'trash.box', role: 'admin' }
  async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    let res: Response
    try {
      res = await fetchImpl(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: { ...args, context: session } } }),
      })
    } catch (e) {
      throw new TradeRepoApiError('UNAVAILABLE', `Trade repository not reachable at ${baseUrl}: ${(e as Error).message}`, [], true)
    }
    if (!res.ok) throw new TradeRepoApiError('UNAVAILABLE', `Trade repository returned HTTP ${res.status}. Start it with \`npm run mcp:http:trade-repo\`.`, [], true)
    const body = (await res.json()) as { result?: { isError?: boolean; structuredContent?: unknown }; error?: { message: string } }
    if (body.error) throw new TradeRepoApiError('RPC_ERROR', body.error.message)
    const result = body.result ?? {}
    if (result.isError) {
      const e = (result.structuredContent ?? {}) as { code?: string; message?: string; details?: FieldIssue[]; retryable?: boolean; correlationId?: string }
      throw new TradeRepoApiError(e.code ?? 'ERROR', e.message ?? 'tool error', e.details ?? [], e.retryable ?? false, e.correlationId)
    }
    return result.structuredContent as T
  }
  return {
    call,
    setSession(s: Session) { session = s },
    getSession: () => session,
  }
}

export const tradeRepo = createTradeRepoClient()

export const newIdempotencyKey = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

export const fmtNotional = (n: number | undefined | null) => {
  if (n === undefined || n === null || Number.isNaN(n)) return '—'
  const a = Math.abs(n)
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(2)}bn` : a >= 1e6 ? `${(a / 1e6).toFixed(2)}m` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : a.toFixed(0)
  return n < 0 ? `-${s}` : s
}
