// P3g-vi — percentile convergence tiles on the real `percentile_convergence`.

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RigaDistributionStabilityTile,
  RigaPercentileConvergenceTile,
} from '../components/RigaPercentileTiles'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

beforeEach(() => {
  installRigaTranscript()
})
afterEach(() => {
  resetTranscripts()
})

describe('riga percentile tiles', () => {
  it('percentile convergence renders the final bands', async () => {
    render(<RigaPercentileConvergenceTile />)
    expect(await screen.findByText('Final P50')).toBeTruthy()
    expect(screen.getByText('Ladder points')).toBeTruthy()
    expect(screen.getByText('Final P05')).toBeTruthy()
  })

  it('distribution stability renders', async () => {
    render(<RigaDistributionStabilityTile />)
    expect(await screen.findByText('Distribution Stability')).toBeTruthy()
  })
})
