import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NotebookDrawer } from './NotebookDrawer'
import { useDashboardDocsStore } from '../../../store/dashboardDocsStore'
import { DEFAULT_RD_WORKFLOW_YAML } from '../../rd/workflowYamlTemplate'

vi.mock('../../themes/ThemeProvider', () => ({ useTheme: () => ({ mode: 'light' }) }))
vi.mock('@uiw/react-codemirror', () => ({ default: () => <textarea aria-label="notebook editor" /> }))

beforeEach(() => {
  localStorage.clear()
  useDashboardDocsStore.setState({ notes: {}, usage: {}, templates: useDashboardDocsStore.getState().templates })
})

describe('NotebookDrawer R&D context', () => {
  it('shows a copy-ready YAML authoring prompt in an isolated R&D notebook', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    useDashboardDocsStore.getState().addNote('payoff-explorer')
    useDashboardDocsStore.getState().updateNote('payoff-explorer', useDashboardDocsStore.getState().notes['payoff-explorer']![0]!.id, { title: 'Payoff-only note' })

    render(<NotebookDrawer dashboardId="payoff-explorer" dashboardName="Payoff Explorer" open onClose={vi.fn()} rdMode />)
    expect(screen.getByText('R&D notebook')).toBeInTheDocument()
    expect(screen.getByText(/External-agent YAML prompt/)).toBeInTheDocument()
    expect(screen.getByText(/R&D notes/)).toBeInTheDocument()
    expect(screen.queryByText('Payoff-only note')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /copy prompt \+ yaml/i }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/copied to clipboard/i))
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0]?.[0]).toContain('Return only one complete YAML document')
    expect(writeText.mock.calls[0]?.[0]).toContain(DEFAULT_RD_WORKFLOW_YAML.trim())
  })
})
