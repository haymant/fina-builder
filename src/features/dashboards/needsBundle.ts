// Which dashboards need the demo-kernel simulation bundle.
//
// Engine dashboards (all Riga*/Tac* tiles) load their own data from the MCP
// servers and must not block on the demo `generate_paths` call. Any dashboard
// containing a demo-kernel tile still waits for the bundle.

import { TILE_CATALOG } from './catalog'
import type { TileLayout } from './types'

export function isEngineTile(type: string): boolean {
  return type.startsWith('Riga') || type.startsWith('Tac')
}

export function dashboardNeedsDemoBundle(layout: TileLayout[]): boolean {
  return layout.some((item) => {
    const meta = TILE_CATALOG.find((candidate) => item.i === candidate.id || item.i.startsWith(`${candidate.id}-`))
    return meta ? !isEngineTile(meta.type) : true
  })
}
