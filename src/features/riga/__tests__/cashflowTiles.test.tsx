// P2a — cashflow tiles sourced from the real `build_cashflows` tool.

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RigaCashflowSummaryTile, RigaCashflowTimelineTile } from '../components/RigaCashflowTiles'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

beforeEach(() => {
  installRigaTranscript()
})
afterEach(() => {
  resetTranscripts()
})

describe('riga cashflow tiles', () => {
  it('summary renders the mean per-leg PV and the sampled paths', async () => {
    render(<RigaCashflowSummaryTile />)
    expect(await screen.findByText('Mean coupon PV')).toBeTruthy()
    expect(screen.getByText('Mean put payoff')).toBeTruthy()
    expect(screen.getByText('Sampled paths')).toBeTruthy()
    // sample path #0 from the transcript
    expect(screen.getByText('#0')).toBeTruthy()
  })

  it('timeline renders coupon PV by period', async () => {
    render(<RigaCashflowTimelineTile />)
    // legend + table header both carry the series name
    expect((await screen.findAllByText('Expected coupon PV')).length).toBeGreaterThan(0)
    expect(screen.getByText('Paid prob')).toBeTruthy()
  })
})
