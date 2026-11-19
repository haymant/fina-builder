import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { AlertCircle, CheckCircle2, RefreshCw, Save, Wifi } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { PanelCard } from '../../shared/components/PanelCard'
import type { NipProviderStatus } from '../types'

type LocalModelSettings = {
  baseUrl: string | null
  model: string | null
  saved: boolean
  envOverride: boolean
}

type LocalModelReadiness = {
  ready: true
  model: string
  availableModelCount: number
}

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function DirectLocalEnvironmentGuide({ status }: { status: NipProviderStatus | null }) {
  const ready = status?.extraction_state === 'available'
  return <PanelCard title="Direct Local model" bodyClassName="narrative-card-body" subtitle="Direct NIP call · loopback-only OpenAI-compatible endpoint · no API key or RIGA bridge" collapsible={false}>
    {status?.provider_id === 'direct-local' ? <>
      <div className="flex items-center justify-between gap-2"><strong className="text-xs text-main">{status.model || 'Local model is not configured'}</strong><span className="narrative-chip">{ready ? 'ready' : status.configured ? 'unavailable' : 'not configured'}</span></div>
      <p className="mt-2 text-[10px] text-muted">NIP calls this model directly. Transcript text stays on the machine; if the endpoint or model is unavailable, extraction is blocked with no RIGA or remote fallback.</p>
      {status.warnings.length ? <p className="mt-2 text-[10px] text-amber-700">{status.warnings.join(' · ')}</p> : null}
    </> : <p className="text-[10px] text-muted">Direct Local is available as an alternative to the currently selected provider.</p>}
    <details className="narrative-adapter-guide" open={!ready}>
      <summary>Configure a direct local model</summary>
      <p>Set these values in the desktop host environment or app-data <code>.env</code>, then restart. Use a literal loopback IP such as <code>127.0.0.1</code> or <code>::1</code>; DNS hostnames are rejected. The server must expose <code>GET /models</code> and <code>POST /chat/completions</code>.</p>
      <pre>{`NIP_CLAIM_PROVIDER=direct_local
NIP_LOCAL_LLM_URL=http://127.0.0.1:1234/v1
NIP_LOCAL_LLM_MODEL=<exact model id>`}</pre>
      <p>With <code>NIP_CLAIM_PROVIDER=auto</code> (the default), configuring the local URL/model selects this route. Choose <code>riga</code> explicitly to use RIGA instead. Direct-local accepts no API key, ignores system proxy settings, follows no redirects, and caps responses at 4 MiB.</p>
    </details>
  </PanelCard>
}

export function DirectLocalSettingsPanel({ status }: { status: NipProviderStatus | null }) {
  const desktop = isTauriRuntime()
  const [settings, setSettings] = useState<LocalModelSettings | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [loading, setLoading] = useState(() => isTauriRuntime())
  const [checking, setChecking] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [messageIsError, setMessageIsError] = useState(false)
  const [restartRequired, setRestartRequired] = useState(false)

  useEffect(() => {
    if (!desktop) return
    let active = true
    void invoke<LocalModelSettings>('nip_get_local_model_settings')
      .then((loaded) => {
        if (!active) return
        setSettings(loaded)
        setBaseUrl(loaded.baseUrl ?? '')
        setModel(loaded.model ?? '')
      })
      .catch((reason: unknown) => {
        if (!active) return
        setMessage(reason instanceof Error ? reason.message : 'Local model settings could not be loaded.')
        setMessageIsError(true)
      })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [desktop])

  if (!desktop) return <DirectLocalEnvironmentGuide status={status} />

  const canSubmit = Boolean(baseUrl.trim() && model.trim()) && !loading
  const setError = (reason: unknown, fallback: string) => {
    setMessage(reason instanceof Error ? reason.message : fallback)
    setMessageIsError(true)
    setRestartRequired(false)
  }

  const checkModel = async () => {
    setChecking(true)
    setMessage(null)
    setMessageIsError(false)
    setRestartRequired(false)
    try {
      const result = await invoke<LocalModelReadiness>('nip_check_local_model', { baseUrl: baseUrl.trim(), model: model.trim() })
      setMessage(`Ready: ${result.model} · ${result.availableModelCount} model${result.availableModelCount === 1 ? '' : 's'} available.`)
    } catch (reason) {
      setError(reason, 'The local model is not ready.')
    } finally {
      setChecking(false)
    }
  }

  const saveSettings = async () => {
    setSaving(true)
    setMessage(null)
    setMessageIsError(false)
    try {
      const result = await invoke<{ restartRequired: true; envOverride: boolean }>('nip_save_local_model_settings', { baseUrl: baseUrl.trim(), model: model.trim() })
      setSettings((current) => ({ baseUrl: baseUrl.trim(), model: model.trim(), saved: true, envOverride: result.envOverride || Boolean(current?.envOverride) }))
      setRestartRequired(result.restartRequired)
      setMessage('Direct Local is selected and saved for the next desktop launch.')
    } catch (reason) {
      setError(reason, 'Local model settings could not be saved.')
    } finally {
      setSaving(false)
    }
  }

  return <PanelCard title="Direct Local model" bodyClassName="narrative-card-body" subtitle="Loopback OpenAI-compatible endpoint · no API key or RIGA bridge" collapsible={false}>
    {status?.provider_id === 'direct-local' ? <div className="mb-3 flex items-center justify-between gap-2"><span className="text-[10px] text-muted">Active provider</span><span className="narrative-chip">{status.extraction_state === 'available' ? 'ready' : status.configured ? 'unavailable' : 'not configured'}</span></div> : null}
    {loading ? <p className="text-[10px] text-muted" role="status"><RefreshCw size={12} className="mr-1 inline animate-spin" />Loading saved settings…</p> : <div className="space-y-2">
      <label className="block text-[10px] font-medium text-main" htmlFor="direct-local-base-url">Model server URL</label>
      <input id="direct-local-base-url" type="url" autoComplete="url" value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); setMessage(null); setRestartRequired(false) }} placeholder="http://127.0.0.1:1234/v1" className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-main" />
      <label className="block pt-1 text-[10px] font-medium text-main" htmlFor="direct-local-model">Exact model ID</label>
      <input id="direct-local-model" type="text" autoComplete="off" value={model} onChange={(event) => { setModel(event.target.value); setMessage(null); setRestartRequired(false) }} placeholder="e.g. qwen2.5:14b" className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs text-main" />
      <p className="text-[10px] text-muted">Check model only probes <code>/models</code> and sends no transcript.</p>
      {settings?.envOverride ? <p className="rounded-md border border-amber-300/70 bg-amber-50/60 p-2 text-[10px] text-amber-800" role="status">Environment configuration overrides saved Direct Local settings. The environment values take precedence.</p> : null}
      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="outline" size="sm" disabled={!canSubmit || checking || saving} onClick={() => void checkModel()}><Wifi size={12} /> {checking ? 'Checking…' : 'Check model'}</Button>
        <Button size="sm" disabled={!canSubmit || checking || saving} onClick={() => void saveSettings()}><Save size={12} /> {saving ? 'Saving…' : 'Save for next launch'}</Button>
      </div>
      {message ? <p className={`text-[10px] ${messageIsError ? 'text-red-700' : 'text-emerald-700'}`} role={messageIsError ? 'alert' : 'status'}>{messageIsError ? <AlertCircle size={12} className="mr-1 inline" /> : <CheckCircle2 size={12} className="mr-1 inline" />}{message}</p> : null}
      {restartRequired ? <p className="rounded-md border border-sky-300/70 bg-sky-50/60 p-2 text-[10px] text-sky-800" role="status">Restart the desktop app for the saved provider and model to take effect.</p> : null}
    </div>}
  </PanelCard>
}
