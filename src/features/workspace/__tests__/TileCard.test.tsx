// Tile card labels the engine lane so a demo tile is never mistaken for
// riga-flow / tac-engine output.

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TileCard, tileLane } from '../components/TileCard'

const noop = () => {}

describe('tileLane', () => {
  it('maps catalog groups to lanes (default demo)', () => {
    expect(tileLane('riga-flow')).toBe('riga-flow')
    expect(tileLane('tac-engine')).toBe('tac-engine')
    expect(tileLane('Risk Analytics')).toBe('demo')
    expect(tileLane('Monte Carlo Diagnostics')).toBe('demo')
    expect(tileLane(undefined)).toBe('demo')
  })
})

describe('TileCard', () => {
  it('marks a demo tile as illustrative, not priced', () => {
    render(
      <TileCard tile={{ id: 'x', type: 'Sankey', title: 'Branch Statistics' }} group="Risk Analytics" onRemove={noop} onExpand={noop}>
        <div />
      </TileCard>,
    )
    expect(screen.getByText('demo')).toBeTruthy()
    expect(screen.getByText(/illustrative, not priced/)).toBeTruthy()
  })

  it('marks a riga tile as live', () => {
    render(
      <TileCard tile={{ id: 'y', type: 'RigaRiskNet', title: 'Risk Net' }} group="riga-flow" onRemove={noop} onExpand={noop}>
        <div />
      </TileCard>,
    )
    expect(screen.getByText('riga-flow')).toBeTruthy()
    expect(screen.getByText(/live engine/)).toBeTruthy()
  })
})
