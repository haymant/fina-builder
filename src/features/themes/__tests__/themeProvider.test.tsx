// Styling alignment (docs/46 / finap parity): the vendored shadcn kit is themed
// by deriving its token names from the app's `--theme-*` variables, and
// ThemeProvider drives those variables + the light/dark class for both themes.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ThemeProvider, themeTokens } from '../ThemeProvider'
import { useExplorerStore } from '../../../store/explorerStore'

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')

describe('theme token bridge (finap-aligned)', () => {
  it('derives the shadcn tokens from --theme-*', () => {
    expect(css).toContain('@custom-variant dark')
    for (const mapping of [
      '--color-background: var(--background)',
      '--color-foreground: var(--foreground)',
      '--color-card: var(--card)',
      '--color-border: var(--border)',
      '--color-muted-foreground: var(--muted-foreground)',
      '--color-primary: var(--primary)',
      '--color-ring: var(--ring)',
    ]) {
      expect(css).toContain(mapping)
    }
    for (const alias of [
      '--background: var(--theme-background)',
      '--foreground: var(--theme-text)',
      '--card: var(--theme-panel)',
      '--border: var(--theme-border)',
      '--muted-foreground: var(--theme-muted)',
      '--primary: var(--theme-primary)',
    ]) {
      expect(css).toContain(alias)
    }
  })

  it('applies dark tokens and class on mount', () => {
    useExplorerStore.setState({ theme: 'dark' })
    render(
      <ThemeProvider>
        <div data-testid="child" />
      </ThemeProvider>,
    )
    const root = document.documentElement
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.classList.contains('light')).toBe(false)
    expect(root.dataset.theme).toBe('dark')
    expect(root.style.getPropertyValue('--theme-background')).toBe(themeTokens.dark.background)
  })

  it('switches tokens and class for light mode', () => {
    useExplorerStore.setState({ theme: 'light' })
    render(
      <ThemeProvider>
        <div data-testid="child" />
      </ThemeProvider>,
    )
    const root = document.documentElement
    expect(root.classList.contains('light')).toBe(true)
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.style.getPropertyValue('--theme-background')).toBe(themeTokens.light.background)
    expect(root.style.getPropertyValue('--theme-text')).toBe(themeTokens.light.text)
    // The two themes must actually differ for the bridge to be meaningful.
    expect(themeTokens.light.background).not.toBe(themeTokens.dark.background)
    expect(themeTokens.light.text).not.toBe(themeTokens.dark.text)
  })
})
