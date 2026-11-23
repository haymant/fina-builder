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

  it('allows only the two explicit qlib dataset representations', () => {
    const base = { run_id: 'run-1', group: 'train', instrument: 'AAPL', page: 1, page_size: 50, sort: 'asc' }
    expect(() => validateRdToolCall({ name: 'rd_exp_dataset', arguments: { ...base, representation: 'raw' } })).not.toThrow()
    expect(() => validateRdToolCall({ name: 'rd_exp_dataset', arguments: { ...base, representation: 'inference' } })).not.toThrow()
    expect(() => validateRdToolCall({ name: 'rd_exp_dataset', arguments: { ...base, representation: 'learn' } })).toThrow(/representation is invalid/)
  })

  it('accepts the complete named R&D execution sequence without shell/path escape hatches', () => {
    expect(() => validateRdToolCall({ name: 'rd_predict', arguments: { model_path: 'run/params.pkl', experiment_name: 'new-run', test_start: '2026-11-19', test_end: '2026-11-19' } })).not.toThrow()
    expect(() => validateRdToolCall({ name: 'rd_strategy_targets', arguments: { pred_path: 'run/pred.pkl', signal_date: '2026-11-19', account: 100000, topk: 2, n_drop: 1, risk_degree: 0.95, prices: '{}', risk_limits: '{}' } })).not.toThrow()
    expect(() => validateRdToolCall({ name: 'rd_backtest', arguments: { pred_path: 'run/pred.pkl', start_time: '2026-11-19', end_time: '2026-11-19', account: 100000, topk: 2, n_drop: 1 } })).not.toThrow()
    expect(() => validateRdToolCall({ name: 'rd_predict', arguments: { model_path: 'run/params.pkl', command: 'cat /etc/passwd' } })).toThrow(/argument is not allowed/)
  })

  it('accepts bounded writes and rejects path/precision escape hatches', () => {
    expect(() => validateTacToolCall({ name: 'place_order', arguments: { symbol: 'AAPL', side: 'buy', type: 'market', time_in_force: 'day', qty: '1.000000000000000001' } })).not.toThrow()
    expect(() => validateTacToolCall({ name: 'place_order', arguments: { symbol: 'AAPL', side: 'buy', type: 'market', time_in_force: 'day', qty: 1, path: '/tmp' } })).toThrow(/argument is not allowed/)
    expect(() => validateTacToolCall({ name: 'place_order', arguments: { symbol: 'AAPL', side: 'buy', type: 'market', time_in_force: 'day', qty: '1', notional: '2' } })).toThrow(/exactly one/)
    expect(() => validateRdToolCall({ name: 'rd_trace_start', arguments: { rational: 'test hypothesis', path: '/tmp' } })).toThrow(/argument is not allowed/)
    expect(() => validateRdToolCall({ name: 'rd_train', arguments: { out_dir: '/tmp' } })).toThrow(/argument is not allowed/)
  })

  it('admits only bounded declarative YAML validation and workflow dispatch', () => {
    const config = 'experiment_name: alpha\ntask: {}'
    expect(() => validateRdToolCall({ name: 'rd_validate_workflow', arguments: { config_yaml: config } })).not.toThrow()
    expect(() => validateRdToolCall({ name: 'rd_run_workflow', arguments: { config_yaml: config, experiment_name: 'alpha' } })).not.toThrow()
    expect(() => validateRdToolCall({ name: 'rd_run_workflow', arguments: { config_yaml: config, experiment_name: 'alpha', config_path: '/tmp/x' } })).toThrow(/argument is not allowed/)
    expect(() => validateRdToolCall({ name: 'rd_run_workflow', arguments: { config_yaml: config, experiment_name: 'alpha', uri_folder: '/tmp' } })).toThrow(/argument is not allowed/)
    expect(() => validateRdToolCall({ name: 'rd_validate_workflow', arguments: { config_yaml: ' ' } })).toThrow(/non-empty/)
    expect(() => validateRdToolCall({ name: 'rd_validate_workflow', arguments: { config_yaml: 'x'.repeat(128 * 1024 + 1) } })).toThrow(/128 KiB/)
    expect(() => validateRdToolCall({ name: 'rd_run_workflow', arguments: { config_yaml: config, experiment_name: ' ' } })).toThrow(/experiment_name/)
  })

  it('accepts bounded semantic RiskCube queries and rejects SQL/path escape hatches', () => {
    expect(() => validateRiskcubeToolCall({ name: 'olap_query', arguments: { scope: { partitionId: 'p1' }, dimensions: ['underlying'], measures: ['pv_amount'], aggregation: 'sum', filters: [], limit: 10 } })).not.toThrow()
    expect(() => validateRiskcubeToolCall({ name: 'olap_query', arguments: { sql: 'select * from riskcube_cells', limit: 10 } })).toThrow(/argument is not allowed: sql/)
    expect(() => validateRiskcubeToolCall({ name: 'olap_query', arguments: { uri: 'file:///tmp/cube', limit: 10 } })).toThrow(/argument is not allowed: uri/)
    expect(() => validateRiskcubeToolCall({ name: 'olap_query', arguments: { scope: {}, dimensions: [], measures: [], aggregation: 'sum', filters: [], limit: '10' } })).toThrow(/query limit is required/)
    expect(() => validateRiskcubeToolCall({ name: 'riskcube_capabilities', arguments: { path: '/tmp/cube' } })).toThrow(/argument is not allowed: path/)
  })
})
