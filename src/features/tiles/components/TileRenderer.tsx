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
import { ExplainLedgerTableTile, ExplainLedgerExplorerTile, ExplainReconciliationTile } from '../../pathcube/components/ExplainLedgerTiles'
import { ValuationExplainSummaryTile, MasterExplainWaterfallTile, TaylorExplainTile, PLVATile } from '../../pathcube/components/ValuationExplainTiles'
import { CashflowSummaryTile, CashflowTimelineTile, CashflowDetailTile, PnLSummaryTile, PnLTimelineTile } from '../../pathcube/components/CashflowPnlTiles'
import { ScheduleExplorerTile, ObservationExplorerTile, ExecutionStateInspectorTile, LifecycleOverviewTile } from '../../pathcube/components/ExecutionLayerTiles'
import { RiskSummaryTile, GreeksTableTile, BucketVegaTile, SpotPriceExplorerTile, VolatilitySurfaceTile, CorrelationMatrixTile, FXSpotExplorerTile, GreeksWaterfallTile, ScenarioComparisonTile } from '../../pathcube/components/MarketRiskTiles'
import type { TileType } from '../../dashboards/types'
import type { ReactElement, ComponentType } from 'react'
import { lazy, Suspense } from 'react'
import { TileErrorBoundary } from './TileErrorBoundary'
import { PanelLoading } from '../../shared/components/AsyncPanel'

// The engine tiles (xyflow + ECharts) load lazily so the initial app chunk and
// app start do not pay for code only the riga/tac dashboards use. Each lazy
// component keeps the same name, so the dispatch below is unchanged.
const lazyNamed = <M extends Record<string, unknown>, K extends keyof M>(loader: () => Promise<M>, name: K) =>
  lazy(() => loader().then((module) => ({ default: module[name] as ComponentType })))
const PetriNetTilesModule = () => import('../../riga/components/PetriNetTiles')
const RigaAnalyticsModule = () => import('../../riga/components/RigaAnalyticsTiles')
const RigaMetadataModule = () => import('../../riga/components/RigaMetadataTiles')
const RigaTradePanelModule = () => import('../../riga/components/RigaTradeEconomicsPanel')
const RigaMarketPanelModule = () => import('../../riga/components/RigaMarketDataPanel')
const RigaCashflowModule = () => import('../../riga/components/RigaCashflowTiles')
const RigaConvergenceModule = () => import('../../riga/components/RigaConvergenceTiles')
const RigaDistributionModule = () => import('../../riga/components/RigaDistributionTiles')
const RigaRiskDetailModule = () => import('../../riga/components/RigaRiskDetailTiles')
const RigaTradeDesignModule = () => import('../../riga/components/RigaTradeDesignTiles')
const TacTilesModule = () => import('../../tac/components/TacTiles')

const RigaTradeEconomicsTile = lazyNamed(RigaTradePanelModule, 'RigaTradeEconomicsTile')
const RigaMarketDataTile = lazyNamed(RigaMarketPanelModule, 'RigaMarketDataTile')

const PayoffPetriNetTile = lazyNamed(PetriNetTilesModule, 'PayoffPetriNetTile')
const RiskNetTile = lazyNamed(PetriNetTilesModule, 'RiskNetTile')
const ExplainNetTile = lazyNamed(PetriNetTilesModule, 'ExplainNetTile')
const TransitionDetailTile = lazyNamed(PetriNetTilesModule, 'TransitionDetailTile')
const TokenDetailTile = lazyNamed(PetriNetTilesModule, 'TokenDetailTile')
const RigaDataLineageTile = lazyNamed(PetriNetTilesModule, 'RigaDataLineageTile')
const RigaBookRiskTile = lazyNamed(RigaAnalyticsModule, 'RigaBookRiskTile')
const RigaExecutionTapeTile = lazyNamed(RigaAnalyticsModule, 'RigaExecutionTapeTile')
const RigaGreeksSanityTile = lazyNamed(RigaAnalyticsModule, 'RigaGreeksSanityTile')
const RigaGovernanceEvidenceTile = lazyNamed(RigaAnalyticsModule, 'RigaGovernanceEvidenceTile')
const RigaPathCubeTile = lazyNamed(RigaAnalyticsModule, 'RigaPathCubeTile')
const RigaAttributionTile = lazyNamed(RigaAnalyticsModule, 'RigaAttributionTile')
const RigaCashflowSummaryTile = lazyNamed(RigaCashflowModule, 'RigaCashflowSummaryTile')
const RigaCashflowTimelineTile = lazyNamed(RigaCashflowModule, 'RigaCashflowTimelineTile')
const RigaRiskSummaryTile = lazyNamed(RigaAnalyticsModule, 'RigaRiskSummaryTile')
const RigaDistributionSummaryTile = lazyNamed(RigaAnalyticsModule, 'RigaDistributionSummaryTile')
const RigaSelectedPathTile = lazyNamed(RigaAnalyticsModule, 'RigaSelectedPathTile')
const RigaPvConvergenceTile = lazyNamed(RigaConvergenceModule, 'RigaPvConvergenceTile')
const RigaCiShrinkageTile = lazyNamed(RigaConvergenceModule, 'RigaCiShrinkageTile')
const RigaErrorVsPathsTile = lazyNamed(RigaConvergenceModule, 'RigaErrorVsPathsTile')
const RigaKiConvergenceTile = lazyNamed(RigaConvergenceModule, 'RigaKiConvergenceTile')
const RigaKoConvergenceTile = lazyNamed(RigaConvergenceModule, 'RigaKoConvergenceTile')
const RigaConvergenceHealthTile = lazyNamed(RigaConvergenceModule, 'RigaConvergenceHealthTile')
const RigaPayoffHistogramTile = lazyNamed(RigaDistributionModule, 'RigaPayoffHistogramTile')
const RigaDistributionExplorerTile = lazyNamed(RigaDistributionModule, 'RigaDistributionExplorerTile')
const RigaGreeksTableTile = lazyNamed(RigaRiskDetailModule, 'RigaGreeksTableTile')
const RigaGreeksWaterfallTile = lazyNamed(RigaRiskDetailModule, 'RigaGreeksWaterfallTile')
const RigaBucketVegaTile = lazyNamed(RigaRiskDetailModule, 'RigaBucketVegaTile')
const RigaEconomicsImpactSummaryTile = lazyNamed(RigaTradeDesignModule, 'RigaEconomicsImpactSummaryTile')
const RigaSensitivityTornadoTile = lazyNamed(RigaTradeDesignModule, 'RigaSensitivityTornadoTile')
const RigaParameterImpactMatrixTile = lazyNamed(RigaTradeDesignModule, 'RigaParameterImpactMatrixTile')
const RigaRegressionTriageTile = lazyNamed(RigaAnalyticsModule, 'RigaRegressionTriageTile')
const RigaRootCauseTile = lazyNamed(RigaAnalyticsModule, 'RigaRootCauseTile')
const RigaScenarioComparisonTile = lazyNamed(RigaAnalyticsModule, 'RigaScenarioComparisonTile')
const RigaStatisticsSummaryTile = lazyNamed(RigaAnalyticsModule, 'RigaStatisticsSummaryTile')
const RigaStressBandsTile = lazyNamed(RigaAnalyticsModule, 'RigaStressBandsTile')
const RigaTaylorExplainTile = lazyNamed(RigaAnalyticsModule, 'RigaTaylorExplainTile')
const RigaHealthRunTile = lazyNamed(RigaMetadataModule, 'RigaHealthRunTile')
const RigaMarketSnapshotTile = lazyNamed(RigaMetadataModule, 'RigaMarketSnapshotTile')
const TacBarChart = lazyNamed(TacTilesModule, 'TacBarChart')
const TacCorporateActions = lazyNamed(TacTilesModule, 'TacCorporateActions')
const TacCorrelationMatrix = lazyNamed(TacTilesModule, 'TacCorrelationMatrix')
const TacFxSpot = lazyNamed(TacTilesModule, 'TacFxSpot')
const TacFxVol = lazyNamed(TacTilesModule, 'TacFxVol')
const TacLakeCoverage = lazyNamed(TacTilesModule, 'TacLakeCoverage')
const TacManipulationEditor = lazyNamed(TacTilesModule, 'TacManipulationEditor')
const TacMarketDataPanel = lazyNamed(TacTilesModule, 'TacMarketDataPanel')
const TacSymbolPicker = lazyNamed(TacTilesModule, 'TacSymbolPicker')
const TacTaSpPanes = lazyNamed(TacTilesModule, 'TacTaSpPanes')
const TacVolSurface = lazyNamed(TacTilesModule, 'TacVolSurface')
const TacYieldCurve = lazyNamed(TacTilesModule, 'TacYieldCurve')

function renderTile(type: TileType): ReactElement | null {
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
    case 'ScheduleExplorer': return wrap(<ScheduleExplorerTile />)
    case 'ObservationExplorer': return wrap(<ObservationExplorerTile />)
    case 'ExecutionStateInspector': return wrap(<ExecutionStateInspectorTile />)
    case 'LifecycleOverview': return wrap(<LifecycleOverviewTile />)
    case 'CashflowSummary': return wrap(<CashflowSummaryTile />)
    case 'CashflowTimeline': return wrap(<CashflowTimelineTile />)
    case 'CashflowDetail': return wrap(<CashflowDetailTile />)
    case 'PnLSummary': return wrap(<PnLSummaryTile />)
    case 'PnLTimeline': return wrap(<PnLTimelineTile />)
    case 'ValuationExplainSummary': return wrap(<ValuationExplainSummaryTile />)
    case 'MasterExplainWaterfall': return wrap(<MasterExplainWaterfallTile />)
    case 'TaylorExplain': return wrap(<TaylorExplainTile />)
    case 'PLVAExplain': return wrap(<PLVATile />)
    case 'ExplainLedgerTable': return wrap(<ExplainLedgerTableTile />)
    case 'ExplainLedgerExplorer': return wrap(<ExplainLedgerExplorerTile />)
    case 'ExplainReconciliation': return wrap(<ExplainReconciliationTile />)
    // riga-flow
    case 'RigaPayoffPetriNet': return wrap(<PayoffPetriNetTile />)
    case 'RigaTransitionDetail': return wrap(<TransitionDetailTile />)
    case 'RigaTokenDetail': return wrap(<TokenDetailTile />)
    case 'RigaRiskNet': return wrap(<RiskNetTile />)
    case 'RigaExplainNet': return wrap(<ExplainNetTile />)
    case 'RigaDataLineage': return wrap(<RigaDataLineageTile />)
    case 'RigaPathCubeQuery': return wrap(<RigaPathCubeTile />)
    case 'RigaExecutionTape': return wrap(<RigaExecutionTapeTile />)
    case 'RigaBookRisk': return wrap(<RigaBookRiskTile />)
    case 'RigaScenarioComparison': return wrap(<RigaScenarioComparisonTile />)
    case 'RigaTaylorExplain': return wrap(<RigaTaylorExplainTile />)
    case 'RigaStatisticsSummary': return wrap(<RigaStatisticsSummaryTile />)
    case 'RigaAttribution': return wrap(<RigaAttributionTile />)
    case 'RigaCashflowSummary': return wrap(<RigaCashflowSummaryTile />)
    case 'RigaCashflowTimeline': return wrap(<RigaCashflowTimelineTile />)
    case 'RigaRiskSummary': return wrap(<RigaRiskSummaryTile />)
    case 'RigaDistributionSummary': return wrap(<RigaDistributionSummaryTile />)
    case 'RigaSelectedPath': return wrap(<RigaSelectedPathTile />)
    case 'RigaPvConvergence': return wrap(<RigaPvConvergenceTile />)
    case 'RigaCiShrinkage': return wrap(<RigaCiShrinkageTile />)
    case 'RigaErrorVsPaths': return wrap(<RigaErrorVsPathsTile />)
    case 'RigaKiConvergence': return wrap(<RigaKiConvergenceTile />)
    case 'RigaKoConvergence': return wrap(<RigaKoConvergenceTile />)
    case 'RigaConvergenceHealth': return wrap(<RigaConvergenceHealthTile />)
    case 'RigaPayoffHistogram': return wrap(<RigaPayoffHistogramTile />)
    case 'RigaDistributionExplorer': return wrap(<RigaDistributionExplorerTile />)
    case 'RigaGreeksTable': return wrap(<RigaGreeksTableTile />)
    case 'RigaGreeksWaterfall': return wrap(<RigaGreeksWaterfallTile />)
    case 'RigaBucketVega': return wrap(<RigaBucketVegaTile />)
    case 'RigaEconomicsImpactSummary': return wrap(<RigaEconomicsImpactSummaryTile />)
    case 'RigaSensitivityTornado': return wrap(<RigaSensitivityTornadoTile />)
    case 'RigaParameterImpactMatrix': return wrap(<RigaParameterImpactMatrixTile />)
    case 'RigaGovernanceEvidence': return wrap(<RigaGovernanceEvidenceTile />)
    case 'RigaRootCause': return wrap(<RigaRootCauseTile />)
    case 'RigaRegressionTriage': return wrap(<RigaRegressionTriageTile />)
    case 'RigaGreeksSanity': return wrap(<RigaGreeksSanityTile />)
    case 'RigaStressBands': return wrap(<RigaStressBandsTile />)
    case 'RigaMarketSnapshot': return wrap(<RigaMarketSnapshotTile />)
    case 'RigaHealthRun': return wrap(<RigaHealthRunTile />)
    case 'RigaTradeEconomics': return wrap(<RigaTradeEconomicsTile />)
    case 'RigaMarketData': return wrap(<RigaMarketDataTile />)
    // tac-engine
    case 'TacMarketDataPanel': return wrap(<TacMarketDataPanel />)
    case 'TacSymbolPicker': return wrap(<TacSymbolPicker />)
    case 'TacBarChart': return wrap(<TacBarChart />)
    case 'TacTaSpPanes': return wrap(<TacTaSpPanes />)
    case 'TacCorrelationMatrix': return wrap(<TacCorrelationMatrix />)
    case 'TacVolSurface': return wrap(<TacVolSurface />)
    case 'TacYieldCurve': return wrap(<TacYieldCurve />)
    case 'TacFxSpot': return wrap(<TacFxSpot />)
    case 'TacFxVol': return wrap(<TacFxVol />)
    case 'TacCorporateActions': return wrap(<TacCorporateActions />)
    case 'TacLakeCoverage': return wrap(<TacLakeCoverage />)
    case 'TacManipulationEditor': return wrap(<TacManipulationEditor />)
  }
  return null
}

export function TileRenderer({ type }: { type: TileType }) {
  return (
    <TileErrorBoundary key={type}>
      <Suspense fallback={<PanelLoading title="Loading tile" />}>{renderTile(type)}</Suspense>
    </TileErrorBoundary>
  )
}
