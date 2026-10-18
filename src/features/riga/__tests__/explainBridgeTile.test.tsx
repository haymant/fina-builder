// P3f — Master Explain Waterfall (frontend-only; the demo bridge is exactly the
// `valuation_explain` payload riga already returns).

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RigaMasterExplainWaterfallTile } from '../components/RigaAnalyticsTiles'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

beforeEach(() => {
  installRigaTranscript()
})
afterEach(() => {
  resetTranscripts()
})

describe('riga master explain waterfall tile', () => {
  it('renders the base → current bridge', async () => {
    render(<RigaMasterExplainWaterfallTile />)
    expect(await screen.findByText('Market explain')).toBeTruthy()
    expect(screen.getByText('Base PV')).toBeTruthy()
    expect(screen.getByText('Current PV')).toBeTruthy()
    expect(screen.getByText('Residual')).toBeTruthy()
  })
})
