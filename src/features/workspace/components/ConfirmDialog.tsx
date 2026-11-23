// In-app confirmation. Native `window.confirm` is a no-op (or returns false) in
// some Tauri webviews, which made destructive actions look broken — tile removal
// had two stacked confirms and never proceeded. This dialog is plain DOM, themed,
// keyboard-dismissable and works everywhere.

import { useEffect, useRef } from 'react'

export interface ConfirmRequest {
  title: string
  message: string
  confirmLabel?: string
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  onConfirm,
  onCancel,
}: {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    cancelRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])
  if (!open) return null
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel} data-testid="confirm-dialog-backdrop">
      <div
        className="expanded-modal confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        data-testid="confirm-dialog"
      >
        <div className="confirm-body">
          <h2 id="confirm-dialog-title" className="text-sm font-semibold text-main">
            {title}
          </h2>
          <p className="mt-1 whitespace-pre-line text-xs text-muted">{message}</p>
          <div className="confirm-actions">
            <button ref={cancelRef} type="button" className="ghost-button" onClick={onCancel} data-testid="confirm-cancel">
              Cancel
            </button>
            <button type="button" className="danger-button" onClick={onConfirm} data-testid="confirm-accept">
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
