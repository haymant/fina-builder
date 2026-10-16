// tac-engine tile + guardrail tests (§6.7/§6.9, §14.1): every Tac* tile renders
// the recorded transcript data, and the workbench never calls a mutating tool.

import { act, render, renderHook, screen } from '@testing-library/react'
import type { ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TacBarChart, TacCorporateActions, TacCorrelationMatrix, TacFxSpot, TacFxVol,
  TacLakeCoverage, TacManipulationEditor, TacMarketDataPanel, TacSymbolPicker,
  TacTaSpPanes, TacVolSurface, TacYieldCurve,
} from '../components/TacTiles'
import { useTacActions } from '../hooks'
import { installTacTranscript, preloadTacMarket, resetTranscripts, TAC_TRANSCRIPT, type CallRecorder } from '../../../tests/mocks/transcripts'

let recorder: CallRecorder

beforeEach(() => {
  preloadTacMarket()
  recorder = installTacTranscript()
})
afterEach(() => resetTranscripts())

const tiles: Array<[string, ComponentType]> = [
  ['Symbol Picker', TacSymbolPicker],
  ['Bar Chart', TacBarChart],
  ['TA / SP Panes', TacTaSpPanes],
  ['Correlation Matrix', TacCorrelationMatrix],
  ['Vol Surface', TacVolSurface],
  ['Yield Curve', TacYieldCurve],
  ['FX Spot', TacFxSpot],
  ['FX Vol (realized)', TacFxVol],
  ['Corporate Actions', TacCorporateActions],
  ['Lake Coverage', TacLakeCoverage],
  ['Manipulation Editor', TacManipulationEditor],
  ['Market Data Workbench', TacMarketDataPanel],
]

describe('tac-engine tiles', () => {
  it('all Tac* tiles render against the recorded transcript', () => {
    for (const [title, Tile] of tiles) {
      const { unmount } = render(<Tile />)
      expect(screen.getAllByText(title).length, title).toBeGreaterThan(0)
      unmount()
    }
  })

  it('renders the calibrated vol-surface provenance', () => {
    render(<TacVolSurface />)
    expect(screen.getByText(/model=svi/)).toBeInTheDocument()
  })

  it('renders the correlation resolved rho, never 0', () => {
    render(<TacCorrelationMatrix />)
    expect(screen.getByText('0.3895')).toBeInTheDocument()
  })
})

describe('market-data guardrails', () => {
  it('never calls a mutating tac-engine tool from the workbench actions', async () => {
    const { result } = renderHook(() => useTacActions())
    await act(async () => {
      await Promise.allSettled([
        result.current.fetchBars('ADBE'),
        result.current.fetchSnapshot('ADBE'),
        result.current.fetchCorrelations(['ADBE', 'AMZN']),
        result.current.fetchVolSurface('ADBE'),
        result.current.fetchCurve(),
        result.current.fetchFx(['EURUSD']),
        result.current.fetchFxVol('USDJPY'),
        result.current.fetchCorporateActions('ADBE'),
        result.current.fetchCoverage(),
        result.current.fetchTa('ADBE'),
        result.current.fetchSp('ADBE'),
        result.current.fetchAll(['ADBE', 'AMZN']),
      ])
    })
    const forbidden = new Set(TAC_TRANSCRIPT.forbidden)
    for (const call of recorder.calls) {
      expect(forbidden.has(call.tool), `called ${call.tool}`).toBe(false)
    }
    expect(recorder.calls.length).toBeGreaterThan(0)
  })
})
