import { invoke } from '@tauri-apps/api/core'
import { createHttpMcpTransport, unwrapToolResult } from './rigaTransport'
import { toSnakeKeys } from './keyCase'

export type RiskCubeErrorKind = 'unavailable' | 'capability' | 'backend' | 'validation' | 'timeout' | 'not_found'
export class RiskCubeError extends Error {
  readonly kind: RiskCubeErrorKind
  readonly tool?: string
  constructor(message: string, kind: RiskCubeErrorKind, tool?: string) { super(message); this.name = 'RiskCubeError'; this.kind = kind; this.tool = tool }
}

export interface RiskCubeTransport { callTool(name: string, args?: Record<string, unknown>): Promise<unknown> }
export interface RiskCubeCapability {
  engine: string
  version: string
  schema: string
  dimensions: string[]
  measures: string[]
  aggregations: string[]
  maxRows: number
  maxCells: number
}
export interface RiskCubePartition {
  partitionId: string
  versionId: string | null
  scenarioId: string | null
  name: string | null
  cellCount: number | null
  instanceCount: number | null
  source: string | null
  firstAt: string | null
  lastAt: string | null
}
export interface RiskCubeColumn {
  key: string
  label: string
  wireType: string
  unit?: string | null
  currency?: string | null
  displayScale?: number | null
  source?: string | null
}
export interface RiskCubeScope { partitionId: string; versionId?: string; scenarioId?: string; sliceId?: string }
export interface RiskCubeQuery {
  scope: RiskCubeScope
  dimensions: string[]
  measures: string[]
  aggregation: string
  filters: Array<{ field: string; operator: 'eq' | 'in'; value: string | string[] }>
  limit: number
}
export interface RiskCubeReport {
  schema: string
  query: RiskCubeQuery
  scope: RiskCubeScope
  columns: RiskCubeColumn[]
  rows: unknown[][]
  totals: unknown[] | null
  truncated: boolean
  nextCursor: string | null
  provenance: Record<string, unknown>
  assumptions: string[]
  limitations: string[]
  lineage: Record<string, unknown>
  warnings: string[]
  engineRunId: string | null
  snapshotId: string | null
}

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const array = (v: unknown, key?: string): unknown[] => Array.isArray(v) ? v : key && Array.isArray(record(v)[key]) ? record(v)[key] as unknown[] : []
const text = (v: unknown): string | null => v === null || v === undefined ? null : String(v)
const integer = (v: unknown, fallback = 0): number => typeof v === 'number' && Number.isSafeInteger(v) ? v : fallback

function normalizeCapability(v: unknown): RiskCubeCapability {
  const r = record(v)
  return { engine: text(r.engine) ?? 'unknown', version: text(r.version) ?? 'unknown', schema: text(r.schema) ?? 'fina.risk-report/v1', dimensions: array(r.dimensions).map(String), measures: array(r.measures).map(String), aggregations: array(r.aggregations).map(String), maxRows: integer(r.max_rows ?? r.maxRows, 1000), maxCells: integer(r.max_cells ?? r.maxCells, 10000) }
}
function normalizePartition(v: unknown): RiskCubePartition {
  const r = record(v)
  return { partitionId: text(r.partition_id ?? r.partitionId ?? r.id) ?? '', versionId: text(r.version_id ?? r.versionId), scenarioId: text(r.scenario_id ?? r.scenarioId), name: text(r.name), cellCount: integer(r.cell_count ?? r.cellCount, 0), instanceCount: integer(r.instance_count ?? r.instanceCount, 0), source: text(r.source), firstAt: text(r.first_at ?? r.firstAt), lastAt: text(r.last_at ?? r.lastAt) }
}
function normalizeReport(v: unknown): RiskCubeReport {
  const r = record(v)
  const q = record(r.query)
  const scope = record(r.scope)
  const query: RiskCubeQuery = { scope: { partitionId: text(scope.partition_id ?? scope.partitionId) ?? '', versionId: text(scope.version_id ?? scope.versionId) ?? undefined, scenarioId: text(scope.scenario_id ?? scope.scenarioId) ?? undefined, sliceId: text(scope.slice_id ?? scope.sliceId) ?? undefined }, dimensions: array(q.dimensions).map(String), measures: array(q.measures).map(String), aggregation: text(q.aggregation) ?? 'sum', filters: array(q.filters).map((f) => { const x = record(f); return { field: text(x.field) ?? '', operator: (text(x.operator) === 'in' ? 'in' : 'eq') as 'eq' | 'in', value: Array.isArray(x.value) ? x.value.map(String) : text(x.value) ?? '' } }), limit: integer(q.limit, 1000) }
  return { schema: text(r.schema) ?? 'fina.risk-report/v1', query, scope: query.scope, columns: array(r.columns).map((c) => { const x = record(c); return { key: text(x.key) ?? '', label: text(x.label) ?? text(x.key) ?? '', wireType: text(x.wire_type ?? x.wireType) ?? 'string', unit: text(x.unit), currency: text(x.currency), displayScale: integer(x.display_scale ?? x.displayScale, 0), source: text(x.source) } }), rows: array(r.rows).map((row) => Array.isArray(row) ? row : []), totals: Array.isArray(r.totals) ? r.totals : null, truncated: r.truncated === true, nextCursor: text(r.next_cursor ?? r.nextCursor), provenance: record(r.provenance), assumptions: array(r.assumptions).map(String), limitations: array(r.limitations).map(String), lineage: record(r.lineage), warnings: array(r.warnings).map(String), engineRunId: text(r.engine_run_id ?? r.engineRunId), snapshotId: text(r.snapshot_id ?? r.snapshotId) }
}

function redact(message: string): string { return message.replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+):([^\s/@]+)@/ig, '$1[REDACTED]@').replace(/(password|secret|token|api[_-]?key)\s*[=:]\s*[^\s,;]+/ig, '$1=[REDACTED]') }
function errorFor(tool: string, cause: unknown): RiskCubeError { if (cause instanceof RiskCubeError) return cause; const message = redact(cause instanceof Error ? cause.message : String(cause)); const lower = message.toLowerCase(); const kind: RiskCubeErrorKind = lower.includes('timeout') || lower.includes('timed out') ? 'timeout' : lower.includes('not found') ? 'not_found' : lower.includes('not configured') || lower.includes('could not reach') || lower.includes('unavailable') ? 'unavailable' : lower.includes('capability') || lower.includes('unsupported') ? 'capability' : lower.includes('invalid') || lower.includes('allowlist') || lower.includes('validation') ? 'validation' : 'backend'; return new RiskCubeError(message, kind, tool) }

const READ_ONLY_TOOLS = new Set(['riskcube_capabilities', 'risk_cube_partitions', 'olap_query'])
const asArgs = (args: Record<string, unknown>): Record<string, unknown> => toSnakeKeys(args) as Record<string, unknown>

export function createRiskCubeApi(transport: RiskCubeTransport) {
  async function call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> { if (!READ_ONLY_TOOLS.has(tool)) throw new RiskCubeError(`RiskCube tool is not allowed: ${tool}`, 'validation', tool); try { return await transport.callTool(tool, args) as T } catch (cause) { throw errorFor(tool, cause) } }
  async function capabilities() { return normalizeCapability(await call('riskcube_capabilities')) }
  async function partitions() { return array(await call('risk_cube_partitions'), 'partitions').map(normalizePartition) }
  async function query(request: RiskCubeQuery, capability: RiskCubeCapability): Promise<RiskCubeReport> {
    if (!request.scope.partitionId) throw new RiskCubeError('A partition scope is required', 'validation', 'olap_query')
    if (!request.dimensions.length || request.dimensions.some((d) => !capability.dimensions.includes(d))) throw new RiskCubeError('Query contains an unsupported dimension', 'validation', 'olap_query')
    if (!request.measures.length || request.measures.some((m) => !capability.measures.includes(m))) throw new RiskCubeError('Query contains an unsupported measure', 'validation', 'olap_query')
    if (!capability.aggregations.includes(request.aggregation)) throw new RiskCubeError('Query contains an unsupported aggregation', 'validation', 'olap_query')
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > capability.maxRows) throw new RiskCubeError(`Query limit must be between 1 and ${capability.maxRows}`, 'validation', 'olap_query')
    const result = await call('olap_query', request as unknown as Record<string, unknown>)
    return normalizeReport(result)
  }
  return { capabilities, partitions, query }
}

export function riskCubeBaseUrl(): string { return (import.meta.env.VITE_RISKCUBE_MCP_URL as string | undefined) ?? '/riskcube' }
function inTauri() { return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window }
const httpClient = createHttpMcpTransport(riskCubeBaseUrl())
const httpTransport: RiskCubeTransport = { callTool: async (name, args = {}) => unwrapToolResult(await httpClient.callTool<Record<string, unknown>>(name, asArgs(args)), name) }
const tauriTransport: RiskCubeTransport = { callTool: async (name, args = {}) => unwrapToolResult(await invoke<Record<string, unknown>>('riskcube_mcp_call_tool', { name, arguments: asArgs(args) }), name) }
let activeTransport: RiskCubeTransport = inTauri() ? tauriTransport : httpTransport
export function setRiskCubeTransport(transport: RiskCubeTransport | null) { activeTransport = transport ?? (inTauri() ? tauriTransport : httpTransport) }
export const riskCubeApi = createRiskCubeApi({ callTool: (name, args) => activeTransport.callTool(name, args) })
