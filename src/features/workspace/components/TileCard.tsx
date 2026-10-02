import { Maximize2, RefreshCw, X } from 'lucide-react'
import { memo, type ReactNode } from 'react'
import type { Tile } from '../../dashboards/types'

export const TileCard = memo(function TileCard({ tile, onRemove, onExpand, children }: { tile: Tile; onRemove: () => void; onExpand: () => void; children: ReactNode }) {
  return <section className="tile-shell flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-sm">
    <header className="tile-header flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
      <span className="h-1.5 w-1.5 rounded-full bg-primary" />
      <div className="min-w-0 flex-1"><h2 className="truncate text-xs font-semibold text-main">{tile.title}</h2><p className="text-[10px] text-muted">Live workspace tile</p></div>
      <button className="tile-action" title="Refresh" type="button"><RefreshCw size={13} /></button>
      <button className="tile-action" title="Expand" type="button" onClick={onExpand}><Maximize2 size={13} /></button>
      <button className="tile-action hover:text-danger" title="Remove" type="button" onClick={onRemove}><X size={14} /></button>
    </header>
    <div className="flex min-h-0 h-full flex-1 flex-col overflow-hidden p-1">{children}</div>
  </section>
})
