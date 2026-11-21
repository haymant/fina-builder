import { describe, expect, it } from 'vitest'
import { validateRdToolCall, validateRiskcubeToolCall, validateTacToolCall } from '../../../scripts/lib/mcpAllowlist.mjs'

describe('browser MCP host allowlists', () => {
  it('accepts only the named R&D read operations and identifiers', () => {
    expect(() => validateRdToolCall({ name: 'rd_status', arguments: { market: 'US' } })).not.toThrow()
    expect(() => validateRdToolCall({ name: 'rd_dataset', arguments: { market: 'US', universe: 'all', features: '$rsi_14' } })).not.toThrow()
    expect(() => validateRdToolCall({ name: 'rd_dataset', arguments: { lake_root: '/tmp/lake' } })).toThrow(/argument is not allowed: lake_root/)
    expect(() => validateRdToolCall({ name: 'rd_exp_result', arguments: { run_id: 'run-1', experiment_id: 'exp-1' } })).not.toThrow()
    expect(() => validateRdToolCall({ name: 'rd_exp_result', arguments: { uri: 'file:///tmp/x' } })).toThrow(/argument is not allowed: uri/)
    expect(() => validateRdToolCall({ name: 'rd_exp_result', arguments: { path: '/tmp/x' } })).toThrow(/argument is not allowed: path/)
    expect(() => validateRdToolCall({ name: 'rd_exp_result', arguments: { tracking_store: '/tmp/mlruns' } })).toThrow(/argument is not allowed: tracking_store/)
    expect(() => validateRdToolCall({ name: 'delete_experiment', arguments: {} })).toThrow(/tool is not allowed/)
  })

  it('accepts bounded writes and rejects path/precision escape hatches', () => {
    expect(() => validateTacToolCall({ name: 'place_order', arguments: { symbol: 'AAPL', side: 'buy', type: 'market', time_in_force: 'day', qty: '1.000000000000000001' } })).not.toThrow()
    expect(() => validateTacToolCall({ name: 'place_order', arguments: { symbol: 'AAPL', side: 'buy', type: 'market', time_in_force: 'day', qty: 1, path: '/tmp' } })).toThrow(/argument is not allowed/)
    expect(() => validateTacToolCall({ name: 'place_order', arguments: { symbol: 'AAPL', side: 'buy', type: 'market', time_in_force: 'day', qty: '1', notional: '2' } })).toThrow(/exactly one/)
    expect(() => validateRdToolCall({ name: 'rd_trace_start', arguments: { rational: 'test hypothesis', path: '/tmp' } })).toThrow(/argument is not allowed/)
    expect(() => validateRdToolCall({ name: 'rd_train', arguments: { out_dir: '/tmp' } })).toThrow(/argument is not allowed/)
  })

  it('accepts bounded semantic RiskCube queries and rejects SQL/path escape hatches', () => {
    expect(() => validateRiskcubeToolCall({ name: 'olap_query', arguments: { scope: { partitionId: 'p1' }, dimensions: ['underlying'], measures: ['pv_amount'], aggregation: 'sum', filters: [], limit: 10 } })).not.toThrow()
    expect(() => validateRiskcubeToolCall({ name: 'olap_query', arguments: { sql: 'select * from riskcube_cells', limit: 10 } })).toThrow(/argument is not allowed: sql/)
    expect(() => validateRiskcubeToolCall({ name: 'olap_query', arguments: { uri: 'file:///tmp/cube', limit: 10 } })).toThrow(/argument is not allowed: uri/)
    expect(() => validateRiskcubeToolCall({ name: 'olap_query', arguments: { scope: {}, dimensions: [], measures: [], aggregation: 'sum', filters: [], limit: '10' } })).toThrow(/query limit is required/)
    expect(() => validateRiskcubeToolCall({ name: 'riskcube_capabilities', arguments: { path: '/tmp/cube' } })).toThrow(/argument is not allowed: path/)
  })
})
