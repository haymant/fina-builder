// ECharts option for the narrative graph. Kept pure so the projection can be
// tested without a canvas: the component only owns the toggles and the click
// handler.

import type { NipNarrativeGraph, NipNarrativeGraphNode } from './types'

export interface GraphViewSettings {
  showNodeLabels: boolean
  showEdgeLabels: boolean
  colorByCluster: boolean
  /** sRGB colours: zrender cannot parse the app's oklch() tokens. */
  textColor?: string
  mutedColor?: string
  surfaceColor?: string
}

// Readable without an outline: an outlined 9px label turns into a smear at
// graph zoom levels, and a hard-coded black fails on the dark theme.
const DEFAULT_TEXT = '#e5e7eb'
const DEFAULT_MUTED = '#9aa4b2'
const DEFAULT_SURFACE = '#1f2430'

const TYPE_COLORS: Record<string, string> = {
  event: '#4f8ef7',
  claim: '#e0a63a',
  narrative: '#9a6dd7',
}
const CLUSTER_PALETTE = [
  '#4f8ef7', '#57c7a3', '#e0a63a', '#c16ae0', '#5fb0e5',
  '#e57373', '#8fa1b3', '#7bc96f', '#d4a15a', '#6b8afd',
]
const UNCLUSTERED_COLOR = '#8b98a9'

/** `narrative_membership` reads as `narrative membership`. */
export function relationshipName(edgeType: string): string {
  return edgeType.split('_').join(' ')
}

function shortLabel(label: string, max = 26): string {
  if (label.length <= max) return label
  return `${label.slice(0, max - 1).trimEnd()}…`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function buildGraphOption(graph: NipNarrativeGraph, view: GraphViewSettings) {
  const narrativeNodes = graph.nodes.filter((node) => node.node_type === 'narrative')
  const clusterOrder = new Map<string, number>()
  narrativeNodes.forEach((node, index) => clusterOrder.set(node.node_id, index))

  // Which narrative owns each origin, so cluster colouring also covers events.
  const membership = new Map<string, number>()
  for (const edge of graph.edges) {
    const cluster = clusterOrder.get(edge.from_node_id)
    if (edge.edge_type === 'narrative_membership' && cluster !== undefined) {
      membership.set(edge.to_node_id, cluster)
    }
  }

  const categories = view.colorByCluster
    ? [
        ...narrativeNodes.map((node, index) => ({
          name: shortLabel(node.label, 22),
          itemStyle: { color: CLUSTER_PALETTE[index % CLUSTER_PALETTE.length] },
        })),
        { name: 'Claims', itemStyle: { color: TYPE_COLORS.claim } },
        { name: 'Unclustered events', itemStyle: { color: UNCLUSTERED_COLOR } },
      ]
    : [
        { name: 'Retained events', itemStyle: { color: TYPE_COLORS.event } },
        { name: 'Claims', itemStyle: { color: TYPE_COLORS.claim } },
        { name: 'Narrative clusters', itemStyle: { color: TYPE_COLORS.narrative } },
      ]

  const categoryOf = (node: NipNarrativeGraphNode): number => {
    if (!view.colorByCluster) {
      if (node.node_type === 'claim') return 1
      if (node.node_type === 'narrative') return 2
      return 0
    }
    if (node.node_type === 'narrative') return clusterOrder.get(node.node_id) ?? 0
    if (node.node_type === 'claim') return narrativeNodes.length
    return membership.get(node.node_id) ?? narrativeNodes.length + 1
  }

  const degree = new Map<string, number>()
  for (const edge of graph.edges) {
    degree.set(edge.from_node_id, (degree.get(edge.from_node_id) ?? 0) + 1)
    degree.set(edge.to_node_id, (degree.get(edge.to_node_id) ?? 0) + 1)
  }

  const nodes = graph.nodes.map((node) => ({
    id: node.node_id,
    name: shortLabel(node.label, 22),
    fullLabel: node.label,
    kind: node.node_type,
    evidenceEventIds: node.evidence_event_ids,
    category: categoryOf(node),
    symbolSize: Math.min(
      44,
      18 + (degree.get(node.node_id) ?? 0) * 6 + (node.node_type === 'narrative' ? 6 : 0),
    ),
  }))

  const links = graph.edges.map((edge) => ({
    id: edge.edge_id,
    source: edge.from_node_id,
    target: edge.to_node_id,
    relationship: relationshipName(edge.edge_type),
    confidence: Math.round(edge.confidence_millis / 10),
    evidenceCount: edge.evidence_event_ids.length,
    lineStyle: { width: 1 + (edge.confidence_millis / 1000) * 1.5 },
    label: {
      show: view.showEdgeLabels,
      formatter: relationshipName(edge.edge_type),
      fontSize: 9,
    },
  }))

  const textColor = view.textColor ?? DEFAULT_TEXT
  const mutedColor = view.mutedColor ?? DEFAULT_MUTED
  const surfaceColor = view.surfaceColor ?? DEFAULT_SURFACE

  return {
    animationDuration: 350,
    tooltip: {
      trigger: 'item',
      backgroundColor: surfaceColor,
      borderWidth: 0,
      textStyle: { color: textColor, fontSize: 12 },
      formatter: (params: {
        dataType?: string
        data?: {
          fullLabel?: string
          kind?: string
          evidenceEventIds?: string[]
          relationship?: string
          confidence?: number
          evidenceCount?: number
        }
      }) => {
        const data = params.data ?? {}
        if (params.dataType === 'edge') {
          return `<strong>${escapeHtml(data.relationship ?? '')}</strong><br/>${data.confidence ?? 0}% confidence · ${plural(data.evidenceCount ?? 0, 'evidence event')}`
        }
        return `<strong>${escapeHtml(data.fullLabel ?? '')}</strong><br/>${escapeHtml(data.kind ?? 'node')} · ${plural(data.evidenceEventIds?.length ?? 0, 'evidence event')}<br/><span style="opacity:.7">click to open the retained origin</span>`
      },
    },
    legend: [
      {
        type: 'scroll',
        bottom: 0,
        data: categories.map((category) => category.name),
        textStyle: { fontSize: 10, color: mutedColor },
        pageTextStyle: { color: mutedColor },
      },
    ],
    series: [
      {
        type: 'graph',
        layout: 'force',
        roam: true,
        draggable: true,
        symbol: 'circle',
        edgeSymbol: ['none', 'arrow'],
        edgeSymbolSize: 6,
        categories,
        data: nodes,
        links,
        top: 16,
        bottom: 44,
        left: 16,
        right: 16,
        label: {
          show: view.showNodeLabels,
          position: 'right',
          color: textColor,
          fontSize: 11,
          fontWeight: 500,
          // No white halo: on a dense canvas the outline is what made the
          // label unreadable, and it fights the theme in dark mode.
          textBorderWidth: 0,
          formatter: '{b}',
        },
        edgeLabel: {
          show: view.showEdgeLabels,
          color: mutedColor,
          fontSize: 10,
          textBorderWidth: 0,
        },
        emphasis: {
          focus: 'adjacency',
          edgeLabel: { show: true },
          lineStyle: { width: 3 },
        },
        force: { repulsion: 240, edgeLength: [70, 150], gravity: 0.08, friction: 0.55 },
        lineStyle: { opacity: 0.7, curveness: 0.08 },
      },
    ],
  }
}
