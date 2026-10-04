import { useEffect, useRef, useState } from 'react'
import { Bot, ChevronRight, Hammer, Plus, Server, Wrench } from 'lucide-react'
import { AGENT_SKILLS, type AgentSkill } from './skills'
import type { McpConnection } from './mcpClient'

export type ComposerMenuProps = {
  connection: McpConnection | null
  connectionError: string | null
  activeSkillIds: readonly string[]
  onToggleSkill: (id: string) => void
}

type MenuView = 'root' | 'servers' | 'skills'

function MenuItem({
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

/**
 * Composer `+` source menu, following the assistant-ui composer convention.
 *
 * Level 1: sources (MCP server, Skills).
 * Level 2: the registered MCP server / the skill list.
 * Level 3: a hovered MCP server's tools.
 */
export function ComposerSourceMenu({ connection, connectionError, activeSkillIds, onToggleSkill }: ComposerMenuProps) {
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
    ? `${tools.length} tools`
    : connectionError
      ? 'unavailable'
      : 'connecting…'

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
          <p className="agent-muted agent-border border-b px-3 py-2 text-[10px] font-semibold uppercase tracking-wide">Add context</p>
          <div className="p-1">
            {view === 'root' ? (
              <>
                <div className="relative">
                  <MenuItem
                    icon={<Server size={14} />}
                    label="MCP server"
                    hint={serverHint}
                    expandable
                    onClick={() => setView('servers')}
                  />
                </div>
                <div className="relative">
                  <MenuItem
                    icon={<Hammer size={14} />}
                    label="Skills"
                    hint={`${AGENT_SKILLS.length} available`}
                    expandable
                    onClick={() => setView('skills')}
                  />
                </div>
              </>
            ) : null}

            {view === 'servers' ? (
              <>
                <button type="button" onClick={() => setView('root')} className="agent-muted px-3 py-1 text-[10px] hover:underline">
                  ← Add context
                </button>
                <div className="group relative">
                  <MenuItem
                    icon={<Wrench size={14} />}
                    label={serverLabel}
                    hint={connection ? `${tools.length} tools · connected` : 'unavailable'}
                  />
                  {tools.length > 0 ? (
                    <div className="agent-surface absolute left-full top-0 z-40 ml-1 hidden w-72 overflow-hidden rounded-xl shadow-2xl group-hover:block">
                      <p className="agent-muted agent-border border-b px-3 py-2 text-[10px] font-semibold uppercase tracking-wide">{serverLabel} tools</p>
                      <div className="max-h-72 overflow-y-auto p-1">
                        {tools.map((tool) => (
                          <div key={tool.name} className="rounded-lg px-3 py-2">
                            <p className="agent-title flex items-center gap-1.5 text-[11px] font-medium"><Bot size={11} className="agent-muted" /> {tool.name}</p>
                            {tool.description ? <p className="agent-muted mt-0.5 text-[10px] leading-4">{tool.description}</p> : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}

            {view === 'skills' ? (
              <>
                <button type="button" onClick={() => setView('root')} className="agent-muted px-3 py-1 text-[10px] hover:underline">
                  ← Add context
                </button>
                <div className="group relative">
                  <MenuItem
                    icon={<Hammer size={14} />}
                    label="Installed skills"
                    hint={`${AGENT_SKILLS.length} available`}
                  />
                  <div className="agent-surface absolute left-full top-0 z-40 ml-1 hidden w-72 overflow-hidden rounded-xl shadow-2xl group-hover:block">
                    <p className="agent-muted agent-border border-b px-3 py-2 text-[10px] font-semibold uppercase tracking-wide">Toggle skills</p>
                    <div className="max-h-72 overflow-y-auto p-1">
                      {AGENT_SKILLS.map((skill: AgentSkill) => {
                        const active = activeSkillIds.includes(skill.id)
                        return (
                          <button
                            key={skill.id}
                            type="button"
                            onClick={() => onToggleSkill(skill.id)}
                            className={`agent-accent-hover flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-[11px] transition ${active ? 'agent-accent' : 'agent-text'}`}
                          >
                            <span className={`mt-0.5 grid h-3.5 w-3.5 shrink-0 place-items-center rounded border ${active ? 'agent-accent-bg agent-accent' : 'agent-border'}`}>
                              {active ? '✓' : ''}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block font-medium">{skill.name}</span>
                              <span className="agent-muted block text-[10px] leading-4">{skill.description}</span>
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
