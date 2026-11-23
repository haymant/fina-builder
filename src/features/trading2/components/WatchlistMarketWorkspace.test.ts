import { describe, expect, it } from 'vitest'
import * as echarts from 'echarts'
import { render, within } from '@testing-library/react'
import { createElement } from 'react'
import type { Trading2Bar } from '../../../api/trading2Api'
import { buildCandleChartOption, IntradayPriceBar } from './WatchlistMarketWorkspace'

describe('watchlist symbol-detail candlesticks', () => {
  it('draws high/low wicks independently from the candle body outline', () => {
    const bars: Trading2Bar[] = [{
      timestamp: '2026-11-22T00:00:00Z',
      open: 10,
      high: 12,
      low: 8,
      close: 11,
      volume: 100,
    }]

    const option = buildCandleChartOption(bars, [], [], [])
    const chartSeries = option.series as Array<Record<string, unknown>>
    const candle = chartSeries[0]!
    const wicks = chartSeries.find((series) => series.name === 'Candlestick wicks')!
    const style = candle.itemStyle as Record<string, unknown>

    expect(candle.type).toBe('candlestick')
    expect(candle.data).toEqual([[10, 11, 8, 12]])
    expect(style).toMatchObject({
      color: '#16a34a',
      color0: '#dc2626',
      borderColor: '#166534',
      borderColor0: '#991b1b',
      borderWidth: 1.5,
    })
    expect(style.borderColor).not.toBe(style.color)
    expect(style.borderColor0).not.toBe(style.color0)

    expect(wicks.type).toBe('custom')
    expect(wicks.z).toBeGreaterThan(0)
    expect(wicks.data).toEqual([['2026-11-22T00:00', 8, 10, 11, 12]])
    const renderItem = wicks.renderItem as (_params: unknown, api: { value: (dimension: number) => unknown; coord: (point: [string | number, number]) => [number, number] }) => { children: Array<{ shape: Record<string, number>; style: Record<string, unknown> }> }
    const rendered = renderItem({}, {
      value: (dimension) => ['2026-11-22T00:00', 8, 10, 11, 12][dimension],
      coord: ([, value]) => [42, 100 - value * 10],
    })
    expect(rendered.children).toHaveLength(4)
    expect(rendered.children.map((child) => child.style.lineWidth)).toEqual([4, 2.5, 4, 2.5])
    expect(rendered.children.map((child) => child.style.stroke)).toEqual(['#f8fafc', '#111827', '#f8fafc', '#111827'])
    expect(rendered.children[0]?.shape).toEqual({ x1: 42, y1: -20, x2: 42, y2: -10 })
    expect(rendered.children[2]?.shape).toEqual({ x1: 42, y1: 0, x2: 42, y2: 20 })

    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 600, height: 400 })
    chart.setOption(option as unknown as echarts.EChartsOption)
    const svg = chart.renderToSVGString()
    chart.dispose()
    expect(svg).toContain('#111827')
    expect(svg).toContain('#f8fafc')
  })

  it('shows distinct low and high endpoint markers on the horizontal watchlist bar', () => {
    const { getByLabelText } = render(createElement(IntradayPriceBar, { bar: {
      timestamp: '2026-11-22T00:00:00Z',
      open: 10,
      high: 12,
      low: 8,
      close: 11,
      volume: 100,
    } }))
    const range = getByLabelText('Low $8.00, open $10.00, last $11.00, high $12.00')
    const low = within(range).getByTestId('intraday-low-wick')
    const high = within(range).getByTestId('intraday-high-wick')

    expect(low.style.left).toBe('0%')
    expect(high.style.left).toBe('100%')
    expect(low.className).toContain('h-3')
    expect(high.className).toContain('h-3')
    expect(low.className).toContain('border-main')
    expect(high.className).toContain('border-main')
  })
})
