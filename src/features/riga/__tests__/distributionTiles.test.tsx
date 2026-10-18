// P3b — distribution tiles on the real `distributions_histogram`.

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RigaDistributionExplorerTile, RigaPayoffHistogramTile } from '../components/RigaDistributionTiles'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

beforeEach(() => {
  installRigaTranscript()
})
afterEach(() => {
  resetTranscripts()
})

describe('riga distribution tiles', () => {
  it('payoff histogram renders PV percentiles', async () => {
    render(<RigaPayoffHistogramTile />)
    expect(await screen.findByText('Median')).toBeTruthy()
    expect(screen.getByText('P05')).toBeTruthy()
    expect(screen.getByText('P95')).toBeTruthy()
  })

  it('distribution explorer renders the metric comparison', async () => {
    render(<RigaDistributionExplorerTile />)
    expect(await screen.findByText('Std dev')).toBeTruthy()
    // metrics from the transcript
    expect(screen.getByText('worst_final')).toBeTruthy()
    expect(screen.getByText('put_payoff')).toBeTruthy()
  })
})
