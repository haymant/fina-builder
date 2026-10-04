import {
  AuiIf,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import {
  ArrowLeft,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Cpu,
  Download,
  FolderOpen,
  History,
  LoaderCircle,
  MessageSquare,
  Plus,
  RefreshCw,
  Square,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createLocalAgentAdapter, storedMessagesToThreadMessages } from './piLocalRuntime'
import { getMcpConnection, resetMcpConnection, type McpConnection } from './mcpClient'
import { ComposerSourceMenu } from './ComposerSourceMenu'
import { AGENT_SKILLS, type AgentSkill } from './skills'

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
type SessionSummary = { sessionId: string; title: string; updatedAt: number; messageCount: number }

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const formatSize = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes < 1_000_000_000 ? 2 : 1)} GB`
const newSessionId = () => `chat_${crypto.randomUUID().replace(/-/g, '')}`

function formatRelative(epochSeconds: number) {
  if (!epochSeconds) return 'Just now'
  const minutes = Math.floor((Date.now() - epochSeconds * 1000) / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(epochSeconds * 1000).toLocaleDateString()
}

function IconButton({
  label,
  onClick,
  children,
  disabled,
  active,
}: {
  label: string
  onClick: () => void
  children: ReactNode
  disabled?: boolean
  active?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      data-active={active ? 'true' : undefined}
      className="agent-button grid h-8 w-8 shrink-0 place-items-center rounded-lg disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function ModelPicker({
  loadedName,
  models,
  onSelect,
  onManage,
}: {
  loadedName: string | null
  models: LocalModel[]
  onSelect: (path: string) => void
  onManage: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handlePointer)
    return () => document.removeEventListener('mousedown', handlePointer)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="agent-button flex h-8 min-w-0 max-w-[190px] items-center gap-1.5 rounded-lg px-2 text-[11px]"
      >
        <Cpu size={13} className="shrink-0" />
        <span className="truncate">{loadedName ?? 'Select model'}</span>
        <ChevronDown size={12} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div className="agent-surface absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-xl shadow-2xl">
          <p className="agent-muted agent-border border-b px-3 py-2 text-[10px] font-semibold uppercase tracking-wide">Installed models</p>
          <div className="max-h-56 overflow-y-auto p-1">
            {models.length === 0 ? <p className="agent-muted px-2 py-3 text-[11px]">No model files found.</p> : models.map((model) => {
              const selected = model.fileName === loadedName
              return (
                <button
                  key={model.path}
                  type="button"
                  onClick={() => {
                    onSelect(model.path)
                    setOpen(false)
                  }}
                  className={`agent-accent-hover flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[11px] transition ${selected ? 'agent-accent' : 'agent-text'}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{model.name}</span>
                    <span className="agent-muted block truncate text-[10px]">{formatSize(model.sizeBytes)}</span>
                  </span>
                  {selected ? <Check size={14} className="shrink-0" /> : null}
                </button>
              )
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              onManage()
              setOpen(false)
            }}
            className="agent-accent agent-border agent-accent-hover flex w-full items-center gap-2 border-t px-3 py-2.5 text-left text-[11px] font-medium"
          >
            <Download size={13} /> Download or load another model…
          </button>
        </div>
      ) : null}
    </div>
  )
}

function ChatThread({
  sessionId,
  initialPiMessages,
  displayMessages,
  loadedName,
  models,
  activeSkills,
  mcpConnection,
  mcpError,
  mcpConnecting,
  onToggleSkill,
  onRetryConnection,
  onSelectModel,
  onManageModels,
  onSaved,
}: {
  sessionId: string
  initialPiMessages: readonly unknown[]
  displayMessages: readonly ThreadMessageLike[]
  loadedName: string | null
  models: LocalModel[]
  activeSkills: readonly AgentSkill[]
  mcpConnection: McpConnection | null
  mcpError: string | null
  mcpConnecting: boolean
  onToggleSkill: (id: string) => void
  onRetryConnection: () => void
  onSelectModel: (path: string) => void
  onManageModels: () => void
  onSaved: () => void
}) {
  const adapter = useMemo(
    () =>
      createLocalAgentAdapter({
        sessionId,
        initialMessages: initialPiMessages,
        skills: activeSkills,
        onSaved,
      }),
    [sessionId, initialPiMessages, activeSkills, onSaved],
  )
  const runtime = useLocalRuntime(adapter, { initialMessages: displayMessages })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
        <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4" autoScroll>
          <ThreadPrimitive.Empty>
            <div className="flex flex-col items-center justify-center px-5 py-14 text-center">
              <MessageSquare size={22} className="agent-accent mb-3" />
              <p className="agent-title text-sm font-medium">Ask about this workspace</p>
              <p className="agent-muted mt-1 text-xs leading-5">The assistant can inspect local demo path statistics and payoff distributions. Inference stays on this device.</p>
            </div>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages>
            {({ message }) => {
              const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).filter(Boolean).join('\n')
              return (
                <div
                  key={message.id}
                  className={`max-w-[92%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-xs leading-5 ${
                    message.role === 'user'
                      ? 'agent-bubble-user ml-auto rounded-br-sm'
                      : 'agent-bubble mr-auto rounded-bl-sm'
                  }`}
                >
                  {text || (message.role === 'assistant' ? '…' : '')}
                  {message.role === 'assistant' ? <MessagePrimitive.Error /> : null}
                </div>
              )
            }}
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
        <div className="agent-border shrink-0 border-t p-3">
          <ComposerPrimitive.Root className="agent-surface flex flex-col gap-1.5 rounded-2xl p-2 transition">
            <ComposerPrimitive.Input
              aria-label="Message local assistant"
              placeholder="Ask about payoff paths or risk…"
              rows={1}
              className="agent-text max-h-32 min-h-10 w-full resize-none bg-transparent px-2 py-2 text-xs outline-none placeholder:text-[color:var(--theme-muted)]"
            />
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <ComposerSourceMenu
                  connection={mcpConnection}
                  connectionError={mcpError}
                  connecting={mcpConnecting}
                  activeSkillIds={activeSkills.map((skill) => skill.id)}
                  onToggleSkill={onToggleSkill}
                  onRetryConnection={onRetryConnection}
                />
                <ModelPicker loadedName={loadedName} models={models} onSelect={onSelectModel} onManage={onManageModels} />
              </div>
              <div className="flex items-center gap-1.5">
                <AuiIf condition={(s) => !s.thread.isRunning}>
                  <ComposerPrimitive.Send
                    aria-label="Send message"
                    className="agent-primary-solid grid h-8 w-8 place-items-center rounded-full transition disabled:opacity-40"
                  >
                    <ArrowUp size={16} />
                  </ComposerPrimitive.Send>
                </AuiIf>
                <AuiIf condition={(s) => s.thread.isRunning}>
                  <ComposerPrimitive.Cancel
                    aria-label="Stop generating"
                    className="agent-surface agent-text agent-danger-hover grid h-8 w-8 place-items-center rounded-full transition disabled:opacity-40"
                  >
                    <Square size={11} className="fill-current" />
                  </ComposerPrimitive.Cancel>
                </AuiIf>
              </div>
            </div>
          </ComposerPrimitive.Root>
          <p className="agent-muted mt-2 text-center text-[10px]">Local model output may be inaccurate. Demo analytics are not investment advice.</p>
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  )
}

function ModelManager({
  models,
  catalog,
  progress,
  selectedPath,
  onSelectPath,
  busy,
  showCatalog,
  onShowCatalog,
  onStartDownload,
  onCancelDownload,
  onLoad,
  onOpenFolder,
  onRefresh,
  onClose,
}: {
  models: LocalModel[]
  catalog: CatalogModel[]
  progress: Record<string, Progress>
  selectedPath: string
  onSelectPath: (path: string) => void
  busy: boolean
  showCatalog: boolean
  onShowCatalog: (value: boolean) => void
  onStartDownload: (modelId: string) => void
  onCancelDownload: (modelId: string) => void
  onLoad: () => void
  onOpenFolder: () => void
  onRefresh: () => void
  onClose?: () => void
}) {
  const selectedModel = models.find((model) => model.path === selectedPath)
  const showCurated = models.length === 0 || showCatalog

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {onClose ? (
        <div className="agent-border flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
          <IconButton label="Back to chat" onClick={onClose}>
            <ArrowLeft size={16} />
          </IconButton>
          <p className="agent-title text-xs font-semibold">Manage models</p>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        {showCurated ? (
          <>
            <div className="agent-surface-soft mb-4 rounded-xl p-4">
              <h2 className="agent-title text-sm font-semibold">Add a local model to start chatting</h2>
              <p className="agent-muted mt-1 text-xs leading-5">Download a curated GGUF model, or copy a compatible .gguf file into your models folder. Model files stay on this device.</p>
            </div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="agent-title text-xs font-semibold uppercase tracking-wide">Curated models</h3>
              {models.length > 0 ? (
                <button type="button" onClick={() => onShowCatalog(false)} className="agent-accent text-[10px] hover:underline">
                  Use an installed model
                </button>
              ) : (
                <span className="agent-muted text-[10px]">Q4_K_M quantization</span>
              )}
            </div>
            <div className="space-y-2">
              {catalog.map((model) => {
                const job = progress[model.id]
                return (
                  <article key={model.id} className="agent-surface-soft rounded-xl p-3">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <h4 className="agent-title text-xs font-semibold">{model.name}</h4>
                        <p className="agent-muted mt-1 text-[10px]">{formatSize(model.sizeBytes)} · context {model.recommendedContext.toLocaleString()} · {model.quant}</p>
                        <p className="agent-muted mt-1 truncate text-[10px]" title={model.chatTemplate}>{model.chatTemplate}</p>
                        <a className="agent-accent mt-1 inline-block text-[10px] underline-offset-2 hover:underline" href={model.licenseUrl} target="_blank" rel="noreferrer">Model license / terms</a>
                      </div>
                      {job ? (
                        <button type="button" className="agent-button rounded p-1.5" aria-label={`Cancel ${model.name} download`} onClick={() => onCancelDownload(model.id)}>
                          <X size={14} />
                        </button>
                      ) : (
                        <button type="button" className="agent-primary-solid inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-medium" onClick={() => onStartDownload(model.id)}>
                          <Download size={12} /> Download
                        </button>
                      )}
                    </div>
                    {job ? (
                      <div className="mt-3">
                        <div className="agent-muted mb-1 flex justify-between text-[10px]"><span>{formatSize(job.downloadedBytes)} / {formatSize(job.totalBytes)}</span><span>{Math.floor(job.percent)}%</span></div>
                        <div className="agent-progress-track h-1.5 overflow-hidden rounded"><div className="agent-progress-fill h-full transition-all" style={{ width: `${job.percent}%` }} /></div>
                      </div>
                    ) : null}
                  </article>
                )
              })}
            </div>
          </>
        ) : (
          <>
            <div className="agent-surface-soft mb-4 rounded-xl p-4">
              <h2 className="agent-title text-sm font-semibold">Choose a local GGUF model</h2>
              <p className="agent-muted mt-1 text-xs">Any .gguf file copied into the models folder is discovered on refresh.</p>
            </div>
            <label htmlFor="local-model-select" className="agent-muted mb-1 text-xs">Available models</label>
            <select id="local-model-select" value={selectedPath} onChange={(event) => onSelectPath(event.target.value)} className="agent-select rounded-lg px-3 py-2 text-xs">
              {models.map((model) => <option key={model.path} value={model.path}>{model.name} · {formatSize(model.sizeBytes)}</option>)}
            </select>
            {selectedModel?.licenseUrl ? <a className="agent-accent mt-2 text-[10px] underline-offset-2 hover:underline" href={selectedModel.licenseUrl} target="_blank" rel="noreferrer">Model license / terms</a> : null}
            <button type="button" disabled={!selectedPath || busy} onClick={onLoad} className="agent-primary-solid mt-4 inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold disabled:opacity-50">
              {busy ? <LoaderCircle className="animate-spin" size={14} /> : <Check size={14} />} Load model
            </button>
            <button type="button" onClick={() => onShowCatalog(true)} className="agent-accent agent-accent-hover mt-2 rounded-lg px-3 py-2 text-[11px]">Download another curated model</button>
          </>
        )}
        <button type="button" onClick={onOpenFolder} className="agent-button mt-4 inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs"><FolderOpen size={14} /> Open models folder</button>
        <button type="button" onClick={onRefresh} className="agent-muted agent-accent-hover mt-2 inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[11px]"><RefreshCw size={13} /> Refresh model list</button>
      </div>
    </div>
  )
}

export function LocalAgentPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [paths, setPaths] = useState<AppPaths | null>(null)
  const [models, setModels] = useState<LocalModel[]>([])
  const [catalog, setCatalog] = useState<CatalogModel[]>([])
  const [selectedPath, setSelectedPath] = useState('')
  const [loadedName, setLoadedName] = useState<string | null>(null)
  const [progress, setProgress] = useState<Record<string, Progress>>({})
  const [busy, setBusy] = useState(false)
  const [showCatalog, setShowCatalog] = useState(false)
  const [manageModels, setManageModels] = useState(false)
  const [error, setError] = useState('')
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [activeSessionId, setActiveSessionId] = useState(newSessionId)
  const [activeSessionMessages, setActiveSessionMessages] = useState<readonly unknown[]>([])
  const [chatKey, setChatKey] = useState(0)
  const [mcpConnection, setMcpConnection] = useState<McpConnection | null>(null)
  const [mcpError, setMcpError] = useState<string | null>(null)
  const [mcpConnecting, setMcpConnecting] = useState(false)
  const [activeSkillIds, setActiveSkillIds] = useState<readonly string[]>([])

  const activeSkills = useMemo(
    () => AGENT_SKILLS.filter((skill) => activeSkillIds.includes(skill.id)),
    [activeSkillIds],
  )

  const toggleSkill = useCallback((id: string) => {
    setActiveSkillIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    )
  }, [])

  const refresh = useCallback(async () => {
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
  }, [])

  const refreshSessions = useCallback(async () => {
    if (!isTauri) return
    try {
      setSessions(await invoke<SessionSummary[]>('list_local_agent_sessions'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [])

  const handleSaved = useCallback(() => {
    void refreshSessions()
  }, [refreshSessions])

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
  }, [open, refresh])

  // Load the MCP tool list for the composer `+` menu. The Rust runtime owns the
  // `fina-mcp` process; this just calls `mcp_list_tools`.
  const connectMcp = useCallback(() => {
    if (!isTauri) return
    // Defer the first state update so calling this from an effect does not
    // synchronously set state during render/commit.
    const pending = Promise.resolve().then(() => {
      setMcpConnecting(true)
      return getMcpConnection()
    })
    void pending
      .then((connection) => {
        setMcpConnection(connection)
        setMcpError(null)
      })
      .catch((reason) => {
        setMcpConnection(null)
        setMcpError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => setMcpConnecting(false))
  }, [])

  const retryMcp = useCallback(() => {
    void resetMcpConnection().finally(() => connectMcp())
  }, [connectMcp])

  useEffect(() => {
    if (!open || !isTauri) return
    connectMcp()
  }, [open, connectMcp])

  const startDownload = (modelId: string) => {
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

  const loadModel = useCallback(async (path: string) => {
    if (!path) return
    setBusy(true)
    setError('')
    try {
      await invoke('load_model', { path })
      setLoadedName(path.split(/[\\/]/).pop() ?? 'local model')
      setSelectedPath(path)
      setManageModels(false)
      setShowCatalog(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [])

  const openModelsFolder = async () => {
    setError('')
    try {
      await invoke('open_models_folder')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const startNewChat = useCallback(() => {
    setActiveSessionId(newSessionId())
    setActiveSessionMessages([])
    setChatKey((value) => value + 1)
    setHistoryOpen(false)
  }, [])

  const openSession = async (sessionId: string) => {
    setError('')
    try {
      const messages = await invoke<unknown[]>('load_local_agent_session', { sessionId })
      setActiveSessionId(sessionId)
      setActiveSessionMessages(messages)
      setChatKey((value) => value + 1)
      setHistoryOpen(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const openHistory = () => {
    setHistoryOpen(true)
    void refreshSessions()
  }

  const isLoaded = loadedName !== null
  const threadMessages = useMemo(() => storedMessagesToThreadMessages(activeSessionMessages), [activeSessionMessages])

  return (
    <>
      {open ? <div className="fixed inset-0 z-[100] flex justify-end">
        <button aria-label="Close local chat panel" className="agent-backdrop absolute inset-0 cursor-default" onClick={onClose} />
        <aside className="agent-panel relative z-10 flex h-full w-full max-w-[460px] flex-col border-l shadow-2xl">
          <header className="agent-border flex shrink-0 items-center gap-2 border-b px-4 py-3">
            <div className="agent-accent-bg agent-accent flex h-8 w-8 items-center justify-center rounded-lg"><Bot size={17} /></div>
            <div className="min-w-0 flex-1">
              <p className="agent-title text-sm font-semibold">Local assistant</p>
              <p title={paths?.modelsDir} className="agent-muted truncate text-[11px]">{isLoaded ? `Offline · ${loadedName}` : 'Runs on your device'}</p>
            </div>
            <IconButton label="New chat" onClick={startNewChat} disabled={!isLoaded}>
              <Plus size={16} />
            </IconButton>
            <IconButton label="Chat history" onClick={openHistory} active={historyOpen}>
              <History size={16} />
            </IconButton>
            <IconButton label="Close" onClick={onClose}>
              <X size={16} />
            </IconButton>
          </header>

          {!isTauri ? <div className="agent-notice m-4 rounded-xl p-4 text-sm">
            Local inference is available in the packaged Tauri desktop app. The browser-only build cannot access native model files.
          </div> : null}

          {isTauri && !isLoaded ? (
            <ModelManager
              models={models}
              catalog={catalog}
              progress={progress}
              selectedPath={selectedPath}
              onSelectPath={setSelectedPath}
              busy={busy}
              showCatalog={showCatalog}
              onShowCatalog={setShowCatalog}
              onStartDownload={startDownload}
              onCancelDownload={(modelId) => void cancelDownload(modelId)}
              onLoad={() => void loadModel(selectedPath)}
              onOpenFolder={() => void openModelsFolder()}
              onRefresh={() => void refresh()}
            />
          ) : null}

          {isTauri && isLoaded ? (
            <ChatThread
              key={chatKey}
              sessionId={activeSessionId}
              initialPiMessages={activeSessionMessages}
              displayMessages={threadMessages}
              loadedName={loadedName}
              models={models}
              activeSkills={activeSkills}
              mcpConnection={mcpConnection}
              mcpError={mcpError}
              mcpConnecting={mcpConnecting}
              onToggleSkill={toggleSkill}
              onRetryConnection={retryMcp}
              onSelectModel={(path) => void loadModel(path)}
              onManageModels={() => setManageModels(true)}
              onSaved={handleSaved}
            />
          ) : null}

          {isTauri && isLoaded && manageModels ? (
            <div className="agent-panel absolute inset-0 z-30 flex flex-col">
              <ModelManager
                models={models}
                catalog={catalog}
                progress={progress}
                selectedPath={selectedPath}
                onSelectPath={setSelectedPath}
                busy={busy}
                showCatalog={showCatalog}
                onShowCatalog={setShowCatalog}
                onStartDownload={startDownload}
                onCancelDownload={(modelId) => void cancelDownload(modelId)}
                onLoad={() => void loadModel(selectedPath)}
                onOpenFolder={() => void openModelsFolder()}
                onRefresh={() => void refresh()}
                onClose={() => setManageModels(false)}
              />
            </div>
          ) : null}

          {historyOpen ? (
            <div className="agent-panel absolute inset-0 z-40 flex flex-col">
              <header className="agent-border flex shrink-0 items-center gap-2 border-b px-3 py-2.5">
                <IconButton label="Back to chat" onClick={() => setHistoryOpen(false)}>
                  <ArrowLeft size={16} />
                </IconButton>
                <p className="agent-title flex-1 text-xs font-semibold">Chats</p>
                <IconButton label="New chat" onClick={startNewChat} disabled={!isLoaded}>
                  <Plus size={16} />
                </IconButton>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto p-2">
                {sessions.length === 0 ? (
                  <p className="agent-muted px-3 py-10 text-center text-xs">No saved chats yet. Start a conversation to see it here.</p>
                ) : sessions.map((session) => {
                  const active = session.sessionId === activeSessionId
                  return (
                    <button
                      key={session.sessionId}
                      type="button"
                      onClick={() => void openSession(session.sessionId)}
                      className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-left transition ${active ? 'agent-accent-bg agent-accent-strong' : 'agent-text agent-accent-hover'}`}
                    >
                      <MessageSquare size={15} className={active ? 'agent-accent' : 'agent-muted'} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{session.title || 'Local chat'}</span>
                        <span className="agent-muted block text-[10px]">{formatRelative(session.updatedAt)} · {session.messageCount} messages</span>
                      </span>
                      {active ? <Check size={14} className="shrink-0" /> : null}
                    </button>
                  )
                })}
              </div>
              <button type="button" onClick={() => void refreshSessions()} className="agent-button m-2 inline-flex shrink-0 items-center justify-center gap-2 rounded-lg px-3 py-2 text-[11px]">
                <RefreshCw size={13} /> Refresh list
              </button>
            </div>
          ) : null}

          {error ? <div className="agent-error absolute bottom-16 left-4 right-4 z-50 rounded-lg px-3 py-2 text-xs shadow-lg">{error}<button type="button" className="ml-2 underline" onClick={() => setError('')}>Dismiss</button></div> : null}
        </aside>
      </div> : null}
    </>
  )
}
