import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NotebookDrawer } from './NotebookDrawer'
import { useDashboardDocsStore } from '../../../store/dashboardDocsStore'
import RD_WORKFLOW_SCHEMA_TEXT from '../../../../skills/tradeac-rd/schema/workflow-yaml.schema.json?raw'
import TRADEAC_RD_SKILL from '../../../../skills/tradeac-rd/SKILL.md?raw'
import RD_FEATURE_CANDIDATES from '../../../../skills/tradeac-rd/references/feature-candidates.md?raw'
import { DEFAULT_RD_WORKFLOW_YAML } from '../../rd/workflowYamlTemplate'

vi.mock('../../themes/ThemeProvider', () => ({ useTheme: () => ({ mode: 'light' }) }))
vi.mock('@uiw/react-codemirror', () => ({ default: () => <textarea aria-label="notebook editor" /> }))

beforeEach(() => {
  localStorage.clear()
  useDashboardDocsStore.setState({ notes: {}, usage: {}, templates: useDashboardDocsStore.getState().templates })
})

describe('NotebookDrawer R&D context', () => {
  it('shows the TradeAC R&D skill and copies it with all authoring resources', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    useDashboardDocsStore.getState().addNote('payoff-explorer')
    useDashboardDocsStore.getState().updateNote('payoff-explorer', useDashboardDocsStore.getState().notes['payoff-explorer']![0]!.id, { title: 'Payoff-only note' })

    render(<NotebookDrawer dashboardId="payoff-explorer" dashboardName="Payoff Explorer" open onClose={vi.fn()} rdMode />)
    expect(screen.getByText('R&D notebook')).toBeInTheDocument()
    expect(screen.getByText(/TradeAC R&D skill \/ external-agent prompt/)).toBeInTheDocument()
    expect(screen.getByText(/Bounded YAML workflow in fina-builder/)).toBeInTheDocument()
    expect(screen.getByText(/R&D notes/)).toBeInTheDocument()
    expect(screen.queryByText('Payoff-only note')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /download starter yaml/i })).toHaveAttribute('download', 'tradeac-rd-workflow.yaml')
    expect(screen.getByRole('link', { name: /download yaml json schema/i })).toHaveAttribute('download', 'workflow-yaml.schema.json')
    expect(screen.getByRole('link', { name: /download feature candidates/i })).toHaveAttribute('download', 'feature-candidates.md')

    await user.click(screen.getByRole('button', { name: /copy prompt and context/i }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/copied to clipboard/i))
    expect(writeText).toHaveBeenCalledTimes(1)
    const copiedContext = writeText.mock.calls[0]?.[0] ?? ''
    expect(copiedContext).toContain(TRADEAC_RD_SKILL.trim())
    expect(copiedContext).toContain('investment thesis')
    expect(copiedContext).toContain('explicit confirmation')
    expect(copiedContext).toContain('Validate & preflight')
    expect(copiedContext).toContain(RD_FEATURE_CANDIDATES.trim())
    expect(copiedContext).toContain('ema_{n}')
    expect(copiedContext).toContain(DEFAULT_RD_WORKFLOW_YAML.trim())
    expect(copiedContext).toContain(RD_WORKFLOW_SCHEMA_TEXT.trim())
  })
})
