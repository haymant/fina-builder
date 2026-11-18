// P3g-i — path-series tiles on the real bounded-cube `path_series`.

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RigaBarrierHeatmapTile,
  RigaPathTimelineTile,
  RigaQuantileFanTile,
  RigaStateOccupancyTile,
  RigaWorstOfEvolutionTile,
} from '../components/RigaPathSeriesTiles'
import { useRigaSelectionStore } from '../../../store/rigaSelectionStore'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

beforeEach(() => {
  installRigaTranscript()
  useRigaSelectionStore.setState({ selectedPathId: 0, pathCount: 1024, cachedPath: null, selectedObservation: null })
})
afterEach(() => {
  resetTranscripts()
})

describe('riga path-series tiles', () => {
  it('path timeline renders the selected-path KPIs', async () => {
    render(<RigaPathTimelineTile />)
    expect(await screen.findByText('Selected')).toBeTruthy()
    expect(screen.getByText('Paths')).toBeTruthy()
    expect(screen.getByText('Steps')).toBeTruthy()
  })

  it('quantile fan / worst-of / crossings / occupancy render', async () => {
    render(<RigaQuantileFanTile />)
    expect(await screen.findByText('Quantile Fan')).toBeTruthy()
    render(<RigaWorstOfEvolutionTile />)
    expect(await screen.findByText('Worst-of Evolution')).toBeTruthy()
    render(<RigaBarrierHeatmapTile />)
    expect(await screen.findByText('Barrier Crossings')).toBeTruthy()
    render(<RigaStateOccupancyTile />)
    expect(await screen.findByText('State Occupancy')).toBeTruthy()
  })

  it('shows the fixing-step detail for the selected observation', async () => {
    useRigaSelectionStore.setState({ selectedPathId: 0, selectedObservation: { pathId: 0, step: 3 } })
    render(<RigaPathTimelineTile />)
    const strip = await screen.findByTestId('path-observation')
    expect(strip.textContent).toContain('Step')
    expect(strip.textContent).toContain('Worst-of')
    expect(strip.textContent).toMatch(/above KI|below KI/)
  })
})
