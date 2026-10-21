// Trade repository domain core (docs/52-trade-repository-design.md).
//
// Event-sourced: every change is an immutable, versioned `TradeEvent` appended to
// an append-only log. Current state, as-of state, positions, the audit trail and
// reconciliation are projections over that log. Pure JS (no deps) so it runs in
// the Node MCP server (`scripts/trade-repo-mcp-http.mjs`) and under Vitest.

export const SCHEMA_VERSION = 'fina.trade-event/v1'

export const EVENT_TYPES = ['NEW', 'AMEND', 'CANCEL', 'NOVATE', 'PARTIAL_TERMINATE', 'EXERCISE', 'MATURE', 'BOOK_TRANSFER']
export const LIFECYCLE_EVENTS = ['CANCEL', 'NOVATE', 'PARTIAL_TERMINATE', 'EXERCISE', 'MATURE', 'BOOK_TRANSFER']
export const STATUSES = ['LIVE', 'CANCELLED', 'TERMINATED', 'EXERCISED', 'MATURED', 'NOVATED']
export const PRODUCT_TYPES = ['IRS', 'FX_FORWARD', 'EQUITY_OPTION', 'CDS', 'PHOENIX_AUTOCALL']
export const ECONOMIC_FIELDS = [
  'productType', 'side', 'notional', 'currency', 'underlying', 'price', 'fixedRate', 'strike', 'optionType',
  'tradeDate', 'effectiveDate', 'maturityDate', 'counterpartyId', 'quantity',
]
export const NON_ECONOMIC_FIELDS = ['bookId', 'trader', 'venue', 'externalId', 'tags', 'comment']
export const ROLES = ['viewer', 'trader', 'ops', 'admin']
const TERMINAL = new Set(['CANCELLED', 'TERMINATED', 'EXERCISED', 'MATURED', 'NOVATED'])

// Allowed transitions: lifecycle state machine (status -> event types).
export const TRANSITIONS = {
  LIVE: ['AMEND', 'CANCEL', 'NOVATE', 'PARTIAL_TERMINATE', 'EXERCISE', 'MATURE', 'BOOK_TRANSFER'],
  CANCELLED: [], TERMINATED: [], EXERCISED: [], MATURED: [], NOVATED: [],
}

export class TradeRepoError extends Error {
  constructor(code, message, details = [], retryable = false) {
    super(message)
    this.code = code
    this.details = details
    this.retryable = retryable
  }
  toJSON() {
    return { code: this.code, message: this.message, details: this.details, retryable: this.retryable }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

/** FNV-1a 64-bit-ish content hash (deterministic, dependency free). */
export function contentHash(value) {
  const s = stableStringify(value)
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0
  }
  return `h:${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
const isCcy = (s) => typeof s === 'string' && /^[A-Z]{3}$/.test(s)

export function diffTrades(a, b) {
  const fields = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  const changes = []
  for (const f of [...fields].sort()) {
    if (['version', 'lastEventId', 'lastEventType', 'recordedAt', 'validFrom', 'contentHash', 'status', 'originalNotional'].includes(f)) continue
    const av = a?.[f], bv = b?.[f]
    if (stableStringify(av) !== stableStringify(bv)) {
      changes.push({ field: f, before: av ?? null, after: bv ?? null, economic: ECONOMIC_FIELDS.includes(f) })
    }
  }
  return changes
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

export function validateTrade(t, ref) {
  const errors = []
  const warnings = []
  const req = (field) => {
    if (t[field] === undefined || t[field] === null || t[field] === '') errors.push({ code: 'REQUIRED', path: field, message: `${field} is required` })
  }
  ;['productType', 'side', 'notional', 'currency', 'tradeDate', 'maturityDate', 'counterpartyId', 'bookId'].forEach(req)
  if (t.productType && !PRODUCT_TYPES.includes(t.productType)) errors.push({ code: 'ENUM', path: 'productType', message: `productType must be one of ${PRODUCT_TYPES.join(', ')}` })
  if (t.side && !['BUY', 'SELL'].includes(t.side)) errors.push({ code: 'ENUM', path: 'side', message: 'side must be BUY or SELL' })
  if (t.notional !== undefined && !(typeof t.notional === 'number' && t.notional > 0)) errors.push({ code: 'RANGE', path: 'notional', message: 'notional must be a positive number (direction is carried by side)' })
  if (t.currency && !isCcy(t.currency)) errors.push({ code: 'FORMAT', path: 'currency', message: 'currency must be an ISO-4217 code' })
  for (const f of ['tradeDate', 'effectiveDate', 'maturityDate']) {
    if (t[f] && !isDate(t[f])) errors.push({ code: 'FORMAT', path: f, message: `${f} must be YYYY-MM-DD` })
  }
  if (isDate(t.tradeDate) && isDate(t.maturityDate) && t.maturityDate <= t.tradeDate) errors.push({ code: 'DATE_ORDER', path: 'maturityDate', message: 'maturityDate must be after tradeDate' })
  if (isDate(t.tradeDate) && isDate(t.effectiveDate) && t.effectiveDate < t.tradeDate) errors.push({ code: 'DATE_ORDER', path: 'effectiveDate', message: 'effectiveDate cannot precede tradeDate' })
  if (ref) {
    if (t.counterpartyId && !ref.parties.find((p) => p.partyId === t.counterpartyId && p.kind === 'COUNTERPARTY')) errors.push({ code: 'UNKNOWN_REF', path: 'counterpartyId', message: `unknown counterparty ${t.counterpartyId}` })
    if (t.bookId && !ref.books.find((b) => b.bookId === t.bookId)) errors.push({ code: 'UNKNOWN_REF', path: 'bookId', message: `unknown book ${t.bookId}` })
  }
  if (t.productType === 'EQUITY_OPTION') {
    if (!t.underlying) errors.push({ code: 'REQUIRED', path: 'underlying', message: 'underlying is required for options' })
    if (!(t.strike > 0)) errors.push({ code: 'REQUIRED', path: 'strike', message: 'strike must be positive for options' })
    if (!['CALL', 'PUT'].includes(t.optionType)) errors.push({ code: 'ENUM', path: 'optionType', message: 'optionType must be CALL or PUT' })
  }
  if (t.productType === 'IRS' && !(typeof t.fixedRate === 'number')) errors.push({ code: 'REQUIRED', path: 'fixedRate', message: 'fixedRate is required for IRS' })
  if (t.productType === 'IRS' && typeof t.fixedRate === 'number' && Math.abs(t.fixedRate) > 0.25) warnings.push({ code: 'OFF_MARKET', path: 'fixedRate', message: 'fixedRate looks off-market (> 25%)' })
  if (t.productType === 'FX_FORWARD' && !(t.price > 0)) errors.push({ code: 'REQUIRED', path: 'price', message: 'forward rate (price) is required for FX forwards' })
  if (['FX_FORWARD', 'CDS', 'PHOENIX_AUTOCALL', 'EQUITY_OPTION'].includes(t.productType) && !t.underlying) {
    if (t.productType !== 'EQUITY_OPTION') errors.push({ code: 'REQUIRED', path: 'underlying', message: 'underlying is required' })
  }
  if (typeof t.notional === 'number' && t.notional > 5e9) warnings.push({ code: 'FAT_FINGER', path: 'notional', message: 'notional above 5bn — confirm (fat-finger check)' })
  return { valid: errors.length === 0, errors, warnings }
}

// ---------------------------------------------------------------------------
// repository
// ---------------------------------------------------------------------------

/**
 * @param {{ reference: object, store?: { append(e): void, load(): object[] }, now?: () => string }} opts
 */
export function createRepository({ reference, store, now = () => new Date().toISOString() }) {
  const ref = reference
  /** @type {object[]} */
  const log = []
  const byTrade = new Map() // tradeId -> events[]
  const idempotency = new Map() // key -> result
  const audit = []
  const breaks = new Map()
  const reconRuns = []
  let seq = 0

  function applyRecord(rec, persist) {
    if (rec.kind === 'trade-event') {
      log.push(rec)
      if (!byTrade.has(rec.tradeId)) byTrade.set(rec.tradeId, [])
      byTrade.get(rec.tradeId).push(rec)
      const n = Number(rec.tradeId.replace(/\D/g, ''))
      if (n > seq) seq = n
      if (rec.idempotencyKey) idempotency.set(rec.idempotencyKey, { tradeId: rec.tradeId, version: rec.version, eventId: rec.eventId })
    } else if (rec.kind === 'audit') audit.push(rec)
    else if (rec.kind === 'recon-run') reconRuns.push(rec)
    else if (rec.kind === 'break') breaks.set(rec.breakId, rec)
    if (persist && store) store.append(rec)
  }
  if (store) for (const rec of store.load()) applyRecord(rec, false)

  const writeAudit = (ctx, action, target, detail) => {
    applyRecord({ kind: 'audit', auditId: `AUD-${String(audit.length + 1).padStart(6, '0')}`, occurredAt: ctx.recordedAt ?? now(), actor: ctx.actor, role: ctx.role, action, target, detail, correlationId: ctx.correlationId ?? null }, true)
  }

  function entitle(ctx, action, bookId) {
    const role = ctx?.role ?? 'viewer'
    if (!ROLES.includes(role)) throw new TradeRepoError('FORBIDDEN', `unknown role ${role}`)
    const write = ['book', 'amend', 'lifecycle', 'import']
    if (write.includes(action)) {
      if (role === 'viewer') throw new TradeRepoError('FORBIDDEN', `role viewer cannot ${action} trades`)
      if (role === 'trader') {
        const user = ref.users.find((u) => u.userId === ctx.actor)
        if (!user || !user.books.includes(bookId)) throw new TradeRepoError('FORBIDDEN', `${ctx.actor} is not entitled to book ${bookId}`)
      }
    }
    if (action === 'break' && !['ops', 'admin'].includes(role)) throw new TradeRepoError('FORBIDDEN', `role ${role} cannot manage reconciliation breaks`)
  }

  const visible = (ctx, trade) => {
    if ((ctx?.role ?? 'viewer') !== 'trader') return true
    const user = ref.users.find((u) => u.userId === ctx.actor)
    const desk = user?.deskId
    const book = ref.books.find((b) => b.bookId === trade.bookId)
    return !!book && (user.books.includes(book.bookId) || book.deskId === desk)
  }

  /** Bitemporal resolution: latest event with recordedAt <= knownAt and validFrom <= validAt. */
  function stateOf(tradeId, { validAt, knownAt } = {}) {
    const events = byTrade.get(tradeId)
    if (!events) return null
    let candidate = null
    for (const e of events) {
      if (knownAt && e.recordedAt > knownAt) continue
      if (validAt && e.validFrom > validAt) continue
      if (!candidate || e.validFrom > candidate.validFrom || (e.validFrom === candidate.validFrom && e.version > candidate.version)) candidate = e
    }
    return candidate ? { ...candidate.state } : null
  }

  function eventsOf(tradeId, knownAt) {
    const evts = byTrade.get(tradeId) ?? []
    return evts.filter((e) => !knownAt || e.recordedAt <= knownAt)
  }

  function nextUti(legalEntityId, n) {
    const le = ref.parties.find((p) => p.partyId === legalEntityId)
    return `${le?.lei ?? '5493000000000000000'}${'FINA'}${String(n).padStart(10, '0')}`
  }

  function appendEvent(ctx, { tradeId, eventType, amendKind, validFrom, state, reason, idempotencyKey, prev, related }) {
    const recordedAt = ctx.recordedAt ?? now()
    const version = (prev?.version ?? 0) + 1
    const full = { ...state, tradeId, version, status: state.status, lastEventType: eventType, validFrom, recordedAt }
    full.contentHash = contentHash(Object.fromEntries(ECONOMIC_FIELDS.map((f) => [f, full[f]])))
    const event = {
      kind: 'trade-event', schema: SCHEMA_VERSION,
      eventId: `EVT-${String(log.length + 1).padStart(7, '0')}`,
      tradeId, uti: full.uti, version, eventType, amendKind: amendKind ?? null,
      validFrom, recordedAt, actor: ctx.actor, idempotencyKey: idempotencyKey ?? null,
      reason: reason ?? null, prevVersion: prev?.version ?? null, related: related ?? null,
      changes: diffTrades(prev, full), state: full,
    }
    event.state.lastEventId = event.eventId
    if (related) event.state = { ...event.state, ...Object.fromEntries(Object.entries(related)) }
    const clean = JSON.parse(JSON.stringify(event))
    applyRecord(clean, true)
    writeAudit(ctx, eventType === 'NEW' ? 'trade.book' : eventType === 'AMEND' ? 'trade.amend' : `trade.${eventType.toLowerCase()}`, { type: 'trade', id: tradeId, version }, { eventId: event.eventId, reason: reason ?? null, changes: event.changes.length })
    return clean
  }

  function checkIdem(key) {
    if (key && idempotency.has(key)) return { ...idempotency.get(key), replayed: true }
    return null
  }

  function current(tradeId) {
    const s = stateOf(tradeId)
    if (!s) throw new TradeRepoError('NOT_FOUND', `trade ${tradeId} not found`)
    return s
  }

  function resolveId(idOrUti) {
    if (byTrade.has(idOrUti)) return idOrUti
    for (const [id, evts] of byTrade) if (evts[0].uti === idOrUti || evts.some((e) => e.state.externalId === idOrUti)) return id
    throw new TradeRepoError('NOT_FOUND', `trade ${idOrUti} not found`)
  }

  const api = {
    reference: ref,

    capabilities() {
      return {
        schema: SCHEMA_VERSION, productTypes: PRODUCT_TYPES, eventTypes: EVENT_TYPES, statuses: STATUSES, roles: ROLES,
        transitions: TRANSITIONS, economicFields: ECONOMIC_FIELDS, nonEconomicFields: NON_ECONOMIC_FIELDS,
        bitemporal: true, idempotency: true, optimisticConcurrency: true, maxPageSize: 500,
      }
    },

    validate(trade) {
      return validateTrade(trade, ref)
    },

    book(ctx, { trade, idempotencyKey, dryRun, validFrom }) {
      const replay = checkIdem(idempotencyKey)
      if (replay) return { ...replay, trade: current(replay.tradeId) }
      const v = validateTrade(trade, ref)
      if (!v.valid) throw new TradeRepoError('VALIDATION_FAILED', `${v.errors.length} validation error(s)`, v.errors)
      entitle(ctx, 'book', trade.bookId)
      if (trade.externalId) {
        for (const evts of byTrade.values()) if (evts[0].state.externalId === trade.externalId) throw new TradeRepoError('DUPLICATE', `externalId ${trade.externalId} already booked as ${evts[0].tradeId}`)
      }
      if (dryRun) return { dryRun: true, validation: v }
      const n = seq + 1
      seq = n
      const tradeId = `TR-${String(n).padStart(6, '0')}`
      const book = ref.books.find((b) => b.bookId === trade.bookId)
      const state = {
        ...trade, tradeId, uti: trade.uti ?? nextUti(book.legalEntityId, n), legalEntityId: book.legalEntityId,
        effectiveDate: trade.effectiveDate ?? trade.tradeDate, status: 'LIVE', tags: trade.tags ?? {},
        originalNotional: trade.notional,
      }
      const event = appendEvent(ctx, { tradeId, eventType: 'NEW', validFrom: validFrom ?? trade.tradeDate, state, reason: 'New trade', idempotencyKey })
      return { tradeId, version: event.version, eventId: event.eventId, warnings: v.warnings, trade: event.state }
    },

    amend(ctx, { tradeId, expectedVersion, changes, reason, validFrom, idempotencyKey }) {
      const replay = checkIdem(idempotencyKey)
      if (replay) return { ...replay, trade: current(replay.tradeId) }
      const prev = current(resolveId(tradeId))
      entitle(ctx, 'amend', prev.bookId)
      if (expectedVersion !== undefined && expectedVersion !== prev.version) throw new TradeRepoError('CONFLICT', `trade ${prev.tradeId} is at version ${prev.version}, expected ${expectedVersion}`, [{ code: 'STALE_VERSION', path: 'expectedVersion', message: `current version is ${prev.version}` }], true)
      if (TERMINAL.has(prev.status)) throw new TradeRepoError('INVALID_TRANSITION', `cannot amend a ${prev.status} trade`)
      if (!reason) throw new TradeRepoError('VALIDATION_FAILED', 'reason is required for amendments', [{ code: 'REQUIRED', path: 'reason', message: 'reason is required' }])
      const forbidden = Object.keys(changes ?? {}).filter((k) => !ECONOMIC_FIELDS.includes(k) && !NON_ECONOMIC_FIELDS.includes(k))
      if (forbidden.length) throw new TradeRepoError('VALIDATION_FAILED', `fields not amendable: ${forbidden.join(', ')}`, forbidden.map((f) => ({ code: 'NOT_AMENDABLE', path: f, message: 'use a lifecycle event or not amendable' })))
      const next = { ...prev, ...changes }
      if (changes.bookId && changes.bookId !== prev.bookId) throw new TradeRepoError('VALIDATION_FAILED', 'use BOOK_TRANSFER to move a trade between books', [{ code: 'USE_LIFECYCLE', path: 'bookId', message: 'use BOOK_TRANSFER' }])
      const v = validateTrade(next, ref)
      if (!v.valid) throw new TradeRepoError('VALIDATION_FAILED', `${v.errors.length} validation error(s)`, v.errors)
      const diff = diffTrades(prev, next)
      if (diff.length === 0) throw new TradeRepoError('NO_CHANGE', 'amendment changes nothing')
      const amendKind = diff.some((d) => d.economic) ? 'ECONOMIC' : 'NON_ECONOMIC'
      if (changes.notional !== undefined) next.originalNotional = changes.notional
      const event = appendEvent(ctx, { tradeId: prev.tradeId, eventType: 'AMEND', amendKind, validFrom: validFrom ?? prev.validFrom, state: next, reason, idempotencyKey, prev })
      return { tradeId: prev.tradeId, version: event.version, eventId: event.eventId, amendKind, changes: event.changes, warnings: v.warnings, trade: event.state }
    },

    lifecycle(ctx, { tradeId, eventType, expectedVersion, effectiveDate, reason, idempotencyKey, params = {} }) {
      const replay = checkIdem(idempotencyKey)
      if (replay) return { ...replay, trade: current(replay.tradeId) }
      if (!LIFECYCLE_EVENTS.includes(eventType)) throw new TradeRepoError('VALIDATION_FAILED', `eventType must be one of ${LIFECYCLE_EVENTS.join(', ')}`)
      const prev = current(resolveId(tradeId))
      entitle(ctx, 'lifecycle', prev.bookId)
      if (expectedVersion !== undefined && expectedVersion !== prev.version) throw new TradeRepoError('CONFLICT', `trade ${prev.tradeId} is at version ${prev.version}, expected ${expectedVersion}`, [], true)
      if (!TRANSITIONS[prev.status]?.includes(eventType)) throw new TradeRepoError('INVALID_TRANSITION', `${eventType} is not allowed from ${prev.status}`)
      const eff = effectiveDate ?? now().slice(0, 10)
      if (!isDate(eff)) throw new TradeRepoError('VALIDATION_FAILED', 'effectiveDate must be YYYY-MM-DD', [{ code: 'FORMAT', path: 'effectiveDate', message: 'YYYY-MM-DD' }])
      if (eff < prev.tradeDate) throw new TradeRepoError('VALIDATION_FAILED', 'effectiveDate precedes tradeDate', [{ code: 'DATE_ORDER', path: 'effectiveDate', message: 'must be on/after tradeDate' }])
      const next = { ...prev }
      let related = null
      let newTrade = null
      switch (eventType) {
        case 'CANCEL':
          if (!reason) throw new TradeRepoError('VALIDATION_FAILED', 'reason is required to cancel', [{ code: 'REQUIRED', path: 'reason', message: 'reason is required' }])
          next.status = 'CANCELLED'
          break
        case 'MATURE':
          if (eff < prev.maturityDate) throw new TradeRepoError('VALIDATION_FAILED', `cannot mature before maturityDate ${prev.maturityDate}`, [{ code: 'DATE_ORDER', path: 'effectiveDate', message: 'before maturity' }])
          next.status = 'MATURED'
          break
        case 'EXERCISE':
          if (!['EQUITY_OPTION', 'PHOENIX_AUTOCALL'].includes(prev.productType)) throw new TradeRepoError('INVALID_TRANSITION', `${prev.productType} has no exercise right`)
          next.status = 'EXERCISED'
          next.settlement = params.settlement ?? 'CASH'
          break
        case 'PARTIAL_TERMINATE': {
          const amt = Number(params.terminatedNotional)
          if (!(amt > 0) || amt >= prev.notional) throw new TradeRepoError('VALIDATION_FAILED', 'terminatedNotional must be > 0 and < current notional (use a full termination/CANCEL otherwise)', [{ code: 'RANGE', path: 'params.terminatedNotional', message: `0 < x < ${prev.notional}` }])
          next.notional = prev.notional - amt
          next.terminatedNotional = (prev.terminatedNotional ?? 0) + amt
          if (params.fee !== undefined) next.terminationFee = params.fee
          break
        }
        case 'NOVATE': {
          const to = params.transfereeId
          if (!ref.parties.find((p) => p.partyId === to && p.kind === 'COUNTERPARTY')) throw new TradeRepoError('VALIDATION_FAILED', 'params.transfereeId must be a known counterparty', [{ code: 'UNKNOWN_REF', path: 'params.transfereeId', message: 'unknown counterparty' }])
          if (to === prev.counterpartyId) throw new TradeRepoError('VALIDATION_FAILED', 'transferee equals current counterparty')
          next.status = 'NOVATED'
          break
        }
        case 'BOOK_TRANSFER': {
          const to = params.toBookId
          if (!ref.books.find((b) => b.bookId === to)) throw new TradeRepoError('VALIDATION_FAILED', 'params.toBookId must be a known book', [{ code: 'UNKNOWN_REF', path: 'params.toBookId', message: 'unknown book' }])
          entitle(ctx, 'lifecycle', to)
          next.bookId = to
          next.legalEntityId = ref.books.find((b) => b.bookId === to).legalEntityId
          break
        }
      }
      if (eventType === 'NOVATE') {
        // Novation = step-out of the old trade + a new trade with the transferee (new UTI, linked).
        newTrade = api.book(ctx, { validFrom: eff,
          trade: { ...Object.fromEntries([...ECONOMIC_FIELDS, ...NON_ECONOMIC_FIELDS].map((f) => [f, prev[f]])), counterpartyId: params.transfereeId, effectiveDate: eff, externalId: undefined, tags: { ...(prev.tags ?? {}), novatedFrom: prev.tradeId } },
          idempotencyKey: idempotencyKey ? `${idempotencyKey}:novation` : undefined,
        })
        related = { novatedTo: newTrade.tradeId }
      }
      const event = appendEvent(ctx, { tradeId: prev.tradeId, eventType, validFrom: eff, state: next, reason, idempotencyKey, prev, related })
      return { tradeId: prev.tradeId, version: event.version, eventId: event.eventId, trade: event.state, ...(newTrade ? { novatedTo: newTrade.tradeId } : {}) }
    },

    get(ctx, { tradeId, validAt, knownAt }) {
      const id = resolveId(tradeId)
      const s = stateOf(id, { validAt, knownAt })
      if (!s) throw new TradeRepoError('NOT_FOUND', `trade ${tradeId} did not exist as of ${validAt ?? knownAt}`)
      if (!visible(ctx, s)) throw new TradeRepoError('FORBIDDEN', `not entitled to view ${id}`)
      const latest = stateOf(id)
      return { trade: s, isLatest: s.version === latest.version, latestVersion: latest.version, allowedEvents: TRANSITIONS[s.status] ?? [] }
    },

    history(ctx, { tradeId, knownAt }) {
      const id = resolveId(tradeId)
      const evts = eventsOf(id, knownAt)
      if (!visible(ctx, evts[0].state)) throw new TradeRepoError('FORBIDDEN', `not entitled to view ${id}`)
      return { tradeId: id, uti: evts[0].uti, events: evts.map(({ state, kind: _kind, ...e }) => ({ ...e, notional: state.notional, status: state.status })) }
    },

    diff(ctx, { tradeId, fromVersion, toVersion }) {
      const id = resolveId(tradeId)
      const evts = byTrade.get(id)
      const a = evts.find((e) => e.version === fromVersion), b = evts.find((e) => e.version === toVersion)
      if (!a || !b) throw new TradeRepoError('NOT_FOUND', `version not found for ${id}`)
      return { tradeId: id, fromVersion, toVersion, changes: diffTrades(a.state, b.state) }
    },

    query(ctx, { filter = {}, sort = [{ field: 'tradeId', dir: 'desc' }], limit = 100, cursor, validAt, knownAt, includeTerminal = true } = {}) {
      if (limit > 500) throw new TradeRepoError('VALIDATION_FAILED', 'limit must be <= 500', [{ code: 'RANGE', path: 'limit', message: '<= 500' }])
      let rows = []
      for (const id of byTrade.keys()) {
        const s = stateOf(id, { validAt, knownAt })
        if (s && visible(ctx, s)) rows.push(s)
      }
      const inList = (list, v) => !list || list.length === 0 || list.includes(v)
      const text = filter.text?.toLowerCase()
      rows = rows.filter((t) =>
        inList(filter.bookIds, t.bookId) && inList(filter.counterpartyIds, t.counterpartyId) &&
        inList(filter.productTypes, t.productType) && inList(filter.statuses, t.status) &&
        inList(filter.legalEntityIds, t.legalEntityId) && inList(filter.currencies, t.currency) &&
        (includeTerminal || !TERMINAL.has(t.status)) &&
        (!filter.tradeDateFrom || t.tradeDate >= filter.tradeDateFrom) && (!filter.tradeDateTo || t.tradeDate <= filter.tradeDateTo) &&
        (!filter.maturityFrom || t.maturityDate >= filter.maturityFrom) && (!filter.maturityTo || t.maturityDate <= filter.maturityTo) &&
        (!text || [t.tradeId, t.uti, t.externalId, t.underlying, t.trader, t.counterpartyId, t.bookId].some((v) => String(v ?? '').toLowerCase().includes(text))),
      )
      rows.sort((a, b) => {
        for (const { field, dir } of sort) {
          const av = a[field], bv = b[field]
          if (av === bv) continue
          const c = av === undefined ? -1 : bv === undefined ? 1 : av < bv ? -1 : 1
          return dir === 'desc' ? -c : c
        }
        return 0
      })
      const offset = cursor ? Number(Buffer.from(cursor, 'base64').toString('utf8').replace('o:', '')) : 0
      const page = rows.slice(offset, offset + limit)
      const nextCursor = offset + limit < rows.length ? Buffer.from(`o:${offset + limit}`).toString('base64') : null
      return { items: page, total: rows.length, nextCursor, asOf: { validAt: validAt ?? null, knownAt: knownAt ?? null } }
    },

    positions(ctx, { groupBy = ['bookId', 'productType', 'underlying', 'currency'], validAt, knownAt, filter = {} } = {}) {
      const { items } = api.query(ctx, { filter: { ...filter, statuses: ['LIVE'] }, limit: 500, validAt, knownAt })
      const all = []
      let cursor
      let page = { items, nextCursor: null }
      all.push(...page.items)
      // fetch all pages
      cursor = api.query(ctx, { filter: { ...filter, statuses: ['LIVE'] }, limit: 500, validAt, knownAt }).nextCursor
      while (cursor) {
        page = api.query(ctx, { filter: { ...filter, statuses: ['LIVE'] }, limit: 500, cursor, validAt, knownAt })
        all.push(...page.items)
        cursor = page.nextCursor
      }
      const groups = new Map()
      for (const t of all) {
        const key = groupBy.map((g) => t[g] ?? '—').join('|')
        if (!groups.has(key)) groups.set(key, { key: Object.fromEntries(groupBy.map((g) => [g, t[g] ?? null])), netNotional: 0, grossNotional: 0, longNotional: 0, shortNotional: 0, tradeCount: 0, tradeIds: [] })
        const g = groups.get(key)
        const signed = t.side === 'BUY' ? t.notional : -t.notional
        g.netNotional += signed
        g.grossNotional += t.notional
        if (signed > 0) g.longNotional += signed; else g.shortNotional += signed
        g.tradeCount += 1
        g.tradeIds.push(t.tradeId)
      }
      const rows = [...groups.values()].sort((a, b) => Math.abs(b.grossNotional) - Math.abs(a.grossNotional))
      return { groupBy, rows, asOf: { validAt: validAt ?? null, knownAt: knownAt ?? null }, tradeCount: all.length }
    },

    /** Booking-to-risk linkage: a doc-51 `fina.position-snapshot/v1` envelope over live trades. */
    positionSnapshot(ctx, { portfolioId, validAt, knownAt } = {}) {
      const books = portfolioId ? ref.books.filter((b) => b.bookId === portfolioId || b.deskId === portfolioId || b.legalEntityId === portfolioId).map((b) => b.bookId) : undefined
      const { items, total } = api.query(ctx, { filter: { statuses: ['LIVE'], bookIds: books }, limit: 500, validAt, knownAt })
      const positions = items.map((t) => ({
        positionId: `pos:${t.tradeId}`, portfolioId: t.bookId, instrumentId: `fina:instrument:${t.tradeId}`, instrumentVersion: t.contentHash,
        quantity: t.side === 'BUY' ? t.notional : -t.notional, quantityKind: 'notional', bookedAt: t.recordedAt, tradeDate: t.tradeDate,
        settlementDate: t.effectiveDate ?? null, fxFactorId: null, status: 'open', tags: { uti: t.uti, tradeVersion: String(t.version) },
      }))
      const gross = {}
      for (const t of items) gross[t.currency] = (gross[t.currency] ?? 0) + t.notional
      const payload = { portfolioIds: [...new Set(positions.map((p) => p.portfolioId))], positions, grossNotional: Object.entries(gross).map(([currency, amount]) => ({ amount, currency })) }
      return {
        schema: 'fina.position-snapshot/v1', id: `fina:position-snapshot:${portfolioId ?? 'all'}`, version: contentHash(payload),
        asOf: validAt ?? now(), recordedAt: knownAt ?? now(), producer: { name: 'fina-trade-repo', version: '1.0.0' },
        links: { trades: items.map((t) => `${t.tradeId}@${t.version}`) }, payload, truncated: total > items.length,
      }
    },

    auditQuery(ctx, { filter = {}, limit = 100, cursor } = {}) {
      let rows = audit.filter((a) =>
        (!filter.actor || a.actor === filter.actor) && (!filter.action || a.action === filter.action) &&
        (!filter.targetId || a.target?.id === filter.targetId) && (!filter.from || a.occurredAt >= filter.from) && (!filter.to || a.occurredAt <= filter.to))
      rows = rows.slice().reverse()
      const offset = cursor ? Number(Buffer.from(cursor, 'base64').toString('utf8').replace('o:', '')) : 0
      return { items: rows.slice(offset, offset + limit), total: rows.length, nextCursor: offset + limit < rows.length ? Buffer.from(`o:${offset + limit}`).toString('base64') : null }
    },

    reconRun(ctx, { source, records, asOfDate, tolerance = { notional: 0.01 } }) {
      entitle(ctx, 'break', null)
      if (!source) throw new TradeRepoError('VALIDATION_FAILED', 'source is required')
      if (!Array.isArray(records)) throw new TradeRepoError('VALIDATION_FAILED', 'records must be an array')
      const runId = `REC-${String(reconRuns.length + 1).padStart(4, '0')}`
      const ours = api.query({ role: 'admin', actor: 'system' }, { filter: { statuses: ['LIVE'] }, limit: 500, validAt: asOfDate }).items
      const byUti = new Map(ours.map((t) => [t.uti, t]))
      const seen = new Set()
      const created = []
      const mk = (type, uti, detail, tradeId) => {
        const b = { kind: 'break', breakId: `BRK-${String(breaks.size + created.length + 1).padStart(5, '0')}`, runId, source, type, uti, tradeId: tradeId ?? null, detail, status: 'OPEN', assignee: null, comments: [], createdAt: ctx.recordedAt ?? now(), updatedAt: ctx.recordedAt ?? now() }
        created.push(b)
      }
      let matched = 0
      for (const r of records) {
        const t = byUti.get(r.uti)
        if (!t) { mk('MISSING_IN_REPO', r.uti, { external: r }); continue }
        seen.add(r.uti)
        const mismatches = []
        if (r.notional !== undefined && Math.abs(r.notional - t.notional) > Math.max(tolerance.notional * t.notional, 0.005)) mismatches.push({ field: 'notional', ours: t.notional, theirs: r.notional })
        for (const f of ['maturityDate', 'currency', 'counterpartyId', 'side']) if (r[f] !== undefined && r[f] !== t[f]) mismatches.push({ field: f, ours: t[f], theirs: r[f] })
        if (mismatches.length) mk('FIELD_MISMATCH', r.uti, { mismatches }, t.tradeId); else matched++
      }
      for (const t of ours) if (!seen.has(t.uti) && (!records.length || records.some(() => true))) if (!records.find((r) => r.uti === t.uti)) mk('MISSING_IN_EXTERNAL', t.uti, { ours: { notional: t.notional, maturityDate: t.maturityDate } }, t.tradeId)
      const run = { kind: 'recon-run', runId, source, asOfDate: asOfDate ?? null, ranAt: ctx.recordedAt ?? now(), actor: ctx.actor, summary: { external: records.length, internal: ours.length, matched, breaks: created.length, byType: created.reduce((m, b) => ({ ...m, [b.type]: (m[b.type] ?? 0) + 1 }), {}) } }
      applyRecord(run, true)
      for (const b of created) applyRecord(b, true)
      writeAudit(ctx, 'recon.run', { type: 'recon-run', id: runId }, run.summary)
      return run
    },

    reconRuns() {
      return { items: reconRuns.slice().reverse() }
    },

    breaksQuery(ctx, { filter = {}, limit = 200 } = {}) {
      const rows = [...breaks.values()].filter((b) => (!filter.runId || b.runId === filter.runId) && (!filter.statuses?.length || filter.statuses.includes(b.status)) && (!filter.types?.length || filter.types.includes(b.type)))
      return { items: rows.slice(0, limit).map(({ kind: _kind, ...b }) => b), total: rows.length, nextCursor: null }
    },

    breakUpdate(ctx, { breakId, status, assignee, comment, expectedUpdatedAt }) {
      entitle(ctx, 'break', null)
      const b = breaks.get(breakId)
      if (!b) throw new TradeRepoError('NOT_FOUND', `break ${breakId} not found`)
      if (expectedUpdatedAt && expectedUpdatedAt !== b.updatedAt) throw new TradeRepoError('CONFLICT', 'break was updated by someone else', [], true)
      const allowed = { OPEN: ['INVESTIGATING', 'RESOLVED', 'WAIVED'], INVESTIGATING: ['OPEN', 'RESOLVED', 'WAIVED'], RESOLVED: ['OPEN'], WAIVED: ['OPEN'] }
      if (status && status !== b.status && !allowed[b.status].includes(status)) throw new TradeRepoError('INVALID_TRANSITION', `break cannot go ${b.status} -> ${status}`)
      if ((status === 'WAIVED' || status === 'RESOLVED') && !comment) throw new TradeRepoError('VALIDATION_FAILED', 'a comment is required to resolve or waive a break', [{ code: 'REQUIRED', path: 'comment', message: 'comment required' }])
      const at = now()
      const next = { ...b, status: status ?? b.status, assignee: assignee === undefined ? b.assignee : assignee, comments: comment ? [...b.comments, { at, actor: ctx.actor, text: comment }] : b.comments, updatedAt: at }
      applyRecord(next, true)
      writeAudit(ctx, 'recon.break.update', { type: 'break', id: breakId }, { from: b.status, to: next.status, assignee: next.assignee })
      const { kind: _kind, ...rest } = next
      return rest
    },

    bulkImport(ctx, { rows, dryRun = false, mode = 'all-or-nothing' }) {
      if (!Array.isArray(rows) || rows.length === 0) throw new TradeRepoError('VALIDATION_FAILED', 'rows must be a non-empty array')
      if (rows.length > 1000) throw new TradeRepoError('VALIDATION_FAILED', 'at most 1000 rows per import')
      const results = rows.map((row, i) => {
        const trade = normaliseRow(row)
        const v = validateTrade(trade, ref)
        const dup = trade.externalId && [...byTrade.values()].some((e) => e[0].state.externalId === trade.externalId)
        if (dup) v.errors.push({ code: 'DUPLICATE', path: 'externalId', message: `externalId ${trade.externalId} already booked` })
        try { if (v.errors.length === 0) entitle(ctx, 'import', trade.bookId) } catch (e) { v.errors.push({ code: e.code, path: 'bookId', message: e.message }) }
        return { row: i + 1, externalId: trade.externalId ?? null, status: v.errors.length ? 'ERROR' : 'OK', errors: v.errors, warnings: v.warnings, trade }
      })
      const failed = results.filter((r) => r.status === 'ERROR').length
      if (dryRun || (mode === 'all-or-nothing' && failed > 0)) {
        return { dryRun, committed: 0, failed, results: results.map(({ trade: _trade, ...r }) => r) }
      }
      let committed = 0
      for (const r of results) {
        if (r.status !== 'OK') continue
        const out = api.book(ctx, { trade: r.trade, idempotencyKey: r.trade.externalId ? `import:${r.trade.externalId}` : undefined })
        r.tradeId = out.tradeId
        committed++
      }
      writeAudit(ctx, 'trade.import', { type: 'import', id: `rows:${rows.length}` }, { committed, failed })
      return { dryRun: false, committed, failed, results: results.map(({ trade: _trade, ...r }) => r) }
    },

    exportTrades(ctx, { format = 'csv', ...q } = {}) {
      const all = []
      let cursor
      do {
        const page = api.query(ctx, { ...q, limit: 500, cursor })
        all.push(...page.items)
        cursor = page.nextCursor
      } while (cursor)
      if (format === 'json') return { format, count: all.length, content: JSON.stringify(all, null, 2) }
      const cols = ['tradeId', 'uti', 'version', 'status', 'productType', 'side', 'notional', 'currency', 'underlying', 'tradeDate', 'effectiveDate', 'maturityDate', 'counterpartyId', 'bookId', 'legalEntityId', 'trader', 'externalId']
      const esc = (v) => (v === undefined || v === null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))
      const content = [cols.join(','), ...all.map((t) => cols.map((c) => esc(t[c])).join(','))].join('\n')
      return { format, count: all.length, content }
    },
  }
  return api
}

export function normaliseRow(row) {
  const num = (v) => (v === undefined || v === '' || v === null ? undefined : Number(v))
  const t = { ...row }
  for (const f of ['notional', 'price', 'fixedRate', 'strike', 'quantity']) if (t[f] !== undefined) t[f] = num(t[f])
  for (const k of Object.keys(t)) if (t[k] === '' || t[k] === undefined) delete t[k]
  if (t.side) t.side = String(t.side).toUpperCase()
  if (t.productType) t.productType = String(t.productType).toUpperCase()
  return t
}

export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/)
  const split = (line) => {
    const out = []; let cur = ''; let q = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (c === '"') q = false; else cur += c }
      else if (c === '"') q = true
      else if (c === ',') { out.push(cur); cur = '' } else cur += c
    }
    out.push(cur)
    return out
  }
  const header = split(lines[0]).map((h) => h.trim())
  return lines.slice(1).filter((l) => l.trim()).map((l) => Object.fromEntries(split(l).map((v, i) => [header[i], v.trim()])))
}
