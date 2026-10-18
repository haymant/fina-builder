// Tile card labels the engine lane so a riga-flow / tac-engine tile is never
// mistaken for another source.

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TileCard, tileLane } from '../components/TileCard'

const noop = () => {}

describe('tileLane', () => {
  it('maps catalog groups to lanes', () => {
    expect(tileLane('riga-flow')).toBe('riga-flow')
    expect(tileLane('tac-engine')).toBe('tac-engine')
    expect(tileLane('Risk Analytics')).toBe('other')
    expect(tileLane(undefined)).toBe('other')
  })
})

describe('TileCard', () => {
  it('flags an unclassified lane', () => {
    render(
      <TileCard tile={{ id: 'x', type: 'RigaRiskNet', title: 'Risk Net' }} group="Risk Analytics" onRemove={noop} onExpand={noop}>
        <div />
      </TileCard>,
    )
    expect(screen.getByText('other')).toBeTruthy()
    expect(screen.getByText(/unclassified lane/)).toBeTruthy()
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

  it('marks a tac tile as live market data', () => {
    render(
      <TileCard tile={{ id: 'z', type: 'TacBarChart', title: 'Bar Chart' }} group="tac-engine" onRemove={noop} onExpand={noop}>
        <div />
      </TileCard>,
    )
    expect(screen.getByText('tac-engine')).toBeTruthy()
    expect(screen.getByText(/live market data/)).toBeTruthy()
  })

  it('renders its children', () => {
    render(
      <TileCard tile={{ id: 'y', type: 'RigaRiskNet', title: 'Risk Net' }} group="riga-flow" onRemove={noop} onExpand={noop}>
        <div>live content</div>
      </TileCard>,
    )
    expect(screen.getByText('live content')).toBeTruthy()
  })
})
