// Guards against the "stuck at loading" regression: with a resolving
// transport, the hook must leave the loading state and render the canvas.

import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PayoffPetriNetTile, RiskNetTile } from '../components/PetriNetTiles'
import { RigaGovernanceEvidenceTile, RigaStatisticsSummaryTile } from '../components/RigaAnalyticsTiles'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'
import { useObservabilityStore } from '../../../store/observabilityStore'

beforeEach(() => {
  vi.useFakeTimers()
  installRigaTranscript()
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

describe('riga tiles resolve out of loading', () => {
  it('PayoffPetriNetTile renders the net canvas', async () => {
    render(<PayoffPetriNetTile />)
    await settle()
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByTestId('riga-net-canvas')).toBeInTheDocument()
  })

  it('RiskNetTile renders the net canvas and per-asset table', async () => {
    render(<RiskNetTile />)
    await settle()
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByTestId('riga-net-canvas')).toBeInTheDocument()
    expect(screen.getByText('DV01')).toBeInTheDocument()
  })

  it('RigaStatisticsSummaryTile leaves the loader', async () => {
    render(<RigaStatisticsSummaryTile />)
    await settle()
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByText('Transition stats')).toBeInTheDocument()
  })

  it('governance tile tolerates the flat sampled_paths shape', async () => {
    useObservabilityStore.getState().setLevel('full')
    render(<RigaGovernanceEvidenceTile />)
    await settle()
    expect(screen.queryByText('Loading…')).toBeNull()
    expect(screen.getByText('Sampled paths')).toBeInTheDocument()
    // The flat `path_id` is read without throwing (identity may be absent).
    expect(screen.getAllByText('0').length).toBeGreaterThan(0)
  })
})
