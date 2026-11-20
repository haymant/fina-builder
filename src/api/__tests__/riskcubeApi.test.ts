import { describe, expect, it } from 'vitest'
import { createRiskCubeApi, RiskCubeError } from '../riskcubeApi'

const capability = { engine: 'fixture-olap', version: '1.0', schema: 'fina.risk-report/v1', dimensions: ['scenario_key', 'underlying'], measures: ['pv_amount', 'delta'], aggregations: ['sum'], max_rows: 100, max_cells: 1000 }
const partition = { partition_id: 'part-1', version_id: 'v1', scenario_id: 'base', name: 'Fixture base', cell_count: 2, instance_count: 1, source: 'fixture', first_at: '2026-11-20T09:00:00Z', last_at: '2026-11-20T09:00:00Z' }
const report = { schema: 'fina.risk-report/v1', query: { scope: { partition_id: 'part-1' }, dimensions: ['scenario_key', 'underlying'], measures: ['pv_amount', 'delta'], aggregation: 'sum', filters: [], limit: 100 }, scope: { partition_id: 'part-1' }, columns: [{ key: 'scenario_key', label: 'Scenario', wire_type: 'string' }, { key: 'pv_amount', label: 'PV', wire_type: 'decimal', unit: 'currency_amount', currency: 'USD' }], rows: [['base', '1250000.125']], totals: null, truncated: false, warnings: [], assumptions: [], limitations: [], provenance: { snapshot_id: 'snap-fixture' }, lineage: {}, engine_run_id: 'run-1', snapshot_id: 'snap-fixture' }

describe('riskCubeApi', () => {
  it('normalizes capability, partition, and report DTOs', async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const api = createRiskCubeApi({ callTool: async (name, args = {}) => { calls.push([name, args]); return name === 'riskcube_capabilities' ? capability : name === 'risk_cube_partitions' ? { partitions: [partition] } : report } })
    const c = await api.capabilities(); const p = await api.partitions(); const r = await api.query({ scope: { partitionId: 'part-1' }, dimensions: ['scenario_key', 'underlying'], measures: ['pv_amount', 'delta'], aggregation: 'sum', filters: [], limit: 100 }, c)
    expect(c.dimensions).toEqual(['scenario_key', 'underlying']); expect(p[0]?.partitionId).toBe('part-1'); expect(r.columns[1]?.wireType).toBe('decimal'); expect(calls.map(([name]) => name)).toEqual(['riskcube_capabilities', 'risk_cube_partitions', 'olap_query'])
  })
  it('rejects unsupported semantic identifiers and excessive limits', async () => {
    const api = createRiskCubeApi({ callTool: async () => capability })
    const c = await api.capabilities()
    await expect(api.query({ scope: { partitionId: 'part-1' }, dimensions: ['raw_sql'], measures: ['pv_amount'], aggregation: 'sum', filters: [], limit: 1 }, c)).rejects.toMatchObject({ name: 'RiskCubeError', kind: 'validation' })
    await expect(api.query({ scope: { partitionId: 'part-1' }, dimensions: ['scenario_key'], measures: ['pv_amount'], aggregation: 'sum', filters: [], limit: 101 }, c)).rejects.toMatchObject({ name: 'RiskCubeError', kind: 'validation' })
  })
  it('exposes only the named read-only operations', async () => {
    const api = createRiskCubeApi({ callTool: async () => ({}) })
    expect('write' in api).toBe(false)
    expect(RiskCubeError).toBeDefined()
  })
  it.each([
    ['missing sidecar', 'RiskCube OLAP service is not configured', 'unavailable'],
    ['timeout', 'request timed out after 30000ms', 'timeout'],
    ['not found', 'partition not found', 'not_found'],
    ['validation', 'backend validation rejected the query', 'validation'],
    ['backend', 'OLAP engine failed while evaluating query', 'backend'],
  ] as const)('classifies %s failures', async (_label, message, kind) => {
    const api = createRiskCubeApi({ callTool: async () => { throw new Error(message) } })
    await expect(api.partitions()).rejects.toMatchObject({ name: 'RiskCubeError', kind, tool: 'risk_cube_partitions' })
  })
  it('redacts credentials from classified backend errors', async () => {
    const api = createRiskCubeApi({ callTool: async () => { throw new Error('connect https://alice:supersecret@example.test/cube with api_key=raw-secret') } })
    await expect(api.capabilities()).rejects.toMatchObject({ name: 'RiskCubeError', kind: 'backend', message: 'connect https://[REDACTED]@example.test/cube with api_key=[REDACTED]' })
  })
})
