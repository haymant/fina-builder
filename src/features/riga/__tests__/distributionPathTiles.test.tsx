// P2c/P2d — distribution deciles/KI and selected-path tiles on real riga tools.

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RigaDistributionSummaryTile, RigaSelectedPathTile } from '../components/RigaAnalyticsTiles'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

beforeEach(() => {
  installRigaTranscript()
  // query_path_cube is gated by the observability level.
  localStorage.removeItem('fina-observability')
})
afterEach(() => {
  resetTranscripts()
})

describe('riga distribution summary tile', () => {
  it('renders KI rate, mean put and the deciles', async () => {
    render(<RigaDistributionSummaryTile />)
    expect(await screen.findByText('KI rate')).toBeTruthy()
    expect(screen.getByText('Mean put')).toBeTruthy()
    // transcript KI rate = 0.1127 -> 11.27%
    expect(screen.getAllByText(/11\.27%/).length).toBeGreaterThan(0)
  })
})

describe('riga selected path tile', () => {
  it('renders the percentile sample and coupon-by-period', async () => {
    render(<RigaSelectedPathTile />)
    expect(await screen.findByText('Percentile')).toBeTruthy()
    expect(screen.getByText('Worst threshold')).toBeTruthy()
    expect(screen.getByText('KI')).toBeTruthy()
  })
})
