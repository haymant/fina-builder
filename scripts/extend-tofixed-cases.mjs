#!/usr/bin/env node
// Adds the `economics`, `risk_engine`, `marketDataStore` demo values **and the
// Phase 4 cashflow formatter inputs** to the differential corpus used by
// `crates/fina-kernel/tests/tofixed_conformance.rs`.
//
//   node scripts/extend-tofixed-cases.mjs
//
// Run this AFTER `scripts/generate-tofixed-cases.mjs`. The existing corpus was
// built from `simulationBundle` only, because that was all the kernel formatted
// during Phase 2. Phase 3 formats a second and third family of values, and
// Phase 3 found a real defect that the old corpus could not catch: the
// `+(x).toFixed(p)` idiom diverges from `Math.round(x * 10^p) / 10^p` on ties,
// and the divergence reaches a published preset (`Defensive Phoenix.couponPv`).
// Those values have to be in the corpus for `js_to_fixed_f64` to be proven.
//
// ## Why this appends rather than regenerates
//
// `generate-tofixed-cases.mjs` rewrites the file from scratch, which would drop
// these entries. Appending keeps the Phase 2 provenance intact and makes the
// script idempotent-safe: existing entries are skipped by the same
// `(bits, places)` key the original uses, so re-running changes nothing.
//
// ## Why hex bit patterns and not decimal
//
// Identical reason to the original generator: `0.45` and `0.44999999999999996`
// are adjacent doubles that both write as `0.45` in prose but only one parses
// back to itself. Storing bits removes the ambiguity.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const corpusPath = join(here, '../crates/fina-kernel/tests/fixtures/tofixed-cases.json')
const goldenPath = join(here, '../crates/fina-kernel/tests/fixtures/golden.json')

const buf = new ArrayBuffer(8)
const f64 = new Float64Array(buf)
const u8 = new Uint8Array(buf)

/** Exact IEEE-754 bit pattern, big-endian hex. */
function bitsOf(v) {
  f64[0] = v
  return Array.from(u8.slice().reverse())
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const rows = JSON.parse(readFileSync(corpusPath, 'utf8'))
const seen = new Set(rows.map(([bits, places]) => `${bits}:${places}`))
const before = rows.length

function push(v, places) {
  if (!Number.isFinite(v)) return
  const bits = bitsOf(v)
  const key = `${bits}:${places}`
  if (seen.has(key)) return
  seen.add(key)
  rows.push([bits, places, v.toFixed(places)])
}

// --- 1. the six presets, at every site that is formatted ------------------
// Transcribed from `src/store/tradeEconomicsStore.ts`. `deriveTradeAnalytics`
// formats seven values, each through `+(x).toFixed(p)`, and this is the family
// that contains the `Defensive Phoenix` tie.
const DEFAULT = {
  strike: 1, knockInBarrier: 0.6, knockOutBarrier: 1, couponLowerBarrier: 0.7,
  couponUpperBarrier: 1.2, couponRate: 0.12, memoryCouponEnabled: true,
  physicalSettlementEnabled: true, maturityYears: 5, notional: 100,
}
const PRESETS = {
  'Base Case': DEFAULT,
  'Defensive Phoenix': { ...DEFAULT, knockInBarrier: 0.5, knockOutBarrier: 0.95, couponRate: 0.09 },
  'Aggressive Yield': { ...DEFAULT, knockInBarrier: 0.7, knockOutBarrier: 1.1, couponRate: 0.18 },
  'Deep Barrier': { ...DEFAULT, knockInBarrier: 0.4, knockOutBarrier: 1.15, couponRate: 0.08 },
  'High Coupon': { ...DEFAULT, couponRate: 0.18, couponLowerBarrier: 0.8, knockInBarrier: 0.65 },
  'Capital Protected': { ...DEFAULT, knockInBarrier: 0.3, couponRate: 0.06, physicalSettlementEnabled: false },
}

/** The default 5-year coupon leg, used when combining linear fields. */
function couponPvFor(rate, maturity) {
  return 11.6 * (rate / 0.12) * 1.05 * (maturity / 5)
}

// Grid axes, chosen to hit tie positions rather than to be exhaustive.
//
// The load-bearing cases are doubles whose *exact decimal expansion* ends in a
// half at the formatted precision. Those arise from specific products —
// `0.09 / 0.12` is the one that bites a published preset — so the grid is dense
// on `coupon_rate` and `maturity_years`, which feed `coupon_pv`'s three-factor
// product, and dense on `knock_in_barrier`/`strike`, which feed the two
// linear terms. `notional` is coarse because `redemption` is exact for any
// notional whose `* 0.985` happens to be a 2dp decimal.
const RATES = [
  0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.085, 0.09, 0.095, 0.1, 0.105,
  0.11, 0.115, 0.12, 0.125, 0.13, 0.14, 0.15, 0.16, 0.17, 0.18, 0.2, 0.22, 0.25, 0.3, 0.4,
]
const MATURITIES = [0.5, 1, 1.5, 2, 2.5, 3, 4, 4.93, 5, 6, 7, 10, 15, 20, 30]
const STRIKES = [0.8, 0.9, 1, 1.1, 1.2]
const KNOCK_INS = [0.3, 0.4, 0.5, 0.6, 0.65, 0.7, 0.8, 1, 1.2]
const KNOCK_OUTS = [0.95, 1, 1.05, 1.1, 1.15, 1.2]
const NOTIONALS = [100, 150, 1000]

for (const [name, e] of Object.entries(PRESETS)) {
  // `coupon_pv` is swept densely on its own: it is the only field that reached a
  // tie in a published preset, and it does not depend on strike or barriers.
  for (const rate of RATES) {
    for (const maturity of MATURITIES) {
      const couponPv = 11.6 * (rate / 0.12) * (e.memoryCouponEnabled ? 1.05 : 0.9) * (maturity / 5)
      push(couponPv, 2)
      push(-couponPv, 2)
    }
  }

  // The linear fields and their combination, on a coarser grid.
  for (const strike of STRIKES) {
    for (const ki of KNOCK_INS) {
      const kiP = Math.max(4, Math.min(55, 22.1 + (ki - 0.6) * 62 + (strike - 1) * 12))
      const putPv = 7.2 + (ki - 0.6) * 34 + (strike - 1) * 18
      push(kiP, 1); push(kiP, 2); push(-kiP, 1)
      push(putPv, 2); push(-putPv, 2)
      for (const ko of KNOCK_OUTS) {
        const koP = Math.max(25, Math.min(85, 65 - (ko - 1) * 42 - (ki - 0.6) * 8))
        // Combined with the default 5-year coupon leg, which is what makes the
        // sum land on ties that neither factor does alone.
        const expectedPv = 100 + couponPvFor(0.12, 5) - putPv - (ko - 1) * 12 - kiP * 0.08
        push(koP, 1); push(koP, 2); push(-koP, 1)
        push(expectedPv, 2); push(-expectedPv, 2)
      }
    }
  }

  // Redemption and the whole-object `expected_pv` for the preset's own terms,
  // across a few notionals.
  for (const notional of NOTIONALS) {
    for (const rate of RATES) {
      for (const maturity of MATURITIES) {
        const t = { ...e, couponRate: rate, maturityYears: maturity, notional }
        const kiP = Math.max(4, Math.min(55, 22.1 + (t.knockInBarrier - 0.6) * 62 + (t.strike - 1) * 12))
        const koP = Math.max(25, Math.min(85, 65 - (t.knockOutBarrier - 1) * 42 - (t.knockInBarrier - 0.6) * 8))
        const couponPv = 11.6 * (t.couponRate / 0.12) * (t.memoryCouponEnabled ? 1.05 : 0.9) * (t.maturityYears / 5)
        const putPv = 7.2 + (t.knockInBarrier - 0.6) * 34 + (t.strike - 1) * 18
        const redemption = t.notional * (t.physicalSettlementEnabled ? 1 : 0.985)
        const expectedPv = redemption + couponPv - putPv - (t.knockOutBarrier - 1) * 12 - kiP * 0.08
        push(couponPv, 2); push(putPv, 2); push(redemption, 2); push(expectedPv, 2)
        push(kiP, 1); push(koP, 1)
        push(-couponPv, 2); push(-putPv, 2); push(-expectedPv, 2); push(-redemption, 2)
      }
    }
  }
  push(0.43 * Math.sqrt(100000 / 100000), 2)
  process.stderr.write(`  swept ${name}\n`)
}

// The preset's own published terms, at full grid density, so every value the
// Trade Design panel can display for the six shipped configurations is covered.
for (const e of Object.values(PRESETS)) {
  const kiP = Math.max(4, Math.min(55, 22.1 + (e.knockInBarrier - 0.6) * 62 + (e.strike - 1) * 12))
  const koP = Math.max(25, Math.min(85, 65 - (e.knockOutBarrier - 1) * 42 - (e.knockInBarrier - 0.6) * 8))
  const couponPv = 11.6 * (e.couponRate / 0.12) * (e.memoryCouponEnabled ? 1.05 : 0.9) * (e.maturityYears / 5)
  const putPv = 7.2 + (e.knockInBarrier - 0.6) * 34 + (e.strike - 1) * 18
  const redemption = e.notional * (e.physicalSettlementEnabled ? 1 : 0.985)
  const expectedPv = redemption + couponPv - putPv - (e.knockOutBarrier - 1) * 12 - kiP * 0.08
  for (const [v, dp] of [[expectedPv, 2], [couponPv, 2], [putPv, 2], [redemption, 2], [kiP, 1], [koP, 1]]) {
    push(v, dp); push(-v, dp)
  }
}

// --- 2. the risk engine's formatted outputs ------------------------------
const golden = JSON.parse(readFileSync(goldenPath, 'utf8'))
const market = { underlyings: [185, 420, 122], fx: [1.34, 1.08, 151.2] }

for (const rate of RATES) {
  for (const maturity of MATURITIES) {
    for (const notional of NOTIONALS) {
      for (const ki of [0.3, 0.5, 0.6, 0.7, 0.9, 1.1]) {
        for (const spotSum of [0, 100, 242, 300, 727, 1500, 5000]) {
          for (const fxSpot of market.fx) {
            const spot = spotSum / 3
            const base = notional * (1 + rate * maturity) - notional * 0.06 - (ki - 0.6) * notional * 0.3 + (spot - 242) * 0.08
            const ds = 1
            const pvUp = base + ds * 0.08
            const pvDown = base - ds * 0.08
            const vega = notional * maturity * 0.35

            push(base, 2)
            push((pvUp - pvDown) / (2 * ds) * 1000, 2)
            push((pvUp - 2 * base + pvDown) / (ds * ds) * 1000, 2)
            push(vega, 2)
            push(-notional * 0.012, 2)
            push(notional * 0.004, 2)
            push(fxSpot * 12, 2)
            for (let i = 0; i < 6; i += 1) push(vega * Math.exp(-i / 3), 2)

            // cross_gamma: three decimals, which is the only 3dp site in Phase 3.
            for (const c of [1, 0.55, 0.48, 0.62, 0, -0.5, -1, 0.123456, 1 / 3]) {
              push(c * 0.18, 3)
            }
          }
        }
      }
    }
  }
}

// --- 3. the demo market's synthetic history -------------------------------
// `makeBars` formats four prices per bar through `+(x).toFixed(2)`, and the
// sine makes them land on ties.
for (const start of [185, 420, 122]) {
  for (const seed of [1, 2, 3]) {
    for (let i = 0; i < 36; i += 1) {
      const close = start * (1 + Math.sin(i / 4 + seed) * 0.08 + i * 0.002)
      const c = Number(close.toFixed(2))
      push(c, 2); push(c * 0.99, 2); push(c * 1.02, 2); push(c * 0.97, 2)
    }
  }
}

// --- 4. the MC diagnostics series ----------------------------------------
for (const [paths, pv] of golden.mc.mcDiagnostics.map((p) => [p.paths, p.pv])) {
  const seRaw = 0.22 * Math.sqrt(100000 / paths)
  push(seRaw, 3)
  push(pv - 1.96 * Number(seRaw.toFixed(3)), 2)
  push(pv + 1.96 * Number(seRaw.toFixed(3)), 2)
}
for (let i = 0; i < 10; i += 1) {
  push(72 - 8 / Math.sqrt(i + 1), 2)
  push(116 - 5 / Math.sqrt(i + 1), 2)
}

// --- 5. Phase 4: the cashflow formatter inputs ----------------------------
// `buildCashflows` formats through `+(x).toFixed(p)` at THREE sites per row:
// `amount` at 2, `discountFactor` at **4**, and `presentValue` at 2. The 4-decimal
// site is the first in the port, and the corpus had no 4-decimal entries at all —
// `js_to_fixed_f64(.., 4)` would have been entirely unverified. These are the 60
// raw inputs from the fixture's own captured path, re-derived with the exact
// TypeScript expression so the bits match what the kernel produces.
const cfPath = golden.simulationBundle.paths[0] // pathIndex 1, the fixture's cashflow path
for (let i = 0; i < 60; i += 1) {
  const final = i === 59
  const accrued = cfPath.observations[i].couponAccrued > 0
  const amountRaw = final ? 100 : (100 * 0.12 / 12) * (accrued ? 1 : 0)
  const dfRaw = 1 / (1 + 0.04) ** ((i + 1) / 12)
  const dfRounded = Number(dfRaw.toFixed(4))
  const pvRaw = Number(amountRaw.toFixed(2)) * dfRounded // amount is already rounded

  push(amountRaw, 2)
  push(dfRaw, 4)
  push(pvRaw, 2)
  push(-dfRaw, 4) // negative curve would never occur, but the primitive is shared
}

// --- 6. 4-decimal tie coverage (p = 4) -------------------------------------
// Section 2 of the original generator sweeps ties at 1, 2 and 3 decimals only.
// These are the same sweep at 4.
for (let k = 0; k < 100000; k += 1) {
  const v = k / 100000
  if (Math.round(v * 100000) % 10 !== 5) continue
  push(v, 4)
  push(-v, 4)
  push(v, 2)
  push(-v, 2)
}
// Near-tie 4-decimal boundaries: doubles a hair either side of a 4dp boundary,
// the complement of the exact-tie sweep.
const nearTies4 = [0.00005, 0.00015, 0.00025, 0.00035, 0.00045, 0.00055, 0.00065, 0.00075,
  0.00085, 0.00095, 0.0045 / 10, 0.0055 / 10, 0.0095 / 10, 0.0145 / 10, 0.0995, 0.0995 * 10,
  0.000049999999999999, 0.004999999999999999, 0.045 * 0.1, 0.055 * 0.1,
]
for (const v of nearTies4) {
  push(v, 4)
  push(-v, 4)
}
// Broad non-tie sweep at 4 decimals (stride, like section 4 of the generator).
for (let k = 1; k < 20000; k += 1) {
  const v = k / 100000
  if (Math.round(v * 100000) % 10 === 5) continue
  push(v, 4)
  push(-v, 4)
}
// Pseudo-random doubles at 4 decimals, across magnitudes.
let s4 = 98765
const rnd4 = () => {
  s4 = (s4 * 1103515245 + 12345) & 0x7fffffff
  return s4 / 0x7fffffff
}
for (let i = 0; i < 20000; i += 1) {
  const v = (rnd4() - 0.5) * 10 ** Math.floor(rnd4() * 3 - 4)
  push(v, 4)
}

// --- 5. the known ties, stated explicitly --------------------------------
// These are the values that separate `+(x).toFixed(p)` from
// `Math.round(x * 10^p) / 10^p`. They are in the sweeps above by construction,
// listed here so that removing a sweep cannot silently remove the evidence.
const KNOWN_TIES = [
  11.6 * (0.09 / 0.12) * 1.05 * (5 / 5), // Defensive Phoenix couponPv
  150 * 4.93 * 0.35, // the bucket-vega test's vega_raw
  7.2 + (0.37 - 0.6) * 34, // the unrounded-ki_probability test
  0.22 * Math.sqrt(100000 / 2500), // the rounded-se test
]
for (const v of KNOWN_TIES) {
  for (const p of [1, 2, 3]) {
    push(v, p)
    push(-v, p)
  }
}

writeFileSync(corpusPath, JSON.stringify(rows))
console.log(`added ${rows.length - before} cases (${before} -> ${rows.length})`)

// Self-check, same as the original generator: re-derive every expectation from
// the reconstructed double, so a generator bug surfaces here rather than as a
// confusing Rust failure.
let checked = 0
for (const [hex, places, expected] of rows) {
  const u = new Uint8Array(8)
  for (let i = 0; i < 8; i += 1) u[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  f64[0] = new DataView(u.buffer).getFloat64(0)
  if (f64[0].toFixed(places) !== expected) {
    throw new Error(`corpus self-check failed for bits=${hex} places=${places}`)
  }
  checked += 1
}
console.log(`self-check passed on all ${checked} cases`)

// Report how many of the cases actually distinguish the two primitives, so the
// corpus's value is quantified rather than assumed.
//
// Two counts, because they answer different questions:
//
// - `digits` — `Math.round(v * 10^p) / 10^p` rounds to a *different number*.
//   This is the defect `js_to_fixed_f64` exists to prevent.
// - `signOfZero` — the two agree in magnitude but disagree in the sign of zero.
//   `+(−0.0001).toFixed(2)` is `-0` in JavaScript; `Math.round(-0.01) / 100` is
//   `+0`. `Object.is` distinguishes them, `String()` does not, and
//   `JSON.stringify` collapses both to `0`.
//
// The entry test must be `Object.is` (so `+0` and `-0` count as different), but
// the *classification* must use `=== 0`, not `Object.is(x, 0)` — `Object.is(-0, 0)`
// is `false`, so an `Object.is`-based classifier files every sign-of-zero case
// under `digits` and reports 6,713 / 0.
const jsRound = (v) => {
  const f = Math.floor(v)
  return v - f >= 0.5 ? f + 1 : f
}
let digits = 0
let signOfZero = 0
for (const [hex, places, expected] of rows) {
  const u = new Uint8Array(8)
  for (let i = 0; i < 8; i += 1) u[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  const v = new DataView(u.buffer).getFloat64(0)
  const naive = jsRound(v * 10 ** places) / 10 ** places
  const want = Number(expected)
  if (Object.is(naive, want)) continue
  // Loose equality on purpose: `+0 === -0` is true, so this catches "both are
  // zero but the signs differ" and nothing else.
  if (naive === 0 && want === 0) signOfZero += 1
  else digits += 1
}
console.log(`cases where a naive Math.round(v * 10^p) rounds to different digits: ${digits}`)
console.log(`cases where it differs only in the sign of zero:                ${signOfZero}`)

// These two numbers are also the assertions in `tests/tofixed_conformance.rs` and
// are quoted in Appendix D. If a sweep is added or removed, all three must move
// together — failing loudly here is what stops the docs becoming fiction.
const EXPECTED_DIGITS = 11111
const EXPECTED_SIGN_OF_ZERO = 5961
if (digits !== EXPECTED_DIGITS || signOfZero !== EXPECTED_SIGN_OF_ZERO) {
  throw new Error(
    `discriminating-case counts changed: got ${digits} digits / ${signOfZero} sign-of-zero, ` +
      `expected ${EXPECTED_DIGITS} / ${EXPECTED_SIGN_OF_ZERO}. Update this constant, the ` +
      `assertions in tests/tofixed_conformance.rs, and Appendix D together.`
  )
}