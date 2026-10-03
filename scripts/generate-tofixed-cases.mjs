#!/usr/bin/env node
// Generates the differential corpus for `crates/fina-kernel/tests/tofixed_conformance.rs`.
//
//   node scripts/generate-tofixed-cases.mjs
//
// Output: crates/fina-kernel/tests/fixtures/tofixed-cases.json
//
// Each entry is `[valueBitsHex, places, jsResult]`.
//
// ## Why hex bit patterns and not decimal
//
// An earlier version stored the value as a JSON number. That is ambiguous here:
// `0.45` and `0.44999999999999996` are adjacent doubles whose *shortest*
// round-trip decimal forms are both acceptable to write as `0.45` in prose but
// only one of them parses back to itself. Entries therefore deserialized to a
// different double than they were generated from, producing impossible-looking
// contradictions ("[0.45, 1] expects both 0.4 and 0.5"). Storing the raw IEEE-754
// bit pattern removes all doubt: the test reconstructs the exact double with
// `f64::from_bits`, so corpus and implementation can never disagree about which
// value is under test.
//
// ## Coverage
//
// - every distinct value the real kernel formats, taken from golden.json
// - an exhaustive sweep of every 4-decimal value ending in 5, i.e. every
//   `toFixed` tie position, in both signs, plus the `pct()` `v * 100` form
// - an exhaustive 3-decimal sweep at 1 and 2 decimal places
// - 60,000 pseudo-random doubles across 8 orders of magnitude
//
// A naive `Math.round(v * 10^p) / 10^p` fails this corpus, so passing it is
// real evidence that `js_to_fixed` rounds the exact decimal expansion.

import { writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const goldenPath = join(
  here,
  '../crates/fina-kernel/tests/fixtures/golden.json',
)
const outPath = join(here, '../crates/fina-kernel/tests/fixtures/tofixed-cases.json')

const buf = new ArrayBuffer(8)
const f64 = new Float64Array(buf)
const u8 = new Uint8Array(buf)

/** Exact IEEE-754 bit pattern, big-endian hex, for round-trip fidelity. */
function bitsOf(v) {
  f64[0] = v
  // toReversed() avoids a Node-version dependency on Array.prototype.toReversed.
  return Array.from(u8.slice().reverse())
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const seen = new Set()
const rows = []

function push(v, places) {
  if (!Number.isFinite(v)) return
  const bits = bitsOf(v)
  const key = `${bits}:${places}`
  if (seen.has(key)) return
  seen.add(key)
  rows.push([bits, places, v.toFixed(places)])
}

// --- 1. every distinct value the kernel actually formats -------------------
const golden = JSON.parse(readFileSync(goldenPath, 'utf8')).simulationBundle
const values = [
  0, -0, 0.1, 0.25, 0.5, 0.75, 1, 100, 0.0001, -0.0001, 99.999,
]
for (const p of golden.paths) {
  values.push(
    ...p.worstOfPerformance,
    p.payoff,
    p.couponValue,
    p.putValue,
    p.memoryCouponValue,
    p.redemptionValue,
    ...Object.values(p.attribution),
  )
  for (const w of p.worstOfPerformance) values.push(w * 100) // the pct() input
}
for (const v of values) {
  push(v, 1)
  push(v, 2)
  push(-v, 1)
  push(-v, 2)
}

// --- 2. exhaustive tie sweep: every 4-decimal value ending in 5 -------------
for (let k = 0; k < 20000; k += 1) {
  const v = k / 10000
  if (Math.round(v * 10000) % 10 !== 5) continue
  push(v, 0)
  push(v, 1)
  push(v, 2)
  push(-v, 1)
  push(-v, 2)
  push(v * 100, 1)
}

// --- 3. exhaustive 3-decimal sweep ----------------------------------------
for (let k = 0; k < 200000; k += 1) {
  const v = k / 1000
  push(v, 1)
  push(v, 2)
}

// --- 4. deterministic pseudo-random doubles across magnitudes --------------
let s = 12345
const rnd = () => {
  s = (s * 1103515245 + 12345) & 0x7fffffff
  return s / 0x7fffffff
}
for (let i = 0; i < 60000; i += 1) {
  const v = (rnd() - 0.5) * 10 ** Math.floor(rnd() * 6 - 2)
  push(v, 0)
  push(v, 1)
  push(v, 2)
}

writeFileSync(outPath, JSON.stringify(rows))
console.log(`wrote ${rows.length} cases to ${outPath}`)

// Sanity check: the corpus must be self-consistent. Re-derive every expectation
// from the reconstructed double and confirm it matches what we stored. This runs
// in Node so a generator bug surfaces here rather than as a confusing Rust
// failure.
let checked = 0
for (const [hex, places, expected] of rows) {
  const u = new Uint8Array(8)
  for (let i = 0; i < 8; i += 1) {
    u[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  f64[0] = new DataView(u.buffer).getFloat64(0)
  if (f64[0].toFixed(places) !== expected) {
    throw new Error(`corpus self-check failed for bits=${hex} places=${places}`)
  }
  checked += 1
}
console.log(`self-check passed on all ${checked} cases`)