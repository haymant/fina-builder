// P3g-iv / P3g-v — branch flow (Sankey) + market explorers (frontend-only).

import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RigaBranchFlowTile } from '../components/RigaBranchFlowTile'
import { RigaMarketExplorerTile, RigaVolSurfaceTile } from '../components/RigaMarketExplorerTiles'
import { useInstrumentStore } from '../../../store/instrumentStore'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

beforeEach(() => {
  installRigaTranscript()
  localStorage.removeItem('fina-instrument')
  useInstrumentStore.getState().reset()
})
afterEach(() => {
  resetTranscripts()
})

describe('riga branch flow tile', () => {
  it('renders the transition populations', async () => {
    render(<RigaBranchFlowTile />)
    expect(await screen.findByText('Paths')).toBeTruthy()
    expect(screen.getByText('KO')).toBeTruthy()
    expect(screen.getByText('Put')).toBeTruthy()
    expect(screen.getByText('Coupon')).toBeTruthy()
  })
})

describe('riga market explorer tiles', () => {
  it('renders spots, vols and correlation from get_market', async () => {
    render(<RigaMarketExplorerTile />)
    expect(await screen.findByText('Marks')).toBeTruthy()
    expect(screen.getByText('Correlation')).toBeTruthy()
    expect(screen.getByText('Market id')).toBeTruthy()
  })

  it('vol surface shows the empty state for a manual document', () => {
    render(<RigaVolSurfaceTile />)
    expect(screen.getByText('Vol Surface')).toBeTruthy()
  })
})
