import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRdApi, RdApiError } from '../rdApi'
describe('R&D API read-only boundary', () => {
  afterEach(() => vi.restoreAllMocks())
  it('normalizes experiment, run, and result envelopes', async () => {
    const callTool = vi.fn(async (name: string) => name === 'rd_exp_list' ? { experiments: [{ experiment_id: 7, name: 'alpha', run_count: 1, latest_run: { run_id: 'r1', status: 'FINISHED' } }] } : name === 'rd_exp_get_experiment' ? { experiment: { experiment_id: 7, name: 'alpha' }, runs: [{ meta: { run_id: 'r1', status: 'FINISHED' } }] } : { run_id: 'r1', experiment_id: '7', headline: { IC: 0.12 }, ic_series: [{ value: 0.12 }], warnings: [] })
    const api = createRdApi({ callTool })
    expect((await api.listExperiments())[0]).toEqual(expect.objectContaining({ experimentId: '7', name: 'alpha', runCount: 1, latestRun: expect.objectContaining({ runId: 'r1' }) }))
    expect((await api.getExperiment('7')).runs[0]?.meta).toEqual(expect.objectContaining({ runId: 'r1' }))
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
  })
  it('sends safe experiment and run payloads', async () => {
    const callTool = vi.fn(async (name: string) => name === 'rd_trace_start' ? { experiment_id: 9 } : { status: 'started', background: true })
    const api = createRdApi({ callTool })
    await api.createExperiment({ rational: 'test hypothesis', experimentName: 'alpha' })
    await api.createRun({ experimentName: 'alpha', trainStart: '2025-01-01', trainEnd: '2025-12-31', wait: false })
    expect(callTool).toHaveBeenNthCalledWith(1, 'rd_trace_start', { rational: 'test hypothesis', experiment_name: 'alpha' })
    expect(callTool).toHaveBeenNthCalledWith(2, 'rd_train', expect.objectContaining({ experiment_name: 'alpha', train_start: '2025-01-01', train_end: '2025-12-31', wait: false }))
  })
  it('maps missing sidecar failures to unavailable', async () => {
    const api = createRdApi({ callTool: async () => { throw new Error('TAC_LAKE_DIR is not set') } })
    await expect(api.listExperiments()).rejects.toMatchObject<Partial<RdApiError>>({ kind: 'unavailable', tool: 'rd_exp_list' })
  })
})
