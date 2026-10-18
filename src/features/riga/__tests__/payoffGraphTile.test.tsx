// P3g-ii — payoff graph tile (the full product graph carried by query_execution_net).

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RigaPayoffGraphTile } from '../components/RigaPayoffGraphTile'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

beforeEach(() => {
  installRigaTranscript()
})
afterEach(() => {
  resetTranscripts()
})

describe('riga payoff graph tile', () => {
  it('renders the full product pipeline (superset of the execution net)', async () => {
    render(<RigaPayoffGraphTile />)
    expect(await screen.findByText('Nodes')).toBeTruthy()
    expect(screen.getByText('Execution transitions')).toBeTruthy()
    // pipeline rows from the transcript
    expect(screen.getByText('down_and_in_put')).toBeTruthy()
    expect(screen.getByText('worst_of_performance')).toBeTruthy()
  })
})
