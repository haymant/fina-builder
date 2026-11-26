import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NotebookDrawer } from './NotebookDrawer'
import { useDashboardDocsStore } from '../../../store/dashboardDocsStore'
import RD_WORKFLOW_SCHEMA_TEXT from '../../../../skills/tradeac-rd/schema/workflow-yaml.schema.json?raw'
import TRADEAC_RD_SKILL from '../../../../skills/tradeac-rd/SKILL.md?raw'
import RD_FEATURE_CANDIDATES from '../../../../skills/tradeac-rd/references/feature-candidates.md?raw'
import { DEFAULT_RD_WORKFLOW_YAML } from '../../rd/workflowYamlTemplate'
import NIP_TRANSCRIPTION_SKILL from '../../../../skills/nip-transcription/SKILL.md?raw'
import NIP_IMPORT_SCHEMA_TEXT from '../../../../skills/nip-transcription/schema/processed-transcript-import.schema.json?raw'

const narrativeApiMock = vi.hoisted(() => ({ buildAgentNarrativeGraph: vi.fn() }))
vi.mock('../../narrative/api', () => ({ narrativeApi: narrativeApiMock }))
vi.mock('../../themes/ThemeProvider', () => ({ useTheme: () => ({ mode: 'light' }) }))
vi.mock('@uiw/react-codemirror', () => ({ default: () => <textarea aria-label="notebook editor" /> }))

beforeEach(() => {
  localStorage.clear()
  useDashboardDocsStore.setState({ notes: {}, usage: {}, templates: useDashboardDocsStore.getState().templates })
  narrativeApiMock.buildAgentNarrativeGraph.mockReset().mockResolvedValue({ analysis: {}, claims: [], graph: {} })
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
  }, 15000) // Heavy drawer (large raw skill/schema imports, jsdom role queries ~1s each under load); the 5s default is too tight on a loaded VM.
})

describe('NotebookDrawer NIP transcript context', () => {
  const transcript = 'The Fed expects rates to remain restrictive through year end.'
  const nipEpisode = { source_id: 'macro-show', source_native_id: 'episode-42', canonical_url: 'https://example.test/42', title: 'Rates outlook', enclosure_url: null, published_at: '2026-11-20T12:00:00Z', discovered_at: '2026-11-21T12:00:00Z', state: 'transcribed' }
  const nipEvent = { schema_version: 1, event_id: 'event-42', source_id: 'macro-show', source_native_id: 'episode-42', canonical_url: nipEpisode.canonical_url, content_hash: 'hash-42', content_text: transcript, times: { published_at: nipEpisode.published_at, source_updated_at: null, captured_at: nipEpisode.discovered_at, ingested_at: nipEpisode.discovered_at }, revision_of: null }
  const payload = { event_id: 'event-42', producer: 'External agent', model: 'test-model', prompt_version: 'nip-transcription-v1', narrative_title: 'Restrictive policy outlook', narrative_thesis: 'The speaker expects rates to remain restrictive through year end.', narrative_summary: '', entities: [{ canonical_name: 'Federal Reserve', entity_type: 'government_body', surface_form: 'Fed', evidence_quote: 'The Fed expects rates to remain restrictive through year end.' }], claims: [{ claim_text: 'Rates are expected to remain restrictive through year end.', claim_type: 'forecast', confidence_millis: 850, evidence_quote: 'The Fed expects rates to remain restrictive through year end.', entity_names: ['Federal Reserve'] }] }

  it('replaces generic dashboard usage with the NIP skill and exposes the selected retained transcript', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    const user = userEvent.setup()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    useDashboardDocsStore.getState().addNote('payoff-explorer')
    useDashboardDocsStore.getState().updateNote('payoff-explorer', useDashboardDocsStore.getState().notes['payoff-explorer']![0]!.id, { title: 'Payoff-only note' })

    render(<NotebookDrawer dashboardId="payoff-explorer" dashboardName="Payoff Explorer" open onClose={vi.fn()} nipMode nipEpisode={nipEpisode} nipEvent={nipEvent} />)
    expect(screen.getByText('NIP notebook')).toBeInTheDocument()
    expect(screen.getByText(/NIP transcript-processing skill/)).toBeInTheDocument()
    expect(screen.getByText(/Choose the available workflow/)).toBeInTheDocument()
    expect(screen.queryByText('1. Usage')).not.toBeInTheDocument()
    expect(screen.queryByText('Payoff-only note')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open retained transcript' })).toHaveAttribute('download', 'event-42.txt')
    expect(screen.getByRole('link', { name: /download nip-transcription skill/i })).toHaveAttribute('download', 'nip-transcription-SKILL.md')
    expect(screen.getByRole('link', { name: /download import json schema/i })).toHaveAttribute('download', 'processed-transcript-import.schema.json')

    await user.click(screen.getByRole('button', { name: /copy skill \+ transcript/i }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/copied to clipboard/i))
    const context = writeText.mock.calls[0]?.[0] ?? ''
    expect(context).toContain(NIP_TRANSCRIPTION_SKILL.trim())
    expect(context).toContain(NIP_IMPORT_SCHEMA_TEXT.trim())
    expect(context).toContain('Preserve ASR spellings, punctuation, whitespace, and capitalization exactly')
    expect(context).toContain(transcript)
    expect(context).toContain('event-42')
    expect(context).toContain('return exactly one JSON object')
  })

  it('imports only JSON for the selected retained event and reports success', async () => {
    const user = userEvent.setup()
    const onNipImportSuccess = vi.fn()
    render(<NotebookDrawer dashboardId="unused" dashboardName="unused" open onClose={vi.fn()} nipMode nipEpisode={nipEpisode} nipEvent={nipEvent} onNipImportSuccess={onNipImportSuccess} />)
    const file = new File([JSON.stringify(payload)], 'processed-transcript.json', { type: 'application/json' })
    await user.upload(screen.getByLabelText('Processed transcript JSON file'), file)
    await waitFor(() => expect(narrativeApiMock.buildAgentNarrativeGraph).toHaveBeenCalledWith(payload))
    expect(onNipImportSuccess).toHaveBeenCalledOnce()
    expect(await screen.findByRole('status')).toHaveTextContent(/Import succeeded/)
  })

  it('opens the native JSON file picker from the Import action', async () => {
    const user = userEvent.setup()
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined)
    render(<NotebookDrawer dashboardId="unused" dashboardName="unused" open onClose={vi.fn()} nipMode nipEpisode={nipEpisode} nipEvent={nipEvent} />)
    await user.click(screen.getByRole('button', { name: 'Import' }))
    expect(click).toHaveBeenCalledOnce()
    click.mockRestore()
  })

  it('copies the context through the legacy clipboard fallback when the Clipboard API rejects', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockRejectedValue(new Error('not allowed'))
    const previousExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')
    const legacyCopy = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: legacyCopy })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    render(<NotebookDrawer dashboardId="unused" dashboardName="unused" open onClose={vi.fn()} nipMode nipEpisode={nipEpisode} nipEvent={nipEvent} />)
    await user.click(screen.getByRole('button', { name: /copy skill \+ transcript/i }))
    expect(await screen.findByRole('status')).toHaveTextContent(/copied to clipboard using compatibility mode/i)
    expect(legacyCopy).toHaveBeenCalledWith('copy')
    if (previousExecCommand) Object.defineProperty(document, 'execCommand', previousExecCommand)
    else Reflect.deleteProperty(document, 'execCommand')
  })

  it('explains when the selected episode lookup failed and keeps import disabled', () => {
    render(<NotebookDrawer dashboardId="unused" dashboardName="unused" open onClose={vi.fn()} nipMode nipEpisode={nipEpisode} nipEpisodeError="Transcript lookup failed: NIP service is offline." />)
    expect(screen.getByText('Transcript lookup failed: NIP service is offline.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /copy skill \+ transcript/i })).toBeDisabled()
  })

  it('rejects a JSON result for a different transcript without calling NIP', async () => {
    const user = userEvent.setup()
    render(<NotebookDrawer dashboardId="unused" dashboardName="unused" open onClose={vi.fn()} nipMode nipEpisode={nipEpisode} nipEvent={nipEvent} />)
    const file = new File([JSON.stringify({ ...payload, event_id: 'another-event' })], 'wrong-event.json', { type: 'application/json' })
    await user.upload(screen.getByLabelText('Processed transcript JSON file'), file)
    expect(await screen.findByRole('status')).toHaveTextContent(/targets event another-event/)
    expect(narrativeApiMock.buildAgentNarrativeGraph).not.toHaveBeenCalled()
  })
})
