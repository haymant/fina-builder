import { Dices, Moon, Sun, Workflow } from 'lucide-react'
import { memo } from 'react'
import { simulationBundle } from '../../../mock-data/generatePaths'
import { useExplorerStore, useSelectedPath } from '../../../store/explorerStore'

export const TopToolbar = memo(function TopToolbar() {
  const selectedPathId = useExplorerStore((s) => s.selectedPathId)
  const setSelectedPathId = useExplorerStore((s) => s.setSelectedPathId)
  const selectRandomPath = useExplorerStore((s) => s.selectRandomPath)
  const theme = useExplorerStore((s) => s.theme)
  const toggleTheme = useExplorerStore((s) => s.toggleTheme)
  const path = useSelectedPath()

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-slate-700/80 bg-panel px-4">
      <div className="flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded bg-primary/20 text-primary">
          <Workflow size={16} />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-slate-100">
            {simulationBundle.productName}
          </div>
          <div className="text-[10px] text-muted">{simulationBundle.tagline}</div>
        </div>
      </div>

      <div className="mx-2 hidden h-6 w-px bg-slate-700 sm:block" />

      <div className="flex items-center gap-2">
        <label className="text-[10px] tracking-wider text-muted uppercase">Path</label>
        <select
          value={selectedPathId}
          onChange={(e) => setSelectedPathId(e.target.value)}
          className="h-8 min-w-[160px] rounded border border-slate-600 bg-bg px-2 font-mono text-xs text-slate-100 outline-none focus:border-primary"
        >
          {simulationBundle.paths.map((p) => (
            <option key={p.id} value={p.id}>
              #{p.pathIndex} · PV {p.attribution.totalPv.toFixed(1)}
              {p.knockedOut ? ' · KO' : p.knockInTriggered ? ' · KI' : ' · Alive'}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={selectRandomPath}
          className="inline-flex h-8 items-center gap-1.5 rounded border border-slate-600 bg-slate-800 px-2.5 text-xs text-slate-200 transition hover:border-primary hover:text-primary"
          title="Select random path"
        >
          <Dices size={14} />
          Random
        </button>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <div className="hidden items-center gap-2 text-[11px] text-muted md:flex">
          <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-slate-300">
            {simulationBundle.underlyings.join(' / ')}
          </span>
          <span>
            {path.knockedOut
              ? 'Knocked Out'
              : path.knockInTriggered
                ? 'Knocked In'
                : 'No Knock-In'}
          </span>
        </div>
        <button
          type="button"
          onClick={toggleTheme}
          className="inline-flex h-8 w-8 items-center justify-center rounded border border-slate-600 bg-slate-800 text-slate-300 transition hover:border-primary hover:text-primary"
          title="Toggle theme"
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>
      </div>
    </header>
  )
})
