// P4 — the market tile has a document | lake lane (docs/46 §7.3); the document
// lane imports market JSON into the canonical instrument document.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RigaMarketDataPanel } from '../components/RigaMarketDataPanel'
import { useInstrumentStore } from '../../../store/instrumentStore'
import { installRigaTranscript, installTacTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

const MUREX = readFileSync(
  resolve(process.cwd(), 'modules/riga-flow/docs/fixture/termsheet1.md.json'),
  'utf8',
)

beforeEach(() => {
  installRigaTranscript()
  installTacTranscript()
  localStorage.removeItem('fina-instrument')
  useInstrumentStore.getState().reset()
})
afterEach(() => {
  resetTranscripts()
})

describe('RigaMarketDataPanel lanes', () => {
  it('offers the document and lake lanes', () => {
    render(<RigaMarketDataPanel />)
    expect(screen.getByText('Instrument market')).toBeTruthy()
    expect(screen.getByText('Lake (tac-engine)')).toBeTruthy()
  })

  it('document lane imports market JSON', async () => {
    render(<RigaMarketDataPanel />)
    fireEvent.click(screen.getByText('Instrument market'))
    expect(screen.getByText('Import market JSON')).toBeTruthy()

    fireEvent.click(screen.getByText('Paste'))
    fireEvent.change(screen.getByPlaceholderText(/Paste market JSON/), { target: { value: MUREX } })
    fireEvent.click(screen.getByTestId('market-paste-import'))

    await waitFor(() => {
      expect(useInstrumentStore.getState().document.market.correlation[0][1]).toBeGreaterThan(0)
    })
    expect(screen.getByText(/Imported market/)).toBeTruthy()
  })
})
