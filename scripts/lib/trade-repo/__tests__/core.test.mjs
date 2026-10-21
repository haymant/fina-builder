import { describe, expect, it, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepository, diffTrades, parseCsv, validateTrade, TradeRepoError } from '../core.mjs'
import { REFERENCE } from '../reference.mjs'
import { seedRepository } from '../seed.mjs'
import { createMemoryStore, createSqliteStore, createStoreFromUrl, toRow } from '../store.mjs'

const admin = { actor: 'trash.box', role: 'admin' }
const irs = { productType: 'IRS', side: 'BUY', notional: 10e6, currency: 'GBP', fixedRate: 0.04, tradeDate: '2026-03-02', maturityDate: '2031-03-04', counterpartyId: 'CP-GSI', bookId: 'RATES-GBP', underlying: 'SONIA' }
let clock = 0
const now = () => new Date(Date.UTC(2026, 9, 1) + (clock++) * 1000).toISOString()
const err = (fn) => { try { fn() } catch (e) { return e } throw new Error('expected throw') }

describe('trade repository core', () => {
  let repo
  beforeEach(() => { clock = 0; repo = createRepository({ reference: REFERENCE, store: createMemoryStore(), now }) })

  it('validates required fields, enums, dates and product rules', () => {
    const v = validateTrade({ ...irs, notional: -1, currency: 'gbp', maturityDate: '2026-01-01', fixedRate: undefined }, REFERENCE)
    expect(v.valid).toBe(false)
    expect(v.errors.map((e) => e.path)).toEqual(expect.arrayContaining(['notional', 'currency', 'maturityDate', 'fixedRate']))
    expect(validateTrade({ ...irs, notional: 6e9 }, REFERENCE).warnings[0].code).toBe('FAT_FINGER')
    expect(validateTrade({ ...irs, counterpartyId: 'NOPE' }, REFERENCE).errors[0].code).toBe('UNKNOWN_REF')
  })

  it('books with tradeId, UTI, version 1 and is idempotent', () => {
    const a = repo.book(admin, { trade: irs, idempotencyKey: 'k1' })
    expect(a.tradeId).toBe('TR-000001')
    expect(a.trade.uti).toMatch(/^5493001KJTIIGC8Y1R12FINA/)
    expect(a.version).toBe(1)
    const b = repo.book(admin, { trade: irs, idempotencyKey: 'k1' })
    expect(b.replayed).toBe(true)
    expect(repo.query(admin).total).toBe(1)
  })

  it('rejects duplicate externalId and bad payloads with structured errors', () => {
    repo.book(admin, { trade: { ...irs, externalId: 'X1' } })
    expect(err(() => repo.book(admin, { trade: { ...irs, externalId: 'X1' } })).code).toBe('DUPLICATE')
    const e = err(() => repo.book(admin, { trade: { ...irs, side: 'LONG' } }))
    expect(e).toBeInstanceOf(TradeRepoError)
    expect(e.toJSON()).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ path: 'side' }] })
  })

  it('classifies economic vs non-economic amends and enforces optimistic concurrency', () => {
    const { tradeId } = repo.book(admin, { trade: irs })
    const ne = repo.amend(admin, { tradeId, expectedVersion: 1, changes: { trader: 'bob' }, reason: 'fix trader' })
    expect(ne.amendKind).toBe('NON_ECONOMIC')
    const ec = repo.amend(admin, { tradeId, expectedVersion: 2, changes: { notional: 12e6 }, reason: 'confirm' })
    expect(ec.amendKind).toBe('ECONOMIC')
    expect(ec.changes).toEqual([{ field: 'notional', before: 10e6, after: 12e6, economic: true }])
    expect(err(() => repo.amend(admin, { tradeId, expectedVersion: 1, changes: { notional: 1 }, reason: 'x' })).code).toBe('CONFLICT')
    expect(err(() => repo.amend(admin, { tradeId, changes: { notional: 1 } })).code).toBe('VALIDATION_FAILED')
    expect(err(() => repo.amend(admin, { tradeId, changes: { bookId: 'RATES-USD' }, reason: 'x' })).details[0].code).toBe('USE_LIFECYCLE')
    expect(repo.diff(admin, { tradeId, fromVersion: 1, toVersion: 3 }).changes.map((c) => c.field)).toEqual(['notional', 'trader'])
  })

  it('runs the lifecycle state machine', () => {
    const t1 = repo.book(admin, { trade: irs }).tradeId
    const p = repo.lifecycle(admin, { tradeId: t1, eventType: 'PARTIAL_TERMINATE', effectiveDate: '2026-06-01', params: { terminatedNotional: 4e6 } })
    expect(p.trade.notional).toBe(6e6)
    const n = repo.lifecycle(admin, { tradeId: t1, eventType: 'NOVATE', effectiveDate: '2026-07-01', params: { transfereeId: 'CP-JPM' } })
    expect(n.trade.status).toBe('NOVATED')
    expect(repo.get(admin, { tradeId: n.novatedTo }).trade).toMatchObject({ counterpartyId: 'CP-JPM', notional: 6e6, status: 'LIVE' })
    expect(err(() => repo.lifecycle(admin, { tradeId: t1, eventType: 'CANCEL', reason: 'x' })).code).toBe('INVALID_TRANSITION')
    const t2 = repo.book(admin, { trade: irs }).tradeId
    expect(err(() => repo.lifecycle(admin, { tradeId: t2, eventType: 'EXERCISE' })).code).toBe('INVALID_TRANSITION')
    expect(err(() => repo.lifecycle(admin, { tradeId: t2, eventType: 'MATURE', effectiveDate: '2027-01-01' })).code).toBe('VALIDATION_FAILED')
    expect(repo.lifecycle(admin, { tradeId: t2, eventType: 'BOOK_TRANSFER', effectiveDate: '2026-04-01', params: { toBookId: 'RATES-USD' } }).trade.bookId).toBe('RATES-USD')
    expect(repo.lifecycle(admin, { tradeId: t2, eventType: 'CANCEL', effectiveDate: '2026-04-02', reason: 'error' }).trade.status).toBe('CANCELLED')
  })

  it('answers bitemporal as-of queries', () => {
    const { tradeId } = repo.book({ ...admin, recordedAt: '2026-03-02T10:00:00.000Z' }, { trade: irs })
    repo.amend({ ...admin, recordedAt: '2026-03-10T10:00:00.000Z' }, { tradeId, changes: { notional: 20e6 }, reason: 'late correction', validFrom: '2026-03-02' })
    expect(repo.get(admin, { tradeId }).trade.notional).toBe(20e6)
    // What did we *know* on 5 March? The original 10m.
    expect(repo.get(admin, { tradeId, knownAt: '2026-03-05T00:00:00.000Z' }).trade.notional).toBe(10e6)
    expect(repo.get(admin, { tradeId, knownAt: '2026-03-05T00:00:00.000Z' }).isLatest).toBe(false)
    expect(err(() => repo.get(admin, { tradeId, knownAt: '2026-03-01T00:00:00.000Z' })).code).toBe('NOT_FOUND')
    repo.lifecycle({ ...admin, recordedAt: '2026-05-01T00:00:00.000Z' }, { tradeId, eventType: 'PARTIAL_TERMINATE', effectiveDate: '2026-05-01', params: { terminatedNotional: 5e6 } })
    expect(repo.get(admin, { tradeId, validAt: '2026-04-01' }).trade.notional).toBe(20e6)
    expect(repo.get(admin, { tradeId, validAt: '2026-06-01' }).trade.notional).toBe(15e6)
  })

  it('enforces entitlements by role and book', () => {
    expect(err(() => repo.book({ actor: 'victor.view', role: 'viewer' }, { trade: irs })).code).toBe('FORBIDDEN')
    expect(repo.book({ actor: 'alice.rates', role: 'trader' }, { trade: irs }).tradeId).toBeTruthy()
    expect(err(() => repo.book({ actor: 'alice.rates', role: 'trader' }, { trade: { ...irs, bookId: 'FX-ASIA', productType: 'FX_FORWARD', price: 1.3, underlying: 'USD/SGD' } })).code).toBe('FORBIDDEN')
    repo.book(admin, { trade: { ...irs, productType: 'FX_FORWARD', bookId: 'FX-ASIA', price: 1.3, underlying: 'USD/SGD' } })
    expect(repo.query({ actor: 'alice.rates', role: 'trader' }).total).toBe(1)
    expect(err(() => repo.breakUpdate({ actor: 'alice.rates', role: 'trader' }, { breakId: 'BRK-1' })).code).toBe('FORBIDDEN')
  })

  it('filters, sorts and paginates with cursors', () => {
    seedRepository(repo)
    const all = repo.query(admin, { limit: 500 })
    const p1 = repo.query(admin, { limit: 10, sort: [{ field: 'notional', dir: 'desc' }] })
    const p2 = repo.query(admin, { limit: 10, cursor: p1.nextCursor, sort: [{ field: 'notional', dir: 'desc' }] })
    expect(p1.items).toHaveLength(10)
    expect(p1.items[9].notional).toBeGreaterThanOrEqual(p2.items[0].notional)
    expect(p1.total).toBe(all.total)
    const irsOnly = repo.query(admin, { filter: { productTypes: ['IRS'], statuses: ['LIVE'] }, limit: 500 })
    expect(irsOnly.items.every((t) => t.productType === 'IRS' && t.status === 'LIVE')).toBe(true)
    expect(err(() => repo.query(admin, { limit: 501 })).code).toBe('VALIDATION_FAILED')
  })

  it('aggregates positions and emits a doc-51 position snapshot', () => {
    repo.book(admin, { trade: irs })
    repo.book(admin, { trade: { ...irs, side: 'SELL', notional: 4e6 } })
    const pos = repo.positions(admin, { groupBy: ['bookId', 'currency'] })
    expect(pos.rows[0]).toMatchObject({ key: { bookId: 'RATES-GBP', currency: 'GBP' }, netNotional: 6e6, grossNotional: 14e6, tradeCount: 2 })
    const snap = repo.positionSnapshot(admin, { portfolioId: 'DESK-RATES' })
    expect(snap.schema).toBe('fina.position-snapshot/v1')
    expect(snap.payload.positions.map((p) => p.quantity).sort()).toEqual([-4e6, 10e6])
  })

  it('reconciles by UTI and manages breaks', () => {
    const a = repo.book(admin, { trade: irs }).trade
    const b = repo.book(admin, { trade: { ...irs, notional: 3e6 } }).trade
    const run = repo.reconRun({ actor: 'olga.ops', role: 'ops' }, { source: 'TR', records: [{ uti: a.uti, notional: 11e6 }, { uti: 'GHOST' }] })
    expect(run.summary.byType).toEqual({ FIELD_MISMATCH: 1, MISSING_IN_REPO: 1, MISSING_IN_EXTERNAL: 1 })
    const brk = repo.breaksQuery(admin, { filter: { types: ['MISSING_IN_EXTERNAL'] } }).items[0]
    expect(brk.uti).toBe(b.uti)
    expect(err(() => repo.breakUpdate({ actor: 'olga.ops', role: 'ops' }, { breakId: brk.breakId, status: 'RESOLVED' })).code).toBe('VALIDATION_FAILED')
    const upd = repo.breakUpdate({ actor: 'olga.ops', role: 'ops' }, { breakId: brk.breakId, status: 'RESOLVED', comment: 'late report', assignee: 'olga.ops' })
    expect(upd).toMatchObject({ status: 'RESOLVED', assignee: 'olga.ops' })
    expect(repo.auditQuery(admin, { filter: { action: 'recon.break.update' } }).total).toBe(1)
  })

  it('bulk imports with dry-run, all-or-nothing and CSV export', () => {
    const csv = 'productType,side,notional,currency,fixedRate,tradeDate,maturityDate,counterpartyId,bookId,externalId\nIRS,buy,1000000,USD,0.04,2026-02-01,2028-02-01,CP-JPM,RATES-USD,E1\nIRS,SELL,-5,USD,0.04,2026-02-01,2028-02-01,CP-JPM,RATES-USD,E2'
    const rows = parseCsv(csv)
    const dry = repo.bulkImport(admin, { rows, dryRun: true })
    expect(dry).toMatchObject({ committed: 0, failed: 1 })
    expect(repo.bulkImport(admin, { rows }).committed).toBe(0)
    const be = repo.bulkImport(admin, { rows, mode: 'best-effort' })
    expect(be.committed).toBe(1)
    const exp = repo.exportTrades(admin, { format: 'csv' })
    expect(exp.content.split('\n')).toHaveLength(2)
    expect(exp.content).toContain('E1')
  })

  it('records an audit trail and immutable history', () => {
    const { tradeId } = repo.book(admin, { trade: irs })
    repo.amend(admin, { tradeId, changes: { notional: 11e6 }, reason: 'r' })
    const h = repo.history(admin, { tradeId })
    expect(h.events.map((e) => e.eventType)).toEqual(['NEW', 'AMEND'])
    expect(repo.auditQuery(admin, { filter: { targetId: tradeId } }).items.map((a) => a.action)).toEqual(['trade.amend', 'trade.book'])
    expect(diffTrades({ a: 1 }, { a: 2 })[0]).toMatchObject({ field: 'a', before: 1, after: 2 })
  })
})

describe('storage adapters', () => {
  it('replays the same state from SQLite after restart', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'trrepo-')), 'db.sqlite')
    const s1 = createSqliteStore(file)
    await s1.init()
    const r1 = createRepository({ reference: REFERENCE, store: s1 })
    s1.transaction(() => seedRepository(r1))
    const before = r1.query(admin, { limit: 500 })
    await s1.close()
    const s2 = createStoreFromUrl(`sqlite:${file}`)
    await s2.init()
    const r2 = createRepository({ reference: REFERENCE, store: s2 })
    expect(r2.query(admin, { limit: 500 })).toEqual(before)
    expect(r2.breaksQuery(admin).total).toBe(r1.breaksQuery(admin).total)
    const next = r2.book(admin, { trade: irs })
    expect(Number(next.tradeId.slice(3))).toBeGreaterThan(before.total)
    await s2.close()
  })

  it('maps records to portable rows and rejects unknown URLs', () => {
    expect(toRow({ kind: 'audit', auditId: 'A', occurredAt: 't', actor: 'x', action: 'y', target: { id: 'T' } }, 1)[0]).toBe('tr_audit_event')
    expect(() => createStoreFromUrl('mysql://x')).toThrow(/unsupported/)
    expect(createStoreFromUrl('postgres://u:secret@h/db').location).not.toContain('secret')
  })
})
