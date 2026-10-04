import { useState } from 'react'
import { Check, ChevronRight, LoaderCircle, Wrench } from 'lucide-react'

/**
 * Tool-call disclosure, following the assistant-ui Tool call element.
 *
 * Collapsed it shows a chevron, the tool label, the primary argument chip, and
 * a check once settled; clicking reveals the raw request and result.
 */
export function ToolCallDisclosure({
  label,
  activeLabel,
  query,
  request,
  result,
  running,
  isError,
}: {
  label: string
  activeLabel: string
  query?: string
  request: string
  result: string
  running: boolean
  isError?: boolean
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="agent-surface overflow-hidden rounded-xl text-xs">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="agent-accent-hover flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ChevronRight size={13} className={`agent-muted shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <Wrench size={13} className="agent-muted shrink-0" />
        <span className={`min-w-0 flex-1 truncate font-medium ${running ? 'agent-muted animate-pulse' : 'agent-text'}`}>
          {running ? activeLabel : label}
        </span>
        {query ? (
          <span className="agent-muted max-w-[40%] shrink-0 truncate rounded bg-[color:var(--theme-background)] px-1.5 py-0.5 font-mono text-[10px]">
            {query}
          </span>
        ) : null}
        {running ? (
          <LoaderCircle size={13} className="agent-muted shrink-0 animate-spin" />
        ) : isError ? (
          <span className="agent-danger shrink-0 text-[11px] font-semibold" aria-label="Tool call failed">!</span>
        ) : (
          <Check size={13} className="agent-accent shrink-0" />
        )}
      </button>
      {open ? (
        <div className="agent-border border-t px-3 py-2">
          <p className="agent-muted mb-1 text-[10px] font-semibold uppercase tracking-wide">Request</p>
          <pre className="agent-text mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-4">{request || '{}'}</pre>
          <p className="agent-muted mb-1 text-[10px] font-semibold uppercase tracking-wide">Result</p>
          <pre className={`max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] leading-4 ${isError ? 'agent-danger' : 'agent-text'}`}>
            {running ? 'Running…' : result || '(empty)'}
          </pre>
        </div>
      ) : null}
    </div>
  )
}
