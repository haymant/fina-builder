// Phoenix autocallable — the template's pluggable functions (docs/52 §R.6 escape hatch).
// Everything expressible as data lives in products/phoenix-autocall.v1.json; only the
// fixing determination (coupon / memory catch-up / KI / autocall / redemption, emitted as
// separate derived events) and corporate-action adjustment factors are code.

const round = (x, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp

/** ISIN check digit (ISO 6166, Luhn over the letter-expanded digits). */
export function isinValid(isin) {
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin ?? '')) return false
  const digits = isin.slice(0, 11).split('').map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55))).join('')
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return (10 - (sum % 10)) % 10 === Number(isin[11])
}
export function isinWithCheck(body11) {
  for (let c = 0; c <= 9; c++) if (isinValid(`${body11}${c}`)) return `${body11}${c}`
  return null
}

/** Worst-of performance of a set of levels vs the (corporate-action adjusted) initial fixings. */
export function worstOf(terms, levels) {
  let worst = Infinity, worstSymbol = null
  const performances = {}
  for (const u of terms.underlyings) {
    const lv = Number(levels?.[u.symbol])
    if (!(lv > 0)) return { error: { code: 'REQUIRED', path: `params.levels.${u.symbol}`, message: `fixing level for ${u.symbol} is required` } }
    const perf = round(lv / u.initialFixing, 6)
    performances[u.symbol] = perf
    if (perf < worst) { worst = perf; worstSymbol = u.symbol }
  }
  return { worst, worstSymbol, performances }
}

export function caFactor({ type, ratio, dividend, cumPrice }) {
  switch (type) {
    case 'SPLIT': return 1 / ratio
    case 'REVERSE_SPLIT': return ratio
    case 'SPECIAL_DIVIDEND': return (cumPrice - dividend) / cumPrice
    case 'RIGHTS_ISSUE': return ratio
    default: return NaN
  }
}

const clone = (x) => JSON.parse(JSON.stringify(x))

/**
 * Plugins return ordered steps: [{ eventType, validFrom, apply(state) -> state, detail }].
 * The runner records each step as its own immutable, versioned event.
 */
export const phoenixPlugins = {
  'phoenix.isin': (trade) => (trade.terms?.isin && !isinValid(trade.terms.isin) ? [{ code: 'FORMAT', path: 'terms.isin', message: 'ISIN check digit is invalid (ISO 6166)' }] : []),

  'phoenix.fixing': (trade, params) => {
    const t = trade.terms, ps = trade.productState
    const obs = t.observations[params.n - 1]
    const w = worstOf(t, params.levels)
    if (w.error) return { errors: [w.error] }
    const final = params.n === t.observations.length
    const memory = t.coupon.memory !== false
    const steps = []
    const fixing = { n: params.n, date: obs.observationDate, levels: params.levels, performances: w.performances, worst: w.worst, worstSymbol: w.worstSymbol, source: params.source ?? null }
    steps.push({ eventType: 'FIXING', validFrom: obs.observationDate, detail: fixing, apply: (s) => { s.productState.fixings.push(fixing); return s } })
    let knocked = ps.knockedIn
    const kiObserved = (t.knockIn.observation === 'EUROPEAN' && final) || t.knockIn.observation === 'AMERICAN'
    if (!knocked && kiObserved && w.worst < t.knockIn.barrier) {
      knocked = true
      const d = { date: obs.observationDate, worst: w.worst, barrier: t.knockIn.barrier, observation: t.knockIn.observation }
      steps.push({ eventType: 'KNOCK_IN', validFrom: obs.observationDate, detail: d, apply: (s) => { Object.assign(s.productState, { knockedIn: true, kiDate: d.date, kiWorst: d.worst }); return s } })
    }
    const paid = w.worst >= obs.couponBarrier
    const periods = paid ? 1 + (memory ? ps.unpaidPeriods : 0) : 0
    const coupon = { n: params.n, paid, periods, memoryCatchUp: paid && memory ? ps.unpaidPeriods : 0, amount: round(trade.notional * obs.couponRate * periods), paymentDate: obs.paymentDate, worst: w.worst, barrier: obs.couponBarrier }
    steps.push({ eventType: 'COUPON', validFrom: obs.observationDate, detail: coupon, apply: (s) => {
      s.productState.coupons.push(coupon)
      s.productState.couponsPaidTotal = round(s.productState.couponsPaidTotal + coupon.amount)
      s.productState.unpaidPeriods = paid ? 0 : s.productState.unpaidPeriods + (memory ? 1 : 0)
      return s
    } })
    if (!final && obs.autocallLevel != null && w.worst >= obs.autocallLevel) {
      const d = { n: params.n, date: obs.observationDate, level: obs.autocallLevel, worst: w.worst, amount: round(trade.notional), paymentDate: obs.paymentDate }
      steps.push({ eventType: 'AUTOCALL', validFrom: obs.observationDate, detail: d, apply: (s) => { s.productState.autocall = d; s.productState.redemption = { amount: d.amount, pct: 1, paymentDate: d.paymentDate, reason: 'AUTOCALL' }; s.status = 'AUTOCALLED'; return s } })
    } else if (final) {
      const loss = knocked && w.worst < t.putStrike
      const pct = loss ? round(w.worst / t.putStrike, 6) : 1
      const d = { pct, amount: round(trade.notional * pct), paymentDate: obs.paymentDate, capitalLoss: loss, worst: w.worst, settlement: t.settlement ?? 'CASH', reason: 'MATURITY' }
      steps.push({ eventType: 'REDEMPTION', validFrom: obs.observationDate, detail: d, apply: (s) => { s.productState.redemption = d; s.status = 'MATURED'; return s } })
    }
    return { steps }
  },

  'phoenix.monitor': (trade, params) => {
    const t = trade.terms
    const w = worstOf(t, params.levels)
    if (w.error) return { errors: [w.error] }
    const rec = { date: params.date, worst: w.worst, worstSymbol: w.worstSymbol }
    const steps = [{ eventType: 'KI_MONITOR', validFrom: params.date, detail: rec, apply: (s) => { s.productState.monitor.push(rec); return s } }]
    if (w.worst < t.knockIn.barrier) steps.push({ eventType: 'KNOCK_IN', validFrom: params.date, detail: { ...rec, barrier: t.knockIn.barrier, observation: 'AMERICAN' }, apply: (s) => { Object.assign(s.productState, { knockedIn: true, kiDate: params.date, kiWorst: w.worst }); return s } })
    return { steps }
  },

  'phoenix.corporateAction': (trade, params) => {
    const f = caFactor(params)
    if (!(f > 0)) return { errors: [{ code: 'RANGE', path: 'params', message: 'invalid corporate-action factor' }] }
    const before = trade.terms.underlyings.find((u) => u.symbol === params.symbol).initialFixing
    const after = round(before * f, 6)
    const rec = { ...params, factor: round(f, 8), initialFixingBefore: before, initialFixingAfter: after }
    return { steps: [{ eventType: 'CORPORATE_ACTION', validFrom: params.exDate, detail: rec, apply: (s) => {
      s.terms = clone(s.terms)
      s.terms.underlyings = s.terms.underlyings.map((u) => (u.symbol === params.symbol ? { ...u, initialFixing: after } : u))
      s.productState.corporateActions.push(rec)
      return s
    } }] }
  },
}
