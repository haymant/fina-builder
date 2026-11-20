import { canonicalizeDecimal, normalizeUtcTimestamp, redactDiagnostic } from '../phase3-contracts/serialization.mjs'

export const READ_ONLY_BOOK_TOOLS = Object.freeze(['round_list', 'round_get', 'trail_query', 'trail_funnel', 'round_metrics'])

export class BookServiceError extends Error {
  constructor(code, message, { tool, retryable = false, details } = {}) {
    super(message)
    this.name = 'BookServiceError'
    this.code = code
    this.tool = tool
    this.retryable = retryable
    this.details = details
  }
}

const asRecord = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const asArray = (value, key) => Array.isArray(value) ? value : (Array.isArray(asRecord(value)[key]) ? asRecord(value)[key] : [])
const opaque = (value) => value === undefined || value === null ? null : String(value)
const decimal = (value, field) => value === undefined || value === null ? null : canonicalizeDecimal(typeof value === 'number' ? String(value) : value)
const timestamp = (value, field) => value === undefined || value === null ? null : normalizeUtcTimestamp(value, field)
const safeError = (error) => error instanceof BookServiceError ? error : new BookServiceError('BACKEND', String(redactDiagnostic(error?.message ?? error)), { retryable: true, details: redactDiagnostic(error) })

function normalizeRound(value) {
  const raw = asRecord(value)
  return {
    id: opaque(raw.id), source: raw.source ?? null, targetDate: raw.target_date ?? raw.targetDate ?? null,
    signalDate: raw.signal_date ?? raw.signalDate ?? null, schedulerRunId: opaque(raw.scheduler_run_id ?? raw.schedulerRunId),
    experimentId: opaque(raw.rd_experiment_id ?? raw.experimentId), experimentName: raw.experiment_name ?? raw.experimentName ?? null,
    runId: opaque(raw.run_id ?? raw.runId), modelRef: opaque(raw.model_path ?? raw.modelRef), status: raw.status ?? null,
    lockedIntentId: opaque(raw.locked_intent_id ?? raw.lockedIntentId), accountEquityAtSizing: decimal(raw.account_equity_at_sizing ?? raw.accountEquityAtSizing, 'accountEquityAtSizing'),
    summaryMetrics: raw.summary_metrics ?? raw.summaryMetrics ?? null, createdAt: timestamp(raw.created_at ?? raw.createdAt, 'createdAt'), updatedAt: timestamp(raw.updated_at ?? raw.updatedAt, 'updatedAt'),
  }
}

function normalizeMetrics(value) {
  const raw = asRecord(value)
  const out = {}
  for (const [key, val] of Object.entries(raw)) {
    if (typeof val === 'number' || (typeof val === 'string' && /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(val))) out[key] = decimal(val, key)
    else if (val === null) out[key] = null
    else if (typeof val === 'boolean' || typeof val === 'string') out[key] = val
  }
  return out
}

export function normalizeBookResponse(tool, value) {
  if (!READ_ONLY_BOOK_TOOLS.includes(tool)) throw new BookServiceError('VALIDATION', `book tool is not allowed: ${tool}`, { tool })
  const raw = asRecord(value)
  if (tool === 'round_list') return { rounds: asArray(value, 'rounds').map(normalizeRound) }
  if (tool === 'round_get') {
    return {
      round: raw.round ? normalizeRound(raw.round) : null,
      intents: asArray(raw.intents, '').map((item) => ({ ...asRecord(item), id: opaque(asRecord(item).id), roundId: opaque(asRecord(item).round_id ?? asRecord(item).roundId), createdAt: timestamp(asRecord(item).created_at ?? asRecord(item).createdAt, 'intent.createdAt') })),
      decisions: asArray(raw.decisions, '').map((item) => ({ ...asRecord(item), id: opaque(asRecord(item).id), roundId: opaque(asRecord(item).round_id ?? asRecord(item).roundId) })),
      orders: asArray(raw.orders, '').map((item) => ({ ...asRecord(item), id: opaque(asRecord(item).id), roundId: opaque(asRecord(item).round_id ?? asRecord(item).roundId), qtyFilled: decimal(asRecord(item).qty_filled ?? asRecord(item).qtyFilled, 'order.qtyFilled'), avgFillPrice: decimal(asRecord(item).avg_fill_price ?? asRecord(item).avgFillPrice, 'order.avgFillPrice') })),
      facts: asArray(raw.facts, '').map((item) => ({ ...asRecord(item), id: opaque(asRecord(item).id), roundId: opaque(asRecord(item).round_id ?? asRecord(item).roundId), at: timestamp(asRecord(item).at, 'fact.at') })),
      funnel: raw.funnel ? normalizeMetrics(raw.funnel) : null, reconcile: raw.reconcile ?? null, metrics: raw.metrics ? normalizeMetrics(raw.metrics) : null,
    }
  }
  if (tool === 'trail_query') return { trail: asArray(value, 'trail') }
  if (tool === 'trail_funnel') return normalizeMetrics(value)
  return normalizeMetrics(value)
}

export function createReadOnlyBookClient(callTool) {
  if (typeof callTool !== 'function') throw new TypeError('book callTool must be a function')
  async function call(tool, args = {}) {
    if (!READ_ONLY_BOOK_TOOLS.includes(tool)) throw new BookServiceError('VALIDATION', `book tool is not allowed: ${tool}`, { tool })
    try { return normalizeBookResponse(tool, await callTool(tool, args)) } catch (error) { throw safeError(error) }
  }
  return {
    call,
    roundList: (args = {}) => call('round_list', args),
    roundGet: (args) => call('round_get', args),
    trailQuery: (args) => call('trail_query', args),
    trailFunnel: (args) => call('trail_funnel', args),
    roundMetrics: (args) => call('round_metrics', args),
  }
}
