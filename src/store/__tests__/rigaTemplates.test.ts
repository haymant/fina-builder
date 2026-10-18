// New dashboard templates + built-in dashboards exist and reference real tiles
// (§8.1/§8.3). Guards against an id typo silently dropping a tile.

import { describe, expect, it } from 'vitest'
import { TILE_CATALOG } from '../../features/dashboards/catalog'
import { useDashboardDocsStore } from '../dashboardDocsStore'
import { useExplorerStore } from '../explorerStore'

const catalogTypes = new Set<string>(TILE_CATALOG.map((tile) => tile.type))
const catalogIds = new Set<string>(TILE_CATALOG.map((tile) => tile.id))

describe('riga-flow templates', () => {
  const templates = useDashboardDocsStore.getState().templates

  it('every template references only real catalog tile types', () => {
    for (const template of templates) {
      for (const type of template.tileTypes) {
        expect(catalogTypes.has(type), `${template.id} → ${type}`).toBe(true)
      }
    }
  })

  it('registers the riga-lineage template with notebook docs', () => {
    const template = templates.find((t) => t.id === 'riga-lineage')!
    expect(template).toBeDefined()
    expect(template.usageMarkdown).toContain('# riga-flow Lineage & Explainability Workspace')
    expect(template.usageMarkdown).toContain('## Connect')
    expect(template.usageMarkdown).toMatch(/\| Layer \| Tool \|/)
    expect(template.tileTypes.every((type) => catalogTypes.has(type))).toBe(true)
  })

  it('registers the tac-market-data template with env + skills docs', () => {
    const template = templates.find((t) => t.id === 'tac-market-data')!
    expect(template).toBeDefined()
    expect(template.usageMarkdown).toContain('TAC_LAKE_DIR')
    expect(template.usageMarkdown).toContain('APCA_API_KEY_ID')
    expect(template.usageMarkdown).toContain('corr_matrix')
    expect(template.tileTypes.every((type) => catalogTypes.has(type))).toBe(true)
  })
})

describe('built-in dashboards', () => {
  const dashboards = useExplorerStore.getState().dashboards

  it('every built-in dashboard has valid catalog tile ids', () => {
    for (const dashboard of dashboards) {
      expect(dashboard.layout.length).toBeGreaterThan(0)
      for (const item of dashboard.layout) {
        expect(catalogIds.has(item.i), `${dashboard.id} → ${item.i}`).toBe(true)
      }
    }
  })

  for (const id of ['riga-lineage', 'tac-market-data']) {
    it(`registers the '${id}' built-in dashboard with valid tile ids`, () => {
      const dashboard = dashboards.find((d) => d.id === id)
      expect(dashboard).toBeDefined()
      expect(dashboard!.layout.length).toBeGreaterThan(0)
      for (const item of dashboard!.layout) {
        expect(catalogIds.has(item.i), `${id} → ${item.i}`).toBe(true)
      }
    })
  }
})

describe('catalog lane', () => {
  it('contains no demo-group tile', () => {
    for (const tile of TILE_CATALOG) {
      expect(['riga-flow', 'tac-engine'], `${tile.id} → ${tile.group}`).toContain(tile.group)
    }
  })
})
