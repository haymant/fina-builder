import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { rdApi } from '../../../api/rdApi'
import { WorkflowYamlDialog } from './WorkflowYamlDialog'

vi.mock('../../../api/rdApi', async () => {
  const actual = await vi.importActual<typeof import('../../../api/rdApi')>('../../../api/rdApi')
  return { ...actual, rdApi: { validateWorkflowYaml: vi.fn(), runWorkflowYaml: vi.fn() } }
})
vi.mock('../../themes/ThemeProvider', () => ({ useTheme: () => ({ mode: 'light' }) }))
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange, ...props }: { value: string; onChange: (value: string) => void; 'aria-label'?: string }) => <textarea aria-label={props['aria-label'] ?? 'yaml editor'} value={value} onChange={(event) => onChange(event.target.value)} />,
}))

const result = {
  valid: true,
  experimentName: 'alpha',
  modelClass: 'RankICLGBModel',
  market: 'US',
  universe: 'SPY,QQQ',
  train: ['2020-01-01', '2023-12-31'],
  validWindow: ['2024-01-01', '2024-12-31'],
  test: ['2025-01-01', '2025-12-31'],
  seed: 2026,
  numThreads: 1,
  featureFields: ['$close'],
  recordClasses: ['SignalRecord', 'SigAnaRecord'],
  configSha256: 'a'.repeat(64),
  determinismProfile: 'lightgbm-seeded-single-thread-v1',
  datasetPreflight: { universeSize: 2, universe: ['SPY', 'QQQ'], segments: { train: { rows: 40, date_min: '2020-01-01', date_max: '2023-12-31' } }, featureFields: ['$close'], allNanDropped: [] },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(rdApi.validateWorkflowYaml).mockResolvedValue(result)
  vi.mocked(rdApi.runWorkflowYaml).mockResolvedValue({ status: 'started' })
})

describe('WorkflowYamlDialog', () => {
  it('requires validation of the exact text before confirmation and named dispatch', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const onDispatched = vi.fn()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<WorkflowYamlDialog onClose={onClose} onDispatched={onDispatched} />)

    const dispatch = screen.getByRole('button', { name: /dispatch workflow/i })
    expect(dispatch).toBeDisabled()
    await user.click(screen.getByRole('button', { name: /validate & preflight/i }))
    await screen.findByText('Preflight passed')
    expect(screen.getByText(/40 rows · 2020-01-01 to 2023-12-31/)).toBeInTheDocument()
    expect(rdApi.validateWorkflowYaml).toHaveBeenCalledTimes(1)
    expect(dispatch).toBeEnabled()

    await user.click(dispatch)
    await waitFor(() => expect(rdApi.runWorkflowYaml).toHaveBeenCalledWith(expect.any(String), 'alpha'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Config SHA-256'))
    expect(onDispatched).toHaveBeenCalledTimes(1)
  })

  it('invalidates preflight when YAML changes and does not dispatch on cancel', async () => {
    const user = userEvent.setup()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<WorkflowYamlDialog onClose={vi.fn()} onDispatched={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /validate & preflight/i }))
    const dispatch = await screen.findByRole('button', { name: /dispatch workflow/i })
    expect(dispatch).toBeEnabled()
    fireEvent.change(screen.getByRole('textbox', { name: /workflow yaml editor/i }), { target: { value: 'experiment_name: edited' } })
    expect(dispatch).toBeDisabled()
    expect(rdApi.runWorkflowYaml).not.toHaveBeenCalled()

    // Revalidation enables the operation, but declining the final confirmation does not call the service.
    await user.click(screen.getByRole('button', { name: /validate & preflight/i }))
    await user.click(await screen.findByRole('button', { name: /dispatch workflow/i }))
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(rdApi.runWorkflowYaml).not.toHaveBeenCalled()
  })
})
