// The Petri net is the single source of truth. Payoff / Risk / Explain draw ONE
// canvas; the risk and explain tiles are watchers bound to the shared selection
// (like transition/token detail). This locks that contract.

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExplainNetTile, PayoffPetriNetTile, RiskNetTile } from '../components/PetriNetTiles'
import { useRigaSelectionStore } from '../../../store/rigaSelectionStore'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

beforeEach(() => {
  vi.useFakeTimers()
  installRigaTranscript()
  useRigaSelectionStore.setState({ selectedTransitionId: null, selectedPlaceId: null, layer: 'execution' })
})
afterEach(() => {
  resetTranscripts()
  vi.useRealTimers()
})

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300)
  })
}

describe('petri net source of truth + watchers', () => {
  it('the source-of-truth net renders the canvas and the layer switch', async () => {
    render(<PayoffPetriNetTile />)
    await settle()
    expect(screen.getByTestId('riga-net-canvas')).toBeInTheDocument()
    expect(screen.getByTestId('riga-net-layer-switch')).toBeInTheDocument()
    expect(useRigaSelectionStore.getState().layer).toBe('execution')
  })

  it('the layer switch drives the shared layer', async () => {
    render(<PayoffPetriNetTile />)
    await settle()
    fireEvent.click(screen.getByText('Risk'))
    expect(useRigaSelectionStore.getState().layer).toBe('risk')
    fireEvent.click(screen.getByText('Explain'))
    expect(useRigaSelectionStore.getState().layer).toBe('explain')
  })

  it('only one canvas exists across the net tiles', async () => {
    render(<PayoffPetriNetTile />)
    render(<RiskNetTile />)
    render(<ExplainNetTile />)
    await settle()
    expect(screen.getAllByTestId('riga-net-canvas')).toHaveLength(1)
  })

  it('the risk watcher pins the selected transition (engine id via the workflow node)', async () => {
    render(<RiskNetTile />)
    await settle()
    expect(screen.queryByTestId('riga-risk-selected')).toBeNull()
    // `global_ko_gate` is a canvas node id; it maps to the engine id `daily_global_ko`.
    act(() => useRigaSelectionStore.getState().selectNode('transition', 'global_ko_gate'))
    expect(screen.getByTestId('riga-risk-selected')).toBeInTheDocument()
  })

  it('the explain watcher pins the selected ledger entry', async () => {
    render(<ExplainNetTile />)
    await settle()
    expect(screen.queryByTestId('riga-explain-selected')).toBeNull()
    act(() => useRigaSelectionStore.getState().selectNode('transition', 'global_ko_gate'))
    expect(screen.getByTestId('riga-explain-selected')).toBeInTheDocument()
  })

  it('a watcher row click writes the shared selection', async () => {
    render(<RiskNetTile />)
    await settle()
    const bodyRow = screen.getAllByRole('row')[1]!
    fireEvent.click(bodyRow)
    expect(useRigaSelectionStore.getState().selectedTransitionId).toBeTruthy()
    // Selecting a transition clears any place selection.
    expect(useRigaSelectionStore.getState().selectedPlaceId).toBeNull()
  })
})
