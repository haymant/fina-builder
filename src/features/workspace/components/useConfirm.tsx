import { useCallback, useRef, useState, type ReactNode } from 'react'
import { ConfirmDialog, type ConfirmRequest } from './ConfirmDialog'

/**
 * Promise-based confirmation for flows that cannot render a dialog inline.
 *
 * Usage:
 *   const [confirm, confirmDialog] = useConfirm()
 *   if (!(await confirm({ title: 'Dispatch?', message: '...' }))) return
 *   return <>{...}{confirmDialog}</>
 *
 * The dialog is plain DOM, so it works in both the browser and Tauri webviews
 * where native `window.confirm` silently returns false.
 */
export function useConfirm(): [(request: ConfirmRequest) => Promise<boolean>, ReactNode] {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const resolver = useRef<((confirmed: boolean) => void) | null>(null)

  const confirm = useCallback((next: ConfirmRequest) => {
    // A second request supersedes the first; settle the old promise as cancelled
    // so its caller does not hang.
    resolver.current?.(false)
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve
      setRequest(next)
    })
  }, [])

  const settle = useCallback((confirmed: boolean) => {
    const resolve = resolver.current
    resolver.current = null
    setRequest(null)
    resolve?.(confirmed)
  }, [])

  const dialog = (
    <ConfirmDialog
      open={request !== null}
      title={request?.title ?? ''}
      message={request?.message ?? ''}
      confirmLabel={request?.confirmLabel}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  )

  return [confirm, dialog]
}
