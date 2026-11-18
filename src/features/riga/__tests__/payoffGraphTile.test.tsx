// P3g-ii — payoff graph tile (the full product graph carried by query_execution_net).

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RigaPayoffGraphTile } from '../components/RigaPayoffGraphTile'
import { layoutPayoffGraph, PRODUCT_TO_WORKFLOW } from '../data/netLayout'
import { useRigaSelectionStore } from '../../../store/rigaSelectionStore'
import { installRigaTranscript, resetTranscripts } from '../../../tests/mocks/transcripts'

// The product graph exactly as the engine returns it (input → transition → output).
const TRANSCRIPT_GRAPH = [
  { id: 'worst_of_performance', inputs: ['perf0', 'perf1'], output: 'worst' },
  { id: 'range_accrual', inputs: ['worst'], output: 'coupon_mask' },
  { id: 'global_ko_gate', inputs: ['worst'], output: 'ko_period' },
  { id: 'knock_in_gate', inputs: ['worst'], output: 'ki_flag' },
  { id: 'down_and_in_put', inputs: ['worst', 'ki_flag'], output: 'put' },
  { id: 'aggregate_legs', inputs: ['put'], output: 'put_pv' },
  { id: 'memory_carry', inputs: ['coupon_mask', 'ko_period'], output: 'coupon_pv' },
  { id: 'aggregate_coupon', inputs: ['coupon_pv'], output: 'coupon_pv_mean' },
]

beforeEach(() => {
  installRigaTranscript()
  useRigaSelectionStore.setState({ selectedTransitionId: null, selectedPlaceId: null })
})
afterEach(() => {
  resetTranscripts()
})

describe('payoff graph layout', () => {
  it('ranks every place after its producing transition', () => {
    const { nodes, edges } = layoutPayoffGraph(TRANSCRIPT_GRAPH)
    const xOf = (kind: 'place' | 'transition', id: string) =>
      nodes.find((node) => node.kind === kind && node.id === id)?.position.x ?? Number.NaN
    // Every arc alternates place → transition → place, and both endpoints exist.
    // (Regression: prefixing every arc as `place:from → transition:to` silently
    // dropped all eight transition→place arcs in the graph view.)
    for (const edge of edges) {
      expect(edge.fromKind).not.toBe(edge.toKind)
      expect(xOf(edge.fromKind, edge.from)).not.toBeNaN()
      expect(xOf(edge.toKind, edge.to)).not.toBeNaN()
      expect(xOf(edge.toKind, edge.to)).toBeGreaterThan(xOf(edge.fromKind, edge.from))
    }
    // 8 transitions + every distinct place is laid out exactly once.
    expect(nodes.filter((node) => node.kind === 'transition')).toHaveLength(8)
    expect(nodes.filter((node) => node.kind === 'place')).toHaveLength(10)
  })
})

describe('riga payoff graph tile', () => {
  it('renders the pipeline input → transition → output', async () => {
    render(<RigaPayoffGraphTile />)
    expect(await screen.findByText('Nodes')).toBeTruthy()
    expect(screen.getByText('Execution transitions')).toBeTruthy()
    // Column order follows the net: inputs first, then the transition, then its output.
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent)
    expect(headers).toEqual(['Inputs', 'Transition', 'Output'])
    expect(screen.getByText('Down And In Put')).toBeTruthy()
    expect(screen.getByText('Worst Of Performance')).toBeTruthy()
  })

  it('clicking a row selects the transition and the place it produces', async () => {
    render(<RigaPayoffGraphTile />)
    fireEvent.click(await screen.findByTestId('payoff-row-down_and_in_put'))
    expect(useRigaSelectionStore.getState().selectedTransitionId).toBe('down_and_in_put')
    expect(useRigaSelectionStore.getState().selectedPlaceId).toBe('put')
    // `aggregate_legs` is the product id for the workflow's `aggregate_put`.
    fireEvent.click(screen.getByTestId('payoff-row-aggregate_legs'))
    expect(useRigaSelectionStore.getState().selectedTransitionId).toBe(PRODUCT_TO_WORKFLOW.aggregate_legs)
    expect(useRigaSelectionStore.getState().selectedPlaceId).toBe('put_pv')
  })

  it('clicking a place chip selects that place without changing the transition', async () => {
    render(<RigaPayoffGraphTile />)
    fireEvent.click(await screen.findByTestId('payoff-row-down_and_in_put'))
    fireEvent.click(screen.getAllByTestId('payoff-place-ki_flag')[0]!)
    expect(useRigaSelectionStore.getState().selectedPlaceId).toBe('ki_flag')
    expect(useRigaSelectionStore.getState().selectedTransitionId).toBe('down_and_in_put')
  })

  it('switches to the graph view', async () => {
    render(<RigaPayoffGraphTile />)
    fireEvent.click(await screen.findByTestId('payoff-graph-view-graph'))
    expect(screen.getByTestId('payoff-graph-canvas')).toBeTruthy()
    // Back to the table.
    fireEvent.click(screen.getByText('Table'))
    expect(screen.getByText('Down And In Put')).toBeTruthy()
  })
})
