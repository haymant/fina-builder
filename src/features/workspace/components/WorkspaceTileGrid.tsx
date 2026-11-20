import { useMemo, type ReactNode } from 'react'
import { Responsive, WidthProvider, type Layout, type ResponsiveLayouts } from 'react-grid-layout/legacy'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'

const Grid = WidthProvider(Responsive)

type WorkspaceTileGridProps = {
  workspaceId: string
  tileIds: string[]
  children: ReactNode
  className?: string
  defaultHeights?: number[]
}

function storageKey(workspaceId: string) {
  return `fina.workspace-layout.${workspaceId}`
}

function readLayout(workspaceId: string, tileIds: string[], defaultHeights: number[]): Layout {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(workspaceId)) ?? 'null')
    if (Array.isArray(parsed) && parsed.length === tileIds.length && parsed.every((item) => item && typeof item.i === 'string' && tileIds.includes(item.i))) {
      return parsed.map((item) => ({ i: item.i, x: Number(item.x) || 0, y: Number(item.y) || 0, w: Math.max(3, Math.min(12, Number(item.w) || 6)), h: Math.max(3, Number(item.h) || 4), minW: 3, minH: 3 }))
    }
  } catch { /* local layout is optional */ }
  return tileIds.map((id, index) => ({ i: id, x: (index % 2) * 6, y: Math.floor(index / 2) * (defaultHeights[index] ?? 4), w: tileIds.length === 1 ? 12 : 6, h: defaultHeights[index] ?? 4, minW: 3, minH: 3 }))
}

export function WorkspaceTileGrid({ workspaceId, tileIds, children, className = '', defaultHeights = [] }: WorkspaceTileGridProps) {
  const initial = useMemo(() => readLayout(workspaceId, tileIds, defaultHeights), [workspaceId, tileIds.join('|'), defaultHeights.join('|')])
  const layouts = useMemo<ResponsiveLayouts>(() => ({
    lg: initial,
    md: initial.map((item, index) => ({ ...item, x: (index % 2) * 5, y: Math.floor(index / 2) * item.h, w: Math.min(item.w, 5) })),
    sm: initial.map((item, index) => ({ ...item, x: (index % 2) * 3, y: Math.floor(index / 2) * item.h, w: Math.min(item.w, 3) })),
    xs: initial.map((item, index) => ({ ...item, x: 0, y: index * item.h, w: 1 })),
  }), [initial])
  const onLayoutChange = (next: Layout) => {
    const normalized = next.map(({ i, x, y, w, h }) => ({ i, x, y, w, h, minW: 3, minH: 3 }))
    try { localStorage.setItem(storageKey(workspaceId), JSON.stringify(normalized)) } catch { /* optional */ }
  }
  return <Grid className={`workspace-tile-grid ${className}`} layouts={layouts} breakpoints={{ lg: 1200, md: 996, sm: 640, xs: 0 }} cols={{ lg: 12, md: 10, sm: 6, xs: 1 }} rowHeight={64} margin={[16, 16]} containerPadding={[0, 0]} compactType="vertical" preventCollision={false} draggableHandle=".tile-header" resizeHandles={['s', 'e', 'se']} onLayoutChange={onLayoutChange}>{Array.from({ length: Math.max(tileIds.length, 0) }, (_, index) => <div key={tileIds[index]} className="workspace-tile-item">{Array.isArray(children) ? children[index] : index === 0 ? children : null}</div>)}</Grid>
}
