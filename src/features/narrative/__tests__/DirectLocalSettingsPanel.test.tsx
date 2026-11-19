import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectLocalSettingsPanel } from '../components/DirectLocalSettingsPanel'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

const savedSettings = { baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen2.5:14b', saved: true, envOverride: false }

function useTauriRuntime() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} })
}

describe('DirectLocalSettingsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useTauriRuntime()
    invokeMock.mockResolvedValue(savedSettings)
  })

  it('loads saved settings into labeled URL and exact-model fields', async () => {
    render(<DirectLocalSettingsPanel status={null} />)
    expect(await screen.findByLabelText('Model server URL')).toHaveValue(savedSettings.baseUrl)
    expect(screen.getByLabelText('Exact model ID')).toHaveValue(savedSettings.model)
    expect(screen.queryByLabelText(/API key/i)).not.toBeInTheDocument()
    expect(invokeMock).toHaveBeenCalledWith('nip_get_local_model_settings')
  })

  it('checks readiness by probing the selected model and shows ready status', async () => {
    invokeMock.mockImplementation((command: string) => command === 'nip_get_local_model_settings'
      ? Promise.resolve(savedSettings)
      : Promise.resolve({ ready: true, model: 'qwen2.5:14b', availableModelCount: 3 }))
    render(<DirectLocalSettingsPanel status={null} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Check model' }))
    expect(await screen.findByRole('status')).toHaveTextContent(/Ready: qwen2\.5:14b · 3 models available/)
    expect(document.body.textContent).toContain('Check model only probes /models and sends no transcript.')
    expect(invokeMock).toHaveBeenCalledWith('nip_check_local_model', { baseUrl: savedSettings.baseUrl, model: savedSettings.model })
  })

  it('saves for the next launch and displays the restart-required notice', async () => {
    invokeMock.mockImplementation((command: string) => command === 'nip_get_local_model_settings'
      ? Promise.resolve(savedSettings)
      : Promise.resolve({ restartRequired: true, envOverride: false }))
    render(<DirectLocalSettingsPanel status={null} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Save for next launch' }))
    expect(await screen.findByText(/Direct Local is selected and saved for the next desktop launch/)).toBeInTheDocument()
    expect(screen.getByText(/Restart the desktop app/)).toBeInTheDocument()
    expect(invokeMock).toHaveBeenCalledWith('nip_save_local_model_settings', { baseUrl: savedSettings.baseUrl, model: savedSettings.model })
  })

  it('warns when environment configuration overrides the saved values', async () => {
    invokeMock.mockResolvedValue({ ...savedSettings, envOverride: true })
    render(<DirectLocalSettingsPanel status={null} />)
    expect(await screen.findByText(/Environment configuration overrides saved Direct Local settings/)).toBeInTheDocument()
  })

  it('keeps environment-variable instructions in a browser runtime', () => {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    render(<DirectLocalSettingsPanel status={null} />)
    expect(screen.getByText(/Set these values in the desktop host environment or app-data/)).toBeInTheDocument()
    expect(document.body.textContent).toContain('NIP_LOCAL_LLM_URL=http://127.0.0.1:1234/v1')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('shows sanitized readiness failures as an error state', async () => {
    invokeMock.mockImplementation((command: string) => command === 'nip_get_local_model_settings'
      ? Promise.resolve(savedSettings)
      : Promise.reject(new Error('local_model_not_ready')))
    render(<DirectLocalSettingsPanel status={null} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Check model' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('local_model_not_ready')
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('nip_check_local_model', { baseUrl: savedSettings.baseUrl, model: savedSettings.model }))
  })
})
