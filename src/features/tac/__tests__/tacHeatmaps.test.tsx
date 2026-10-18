// Heatmap theming regression (the bug this fixes): the theme tokens are `oklch()`
// and zrender cannot parse them, so every chart colour silently fell back to
// black. `useTheme().tokens` is now sRGB, so the heatmaps (and their axes/labels)
// follow the theme. Chart is mocked to capture the ECharts option.

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { captured } = vi.hoisted(() => ({ captured: [] as Array<Record<string, unknown>> }))

vi.mock('../../shared/components/Chart', () => ({
  default: (props: { option: Record<string, unknown> }) => {
    captured.push(props.option)
    return null
  },
}))

const { TacCorrelationMatrix, TacVolSurface } = await import('../components/TacTiles')
const { rampColor } = await import('../components/VolSurface3D')
const { installTacTranscript, preloadTacMarket, resetTranscripts } = await import(
  '../../../tests/mocks/transcripts'
)

beforeEach(() => {
  captured.length = 0
  preloadTacMarket()
  installTacTranscript()
})
afterEach(() => resetTranscripts())

const lastOption = () => captured.at(-1) as {
  series: Array<{ type: string }>
  visualMap: { inRange: { color: string[] } }
  xAxis?: { axisLabel?: { color?: string } }
}

describe('tac heatmap theming', () => {
  it('interpolates the colour ramp', () => {
    const ramp = ['rgb(0, 0, 0)', 'rgb(100, 100, 100)', 'rgb(200, 200, 200)']
    expect(rampColor(ramp, 0)).toBe('rgb(0, 0, 0)')
    expect(rampColor(ramp, 1)).toBe('rgb(200, 200, 200)')
    expect(rampColor(ramp, 0.25)).toBe('rgb(50, 50, 50)')
    expect(rampColor(ramp, 0.5)).toBe('rgb(100, 100, 100)')
    expect(rampColor(ramp, -1)).toBe('rgb(0, 0, 0)')
    expect(rampColor(ramp, 2)).toBe('rgb(200, 200, 200)')
  })
  it('sources the correlation heatmap colours from the theme (sRGB, not oklch)', () => {
    render(<TacCorrelationMatrix />)
    const option = lastOption()
    expect(option.series[0]!.type).toBe('heatmap')
    expect(option.visualMap.inRange.color).toHaveLength(3)
    for (const color of option.visualMap.inRange.color) {
      expect(color, color).toMatch(/^rgba?\(/)
      expect(color).not.toContain('oklch')
    }
    expect(option.xAxis?.axisLabel?.color).toMatch(/^rgba?\(/)
  })

  it('defaults the vol surface to a 2D heatmap with theme colours', () => {
    render(<TacVolSurface />)
    const option = lastOption()
    expect(option.series[0]!.type).toBe('heatmap')
    for (const color of option.visualMap.inRange.color) {
      expect(color).toMatch(/^rgba?\(/)
    }
  })

  it('renders the 3D surface as a bounded SVG mesh', () => {
    render(<TacVolSurface />)
    fireEvent.click(screen.getByText('3D'))
    const svg = screen.getByTestId('vol-surface-3d')
    const paths = [...svg.querySelectorAll('path')]
    expect(paths.length).toBeGreaterThan(4)
    for (const path of paths) {
      expect(path.getAttribute('fill')).toMatch(/^rgba?\(/)
      const coords = (path.getAttribute('d') ?? '').match(/-?\d+\.?\d*/g)?.map(Number) ?? []
      // 4 corners × (x, y).
      expect(coords.length).toBeGreaterThanOrEqual(8)
      for (const value of coords) {
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(-1)
        expect(value).toBeLessThanOrEqual(361) // viewBox is 360×240
      }
    }
  })
})
