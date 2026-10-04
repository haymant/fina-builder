import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import App from './App'
import './index.css'

// Surface uncaught webview errors to the Rust log so a crash is diagnosable
// from <app-data>/frontend-errors.log without a devtools session.
const report = (context: string, message: string) => {
  if (!('__TAURI_INTERNALS__' in window)) return
  void invoke('report_frontend_error', { context, message }).catch(() => undefined)
}
window.addEventListener('error', (event) => {
  report('window.error', `${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`)
})
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  report('unhandledrejection', reason instanceof Error ? `${reason.name}: ${reason.message}\n${reason.stack ?? ''}` : String(reason))
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
