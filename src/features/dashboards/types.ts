export type TileType =
  // riga-flow tiles (additive; handoff §5.1b)
  | 'RigaPayoffPetriNet' | 'RigaTransitionDetail' | 'RigaTokenDetail' | 'RigaRiskNet' | 'RigaExplainNet'
  | 'RigaDataLineage' | 'RigaPathCubeQuery' | 'RigaExecutionTape' | 'RigaBookRisk' | 'RigaScenarioComparison'
  | 'RigaTaylorExplain' | 'RigaStatisticsSummary' | 'RigaAttribution' | 'RigaCashflowSummary' | 'RigaCashflowTimeline' | 'RigaRiskSummary' | 'RigaDistributionSummary' | 'RigaSelectedPath'
  | 'RigaPvConvergence' | 'RigaCiShrinkage' | 'RigaErrorVsPaths' | 'RigaKiConvergence' | 'RigaKoConvergence' | 'RigaConvergenceHealth'
  | 'RigaPayoffHistogram' | 'RigaDistributionExplorer'
  | 'RigaGreeksTable' | 'RigaGreeksWaterfall' | 'RigaBucketVega'
  | 'RigaEconomicsImpactSummary' | 'RigaSensitivityTornado' | 'RigaParameterImpactMatrix'
  | 'RigaMasterExplainWaterfall'
  | 'RigaPathTimeline' | 'RigaQuantileFan' | 'RigaWorstOfEvolution' | 'RigaBarrierHeatmap' | 'RigaStateOccupancy'
  | 'RigaBranchFlow' | 'RigaMarketExplorer' | 'RigaVolSurface' | 'RigaPayoffGraph'
  | 'RigaObservationSchedule' | 'RigaScheduleExplorer' | 'RigaPercentileConvergence' | 'RigaDistributionStability'
  | 'RigaGovernanceEvidence' | 'RigaRootCause' | 'RigaRegressionTriage' | 'RigaGreeksSanity'
  | 'RigaStressBands' | 'RigaMarketSnapshot' | 'RigaHealthRun' | 'RigaTradeEconomics' | 'RigaMarketData'
  // tac-engine market-data tiles (additive; handoff §6.7)
  | 'TacMarketDataPanel' | 'TacSymbolPicker' | 'TacBarChart' | 'TacTaSpPanes' | 'TacCorrelationMatrix'
  | 'TacVolSurface' | 'TacYieldCurve' | 'TacFxSpot' | 'TacFxVol' | 'TacCorporateActions'
  | 'TacLakeCoverage' | 'TacManipulationEditor'

export type TileLayout = { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number }
export type Tile = { id: string; type: TileType; title: string }
export type Dashboard = { id: string; name: string; layout: TileLayout[] }
