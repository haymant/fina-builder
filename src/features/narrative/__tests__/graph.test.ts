import { describe, expect, it } from 'vitest'
import { buildGraphOption, relationshipName } from '../graph'
import type { NipNarrativeGraph } from '../types'

const graph: NipNarrativeGraph = {
  graph_id: 'graph-1',
  derivation_run_id: 'graph-run-1',
  algorithm_version: 'nip-graph-v1',
  created_at: '2026-11-18T01:00:00Z',
  nodes: [
    {
      node_id: 'narrative:cluster-1',
      node_type: 'narrative',
      label: 'Nvidia Blow-up Beneficiaries',
      evidence_event_ids: ['event-1', 'event-2'],
    },
    {
      node_id: 'event:event-1',
      node_type: 'event',
      label: 'Nvidia Blow-up Beneficiaries',
      evidence_event_ids: ['event-1'],
    },
    {
      node_id: 'claim:claim-1',
      node_type: 'claim',
      label: 'Retail flows amplified the move.',
      evidence_event_ids: ['event-2'],
    },
    {
      node_id: 'event:event-3',
      node_type: 'event',
      label: 'An unrelated retained document',
      evidence_event_ids: ['event-3'],
    },
  ],
  edges: [
    {
      edge_id: 'edge:membership-1',
      from_node_id: 'narrative:cluster-1',
      to_node_id: 'event:event-1',
      edge_type: 'narrative_membership',
      evidence_event_ids: ['event-1'],
      confidence_millis: 1000,
      derivation_run_id: 'graph-run-1',
    },
    {
      edge_id: 'edge:claim-1',
      from_node_id: 'claim:claim-1',
      to_node_id: 'event:event-2',
      edge_type: 'claim_support',
      evidence_event_ids: ['event-2'],
      confidence_millis: 920,
      derivation_run_id: 'graph-run-1',
    },
  ],
}

function series(option: ReturnType<typeof buildGraphOption>) {
  return option.series[0] as unknown as {
    data: Array<{ id: string; name: string; category: number; symbolSize: number }>
    links: Array<{ label: { show: boolean }; relationship: string }>
    categories: Array<{ name: string; itemStyle: { color: string } }>
    label: { show: boolean; color: string; textBorderWidth: number; fontSize: number }
    edgeLabel: { show: boolean; color: string; textBorderWidth: number }
    roam: boolean
    draggable: boolean
  }
}

describe('buildGraphOption', () => {
  it('labels nodes and links from the projection instead of raw ids', () => {
    const option = buildGraphOption(graph, { showNodeLabels: true, showEdgeLabels: false, colorByCluster: false })
    const { data, links, label } = series(option)
    expect(label.show).toBe(true)
    // Truncated for the canvas, never the raw id.
    expect(data.find((node) => node.id === 'event:event-1')?.name).toBe('Nvidia Blow-up Benefi…')
    expect(links.map((link) => link.relationship)).toEqual(['narrative membership', 'claim support'])
    // Edge labels stay quiet by default; hovering still names the relation.
    expect(links.every((link) => link.label.show === false)).toBe(true)
  })

  it('shows every edge label only when asked', () => {
    const option = buildGraphOption(graph, { showNodeLabels: false, showEdgeLabels: true, colorByCluster: true })
    const { links, label } = series(option)
    expect(label.show).toBe(false)
    expect(links.every((link) => link.label.show === true)).toBe(true)
  })

  it('gives every cluster its own colour and lets members inherit it', () => {
    const option = buildGraphOption(graph, { showNodeLabels: true, showEdgeLabels: false, colorByCluster: true })
    const { data, categories } = series(option)
    const cluster = data.find((node) => node.id === 'narrative:cluster-1')!
    const member = data.find((node) => node.id === 'event:event-1')!
    const outsider = data.find((node) => node.id === 'event:event-3')!
    expect(member.category).toBe(cluster.category)
    expect(outsider.category).not.toBe(cluster.category)
    expect(categories[cluster.category].name).toBe(data.find((node) => node.id === 'narrative:cluster-1')?.name)
    expect(categories[cluster.category].itemStyle.color).toMatch(/^#/)
  })

  it('colours by node kind when cluster colouring is off', () => {
    const option = buildGraphOption(graph, { showNodeLabels: true, showEdgeLabels: false, colorByCluster: false })
    const { data, categories } = series(option)
    expect(categories.map((category) => category.name)).toEqual([
      'Retained events',
      'Claims',
      'Narrative clusters',
    ])
    expect(data.find((node) => node.id === 'claim:claim-1')?.category).toBe(1)
    expect(data.find((node) => node.id === 'event:event-3')?.category).toBe(0)
  })

  it('keeps the map interactive: zoom, pan and node dragging', () => {
    const option = buildGraphOption(graph, { showNodeLabels: true, showEdgeLabels: false, colorByCluster: true })
    const graphSeries = series(option)
    expect(graphSeries.roam).toBe(true)
    expect(graphSeries.draggable).toBe(true)
    // Size by degree so a hub reads as a hub.
    const narrative = graphSeries.data.find((node) => node.id === 'narrative:cluster-1')!
    const leaf = graphSeries.data.find((node) => node.id === 'event:event-3')!
    expect(narrative.symbolSize).toBeGreaterThan(leaf.symbolSize)
  })

  it('draws labels in the theme colour without a halo', () => {
    const option = buildGraphOption(graph, {
      showNodeLabels: true,
      showEdgeLabels: true,
      colorByCluster: true,
      textColor: '#f4f4f5',
      mutedColor: '#a1a1aa',
      surfaceColor: '#18181b',
    })
    const { label, edgeLabel } = series(option)
    // A tiny label with a white outline was unreadable on the dark canvas and
    // painted black text over dark nodes.
    expect(label.color).toBe('#f4f4f5')
    expect(label.textBorderWidth).toBe(0)
    expect(label.fontSize).toBeGreaterThanOrEqual(11)
    expect(edgeLabel.color).toBe('#a1a1aa')
    expect(edgeLabel.textBorderWidth).toBe(0)
  })

  it('names a relation the way a reader would say it', () => {
    expect(relationshipName('narrative_membership')).toBe('narrative membership')
    expect(relationshipName('claim_support')).toBe('claim support')
  })
})
