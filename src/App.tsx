import { useEffect } from 'react'
import { ThemeProvider } from './features/themes/ThemeProvider'
import { Workspace } from './features/workspace/components/Workspace'
import { useSimulationStore } from './store/simulationStore'

export default function App() {
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
      <Workspace />
    </ThemeProvider>
  )
}