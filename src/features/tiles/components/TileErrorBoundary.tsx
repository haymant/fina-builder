// Per-tile error boundary. A render-time throw in one tile (e.g. an engine
// field the UI did not expect) must show an inline error, never blank the whole
// workspace. `key={type}` on the boundary resets it when the tile changes.

import { Component, type ReactNode } from 'react'
import { PanelCard } from '../../shared/components/PanelCard'

interface State {
  error: Error | null
}

export class TileErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    console.error('tile render error', error, info.componentStack)
    if (typeof window !== 'undefined') {
      const report = (window as { __reportFrontendError?: (context: string, message: string) => void }).__reportFrontendError
      report?.('tile-render', `${error.message}\n${info.componentStack ?? ''}`)
    }
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <PanelCard title="Tile error" subtitle="This tile failed to render">
          <div className="space-y-2 p-3">
            <p className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[10px] font-semibold text-danger">
              RENDER ERROR
            </p>
            <p className="font-mono text-[10px] break-words text-muted">{this.state.error.message}</p>
          </div>
        </PanelCard>
      )
    }
    return this.props.children
  }
}
