import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { rdApi } from '../../../api/rdApi'
import { trading2Api } from '../../../api/trading2Api'
import { WorkflowYamlDialog } from './WorkflowYamlDialog'

vi.mock('../../../api/rdApi', async () => {
  const actual = await vi.importActual<typeof import('../../../api/rdApi')>('../../../api/rdApi')
  return { ...actual, rdApi: { validateWorkflowYaml: vi.fn(), runWorkflowYaml: vi.fn() } }
})
vi.mock('../../../api/trading2Api', () => ({ trading2Api: { loadLakeSymbols: vi.fn(), getLoadStatus: vi.fn() } }))
vi.mock('../../themes/ThemeProvider', () => ({ useTheme: () => ({ mode: 'light' }) }))
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange, editable = true, ...props }: { value: string; onChange: (value: string) => void; editable?: boolean; 'aria-label'?: string }) => <textarea aria-label={props['aria-label'] ?? 'yaml editor'} disabled={!editable} value={value} onChange={(event) => onChange(event.target.value)} />,
}))

const result = {
  valid: true, experimentName: 'alpha', modelClass: 'RankICLGBModel', market: 'US', universe: 'SPY,QQQ',
  train: ['2020-01-01', '2023-12-31'], validWindow: ['2024-01-01', '2024-12-31'], test: ['2025-01-01', '2025-12-31'],
  seed: 2026, numThreads: 1, featureFields: ['$close'], recordClasses: ['SignalRecord', 'SigAnaRecord'],
  configSha256: 'a'.repeat(64), determinismProfile: 'lightgbm-seeded-single-thread-v1',
  datasetPreflight: { universeSize: 2, universe: ['SPY', 'QQQ'], segments: { train: { rows: 40, date_min: '2020-01-01', date_max: '2023-12-31' } }, featureFields: ['$close'], allNanDropped: [] },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(rdApi.validateWorkflowYaml).mockResolvedValue(result)
  vi.mocked(rdApi.runWorkflowYaml).mockResolvedValue({ status: 'started' })
  vi.mocked(trading2Api.loadLakeSymbols).mockResolvedValue({ jobId: 'load-1', status: 'started', symbols: ['SPY', 'QQQ'], processed: 0, results: [], raw: {} })
  vi.mocked(trading2Api.getLoadStatus).mockResolvedValue({ jobId: 'load-1', status: 'completed', symbols: ['SPY', 'QQQ'], processed: 2, results: [], raw: {} })
})

describe('WorkflowYamlDialog', () => {
  it('requires validation of the exact text before confirmation and named dispatch', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn(); const onDispatched = vi.fn()
    render(<WorkflowYamlDialog onClose={onClose} onDispatched={onDispatched} />)
    const dispatch = screen.getByRole('button', { name: /dispatch workflow/i })
    expect(dispatch).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /validate & preflight/i }))
    await screen.findByText('Preflight passed')
    expect(screen.getByText(/40 rows · 2020-01-01 to 2023-12-31/)).toBeInTheDocument()
    expect(rdApi.validateWorkflowYaml).toHaveBeenCalledTimes(1)
    expect(dispatch).toBeEnabled()
    await user.click(dispatch)
    const dialog = await screen.findByTestId('confirm-dialog')
    expect(dialog).toHaveTextContent('Config SHA-256')
    expect(rdApi.runWorkflowYaml).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('confirm-accept'))
    await waitFor(() => expect(rdApi.runWorkflowYaml).toHaveBeenCalledWith(expect.any(String), 'alpha'))
    expect(await screen.findByRole('status')).toHaveTextContent('Workflow submitted (started)')
    expect(dispatch).toBeDisabled()
    expect(onClose).not.toHaveBeenCalled()
    expect(onDispatched).toHaveBeenCalledTimes(1)
  })

  it('invalidates preflight when YAML changes and does not dispatch on cancel', async () => {
    const user = userEvent.setup()
    render(<WorkflowYamlDialog onClose={vi.fn()} onDispatched={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /validate & preflight/i }))
    const dispatch = await screen.findByRole('button', { name: /dispatch workflow/i }); expect(dispatch).toBeEnabled()
    fireEvent.change(screen.getByRole('textbox', { name: /workflow yaml editor/i }), { target: { value: 'experiment_name: edited' } })
    expect(dispatch).toBeDisabled(); expect(rdApi.runWorkflowYaml).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: /validate & preflight/i }))
    await user.click(await screen.findByRole('button', { name: /dispatch workflow/i }))
    await user.click(await screen.findByTestId('confirm-cancel'))
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument()
    expect(rdApi.runWorkflowYaml).not.toHaveBeenCalled()
  })

  it('offers but does not start lake recovery when the user cancels', async () => {
    const user = userEvent.setup()
    vi.mocked(rdApi.validateWorkflowYaml).mockRejectedValue(new Error('Workflow validation or persisted-lake preflight failed: requested lake data is missing'))
    render(<WorkflowYamlDialog onClose={vi.fn()} onDispatched={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /validate & preflight/i }))
    expect(await screen.findByRole('button', { name: /populate missing lake data/i })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /populate missing lake data/i }))
    expect(await screen.findByTestId('confirm-dialog')).toHaveTextContent('Populate the missing persisted lake data now?')
    await user.click(screen.getByTestId('confirm-cancel'))
    expect(trading2Api.loadLakeSymbols).not.toHaveBeenCalled()
  })

  it('loads missing data after confirmation, polls, and revalidates the same YAML', async () => {
    const user = userEvent.setup()
    vi.mocked(rdApi.validateWorkflowYaml).mockRejectedValueOnce(new Error('Workflow validation or persisted-lake preflight failed: empty input; check lake coverage')).mockResolvedValueOnce(result)
    render(<WorkflowYamlDialog onClose={vi.fn()} onDispatched={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /validate & preflight/i }))
    await user.click(await screen.findByRole('button', { name: /populate missing lake data/i }))
    await user.click(await screen.findByTestId('confirm-accept'))
    await waitFor(() => expect(rdApi.validateWorkflowYaml).toHaveBeenCalledTimes(2))
    expect(trading2Api.loadLakeSymbols).toHaveBeenCalledWith(expect.objectContaining({ market: 'US', symbols: ['SPY', 'QQQ'], timeframe: '1d' }))
    expect(trading2Api.getLoadStatus).toHaveBeenCalledWith('load-1')
    expect(await screen.findByText('Preflight passed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /dispatch workflow/i })).toBeEnabled()
  })

  it('backfills from the YAML start when it predates TAC_LAKE_START_DATE', async () => {
    const user = userEvent.setup()
    const yaml = 'instruments: SPY,QQQ\nmarket: US\nfreq: day\nstart_time: 2019-06-03\nend_time: 2020-01-31\n'
    vi.mocked(rdApi.validateWorkflowYaml)
      .mockRejectedValueOnce(new Error('handler.start_time 2019-06-03 is before TAC_LAKE_START_DATE 2021-01-04; confirm whether to backfill'))
      .mockResolvedValueOnce(result)
    render(<WorkflowYamlDialog onClose={vi.fn()} onDispatched={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox', { name: /workflow yaml editor/i }), { target: { value: yaml } })
    await user.click(screen.getByRole('button', { name: /validate & preflight/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent('YAML\'s requested start date 2019-06-03 through 2020-01-31')
    await user.click(screen.getByRole('button', { name: /populate missing lake data/i }))
    expect(await screen.findByTestId('confirm-dialog')).toHaveTextContent('2019-06-03 through 2020-01-31')
    expect(screen.getByRole('textbox', { name: /workflow yaml editor/i })).toBeDisabled()
    await user.click(screen.getByTestId('confirm-accept'))
    await waitFor(() => expect(trading2Api.loadLakeSymbols).toHaveBeenCalledWith(expect.objectContaining({ start: '2019-06-03', end: '2020-01-31' })))
    await waitFor(() => expect(rdApi.validateWorkflowYaml).toHaveBeenCalledTimes(2))
  })
})
