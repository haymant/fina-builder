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
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, 'aria-label': label }: { value: string; 'aria-label'?: string }) => <textarea aria-label={label ?? 'Workflow YAML editor'} readOnly value={value} />,
}))

const experiment = {
  experimentId: 'exp-1', name: 'alpha', lifecycleStage: 'active', runCount: 1,
  latestRun: { runId: 'run-1', name: 'baseline', status: 'FINISHED', startTime: '2026-01-01', headline: {} },
  bestHeadline: {},
}
const secondExperiment = { ...experiment, experimentId: 'exp-2', name: 'beta' }
const run = {
  meta: { runId: 'run-1', name: 'baseline', status: 'FINISHED', experimentId: 'exp-1', startTime: '2026-01-01', endTime: null, sourceVersion: null },
  params: {}, tags: {}, metrics: {}, metricsLatest: {}, headline: {}, notes: {}, artifacts: [],
}
const secondRun = { ...run, meta: { ...run.meta, runId: 'run-2', experimentId: 'exp-2', name: 'second run' } }
const savedYaml = 'experiment_name: alpha\ntask:\n  model:\n    class: LGBModel\n'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(rdApi.listExperiments).mockResolvedValue([experiment])
  vi.mocked(rdApi.getExperiment).mockResolvedValue({ experiment, runs: [run] })
  vi.mocked(rdApi.getResult).mockResolvedValue({ runId: 'run-1', experimentId: 'exp-1', metrics: {}, headline: {}, icSeries: [], groupReturns: {}, backtest: {}, explanation: null, warnings: [], predStats: {}, icHistogram: [], monthlyIc: [] })
  vi.mocked(rdApi.getInput).mockResolvedValue({
    run_id: 'run-1', experiment_id: 'exp-1', config_yaml: savedYaml,
    source: 'run-config',
    dataset: { handler_kwargs: { instruments: 'SPY' }, universe: ['SPY'], universe_size: 1, features: ['$close'], label: '$label', segments: {} },
    model: { class: 'LGBModel', module_path: 'qlib.contrib.model.gbdt', kwargs: {} },
  })
  vi.mocked(rdApi.getModel).mockResolvedValue({})
  vi.mocked(rdApi.getBlotter).mockResolvedValue({ runId: 'run-1', experimentId: 'exp-1', summary: {}, daily: [], positions: [], positionHistory: [], trades: [], signals: [], warnings: [] })
  vi.mocked(rdApi.getDataset).mockResolvedValue({ runId: 'run-1', experimentId: 'exp-1', group: 'train', instrument: 'SPY', instruments: ['SPY'], columns: [], rows: [], page: 1, pageSize: 50, total: 0, hasNext: false, sort: 'asc', representation: 'raw', dataKey: 'DK_R', provenance: {}, warnings: [] })
})

describe('R&D Dataset navigation', () => {
  it('adds a Dataset button to each Dashboard run Inspect action', async () => {
    const onNavigate = vi.fn()
    render(<RdWorkspace view="dashboard" onNavigate={onNavigate} />)

    const dataset = await screen.findByRole('button', { name: 'Dataset' })
    fireEvent.click(dataset)

    expect(onNavigate).toHaveBeenCalledWith({ kind: 'rd', view: 'dataset' })
  })

  it('adds a Dashboard link to the Dataset title area', async () => {
    const onNavigate = vi.fn()
    render(<RdWorkspace view="dataset" onNavigate={onNavigate} />)

    const dashboard = await screen.findByRole('button', { name: /Dashboard/ })
    await screen.findByRole('heading', { name: 'Dataset rows' })
    onNavigate.mockClear()
    fireEvent.click(dashboard)

    expect(onNavigate).toHaveBeenCalledWith({ kind: 'rd', view: 'dashboard' })
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

  it('copies the selected run YAML from the Input page', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<RdWorkspace view="input" onNavigate={vi.fn()} />)

    await screen.findByRole('button', { name: 'Copy original YAML' })
    fireEvent.click(screen.getByRole('button', { name: 'Copy original YAML' }))

    await screen.findByText('Run YAML copied to clipboard.')
    expect(writeText).toHaveBeenCalledWith(savedYaml)
  })

  it('opens the selected run YAML in the Clone dialog', async () => {
    render(<RdWorkspace view="dashboard" onNavigate={vi.fn()} />)

    const clone = await screen.findByRole('button', { name: 'Clone selected run YAML' })
    await waitFor(() => expect(clone).toBeEnabled())
    fireEvent.click(clone)

    expect(await screen.findByRole('textbox', { name: 'Workflow YAML editor' })).toHaveValue(savedYaml)
  })

  it('disables Clone when the selected experiment has no selected run', async () => {
    vi.mocked(rdApi.getExperiment).mockResolvedValue({ experiment, runs: [] })
    const firstRender = render(<RdWorkspace view="dashboard" onNavigate={vi.fn()} />)

    expect(await screen.findByRole('button', { name: 'Clone selected run YAML' })).toBeDisabled()
    firstRender.unmount()

    vi.mocked(rdApi.listExperiments).mockResolvedValue([])
    render(<RdWorkspace view="dashboard" onNavigate={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'Clone selected run YAML' })).toBeDisabled()
  })

  it('loads the newly selected experiment runs without requiring Refresh', async () => {
    vi.mocked(rdApi.listExperiments).mockResolvedValue([experiment, secondExperiment])
    vi.mocked(rdApi.getExperiment).mockImplementation(async (id) => id === 'exp-2'
      ? { experiment: secondExperiment, runs: [secondRun] }
      : { experiment, runs: [run] })
    render(<RdWorkspace view="dashboard" onNavigate={vi.fn()} />)

    fireEvent.click(await screen.findByText('beta'))

    expect(await screen.findByText('second run')).toBeInTheDocument()
    expect(rdApi.getExperiment).toHaveBeenCalledWith('exp-2')
  })
})
