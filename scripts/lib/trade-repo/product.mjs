// Product definition registry + generic interpreters (docs/52 §R).
//
// A product is data: a versioned `fina.product-template/v1` document (products/*.json,
// persisted in tr_product_template) declaring its term schema, cross-field constraints,
// schedule generators, lifecycle state machine (statuses, events, params, guards,
// effects), pricer binding and UI hints. The functions here interpret any template;
// product-specific code is limited to named plugins (e.g. phoenix.mjs).

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { addBusinessDays, periodicSchedule, yearFrac } from './calendar.mjs'
import { evaluate, registerFunction } from './expr.mjs'
import { phoenixPlugins } from './phoenix.mjs'

export const TEMPLATE_SCHEMA = 'fina.product-template/v1'
export const FIELD_TYPES = ['string', 'number', 'integer', 'percent', 'boolean', 'date', 'enum', 'ref', 'array', 'map']

// Formatting/date helpers available to template expressions.
const fmtMoney = (x, ccy) => (x == null ? '—' : `${Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${ccy ?? ''}`.trim())
registerFunction('fmtMoney', fmtMoney)
registerFunction('pct', (x) => (x == null ? '—' : `${Math.round(x * 1e6) / 1e4}%`))
registerFunction('lower', (s) => String(s ?? '').toLowerCase().replace(/_/g, ' '))
registerFunction('join', (a, sep = ', ') => (a ?? []).join(sep))
registerFunction('last', (a) => (Array.isArray(a) && a.length ? a[a.length - 1] : null))
registerFunction('yearFrac', yearFrac)
registerFunction('addBusinessDays', (d, n, cal) => addBusinessDays(d, n, cal))

/** Built-in plugin table — the only product code. Templates reference these by name. */
export const PLUGINS = { ...phoenixPlugins }
export const GENERATORS = {
  periodic: (p) => periodicSchedule(p),
}

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
export function getPath(obj, path) {
  return String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj)
}
export function setPath(obj, path, value) {
  const keys = String(path).split('.')
  let o = obj
  for (const k of keys.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k] }
  o[keys.at(-1)] = value
  return obj
}
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)))

// ---------------------------------------------------------------------------
// template meta-validation + registry
// ---------------------------------------------------------------------------

export function checkTemplate(t) {
  const errs = []
  const e = (path, message) => errs.push({ code: 'TEMPLATE_INVALID', path, message })
  if (!t || typeof t !== 'object') return [{ code: 'TEMPLATE_INVALID', path: '', message: 'template must be an object' }]
  if (!/^[A-Z][A-Z0-9_]{1,40}$/.test(t.id ?? '')) e('id', 'id must be UPPER_SNAKE')
  if (!(Number.isInteger(t.version) && t.version >= 1)) e('version', 'version must be a positive integer')
  if (!t.name) e('name', 'name is required')
  const fields = (list, base) => (list ?? []).forEach((f, i) => {
    if (!f.path) e(`${base}[${i}].path`, 'path is required')
    if (!FIELD_TYPES.includes(f.type)) e(`${base}[${i}].type`, `type must be one of ${FIELD_TYPES.join(', ')}`)
    if (f.type === 'enum' && !Array.isArray(f.values)) e(`${base}[${i}].values`, 'enum needs values')
    if (f.type === 'array' && f.items) fields(f.items, `${base}[${i}].items`)
  })
  fields(t.terms?.fields, 'terms.fields')
  const tryExpr = (src, path) => { try { evaluate(src, {}) } catch (err) { if (/expr:/.test(err.message)) e(path, err.message) } }
  ;(t.terms?.constraints ?? []).forEach((c, i) => tryExpr(c.expr, `terms.constraints[${i}].expr`))
  ;(t.terms?.plugins ?? []).forEach((p, i) => { if (!PLUGINS[p]) e(`terms.plugins[${i}]`, `unknown plugin ${p}`) })
  ;(t.schedules ?? []).forEach((s, i) => { if (!GENERATORS[s.generator]) e(`schedules[${i}].generator`, `unknown generator ${s.generator}`) })
  const lc = t.lifecycle
  if (!lc?.statuses || !lc.initialStatus || !lc.statuses[lc.initialStatus]) e('lifecycle', 'lifecycle needs statuses and a valid initialStatus')
  for (const [name, ev] of Object.entries(lc?.events ?? {})) {
    if (ev.plugin && !PLUGINS[ev.plugin]) e(`lifecycle.events.${name}.plugin`, `unknown plugin ${ev.plugin}`)
    ;(ev.from ?? []).forEach((s) => { if (!lc.statuses[s]) e(`lifecycle.events.${name}.from`, `unknown status ${s}`) })
    if (ev.to && !lc.statuses[ev.to]) e(`lifecycle.events.${name}.to`, `unknown status ${ev.to}`)
    ;(ev.guards ?? []).forEach((g, i) => tryExpr(g.expr, `lifecycle.events.${name}.guards[${i}]`))
    ;(ev.effects ?? []).forEach((f, i) => { if (f.expr) tryExpr(f.expr, `lifecycle.events.${name}.effects[${i}]`) })
    fields(ev.params, `lifecycle.events.${name}.params`)
  }
  return errs
}

export function loadTemplateFiles(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(resolve(dir, f), 'utf8')))
}

export const PRODUCTS_DIR = process.env.TRADE_REPO_PRODUCTS_DIR || resolve(dirname(fileURLToPath(import.meta.url)), '../../../products')
export const shippedTemplates = () => loadTemplateFiles(PRODUCTS_DIR)

export function createRegistry(initial = []) {
  const byKey = new Map() // id@version -> template
  const reg = {
    register(t) {
      const errs = checkTemplate(t)
      if (errs.length) { const err = new Error(`invalid product template ${t?.id}@${t?.version}`); err.details = errs; throw err }
      const key = `${t.id}@${t.version}`
      byKey.set(key, Object.freeze(clone(t)))
      return key
    },
    has: (id, version) => (version ? byKey.has(`${id}@${version}`) : [...byKey.values()].some((t) => t.id === id)),
    get(id, version) {
      if (version) return byKey.get(`${id}@${version}`) ?? null
      return [...byKey.values()].filter((t) => t.id === id && t.status !== 'RETIRED').sort((a, b) => b.version - a.version)[0] ?? null
    },
    list: () => [...byKey.values()].sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version),
    ids: () => [...new Set([...byKey.values()].filter((t) => t.status !== 'RETIRED').map((t) => t.id))],
  }
  for (const t of initial) reg.register(t)
  return reg
}

// ---------------------------------------------------------------------------
// generic validator + defaults + coercion
// ---------------------------------------------------------------------------

function defaultsInto(fields, obj) {
  for (const f of fields ?? []) {
    const cur = getPath(obj, f.path)
    if (cur === undefined && f.default !== undefined) setPath(obj, f.path, clone(f.default))
    if (f.type === 'array' && Array.isArray(getPath(obj, f.path))) for (const it of getPath(obj, f.path)) if (it && typeof it === 'object') defaultsInto(f.items, it)
  }
  return obj
}

export function applyDefaults(tpl, trade) {
  const t = clone(trade)
  for (const [k, v] of Object.entries(tpl.kernel?.defaults ?? {})) if (t[k] === undefined) t[k] = v
  t.terms = defaultsInto(tpl.terms?.fields, t.terms ?? {})
  return t
}

const NUMERIC = new Set(['number', 'integer', 'percent'])
/** Coerce strings (CSV, form inputs) to the declared field types. */
export function coerceFields(fields, obj) {
  for (const f of fields ?? []) {
    const v = getPath(obj, f.path)
    if (v === '' ) { setPath(obj, f.path, undefined); continue }
    if (typeof v === 'string' && NUMERIC.has(f.type) && v.trim() !== '' && !Number.isNaN(Number(v))) setPath(obj, f.path, Number(v))
    if (typeof v === 'string' && f.type === 'boolean') setPath(obj, f.path, /^(true|1|yes|y)$/i.test(v))
    if (f.type === 'array' && Array.isArray(v)) v.forEach((it) => it && coerceFields(f.items, it))
  }
  return obj
}

/** Generic field checker shared by terms and event params. */
export function checkFields(fields, obj, base, ref) {
  const errors = []
  const err = (path, code, message) => errors.push({ code, path: base ? `${base}.${path}` : path, message })
  for (const f of fields ?? []) {
    const v = getPath(obj, f.path)
    const label = f.label ?? f.path
    if (v === undefined || v === null || v === '') { if (f.required) err(f.path, 'REQUIRED', `${label} is required`); continue }
    switch (f.type) {
      case 'string':
        if (typeof v !== 'string') err(f.path, 'TYPE', `${label} must be text`)
        else if (f.pattern && !new RegExp(f.pattern).test(v)) err(f.path, 'FORMAT', `${label} has an invalid format`)
        break
      case 'number': case 'percent': case 'integer':
        if (typeof v !== 'number' || Number.isNaN(v)) { err(f.path, 'TYPE', `${label} must be a number`); break }
        if (f.type === 'integer' && !Number.isInteger(v)) err(f.path, 'TYPE', `${label} must be a whole number`)
        if (f.min !== undefined && (f.exclusiveMin ? v <= f.min : v < f.min)) err(f.path, 'RANGE', `${label} must be ${f.exclusiveMin ? '>' : '≥'} ${f.type === 'percent' ? `${f.min * 100}%` : f.min}`)
        if (f.max !== undefined && v > f.max) err(f.path, 'RANGE', `${label} must be ≤ ${f.type === 'percent' ? `${f.max * 100}%` : f.max}`)
        break
      case 'boolean': if (typeof v !== 'boolean') err(f.path, 'TYPE', `${label} must be true/false`); break
      case 'date': if (!isDate(v)) err(f.path, 'FORMAT', `${label} must be YYYY-MM-DD`); break
      case 'enum': if (!f.values.includes(v)) err(f.path, 'ENUM', `${label} must be one of ${f.values.join(', ')}`); break
      case 'ref':
        if (ref && f.ref === 'party' && !ref.parties.some((p) => p.partyId === v)) err(f.path, 'UNKNOWN_REF', `unknown party ${v}`)
        if (ref && f.ref === 'book' && !ref.books.some((b) => b.bookId === v)) err(f.path, 'UNKNOWN_REF', `unknown book ${v}`)
        break
      case 'map': if (typeof v !== 'object' || Array.isArray(v)) err(f.path, 'TYPE', `${label} must be an object`); break
      case 'array':
        if (!Array.isArray(v)) { err(f.path, 'TYPE', `${label} must be a list`); break }
        if (f.minItems !== undefined && v.length < f.minItems) err(f.path, 'RANGE', `${label} needs at least ${f.minItems}`)
        if (f.maxItems !== undefined && v.length > f.maxItems) err(f.path, 'RANGE', `${label} allows at most ${f.maxItems}`)
        v.forEach((it, i) => errors.push(...checkFields(f.items, it ?? {}, `${base ? `${base}.` : ''}${f.path}[${i}]`, ref)))
        break
    }
  }
  return errors
}

export const scopeOf = (trade, extra = {}) => ({ ...trade, terms: trade.terms ?? {}, productState: trade.productState ?? {}, ...extra })

export function validateProduct(tpl, trade, ref) {
  const errors = checkFields(tpl.terms?.fields, trade.terms ?? {}, 'terms', ref)
  const warnings = []
  if (errors.length === 0) {
    const scope = scopeOf(trade)
    for (const c of tpl.terms?.constraints ?? []) {
      let ok
      try { ok = evaluate(c.expr, scope) } catch { ok = false }
      if (!ok) (c.severity === 'warning' ? warnings : errors).push({ code: c.code ?? 'CONSTRAINT', path: c.path ?? 'terms', message: c.message })
    }
    for (const p of tpl.terms?.plugins ?? []) errors.push(...PLUGINS[p](trade, ref))
  }
  return { errors, warnings }
}

// ---------------------------------------------------------------------------
// schedules
// ---------------------------------------------------------------------------

/** Generate schedules declared by the template (unless already present, e.g. imported). */
export function generateSchedules(tpl, trade, { force = false } = {}) {
  const t = clone(trade)
  for (const s of tpl.schedules ?? []) {
    const existing = getPath(t, s.target)
    if (!force && Array.isArray(existing) && existing.length) continue
    const scope = scopeOf(t)
    const params = Object.fromEntries(Object.entries(s.params).map(([k, ex]) => [k, evaluate(ex, scope)]))
    const rows = GENERATORS[s.generator](params).map((row) => {
      const out = { ...row }
      for (const [col, ex] of Object.entries(s.columns ?? {})) out[col] = evaluate(ex, scopeOf(t, { ...row, count: params.count }))
      return out
    })
    setPath(t, s.target, rows)
    for (const [path, ex] of Object.entries(s.derive ?? {})) {
      const v = evaluate(ex, scopeOf(t, { last: rows.at(-1) ?? {}, first: rows[0] ?? {} }))
      if (v !== null && v !== undefined) setPath(t, path, v)
    }
  }
  if (tpl.kernel?.maturityFrom) {
    const m = evaluate(tpl.kernel.maturityFrom, scopeOf(t))
    if (isDate(m)) t.maturityDate = m
  }
  return t
}

// ---------------------------------------------------------------------------
// lifecycle runner
// ---------------------------------------------------------------------------

export function isTerminal(tpl, status) {
  return !!tpl?.lifecycle?.statuses?.[status]?.terminal
}

/** Events a user may invoke from the current status (derived events are engine-only). */
export function allowedEvents(tpl, state) {
  const out = []
  if (!tpl) return out
  if (!isTerminal(tpl, state.status)) out.push('AMEND')
  for (const [name, ev] of Object.entries(tpl.lifecycle.events)) if (!ev.derived && (ev.from ?? []).includes(state.status)) out.push(name)
  return out
}

/**
 * Interpret one requested event against a trade state. Returns { steps } where each step is
 * { eventType, validFrom, state, detail } — one immutable event each — or throws {code, details}.
 */
export function runEvent(tpl, trade, eventType, params = {}, { role, reason, effectiveDate } = {}) {
  const ev = tpl.lifecycle.events[eventType]
  const fail = (code, message, details = []) => { throw Object.assign(new Error(message), { code, details }) }
  if (!ev) fail('VALIDATION_FAILED', `${tpl.id} has no event ${eventType}`)
  if (ev.derived) fail('INVALID_TRANSITION', `${eventType} is derived by the engine and cannot be requested directly`)
  if (!(ev.from ?? []).includes(trade.status)) fail('INVALID_TRANSITION', `${eventType} is not allowed from ${trade.status}`)
  if (ev.roles && role && !ev.roles.includes(role)) fail('FORBIDDEN', `role ${role} cannot ${eventType}`)
  if (ev.requiresReason && !reason) fail('VALIDATION_FAILED', `reason is required for ${eventType}`, [{ code: 'REQUIRED', path: 'reason', message: 'reason is required' }])
  const p = defaultsInto(ev.params, coerceFields(ev.params, clone(params) ?? {}))
  const perrs = checkFields(ev.params, p, 'params')
  if (perrs.length) fail('VALIDATION_FAILED', `${perrs.length} parameter error(s)`, perrs)
  const scope = scopeOf(trade, { params: p, reason: reason ?? null })
  for (const g of ev.guards ?? []) {
    let ok
    try { ok = evaluate(g.expr, scope) } catch { ok = false }
    if (!ok) fail(g.code === 'OUT_OF_ORDER' || g.code === 'ALREADY' ? 'INVALID_TRANSITION' : 'VALIDATION_FAILED', g.message, [{ code: g.code ?? 'GUARD', path: g.path ?? 'params', message: g.message }])
  }
  const eff = effectiveDate ?? (ev.effectiveDate ? evaluate(ev.effectiveDate, scope) : null)
  const steps = []
  let cur = clone(trade)
  if (ev.plugin) {
    const r = PLUGINS[ev.plugin](cur, p, { tpl, role })
    if (r.errors?.length) fail('VALIDATION_FAILED', r.errors[0].message, r.errors)
    for (const s of r.steps) {
      cur = s.apply(clone(cur))
      const to = tpl.lifecycle.events[s.eventType]?.to
      if (to) cur.status = to
      steps.push({ eventType: s.eventType, validFrom: s.validFrom ?? eff, state: cur, detail: s.detail ?? null })
    }
  } else {
    for (const f of ev.effects ?? []) {
      const sc = scopeOf(cur, { params: p, reason: reason ?? null })
      if (f.set) setPath(cur, f.set, evaluate(f.expr, sc))
      else if (f.append) {
        const val = Object.fromEntries(Object.entries(f.value).map(([k, ex]) => [k, evaluate(ex, sc)]))
        const arr = getPath(cur, f.append) ?? []
        setPath(cur, f.append, [...arr, val])
      }
    }
    if (ev.to) cur.status = ev.to
    steps.push({ eventType, validFrom: eff, state: cur, detail: Object.keys(p).length ? p : null })
  }
  return { steps, params: p }
}

/** Pricer binding: evaluate the template's parameter mapping (e.g. -> riga PriceRequest.trade). */
export function pricingRequest(tpl, trade) {
  const pr = tpl.pricing
  if (!pr) return { applicable: false, reason: 'template has no pricer binding' }
  const scope = scopeOf(trade)
  const applicable = pr.applicable ? !!evaluate(pr.applicable, scope) : true
  const mapped = Object.fromEntries(Object.entries(pr.mapping ?? {}).map(([k, ex]) => [k, evaluate(ex, scope)]))
  const notes = [...(pr.notes ?? [])]
  return { engine: pr.engine, tool: pr.tool, payoff: pr.payoff, dashboard: pr.dashboard ?? null, applicable, request: mapped, notes }
}

/** Server-side evaluation of the template's term-sheet layout (rendered generically by the UI). */
export function termSheet(tpl, trade) {
  const scope = scopeOf(trade)
  const val = (ex, sc = scope) => { try { const v = evaluate(ex, sc); return v === null || v === undefined ? '—' : v } catch { return '—' } }
  return (tpl.ui?.termSheet ?? []).map((sec) => sec.table
    ? { title: sec.title, columns: sec.columns.map(([h]) => h), rows: (evaluate(sec.table, scope) ?? []).map((row) => sec.columns.map(([, ex]) => val(ex, { ...scope, row }))) }
    : { title: sec.title, rows: sec.rows.map(([label, ex]) => [label, val(ex)]) })
}

/** Blotter display columns declared by the template, evaluated per row. */
export function displayColumns(tpl, trade) {
  const out = {}
  for (const c of tpl?.ui?.blotterColumns ?? []) {
    try { out[c.field] = c.expr ? evaluate(c.expr, scopeOf(trade)) : getPath(trade, c.field) ?? null } catch { out[c.field] = null }
  }
  return out
}

/** Flattened leaf diff (terms.coupon.barrier, terms.underlyings[0].initialFixing …). */
export function flatten(obj, base = '', out = {}) {
  if (obj === null || typeof obj !== 'object') { out[base] = obj; return out }
  if (Array.isArray(obj)) { if (!obj.length) out[base] = []; obj.forEach((v, i) => flatten(v, `${base}[${i}]`, out)); return out }
  const keys = Object.keys(obj)
  if (!keys.length && base) out[base] = {}
  for (const k of keys) flatten(obj[k], base ? `${base}.${k}` : k, out)
  return out
}
