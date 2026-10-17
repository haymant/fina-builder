// P2 — central instrument store (docs/46 §6). Importing a document syncs the
// flat riga stores that composeRigaRequest reads, so every tile follows it.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { useInstrumentStore } from '../instrumentStore'
import { useRigaTradeStore } from '../rigaTradeStore'
import { useRigaMarketStore } from '../rigaMarketStore'

const FIXTURES = resolve(process.cwd(), 'modules/riga-flow/docs/fixture')
const read = (name: string) => readFileSync(resolve(FIXTURES, name), 'utf8')

beforeEach(() => {
  localStorage.removeItem('fina-instrument')
  useRigaTradeStore.getState().resetTrade()
  useRigaMarketStore.getState().resetMarket()
  useInstrumentStore.getState().reset()
})

describe('useInstrumentStore', () => {
  it('seeds a document from the current flat stores', () => {
    const doc = useInstrumentStore.getState().document
    expect(doc.schema).toBe('fina.instrument/v1')
    expect(doc.legs[0].kind).toBe('put')
    expect(doc.legs[0].put?.strike).toBe(useRigaTradeStore.getState().trade.strike)
  })

  it('imports the riga fixture and syncs the flat trade', () => {
    const result = useInstrumentStore.getState().importText(read('termsheet1.json'), 'termsheet1.json')
    expect(result.ok).toBe(true)
    expect(result.adapter).toBe('riga-fixture@1')

    const doc = useInstrumentStore.getState().document
    expect(doc.source.fileName).toBe('termsheet1.json')
    expect(useInstrumentStore.getState().marketSource).toBe('document')
    // The put leg flowed into the flat trade store.
    expect(useRigaTradeStore.getState().trade.strike).toBeCloseTo(0.78, 6)
    expect(useRigaTradeStore.getState().trade.knockInBarrier).toBeCloseTo(0.7, 6)
  })

  it('imports a three-leg Murex chunk', () => {
    const result = useInstrumentStore.getState().importText(read('termsheet1.md.json'), 'termsheet1.md.json')
    expect(result.adapter).toBe('murex-chunk@1')
    const kinds = useInstrumentStore.getState().document.legs.map((leg) => leg.kind)
    expect(kinds).toEqual(expect.arrayContaining(['put', 'coupon', 'funding']))
  })

  it('applyDocument pushes an edited strike into the flat trade store', () => {
    useInstrumentStore.getState().importText(read('termsheet1.json'), 'termsheet1.json')
    const current = useInstrumentStore.getState().document
    const next = structuredClone(current)
    next.legs[0].put!.strike = 0.5
    useInstrumentStore.getState().applyDocument(next)

    expect(useRigaTradeStore.getState().trade.strike).toBe(0.5)
    expect(useInstrumentStore.getState().document.legs[0].put?.strike).toBe(0.5)
  })

  it('recomputes issues on apply (no put leg -> a finding, not a crash)', () => {
    const current = useInstrumentStore.getState().document
    const next = structuredClone(current)
    next.legs = []
    useInstrumentStore.getState().applyDocument(next)
    expect(useInstrumentStore.getState().document.issues.map((i) => i.code)).toContain(
      'engine.no_put_leg',
    )
  })

  it('reports an invalid import without changing the document', () => {
    const before = useInstrumentStore.getState().document
    const result = useInstrumentStore.getState().importText('{ not json')
    expect(result.ok).toBe(false)
    expect(useInstrumentStore.getState().lastImport?.ok).toBe(false)
    expect(useInstrumentStore.getState().document).toBe(before)
  })

  it('reset re-seeds from the flat stores and clears persistence', () => {
    useInstrumentStore.getState().importText(read('termsheet1.json'), 'termsheet1.json')
    useInstrumentStore.getState().reset()
    expect(localStorage.getItem('fina-instrument')).toBeNull()
    expect(useInstrumentStore.getState().document.source.adapter).toBe('manual')
  })
})
