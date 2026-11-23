import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRdApi, lakeRecoveryRequest, RdApiError } from '../rdApi'
describe('R&D API read-only boundary', () => {
  afterEach(() => vi.restoreAllMocks())
  it('normalizes experiment, run, and result envelopes', async () => {
    const callTool = vi.fn(async (name: string) => name === 'rd_exp_list' ? { experiments: [{ experiment_id: 7, name: 'alpha', run_count: 1, latest_run: { run_id: 'r1', status: 'FINISHED' }, best_headline: { IC: 0.1, ICIR: 0.5, 'Rank IC': 0.09, 'Rank ICIR': 0.45, AnnReturn: 0.2, MaxDD: -0.1 } }] } : name === 'rd_exp_get_experiment' ? { experiment: { experiment_id: 7, name: 'alpha' }, runs: [{ meta: { run_id: 'r1', status: 'FINISHED' }, metrics: { IC: 0.11, ICIR: 0.6, '1day.excess_return_with_cost.annualized_return': 0.25, '1day.excess_return_with_cost.max_drawdown': -0.08 } }] } : { run_id: 'r1', experiment_id: '7', headline: { IC: 0.12 }, ic_series: [{ value: 0.12 }], warnings: [] })
    const api = createRdApi({ callTool })
    expect((await api.listExperiments())[0]).toEqual(expect.objectContaining({ experimentId: '7', name: 'alpha', runCount: 1, latestRun: expect.objectContaining({ runId: 'r1' }), bestHeadline: expect.objectContaining({ IC: 0.1, 'Rank IC': 0.09, AnnReturn: 0.2, MaxDD: -0.1 }) }))
    const run = (await api.getExperiment('7')).runs[0]
    expect(run?.meta).toEqual(expect.objectContaining({ runId: 'r1' }))
    expect(run?.metricsLatest).toEqual(expect.objectContaining({ IC: 0.11, ICIR: 0.6, '1day.excess_return_with_cost.annualized_return': 0.25, '1day.excess_return_with_cost.max_drawdown': -0.08 }))
    expect(await api.getResult('r1', '7')).toEqual(expect.objectContaining({ runId: 'r1', experimentId: '7', icSeries: [{ value: 0.12 }] }))
    expect(callTool).toHaveBeenNthCalledWith(1, 'rd_exp_list', {})
    expect(callTool).toHaveBeenNthCalledWith(2, 'rd_exp_get_experiment', { experiment_id: '7' })
    expect(callTool).toHaveBeenNthCalledWith(3, 'rd_exp_result', { run_id: 'r1', experiment_id: '7' })
  })
  it('exposes only named supported mutation methods', () => {
    const api = createRdApi({ callTool: vi.fn() })
    expect(api).toHaveProperty('createExperiment')
    expect(api).toHaveProperty('createRun')
    expect(api).not.toHaveProperty('deleteExperiment')
    expect(api).not.toHaveProperty('setNotes')
    expect(api).toHaveProperty('validateWorkflowYaml')
    expect(api).toHaveProperty('runWorkflowYaml')
  })
  it('sends safe experiment and run payloads', async () => {
    const callTool = vi.fn(async (name: string) => name === 'rd_trace_start' ? { experiment_id: 9 } : { status: 'started', background: true })
    const api = createRdApi({ callTool })
    await api.createExperiment({ rational: 'test hypothesis', experimentName: 'alpha' })
    await api.createRun({ experimentName: 'alpha', trainStart: '2025-01-01', trainEnd: '2025-12-31', wait: false })
    expect(callTool).toHaveBeenNthCalledWith(1, 'rd_trace_start', { rational: 'test hypothesis', experiment_name: 'alpha' })
    expect(callTool).toHaveBeenNthCalledWith(2, 'rd_train', expect.objectContaining({ experiment_name: 'alpha', train_start: '2025-01-01', train_end: '2025-12-31', wait: false }))
  })
  it('preflights persisted fields and sends feature-aware runs', async () => {
    const callTool = vi.fn(async (name: string) => name === 'rd_status' ? { market: 'US', symbol_count: 2, features: [{ timeframe: '1d', columns: ['rsi_14', 'macro_vix'] }] } : name === 'rd_dataset' ? { feature_fields: ['$close', '$rsi_14', '$macro_vix'], universe: ['AAPL', 'MSFT'], universe_size: 2, segments: { train: { rows: 10 } }, all_nan_dropped: [], nan_ratio_nonzero: {} } : { status: 'started' })
    const api = createRdApi({ callTool })
    expect((await api.getStatus()).features[0]?.columns).toEqual(['rsi_14', 'macro_vix'])
    expect((await api.preflight({ trainStart: '2025-01-01', trainEnd: '2025-12-31', features: '$rsi_14,$macro_vix' })).featureFields).toEqual(['$close', '$rsi_14', '$macro_vix'])
    await api.createRun({ experimentName: 'alpha', trainStart: '2025-01-01', trainEnd: '2025-12-31', features: '$rsi_14,$macro_vix', validStart: '2026-01-01', validEnd: '2026-02-01' })
    expect(callTool).toHaveBeenLastCalledWith('rd_train', expect.objectContaining({ features: '$rsi_14,$macro_vix', valid_start: '2026-01-01', valid_end: '2026-02-01', record_analysis: true }))
  })
  it('normalizes paginated dataset rows and preserves the named query contract', async () => {
    const callTool = vi.fn(async () => ({ run_id: 'r1', experiment_id: 7, group: 'train', instrument: 'AAPL', instruments: ['AAPL', 'MSFT'], columns: ['date', 'instrument', '$close', 'label'], rows: [{ date: '2026-01-02T00:00:00', instrument: 'AAPL', '$close': 10, label: 0.1 }], page: 2, page_size: 1, total: 3, has_next: true, sort: 'desc', provenance: { source: 'run-config' }, warnings: [] }))
    const api = createRdApi({ callTool })
    await expect(api.getDataset('r1', 'train', 'AAPL', 2, 1, 'desc', '7')).resolves.toMatchObject({ runId: 'r1', group: 'train', instrument: 'AAPL', page: 2, pageSize: 1, total: 3, hasNext: true, sort: 'desc', rows: [{ '$close': 10 }] })
    expect(callTool).toHaveBeenCalledWith('rd_exp_dataset', { run_id: 'r1', group: 'train', instrument: 'AAPL', page: 2, page_size: 1, sort: 'desc', experiment_id: '7' })
  })
  it('validates YAML on the service and dispatches the same exact text through rd_run_workflow', async () => {
    const configYaml = 'experiment_name: alpha\ntask: {}\n'
    const callTool = vi.fn(async (name: string) => name === 'rd_validate_workflow' ? {
      valid: true, experiment_name: 'alpha', model_class: 'RankICLGBModel', market: 'US', universe: 'SPY,QQQ',
      train: ['2020-01-01', '2023-12-31'], valid_window: ['2024-01-01', '2024-12-31'], test: ['2025-01-01', '2025-12-31'],
      seed: 2026, num_threads: 1, feature_fields: ['$close'], record_classes: ['SignalRecord', 'SigAnaRecord'],
      config_sha256: 'a'.repeat(64), determinism_profile: 'lightgbm-seeded-single-thread-v1',
      dataset_preflight: { universe_size: 2, universe: ['SPY', 'QQQ'], segments: { train: { rows: 12 } }, feature_fields: ['$close'], all_nan_dropped: [] },
    } : { status: 'started', background: true, process_mode: 'subprocess' })
    const api = createRdApi({ callTool })
    const checked = await api.validateWorkflowYaml(configYaml)
    expect(checked).toMatchObject({ valid: true, experimentName: 'alpha', seed: 2026, numThreads: 1, validWindow: ['2024-01-01', '2024-12-31'], datasetPreflight: { universeSize: 2 } })
    await api.runWorkflowYaml(configYaml, checked.experimentName)
    expect(callTool).toHaveBeenNthCalledWith(1, 'rd_validate_workflow', { config_yaml: configYaml })
    expect(callTool).toHaveBeenNthCalledWith(2, 'rd_run_workflow', { config_yaml: configYaml, experiment_name: 'alpha' })
  })
  it('maps missing sidecar failures to unavailable', async () => {
    const api = createRdApi({ callTool: async () => { throw new Error('TAC_LAKE_DIR is not set') } })
    await expect(api.listExperiments()).rejects.toMatchObject<Partial<RdApiError>>({ kind: 'unavailable', tool: 'rd_exp_list' })
  })
  it('classifies only bounded lake coverage failures into a loader request', () => {
    const yaml = 'instruments: SPY,QQQ\nstart_time: 2026-01-02\nend_time: 2026-08-10\nfreq: day\nmarket: US\n'
    expect(lakeRecoveryRequest(yaml, new Error('empty input; check requested lake coverage'))).toEqual({
      market: 'US', symbols: ['SPY', 'QQQ'], timeframe: '1d', start: '2026-01-02', end: '2026-08-10', reason: 'empty input; check requested lake coverage',
    })
    expect(lakeRecoveryRequest(yaml, new Error('invalid YAML syntax'))).toBeNull()
    expect(lakeRecoveryRequest(yaml.replace('SPY,QQQ', 'all'), new Error('missing lake data'))).toBeNull()
  })
})
