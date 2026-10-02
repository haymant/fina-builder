import { Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { TILE_CATALOG } from '../../dashboards/catalog'
import type { TileMeta } from '../../dashboards/catalog'
import type { TileType } from '../../dashboards/types'

export function TileGallery({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (type: TileType) => void }) {
  const [query, setQuery] = useState('')
  const items = useMemo(() => TILE_CATALOG.filter((t) => `${t.title} ${t.description} ${t.group}`.toLowerCase().includes(query.toLowerCase())), [query])
  const groups = useMemo(() => items.reduce<Record<string, TileMeta[]>>((acc, item) => { (acc[item.group] ??= []).push(item); return acc }, {}), [items])
  if (!open) return null
  return <aside className="gallery-drawer fixed right-4 top-24 z-50 flex h-[calc(100vh-112px)] w-[min(360px,calc(100vw-32px))] flex-col rounded-xl border border-line bg-panel p-4 shadow-2xl">
    <div className="mb-4 flex items-center justify-between"><div><p className="eyebrow">Workspace library</p><h2 className="text-lg font-semibold text-main">Add visualization</h2></div><button className="tile-action" onClick={onClose} type="button"><X size={16} /></button></div>
    <div className="relative mb-4"><Search size={14} className="absolute left-3 top-2.5 text-muted" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tiles..." className="h-9 w-full rounded-lg border border-line bg-surface pl-9 pr-3 text-xs text-main outline-none focus:border-primary" /></div>
    <div className="min-h-0 flex-1 space-y-4 overflow-auto">{Object.entries(groups).map(([group, tiles]) => <div key={group}><p className="eyebrow mb-2">{group}</p><div className="space-y-2">{tiles.map((tile) => <button key={tile.type} type="button" onClick={() => onAdd(tile.type)} className="gallery-item flex w-full items-center gap-3 rounded-lg border border-line bg-surface p-3 text-left transition hover:border-primary hover:bg-primary/5"><span className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 font-mono text-sm text-primary">{tile.icon}</span><span className="min-w-0 flex-1"><span className="block text-xs font-semibold text-main">{tile.title}</span><span className="mt-0.5 block text-[10px] leading-snug text-muted">{tile.description}</span></span><span className="text-lg text-muted">+</span></button>)}</div></div>)}</div>
  </aside>
}
