// Net graph assembly (§5.2): the tile draws the engine's canonical execution
// workflow (fixed structure from the graph runtime) with the live
// `query_execution_net` overlay, and selection marks nodes.

import { describe, expect, it } from 'vitest'
import { buildNetGraph } from '../components/PetriNetTiles'
import { WORKFLOW_TRANSITIONS } from '../data/netLayout'
import { toCamelKeys } from '../../../api/keyCase'
import { RIGA_TRANSCRIPT } from '../../../tests/mocks/transcripts'
import type { ExecutionNet, RiskNet } from '../types'

const net = toCamelKeys(RIGA_TRANSCRIPT.tools.query_execution_net) as unknown as ExecutionNet

describe('buildNetGraph (workflow topology + live overlay)', () => {
  it('renders every workflow transition and place', () => {
    const { nodes } = buildNetGraph(net, 'execution', { transitionId: null, placeId: null })
    const transitionNodes = nodes.filter((node) => node.id.startsWith('transition:'))
    const placeNodes = nodes.filter((node) => node.id.startsWith('place:'))
    expect(transitionNodes).toHaveLength(WORKFLOW_TRANSITIONS.length)
    const placeIds = new Set(['start'])
    for (const t of WORKFLOW_TRANSITIONS) {
      t.inputs.forEach((i) => placeIds.add(i))
      placeIds.add(t.output)
    }
    expect(placeNodes).toHaveLength(placeIds.size)
  })

  it('every edge anchors to existing nodes and every node is a sized custom node', () => {
    const { nodes, edges } = buildNetGraph(net, 'execution', { transitionId: null, placeId: null })
    const ids = new Set(nodes.map((node) => node.id))
    for (const node of nodes) {
      expect(node.type).toBe('rigaNet')
      expect(node.style?.width).toBeGreaterThan(0)
      expect(node.style?.height).toBeGreaterThan(0)
    }
    for (const edge of edges) {
      expect(ids.has(edge.source), `missing source ${edge.source}`).toBe(true)
      expect(ids.has(edge.target), `missing target ${edge.target}`).toBe(true)
    }
  })

  it('overlays the live ledger transitions onto the workflow stages', () => {
    const { nodes } = buildNetGraph(net, 'execution', { transitionId: null, placeId: null })
    const koGate = nodes.find((n) => n.id === 'transition:global_ko_gate')
    const put = nodes.find((n) => n.id === 'transition:down_and_in_put')
    // daily_global_ko → global_ko_gate, final_fixing_eki → down_and_in_put.
    expect(koGate?.data.probability).toBeCloseTo(0.5311333333333333, 6)
    expect(put?.data.pvImpact).toBeCloseTo(-0.0203289353821023, 6)
    // The live `start` place (path count) lands on the source mark.
    expect(nodes.find((n) => n.id === 'place:start')?.data.tokens).toBe(30000)
    expect(nodes.find((n) => n.id === 'place:ko_period')?.data.tokens).toBe(15934)
  })

  it('lays the workflow out left→right with no overlap', () => {
    const { nodes, edges } = buildNetGraph(net, 'execution', { transitionId: null, placeId: null })
    const position = new Map(nodes.map((node) => [node.id, node.position]))
    for (const edge of edges) {
      expect(position.get(edge.target)!.x, `${edge.id} must flow right`).toBeGreaterThan(position.get(edge.source)!.x)
    }
    const spots = new Set(nodes.map((node) => `${node.position.x}:${node.position.y}`))
    expect(spots.size).toBe(nodes.length)
  })

  it('marks the selected transition and place', () => {
    const { nodes } = buildNetGraph(net, 'explain', { transitionId: 'down_and_in_put', placeId: 'worst' })
    expect(nodes.find((n) => n.id === 'transition:down_and_in_put')?.data.selected).toBe(true)
    expect(nodes.find((n) => n.id === 'place:worst')?.data.selected).toBe(true)
  })

  it('tints transitions by risk in risk mode', () => {
    const risk = toCamelKeys(RIGA_TRANSCRIPT.tools.query_risk_net) as unknown as RiskNet
    const { nodes } = buildNetGraph(net, 'risk', { transitionId: null, placeId: null }, risk)
    const put = nodes.find((n) => n.id === 'transition:down_and_in_put')
    expect(put?.data.deltaImpact).toBeDefined()
  })
})
