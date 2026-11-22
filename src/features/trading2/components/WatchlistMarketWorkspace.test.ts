import { describe, expect, it } from 'vitest'
import type { Trading2Bar } from '../../../api/trading2Api'
import { buildCandleChartOption } from './WatchlistMarketWorkspace'

describe('watchlist symbol-detail candlesticks', () => {
  it('keeps high/low wicks visible with a contrasting outline', () => {
    const bars: Trading2Bar[] = [{
      timestamp: '2026-11-22T00:00:00Z',
      open: 10,
      high: 12,
      low: 8,
      close: 11,
      volume: 100,
    }]

    const option = buildCandleChartOption(bars, [], [], [])
    const candle = (option.series as Array<Record<string, unknown>>)[0]!
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
  })
})
