// Domain data hooks (§5d.4). Every domain value the UI renders arrives from
// fina-kernel through the active transport; these hooks hold no formulas.

import { fina } from '../api'
import type {
  CashflowResponse,
  ExplainLedger,
  ExecutionEvent,
  McDiagnosticsResponse,
  MarketSnapshot,
  RiskState,
  SimulationPath,
  TradeAnalytics,
  TradeEconomics,
  ValuationExplain,
} from '../api/types'
import { useAsync, type AsyncState } from './useAsync'
import { useSelectedSimulationPath } from '../store/simulationStore'
import { useTradeEconomicsStore } from '../store/tradeEconomicsStore'
import { useMarketDataStore } from '../store/marketDataStore'

/** Same `as_of` across ledger hooks: today, `YYYY-MM-DD`. */
export function todayAsOf(): string {
  return new Date().toISOString().slice(0, 10)
}

/** The market inputs in the wire shape (drops UI selection state). */
function marketSnapshot(): MarketSnapshot {
  const m = useMarketDataStore.getState()
  return {
    underlyings: m.underlyings,
    fxPairs: m.fxPairs,
    correlations: m.correlations,
    vol: m.vol,
  }
}

/** The currently selected path from the backend. */
export function useSelectedPath(): AsyncState<SimulationPath> {
  const path = useSelectedSimulationPath()
  const index = path?.pathIndex ?? 0
  return useAsync(() => fina.call<SimulationPath>('get_path', { pathIndex: index }), [index])
}

export function useSimulation() {
  return useSelectedPath()
}

/** Trade analytics for the current trade inputs (remote, not derived). */
export function useTradeAnalytics(
  trade: TradeEconomics,
): AsyncState<TradeAnalytics> {
  return useAsync(
    () => fina.call<TradeAnalytics>('compute_trade_analytics', { trade }),
    [JSON.stringify(trade)],
  )
}

/** Risk panel Greeks for the current market + trade. */
export function useRiskEngine(): AsyncState<RiskState> {
  const trade = useTradeEconomicsStore()
  const key = JSON.stringify({ trade, market: marketSnapshot() })
  return useAsync(
    () =>
      fina.call<RiskState>('compute_risk', { trade, market: marketSnapshot() }),
    [key],
  )
}

/** MC convergence series + efficiency + final row. */
export function useMcDiagnostics(): AsyncState<McDiagnosticsResponse> {
  return useAsync(
    () => fina.call<McDiagnosticsResponse>('get_mc_diagnostics', {}),
    [],
  )
}

/** Cashflows + analytics for the selected path. */
export function useCashflows(): AsyncState<CashflowResponse> {
  const path = useSelectedSimulationPath()
  const trade = useTradeEconomicsStore()
  const index = path?.pathIndex ?? 0
  return useAsync(
    () => fina.call<CashflowResponse>('build_cashflows', { trade, pathIndex: index }),
    [index, JSON.stringify(trade)],
  )
}

/** Valuation explain (Taylor + PLVA) for the selected path. */
export function useValuationExplain(): AsyncState<ValuationExplain> {
  const path = useSelectedSimulationPath()
  const trade = useTradeEconomicsStore()
  const index = path?.pathIndex ?? 0
  const marketKey = JSON.stringify(marketSnapshot())
  return useAsync(
    () =>
      fina.call<ValuationExplain>('valuation_explain', {
        trade,
        market: marketSnapshot(),
        pathIndex: index,
        asOf: todayAsOf(),
      }),
    [index, JSON.stringify(trade), marketKey],
  )
}

/** The ten-entry explain ledger for the selected path. */
export function useExplainLedger(): AsyncState<ExplainLedger> {
  const path = useSelectedSimulationPath()
  const trade = useTradeEconomicsStore()
  const index = path?.pathIndex ?? 0
  const marketKey = JSON.stringify(marketSnapshot())
  return useAsync(
    () =>
      fina.call<ExplainLedger>('explain_ledger', {
        trade,
        market: marketSnapshot(),
        pathIndex: index,
        asOf: todayAsOf(),
      }),
    [index, JSON.stringify(trade), marketKey],
  )
}

/** Execution events for the selected path. */
export function useExecutionEvents(): AsyncState<ExecutionEvent[]> {
  const path = useSelectedSimulationPath()
  const index = path?.pathIndex ?? 0
  return useAsync(
    () => fina.call<ExecutionEvent[]>('execution_events', { pathIndex: index }),
    [index],
  )
}