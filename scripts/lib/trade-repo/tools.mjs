// MCP tool catalog for the trade repository. Every tool takes an optional `context`
// ({actor, role, correlationId}); in production this comes from the authenticated session.
import { EVENT_TYPES, LIFECYCLE_EVENTS, PRODUCT_TYPES, STATUSES, ROLES } from './core.mjs'

const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const ts = { type: 'string', description: 'ISO-8601 UTC timestamp (system/knowledge time)' }
const context = { type: 'object', properties: { actor: { type: 'string' }, role: { enum: ROLES }, correlationId: { type: 'string' } }, additionalProperties: false }
const idem = { type: 'string', maxLength: 128, description: 'Client-generated key; a replay returns the original result instead of a duplicate booking' }
const tradeRef = { type: 'string', description: 'tradeId, UTI or externalId' }
const tradeInput = {
  type: 'object', required: ['productType', 'side', 'notional', 'currency', 'tradeDate', 'maturityDate', 'counterpartyId', 'bookId'],
  properties: {
    productType: { enum: PRODUCT_TYPES }, side: { enum: ['BUY', 'SELL'] }, notional: { type: 'number', exclusiveMinimum: 0 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' }, underlying: { type: 'string' }, price: { type: 'number' }, fixedRate: { type: 'number' },
    strike: { type: 'number' }, optionType: { enum: ['CALL', 'PUT'] }, quantity: { type: 'number' },
    tradeDate: date, effectiveDate: date, maturityDate: date, counterpartyId: { type: 'string' }, bookId: { type: 'string' },
    trader: { type: 'string' }, venue: { type: 'string' }, externalId: { type: 'string' }, uti: { type: 'string', maxLength: 52 },
    tags: { type: 'object', additionalProperties: { type: 'string' } }, comment: { type: 'string' },
  },
}
const filter = {
  type: 'object', properties: {
    text: { type: 'string' }, bookIds: { type: 'array', items: { type: 'string' } }, counterpartyIds: { type: 'array', items: { type: 'string' } },
    legalEntityIds: { type: 'array', items: { type: 'string' } }, productTypes: { type: 'array', items: { enum: PRODUCT_TYPES } },
    statuses: { type: 'array', items: { enum: STATUSES } }, currencies: { type: 'array', items: { type: 'string' } },
    tradeDateFrom: date, tradeDateTo: date, maturityFrom: date, maturityTo: date,
  },
}
const asOf = { validAt: { ...date, description: 'Business (valid) date' }, knownAt: ts }
const obj = (properties, required = []) => ({ type: 'object', properties: { context, ...properties }, required, additionalProperties: false })

export const TOOLS = [
  { name: 'tr_capabilities', description: 'Product types, lifecycle state machine, roles and limits supported by this repository.', inputSchema: obj({}), run: (r) => r.capabilities() },
  { name: 'tr_reference_list', description: 'Reference data: legal entities, counterparties, desks, books (hierarchy) and users/entitlements.', inputSchema: obj({}), run: (r) => r.reference },
  { name: 'tr_trade_validate', description: 'Validate a trade without booking it. Returns errors and warnings (fat-finger, off-market).', inputSchema: obj({ trade: tradeInput }, ['trade']), run: (r, a) => r.validate(a.trade) },
  { name: 'tr_trade_book', description: 'Book a NEW trade. Idempotent on idempotencyKey; assigns tradeId and UTI; version 1.', inputSchema: obj({ trade: tradeInput, idempotencyKey: idem, dryRun: { type: 'boolean' } }, ['trade']), run: (r, a, c) => r.book(c, a) },
  { name: 'tr_trade_amend', description: 'Amend a LIVE trade. Optimistic concurrency via expectedVersion; classifies the amend as ECONOMIC or NON_ECONOMIC; reason mandatory.', inputSchema: obj({ tradeId: tradeRef, expectedVersion: { type: 'integer', minimum: 1 }, changes: { type: 'object' }, reason: { type: 'string', minLength: 1 }, validFrom: date, idempotencyKey: idem }, ['tradeId', 'changes', 'reason']), run: (r, a, c) => r.amend(c, a) },
  { name: 'tr_trade_lifecycle', description: `Apply a lifecycle event: ${LIFECYCLE_EVENTS.join(', ')}. params: PARTIAL_TERMINATE {terminatedNotional, fee?}; NOVATE {transfereeId}; BOOK_TRANSFER {toBookId}; EXERCISE {settlement?}.`, inputSchema: obj({ tradeId: tradeRef, eventType: { enum: LIFECYCLE_EVENTS }, expectedVersion: { type: 'integer' }, effectiveDate: date, reason: { type: 'string' }, idempotencyKey: idem, params: { type: 'object' } }, ['tradeId', 'eventType']), run: (r, a, c) => r.lifecycle(c, a) },
  { name: 'tr_trade_get', description: 'Get one trade, optionally bitemporally as of validAt (business date) and knownAt (system time).', inputSchema: obj({ tradeId: tradeRef, ...asOf }, ['tradeId']), run: (r, a, c) => r.get(c, a) },
  { name: 'tr_trade_query', description: 'Query trades with filters, multi-field sort and cursor pagination, optionally as of a point in (bi)time.', inputSchema: obj({ filter, sort: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, dir: { enum: ['asc', 'desc'] } } } }, limit: { type: 'integer', minimum: 1, maximum: 500 }, cursor: { type: 'string' }, ...asOf }), run: (r, a, c) => r.query(c, a) },
  { name: 'tr_trade_history', description: 'Immutable event history (all versions) of a trade with per-event field changes.', inputSchema: obj({ tradeId: tradeRef, knownAt: ts }, ['tradeId']), run: (r, a, c) => r.history(c, a) },
  { name: 'tr_trade_diff', description: 'Field-level diff between two versions of a trade (economic flag per field).', inputSchema: obj({ tradeId: tradeRef, fromVersion: { type: 'integer' }, toVersion: { type: 'integer' } }, ['tradeId', 'fromVersion', 'toVersion']), run: (r, a, c) => r.diff(c, a) },
  { name: 'tr_position_query', description: 'Aggregate LIVE trades into positions (net/gross/long/short notional, trade count) by groupBy dimensions, as of a date.', inputSchema: obj({ groupBy: { type: 'array', items: { enum: ['bookId', 'productType', 'underlying', 'currency', 'counterpartyId', 'legalEntityId'] } }, filter, ...asOf }), run: (r, a, c) => r.positions(c, a) },
  { name: 'tr_position_snapshot', description: 'Booking-to-risk linkage: emit a doc-51 fina.position-snapshot/v1 envelope for a book/desk/legal entity.', inputSchema: obj({ portfolioId: { type: 'string' }, ...asOf }), run: (r, a, c) => r.positionSnapshot(c, a) },
  { name: 'tr_audit_query', description: 'Append-only audit trail (who did what, when, with correlation id).', inputSchema: obj({ filter: { type: 'object', properties: { actor: { type: 'string' }, action: { type: 'string' }, targetId: { type: 'string' }, from: ts, to: ts } }, limit: { type: 'integer', maximum: 500 }, cursor: { type: 'string' } }), run: (r, a, c) => r.auditQuery(c, a) },
  { name: 'tr_recon_run', description: 'Reconcile an external report (e.g. regulator TR / counterparty) by UTI; creates breaks MISSING_IN_REPO, MISSING_IN_EXTERNAL, FIELD_MISMATCH.', inputSchema: obj({ source: { type: 'string' }, asOfDate: date, records: { type: 'array', items: { type: 'object', required: ['uti'] } }, tolerance: { type: 'object', properties: { notional: { type: 'number' } } } }, ['source', 'records']), run: (r, a, c) => r.reconRun(c, a) },
  { name: 'tr_recon_runs', description: 'List reconciliation runs with summaries.', inputSchema: obj({}), run: (r) => r.reconRuns() },
  { name: 'tr_recon_breaks_query', description: 'Query reconciliation breaks.', inputSchema: obj({ filter: { type: 'object', properties: { runId: { type: 'string' }, statuses: { type: 'array', items: { enum: ['OPEN', 'INVESTIGATING', 'RESOLVED', 'WAIVED'] } }, types: { type: 'array', items: { type: 'string' } } } }, limit: { type: 'integer' } }), run: (r, a, c) => r.breaksQuery(c, a) },
  { name: 'tr_recon_break_update', description: 'Break workflow: assign, comment, move OPEN -> INVESTIGATING -> RESOLVED|WAIVED (comment required to close).', inputSchema: obj({ breakId: { type: 'string' }, status: { enum: ['OPEN', 'INVESTIGATING', 'RESOLVED', 'WAIVED'] }, assignee: { type: ['string', 'null'] }, comment: { type: 'string' }, expectedUpdatedAt: ts }, ['breakId']), run: (r, a, c) => r.breakUpdate(c, a) },
  { name: 'tr_bulk_import', description: 'Bulk import trades (rows as objects; use csv for CSV text). dryRun validates only; mode all-or-nothing | best-effort. Idempotent per externalId.', inputSchema: obj({ rows: { type: 'array', items: { type: 'object' }, maxItems: 1000 }, csv: { type: 'string' }, dryRun: { type: 'boolean' }, mode: { enum: ['all-or-nothing', 'best-effort'] } }), run: (r, a, c) => r.bulkImport(c, a) },
  { name: 'tr_export', description: 'Export trades matching a query as CSV or JSON.', inputSchema: obj({ format: { enum: ['csv', 'json'] }, filter, ...asOf }), run: (r, a, c) => r.exportTrades(c, a) },
]
export { EVENT_TYPES }
