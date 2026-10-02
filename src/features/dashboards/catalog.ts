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
  { id: 'simulation-summary', type: 'SimulationSummary', title: 'Simulation Summary', description: 'KPI cards for path count, PV, error, confidence, and convergence.', group: 'Monte Carlo Diagnostics', icon: '◉' },
  { id: 'pv-convergence', type: 'PVConvergence', title: 'PV Convergence', description: 'Running PV estimate with 95% confidence band.', group: 'Monte Carlo Diagnostics', icon: '⌁' },
  { id: 'ci-shrinkage', type: 'ConfidenceIntervalShrinkage', title: 'Confidence Interval Shrinkage', description: 'Uncertainty reduction as simulation size increases.', group: 'Monte Carlo Diagnostics', icon: '↘' },
  { id: 'error-vs-path-count', type: 'ErrorVsPathCount', title: 'Error vs Path Count', description: 'Observed error versus theoretical 1/√N decay.', group: 'Monte Carlo Diagnostics', icon: '∝' },
  { id: 'percentile-convergence', type: 'PercentileConvergence', title: 'Percentile Convergence', description: 'P05, P50, and P95 tail stability.', group: 'Monte Carlo Diagnostics', icon: '≋' },
  { id: 'ki-probability-convergence', type: 'KIProbabilityConvergence', title: 'KI Probability Convergence', description: 'Stability of knock-in probability estimation.', group: 'Monte Carlo Diagnostics', icon: 'KI' },
  { id: 'ko-probability-convergence', type: 'KOProbabilityConvergence', title: 'KO Probability Convergence', description: 'Stability of knock-out probability estimation.', group: 'Monte Carlo Diagnostics', icon: 'KO' },
  { id: 'distribution-stability', type: 'DistributionStability', title: 'Distribution Stability', description: 'Overlaid terminal payoff distributions at increasing path counts.', group: 'Monte Carlo Diagnostics', icon: '◒' },
  { id: 'simulation-efficiency', type: 'SimulationEfficiency', title: 'Simulation Efficiency', description: 'Educational paths-required tradeoff by variance-reduction method.', group: 'Monte Carlo Diagnostics', icon: '▤' },
  { id: 'convergence-health', type: 'ConvergenceHealth', title: 'Convergence Health', description: 'Traffic-light assessment of simulation quality.', group: 'Monte Carlo Diagnostics', icon: '●' },
  { id: 'trade-summary', type: 'TradeSummary', title: 'Trade Summary', description: 'Current barriers, coupon, settlement, notional, and maturity.', group: 'Trade Design', icon: '◇' },
  { id: 'economics-impact-summary', type: 'EconomicsImpactSummary', title: 'Economics Impact Summary', description: 'Expected PV, coupon, put, and branch-probability impacts.', group: 'Trade Design', icon: 'Δ' },
  { id: 'sensitivity-tornado', type: 'SensitivityTornado', title: 'Sensitivity Tornado', description: 'Rank economics parameters by one-step PV impact.', group: 'Trade Design', icon: '◀' },
  { id: 'parameter-impact-matrix', type: 'ParameterImpactMatrix', title: 'Parameter Impact Matrix', description: 'Heatmap of directional impacts across analytics.', group: 'Trade Design', icon: '▦' },
]

export function tileFromType(type: TileType, suffix = `${Date.now()}`): Tile { const meta = TILE_CATALOG.find((item) => item.type === type)!; return { id: `${meta.id}-${suffix}`, type, title: meta.title } }
