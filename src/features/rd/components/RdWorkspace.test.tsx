import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { rdApi } from '../../../api/rdApi'
import { RdWorkspace } from './RdWorkspace'

vi.mock('../../../api/rdApi', async () => {
  const actual = await vi.importActual<typeof import('../../../api/rdApi')>('../../../api/rdApi')
  return {
    ...actual,
    rdApi: {
      listExperiments: vi.fn(), getExperiment: vi.fn(), getResult: vi.fn(), getInput: vi.fn(),
      getModel: vi.fn(), getBlotter: vi.fn(), getDataset: vi.fn(),
    },
  }
})

const experiment = {
  experimentId: 'exp-1', name: 'alpha', lifecycleStage: 'active', runCount: 1,
  latestRun: { runId: 'run-1', name: 'baseline', status: 'FINISHED', startTime: '2026-01-01', headline: {} },
  bestHeadline: {},
}
const run = {
  meta: { runId: 'run-1', name: 'baseline', status: 'FINISHED', experimentId: 'exp-1', startTime: '2026-01-01', endTime: null, sourceVersion: null },
  params: {}, tags: {}, metrics: {}, metricsLatest: {}, headline: {}, notes: {}, artifacts: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(rdApi.listExperiments).mockResolvedValue([experiment])
  vi.mocked(rdApi.getExperiment).mockResolvedValue({ experiment, runs: [run] })
  vi.mocked(rdApi.getResult).mockResolvedValue({ runId: 'run-1', experimentId: 'exp-1', metrics: {}, headline: {}, icSeries: [], groupReturns: {}, backtest: {}, explanation: null, warnings: [], predStats: {}, icHistogram: [], monthlyIc: [] })
  vi.mocked(rdApi.getInput).mockResolvedValue({
    source: 'run-config',
    dataset: { handler_kwargs: { instruments: 'SPY' }, universe: ['SPY'], universe_size: 1, features: ['$close'], label: '$label', segments: {} },
    model: { class: 'LGBModel', module_path: 'qlib.contrib.model.gbdt', kwargs: {} },
  })
  vi.mocked(rdApi.getModel).mockResolvedValue({})
  vi.mocked(rdApi.getBlotter).mockResolvedValue({ runId: 'run-1', experimentId: 'exp-1', summary: {}, daily: [], positions: [], positionHistory: [], trades: [], signals: [], warnings: [] })
})

describe('R&D Dataset navigation', () => {
  it('adds a Dataset button to each Dashboard run Inspect action', async () => {
    const onNavigate = vi.fn()
    render(<RdWorkspace view="dashboard" onNavigate={onNavigate} />)

    const dataset = await screen.findByRole('button', { name: 'Dataset' })
    fireEvent.click(dataset)

    expect(onNavigate).toHaveBeenCalledWith({ kind: 'rd', view: 'dataset' })
  })

  it('adds a Dataset link to the Input title area and retains Dashboard navigation', async () => {
    const onNavigate = vi.fn()
    render(<RdWorkspace view="input" onNavigate={onNavigate} />)

    await screen.findByRole('heading', { name: 'Input' })
    await waitFor(() => expect(rdApi.getInput).toHaveBeenCalled())
    onNavigate.mockClear()

    fireEvent.click(screen.getByRole('button', { name: 'Dataset' }))
    expect(onNavigate).toHaveBeenCalledWith({ kind: 'rd', view: 'dataset' })
    expect(screen.getByRole('button', { name: /Dashboard/ })).toBeInTheDocument()
  })
})
