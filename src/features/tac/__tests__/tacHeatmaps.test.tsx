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

  it('offers a 3D view toggle without crashing', () => {
    render(<TacVolSurface />)
    const toggle = screen.getByText('3D')
    fireEvent.click(toggle)
    // The lazy echarts-gl import may not resolve under jsdom; the tile must
    // degrade gracefully (loading / unavailable message) and keep rendering.
    expect(screen.getByText('2D')).toBeTruthy()
    expect(screen.getByText('3D')).toBeTruthy()
  })
})
