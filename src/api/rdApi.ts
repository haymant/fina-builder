import { invoke } from '@tauri-apps/api/core'
import { createHttpMcpTransport, unwrapToolResult } from './rigaTransport'
import { toSnakeKeys } from './keyCase'

export type RdErrorKind = 'unavailable' | 'backend' | 'validation' | 'timeout'

export class RdApiError extends Error {
  readonly kind: RdErrorKind
  readonly tool?: string
  constructor(message: string, kind: RdErrorKind, tool?: string) {
    super(message)
    this.name = 'RdApiError'
    this.kind = kind
    this.tool = tool
  }
}

export interface RdTransport {
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>
}
export interface RdExperiment {
  experimentId: string
  name: string | null
  lifecycleStage: string | null
  runCount: number
  latestRun: RdRunSummary | null
  bestHeadline: Record<string, unknown>
}
export interface RdRunSummary {
  runId: string
  name: string | null
  status: string | null
  startTime: string | null
  headline: Record<string, unknown>
}
export interface RdRunMeta {
  runId: string
  name: string | null
  status: string | null
  experimentId: string | null
  startTime: string | null
  endTime: string | null
  sourceVersion: string | null
}
export interface RdRunDetail {
  meta: RdRunMeta | null
  params: Record<string, string>
  tags: Record<string, string>
  metrics: Record<string, unknown>
  metricsLatest: Record<string, unknown>
  headline: Record<string, unknown>
  notes: Record<string, unknown>
  artifacts: RdArtifact[]
}
export interface RdArtifact { path: string; size: number }
export interface RdLakeStatus { market: string; calendarDays: number; calendarStart: string | null; calendarEnd: string | null; symbols: string[]; symbolCount: number; features: { timeframe: string; columns: string[] }[] }
export interface RdDatasetPreflight { featureFields: string[]; label: string; universe: string[]; universeSize: number; segments: Record<string, unknown>; allNanDropped: string[]; nanRatioNonzero: Record<string, number>; window: Record<string, unknown> }
export interface RdBlotter {
  runId: string
  experimentId: string
  summary: Record<string, unknown>
  daily: Record<string, unknown>[]
  positions: Record<string, unknown>[]
  positionHistory: Record<string, unknown>[]
  trades: Record<string, unknown>[]
  signals: Record<string, unknown>[]
  warnings: string[]
}
export interface RdResult {
  runId: string
  experimentId: string
  metrics: Record<string, unknown>
  headline: Record<string, unknown>
  icSeries: Record<string, unknown>[]
  groupReturns: Record<string, unknown>
  backtest: Record<string, unknown>
  explanation: unknown
  warnings: string[]
  predStats: Record<string, unknown>
  icHistogram: Record<string, unknown>[]
  monthlyIc: Record<string, unknown>[]
}
export interface RdExperimentDraft { rational: string; details?: string; experimentName?: string; evolvedFrom?: string }
export interface RdRunConfig { experimentName: string; trainStart: string; trainEnd: string; validStart?: string; validEnd?: string; testStart?: string; testEnd?: string; universe?: string; market?: string; freq?: string; features?: string; label?: string; recordAnalysis?: boolean; wait?: boolean }
export interface RdWorkflowValidation { valid: boolean; experimentName: string; modelClass: string; market: string; universe: string; train: string[]; validWindow: string[]; test: string[]; seed: number; numThreads: number; featureFields: string[]; recordClasses: string[]; configSha256: string; determinismProfile: string; datasetPreflight: { universeSize: number; universe: string[]; segments: Record<string, unknown>; featureFields: string[]; allNanDropped: string[] } }
export interface RdLakeRecoveryRequest { market: string; symbols: string[]; timeframe: string; start: string; end: string; reason: string }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const array = (value: unknown, key: string): unknown[] => Array.isArray(value) ? value : Array.isArray(record(value)[key]) ? record(value)[key] as unknown[] : []
const text = (value: unknown): string | null => value === null || value === undefined ? null : String(value)
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : Number(value ?? 0) || 0
const yamlScalar = (yaml: string, key: string): string | null => {
  const match = yaml.match(new RegExp(`^\\s{0,16}${key}\\s*:\\s*["']?([^"'\\n#]+?)["']?\\s*(?:#.*)?$`, 'm'))
  return match?.[1]?.trim() || null
}
const yamlList = (yaml: string, key: string): string[] => {
  const value = yamlScalar(yaml, key)
  return value ? value.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean) : []
}
/**
 * Convert only the bounded handler fields into a lake-load request. This is
 * intentionally not a general YAML parser and never rewrites user-authored
 * configuration. It returns null unless the service error clearly indicates a
 * persisted-lake coverage/data problem.
 */
export function lakeRecoveryRequest(configYaml: string, error: unknown): RdLakeRecoveryRequest | null {
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()
  const coverageFailure = /(empty input|no rows|all[- ]?nan|missing.*(?:lake|data|feature)|(?:lake|coverage).*(?:missing|empty|hollow|requested|feature)|feature.*(?:missing|coverage|not found))/i.test(lower)
  if (!coverageFailure) return null
  const symbols = yamlList(configYaml, 'instruments')
  const market = (yamlScalar(configYaml, 'market') ?? 'US').toUpperCase()
  const freq = (yamlScalar(configYaml, 'freq') ?? 'day').toLowerCase()
  const start = yamlScalar(configYaml, 'start_time')
  const end = yamlScalar(configYaml, 'end_time')
  if (!symbols.length || symbols.length > 100 || symbols.includes('ALL') || symbols.some((symbol) => !/^[A-Z][A-Z0-9._-]{0,15}$/.test(symbol))) return null
  if (!start || !end || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null
  if (market !== 'US' || !['day', '1d'].includes(freq)) return null
  return { market, symbols, timeframe: '1d', start, end, reason: message }
}
function normalizeRunSummary(value: unknown): RdRunSummary | null {
  const raw = record(value)
  if (!raw.run_id && !raw.runId) return null
  return { runId: text(raw.run_id ?? raw.runId) ?? '', name: text(raw.name), status: text(raw.status), startTime: text(raw.start_time ?? raw.startTime), headline: record(raw.headline) }
}
function normalizeExperiment(value: unknown): RdExperiment {
  const raw = record(value)
  return { experimentId: text(raw.experiment_id ?? raw.experimentId) ?? '', name: text(raw.name), lifecycleStage: text(raw.lifecycle_stage ?? raw.lifecycleStage), runCount: number(raw.run_count ?? raw.runCount), latestRun: normalizeRunSummary(raw.latest_run ?? raw.latestRun), bestHeadline: record(raw.best_headline ?? raw.bestHeadline) }
}
function normalizeMeta(value: unknown): RdRunMeta | null {
  const raw = record(value)
  if (!Object.keys(raw).length) return null
  return { runId: text(raw.run_id ?? raw.runId) ?? '', name: text(raw.name), status: text(raw.status), experimentId: text(raw.experiment_id ?? raw.experimentId), startTime: text(raw.start_time ?? raw.startTime), endTime: text(raw.end_time ?? raw.endTime), sourceVersion: text(raw.source_version ?? raw.sourceVersion) }
}
function normalizeRun(value: unknown): RdRunDetail {
  const raw = record(value)
  return { meta: normalizeMeta(raw.meta), params: record(raw.params) as Record<string, string>, tags: record(raw.tags) as Record<string, string>, metrics: record(raw.metrics), metricsLatest: record(raw.metrics_latest ?? raw.metricsLatest), headline: record(raw.headline), notes: record(raw.notes), artifacts: array(raw.artifacts, '').map((item) => { const value = record(item); return { path: text(value.path) ?? String(item), size: number(value.size) } }) }
}
function errorFor(tool: string, cause: unknown): RdApiError {
  if (cause instanceof RdApiError) return cause
  const message = cause instanceof Error ? cause.message : String(cause)
  const lower = message.toLowerCase()
  const kind: RdErrorKind = lower.includes('timeout') || lower.includes('timed out') ? 'timeout' : lower.includes('not set') || lower.includes('not found') || lower.includes('not reachable') || lower.includes('could not reach') ? 'unavailable' : 'backend'
  const redacted = message.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+):([^\s/@]+)@/ig, '$1[REDACTED]@').replace(/(password|secret|token|api[_-]?key)\s*[=:]\s*[^\s,;]+/ig, '$1=[REDACTED]')
  return new RdApiError(redacted, kind, tool)
}
const ALLOWED_TOOLS = new Set(['rd_status', 'rd_dataset', 'rd_exp_list', 'rd_exp_get_experiment', 'rd_exp_get_run', 'rd_exp_input', 'rd_exp_result', 'rd_exp_model', 'rd_exp_blotter', 'rd_exp_lineage', 'rd_trace_start', 'rd_trace_get', 'rd_trace_list', 'rd_train', 'rd_validate_workflow', 'rd_run_workflow'])
export function createRdApi(transport: RdTransport) {
  async function call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!ALLOWED_TOOLS.has(tool)) throw new RdApiError(`R&D tool is not allowed: ${tool}`, 'validation', tool)
    try { return await transport.callTool(tool, args) as T } catch (cause) { throw errorFor(tool, cause) }
  }
  return {
    async getStatus(market = 'US'): Promise<RdLakeStatus> { const raw = record(await call('rd_status', { market })); return { market: text(raw.market) ?? market, calendarDays: number(raw.calendar_days ?? raw.calendarDays), calendarStart: text(raw.calendar_start ?? raw.calendarStart), calendarEnd: text(raw.calendar_end ?? raw.calendarEnd), symbols: array(raw.symbols, '').map(String), symbolCount: number(raw.symbol_count ?? raw.symbolCount), features: array(raw.features, '').map((item) => { const value = record(item); return { timeframe: text(value.timeframe) ?? '', columns: array(value.columns, '').map(String) } }) } },
    async preflight(config: Omit<RdRunConfig, 'experimentName' | 'wait'>): Promise<RdDatasetPreflight> { const raw = record(await call('rd_dataset', { market: config.market ?? 'US', universe: config.universe ?? 'all', freq: config.freq ?? 'day', features: config.features ?? '', label: config.label ?? '', train_start: config.trainStart, train_end: config.trainEnd, valid_start: config.validStart ?? '', valid_end: config.validEnd ?? '', test_start: config.testStart ?? '', test_end: config.testEnd ?? '' })); return { featureFields: array(raw.feature_fields ?? raw.featureFields, '').map(String), label: text(raw.label) ?? '', universe: array(raw.universe, '').map(String), universeSize: number(raw.universe_size ?? raw.universeSize), segments: record(raw.segments), allNanDropped: array(raw.all_nan_dropped ?? raw.allNanDropped, '').map(String), nanRatioNonzero: record(raw.nan_ratio_nonzero ?? raw.nanRatioNonzero) as Record<string, number>, window: record(raw.window) } },
    async listExperiments(): Promise<RdExperiment[]> { return array(await call('rd_exp_list'), 'experiments').map(normalizeExperiment) },
    async getExperiment(experimentId: string): Promise<{ experiment: RdExperiment | null; runs: RdRunDetail[] }> { const raw = record(await call('rd_exp_get_experiment', { experiment_id: experimentId })); return { experiment: raw.experiment ? normalizeExperiment(raw.experiment) : null, runs: array(raw.runs, '').map(normalizeRun) } },
    async getRun(runId: string, experimentId?: string): Promise<RdRunDetail> { return normalizeRun(await call('rd_exp_get_run', { run_id: runId, ...(experimentId ? { experiment_id: experimentId } : {}) })) },
    async getResult(runId: string, experimentId?: string): Promise<RdResult> { const raw = record(await call('rd_exp_result', { run_id: runId, ...(experimentId ? { experiment_id: experimentId } : {}) })); return { runId: text(raw.run_id ?? raw.runId) ?? runId, experimentId: text(raw.experiment_id ?? raw.experimentId) ?? experimentId ?? '', metrics: record(raw.metrics), headline: record(raw.headline), icSeries: array(raw.ic_series ?? raw.icSeries, '').map(record), icHistogram: array(raw.ic_histogram ?? raw.icHistogram, '').map(record), monthlyIc: array(raw.monthly_ic ?? raw.monthlyIc, '').map(record), groupReturns: record(raw.group_returns ?? raw.groupReturns), predStats: record(raw.pred_stats ?? raw.predStats), backtest: record(raw.backtest), explanation: record(raw.explanation), warnings: array(raw.warnings, '').map(String) } },
    async getModel(runId: string, experimentId?: string): Promise<Record<string, unknown>> { return record(await call('rd_exp_model', { run_id: runId, ...(experimentId ? { experiment_id: experimentId } : {}) })) },
    async getInput(runId: string, experimentId?: string): Promise<Record<string, unknown>> { return record(await call('rd_exp_input', { run_id: runId, ...(experimentId ? { experiment_id: experimentId } : {}) })) },
    async getBlotter(runId: string, experimentId?: string): Promise<RdBlotter> { const raw = record(await call('rd_exp_blotter', { run_id: runId, ...(experimentId ? { experiment_id: experimentId } : {}) })); return { runId: text(raw.run_id ?? raw.runId) ?? runId, experimentId: text(raw.experiment_id ?? raw.experimentId) ?? experimentId ?? '', summary: record(raw.summary), daily: array(raw.daily, '').map(record), positions: array(raw.positions, '').map(record), positionHistory: array(raw.position_history ?? raw.positionHistory, '').map(record), trades: array(raw.trades, '').map(record), signals: array(raw.signals, '').map(record), warnings: array(raw.warnings, '').map(String) } },
    async createExperiment(draft: RdExperimentDraft): Promise<Record<string, unknown>> { return record(await call('rd_trace_start', { rational: draft.rational, ...(draft.details ? { details: draft.details } : {}), ...(draft.experimentName ? { experiment_name: draft.experimentName } : {}), ...(draft.evolvedFrom ? { evolved_from: draft.evolvedFrom } : {}) })) },
    async getTraceExperiment(experimentId: string): Promise<Record<string, unknown>> { return record(await call('rd_trace_get', { experiment_id: experimentId })) },
    async listTraceExperiments(limit = 20): Promise<Record<string, unknown>[]> { return array(await call('rd_trace_list', { limit }), 'experiments').map(record) },
    async createRun(config: RdRunConfig): Promise<Record<string, unknown>> { return record(await call('rd_train', { experiment_name: config.experimentName, train_start: config.trainStart, train_end: config.trainEnd, wait: config.wait ?? false, record_analysis: config.recordAnalysis ?? true, ...(config.validStart ? { valid_start: config.validStart } : {}), ...(config.validEnd ? { valid_end: config.validEnd } : {}), ...(config.testStart ? { test_start: config.testStart } : {}), ...(config.testEnd ? { test_end: config.testEnd } : {}), ...(config.universe ? { universe: config.universe } : {}), ...(config.market ? { market: config.market } : {}), ...(config.freq ? { freq: config.freq } : {}), ...(config.features ? { features: config.features } : {}), ...(config.label ? { label: config.label } : {}) })) },
    async validateWorkflowYaml(configYaml: string): Promise<RdWorkflowValidation> { const raw = record(await call('rd_validate_workflow', { config_yaml: configYaml })); const preflight = record(raw.datasetPreflight ?? raw.dataset_preflight); return { valid: raw.valid === true, experimentName: text(raw.experimentName ?? raw.experiment_name) ?? '', modelClass: text(raw.modelClass ?? raw.model_class) ?? '', market: text(raw.market) ?? '', universe: text(raw.universe) ?? '', train: array(raw.train, '').map(String), validWindow: array(raw.validWindow ?? raw.valid_window, '').map(String), test: array(raw.test, '').map(String), seed: number(raw.seed), numThreads: number(raw.numThreads ?? raw.num_threads), featureFields: array(raw.featureFields ?? raw.feature_fields, '').map(String), recordClasses: array(raw.recordClasses ?? raw.record_classes, '').map(String), configSha256: text(raw.configSha256 ?? raw.config_sha256) ?? '', determinismProfile: text(raw.determinismProfile ?? raw.determinism_profile) ?? '', datasetPreflight: { universeSize: number(preflight.universeSize ?? preflight.universe_size), universe: array(preflight.universe, '').map(String), segments: record(preflight.segments), featureFields: array(preflight.featureFields ?? preflight.feature_fields, '').map(String), allNanDropped: array(preflight.allNanDropped ?? preflight.all_nan_dropped, '').map(String) } } },
    async runWorkflowYaml(configYaml: string, experimentName: string): Promise<Record<string, unknown>> { return record(await call('rd_run_workflow', { config_yaml: configYaml, experiment_name: experimentName })) },
  }
}
export function rdBaseUrl(): string { return (import.meta.env.VITE_RD_MCP_URL as string | undefined) ?? '/rd' }
function inTauri(): boolean { return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window }
const httpRdClient = createHttpMcpTransport(rdBaseUrl())
const httpRdTransport: RdTransport = { async callTool(name, args = {}) { return unwrapToolResult(await httpRdClient.callTool<Record<string, unknown>>(name, args), name) as unknown } }
const tauriRdTransport: RdTransport = { async callTool(name, args = {}) { return unwrapToolResult(await invoke<Record<string, unknown>>('rd_mcp_call_tool', { name, arguments: toSnakeKeys(args) }), name) as unknown } }
let activeRdTransport: RdTransport = inTauri() ? tauriRdTransport : httpRdTransport
export function setRdTransport(transport: RdTransport | null): void { activeRdTransport = transport ?? (inTauri() ? tauriRdTransport : httpRdTransport) }
export const rdApi = createRdApi({ callTool: (name, args) => activeRdTransport.callTool(name, args) })
