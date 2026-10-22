// MCP tool catalog for the trade repository. Every tool takes an optional `context`
// ({actor, role, correlationId}); in production this comes from the authenticated session.
import { KERNEL_EVENTS, ROLES } from './core.mjs'

const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const ts = { type: 'string', description: 'ISO-8601 UTC timestamp (system/knowledge time)' }
const context = { type: 'object', properties: { actor: { type: 'string' }, role: { enum: ROLES }, correlationId: { type: 'string' } }, additionalProperties: false }
const idem = { type: 'string', maxLength: 128, description: 'Client-generated key; a replay returns the original result instead of a duplicate booking' }
const tradeRef = { type: 'string', description: 'tradeId, UTI or externalId' }
const tradeInput = {
  type: 'object', required: ['productType', 'side', 'notional', 'currency', 'tradeDate', 'counterpartyId', 'bookId', 'terms'],
  description: 'Kernel fields + product `terms` validated against the product template (see tr_product_get). maturityDate may be derived from the template schedule.',
  properties: {
    productType: { type: 'string', description: 'Product template id, e.g. PHOENIX_AUTOCALL (tr_product_list)' },
    productTemplate: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'integer' } }, description: 'Pin a template version (default: latest active)' },
    side: { enum: ['BUY', 'SELL'] }, notional: { type: 'number', exclusiveMinimum: 0 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' }, tradeDate: date, effectiveDate: date, maturityDate: date,
    counterpartyId: { type: 'string' }, bookId: { type: 'string' },
    terms: { type: 'object', description: 'Product economics; schema is the template terms.fields' },
    trader: { type: 'string' }, venue: { type: 'string' }, externalId: { type: 'string' }, uti: { type: 'string', maxLength: 52 },
    tags: { type: 'object', additionalProperties: { type: 'string' } }, comment: { type: 'string' },
  },
}
const filter = {
  type: 'object', properties: {
    text: { type: 'string' }, bookIds: { type: 'array', items: { type: 'string' } }, counterpartyIds: { type: 'array', items: { type: 'string' } },
    legalEntityIds: { type: 'array', items: { type: 'string' } }, productTypes: { type: 'array', items: { type: 'string' } },
    statuses: { type: 'array', items: { type: 'string' } }, currencies: { type: 'array', items: { type: 'string' } },
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
  { name: 'tr_trade_lifecycle', description: `Apply a lifecycle event declared by the trade's product template (tr_trade_events lists the allowed ones and their params). Kernel events: ${KERNEL_EVENTS.filter((e) => e !== 'NEW' && e !== 'AMEND').join(', ')}. Phoenix: FIXING {n, levels{symbol: close}} derives COUPON / KNOCK_IN / AUTOCALL / REDEMPTION as separate events; KI_MONITOR {date, levels}; CORPORATE_ACTION {symbol, type, exDate, ratio|dividend+cumPrice}; UNWIND {notional, pricePct, date}; CANCEL.`, inputSchema: obj({ tradeId: tradeRef, eventType: { type: 'string' }, expectedVersion: { type: 'integer' }, effectiveDate: date, reason: { type: 'string' }, idempotencyKey: idem, params: { type: 'object' } }, ['tradeId', 'eventType']), run: (r, a, c) => r.lifecycle(c, a) },
  { name: 'tr_fixing_due', description: 'List product-scheduled observations due on or before asOfDate for ops/admin review. This does not fetch or post market data.', inputSchema: obj({ asOfDate: date, limit: { type: 'integer', minimum: 1, maximum: 500 }, bookIds: { type: 'array', items: { type: 'string' } } }, ['asOfDate']), run: (r, a, c) => r.fixingDue(c, a) },
  { name: 'tr_fixings_bulk', description: 'Preview or commit up to 500 one-per-trade Phoenix fixings. Uses normal lifecycle validation, expectedVersion and per-row idempotency keys. all-or-nothing writes nothing if any row is invalid; best-effort commits valid rows. Every fixing needs source and sourceObservedAt. This is operator-submitted data, not an unattended market-data feed.', inputSchema: obj({ rows: { type: 'array', maxItems: 500, items: { type: 'object', required: ['tradeId', 'expectedVersion', 'n', 'levels', 'source', 'sourceObservedAt', 'idempotencyKey'], properties: { tradeId: tradeRef, expectedVersion: { type: 'integer', minimum: 1 }, n: { type: 'integer', minimum: 1 }, levels: { type: 'object', additionalProperties: { type: 'number' } }, source: { type: 'string', minLength: 1 }, sourceObservedAt: { type: 'string', description: 'ISO-8601 timestamp with timezone' }, evidenceRef: { type: 'string' }, reason: { type: 'string' }, idempotencyKey: idem }, additionalProperties: false } }, dryRun: { type: 'boolean', default: true }, mode: { enum: ['all-or-nothing', 'best-effort'], default: 'all-or-nothing' } }, ['rows']), run: (r, a, c) => r.bulkFixings(c, a) },
  { name: 'tr_trade_events', description: 'Lifecycle events of the trade\'s product template with allowed flag (from current status + role), derived flag and parameter schema.', inputSchema: obj({ tradeId: tradeRef }, ['tradeId']), run: (r, a, c) => r.events(c, a) },
  { name: 'tr_trade_termsheet', description: 'Term sheet of a trade (version optional) rendered from the product template layout.', inputSchema: obj({ tradeId: tradeRef, version: { type: 'integer', minimum: 1 } }, ['tradeId']), run: (r, a, c) => r.termSheet(c, a) },
  { name: 'tr_trade_schedule', description: 'Observation schedule joined with fixings, coupon determinations, autocall, knock-in and redemption (observation timeline).', inputSchema: obj({ tradeId: tradeRef, version: { type: 'integer', minimum: 1 } }, ['tradeId']), run: (r, a, c) => r.schedule(c, a) },
  { name: 'tr_trade_pricing', description: 'Pricer binding: engine/tool/payoff and the mapped parameters (e.g. riga price_trade PhoenixTrade) for a trade.', inputSchema: obj({ tradeId: tradeRef, version: { type: 'integer', minimum: 1 } }, ['tradeId']), run: (r, a, c) => r.pricing(c, a) },
  { name: 'tr_product_list', description: 'Registered product templates (id, version, name, status).', inputSchema: obj({}), run: (r) => r.products() },
  { name: 'tr_product_get', description: 'Full product template (fina.product-template/v1): term schema, constraints, schedules, lifecycle, pricing binding, UI hints.', inputSchema: obj({ id: { type: 'string' }, version: { type: 'integer', minimum: 1 } }, ['id']), run: (r, a, c) => r.product(c, a) },
  { name: 'tr_product_register', description: 'Admin: register a new product template version as data (immutable once registered; validated: field types, expressions, plugins, statuses).', inputSchema: obj({ template: { type: 'object' } }, ['template']), run: (r, a, c) => r.registerProduct(c, a) },
  { name: 'tr_trade_get', description: 'Get one trade at an exact version, or bitemporally as of validAt (business date) and knownAt (system time).', inputSchema: obj({ tradeId: tradeRef, version: { type: 'integer', minimum: 1, description: 'Exact version (overrides as-of)' }, ...asOf }, ['tradeId']), run: (r, a, c) => r.get(c, a) },
  { name: 'tr_trade_query', description: 'Query trades with filters, multi-field sort and cursor pagination, optionally as of a point in (bi)time.', inputSchema: obj({ filter, sort: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, dir: { enum: ['asc', 'desc'] } } } }, limit: { type: 'integer', minimum: 1, maximum: 500 }, cursor: { type: 'string' }, ...asOf }), run: (r, a, c) => r.query(c, a) },
  { name: 'tr_trade_history', description: 'Immutable event history (all versions) of a trade with per-event field changes.', inputSchema: obj({ tradeId: tradeRef, knownAt: ts }, ['tradeId']), run: (r, a, c) => r.history(c, a) },
  { name: 'tr_trade_diff', description: 'Field-level diff between two versions of a trade (economic flag per field).', inputSchema: obj({ tradeId: tradeRef, fromVersion: { type: 'integer' }, toVersion: { type: 'integer' } }, ['tradeId', 'fromVersion', 'toVersion']), run: (r, a, c) => r.diff(c, a) },
  { name: 'tr_position_query', description: 'Aggregate LIVE trades into positions (net/gross/long/short notional, trade count) by groupBy dimensions, as of a date.', inputSchema: obj({ groupBy: { type: 'array', items: { enum: ['bookId', 'productType', 'underlying', 'currency', 'counterpartyId', 'legalEntityId', 'terms.issuerId'] } }, filter, ...asOf }), run: (r, a, c) => r.positions(c, a) },
  { name: 'tr_position_snapshot', description: 'Booking-to-risk linkage: emit a doc-51 fina.position-snapshot/v1 envelope for a book/desk/legal entity.', inputSchema: obj({ portfolioId: { type: 'string' }, ...asOf }), run: (r, a, c) => r.positionSnapshot(c, a) },
  { name: 'tr_audit_query', description: 'Append-only audit trail (who did what, when, with correlation id).', inputSchema: obj({ filter: { type: 'object', properties: { actor: { type: 'string' }, action: { type: 'string' }, targetId: { type: 'string' }, from: ts, to: ts } }, limit: { type: 'integer', maximum: 500 }, cursor: { type: 'string' } }), run: (r, a, c) => r.auditQuery(c, a) },
  { name: 'tr_recon_run', description: 'Reconcile an external report (e.g. regulator TR / counterparty) by UTI; creates breaks MISSING_IN_REPO, MISSING_IN_EXTERNAL, FIELD_MISMATCH.', inputSchema: obj({ source: { type: 'string' }, asOfDate: date, records: { type: 'array', items: { type: 'object', required: ['uti'] } }, tolerance: { type: 'object', properties: { notional: { type: 'number' } } } }, ['source', 'records']), run: (r, a, c) => r.reconRun(c, a) },
  { name: 'tr_recon_runs', description: 'List reconciliation runs with summaries.', inputSchema: obj({}), run: (r) => r.reconRuns() },
  { name: 'tr_recon_breaks_query', description: 'Query reconciliation breaks.', inputSchema: obj({ filter: { type: 'object', properties: { runId: { type: 'string' }, statuses: { type: 'array', items: { enum: ['OPEN', 'INVESTIGATING', 'RESOLVED', 'WAIVED'] } }, types: { type: 'array', items: { type: 'string' } } } }, limit: { type: 'integer' } }), run: (r, a, c) => r.breaksQuery(c, a) },
  { name: 'tr_recon_break_update', description: 'Break workflow: assign, comment, move OPEN -> INVESTIGATING -> RESOLVED|WAIVED (comment required to close).', inputSchema: obj({ breakId: { type: 'string' }, status: { enum: ['OPEN', 'INVESTIGATING', 'RESOLVED', 'WAIVED'] }, assignee: { type: ['string', 'null'] }, comment: { type: 'string' }, expectedUpdatedAt: ts }, ['breakId']), run: (r, a, c) => r.breakUpdate(c, a) },
  { name: 'tr_bulk_import', description: 'Bulk import trades (rows as objects; use csv for CSV text). dryRun validates only; mode all-or-nothing | best-effort. Idempotent per externalId.', inputSchema: obj({ rows: { type: 'array', items: { type: 'object' }, maxItems: 1000 }, csv: { type: 'string' }, dryRun: { type: 'boolean' }, mode: { enum: ['all-or-nothing', 'best-effort'] } }), run: (r, a, c) => r.bulkImport(c, a) },
  { name: 'tr_export', description: 'Export trades matching a query as CSV or JSON.', inputSchema: obj({ format: { enum: ['csv', 'json'] }, filter, ...asOf }), run: (r, a, c) => r.exportTrades(c, a) },
]
