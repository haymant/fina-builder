import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
} from '@assistant-ui/react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { Bot, Check, ChevronDown, Download, FolderOpen, LoaderCircle, MessageSquare, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { localAgentAdapter } from './piLocalRuntime'

type AppPaths = { appDataDir: string; modelsDir: string; sessionsDir: string; configFile: string }
type LocalModel = {
  id: string
  name: string
  fileName: string
  path: string
  sizeBytes: number
  curated: boolean
  recommendedContext?: number
  chatTemplate?: string
  licenseUrl?: string
}
type CatalogModel = {
  id: string
  name: string
  fileName: string
  sizeBytes: number
  recommendedContext: number
  chatTemplate: string
  licenseUrl: string
  quant: string
}
type Progress = { modelId: string; downloadedBytes: number; totalBytes: number; percent: number }

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const formatSize = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes < 1_000_000_000 ? 2 : 1)} GB`

export function LocalAgentPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const runtime = useLocalRuntime(localAgentAdapter)
  const [paths, setPaths] = useState<AppPaths | null>(null)
  const [models, setModels] = useState<LocalModel[]>([])
  const [catalog, setCatalog] = useState<CatalogModel[]>([])
  const [selectedPath, setSelectedPath] = useState('')
  const [loadedName, setLoadedName] = useState<string | null>(null)
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [busy, setBusy] = useState(false)
  const [chooseModel, setChooseModel] = useState(false)
  const [showCatalog, setShowCatalog] = useState(false)
  const [error, setError] = useState('')

  const refresh = async () => {
    if (!isTauri) return
    try {
      const [nextPaths, nextModels, nextCatalog, loaded, preferredPath] = await Promise.all([
        invoke<AppPaths>('get_app_paths'),
        invoke<LocalModel[]>('list_local_models'),
        invoke<CatalogModel[]>('curated_model_catalog'),
        invoke<string | null>('get_loaded_model'),
        invoke<string | null>('get_preferred_model'),
      ])
      setPaths(nextPaths)
      setModels(nextModels)
      setCatalog(nextCatalog)
      setLoadedName(loaded)
      setSelectedPath((current) => current || nextModels.find((model) => model.fileName === loaded)?.path || nextModels.find((model) => model.path === preferredPath)?.path || nextModels[0]?.path || '')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  useEffect(() => {
    if (!open || !isTauri) return
    void Promise.resolve().then(refresh)
    let disposed = false
    const unlisteners: Array<() => void> = []
    void Promise.all([
      listen<Progress>('model-download-progress', ({ payload }) => {
        setProgress((current) => ({ ...current, [payload.modelId]: payload }))
      }),
      listen<{ modelId: string }>('model-download-finished', ({ payload }) => {
        setProgress((current) => {
          const next = { ...current }
          delete next[payload.modelId]
          return next
        })
        setShowCatalog(false)
        setChooseModel(true)
        void refresh()
      }),
      listen<{ modelId: string; message: string }>('model-download-error', ({ payload }) => {
        setProgress((current) => {
          const next = { ...current }
          delete next[payload.modelId]
          return next
        })
        if (payload.message !== 'Download cancelled') setError(payload.message)
        void refresh()
      }),
    ]).then((items) => {
      if (disposed) items.forEach((unlisten) => unlisten())
      else unlisteners.push(...items)
    })
    return () => {
      disposed = true
      unlisteners.forEach((unlisten) => unlisten())
    }
  }, [open])

  const selectedModel = useMemo(() => models.find((model) => model.path === selectedPath), [models, selectedPath])

  const startDownload = async (modelId: string) => {
    setError('')
    void invoke('start_model_download', { modelId }).catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  const cancelDownload = async (modelId: string) => {
    try {
      await invoke('cancel_model_download', { modelId })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const loadSelected = async () => {
    if (!selectedPath) return
    setBusy(true)
    setError('')
    try {
      await invoke('load_model', { path: selectedPath })
      const filename = selectedModel?.fileName ?? selectedPath.split(/[\\/]/).pop() ?? 'local model'
      setLoadedName(filename)
      setChooseModel(false)
      setShowCatalog(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const openModelsFolder = async () => {
    setError('')
    try {
      await invoke('open_models_folder')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const isLoaded = loadedName !== null && !chooseModel

  return (
    <>
      {open ? <div className="fixed inset-0 z-[100] flex justify-end">
        <button aria-label="Close local chat panel" className="absolute inset-0 cursor-default bg-black/35" onClick={onClose} />
        <aside className="relative z-10 flex h-full w-full max-w-[440px] flex-col border-l border-slate-700 bg-slate-950 text-slate-100 shadow-2xl">
          <header className="flex shrink-0 items-center gap-3 border-b border-slate-800 px-4 py-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-300"><Bot size={17} /></div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Local assistant</p>
              <p title={paths?.modelsDir} className="truncate text-[11px] text-slate-400">{isLoaded ? `Offline · ${loadedName}` : 'Runs on your device'}</p>
            </div>
            {isLoaded ? <>
              <button type="button" className="rounded px-2 py-1 text-xs text-slate-300 hover:bg-slate-800" onClick={() => void runtime.threads.switchToNewThread()}>New chat</button>
              <button type="button" className="rounded px-2 py-1 text-xs text-slate-300 hover:bg-slate-800" onClick={() => setChooseModel(true)}>Change model</button>
            </> : null}
            <button type="button" aria-label="Close" className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white" onClick={onClose}><X size={16} /></button>
          </header>

          {!isTauri ? <div className="m-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
            Local inference is available in the packaged Tauri desktop app. The browser-only build cannot access native model files.
          </div> : null}

          {isTauri && !isLoaded ? <section className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
            {models.length === 0 || showCatalog ? <>
              <div className="mb-4 rounded-xl border border-slate-800 bg-slate-900/70 p-4">
                <h2 className="text-sm font-semibold">Add a local model to start chatting</h2>
                <p className="mt-1 text-xs leading-5 text-slate-400">Download a curated GGUF model, or copy a compatible .gguf file into your models folder. Model files stay on this device.</p>
              </div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-300">Curated models</h3>
                {models.length > 0 ? <button type="button" onClick={() => setShowCatalog(false)} className="text-[10px] text-sky-300 hover:underline">Use an installed model</button> : <span className="text-[10px] text-slate-500">Q4_K_M quantization</span>}
              </div>
              <div className="space-y-2">
                {catalog.map((model) => {
                  const job = progress[model.id]
                  return <article key={model.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <h4 className="text-xs font-semibold">{model.name}</h4>
                        <p className="mt-1 text-[10px] text-slate-400">{formatSize(model.sizeBytes)} · context {model.recommendedContext.toLocaleString()} · {model.quant}</p>
                        <p className="mt-1 truncate text-[10px] text-slate-500" title={model.chatTemplate}>{model.chatTemplate}</p>
                        <a className="mt-1 inline-block text-[10px] text-sky-300 underline-offset-2 hover:underline" href={model.licenseUrl} target="_blank" rel="noreferrer">Model license / terms</a>
                      </div>
                      {job ? <button type="button" className="rounded border border-slate-700 p-1.5 text-slate-300 hover:bg-slate-800" aria-label={`Cancel ${model.name} download`} onClick={() => void cancelDownload(model.id)}><X size={14} /></button> : <button type="button" className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-500" onClick={() => void startDownload(model.id)}><Download size={12} /> Download</button>}
                    </div>
                    {job ? <div className="mt-3">
                      <div className="mb-1 flex justify-between text-[10px] text-slate-400"><span>{formatSize(job.downloadedBytes)} / {formatSize(job.totalBytes)}</span><span>{Math.floor(job.percent)}%</span></div>
                      <div className="h-1.5 overflow-hidden rounded bg-slate-800"><div className="h-full bg-emerald-400 transition-all" style={{ width: `${job.percent}%` }} /></div>
                    </div> : null}
                  </article>
                })}
              </div>
            </> : <>
              <div className="mb-4 rounded-xl border border-slate-800 bg-slate-900/70 p-4">
                <h2 className="text-sm font-semibold">Choose a local GGUF model</h2>
                <p className="mt-1 text-xs text-slate-400">Any .gguf file copied into the models folder is discovered on refresh.</p>
              </div>
              <label htmlFor="local-model-select" className="mb-1 text-xs text-slate-400">Available models</label>
              <select id="local-model-select" value={selectedPath} onChange={(event) => setSelectedPath(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100 outline-none focus:border-emerald-400">
                {models.map((model) => <option key={model.path} value={model.path}>{model.name} · {formatSize(model.sizeBytes)}</option>)}
              </select>
              {selectedModel?.licenseUrl ? <a className="mt-2 text-[10px] text-sky-300 underline-offset-2 hover:underline" href={selectedModel.licenseUrl} target="_blank" rel="noreferrer">Model license / terms</a> : null}
              <button type="button" disabled={!selectedPath || busy} onClick={() => void loadSelected()} className="mt-4 inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">{busy ? <LoaderCircle className="animate-spin" size={14} /> : <Check size={14} />} Load model</button>
              <button type="button" onClick={() => setShowCatalog(true)} className="mt-2 rounded-lg px-3 py-2 text-[11px] text-sky-300 hover:bg-slate-900">Download another curated model</button>
            </>}
            <button type="button" onClick={() => void openModelsFolder()} className="mt-4 inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-900"><FolderOpen size={14} /> Open models folder</button>
            <button type="button" onClick={() => void refresh()} className="mt-2 inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[11px] text-slate-400 hover:bg-slate-900"><ChevronDown size={13} /> Refresh model list</button>
          </section> : null}

          {isTauri && isLoaded ? <AssistantRuntimeProvider runtime={runtime}>
            <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
              <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4" autoScroll>
                <ThreadPrimitive.Empty>
                  <div className="flex flex-col items-center justify-center px-5 py-14 text-center">
                    <MessageSquare size={22} className="mb-3 text-emerald-300" />
                    <p className="text-sm font-medium">Ask about this workspace</p>
                    <p className="mt-1 text-xs leading-5 text-slate-400">The assistant can inspect local demo path statistics and payoff distributions. Inference stays on this device.</p>
                  </div>
                </ThreadPrimitive.Empty>
                <ThreadPrimitive.Messages>
                  {({ message }) => {
                    const text = message.content.map((part) => part.type === 'text' ? part.text : '').filter(Boolean).join('\n')
                    return <div key={message.id} className={`max-w-[92%] rounded-xl px-3 py-2.5 text-xs leading-5 ${message.role === 'user' ? 'ml-auto bg-emerald-600/20 text-emerald-50' : 'mr-auto border border-slate-800 bg-slate-900 text-slate-200'}`}>
                      {text || (message.role === 'assistant' ? '…' : '')}
                      {message.role === 'assistant' ? <MessagePrimitive.Error /> : null}
                    </div>
                  }}
                </ThreadPrimitive.Messages>
              </ThreadPrimitive.Viewport>
              <div className="shrink-0 border-t border-slate-800 p-3">
                <ComposerPrimitive.Root className="flex items-end gap-2 rounded-xl border border-slate-700 bg-slate-900 p-2 focus-within:border-emerald-500">
                  <ComposerPrimitive.Input aria-label="Message local assistant" placeholder="Ask about payoff paths or risk…" className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-xs text-slate-100 outline-none placeholder:text-slate-500" />
                  <ComposerPrimitive.Cancel className="rounded-lg border border-slate-700 px-2 py-2 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40">Stop</ComposerPrimitive.Cancel>
                  <ComposerPrimitive.Send className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40">Send</ComposerPrimitive.Send>
                </ComposerPrimitive.Root>
                <p className="mt-2 text-center text-[10px] text-slate-500">Local model output may be inaccurate. Demo analytics are not investment advice.</p>
              </div>
            </ThreadPrimitive.Root>
          </AssistantRuntimeProvider> : null}

          {error ? <div className="absolute bottom-16 left-4 right-4 z-20 rounded-lg border border-rose-500/30 bg-rose-950/95 px-3 py-2 text-xs text-rose-100 shadow-lg">{error}<button type="button" className="ml-2 underline" onClick={() => setError('')}>Dismiss</button></div> : null}
        </aside>
      </div> : null}
    </>
  )
}
