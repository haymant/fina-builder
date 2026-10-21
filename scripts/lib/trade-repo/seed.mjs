// Deterministic, realistic Phoenix demo book. Synthetic (seeded GBM) closing levels drive
// each note's real lifecycle through the repository API — fixings, coupons (with memory),
// knock-ins (European + American), autocalls, maturities, a 10:1 split, buybacks, amends,
// a novation and a book transfer — so every state is produced by the same engine a user drives.
import { addBusinessDays, isBusinessDay } from './calendar.mjs'
import { isinWithCheck } from './phoenix.mjs'

export const AS_OF = '2026-10-20'
const START = '2022-12-30'

function rng(seed) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
}
const normal = (r) => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r())
const addDays = (d, n) => new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10)

// symbol -> [name, level on 2022-12-30, annual drift, annual vol, currency, region]
export const UNIVERSE = {
  AAPL: ['Apple Inc', 129.9, 0.22, 0.27, 'USD', 'US'], MSFT: ['Microsoft Corp', 239.8, 0.2, 0.26, 'USD', 'US'],
  NVDA: ['NVIDIA Corp', 146.1, 0.55, 0.5, 'USD', 'US'], AMZN: ['Amazon.com Inc', 84.0, 0.18, 0.33, 'USD', 'US'],
  TSLA: ['Tesla Inc', 123.2, 0.05, 0.58, 'USD', 'US'], META: ['Meta Platforms', 120.3, 0.3, 0.38, 'USD', 'US'],
  SPX: ['S&P 500 Index', 3839.5, 0.1, 0.16, 'USD', 'US'],
  SX5E: ['EURO STOXX 50', 3793.6, 0.07, 0.17, 'EUR', 'EU'], ASML: ['ASML Holding', 505.0, 0.05, 0.38, 'EUR', 'EU'],
  'MC.PA': ['LVMH', 680.0, -0.06, 0.3, 'EUR', 'EU'], SAP: ['SAP SE', 96.4, 0.25, 0.25, 'EUR', 'EU'],
  HSI: ['Hang Seng Index', 19781.4, -0.02, 0.24, 'USD', 'ASIA'], '0700.HK': ['Tencent Holdings', 334.8, 0.04, 0.34, 'USD', 'ASIA'],
  BABA: ['Alibaba Group ADR', 88.1, -0.12, 0.42, 'USD', 'ASIA'], D05: ['DBS Group', 33.9, 0.1, 0.2, 'USD', 'ASIA'],
}
/** NVIDIA's 10-for-1 split (ex-date 2024-06-10): raw closes are post-split after this date. */
export const SPLITS = [{ symbol: 'NVDA', exDate: '2024-06-10', ratio: 10 }]

const paths = new Map()
function path(symbol) {
  if (paths.has(symbol)) return paths.get(symbol)
  const [, s0, mu, vol] = UNIVERSE[symbol]
  const r = rng([...symbol].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261))
  const out = new Map()
  let s = s0, d = START
  const dt = 1 / 252
  while (d <= '2029-12-31') {
    if (isBusinessDay(d, 'NYSE')) {
      out.set(d, s)
      s *= Math.exp((mu - 0.5 * vol * vol) * dt + vol * Math.sqrt(dt) * normal(r))
    }
    d = addDays(d, 1)
  }
  paths.set(symbol, out)
  return out
}
/** Closing level on or before `date`, in post-corporate-action units on that date. */
export function close(symbol, date) {
  const p = path(symbol)
  let d = date
  for (let i = 0; i < 10 && !p.has(d); i++) d = addDays(d, -1)
  let v = p.get(d) ?? UNIVERSE[symbol][1]
  for (const sp of SPLITS) if (sp.symbol === symbol && d >= sp.exDate) v /= sp.ratio
  return Math.round(v * 100) / 100
}

const BASKETS = {
  US: [['AAPL', 'MSFT'], ['NVDA', 'AMZN'], ['TSLA', 'META'], ['NVDA', 'TSLA'], ['SPX', 'AAPL'], ['AMZN', 'META']],
  EU: [['SX5E', 'ASML'], ['MC.PA', 'SAP'], ['ASML', 'SAP'], ['SX5E', 'MC.PA']],
  ASIA: [['HSI', '0700.HK'], ['BABA', '0700.HK'], ['D05', 'HSI'], ['NVDA', '0700.HK']],
}
const DISTRIBUTORS = { US: ['CP-GSI', 'CP-JPM', 'CP-UBS'], EU: ['CP-BNP', 'CP-JB', 'CP-HSBC'], ASIA: ['CP-DBS', 'CP-UOB', 'CP-HSBC', 'CP-JB'] }
const TRADERS = { 'PHX-EUR': 'eddie.ldn', 'PHX-USD': 'eddie.ldn', 'PHX-ASIA': 'alice.sg', 'PHX-HEDGE': 'alice.sg' }

/** Builds one realistic Phoenix term set (exported for tests and the UI defaults). */
export function demoPhoenix(i, r, tradeDate, region) {
  const pick = (a) => a[Math.floor(r() * a.length)]
  const basket = pick(BASKETS[region])
  const strikeDate = addBusinessDays(tradeDate, 2, 'NYSE')
  const monthly = r() < 0.3
  const american = r() < 0.25
  const stepDown = pick([0, 0, 0.025, 0.05])
  return {
    isin: isinWithCheck(`${region === 'EU' ? 'XS' : region === 'ASIA' ? 'XS' : 'CH'}${String(2410000 + i * 137).padStart(9, '0')}`),
    issuerId: region === 'ASIA' ? 'LE-FINA-SG' : 'LE-FINA-UK',
    underlyings: basket.map((s) => ({ symbol: s, name: UNIVERSE[s][0], initialFixing: close(s, strikeDate) })),
    denomination: 1000, issuePrice: 1, upfrontFeePct: pick([0.01, 0.015, 0.02]),
    strikeDate, frequency: monthly ? 'MONTHLY' : 'QUARTERLY', numObservations: monthly ? pick([12, 18, 24]) : pick([8, 8, 12]),
    calendar: region === 'EU' ? 'TARGET' : region === 'ASIA' ? 'SGX' : 'NYSE', bdc: 'MODIFIED_FOLLOWING', paymentLagDays: 5,
    coupon: { ratePerPeriod: Math.round((monthly ? 0.006 + r() * 0.006 : 0.018 + r() * 0.017) * 1e4) / 1e4, barrier: pick([0.6, 0.65, 0.7, 0.75]), memory: r() < 0.8 },
    autocall: { initialLevel: 1, startObservation: monthly ? 3 : 2, stepDown, floor: stepDown ? 0.8 : 0 },
    knockIn: { barrier: american ? pick([0.5, 0.55]) : pick([0.55, 0.6, 0.65]), observation: american ? 'AMERICAN' : 'EUROPEAN' },
    putStrike: 1, settlement: 'CASH',
  }
}

export function seedRepository(repo, { count = 32 } = {}) {
  const r = rng(52)
  const pick = (a) => a[Math.floor(r() * a.length)]
  const ids = []
  for (let i = 0; i < count; i++) {
    const tradeDate = addBusinessDays(addDays('2023-02-01', Math.floor(i * 41.5 + r() * 10)), 0, 'NYSE')
    if (tradeDate > '2026-10-01') break
    const region = pick(['US', 'US', 'EU', 'ASIA', 'ASIA'])
    const terms = demoPhoenix(i, r, tradeDate, region)
    const bookId = region === 'EU' ? 'PHX-EUR' : region === 'ASIA' ? 'PHX-ASIA' : 'PHX-USD'
    const t = {
      productType: 'PHOENIX_AUTOCALL', side: r() < 0.85 ? 'SELL' : 'BUY', notional: Math.round(1 + r() * 19) * 5e5,
      currency: region === 'EU' ? 'EUR' : 'USD', tradeDate, counterpartyId: pick(DISTRIBUTORS[region]), bookId,
      trader: TRADERS[bookId], venue: 'PRIMARY', externalId: `PHX-${String(1001 + i)}`, tags: { distributorRef: `D${7000 + i * 13}` }, terms,
    }
    const recordedAt = `${tradeDate}T0${1 + Math.floor(r() * 8)}:${String(Math.floor(r() * 60)).padStart(2, '0')}:00.000Z`
    const out = repo.book({ actor: t.trader, role: 'admin', recordedAt }, { trade: t, idempotencyKey: `seed:${i}` })
    ids.push({ id: out.tradeId, trade: out.trade, i })
  }
  const ops = (d, h = 21) => ({ actor: 'olga.ops', role: 'ops', recordedAt: `${d}T${h}:00:00.000Z` })
  const safe = (fn) => { try { return fn() } catch { return null } }

  // Operations on a few notes before the lifecycle runs (deterministic choices by index).
  for (const { id, trade, i } of ids) {
    if (i === 3) safe(() => repo.lifecycle(ops(addDays(trade.tradeDate, 1), 9), { tradeId: id, eventType: 'CANCEL', reason: 'Booked in error — duplicate of PHX ticket from voice' }))
    if (i === 5) safe(() => repo.amend(ops(trade.tradeDate, 12), { tradeId: id, changes: { terms: { coupon: { ratePerPeriod: Math.round((trade.terms.coupon.ratePerPeriod + 0.001) * 1e4) / 1e4 } } }, reason: 'Coupon corrected to final term sheet before strike' }))
    if (i === 8) safe(() => repo.amend(ops(addDays(trade.tradeDate, 2), 10), { tradeId: id, changes: { trader: 'desk.head', comment: 'cover while on leave' }, reason: 'Trader reassignment' }))
  }

  // Lifecycle: walk each note's schedule up to AS_OF in time order.
  for (const { id } of ids) {
    let s = repo.get({ role: 'admin' }, { tradeId: id }).trade
    if (s.status !== 'LIVE') continue
    const syms = s.terms.underlyings.map((u) => u.symbol)
    let lastDate = s.terms.strikeDate
    for (const obs of s.terms.observations) {
      if (obs.observationDate > AS_OF) break
      s = repo.get({ role: 'admin' }, { tradeId: id }).trade
      if (s.status !== 'LIVE') break
      for (const sp of SPLITS) if (syms.includes(sp.symbol) && sp.exDate > lastDate && sp.exDate <= obs.observationDate && sp.exDate > s.terms.strikeDate)
        safe(() => repo.lifecycle(ops(sp.exDate, 8), { tradeId: id, eventType: 'CORPORATE_ACTION', params: { symbol: sp.symbol, type: 'SPLIT', exDate: sp.exDate, ratio: sp.ratio }, reason: `${sp.symbol} ${sp.ratio}-for-1 split: initial fixing adjusted` }))
      if (s.terms.knockIn.observation === 'AMERICAN' && !s.productState.knockedIn) {
        for (let d = addDays(lastDate, 1); d < obs.observationDate; d = addDays(d, 1)) {
          if (!isBusinessDay(d, 'NYSE')) continue
          const cur = repo.get({ role: 'admin' }, { tradeId: id }).trade
          const worst = Math.min(...cur.terms.underlyings.map((u) => close(u.symbol, d) / u.initialFixing))
          if (worst < cur.terms.knockIn.barrier) {
            safe(() => repo.lifecycle(ops(d, 22), { tradeId: id, eventType: 'KI_MONITOR', params: { date: d, levels: Object.fromEntries(cur.terms.underlyings.map((u) => [u.symbol, close(u.symbol, d)])) }, reason: 'American barrier breach detected by daily monitoring' }))
            break
          }
        }
      }
      safe(() => repo.lifecycle(ops(obs.observationDate), { tradeId: id, eventType: 'FIXING', params: { n: obs.n, levels: Object.fromEntries(syms.map((sym) => [sym, close(sym, obs.observationDate)])), source: 'Bloomberg official close' }, reason: `Observation ${obs.n} fixing`, idempotencyKey: `seed:fix:${id}:${obs.n}` }))
      lastDate = obs.observationDate
    }
  }

  // Post-trade operations on live notes: buybacks, a full unwind, transfer, novation.
  const live = ids.map(({ id }) => repo.get({ role: 'admin' }, { tradeId: id }).trade).filter((t) => t.status === 'LIVE')
  const opAt = (t, days) => { let d = addDays(t.tradeDate, days); if (d <= t.validFrom) d = addDays(t.validFrom, 1); return d > AS_OF ? AS_OF : d }
  if (live[0]) safe(() => repo.lifecycle(ops(opAt(live[0], 200)), { tradeId: live[0].tradeId, eventType: 'UNWIND', params: { notional: Math.floor(live[0].notional / 2 / 1000) * 1000, pricePct: 0.968, date: opAt(live[0], 200) }, reason: 'Client secondary-market buyback (50%)' }))
  if (live[1]) safe(() => repo.lifecycle(ops(opAt(live[1], 150)), { tradeId: live[1].tradeId, eventType: 'UNWIND', params: { notional: live[1].notional, pricePct: 0.9425, date: opAt(live[1], 150) }, reason: 'Full buyback at bid' }))
  if (live[2]) safe(() => repo.lifecycle(ops(opAt(live[2], 40)), { tradeId: live[2].tradeId, eventType: 'BOOK_TRANSFER', effectiveDate: opAt(live[2], 40), params: { toBookId: 'PHX-HEDGE' }, reason: 'Moved to buyback inventory book' }))
  if (live[3]) safe(() => repo.lifecycle(ops(opAt(live[3], 60)), { tradeId: live[3].tradeId, eventType: 'NOVATE', effectiveDate: opAt(live[3], 60), params: { transfereeId: live[3].counterpartyId === 'CP-UBS' ? 'CP-JB' : 'CP-UBS' }, reason: 'Distributor novation' }))

  // Reconciliation against a (simulated) distributor / TR report with breaks.
  const items = repo.query({ role: 'admin', actor: 'system' }, { filter: { statuses: ['LIVE'] }, limit: 500 }).items
  const records = items.slice(0, Math.max(0, items.length - 1)).map((t, k) => ({
    uti: t.uti, notional: k % 5 === 2 ? t.notional * 1.1 : t.notional, maturityDate: k % 7 === 4 ? addDays(t.maturityDate, 1) : t.maturityDate, currency: t.currency, counterpartyId: t.counterpartyId, side: t.side,
  }))
  records.push({ uti: 'W22LROWP2IHZNBB6K528GS00000098765', notional: 2.5e6, maturityDate: '2028-03-20', currency: 'USD', counterpartyId: 'CP-GSI', side: 'SELL' })
  repo.reconRun({ actor: 'olga.ops', role: 'ops', recordedAt: `${AS_OF}T07:00:00.000Z` }, { source: 'Distributor position report (DBS/UOB/GS)', records, asOfDate: AS_OF })
  return ids.length
}
