// Payoff Tree tile + Place Detail tile (docs/49 P3g-vi). The tree's population /
// route overlay is exercised in the browser; here we pin the wiring that can be
// checked without layout: the canvas, the derived route, the reachability notes
// and the place watcher's arcs.

import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RigaPayoffTreeTile } from '../components/RigaPayoffTreeTile'
import { RigaPlaceDetailTile } from '../components/PetriNetTiles'
import { useInstrumentStore } from '../../../store/instrumentStore'
import { useRigaSelectionStore } from '../../../store/rigaSelectionStore'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

beforeEach(() => {
  installRigaTranscript()
  localStorage.removeItem('fina-instrument')
  useInstrumentStore.getState().reset()
  useRigaSelectionStore.setState({ selectedPathId: 0, pathCount: 1024, cachedPath: null, selectedPlaceId: null })
})
afterEach(() => {
  resetTranscripts()
})

describe('payoff tree tile', () => {
  it('renders the tree canvas, the derived route and the unreachable notes', async () => {
    render(<RigaPayoffTreeTile />)
    expect(await screen.findByTestId('payoff-tree-canvas')).toBeTruthy()
    const route = await screen.findByTestId('payoff-tree-route')
    // Transcript path 2100: no KO, KI hit, terminal worst-of 0.2668.
    expect(route.textContent).toContain('Path #2100')
    expect(route.textContent).toMatch(/→ P0[1-8]/)
    // The default trade has no call strike, so P05 cannot be reached.
    expect(screen.getByText(/P05 unreachable/)).toBeTruthy()
  })

  it('re-requests the selected path record when the shared path changes', async () => {
    const recorder = installRigaTranscript()
    render(<RigaPayoffTreeTile />)
    expect(await screen.findByTestId('payoff-tree-route')).toBeTruthy()
    act(() => useRigaSelectionStore.getState().selectPath(1))
    await waitFor(() => {
      const call = recorder.calls.find(
        (entry) => entry.tool === 'get_path' && (entry.args as { pathId?: number }).pathId === 1,
      )
      expect(call).toBeTruthy()
    })
  })
})

describe('place detail tile', () => {
  it('asks for a place until one is selected', () => {
    render(<RigaPlaceDetailTile />)
    expect(screen.getByText('Select a place in the net')).toBeTruthy()
  })

  it('shows the arcs and incident transitions of the selected place', async () => {
    useRigaSelectionStore.setState({ selectedPlaceId: 'put' })
    render(<RigaPlaceDetailTile />)
    expect(await screen.findByText('Incoming arcs (transition → place)')).toBeTruthy()
    expect(screen.getByText('Outgoing arcs (place → transition)')).toBeTruthy()
    // `put` is produced by down_and_in_put and consumed by the aggregate.
    expect(screen.getAllByText('Down And In Put').length).toBeGreaterThan(0)
    expect(screen.getByText('Tokens')).toBeTruthy()
  })

  it('marks frontend-only places as structure only', async () => {
    useRigaSelectionStore.setState({ selectedPlaceId: 'coupon' })
    render(<RigaPlaceDetailTile />)
    expect(await screen.findByText('reference')).toBeTruthy()
    expect(screen.getByText(/union of the execution topology/)).toBeTruthy()
  })
})
