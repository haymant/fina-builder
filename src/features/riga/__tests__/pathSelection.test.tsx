// Shared simulation-path selection (docs/49 P3g): one store drives the stepper
// and every path-dependent tile. These tests pin the store contract and the
// cross-tile wiring, not the chart internals.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PathStepper } from '../components/PathStepper'
import { RigaExecutionTapeTile } from '../components/RigaAnalyticsTiles'
import { RigaBranchFlowTile } from '../components/RigaBranchFlowTile'
import { RigaPathTimelineTile } from '../components/RigaPathSeriesTiles'
import { RigaSelectedPathDetailTile } from '../components/RigaSelectedPathTiles'
import { useInstrumentStore } from '../../../store/instrumentStore'
import { PATH_CUBE_CAP, useRigaSelectionStore } from '../../../store/rigaSelectionStore'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

beforeEach(() => {
  installRigaTranscript()
  localStorage.removeItem('fina-instrument')
  localStorage.removeItem('fina-observability')
  useInstrumentStore.getState().reset()
  useRigaSelectionStore.setState({ selectedPathId: 0, pathCount: 0, cachedPath: null, selectedObservation: null })
})
afterEach(() => {
  resetTranscripts()
})

describe('path selection store', () => {
  it('clamps, wraps and caps navigation to the bounded cube', () => {
    const store = useRigaSelectionStore.getState()
    store.setPathCount(10)
    store.selectPath(42)
    expect(useRigaSelectionStore.getState().selectedPathId).toBe(9)
    store.selectPath(-3)
    expect(useRigaSelectionStore.getState().selectedPathId).toBe(0)
    store.stepPath(-1)
    expect(useRigaSelectionStore.getState().selectedPathId).toBe(9)
    store.stepPath(1)
    expect(useRigaSelectionStore.getState().selectedPathId).toBe(0)
    store.setPathCount(50_000)
    expect(useRigaSelectionStore.getState().pathCount).toBe(PATH_CUBE_CAP)
  })

  it('pins a fixing step and clears it when the path changes', () => {
    const store = useRigaSelectionStore.getState()
    store.setPathCount(10)
    store.selectObservation(3, 7)
    expect(useRigaSelectionStore.getState().selectedObservation).toEqual({ pathId: 3, step: 7 })
    store.selectPath(4)
    expect(useRigaSelectionStore.getState().selectedObservation).toBeNull()
    store.selectObservation(4, 2)
    store.stepPath(1)
    expect(useRigaSelectionStore.getState().selectedObservation).toBeNull()
    store.selectObservation(5, 1)
    store.randomPath()
    expect(useRigaSelectionStore.getState().selectedObservation).toBeNull()
  })
})

describe('path stepper', () => {
  it('publishes the cube size and steps the shared selection', async () => {
    render(<PathStepper />)
    // path_series reports 1,024 paths in the bounded cube.
    expect(await screen.findByText('/ 1,024')).toBeTruthy()
    expect(useRigaSelectionStore.getState().pathCount).toBe(1024)

    fireEvent.click(screen.getByLabelText('Next path'))
    expect(useRigaSelectionStore.getState().selectedPathId).toBe(1)
    fireEvent.click(screen.getByLabelText('Previous path'))
    fireEvent.click(screen.getByLabelText('Previous path'))
    // Wraps backwards from 0 to the last cube index.
    expect(useRigaSelectionStore.getState().selectedPathId).toBe(1023)

    // The number is a spinbutton: the arrows step the shared selection.
    fireEvent.keyDown(screen.getByRole('spinbutton'), { key: 'ArrowRight' })
    expect(useRigaSelectionStore.getState().selectedPathId).toBe(0)
    fireEvent.keyDown(screen.getByRole('spinbutton'), { key: 'ArrowLeft', shiftKey: true })
    expect(useRigaSelectionStore.getState().selectedPathId).toBe(1014)
  })
})

describe('path-dependent tiles follow the shared selection', () => {
  it('path timeline re-requests path_series for the new index', async () => {
    const recorder = installRigaTranscript()
    render(<RigaPathTimelineTile />)
    expect(await screen.findByText('Selected')).toBeTruthy()
    act(() => useRigaSelectionStore.getState().selectPath(0))
    act(() => useRigaSelectionStore.getState().selectPath(7))
    await waitFor(() => {
      const call = recorder.calls.find((entry) => entry.tool === 'path_series' && (entry.args as { path_id?: number }).path_id === 7)
      expect(call).toBeTruthy()
    })
  })

  it('selected path detail renders the get_path record', async () => {
    const recorder = installRigaTranscript()
    render(<RigaSelectedPathDetailTile />)
    // The transcript records path 2100 with a KI hit and no KO.
    expect(await screen.findByText('#2100')).toBeTruthy()
    expect(screen.getByText('Worst final')).toBeTruthy()
    expect(screen.getByText('Coupon PV')).toBeTruthy()
    expect(screen.getByTestId('selected-path-outcome').textContent).toContain('knock-in hit')
    // The engine's `path_id` is a usize: send a number, not a string.
    const call = recorder.calls.find((entry) => entry.tool === 'get_path')
    expect(typeof (call?.args as { pathId?: unknown } | undefined)?.pathId).toBe('number')
  })

  it('branch flow highlights the selected path branch', async () => {
    useRigaSelectionStore.setState({ selectedPathId: 3 })
    render(<RigaBranchFlowTile />)
    const caption = await screen.findByTestId('branch-flow-selected')
    expect(caption.textContent).toContain('Selected path #2100')
    expect(caption.textContent).toContain('KI branch')
  })

  it('execution tape row click selects that path', async () => {
    render(<RigaExecutionTapeTile />)
    fireEvent.click(await screen.findByTestId('tape-path-1'))
    expect(useRigaSelectionStore.getState().selectedPathId).toBe(1)
  })
})
