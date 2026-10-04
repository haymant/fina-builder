import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ThemeProvider } from './features/themes/ThemeProvider'
import { Workspace } from './features/workspace/components/Workspace'
import { useSimulationStore } from './store/simulationStore'

const LocalAgentPanel = lazy(() => import('./features/local-agent/LocalAgentPanel').then((module) => ({ default: module.LocalAgentPanel })))

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
  const status = useSimulationStore((s) => s.status)
  const error = useSimulationStore((s) => s.error)
  const load = useSimulationStore((s) => s.load)

  // The bundle is generated once through the transport; every tile reads it
  // from the store (§5d.2).
  useEffect(() => {
    void useSimulationStore.getState().load()
  }, [])

  return (
    <ThemeProvider>
      {status === 'error' ? (
        <div className="fixed inset-x-0 top-0 z-50 flex items-center gap-3 border-b border-danger/40 bg-danger/10 px-4 py-2">
          <span className="text-xs font-semibold text-danger">Simulation failed to load</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted">{error}</span>
          <button
            type="button"
            className="shock-button"
            onClick={() => void load()}
          >
            Retry
          </button>
        </div>
      ) : null}
      <Workspace onOpenLocalAgent={() => { setHasOpenedLocalAgent(true); setLocalAgentOpen(true) }} />
      {hasOpenedLocalAgent ? (
        <Suspense fallback={null}>
          <PanelErrorBoundary>
            <LocalAgentPanel open={localAgentOpen} onClose={() => setLocalAgentOpen(false)} />
          </PanelErrorBoundary>
        </Suspense>
      ) : null}
    </ThemeProvider>
  )
}
