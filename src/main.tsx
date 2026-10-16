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

// The RIGA assistant emits `riga:open-link` for external links instead of a
// `target="_blank"` navigation (which would open a second app window in Tauri).
// Open the URL in the OS browser through a first-party command.
window.addEventListener('riga:open-link', (event) => {
  const url = (event as CustomEvent<{ url?: string }>).detail?.url
  if (!url) return
  // Never re-open the app itself (an assistant link back to the dev/app origin).
  try {
    if (new URL(url).origin === window.location.origin) return
  } catch {
    return
  }
  if ('__TAURI_INTERNALS__' in window) {
    void invoke('open_external', { url }).catch(() => undefined)
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
})

// Under the desktop host, `window.open`/`target="_blank"` would spawn a second
// app window. Route every external open to the OS browser instead; this is a
// belt-and-braces guard over the markdown `riga:open-link` event above.
if ('__TAURI_INTERNALS__' in window) {
  const nativeOpen = window.open.bind(window)
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    const href = typeof url === 'string' ? url : (url?.toString() ?? '')
    if (/^https?:/i.test(href)) {
      void invoke('open_external', { url: href }).catch(() => undefined)
      return null
    }
    return nativeOpen(url as never, target, features)
  }) as typeof window.open
}

createRoot(document.getElementById('root')!).render(<App />)
