// The per-leg PV + per-transition PV/Δ/ν tile (explain_pv_attribution).

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RigaAttributionTile } from '../components/RigaAnalyticsTiles'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

beforeEach(() => {
  installRigaTranscript()
})
afterEach(() => {
  resetTranscripts()
})

describe('RigaAttributionTile', () => {
  it('renders PV by leg and PV/Δ/ν by transition', async () => {
    render(<RigaAttributionTile />)
    expect(await screen.findByText('PV by leg')).toBeTruthy()
    expect(screen.getByText('Down-and-in put')).toBeTruthy()
    expect(screen.getByText('Par redemption')).toBeTruthy()
    expect(screen.getByText('PV & sensitivities by transition')).toBeTruthy()
    expect(screen.getByText('Transition')).toBeTruthy()
    expect(screen.getByText('Δ')).toBeTruthy()
    expect(screen.getByText('ν')).toBeTruthy()
  })
})
