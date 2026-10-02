import type { Tile, TileType } from './types'

export type TileMeta = Tile & { description: string; group: string; icon: string }
export const TILE_CATALOG: TileMeta[] = [
  { id: 'payoff-graph', type: 'PayoffGraph', title: 'Payoff Graph', description: 'Trace the selected path through the payoff logic.', group: 'Payoff Analysis', icon: '⌘' },
  { id: 'path-timeline', type: 'PathTimeline', title: 'Path Timeline', description: 'Worst-of performance and barrier crossings.', group: 'Path Analysis', icon: '↗' },
  { id: 'node-details', type: 'NodeDetails', title: 'Node Details', description: 'Explain the current payoff decision.', group: 'Path Analysis', icon: '◈' },
  { id: 'sankey', type: 'Sankey', title: 'Branch Statistics', description: 'Population flow through KO, KI, and settlement states.', group: 'Risk Analytics', icon: '≋' },
  { id: 'attribution', type: 'Attribution', title: 'Attribution', description: 'Waterfall decomposition of selected-path PV.', group: 'Payoff Analysis', icon: '▥' },
  { id: 'histogram', type: 'Histogram', title: 'Payoff Histogram · Selected Path', description: 'Focused total-payoff histogram with a selected-path marker.', group: 'Distribution Analysis', icon: '▤' },
  { id: 'distribution', type: 'Distribution', title: 'Distribution Explorer · Metric Compare', description: 'Compare normalized payoff, coupon, put, and worst-of distributions.', group: 'Distribution Analysis', icon: '◒' },
  { id: 'quantile-fan', type: 'QuantileFan', title: 'Quantile Fan · Population Envelope', description: 'Time-evolving P05–P95 population bands with selected path overlay.', group: 'Path Analysis', icon: '⌁' },
  { id: 'state-occupancy', type: 'StateOccupancy', title: 'State Occupancy', description: '100% stacked path states through time.', group: 'Risk Analytics', icon: '▰' },
  { id: 'barrier-heatmap', type: 'BarrierHeatmap', title: 'Barrier Crossing Timeline', description: 'Aggregated barrier crossing rates by observation.', group: 'Risk Analytics', icon: '▦' },
  { id: 'path-percentile-heatmap', type: 'PathPercentileHeatmap', title: 'Worst-of Evolution', description: 'Percentile evolution of the worst-of process.', group: 'Path Analysis', icon: '▧' },
  { id: 'path-distribution-position', type: 'PathDistributionPosition', title: 'Selected Path in Population', description: 'Where the selected path sits in the population.', group: 'Distribution Analysis', icon: '◎' },
]

export function tileFromType(type: TileType, suffix = `${Date.now()}`): Tile { const meta = TILE_CATALOG.find((item) => item.type === type)!; return { id: `${meta.id}-${suffix}`, type, title: meta.title } }
