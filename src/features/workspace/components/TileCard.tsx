import { Maximize2, RefreshCw, X } from 'lucide-react'
import { memo, type ReactNode } from 'react'
import type { Tile } from '../../dashboards/types'

/** Which engine a tile reads, derived from its catalog group. */
export function tileLane(group: string | undefined): 'riga-flow' | 'tac-engine' | 'other' {
  if (group === 'riga-flow') return 'riga-flow'
  if (group === 'tac-engine') return 'tac-engine'
  return 'other'
}

const LANE_STYLE: Record<string, string> = {
  'riga-flow': 'border-primary/40 bg-primary/10 text-primary',
  'tac-engine': 'border-success/40 bg-success/10 text-success',
  other: 'border-warning/40 bg-warning/10 text-warning',
}

const LANE_NOTE: Record<string, string> = {
  'riga-flow': 'riga-flow · live engine',
  'tac-engine': 'tac-engine · live market data',
  other: 'unclassified lane',
}

export const TileCard = memo(function TileCard({
  tile,
  group,
  onRemove,
  onExpand,
  children,
}: {
  tile: Tile
  group?: string
  onRemove: () => void
  onExpand: () => void
  children: ReactNode
}) {
  const lane = tileLane(group)

  return (
    <section className="tile-shell flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-sm">
      <header className="tile-header flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xs font-semibold text-main">{tile.title}</h2>
          <p className="text-[10px] text-muted">{LANE_NOTE[lane]}</p>
        </div>
        <span
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-medium ${LANE_STYLE[lane]}`}
          title={LANE_NOTE[lane]}
        >
          {lane}
        </span>
        <button className="tile-action" title="Refresh" type="button">
          <RefreshCw size={13} />
        </button>
        <button className="tile-action" title="Expand" type="button" onClick={onExpand}>
          <Maximize2 size={13} />
        </button>
        <button className="tile-action hover:text-danger" title="Remove" type="button" onClick={onRemove}>
          <X size={14} />
        </button>
      </header>
      <div className="flex min-h-0 h-full flex-1 flex-col overflow-hidden p-1">{children}</div>
    </section>
  )
})
