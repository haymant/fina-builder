import { createHttpMcpTransport, unwrapToolResult } from './rigaTransport'
import { invoke } from '@tauri-apps/api/core'
import { toSnakeKeys } from './keyCase'

export type BookErrorKind = 'unavailable' | 'backend' | 'validation' | 'timeout'

export class BookApiError extends Error {
  readonly kind: BookErrorKind
  readonly tool?: string
  constructor(message: string, kind: BookErrorKind, tool?: string) {
    super(message)
    this.name = 'BookApiError'
    this.kind = kind
    this.tool = tool
  }
}

export interface BookRound {
  id: string | null
  source: string | null
  targetDate: string | null
  signalDate: string | null
  schedulerRunId: string | null
  experimentId: string | null
  experimentName: string | null
  runId: string | null
  modelRef: string | null
  status: string | null
  lockedIntentId: string | null
  accountEquityAtSizing: string | null
  summaryMetrics: Record<string, unknown> | null
  createdAt: string | null
  updatedAt: string | null
}

export interface BookRoundDetail {
  round: BookRound | null
  intents: Record<string, unknown>[]
  decisions: Record<string, unknown>[]
  orders: Record<string, unknown>[]
  facts: Record<string, unknown>[]
  funnel: Record<string, unknown> | null
  reconcile: Record<string, unknown> | null
  metrics: Record<string, unknown> | null
}

export interface BookTransport {
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>
}

const READ_ONLY_TOOLS = new Set(['round_list', 'round_get', 'trail_query', 'trail_funnel', 'round_metrics'])
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const array = (value: unknown, key: string): unknown[] => Array.isArray(value) ? value : (Array.isArray(record(value)[key]) ? record(value)[key] as unknown[] : [])
const opaque = (value: unknown): string | null => value === null || value === undefined ? null : String(value)
const decimal = (value: unknown): string | null => value === null || value === undefined ? null : String(value)
const timestamp = (value: unknown): string | null => value === null || value === undefined ? null : String(value)

function normalizeRound(value: unknown): BookRound {
  const raw = record(value)
  return {
    id: opaque(raw.id), source: (raw.source as string | null) ?? null,
    targetDate: (raw.targetDate as string | null) ?? null, signalDate: (raw.signalDate as string | null) ?? null,
    schedulerRunId: opaque(raw.schedulerRunId), experimentId: opaque(raw.experimentId), experimentName: (raw.experimentName as string | null) ?? null,
    runId: opaque(raw.runId), modelRef: opaque(raw.modelRef), status: (raw.status as string | null) ?? null,
    lockedIntentId: opaque(raw.lockedIntentId), accountEquityAtSizing: decimal(raw.accountEquityAtSizing),
    summaryMetrics: record(raw.summaryMetrics), createdAt: timestamp(raw.createdAt), updatedAt: timestamp(raw.updatedAt),
  }
}

function normalizeDetail(value: unknown): BookRoundDetail {
  const raw = record(value)
  return {
    round: raw.round ? normalizeRound(raw.round) : null,
    intents: array(raw.intents, '').map(record), decisions: array(raw.decisions, '').map(record), orders: array(raw.orders, '').map(record), facts: array(raw.facts, '').map(record),
    funnel: raw.funnel ? record(raw.funnel) : null, reconcile: raw.reconcile ? record(raw.reconcile) : null, metrics: raw.metrics ? record(raw.metrics) : null,
  }
}

function errorFor(tool: string, error: unknown): BookApiError {
  if (error instanceof BookApiError) return error
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  const kind: BookErrorKind = lower.includes('timeout') || lower.includes('timed out') ? 'timeout' : lower.includes('reach') || lower.includes('not configured') || lower.includes('database_url') ? 'unavailable' : 'backend'
  const redacted = message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+):([^\s/@]+)@/ig, '$1[REDACTED]@')
    .replace(/(password|secret|token|api[_-]?key)\s*[=:]\s*[^\s,;]+/ig, '$1=[REDACTED]')
  return new BookApiError(redacted, kind, tool)
}

export function createBookApi(transport: BookTransport) {
  async function call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!READ_ONLY_TOOLS.has(tool)) throw new BookApiError(`Book tool is not allowed: ${tool}`, 'validation', tool)
    try { return await transport.callTool(tool, args) as T } catch (error) { throw errorFor(tool, error) }
  }
  return {
    async listRounds(args: Record<string, unknown> = {}): Promise<{ rounds: BookRound[] }> { const value = await call<unknown>('round_list', args); return { rounds: array(value, 'rounds').map(normalizeRound) } },
    async getRound(args: Record<string, unknown>): Promise<BookRoundDetail> { return normalizeDetail(await call('round_get', args)) },
    async queryTrail(args: Record<string, unknown>): Promise<{ trail: Record<string, unknown>[] }> { const value = await call<unknown>('trail_query', args); return { trail: array(value, 'trail').map(record) } },
    async funnel(args: Record<string, unknown>): Promise<Record<string, unknown>> { return record(await call('trail_funnel', args)) },
    async metrics(args: Record<string, unknown>): Promise<Record<string, unknown>> { return record(await call('round_metrics', args)) },
  }
}

export function bookBaseUrl(): string {
  return (import.meta.env.VITE_BOOK_MCP_URL as string | undefined) ?? '/book'
}

const httpBookTransport: BookTransport = {
  async callTool(name: string, args: Record<string, unknown> = {}) {
    const result = await createHttpMcpTransport(bookBaseUrl()).callTool<Record<string, unknown>>(name, args)
    return unwrapToolResult(result, name)
  },
}

const tauriBookTransport: BookTransport = {
  async callTool(name: string, args: Record<string, unknown> = {}) {
    const result = await invoke<Record<string, unknown>>('book_mcp_call_tool', { name, arguments: toSnakeKeys(args) })
    return unwrapToolResult(result, name)
  },
}

function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

let activeBookTransport: BookTransport = inTauri() ? tauriBookTransport : httpBookTransport
export function setBookTransport(transport: BookTransport | null): void { activeBookTransport = transport ?? httpBookTransport }
export const bookApi = createBookApi({ callTool: (name, args) => activeBookTransport.callTool(name, args) })
