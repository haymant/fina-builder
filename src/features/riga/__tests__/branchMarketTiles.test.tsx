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
  it('renders the Phoenix decision-tree populations', async () => {
    render(<RigaBranchFlowTile />)
    expect(await screen.findByText('Paths')).toBeTruthy()
    // The KO branch resolves to a P0x id for the current trade.
    expect(screen.getByText(/^KO/)).toBeTruthy()
    expect(screen.getByText('Survive')).toBeTruthy()
    expect(screen.getByText('KI (P07)')).toBeTruthy()
    expect(screen.getByText('No KI (P08)')).toBeTruthy()
    // The coupon leg is additive on every branch, so it is a note, not a flow.
    expect(screen.getByText(/Coupon leg/)).toBeTruthy()
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
