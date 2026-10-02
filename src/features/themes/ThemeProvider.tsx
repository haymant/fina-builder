import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { useExplorerStore } from '../../store/explorerStore'

export const themeTokens = {
  light: { background: '#f8fafc', panel: '#ffffff', border: '#e2e8f0', text: '#0f172a', muted: '#64748b', primary: '#2563eb', success: '#16a34a', danger: '#dc2626', warning: '#d97706', grid: '#e2e8f0', chartMuted: '#94a3b8' },
  dark: { background: '#0f172a', panel: '#111827', border: '#374151', text: '#f8fafc', muted: '#94a3b8', primary: '#3b82f6', success: '#22c55e', danger: '#ef4444', warning: '#f59e0b', grid: '#1e293b', chartMuted: '#64748b' },
} as const

type ThemeTokens = (typeof themeTokens)[keyof typeof themeTokens]
const ThemeContext = createContext<{ tokens: ThemeTokens; mode: 'dark' | 'light' }>({ tokens: themeTokens.dark, mode: 'dark' })

export function ThemeProvider({ children }: { children: ReactNode }) {
  const mode = useExplorerStore((s) => s.theme)
  const tokens = themeTokens[mode]
  useEffect(() => { const root = document.documentElement; root.dataset.theme = mode; root.classList.toggle('light', mode === 'light'); root.classList.toggle('dark', mode === 'dark'); for (const [key, value] of Object.entries(tokens)) root.style.setProperty(`--theme-${key}`, value) }, [mode, tokens])
  return <ThemeContext.Provider value={{ tokens, mode }}>{children}</ThemeContext.Provider>
}
export function useTheme() { return useContext(ThemeContext) }
