// Tiny, safe expression language for product templates (docs/52 §R.4).
// No eval / Function: a hand-written tokenizer + Pratt parser over a whitelisted
// grammar — literals, dotted/indexed paths, arithmetic, comparison, logic,
// ternary, and calls to a fixed function table. Unknown identifiers are null.

const FUNCS = {
  min: (...a) => Math.min(...a.flat()), max: (...a) => Math.max(...a.flat()), abs: Math.abs,
  round: (x, dp = 0) => Math.round(x * 10 ** dp) / 10 ** dp, floor: Math.floor, ceil: Math.ceil,
  len: (x) => (x == null ? 0 : x.length ?? Object.keys(x).length), sum: (a) => (a ?? []).reduce((s, x) => s + x, 0),
  isDate: (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)),
  matches: (s, re) => typeof s === 'string' && new RegExp(re).test(s),
  contains: (a, x) => Array.isArray(a) ? a.includes(x) : typeof a === 'string' && a.includes(x),
  unique: (a) => Array.isArray(a) && new Set(a).size === a.length,
  pluck: (a, k) => (a ?? []).map((x) => x?.[k]),
  every: (a) => (a ?? []).every(Boolean), some: (a) => (a ?? []).some(Boolean),
  coalesce: (...a) => a.find((x) => x != null) ?? null,
  isNull: (x) => x == null,
}
export const registerFunction = (name, fn) => { FUNCS[name] = fn }

const TOKEN = /\s*(?:(\d+(?:\.\d+)?(?:e[-+]?\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([A-Za-z_$][\w$]*)|(==|!=|<=|>=|&&|\|\||\?\?|[-+*/%<>!?:.,()[\]]))/gy

function tokenize(src) {
  const out = []
  TOKEN.lastIndex = 0
  let m
  while (TOKEN.lastIndex < src.length) {
    const start = TOKEN.lastIndex
    if (!(m = TOKEN.exec(src))) {
      if (/^\s*$/.test(src.slice(start))) break
      throw new Error(`expr: unexpected input at ${start}: ${src.slice(start, start + 10)}`)
    }
    if (m[1]) out.push({ t: 'num', v: Number(m[1]) })
    else if (m[2]) out.push({ t: 'str', v: m[2].slice(1, -1).replace(/\\(.)/g, '$1') })
    else if (m[3]) out.push({ t: 'id', v: m[3] })
    else if (m[4]) out.push({ t: 'op', v: m[4] })
  }
  return out
}

const BP = { '??': 1, '||': 2, '&&': 3, '==': 4, '!=': 4, '<': 5, '<=': 5, '>': 5, '>=': 5, '+': 6, '-': 6, '*': 7, '/': 7, '%': 7 }

function parse(src) {
  const toks = tokenize(src)
  let i = 0
  const peek = () => toks[i]
  const next = () => toks[i++]
  const expect = (v) => { const t = next(); if (!t || t.v !== v) throw new Error(`expr: expected '${v}' in ${src}`); return t }
  function primary() {
    const t = next()
    if (!t) throw new Error(`expr: unexpected end in ${src}`)
    let node
    if (t.t === 'num' || t.t === 'str') node = { k: 'lit', v: t.v }
    else if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') node = { k: 'lit', v: t.v === 'true' }
      else if (t.v === 'null') node = { k: 'lit', v: null }
      else if (peek()?.v === '(') {
        next()
        const args = []
        if (peek()?.v !== ')') { do args.push(expr(0)); while (peek()?.v === ',' && next()) }
        expect(')')
        if (!Object.hasOwn(FUNCS, t.v)) throw new Error(`expr: unknown function ${t.v}`)
        node = { k: 'call', f: t.v, args }
      } else node = { k: 'var', v: t.v }
    } else if (t.v === '(') { node = expr(0); expect(')') }
    else if (t.v === '!' || t.v === '-') node = { k: 'un', op: t.v, a: unary() }
    else if (t.v === '[') {
      const items = []
      if (peek()?.v !== ']') { do items.push(expr(0)); while (peek()?.v === ',' && next()) }
      expect(']')
      node = { k: 'arr', items }
    } else throw new Error(`expr: unexpected '${t.v}' in ${src}`)
    for (;;) {
      if (peek()?.v === '.') { next(); const id = next(); if (id?.t !== 'id') throw new Error('expr: bad member'); node = { k: 'get', o: node, p: { k: 'lit', v: id.v } } }
      else if (peek()?.v === '[') { next(); const p = expr(0); expect(']'); node = { k: 'get', o: node, p } }
      else return node
    }
  }
  function unary() { return primary() }
  function expr(minBp) {
    let left = primary()
    for (;;) {
      const t = peek()
      if (!t || t.t !== 'op') break
      if (t.v === '?' && minBp === 0) {
        next(); const a = expr(0); expect(':'); const b = expr(0)
        left = { k: 'tern', c: left, a, b }
        continue
      }
      const bp = BP[t.v]
      if (!bp || bp <= minBp) break
      next()
      left = { k: 'bin', op: t.v, a: left, b: expr(bp) }
    }
    return left
  }
  const ast = expr(0)
  if (i < toks.length) throw new Error(`expr: trailing input in ${src}`)
  return ast
}

const SAFE_KEY = (k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype'

function run(n, scope) {
  switch (n.k) {
    case 'lit': return n.v
    case 'var': return Object.hasOwn(scope, n.v) ? scope[n.v] : null
    case 'arr': return n.items.map((x) => run(x, scope))
    case 'get': { const o = run(n.o, scope); const p = run(n.p, scope); return o != null && SAFE_KEY(String(p)) ? (o[p] ?? null) : null }
    case 'un': { const a = run(n.a, scope); return n.op === '!' ? !a : -a }
    case 'tern': return run(n.c, scope) ? run(n.a, scope) : run(n.b, scope)
    case 'call': return FUNCS[n.f](...n.args.map((a) => run(a, scope)))
    case 'bin': {
      if (n.op === '&&') return run(n.a, scope) && run(n.b, scope)
      if (n.op === '||') return run(n.a, scope) || run(n.b, scope)
      if (n.op === '??') return run(n.a, scope) ?? run(n.b, scope)
      const a = run(n.a, scope), b = run(n.b, scope)
      switch (n.op) {
        case '+': return a + b
        case '-': return a - b
        case '*': return a * b
        case '/': return a / b
        case '%': return a % b
        case '==': return a === b
        case '!=': return a !== b
        case '<': return a < b
        case '<=': return a <= b
        case '>': return a > b
        case '>=': return a >= b
      }
    }
  }
  throw new Error(`expr: bad node ${n.k}`)
}

const cache = new Map()
export function compile(src) {
  if (!cache.has(src)) cache.set(src, parse(String(src)))
  return cache.get(src)
}
export function evaluate(src, scope = {}) {
  return run(compile(src), scope)
}
