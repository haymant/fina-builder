import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { useExplorerStore } from '../../store/explorerStore'
import { toChartTokens } from './colors'

export const themeTokens = {
  // Aligned to finap's neutral shadcn palette (oklch), so both the app chrome
  // and the vendored component kit read the same in light and dark.
  light: {
    background: 'oklch(1 0 0)',
    panel: 'oklch(1 0 0)',
    border: 'oklch(0.922 0 0)',
    text: 'oklch(0.145 0 0)',
    muted: 'oklch(0.556 0 0)',
    primary: 'oklch(0.205 0 0)',
    success: 'oklch(0.62 0.14 150)',
    danger: 'oklch(0.577 0.245 27.325)',
    warning: 'oklch(0.7 0.16 65)',
    grid: 'oklch(0.97 0 0)',
    chartMuted: 'oklch(0.708 0 0)',
  },
  dark: {
    background: 'oklch(0.145 0 0)',
    panel: 'oklch(0.205 0 0)',
    border: 'oklch(1 0 0 / 12%)',
    text: 'oklch(0.985 0 0)',
    muted: 'oklch(0.708 0 0)',
    primary: 'oklch(0.922 0 0)',
    success: 'oklch(0.696 0.17 162)',
    danger: 'oklch(0.704 0.191 22.216)',
    warning: 'oklch(0.769 0.188 70)',
    grid: 'oklch(0.269 0 0)',
    chartMuted: 'oklch(0.556 0 0)',
  },
} as const

type ThemeTokens = (typeof themeTokens)[keyof typeof themeTokens]

// Charts get sRGB tokens: zrender (ECharts' canvas engine) cannot parse `oklch()`
// and silently falls back to black, which is why chart axes/heatmaps ignored the
// theme. CSS variables keep the authored oklch values.
const chartTokens = { light: toChartTokens(themeTokens.light), dark: toChartTokens(themeTokens.dark) }

const ThemeContext = createContext<{ tokens: ThemeTokens; mode: 'dark' | 'light' }>({ tokens: chartTokens.dark, mode: 'dark' })

export function ThemeProvider({ children }: { children: ReactNode }) {
  const mode = useExplorerStore((s) => s.theme)
  const tokens = chartTokens[mode]
  useEffect(() => { const root = document.documentElement; root.dataset.theme = mode; root.classList.toggle('light', mode === 'light'); root.classList.toggle('dark', mode === 'dark'); for (const [key, value] of Object.entries(themeTokens[mode])) root.style.setProperty(`--theme-${key}`, value) }, [mode])
  return <ThemeContext.Provider value={{ tokens, mode }}>{children}</ThemeContext.Provider>
}
export function useTheme() { return useContext(ThemeContext) }
