// Deterministic, realistic demo trades with lifecycle history.
import { REFERENCE } from './reference.mjs'

function rng(seed) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
}
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10)
const pick = (r, a) => a[Math.floor(r() * a.length)]

export function seedRepository(repo, { count = 60 } = {}) {
  const r = rng(51)
  const cps = REFERENCE.parties.filter((p) => p.kind === 'COUNTERPARTY').map((p) => p.partyId)
  const traders = { 'DESK-RATES': ['alice.rates', 'ben.rates'], 'DESK-FX': ['chen.fx', 'dana.fx'], 'DESK-EQD': ['eddie.eqd', 'fiona.eqd'], 'DESK-CREDIT': ['gus.credit'] }
  const base = '2026-01-05'
  const ids = []
  for (let i = 0; i < count; i++) {
    const tradeDate = addDays(base, Math.floor(i * 4.3))
    const kind = pick(r, ['IRS', 'IRS', 'FX_FORWARD', 'FX_FORWARD', 'EQUITY_OPTION', 'EQUITY_OPTION', 'CDS', 'PHOENIX_AUTOCALL'])
    let t
    if (kind === 'IRS') {
      const ccy = pick(r, ['GBP', 'USD'])
      t = { productType: 'IRS', bookId: `RATES-${ccy}`, currency: ccy, underlying: ccy === 'GBP' ? 'SONIA' : 'SOFR', notional: Math.round(5 + r() * 95) * 1e6, fixedRate: Math.round((0.03 + r() * 0.015) * 1e5) / 1e5, maturityDate: addDays(tradeDate, 365 * pick(r, [2, 5, 10])) }
    } else if (kind === 'FX_FORWARD') {
      const pair = pick(r, [['USD/SGD', 1.34], ['USD/JPY', 151.2], ['EUR/USD', 1.085], ['AUD/USD', 0.66]])
      t = { productType: 'FX_FORWARD', bookId: 'FX-ASIA', currency: pair[0].slice(0, 3), underlying: pair[0], notional: Math.round(1 + r() * 49) * 1e6, price: Math.round(pair[1] * (1 + (r() - 0.5) * 0.02) * 1e4) / 1e4, maturityDate: addDays(tradeDate, pick(r, [30, 90, 180, 365])) }
    } else if (kind === 'EQUITY_OPTION') {
      const und = pick(r, [['AAPL', 225], ['MSFT', 430], ['NVDA', 135], ['SPX', 5800]])
      t = { productType: 'EQUITY_OPTION', bookId: 'EQD-FLOW', currency: 'USD', underlying: und[0], optionType: pick(r, ['CALL', 'PUT']), strike: Math.round(und[1] * (0.85 + r() * 0.3)), notional: Math.round(1 + r() * 19) * 1e6, quantity: Math.round(1000 + r() * 9000), maturityDate: addDays(tradeDate, pick(r, [90, 180, 365])) }
    } else if (kind === 'CDS') {
      t = { productType: 'CDS', bookId: 'CREDIT-IG', currency: 'EUR', underlying: pick(r, ['ITRAXX-MAIN-S44', 'VW AG', 'TOTALENERGIES', 'SIEMENS AG']), notional: Math.round(5 + r() * 45) * 1e6, price: pick(r, [0.01, 0.05]), maturityDate: addDays(tradeDate, 365 * 5) }
    } else {
      t = { productType: 'PHOENIX_AUTOCALL', bookId: 'EQD-EXOTICS', currency: 'USD', underlying: pick(r, ['AAPL|MSFT', 'NVDA|AMD', 'SPX|SX5E']), notional: Math.round(2 + r() * 18) * 1e6, strike: 1, maturityDate: addDays(tradeDate, 365 * 3) }
    }
    const book = REFERENCE.books.find((b) => b.bookId === t.bookId)
    t = { ...t, side: r() < 0.55 ? 'BUY' : 'SELL', tradeDate, effectiveDate: addDays(tradeDate, kind === 'FX_FORWARD' ? 0 : 2), counterpartyId: pick(r, cps), trader: pick(r, traders[book.deskId]), venue: pick(r, ['OTC', 'OTC', 'BBG-MTF', 'TRADEWEB']), externalId: `EXT-${10000 + i}`, tags: { strategy: pick(r, ['hedge', 'client', 'prop']) } }
    const recordedAt = `${tradeDate}T0${1 + Math.floor(r() * 8)}:${String(Math.floor(r() * 60)).padStart(2, '0')}:00.000Z`
    const out = repo.book({ actor: t.trader, role: 'admin', recordedAt }, { trade: t, idempotencyKey: `seed:${i}` })
    ids.push({ id: out.tradeId, t, recordedAt })
  }
  // lifecycle history on a subset (deterministic)
  const ctx = (d, h = 14) => ({ actor: 'olga.ops', role: 'admin', recordedAt: `${d}T${h}:00:00.000Z` })
  const safe = (fn) => { try { fn() } catch { /* overlapping demo events are skipped */ } }
  ids.forEach(({ id, t }, i) => {
    const d1 = addDays(t.tradeDate, 3)
    if (d1 > '2026-10-20') return
    if (i % 7 === 1) safe(() => repo.amend(ctx(d1), { tradeId: id, changes: { notional: t.notional + 1e6 }, reason: 'Allocation correction from broker confirm' }))
    if (i % 9 === 2) safe(() => repo.amend(ctx(d1, 15), { tradeId: id, changes: { trader: 'desk.head', comment: 'reassigned' }, reason: 'Trader reassignment' }))
    if (i % 11 === 3) safe(() => repo.lifecycle(ctx(addDays(t.tradeDate, 1)), { tradeId: id, eventType: 'CANCEL', effectiveDate: t.tradeDate, reason: 'Booked in error (duplicate of voice trade)' }))
    else if (i % 13 === 4) safe(() => repo.lifecycle(ctx(addDays(t.tradeDate, 30)), { tradeId: id, eventType: 'PARTIAL_TERMINATE', effectiveDate: addDays(t.tradeDate, 30), params: { terminatedNotional: Math.round(t.notional / 2e6) * 1e6 }, reason: 'Client unwind 50%' }))
    else if (i % 17 === 5) safe(() => repo.lifecycle(ctx(addDays(t.tradeDate, 20)), { tradeId: id, eventType: 'NOVATE', effectiveDate: addDays(t.tradeDate, 20), params: { transfereeId: t.counterpartyId === 'CP-UBS' ? 'CP-HSBC' : 'CP-UBS' }, reason: 'Novation to new dealer' }))
    else if (t.maturityDate <= '2026-10-20') safe(() => repo.lifecycle(ctx(t.maturityDate, 18), { tradeId: id, eventType: 'MATURE', effectiveDate: t.maturityDate, reason: 'Matured' }))
  })
  // A reconciliation run against a (simulated) external trade repository report with breaks.
  const live = repo.query({ role: 'admin', actor: 'system' }, { filter: { statuses: ['LIVE'] }, limit: 500 }).items
  const records = live.slice(0, Math.max(0, live.length - 2)).map((t, i) => ({
    uti: t.uti, notional: i % 10 === 3 ? t.notional * 1.1 : t.notional, maturityDate: i % 15 === 7 ? addDays(t.maturityDate, 1) : t.maturityDate, currency: t.currency, counterpartyId: t.counterpartyId, side: t.side,
  }))
  records.push({ uti: 'W22LROWP2IHZNBB6K528GS00000098765', notional: 25e6, maturityDate: '2031-03-20', currency: 'USD', counterpartyId: 'CP-GSI', side: 'SELL' })
  repo.reconRun({ actor: 'olga.ops', role: 'ops', recordedAt: '2026-10-20T07:00:00.000Z' }, { source: 'DTCC GTR (EMIR)', records, asOfDate: '2026-10-20' })
  return ids.length
}
