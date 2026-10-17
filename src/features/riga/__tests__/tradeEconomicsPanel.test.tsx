// P4 — the trade tile is the deep-form instrument editor (docs/46 §7.2): it
// renders the fina.instrument/v1 document, imports JSON via the paste box, and
// keeps price_trade as the displayed authority.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RigaTradeEconomicsPanel } from '../components/RigaTradeEconomicsPanel'
import { useInstrumentStore } from '../../../store/instrumentStore'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

const RIGA = readFileSync(
  resolve(process.cwd(), 'modules/riga-flow/docs/fixture/termsheet1.json'),
  'utf8',
)

beforeEach(() => {
  installRigaTranscript()
  localStorage.removeItem('fina-instrument')
  useInstrumentStore.getState().reset()
})
afterEach(() => {
  resetTranscripts()
})

describe('RigaTradeEconomicsPanel', () => {
  it('renders the instrument document header and the price_trade authority', () => {
    render(<RigaTradeEconomicsPanel />)
    expect(screen.getByText('riga-flow Trade Economics')).toBeTruthy()
    expect(screen.getByText('fina.instrument/v1')).toBeTruthy()
    expect(screen.getAllByText('price_trade').length).toBeGreaterThan(0)
  })

  it('renders the instrument fields as a tabular grid', () => {
    render(<RigaTradeEconomicsPanel />)
    expect(screen.getByText('Strike (× initial)')).toBeTruthy()
    expect(screen.getByText('Initial fixing 1 (P0)')).toBeTruthy()
    // finap's `.fina-form-grid` layout, one bordered cell per field.
    expect(document.querySelector('.fina-form-grid')).toBeTruthy()
    expect(document.querySelector('[data-tabular-path="/legs/0/put/strike"]')).toBeTruthy()
  })

  it('imports pasted JSON through the store', async () => {
    render(<RigaTradeEconomicsPanel />)
    fireEvent.click(screen.getByText('Paste'))
    const textarea = screen.getByPlaceholderText(/Paste instrument JSON/)
    fireEvent.change(textarea, { target: { value: RIGA } })
    fireEvent.click(screen.getByTestId('instrument-paste-import'))

    await waitFor(() => {
      expect(useInstrumentStore.getState().document.source.adapter).toBe('riga-fixture@1')
    })
    expect(screen.getByText(/Imported \(riga fixture\)/)).toBeTruthy()
  })

  it('reports an invalid paste without changing the document', async () => {
    render(<RigaTradeEconomicsPanel />)
    const before = useInstrumentStore.getState().document
    fireEvent.click(screen.getByText('Paste'))
    fireEvent.change(screen.getByPlaceholderText(/Paste instrument JSON/), {
      target: { value: '{ not json' },
    })
    fireEvent.click(screen.getByTestId('instrument-paste-import'))

    await waitFor(() => {
      expect(screen.getByText(/invalid JSON/)).toBeTruthy()
    })
    expect(useInstrumentStore.getState().document).toBe(before)
  })
})
