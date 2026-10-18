// riga-flow data hooks (§9). Every hook depends on the composed request key
// (`rigaRequestStore`) **and** the observability level, so a pure market-data
// change re-runs risk / valuation / ledger — the reactivity gap §9.2 closes.
// Calls are debounced (§9.3); `refresh` is the immediate path.

import { riga } from '../../api/rigaTransport'
import type { RigaTask } from '../../api/rigaTransport'
import { useDebouncedAsync } from '../../hooks/useDebouncedAsync'
import type { AsyncState } from '../../hooks/useAsync'
import { useRigaRequestStore } from '../../store/rigaRequestStore'
import { useObservabilityStore } from '../../store/observabilityStore'
import type {
  ExecutionNet,
  ExecutionTape,
  ExplainPvAttribution,
  LedgerPayload,
  PathCubeQueryResponse,
  PathRecord,
  RigaBaseline,
  RigaBookRisk,
  RigaDistributions,
  RigaGovernanceEvidence,
  RigaHealth,
  RigaMarketEntry,
  RigaCashflows,
  RigaDistributionsHistogram,
  RigaMcConvergence,
  RigaRiskDetailed,
  RigaMcDiagnostics,
  RigaPlExplain,
  RigaPricePut,
  RigaPriceResult,
  RigaRegressionResult,
  RigaRiskBatch,
  RigaRootCause,
  RigaScenario,
  RigaStressBand,
  RigaValidationFlag,
  RigaValuationExplain,
  RiskNet,
  TransitionStats,
} from './types'

/** Default factor moves for the explain tools (camelCase wire names). */
export const DEFAULT_MOVES = {
  spotMoves: [0.01, -0.01],
  volMoves: [0.01, -0.01],
  rateMove: 0.0001,
  corrMove: 0.01,
}

type ToolOptions = {
  /** When false the tool is not called (trace gating, §10). */
  enabled?: boolean
  /** Extra dependency values (percentile, pathId, …). */
  deps?: readonly unknown[]
}

/** Every riga-mcp fixture tool whose param struct now accepts an inline
 * `request` (see docs/46 §8). `health` takes no params; `price_trade` already
 * carries the request itself. Injecting it here is what keeps every tile
 * pricing the same live trade as `price_trade`. */
const TOOLS_WITH_REQUEST = new Set<string>([
  'price_put',
  'explain_pv_attribution',
  'replay_path',
  'query_path_cube',
  'query_pathcube',
  'risk_batch',
  'list_markets',
  'get_market',
  'generate_paths',
  'get_path',
  'get_branch_stats',
  'get_distributions',
  'get_mc_diagnostics',
  'mc_convergence',
  'distributions_histogram',
  'risk_detailed',
  'build_cashflows',
  'execution_events',
  'compute_risk',
  'compute_book_risk',
  'price_book',
  'price_book_async',
  'pl_explain',
  'get_ledger',
  'query_execution_net',
  'query_risk_net',
  'validate_greeks',
  'recommend_scenarios',
  'root_cause',
  'export_governance_evidence',
  'freeze_baseline',
  'compare_corpus',
  'triage_regression',
  'estimate_aad_greeks',
  'valuation_explain',
  'scenario',
])

/** Attach the live request to a fixture tool's args when it accepts one. */
function withRequest(tool: string, args: unknown, request: unknown): unknown {
  if (!TOOLS_WITH_REQUEST.has(tool)) return args
  const base = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  return { ...base, request }
}

/** Shared plumbing: subscribe to the request key + level, debounce the call. */
function useRigaTool<T>(
  tool: string,
  buildArgs: () => unknown,
  options: ToolOptions = {},
): AsyncState<T> {
  const key = useRigaRequestStore((s) => s.key)
  const request = useRigaRequestStore((s) => s.request)
  const level = useObservabilityStore((s) => s.level)
  const enabled = options.enabled ?? true
  const extra = options.deps ?? []
  return useDebouncedAsync<T>(
    () =>
      enabled
        ? riga.callTool<T>(tool, withRequest(tool, buildArgs(), request))
        : Promise.resolve(null as unknown as T),
    [tool, key, level, enabled, ...extra],
  )
}

// --- Connection / health ----------------------------------------------------

export function useRigaHealth(): AsyncState<RigaHealth> {
  return useRigaTool<RigaHealth>('health', () => ({}), { deps: [] })
}

// --- Pricing / attribution --------------------------------------------------

/** The pinned-fixture `price_put` round-trip (the connect test, §14). */
export function useRigaPrice(): AsyncState<RigaPricePut> {
  return useRigaTool<RigaPricePut>('price_put', () => ({}))
}

/** The trade/market controls' custom `price_trade` request. */
export function useRigaTradePrice(): AsyncState<RigaPriceResult> {
  const request = useRigaRequestStore((s) => s.request)
  return useRigaTool<RigaPriceResult>('price_trade', () => ({ request }), { deps: [request] })
}

export function useRigaAttribution(): AsyncState<ExplainPvAttribution> {
  return useRigaTool<ExplainPvAttribution>('explain_pv_attribution', () => ({}))
}

export function useRigaMarkets(): AsyncState<{ markets: RigaMarketEntry[] }> {
  return useRigaTool<{ markets: RigaMarketEntry[] }>('list_markets', () => ({}))
}

export function useRigaMarket(): AsyncState<RigaMarketEntry> {
  return useRigaTool<RigaMarketEntry>('get_market', () => ({}))
}

export function useRigaLedger(): AsyncState<LedgerPayload> {
  return useRigaTool<LedgerPayload>('get_ledger', () => ({}))
}

// --- Nets -------------------------------------------------------------------

export function useRigaExecutionNet(): AsyncState<ExecutionNet> {
  return useRigaTool<ExecutionNet>('query_execution_net', () => ({}))
}

export function useRigaRiskNet(): AsyncState<RiskNet> {
  return useRigaTool<RiskNet>('query_risk_net', () => ({}))
}

// --- Paths / events ---------------------------------------------------------

export function useRigaPathCube(percentile = 0.05): AsyncState<PathCubeQueryResponse> {
  const level = useObservabilityStore((s) => s.level)
  return useRigaTool<PathCubeQueryResponse>(
    'query_path_cube',
    () => ({ percentile, maxSample: 16 }),
    { enabled: level !== 'off', deps: [percentile] },
  )
}

export function useRigaExecutionTape(maxPaths = 16): AsyncState<ExecutionTape> {
  const level = useObservabilityStore((s) => s.level)
  return useRigaTool<ExecutionTape>('execution_events', () => ({ maxPaths }), {
    enabled: level !== 'off',
    deps: [maxPaths],
  })
}

export function useRigaPath(pathId: string | null): AsyncState<PathRecord> {
  const level = useObservabilityStore((s) => s.level)
  return useRigaTool<PathRecord>('get_path', () => ({ pathId }), {
    enabled: level !== 'off' && Boolean(pathId),
    deps: [pathId],
  })
}

export async function replayRigaPath(pathId: string): Promise<PathRecord> {
  return riga.callTool<PathRecord>('replay_path', {
    pathId,
    request: useRigaRequestStore.getState().request,
  })
}

// --- Statistics / diagnostics ----------------------------------------------

export function useRigaBranchStats(): AsyncState<TransitionStats[]> {
  return useRigaTool<TransitionStats[]>('get_branch_stats', () => ({}))
}

export function useRigaDistributions(): AsyncState<RigaDistributions> {
  return useRigaTool<RigaDistributions>('get_distributions', () => ({}))
}

export function useRigaMcDiagnostics(): AsyncState<RigaMcDiagnostics> {
  return useRigaTool<RigaMcDiagnostics>('get_mc_diagnostics', () => ({}))
}

/** Monte-Carlo convergence series (PV / SE / CI / KI / KO vs path count). */
export function useRigaMcConvergence(): AsyncState<RigaMcConvergence> {
  return useRigaTool<RigaMcConvergence>('mc_convergence', () => ({}))
}

/** Per-leg cashflow mean, sampled paths and coupon timeline (`build_cashflows`). */
export function useRigaCashflows(): AsyncState<RigaCashflows> {
  return useRigaTool<RigaCashflows>('build_cashflows', () => ({}))
}

/** Per-metric histograms + percentiles (`distributions_histogram`). */
export function useRigaDistributionsHistogram(): AsyncState<RigaDistributionsHistogram> {
  return useRigaTool<RigaDistributionsHistogram>('distributions_histogram', () => ({}))
}

/** Detailed risk: θ/ρ/cross-gamma/vega buckets + per-asset Δ/Γ/ν (`risk_detailed`). */
export function useRigaRiskDetailed(): AsyncState<RigaRiskDetailed> {
  return useRigaTool<RigaRiskDetailed>('risk_detailed', () => ({}))
}

// --- Risk -------------------------------------------------------------------

export function useRigaRiskBatch(): AsyncState<RigaRiskBatch> {
  return useRigaTool<RigaRiskBatch>('risk_batch', () => ({}))
}

export function useRigaBookRisk(notionals: number[]): AsyncState<RigaBookRisk> {
  return useRigaTool<RigaBookRisk>('compute_book_risk', () => ({ notionals }), {
    enabled: notionals.length > 0,
    deps: [JSON.stringify(notionals)],
  })
}

export function useRigaScenario(): AsyncState<RigaScenario> {
  return useRigaTool<RigaScenario>('scenario', () => ({}))
}

export function useRigaValidateGreeks(): AsyncState<{ flags: RigaValidationFlag[] }> {
  return useRigaTool<{ flags: RigaValidationFlag[] }>('validate_greeks', () => ({}))
}

export function useRigaStressBands(): AsyncState<{ recommendations: RigaStressBand[] }> {
  return useRigaTool<{ recommendations: RigaStressBand[] }>('recommend_scenarios', () => ({}))
}

// --- Explain ----------------------------------------------------------------

export function useRigaPlExplain(): AsyncState<RigaPlExplain> {
  const level = useObservabilityStore((s) => s.level)
  return useRigaTool<RigaPlExplain>('pl_explain', () => DEFAULT_MOVES, {
    enabled: level !== 'off',
  })
}

export function useRigaValuationExplain(): AsyncState<RigaValuationExplain> {
  const level = useObservabilityStore((s) => s.level)
  return useRigaTool<RigaValuationExplain>('valuation_explain', () => DEFAULT_MOVES, {
    enabled: level !== 'off',
  })
}

export function useRigaRootCause(): AsyncState<RigaRootCause> {
  const level = useObservabilityStore((s) => s.level)
  return useRigaTool<RigaRootCause>('root_cause', () => ({}), { enabled: level === 'full' })
}

export function useRigaGovernanceEvidence(): AsyncState<RigaGovernanceEvidence> {
  const level = useObservabilityStore((s) => s.level)
  return useRigaTool<RigaGovernanceEvidence>('export_governance_evidence', () => ({}), {
    enabled: level === 'full',
  })
}

// --- Regression -------------------------------------------------------------

export function useRigaCompareCorpus(): AsyncState<RigaRegressionResult> {
  return useRigaTool<RigaRegressionResult>('compare_corpus', () => ({}))
}

export function useRigaTriageRegression(): AsyncState<RigaRegressionResult> {
  return useRigaTool<RigaRegressionResult>('triage_regression', () => ({}))
}

export async function freezeRigaBaseline(name = 'default'): Promise<RigaBaseline> {
  return riga.callTool<RigaBaseline>('freeze_baseline', {
    name,
    request: useRigaRequestStore.getState().request,
  })
}

/**
 * `price_book_async` (§3.5 tasks): returns either a task (client advertises the
 * capability) or the inline `compute_book_risk` payload. Both shapes are
 * handled here, and a task is polled via `tasks/get`.
 */
export async function priceBookAsync(
  notionals: number[],
  onProgress?: (task: RigaTask) => void,
): Promise<RigaBookRisk> {
  const result = await riga.callTool<Record<string, unknown>>('price_book_async', {
    notionals,
    request: useRigaRequestStore.getState().request,
  })
  if (result && typeof result === 'object' && 'taskId' in result) {
    let task = result as unknown as RigaTask
    for (let attempt = 0; attempt < 120; attempt++) {
      onProgress?.(task)
      if (task.status === 'completed' || task.status === 'succeeded') {
        return (task.result ?? {}) as RigaBookRisk
      }
      if (task.status === 'failed' || task.status === 'cancelled') {
        throw new Error(task.message ?? `book task ${task.status}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
      task = await riga.getTask(task.taskId)
    }
    throw new Error('book task timed out')
  }
  return result as unknown as RigaBookRisk
}

/** The 6 riga-flow prompts, for the local-agent panel (§12.4). */
export const RIGA_PROMPTS = [
  'explain_pv_change',
  'investigate_validation_failure',
  'triage_regression',
  'summarise_risk_report',
  'recommend_stress_scenarios',
  'compose_governance_section',
] as const
