import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = dirname(fileURLToPath(import.meta.url))
import { createRepository, diffTrades, parseCsv, validateTrade, TradeRepoError } from '../core.mjs'
import { REFERENCE } from '../reference.mjs'
import { seedRepository } from '../seed.mjs'
import { createMemoryStore, createSqliteStore, createStoreFromUrl, toRow } from '../store.mjs'
import { checkTemplate, createRegistry, shippedTemplates } from '../product.mjs'
import { adjust, addBusinessDays } from '../calendar.mjs'
import { evaluate } from '../expr.mjs'
import { isinValid } from '../phoenix.mjs'

const admin = { actor: 'trash.box', role: 'admin' }
const ops = { actor: 'olga.ops', role: 'ops' }
const TEMPLATES = shippedTemplates()
const ELN = JSON.parse(readFileSync(join(__dirname, 'fixtures/eln-stub.v1.json'), 'utf8'))
/** A 2-asset quarterly Phoenix struck on 2026-01-20: AAPL 200, MSFT 400. */
const phx = (o = {}) => ({
  productType: 'PHOENIX_AUTOCALL', side: 'SELL', notional: 1_000_000, currency: 'USD', tradeDate: '2026-01-16', counterpartyId: 'CP-DBS', bookId: 'PHX-ASIA', externalId: o.externalId,
  terms: { isin: 'XS2960012347', underlyings: [{ symbol: 'AAPL', initialFixing: 200 }, { symbol: 'MSFT', initialFixing: 400 }], strikeDate: '2026-01-20', frequency: 'QUARTERLY', numObservations: 4,
    coupon: { ratePerPeriod: 0.02, barrier: 0.7, memory: true }, autocall: { initialLevel: 1, startObservation: 2, stepDown: 0.05, floor: 0.85 }, knockIn: { barrier: 0.6, observation: 'EUROPEAN' }, ...(o.terms ?? {}) },
  ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'terms' && k !== 'externalId')),
})
let clock = 0
const now = () => new Date(Date.UTC(2026, 9, 1) + (clock++) * 1000).toISOString()
const err = (fn) => { try { fn() } catch (e) { return e } throw new Error('expected throw') }
const mk = (store = createMemoryStore(), templates = TEMPLATES) => createRepository({ reference: REFERENCE, store, now, templates })
const fix = (repo, tradeId, n, AAPL, MSFT) => {
  const obs = repo.get(admin, { tradeId }).trade.terms.observations[n - 1]
  return repo.lifecycle(ops, { tradeId, eventType: 'FIXING', params: { n, levels: { AAPL, MSFT }, source: 'Synthetic unit-test source', sourceObservedAt: `${obs.observationDate}T20:00:00Z`, evidenceRef: `unit-test:${tradeId}:${n}` } })
}

describe('expression language + calendars', () => {
  it('evaluates safely', () => {
    expect(evaluate('max(a.b - 0.05 * (n - 2), 0.85)', { a: { b: 1 }, n: 5 })).toBe(0.85)
    expect(evaluate("x > 1 ? 'hi' : 'lo'", { x: 2 })).toBe('hi')
    expect(evaluate('constructor', {})).toBe(null)
    expect(evaluate('a.__proto__', { a: {} })).toBe(null)
    expect(() => evaluate('process.exit(1)', {})).toThrow()
    expect(() => evaluate('eval("1")', {})).toThrow(/unknown function/)
  })
  it('rolls dates with business-day conventions', () => {
    expect(adjust('2026-01-31', 'FOLLOWING', 'NYSE')).toBe('2026-02-02')
    expect(adjust('2026-01-31', 'MODIFIED_FOLLOWING', 'NYSE')).toBe('2026-01-30')
    expect(adjust('2026-12-25', 'FOLLOWING', 'NYSE')).toBe('2026-12-28')
    expect(addBusinessDays('2026-04-02', 1, 'TARGET')).toBe('2026-04-07') // Good Friday + Easter Monday
    expect(isinValid('US0378331005')).toBe(true)
    expect(isinValid('US0378331006')).toBe(false)
  })
})

describe('product registry', () => {
  it('ships a valid Phoenix template and rejects broken templates', () => {
    expect(TEMPLATES.map((t) => t.id)).toContain('PHOENIX_AUTOCALL')
    for (const t of TEMPLATES) expect(checkTemplate(t)).toEqual([])
    const bad = { ...ELN, id: 'bad id', lifecycle: { ...ELN.lifecycle, events: { X: { from: ['NOPE'], plugin: 'nope', guards: [{ expr: '1 +' }] } } } }
    expect(checkTemplate(bad).map((e) => e.path)).toEqual(expect.arrayContaining(['id', 'lifecycle.events.X.plugin', 'lifecycle.events.X.from', 'lifecycle.events.X.guards[0]']))
    const reg = createRegistry([ELN, { ...ELN, version: 2, name: 'v2' }])
    expect(reg.get('ELN_STUB').version).toBe(2)
    expect(reg.get('ELN_STUB', 1).name).toMatch(/stub/)
  })

  it('books, validates, lists and lifecycles a NEW product defined purely as data (ELN stub)', () => {
    const repo = mk()
    expect(err(() => repo.registerProduct(ops, { template: ELN })).code).toBe('FORBIDDEN')
    expect(repo.registerProduct(admin, { template: ELN })).toEqual({ id: 'ELN_STUB', version: 1 })
    expect(err(() => repo.registerProduct(admin, { template: ELN })).code).toBe('CONFLICT')
    const base = { productType: 'ELN_STUB', notional: 500_000, tradeDate: '2026-02-02', maturityDate: '2027-02-02', counterpartyId: 'CP-UOB', bookId: 'PHX-ASIA' }
    const bad = repo.validate({ ...base, terms: { underlying: 'D05', strikePct: 2 } })
    expect(bad.errors).toEqual([expect.objectContaining({ path: 'terms.strikePct', code: 'RANGE' })])
    const out = repo.book(admin, { trade: { ...base, terms: { underlying: 'D05', strikePct: 0.9 } } })
    expect(out.trade).toMatchObject({ productTemplate: { id: 'ELN_STUB', version: 1 }, currency: 'USD', side: 'SELL', underlying: 'D05', terms: { discountPct: 0.05 }, productState: { settled: false } })
    const row = repo.query(admin, { filter: { productTypes: ['ELN_STUB'] } }).items[0]
    expect(row.display).toEqual({ strike: '90%' })
    expect(repo.termSheet(admin, { tradeId: out.tradeId }).sections[0].rows).toEqual([['Underlying', 'D05'], ['Strike', '90%']])
    expect(repo.events(admin, { tradeId: out.tradeId }).events.filter((e) => e.allowed).map((e) => e.name)).toEqual(['SETTLE', 'CANCEL'])
    expect(repo.events({ actor: 'victor.view', role: 'viewer' }, { tradeId: out.tradeId }).events.filter((e) => e.allowed)).toEqual([])
    const s = repo.lifecycle(ops, { tradeId: out.tradeId, eventType: 'SETTLE', params: { finalLevelPct: 0.72 } })
    expect(s.trade).toMatchObject({ status: 'MATURED', validFrom: '2027-02-02', productState: { settled: true, payoutPct: 0.8 } })
    expect(repo.capabilities().productTypes).toEqual(expect.arrayContaining(['PHOENIX_AUTOCALL', 'ELN_STUB']))
  })

  it('keeps trades on the template version they were booked with', () => {
    const repo = mk()
    repo.registerProduct(admin, { template: ELN })
    const base = { productType: 'ELN_STUB', notional: 1e6, tradeDate: '2026-02-02', maturityDate: '2027-02-02', counterpartyId: 'CP-UOB', bookId: 'PHX-ASIA', terms: { underlying: 'D05', strikePct: 0.55 } }
    const v1 = repo.book(admin, { trade: base })
    const v2tpl = JSON.parse(JSON.stringify(ELN)); v2tpl.version = 2; v2tpl.terms.fields[1].min = 0.6
    repo.registerProduct(admin, { template: v2tpl })
    expect(err(() => repo.book(admin, { trade: base })).details[0].path).toBe('terms.strikePct') // new bookings use v2
    expect(repo.amend(admin, { tradeId: v1.tradeId, changes: { trader: 'x' }, reason: 'r' }).trade.productTemplate.version).toBe(1) // v1 trade still valid under v1
  })
})

describe('Phoenix trade repository', () => {
  let repo
  beforeEach(() => { clock = 0; repo = mk() })

  it('validates Phoenix terms generically from the template', () => {
    const v = repo.validate(phx({ terms: { isin: 'XS2960012340', underlyings: [{ symbol: 'AAPL', initialFixing: 200 }, { symbol: 'AAPL', initialFixing: -1 }], coupon: { ratePerPeriod: 0.4, barrier: 0.7 } } }))
    expect(v.errors.map((e) => e.path)).toEqual(expect.arrayContaining(['terms.underlyings[1].initialFixing', 'terms.coupon.ratePerPeriod']))
    const v2 = repo.validate(phx({ terms: { isin: 'XS2960012340' } }))
    expect(v2.errors).toEqual([expect.objectContaining({ path: 'terms.isin', code: 'FORMAT' })])
    const v3 = repo.validate(phx({ notional: 1_000_500 }))
    expect(v3.errors[0]).toMatchObject({ path: 'terms.denomination', code: 'MULTIPLE' })
    expect(repo.validate(phx({ terms: { coupon: { ratePerPeriod: 0.02, barrier: 0.5 } } })).warnings[0].code).toBe('UNUSUAL')
    expect(validateTrade({ ...phx(), productType: 'IRS' }, REFERENCE, createRegistry(TEMPLATES)).errors.map((e) => e.code)).toContain('ENUM')
  })

  it('books with a generated, business-day adjusted schedule, maturity and derived fields', () => {
    const a = repo.book(admin, { trade: phx(), idempotencyKey: 'k1' })
    expect(a.tradeId).toBe('TR-000001')
    expect(a.trade.uti).toMatch(/^549300SGFINA0000SG01FINA/)
    const obs = a.trade.terms.observations
    expect(obs.map((o) => o.observationDate)).toEqual(['2026-04-20', '2026-07-20', '2026-10-20', '2027-01-20'])
    expect(obs.map((o) => o.autocallLevel)).toEqual([null, 1, 0.95, null])
    expect(obs[0].paymentDate).toBe('2026-04-27')
    expect(a.trade).toMatchObject({ maturityDate: '2027-01-27', underlying: 'AAPL/MSFT', status: 'LIVE', productTemplate: { id: 'PHOENIX_AUTOCALL', version: 1 } })
    expect(repo.book(admin, { trade: phx(), idempotencyKey: 'k1' }).replayed).toBe(true)
  })

  it('coupon, memory catch-up and step-down autocall are separate immutable events', () => {
    const { tradeId } = repo.book(admin, { trade: phx() })
    const f1 = fix(repo, tradeId, 1, 190, 420) // worst 95% >= 70% -> coupon; obs 1 not callable
    expect(f1.events.map((e) => e.eventType)).toEqual(['FIXING', 'COUPON'])
    expect(f1.trade.productState.couponsPaidTotal).toBe(20000)
    const f2 = fix(repo, tradeId, 2, 130, 400) // worst 65% < 70% -> missed (memory)
    expect(f2.events[1].detail).toMatchObject({ paid: false, amount: 0 })
    expect(f2.trade.productState.unpaidPeriods).toBe(1)
    expect(err(() => fix(repo, tradeId, 4, 1, 1)).code).toBe('INVALID_TRANSITION') // out of order
    const f3 = fix(repo, tradeId, 3, 196, 410) // 98% >= 70% coupon with memory (2 periods); >= 95% step-down -> autocall
    expect(f3.events.map((e) => e.eventType)).toEqual(['FIXING', 'COUPON', 'AUTOCALL'])
    expect(f3.events[1].detail).toMatchObject({ paid: true, periods: 2, memoryCatchUp: 1, amount: 40000 })
    expect(f3.trade).toMatchObject({ status: 'AUTOCALLED', productState: { couponsPaidTotal: 60000, redemption: { amount: 1_000_000, reason: 'AUTOCALL' } } })
    const h = repo.history(admin, { tradeId }).events
    expect(h.map((e) => e.eventType)).toEqual(['NEW', 'FIXING', 'COUPON', 'FIXING', 'COUPON', 'FIXING', 'COUPON', 'AUTOCALL'])
    expect(h.at(-1).causedBy).toBe(h.at(-3).eventId)
    expect(repo.events(admin, { tradeId }).events.filter((e) => e.allowed)).toEqual([])
    expect(repo.get(admin, { tradeId, validAt: '2026-08-01' }).trade.status).toBe('LIVE') // bitemporal: before the autocall
  })

  it('European knock-in at final valuation redeems at worst-of / strike', () => {
    const { tradeId } = repo.book(admin, { trade: phx({ terms: { autocall: { initialLevel: 1.2, startObservation: 2 } } }) })
    fix(repo, tradeId, 1, 150, 300); fix(repo, tradeId, 2, 110, 300); fix(repo, tradeId, 3, 110, 300) // 55%: below KI but European -> no KI yet
    expect(repo.get(admin, { tradeId }).trade.productState.knockedIn).toBe(false)
    const f4 = fix(repo, tradeId, 4, 104, 380)
    expect(f4.events.map((e) => e.eventType)).toEqual(['FIXING', 'KNOCK_IN', 'COUPON', 'REDEMPTION'])
    expect(f4.trade).toMatchObject({ status: 'MATURED', productState: { knockedIn: true, redemption: { pct: 0.52, amount: 520000, capitalLoss: true } } })
  })

  it('American KI via barrier monitoring; corporate action adjusts initial fixings', () => {
    const { tradeId } = repo.book(admin, { trade: phx({ terms: { knockIn: { barrier: 0.6, observation: 'AMERICAN' } } }) })
    const ca = repo.lifecycle(ops, { tradeId, eventType: 'CORPORATE_ACTION', params: { symbol: 'AAPL', type: 'SPLIT', exDate: '2026-02-10', ratio: 4 }, reason: '4:1 split' })
    expect(ca.trade.terms.underlyings[0].initialFixing).toBe(50)
    expect(ca.events[0].detail).toMatchObject({ factor: 0.25, initialFixingBefore: 200, initialFixingAfter: 50 })
    expect(err(() => repo.lifecycle(ops, { tradeId, eventType: 'CORPORATE_ACTION', params: { symbol: 'TSLA', type: 'SPLIT', exDate: '2026-02-10', ratio: 2 } })).code).toBe('VALIDATION_FAILED')
    const m = repo.lifecycle(ops, { tradeId, eventType: 'KI_MONITOR', params: { date: '2026-03-03', levels: { AAPL: 29, MSFT: 380 } } })
    expect(m.events.map((e) => e.eventType)).toEqual(['KI_MONITOR', 'KNOCK_IN'])
    expect(m.trade.productState).toMatchObject({ knockedIn: true, kiDate: '2026-03-03', kiWorst: 0.58 })
    expect(err(() => repo.lifecycle(ops, { tradeId, eventType: 'KI_MONITOR', params: { date: '2026-03-04', levels: { AAPL: 29, MSFT: 380 } } })).code).toBe('INVALID_TRANSITION')
  })

  it('partial and full buyback, cancel, novation carrying state, book transfer, roles', () => {
    const t1 = repo.book(admin, { trade: phx() }).tradeId
    fix(repo, t1, 1, 190, 420)
    expect(err(() => repo.lifecycle(ops, { tradeId: t1, eventType: 'UNWIND', params: { notional: 250_000, pricePct: 0.97, date: '2026-05-01' } })).code).toBe('VALIDATION_FAILED') // reason required
    const u = repo.lifecycle(ops, { tradeId: t1, eventType: 'UNWIND', params: { notional: 250_000, pricePct: 0.97, date: '2026-05-01' }, reason: 'client buyback' })
    expect(u.trade).toMatchObject({ notional: 750_000, terminatedNotional: 250_000, status: 'LIVE', productState: { unwinds: [{ cash: 242500 }] } })
    expect(err(() => repo.lifecycle(ops, { tradeId: t1, eventType: 'UNWIND', params: { notional: 900_000, pricePct: 1, date: '2026-05-02' }, reason: 'x' })).code).toBe('VALIDATION_FAILED')
    const n = repo.lifecycle(admin, { tradeId: t1, eventType: 'NOVATE', effectiveDate: '2026-06-01', params: { transfereeId: 'CP-UOB' } })
    const succ = repo.get(admin, { tradeId: n.novatedTo }).trade
    expect(succ).toMatchObject({ counterpartyId: 'CP-UOB', notional: 750_000, status: 'LIVE' })
    expect(succ.productState.fixings).toHaveLength(1)
    const t2 = repo.book(admin, { trade: phx() }).tradeId
    expect(repo.lifecycle(admin, { tradeId: t2, eventType: 'BOOK_TRANSFER', effectiveDate: '2026-02-01', params: { toBookId: 'PHX-HEDGE' } }).trade.bookId).toBe('PHX-HEDGE')
    expect(err(() => repo.lifecycle({ actor: 'alice.sg', role: 'trader' }, { tradeId: t2, eventType: 'FIXING', params: { n: 1, levels: { AAPL: 1, MSFT: 1 } } })).code).toBe('FORBIDDEN')
    expect(repo.lifecycle(admin, { tradeId: t2, eventType: 'UNWIND', params: { notional: 1_000_000, pricePct: 0.9, date: '2026-03-01' }, reason: 'full buyback' }).trade.status).toBe('TERMINATED')
    const t3 = repo.book(admin, { trade: phx() }).tradeId
    expect(repo.lifecycle(admin, { tradeId: t3, eventType: 'CANCEL', reason: 'error', effectiveDate: '2026-01-16' }).trade.status).toBe('CANCELLED')
    expect(err(() => repo.lifecycle(admin, { tradeId: t3, eventType: 'CANCEL', reason: 'again' })).code).toBe('INVALID_TRANSITION')
  })

  it('amends terms (economic, leaf-level diff), regenerates schedule before first fixing only', () => {
    const { tradeId } = repo.book(admin, { trade: phx() })
    const ne = repo.amend(admin, { tradeId, expectedVersion: 1, changes: { trader: 'bob' }, reason: 'fix trader' })
    expect(ne.amendKind).toBe('NON_ECONOMIC')
    const ec = repo.amend(admin, { tradeId, expectedVersion: 2, changes: { terms: { coupon: { barrier: 0.65 } } }, reason: 'final TS' })
    expect(ec.amendKind).toBe('ECONOMIC')
    expect(ec.changes.find((c) => c.field === 'terms.coupon.barrier')).toEqual({ field: 'terms.coupon.barrier', before: 0.7, after: 0.65, economic: true })
    expect(ec.trade.terms.observations[0].couponBarrier).toBe(0.65)
    const f = repo.amend(admin, { tradeId, changes: { terms: { frequency: 'MONTHLY', numObservations: 6 } }, reason: 'restructure' })
    expect(f.trade.terms.observations).toHaveLength(6)
    expect(f.trade.maturityDate).toBe('2026-07-27')
    fix(repo, tradeId, 1, 200, 400)
    expect(err(() => repo.amend(admin, { tradeId, changes: { terms: { numObservations: 8 } }, reason: 'x' })).code).toBe('INVALID_TRANSITION')
    expect(err(() => repo.amend(admin, { tradeId, expectedVersion: 1, changes: { trader: 'z' }, reason: 'x' })).code).toBe('CONFLICT')
    expect(err(() => repo.amend(admin, { tradeId, changes: { bookId: 'PHX-EUR' }, reason: 'x' })).details[0].code).toBe('USE_LIFECYCLE')
    expect(diffTrades({ terms: { a: [1, 2] } }, { terms: { a: [1, 3] } })[0]).toMatchObject({ field: 'terms.a[1]', before: 2, after: 3, economic: true })
  })

  it('schedule timeline, term sheet and riga pricer binding', () => {
    const { tradeId } = repo.book(admin, { trade: phx() })
    fix(repo, tradeId, 1, 150, 420)
    const fixEv = repo.events(admin, { tradeId }).events.find((e) => e.name === 'FIXING')
    expect(fixEv.params.find((p) => p.path === 'levels').keys).toEqual(['AAPL', 'MSFT'])
    expect(fixEv.params.find((p) => p.path === 'n').default).toBe(2)
    expect(repo.validate(phx()).preview.schedule).toHaveLength(4)
    const sch = repo.schedule(admin, { tradeId })
    expect(sch.rows[0]).toMatchObject({ status: 'FIXED', fixing: { worst: 0.75, worstSymbol: 'AAPL' }, coupon: { paid: true } })
    expect(sch.rows[1].status).toBe('PENDING')
    const ts = repo.termSheet(admin, { tradeId })
    expect(ts.sections.map((s) => s.title)).toEqual(['Summary', 'Underlyings', 'Key dates', 'Payoff', 'Lifecycle status'])
    expect(ts.sections[1].rows[0]).toEqual(['AAPL', '', 200, 120, 140])
    const pr = repo.pricing(admin, { tradeId })
    expect(pr).toMatchObject({ engine: 'riga', tool: 'price_trade', applicable: true, request: { initialSpots: [200, 400], steps: 4, knockInBarrier: 0.6, couponBarrier: 0.7, memoryCoupon: true, callStartStep: 2 } })
  })

  it('queues due observations and supports atomic/best-effort bulk fixing with immutable provenance and replay', () => {
    const a = repo.book(admin, { trade: phx({ externalId: 'FIX-BULK-A' }) })
    const b = repo.book(admin, { trade: phx({ externalId: 'FIX-BULK-B' }) })
    const due = repo.fixingDue(ops, { asOfDate: '2026-04-20' })
    expect(due).toMatchObject({ asOfDate: '2026-04-20', reviewRequired: true })
    expect(due.items.map((item) => item.tradeId)).toEqual([a.tradeId, b.tradeId])
    expect(due.items[0]).toMatchObject({ version: 1, n: 1, observationDate: '2026-04-20', levelsRequired: ['AAPL', 'MSFT'] })
    const valid = { tradeId: a.tradeId, expectedVersion: 1, n: 1, levels: { AAPL: 190, MSFT: 420 }, source: 'NYSE official close', sourceObservedAt: '2026-04-20T20:00:00-04:00', evidenceRef: 'feed:NYSE:close:2026-04-20:AAPL-MSFT', reason: 'Regular scheduled close', idempotencyKey: 'fix-batch-a-1' }
    const invalid = { ...valid, tradeId: b.tradeId, n: 99, idempotencyKey: 'fix-batch-b-99' }

    const atomic = repo.bulkFixings(ops, { rows: [valid, invalid], dryRun: false, mode: 'all-or-nothing' })
    expect(atomic).toMatchObject({ committed: 0, failed: 1, noWrites: true })
    expect(repo.get(admin, { tradeId: a.tradeId }).trade.productState.fixings).toHaveLength(0)

    const partial = repo.bulkFixings(ops, { rows: [valid, invalid], dryRun: false, mode: 'best-effort' })
    expect(partial).toMatchObject({ committed: 1, failed: 1, noWrites: false })
    expect(partial.results[0]).toMatchObject({ status: 'COMMITTED', tradeId: a.tradeId, n: 1 })
    expect(repo.get(admin, { tradeId: a.tradeId }).trade.productState.fixings[0]).toMatchObject({ source: valid.source, sourceObservedAt: valid.sourceObservedAt, evidenceRef: valid.evidenceRef })
    const replay = repo.lifecycle(ops, { tradeId: valid.tradeId, eventType: 'FIXING', expectedVersion: valid.expectedVersion, params: { n: valid.n, levels: valid.levels, source: valid.source, sourceObservedAt: valid.sourceObservedAt, evidenceRef: valid.evidenceRef }, reason: valid.reason, idempotencyKey: valid.idempotencyKey })
    expect(replay).toMatchObject({ replayed: true, events: [{ eventType: 'FIXING' }, { eventType: 'COUPON' }] })
    expect(replay.version).toBe(partial.results[0].version)
    expect(err(() => repo.lifecycle(ops, { tradeId: valid.tradeId, eventType: 'FIXING', expectedVersion: valid.expectedVersion, params: { n: valid.n, levels: { AAPL: 191, MSFT: 420 }, source: valid.source, sourceObservedAt: valid.sourceObservedAt, evidenceRef: valid.evidenceRef }, reason: valid.reason, idempotencyKey: valid.idempotencyKey })).code).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('answers bitemporal as-of queries and enforces entitlements', () => {
    const { tradeId } = repo.book({ ...admin, recordedAt: '2026-01-16T10:00:00.000Z' }, { trade: phx() })
    repo.amend({ ...admin, recordedAt: '2026-01-19T10:00:00.000Z' }, { tradeId, changes: { notional: 2_000_000 }, reason: 'late allocation', validFrom: '2026-01-16' })
    expect(repo.get(admin, { tradeId, knownAt: '2026-01-17T00:00:00.000Z' }).trade.notional).toBe(1_000_000)
    expect(repo.get(admin, { tradeId }).trade.notional).toBe(2_000_000)
    expect(err(() => repo.book({ actor: 'victor.view', role: 'viewer' }, { trade: phx() })).code).toBe('FORBIDDEN')
    expect(err(() => repo.book({ actor: 'alice.sg', role: 'trader' }, { trade: phx({ bookId: 'PHX-EUR', currency: 'EUR' }) })).code).toBe('FORBIDDEN')
    expect(repo.book({ actor: 'alice.sg', role: 'trader' }, { trade: phx() }).tradeId).toBeTruthy()
    expect(repo.query({ actor: 'eddie.ldn', role: 'trader' }).total).toBe(0)
  })

  it('seeds realistic Phoenix notes in every state; filters, paginates, positions, recon', () => {
    seedRepository(repo)
    const all = repo.query(admin, { limit: 500 }).items
    const statuses = new Set(all.map((t) => t.status))
    for (const s of ['LIVE', 'AUTOCALLED', 'MATURED', 'CANCELLED', 'TERMINATED']) expect(statuses).toContain(s)
    expect(all.some((t) => t.productState.knockedIn && t.productState.redemption?.capitalLoss)).toBe(true)
    expect(all.some((t) => t.productState.corporateActions.length)).toBe(true)
    expect(all.some((t) => t.productState.coupons.some((c) => c.memoryCatchUp > 0))).toBe(true)
    const p1 = repo.query(admin, { limit: 10, sort: [{ field: 'notional', dir: 'desc' }] })
    const p2 = repo.query(admin, { limit: 10, cursor: p1.nextCursor, sort: [{ field: 'notional', dir: 'desc' }] })
    expect(p1.items[9].notional).toBeGreaterThanOrEqual(p2.items[0].notional)
    expect(repo.query(admin, { filter: { text: 'NVDA' } }).items.every((t) => t.underlying.includes('NVDA'))).toBe(true)
    expect(err(() => repo.query(admin, { limit: 501 })).code).toBe('VALIDATION_FAILED')
    const pos = repo.positions(admin, { groupBy: ['bookId'] })
    expect(pos.rows.reduce((s, r) => s + r.tradeCount, 0)).toBe(all.filter((t) => t.status === 'LIVE').length)
    expect(repo.positionSnapshot(admin, { portfolioId: 'DESK-EQD-SG' }).schema).toBe('fina.position-snapshot/v1')
    const run = repo.reconRuns().items[0]
    expect(run.summary.breaks).toBeGreaterThan(2)
    const brk = repo.breaksQuery(admin, { filter: { types: ['MISSING_IN_EXTERNAL'] } }).items[0]
    expect(err(() => repo.breakUpdate(ops, { breakId: brk.breakId, status: 'RESOLVED' })).code).toBe('VALIDATION_FAILED')
    expect(repo.breakUpdate(ops, { breakId: brk.breakId, status: 'RESOLVED', comment: 'late report' }).status).toBe('RESOLVED')
  })

  it('bulk imports Phoenix rows from CSV with dotted columns; export; audit', () => {
    const csv = [
      'productType,side,notional,tradeDate,counterpartyId,bookId,externalId,terms.isin,terms.underlyings[0].symbol,terms.underlyings[0].initialFixing,terms.underlyings[1].symbol,terms.underlyings[1].initialFixing,terms.strikeDate,terms.frequency,terms.numObservations,terms.coupon.ratePerPeriod,terms.coupon.barrier,terms.knockIn.barrier',
      'PHOENIX_AUTOCALL,SELL,2000000,2026-03-02,CP-UOB,PHX-ASIA,IMP-1,XS2960012347,D05,38.2,HSI,21000,2026-03-04,QUARTERLY,8,0.025,0.7,0.6',
      'PHOENIX_AUTOCALL,SELL,2000000,2026-03-02,CP-UOB,PHX-ASIA,IMP-2,XS2960012347,D05,-1,HSI,21000,2026-03-04,QUARTERLY,8,0.025,0.7,0.6',
    ].join('\n')
    const rows = parseCsv(csv)
    expect(repo.bulkImport(admin, { rows, dryRun: true })).toMatchObject({ committed: 0, failed: 1 })
    const be = repo.bulkImport(admin, { rows, mode: 'best-effort' })
    expect(be.committed).toBe(1)
    const t = repo.get(admin, { tradeId: 'IMP-1' }).trade
    expect(t.terms.underlyings[1]).toMatchObject({ symbol: 'HSI', initialFixing: 21000 })
    expect(t.terms.observations).toHaveLength(8)
    expect(repo.exportTrades(admin, { format: 'csv' }).content).toContain('XS2960012347')
    expect(repo.auditQuery(admin, { filter: { action: 'trade.import' } }).total).toBe(1)
  })
})

describe('storage adapters', () => {
  it('replays the same state (templates included) from SQLite after restart', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'trrepo-')), 'db.sqlite')
    const s1 = createSqliteStore(file)
    await s1.init()
    const r1 = mk(s1)
    r1.registerProduct(admin, { template: ELN })
    s1.transaction(() => seedRepository(r1))
    const before = r1.query(admin, { limit: 500 })
    await s1.close()
    const s2 = createStoreFromUrl(`sqlite:${file}`)
    await s2.init()
    const r2 = createRepository({ reference: REFERENCE, store: s2, now, templates: [] }) // registry comes back from the DB
    expect(r2.query(admin, { limit: 500 })).toEqual(before)
    expect(r2.products().items.map((p) => p.id)).toEqual(['ELN_STUB', 'PHOENIX_AUTOCALL'])
    const next = r2.book(admin, { trade: phx() })
    expect(Number(next.tradeId.slice(3))).toBeGreaterThan(before.total)
    await s2.close()
  })

  it('maps records to portable rows and rejects unknown URLs', () => {
    expect(toRow({ kind: 'audit', auditId: 'A', occurredAt: 't', actor: 'x', action: 'y', target: { id: 'T' } }, 1)[0]).toBe('tr_audit_event')
    expect(toRow({ kind: 'product-template', key: 'X@1', id: 'X', version: 1, registeredAt: 't', template: {} }, 2)[0]).toBe('tr_product_template')
    expect(() => createStoreFromUrl('mysql://x')).toThrow(/unsupported/)
    expect(createStoreFromUrl('postgres://u:secret@h/db').location).not.toContain('secret')
  })
})

// PostgreSQL adapter round-trip; runs only when a database is provided, e.g.
//   TRADE_REPO_TEST_PG_URL=postgres://trade_repo:...@127.0.0.1:55432/postgres npm run test:run
const PG_URL = process.env.TRADE_REPO_TEST_PG_URL
describe.skipIf(!PG_URL)('postgres adapter', () => {
  it('migrates, persists and replays identical state', async () => {
    const s1 = createStoreFromUrl(PG_URL, { reset: true })
    await s1.init()
    const r1 = mk(s1)
    seedRepository(r1)
    await s1.flush()
    const before = r1.query(admin, { limit: 500 })
    await s1.close()
    const s2 = createStoreFromUrl(PG_URL)
    await s2.init()
    const r2 = createRepository({ reference: REFERENCE, store: s2, now, templates: [] })
    expect(r2.query(admin, { limit: 500 })).toEqual(before)
    expect(r2.auditQuery(admin).total).toBe(r1.auditQuery(admin).total)
    await expect((async () => { r2.book(admin, { trade: phx(), idempotencyKey: 'pg-1' }); await s2.flush() })()).resolves.toBeUndefined()
    await s2.close()
  }, 60_000)
})
