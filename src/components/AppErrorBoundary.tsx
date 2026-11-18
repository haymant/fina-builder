import { Component, type ErrorInfo, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'

/**
 * A render error must never leave an empty window. Show the error, report it to
 * `<app-data>/logs/frontend-errors.log`, and offer a reload.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if ('__TAURI_INTERNALS__' in window) {
      void invoke('report_frontend_error', {
        context: 'app-boundary',
        message: `${error.name}: ${error.message}\n${error.stack ?? ''}\n${info.componentStack ?? ''}`,
      }).catch(() => undefined)
    }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div role="alert" className="flex min-h-screen flex-col gap-3 bg-background p-6 text-sm text-main">
        <h1 className="text-base font-semibold text-danger">The workspace hit an error</h1>
        <p className="text-xs text-muted">
          The error was written to <code>logs/frontend-errors.log</code> in the app data directory.
        </p>
        <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-panel p-3 font-mono text-[10px] text-muted">
          {String(this.state.error.stack ?? this.state.error)}
        </pre>
        <div className="flex gap-2">
          <button type="button" className="shock-button" onClick={() => window.location.reload()}>Reload</button>
          <button type="button" className="shock-button" onClick={() => this.setState({ error: null })}>Dismiss</button>
        </div>
      </div>
    )
  }
}
