// Central instrument store (docs/46 §6): owns the canonical `fina.instrument/v1`
// document, imports/pastes it, and pushes the derived flat values into the
// existing riga trade/market stores that `composeRigaRequest` reads.
//
// Low-risk integration: the trade is always synced (the document represents it
// fully); the market is synced only when the document carries real market data
// (`market.raw`) and the user is on the `document` lane, so a lake-lane market
// or a curve-less manual document never overwrites the live request market.

import { create } from 'zustand'
import type { RigaMarketSnapshot, RigaPhoenixTrade } from '../features/riga/types'
import { emptyMeta, emptyRails, INSTRUMENT_SCHEMA } from '../features/riga/instrument/schema'
import type { InstrumentDocument, InstrumentSimulation } from '../features/riga/instrument/schema'
import { parseInstrumentText, type ParseResult } from '../features/riga/instrument/parse'
import {
  marketFromDocument,
  simulationFromDocument,
  tradeFromDocument,
} from '../features/riga/instrument/selectors'
import { validateDocument } from '../features/riga/instrument/validate'
import { useRigaTradeStore } from './rigaTradeStore'
import { useRigaMarketStore, type RigaSimulationInputs } from './rigaMarketStore'

const KEY = 'fina-instrument'

export type MarketSource = 'document' | 'lake'

/** Build a document from the current flat stores, so the two never disagree. */
function documentFromFlat(
  trade: RigaPhoenixTrade,
  market: RigaMarketSnapshot,
  simulation: RigaSimulationInputs,
): InstrumentDocument {
  return {
    schema: INSTRUMENT_SCHEMA,
    source: { kind: 'manual', adapter: 'manual', fileName: null, importedAt: null, rawHash: null },
    meta: { ...emptyMeta(), name: trade.tradeId, template: 'ELIFCN_KI', currency: 'USD' },
    legs: [
      {
        id: 'PUT',
        legId: 1,
        kind: 'put',
        pricedByEngine: true,
        extras: {},
        put: {
          initialSpots: trade.initialSpots,
          strike: trade.strike,
          knockInBarrier: trade.knockInBarrier,
          knockInType: 'EKI',
          knockOutKind: trade.knockOutBarrier != null ? 'global' : 'none',
          knockOutBarrier: trade.knockOutBarrier,
          koLocked: [],
          koDates: [],
          couponBarrier: trade.couponBarrier,
          couponRate: trade.couponRate,
          memoryCoupon: trade.memoryCoupon,
          couponPeriods: trade.couponPeriods,
          fixedFirstCoupon: trade.fixedFirstCoupon,
          maturityYears: trade.maturityYears,
          steps: trade.steps,
          callStartStep: trade.callStartStep,
          rails: emptyRails(),
        },
      },
    ],
    market: {
      asOf: market.asOf,
      symbols: ['A', 'B'],
      initialFixings: trade.initialSpots,
      spots: market.spots,
      vols: market.vols,
      dividendYields: market.dividendYields,
      correlation: market.correlation,
      discountCurve: null,
      localVol: [],
      raw: {},
    },
    simulation: {
      paths: simulation.paths,
      pathBlockSize: simulation.pathBlockSize,
      seed: simulation.seed,
      traceLevel: 'aggregated',
      aad: false,
      varianceReduction: simulation.varianceReduction,
    },
    issues: [],
    unmapped: [],
  }
}

function seedDocument(): InstrumentDocument {
  const trade = useRigaTradeStore.getState().trade
  const marketState = useRigaMarketStore.getState()
  return documentFromFlat(trade, marketState.market, marketState.simulation)
}

function loadDocument(): InstrumentDocument | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as InstrumentDocument
    return parsed?.schema === INSTRUMENT_SCHEMA ? parsed : null
  } catch {
    return null
  }
}

function persist(document: InstrumentDocument) {
  try {
    localStorage.setItem(KEY, JSON.stringify(document))
  } catch {
    /* storage is optional */
  }
}

/** Recompute findings and re-impose provenance that is not user-editable. */
function normalise(next: InstrumentDocument, prev: InstrumentDocument): InstrumentDocument {
  const doc = {
    ...next,
    schema: INSTRUMENT_SCHEMA,
    source: next.source?.adapter ? next.source : prev.source,
    unmapped: next.unmapped ?? prev.unmapped,
  }
  return { ...doc, issues: validateDocument(doc) }
}

function pushFlat(document: InstrumentDocument, marketSource: MarketSource) {
  try {
    useRigaTradeStore.setState({ trade: tradeFromDocument(document) })
  } catch {
    /* no put leg — leave the flat trade untouched */
  }
  if (marketSource === 'document' && Object.keys(document.market.raw ?? {}).length > 0) {
    try {
      useRigaMarketStore.setState({
        market: marketFromDocument(document),
        simulation: simulationFromDocument(document),
      })
    } catch {
      /* leave the flat market untouched */
    }
  }
}

interface InstrumentState {
  document: InstrumentDocument
  marketSource: MarketSource
  lastImport: ParseResult | null
  importText: (text: string, fileName?: string | null) => ParseResult
  applyDocument: (next: InstrumentDocument) => void
  setMarketSource: (source: MarketSource) => void
  updateSimulation: (patch: Partial<InstrumentSimulation>) => void
  reset: () => void
}

const initial = loadDocument() ?? seedDocument()

export const useInstrumentStore = create<InstrumentState>((set, get) => ({
  document: initial,
  marketSource: loadDocument() ? 'document' : 'lake',
  lastImport: null,

  importText: (text, fileName = null) => {
    const result = parseInstrumentText(text, fileName)
    if (!result.ok || !result.document) {
      set({ lastImport: result })
      return result
    }
    const document = { ...result.document, issues: validateDocument(result.document) }
    set({ document, marketSource: 'document', lastImport: result })
    persist(document)
    pushFlat(document, 'document')
    return result
  },

  applyDocument: (next) => {
    const document = normalise(next, get().document)
    set({ document })
    persist(document)
    pushFlat(document, get().marketSource)
  },

  setMarketSource: (marketSource) => {
    set({ marketSource })
    if (marketSource === 'document') pushFlat(get().document, 'document')
  },

  updateSimulation: (patch) => {
    const document: InstrumentDocument = {
      ...get().document,
      simulation: { ...get().document.simulation, ...patch },
    }
    set({ document })
    persist(document)
    pushFlat(document, get().marketSource)
  },

  reset: () => {
    const document = seedDocument()
    set({ document, marketSource: 'lake', lastImport: null })
    try {
      localStorage.removeItem(KEY)
    } catch {
      /* optional */
    }
  },
}))
