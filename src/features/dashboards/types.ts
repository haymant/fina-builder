export type TileType =
  | 'PayoffGraph' | 'PathTimeline' | 'NodeDetails' | 'Sankey' | 'Attribution' | 'Histogram' | 'Distribution'
  | 'QuantileFan' | 'StateOccupancy' | 'BarrierHeatmap' | 'PathPercentileHeatmap' | 'PathDistributionPosition'
  | 'SimulationSummary' | 'PVConvergence' | 'ConfidenceIntervalShrinkage' | 'ErrorVsPathCount'
  | 'PercentileConvergence' | 'KIProbabilityConvergence' | 'KOProbabilityConvergence'
  | 'DistributionStability' | 'SimulationEfficiency' | 'ConvergenceHealth'

export type TileLayout = { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number }
export type Tile = { id: string; type: TileType; title: string }
export type Dashboard = { id: string; name: string; layout: TileLayout[] }
