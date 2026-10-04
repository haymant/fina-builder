import { useEffect, useRef, useState } from 'react'
import { Bot, ChevronRight, Hammer, Plus, RefreshCw, Server, Wrench } from 'lucide-react'
import type { AgentSkill } from './skills'
import type { McpConnection } from './mcpClient'

export type ComposerMenuProps = {
  connection: McpConnection | null
  connectionError: string | null
  connecting: boolean
  skills: readonly AgentSkill[]
  activeSkillIds: readonly string[]
  onToggleSkill: (id: string) => void
  onRetryConnection: () => void
  onRefreshSkills: () => void
  /** Insert `/{name}` tokens into the composer for a chosen tool or skill. */
  onInsert: (token: string) => void
}

type MenuView = 'root' | 'servers' | 'tools' | 'skills'

function MenuRow({
  icon,
  label,
  hint,
  onClick,
  expandable,
  active,
}: {
  icon: React.ReactNode
  label: string
  hint?: string
  onClick?: () => void
  expandable?: boolean
  active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`agent-accent-hover flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs transition ${active ? 'agent-accent' : 'agent-text'}`}
    >
      <span className="agent-muted shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {hint ? <span className="agent-muted block truncate text-[10px]">{hint}</span> : null}
      </span>
      {expandable ? <ChevronRight size={13} className="agent-muted shrink-0" /> : null}
    </button>
  )
}

function BackRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="agent-muted px-3 py-1 text-[10px] hover:underline">
      ← {label}
    </button>
  )
}

/**
 * Composer `+` source menu, following the assistant-ui composer convention.
 *
 * Root → MCP server → the server's tools, and Root → Skills. Clicking a tool or
 * skill inserts `/{name}` into the composer.
 */
export function ComposerSourceMenu({
  connection,
  connectionError,
  connecting,
  skills,
  activeSkillIds,
  onToggleSkill,
  onRetryConnection,
  onRefreshSkills,
  onInsert,
}: ComposerMenuProps) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<MenuView>('root')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handlePointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handlePointer)
    return () => document.removeEventListener('mousedown', handlePointer)
  }, [open])

  const openAt = (nextView: MenuView) => {
    setView(nextView)
    setOpen(true)
  }

  const tools = connection?.rawTools ?? []
  const serverLabel = connection?.serverName ?? 'fina-mcp'
  const serverHint = connection
    ? `${tools.length} tools · connected`
    : connecting
      ? 'connecting…'
      : 'unavailable'

  const choose = (name: string) => {
    onInsert(`/${name}`)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Add context"
        title="Add MCP server or skill"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openAt('root'))}
        onMouseEnter={() => openAt('root')}
        className="agent-button grid h-8 w-8 shrink-0 place-items-center rounded-lg"
      >
        <Plus size={16} className={`transition-transform ${open ? 'rotate-45' : ''}`} />
      </button>

      {open ? (
        <div className="agent-surface absolute bottom-full left-0 z-30 mb-2 w-72 overflow-hidden rounded-xl shadow-2xl">
          <p className="agent-muted agent-border border-b px-3 py-2 text-[10px] font-semibold uppercase tracking-wide">
            {view === 'root' ? 'Add context' : view === 'tools' ? `${serverLabel} tools` : view === 'servers' ? 'MCP servers' : 'Skills'}
          </p>
          <div className="max-h-80 overflow-y-auto p-1">
            {view === 'root' ? (
              <>
                <MenuRow
                  icon={<Server size={14} />}
                  label="MCP server"
                  hint={serverHint}
                  expandable
                  onClick={() => setView('servers')}
                />
                <MenuRow
                  icon={<Hammer size={14} />}
                  label="Skills"
                  hint={`${skills.length} available`}
                  expandable
                  onClick={() => setView('skills')}
                />
              </>
            ) : null}

            {view === 'servers' ? (
              <>
                <BackRow label="Add context" onClick={() => setView('root')} />
                <MenuRow
                  icon={<Wrench size={14} />}
                  label={serverLabel}
                  hint={serverHint}
                  expandable
                  onClick={() => (tools.length > 0 ? setView('tools') : onRetryConnection())}
                />
                {!connection ? (
                  <div className="px-3 pb-1 pt-2">
                    {connectionError ? <p className="agent-muted mb-2 text-[10px] leading-4">{connectionError}</p> : null}
                    <button
                      type="button"
                      onClick={onRetryConnection}
                      className="agent-button flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px]"
                    >
                      <RefreshCw size={12} /> Retry connection
                    </button>
                  </div>
                ) : null}
              </>
            ) : null}

            {view === 'tools' ? (
              <>
                <BackRow label={serverLabel} onClick={() => setView('servers')} />
                {tools.map((tool) => (
                  <button
                    key={tool.name}
                    type="button"
                    onClick={() => choose(tool.name)}
                    className="agent-accent-hover agent-text flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-[11px] transition"
                  >
                    <Bot size={12} className="agent-muted mt-0.5 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{tool.name}</span>
                      {tool.description ? <span className="agent-muted block text-[10px] leading-4">{tool.description}</span> : null}
                    </span>
                  </button>
                ))}
              </>
            ) : null}

            {view === 'skills' ? (
              <>
                <BackRow label="Add context" onClick={() => setView('root')} />
                {skills.length === 0 ? (
                  <p className="agent-muted px-3 py-2 text-[10px]">No SKILL.md files found.</p>
                ) : skills.map((skill) => {
                  const active = activeSkillIds.includes(skill.id)
                  return (
                    <div key={skill.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onToggleSkill(skill.id)}
                        title={active ? 'Deactivate skill' : 'Activate skill'}
                        className={`agent-accent-hover mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border ${active ? 'agent-accent-bg agent-accent' : 'agent-border'}`}
                      >
                        {active ? '✓' : ''}
                      </button>
                      <button
                        type="button"
                        onClick={() => choose(skill.id)}
                        className="agent-accent-hover agent-text flex min-w-0 flex-1 items-start gap-1 rounded-lg px-2 py-2 text-left text-[11px] transition"
                      >
                        <span className="min-w-0 flex-1">
                          <span className={`block font-medium ${active ? 'agent-accent-strong' : ''}`}>{skill.name}</span>
                          <span className="agent-muted block text-[10px] leading-4">{skill.description}</span>
                        </span>
                      </button>
                    </div>
                  )
                })}
                <button
                  type="button"
                  onClick={onRefreshSkills}
                  className="agent-button mt-1 flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[11px]"
                >
                  <RefreshCw size={12} /> Rescan skills
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
