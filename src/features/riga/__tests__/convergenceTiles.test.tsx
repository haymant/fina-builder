// P3a-UI — Monte-Carlo convergence tiles on the real `mc_convergence` series.

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  RigaCiShrinkageTile,
  RigaConvergenceHealthTile,
  RigaErrorVsPathsTile,
  RigaKiConvergenceTile,
  RigaKoConvergenceTile,
  RigaPvConvergenceTile,
} from '../components/RigaConvergenceTiles'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

beforeEach(() => {
  installRigaTranscript()
})
afterEach(() => {
  resetTranscripts()
})

describe('riga convergence tiles', () => {
  it('PV convergence renders against the ladder', async () => {
    render(<RigaPvConvergenceTile />)
    expect(await screen.findByText('PV Convergence')).toBeTruthy()
  })

  it('CI shrinkage / error-vs-N / KI / KO render', async () => {
    render(<RigaCiShrinkageTile />)
    expect(await screen.findByText('CI Shrinkage')).toBeTruthy()

    render(<RigaErrorVsPathsTile />)
    expect(await screen.findByText('Error vs Path Count')).toBeTruthy()

    render(<RigaKiConvergenceTile />)
    expect(await screen.findByText('KI Probability Convergence')).toBeTruthy()

    render(<RigaKoConvergenceTile />)
    expect(await screen.findByText('KO Probability Convergence')).toBeTruthy()
  })

  it('convergence health renders the final estimator and the ladder', async () => {
    render(<RigaConvergenceHealthTile />)
    expect(await screen.findByText('Relative SE')).toBeTruthy()
    expect(screen.getByText('SE decreasing')).toBeTruthy()
    expect(screen.getByText('Ladder')).toBeTruthy()
    expect(screen.getAllByText('30,000').length).toBeGreaterThan(0)
  })
})
