export type TileType =
  | 'PayoffGraph' | 'PathTimeline' | 'NodeDetails' | 'Sankey' | 'Attribution' | 'Histogram' | 'Distribution'
  | 'QuantileFan' | 'StateOccupancy' | 'BarrierHeatmap' | 'PathPercentileHeatmap' | 'PathDistributionPosition'
  | 'SimulationSummary' | 'PVConvergence' | 'ConfidenceIntervalShrinkage' | 'ErrorVsPathCount'
  | 'PercentileConvergence' | 'KIProbabilityConvergence' | 'KOProbabilityConvergence'
  | 'DistributionStability' | 'SimulationEfficiency' | 'ConvergenceHealth'
  | 'TradeSummary' | 'EconomicsImpactSummary' | 'SensitivityTornado' | 'ParameterImpactMatrix'
  | 'RiskSummary' | 'GreeksTable' | 'BucketVega' | 'SpotPriceExplorer' | 'VolatilitySurface'
  | 'CorrelationMatrix' | 'FXSpotExplorer' | 'GreeksWaterfall' | 'ScenarioComparison'
  | 'ScheduleExplorer' | 'ObservationExplorer' | 'ExecutionStateInspector' | 'LifecycleOverview'
  | 'CashflowSummary' | 'CashflowTimeline' | 'CashflowDetail' | 'PnLSummary' | 'PnLTimeline'
  | 'ValuationExplainSummary' | 'MasterExplainWaterfall' | 'TaylorExplain' | 'PLVAExplain'
  | 'ExplainLedgerTable' | 'ExplainLedgerExplorer' | 'ExplainReconciliation'
  // riga-flow tiles (additive; handoff §5.1b)
  | 'RigaPayoffPetriNet' | 'RigaTransitionDetail' | 'RigaTokenDetail' | 'RigaRiskNet' | 'RigaExplainNet'
  | 'RigaDataLineage' | 'RigaPathCubeQuery' | 'RigaExecutionTape' | 'RigaBookRisk' | 'RigaScenarioComparison'
  | 'RigaTaylorExplain' | 'RigaStatisticsSummary' | 'RigaAttribution' | 'RigaCashflowSummary' | 'RigaCashflowTimeline' | 'RigaRiskSummary' | 'RigaDistributionSummary' | 'RigaSelectedPath'
  | 'RigaPvConvergence' | 'RigaCiShrinkage' | 'RigaErrorVsPaths' | 'RigaKiConvergence' | 'RigaKoConvergence' | 'RigaConvergenceHealth'
  | 'RigaGovernanceEvidence' | 'RigaRootCause' | 'RigaRegressionTriage' | 'RigaGreeksSanity'
  | 'RigaStressBands' | 'RigaMarketSnapshot' | 'RigaHealthRun' | 'RigaTradeEconomics' | 'RigaMarketData'
  // tac-engine market-data tiles (additive; handoff §6.7)
  | 'TacMarketDataPanel' | 'TacSymbolPicker' | 'TacBarChart' | 'TacTaSpPanes' | 'TacCorrelationMatrix'
  | 'TacVolSurface' | 'TacYieldCurve' | 'TacFxSpot' | 'TacFxVol' | 'TacCorporateActions'
  | 'TacLakeCoverage' | 'TacManipulationEditor'

export type TileLayout = { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number }
export type Tile = { id: string; type: TileType; title: string }
export type Dashboard = { id: string; name: string; layout: TileLayout[] }
