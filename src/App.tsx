import { Component, lazy, Suspense, useMemo, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { X } from 'lucide-react'
import { createTauriTransport } from '@rigai/assistant-ui/tauri'
import type { AssistantUIProps } from '@rigai/assistant-ui'
import { ThemeProvider } from './features/themes/ThemeProvider'
import { Workspace } from './features/workspace/components/Workspace'
import { useExplorerStore } from './store/explorerStore'

// The chat panel is RIGA's assistant surface (§ RIGA integration). It is loaded
// lazily so its code only enters the bundle when the panel is first opened.
const AssistantUI = lazy(() => import('@rigai/assistant-ui').then((module) => ({ default: module.AssistantUI })))

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Keep a chat-panel render error from taking the whole app down. */
class PanelErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    if ('__TAURI_INTERNALS__' in window) {
      void invoke('report_frontend_error', { context: 'panel-boundary', message: `${error.name}: ${error.message}\n${error.stack ?? ''}` }).catch(() => undefined)
    }
  }
  render() {
    if (this.state.error) {
      return (
        <div className="fixed inset-y-0 right-0 z-[100] flex w-full max-w-[460px] flex-col gap-3 border-l border-line bg-panel p-4 text-xs">
          <p className="font-semibold text-danger">The chat panel hit an error</p>
          <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-muted">{String(this.state.error?.stack ?? this.state.error)}</pre>
          <button type="button" className="shock-button w-fit" onClick={() => this.setState({ error: null })}>Dismiss</button>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  const [localAgentOpen, setLocalAgentOpen] = useState(false)
  const [hasOpenedLocalAgent, setHasOpenedLocalAgent] = useState(false)
  const [chatWidth, setChatWidth] = useState(() => {
    const saved = Number(localStorage.getItem('fina-chat-width') ?? 560)
    const base = Number.isFinite(saved) && saved > 0 ? saved : 560
    return Math.max(360, Math.min(Math.round(window.innerWidth * 0.8), base))
  })
  const saveChatWidth = (value: number) => {
    const next = Math.max(360, Math.min(Math.round(window.innerWidth * 0.8), value))
    setChatWidth(next)
    localStorage.setItem('fina-chat-width', String(next))
  }
  const startChatResize = (event: { clientX: number }) => {
    const start = event.clientX
    const initial = chatWidth
    const move = (moveEvent: MouseEvent) => saveChatWidth(initial - (moveEvent.clientX - start))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  // Follow fina-builder's theme instead of letting the assistant own one, and
  // hide RIGA's own title bar so the composer is not pushed off-screen.
  const theme = useExplorerStore((s) => s.theme)

  const desktop = isTauriRuntime()
  // Tauri uses in-process IPC; the browser uses RIGA's HTTP/WebSocket transport
  // (Vite proxies the riga-server endpoints). See `modules/riga/demo/src/App.tsx`.
  const transportFactory = useMemo<AssistantUIProps['transportFactory']>(
    () => (desktop ? (listeners) => createTauriTransport({ listeners }) : undefined),
    [desktop],
  )

  return (
    <ThemeProvider>
      <Workspace onOpenLocalAgent={() => { setHasOpenedLocalAgent(true); setLocalAgentOpen(true) }} />
      {hasOpenedLocalAgent && localAgentOpen ? (
        <aside
          className="fixed inset-y-0 right-0 z-[60] flex max-w-[92vw] flex-col border-l border-line bg-panel shadow-2xl"
          style={{ width: chatWidth }}
          aria-label="RIGA assistant"
        >
          <div
            className="notebook-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize chat panel"
            onMouseDown={startChatResize}
          />
          <header className="flex shrink-0 items-center justify-between border-b border-line px-3 py-2">
            <span className="text-xs font-semibold text-main">RIGA assistant</span>
            <button type="button" className="tile-action" title="Close" onClick={() => setLocalAgentOpen(false)}>
              <X size={14} />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">
            <Suspense fallback={<div className="p-3 text-xs text-muted">Loading assistant…</div>}>
              <PanelErrorBoundary>
                <AssistantUI showSessionHistoryButton fullWidth showHeader={false} theme={theme} transportFactory={transportFactory} />
              </PanelErrorBoundary>
            </Suspense>
          </div>
        </aside>
      ) : null}
    </ThemeProvider>
  )
}
