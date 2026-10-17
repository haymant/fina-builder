import { create } from 'zustand'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedThemeMode = 'light' | 'dark'

interface PreferencesState {
  /** User preference (may be `system`). */
  themeMode: ThemeMode
  /** Concrete mode after resolving `system` against the OS. */
  resolvedThemeMode: ResolvedThemeMode
  setThemeMode: (mode: ThemeMode) => void
}

function resolve(mode: ThemeMode): ResolvedThemeMode {
  if (mode !== 'system') return mode
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * Minimal preferences store backing the vendored `ui/sonner`. The broader
 * preferences surface is out of scope for the instrument-store revamp.
 */
export const usePreferencesStore = create<PreferencesState>((set) => ({
  themeMode: 'system',
  resolvedThemeMode: resolve('system'),
  setThemeMode: (mode) => set({ themeMode: mode, resolvedThemeMode: resolve(mode) }),
}))
