// oklch → sRGB bridge (src/features/themes/colors.ts). zrender cannot parse
// `oklch()`, so chart colours must be converted or they silently render black.

import { describe, expect, it } from 'vitest'
import { oklchToRgb, toChartTokens } from '../colors'
import { themeTokens } from '../ThemeProvider'

describe('oklchToRgb', () => {
  it('converts the neutral ramp to sRGB', () => {
    expect(oklchToRgb('oklch(1 0 0)')).toBe('rgb(255, 255, 255)')
    expect(oklchToRgb('oklch(0 0 0)')).toBe('rgb(0, 0, 0)')
    expect(oklchToRgb('oklch(0.145 0 0)')).toBe('rgb(10, 10, 10)')
  })

  it('converts hue+chroma to plausible channels', () => {
    // success green: green channel must dominate.
    const green = oklchToRgb('oklch(0.62 0.14 150)')
    const [, g] = green.match(/\d+/g)!.map(Number)
    expect(g).toBeGreaterThan(120)
    // danger red: red channel must dominate.
    const red = oklchToRgb('oklch(0.577 0.245 27.325)')
    const [r] = red.match(/\d+/g)!.map(Number)
    expect(r).toBeGreaterThan(180)
  })

  it('preserves alpha', () => {
    expect(oklchToRgb('oklch(1 0 0 / 12%)')).toBe('rgba(255, 255, 255, 0.12)')
    expect(oklchToRgb('oklch(1 0 0 / 0.5)')).toBe('rgba(255, 255, 255, 0.5)')
    expect(oklchToRgb('oklch(1 0 0 / 1)')).toBe('rgb(255, 255, 255)')
  })

  it('passes non-oklch input through unchanged', () => {
    expect(oklchToRgb('#3b82f6')).toBe('#3b82f6')
    expect(oklchToRgb('transparent')).toBe('transparent')
  })
})

describe('toChartTokens', () => {
  it('converts every theme token to a zrender-parseable colour', () => {
    for (const mode of ['light', 'dark'] as const) {
      const converted = toChartTokens(themeTokens[mode])
      for (const [key, value] of Object.entries(converted)) {
        expect(value, `${mode}.${key}`).toMatch(/^rgba?\(/)
        expect(value, `${mode}.${key}`).not.toContain('oklch')
      }
    }
  })

  it('keeps the themes distinguishable', () => {
    expect(toChartTokens(themeTokens.light).text).not.toBe(toChartTokens(themeTokens.dark).text)
  })
})
