import { ReactFlowProvider } from '@xyflow/react'
import { AttributionPanel } from '../../attribution/components/AttributionPanel'
import { BranchSankeyPanel } from '../../branch-statistics/components/BranchSankeyPanel'
import { DistributionExplorerTile, PayoffHistogramTile } from '../../distribution/components/DistributionTiles'
import { NodeDetailPanel } from '../../path-inspector/components/NodeDetailPanel'
import { PathTimelinePanel } from '../../path-inspector/components/PathTimelinePanel'
import { PayoffGraphPanel } from '../../payoff-graph/components/PayoffGraphPanel'
import { QuantileFanTile, StateOccupancyTile, BarrierHeatmapTile, PathDistributionPositionTile } from '../../pathcube/components/PathCubeTiles'
import { SimulationSummaryTile, PVConvergenceTile, ConfidenceIntervalShrinkageTile, ErrorVsPathCountTile, PercentileConvergenceTile, KIProbabilityConvergenceTile, KOProbabilityConvergenceTile, DistributionStabilityTile, SimulationEfficiencyTile, ConvergenceHealthTile } from '../../pathcube/components/MCDiagnosticsTiles'
import { TradeSummaryTile, EconomicsImpactSummaryTile, SensitivityTornadoTile, ParameterImpactMatrixTile } from '../../pathcube/components/TradeDesignTiles'
import { RiskSummaryTile, GreeksTableTile, BucketVegaTile, SpotPriceExplorerTile, VolatilitySurfaceTile, CorrelationMatrixTile, FXSpotExplorerTile, GreeksWaterfallTile, ScenarioComparisonTile } from '../../pathcube/components/MarketRiskTiles'
import type { TileType } from '../../dashboards/types'
import type { ReactElement } from 'react'

export function TileRenderer({ type }: { type: TileType }) {
  const wrap = (child: ReactElement) => <div className="h-full min-h-0">{child}</div>
  switch (type) {
    case 'PayoffGraph': return wrap(<ReactFlowProvider><PayoffGraphPanel /></ReactFlowProvider>)
    case 'PathTimeline': return wrap(<PathTimelinePanel />)
    case 'NodeDetails': return wrap(<NodeDetailPanel />)
    case 'Sankey': return wrap(<BranchSankeyPanel />)
    case 'Attribution': return wrap(<AttributionPanel />)
    case 'Histogram': return wrap(<PayoffHistogramTile />)
    case 'Distribution': return wrap(<DistributionExplorerTile />)
    case 'QuantileFan': return wrap(<QuantileFanTile />)
    case 'StateOccupancy': return wrap(<StateOccupancyTile />)
    case 'BarrierHeatmap': case 'PathPercentileHeatmap': return wrap(<BarrierHeatmapTile />)
    case 'PathDistributionPosition': return wrap(<PathDistributionPositionTile />)
    case 'SimulationSummary': return wrap(<SimulationSummaryTile />)
    case 'PVConvergence': return wrap(<PVConvergenceTile />)
    case 'ConfidenceIntervalShrinkage': return wrap(<ConfidenceIntervalShrinkageTile />)
    case 'ErrorVsPathCount': return wrap(<ErrorVsPathCountTile />)
    case 'PercentileConvergence': return wrap(<PercentileConvergenceTile />)
    case 'KIProbabilityConvergence': return wrap(<KIProbabilityConvergenceTile />)
    case 'KOProbabilityConvergence': return wrap(<KOProbabilityConvergenceTile />)
    case 'DistributionStability': return wrap(<DistributionStabilityTile />)
    case 'SimulationEfficiency': return wrap(<SimulationEfficiencyTile />)
    case 'ConvergenceHealth': return wrap(<ConvergenceHealthTile />)
    case 'TradeSummary': return wrap(<TradeSummaryTile />)
    case 'EconomicsImpactSummary': return wrap(<EconomicsImpactSummaryTile />)
    case 'SensitivityTornado': return wrap(<SensitivityTornadoTile />)
    case 'ParameterImpactMatrix': return wrap(<ParameterImpactMatrixTile />)
    case 'RiskSummary': return wrap(<RiskSummaryTile />)
    case 'GreeksTable': return wrap(<GreeksTableTile />)
    case 'BucketVega': return wrap(<BucketVegaTile />)
    case 'SpotPriceExplorer': return wrap(<SpotPriceExplorerTile />)
    case 'VolatilitySurface': return wrap(<VolatilitySurfaceTile />)
    case 'CorrelationMatrix': return wrap(<CorrelationMatrixTile />)
    case 'FXSpotExplorer': return wrap(<FXSpotExplorerTile />)
    case 'GreeksWaterfall': return wrap(<GreeksWaterfallTile />)
    case 'ScenarioComparison': return wrap(<ScenarioComparisonTile />)
  }
}
