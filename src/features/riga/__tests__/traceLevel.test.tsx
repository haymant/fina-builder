// Trace-level gating (§10, §14.1): at Off the path UI is absent and its tools
// are not called; at Sampled it is present and bounded.

import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RigaExecutionTapeTile, RigaPathCubeTile } from '../components/RigaAnalyticsTiles'
import { TokenDetailTile } from '../components/PetriNetTiles'
import { useObservabilityStore } from '../../../store/observabilityStore'
import { useRigaSelectionStore } from '../../../store/rigaSelectionStore'
import { installRigaTranscript, resetTranscripts, type CallRecorder } from '../../../tests/mocks/transcripts'

let recorder: CallRecorder

beforeEach(() => {
  vi.useFakeTimers()
  recorder = installRigaTranscript()
})
afterEach(() => {
  resetTranscripts()
  vi.useRealTimers()
})

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200)
  })
}

function calls(tool: string): number {
  return recorder.calls.filter((call) => call.tool === tool).length
}

describe('trace-level gating', () => {
  it('Off: shows aggregate-only empty states and calls no path tools', async () => {
    useObservabilityStore.getState().setLevel('off')
    useRigaSelectionStore.setState({ selectedPlaceId: 'worst' })
    render(
      <>
        <RigaExecutionTapeTile />
        <RigaPathCubeTile />
        <TokenDetailTile />
      </>,
    )
    await settle()
    expect(screen.getAllByText(/trace off — aggregate only\./).length).toBeGreaterThanOrEqual(2)
    expect(calls('execution_events')).toBe(0)
    expect(calls('query_path_cube')).toBe(0)
  })

  it('Sampled: calls the path tools and shows the tape', async () => {
    useObservabilityStore.getState().setLevel('sampled')
    render(<RigaExecutionTapeTile />)
    await settle()
    expect(calls('execution_events')).toBeGreaterThan(0)
    expect(screen.getByText('Execution Tape')).toBeInTheDocument()
    expect(screen.getByText('Tape size')).toBeInTheDocument()
  })
})
