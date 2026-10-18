// P3c — detailed-risk tiles on the real `risk_detailed`.

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RigaBucketVegaTile,
  RigaGreeksTableTile,
  RigaGreeksWaterfallTile,
} from '../components/RigaRiskDetailTiles'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

beforeEach(() => {
  installRigaTranscript()
})
afterEach(() => {
  resetTranscripts()
})

describe('riga detailed-risk tiles', () => {
  it('greeks table renders theta/rho and per-asset greeks', async () => {
    render(<RigaGreeksTableTile />)
    expect(await screen.findByText('Theta (1d)')).toBeTruthy()
    expect(screen.getByText('Rho / DV01')).toBeTruthy()
    expect(screen.getByText('FX delta')).toBeTruthy()
    expect(screen.getByText('Cross-gamma')).toBeTruthy()
  })

  it('greeks waterfall and bucket vega render', async () => {
    render(<RigaGreeksWaterfallTile />)
    expect(await screen.findByText('Greeks Waterfall')).toBeTruthy()

    render(<RigaBucketVegaTile />)
    expect(await screen.findByText('Bucket Vega')).toBeTruthy()
  })
})
