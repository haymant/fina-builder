// P1 — canonical `fina.instrument/v1` adapters + toRequest (docs/46 §4/§5).
// Fixtures are read from the riga-flow submodule so the tests pin the real
// cross-document shapes (one Murex chunk with 3 legs + the riga fixture).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectAdapter } from '../adapters/detect'
import { decodeMurexChunk } from '../adapters/murexChunk'
import { decodeRigaFixture } from '../adapters/rigaFixture'
import { blankDocument } from '../adapters/manual'
import { parseInstrumentText } from '../parse'
import { toRequest, InstrumentError, rateAt } from '../toRequest'
import { tradeFromDocument } from '../selectors'
import { INSTRUMENT_SCHEMA } from '../schema'

const FIXTURES = resolve(process.cwd(), 'modules/riga-flow/docs/fixture')
const readJson = (name: string) => JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'))

const MUREX = readJson('termsheet1.md.json') // 3 legs: PUT / COUPON / FUNDING
const RIGA = readJson('termsheet1.json') // the canonical riga fixture

describe('detectAdapter', () => {
  it('recognises a Murex chunk', () => {
    expect(detectAdapter(MUREX)).toBe('murex-chunk@1')
  })
  it('recognises the riga fixture', () => {
    expect(detectAdapter(RIGA)).toBe('riga-fixture@1')
  })
  it('rejects an unknown shape', () => {
    expect(detectAdapter({ hello: 'world' })).toBeNull()
  })
})

describe('murex-chunk adapter', () => {
  const doc = decodeMurexChunk(MUREX, 'termsheet1.md.json')

  it('produces a fina.instrument/v1 document', () => {
    expect(doc.schema).toBe(INSTRUMENT_SCHEMA)
    expect(doc.source.adapter).toBe('murex-chunk@1')
    expect(doc.source.fileName).toBe('termsheet1.md.json')
  })

  it('maps the three jobs to PUT / COUPON / FUNDING legs', () => {
    const kinds = doc.legs.map((leg) => leg.kind)
    expect(kinds).toContain('put')
    expect(kinds).toContain('coupon')
    expect(kinds).toContain('funding')
    expect(doc.legs.filter((leg) => leg.pricedByEngine)).toHaveLength(1)
    expect(doc.legs.find((leg) => leg.pricedByEngine)?.kind).toBe('put')
  })

  it('decodes the put terms and the Phoenix rails', () => {
    const put = doc.legs.find((leg) => leg.kind === 'put')?.put
    expect(put?.initialSpots).toHaveLength(2)
    expect(put?.knockInBarrier).toBeCloseTo(0.7, 6)
    expect(put?.knockInType).toBe('EKI')
    expect(put?.rails.PRKI2).toBeCloseTo(-1, 6)
    expect(put?.rails.KIBarrier).toBeCloseTo(0.7, 6)
    expect(put?.rails.raw).toHaveProperty('strikeKI2')
  })

  it('accepts the captured unit KI participation (PRKI2 = -1)', () => {
    expect(doc.issues.some((issue) => issue.path.endsWith('/PRKI2'))).toBe(false)
  })

  it('flags a non-unit KI participation (PRKI2)', () => {
    const mutated = structuredClone(MUREX) as Record<string, unknown>
    let mutatedCount = 0
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk)
        return
      }
      if (node && typeof node === 'object') {
        const obj = node as Record<string, unknown>
        if ('PRKI2' in obj) {
          obj.PRKI2 = -0.5
          mutatedCount += 1
        }
        Object.values(obj).forEach(walk)
      }
    }
    walk(mutated)
    expect(mutatedCount).toBeGreaterThan(0)
    const issue = decodeMurexChunk(mutated, 'mutated.json').issues.find((i) =>
      i.path.endsWith('/PRKI2'),
    )
    expect(issue?.code).toBe('engine.unsupported_rail')
    expect(issue?.message).toContain('PRKI2=-0.5')
  })

  it('decodes the market, as-of and simulation', () => {
    expect(doc.market.symbols).toEqual(['ADBE', 'AMZN'])
    expect(doc.market.asOf).toBe('2026-09-07')
    expect(doc.market.spots).toHaveLength(2)
    expect(doc.market.correlation).toHaveLength(2)
    expect(doc.market.correlation[0]).toHaveLength(2)
    expect(doc.market.localVol.length).toBeGreaterThan(0)
    expect(doc.simulation.paths).toBe(30000)
  })

  it('feeds toRequest with a 2-factor put request', () => {
    const request = toRequest(doc)
    expect(request.trade.initialSpots).toHaveLength(2)
    expect(request.market.asOf).toBe('2026-09-07')
    expect(request.asOf).toBe('2026-09-07')
    expect(request.config.paths).toBe(30000)
    expect(request.localVol?.grids.length).toBeGreaterThan(0)
  })
})

describe('riga-fixture adapter', () => {
  const doc = decodeRigaFixture(RIGA, 'termsheet1.json')

  it('produces a fina.instrument/v1 document', () => {
    expect(doc.schema).toBe(INSTRUMENT_SCHEMA)
    expect(doc.source.adapter).toBe('riga-fixture@1')
    expect(doc.legs).toHaveLength(1)
    expect(doc.legs[0].kind).toBe('put')
  })

  it('maps barriers, coupon and initial fixings', () => {
    const put = doc.legs[0].put
    expect(put?.initialSpots).toEqual([239.97, 260])
    expect(put?.strike).toBeCloseTo(0.78, 6)
    expect(put?.knockInBarrier).toBeCloseTo(0.7, 6)
    expect(put?.knockOutBarrier).toBeCloseTo(1.1, 6)
    expect(put?.couponRate).toBeCloseTo(0.009642, 9)
    expect(put?.couponPeriods).toBe(9)
    expect(put?.memoryCoupon).toBe(true)
  })

  it('maps the market (fixings, marks, correlation, curve, local vol)', () => {
    expect(doc.market.asOf).toBe('2026-09-07')
    expect(doc.market.symbols).toEqual(['ADBE', 'AMZN'])
    expect(doc.market.spots).toEqual([267.885, 258.355])
    expect(doc.market.correlation[0][1]).toBeCloseTo(0.4593248181, 9)
    expect(doc.market.dividendYields[0]).toBe(0)
    expect(doc.market.discountCurve?.pillars.length).toBeGreaterThan(0)
    expect(doc.market.localVol).toHaveLength(2)
  })

  it('derives a flat risk-free rate from the discount curve', () => {
    const rate = rateAt(doc.market.discountCurve, 0.75)
    expect(rate).toBeGreaterThan(0.037)
    expect(rate).toBeLessThan(0.043)
  })

  it('carries fixture acceptance metadata as unmapped, not engine input', () => {
    const paths = doc.unmapped.map((entry) => entry.sourcePath)
    expect(paths).toContain('/expected')
    expect(paths).toContain('/provenance')
  })
})

describe('cross-document acceptance', () => {
  it('both dialects decode to a valid put request', () => {
    for (const doc of [decodeMurexChunk(MUREX, 'termsheet1.md.json'), decodeRigaFixture(RIGA, 'termsheet1.json')]) {
      const request = toRequest(doc)
      expect(request.trade.initialSpots).toHaveLength(2)
      expect(request.market.spots).toHaveLength(2)
      expect(Number.isFinite(request.market.riskFreeRate)).toBe(true)
      expect(tradeFromDocument(doc).tradeId).toBeTruthy()
    }
  })
})

describe('manual document', () => {
  it('is a valid 2-factor put document', () => {
    const doc = blankDocument('manual.json')
    expect(doc.source.adapter).toBe('manual')
    expect(toRequest(doc).trade.initialSpots).toHaveLength(2)
  })
})

describe('parseInstrumentText', () => {
  it('parses a Murex chunk from text', () => {
    const result = parseInstrumentText(JSON.stringify(MUREX), 'termsheet1.md.json')
    expect(result.ok).toBe(true)
    expect(result.adapter).toBe('murex-chunk@1')
    expect(result.document?.legs.length).toBe(3)
  })
  it('parses the riga fixture from text', () => {
    expect(parseInstrumentText(JSON.stringify(RIGA)).adapter).toBe('riga-fixture@1')
  })
  it('reports invalid JSON', () => {
    const result = parseInstrumentText('{ not json')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('invalid JSON')
  })
  it('reports an unrecognised shape', () => {
    const result = parseInstrumentText('{"foo":1}')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('unrecognised')
  })
})

describe('toRequest guard', () => {
  it('throws InstrumentError when there is no put leg', () => {
    const doc = { ...blankDocument(), legs: [] }
    expect(() => toRequest(doc)).toThrow(InstrumentError)
  })
})
