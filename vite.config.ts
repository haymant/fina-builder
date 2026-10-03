import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Vitest-only alias. This MUST NOT apply to `vite build` / `tauri build`:
// rewriting `@tauri-apps/api/core` unconditionally bundles the throwing test
// mock into the desktop app, which then fails every command with
// "unmocked tauri command: register a mock in the test".
const testAlias: Record<string, string> = process.env.VITEST
  ? {
      '@tauri-apps/api/core': new URL(
        './src/tests/mocks/tauriMock.ts',
        import.meta.url,
      ).pathname,
    }
  : {}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: testAlias,
  },
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts: ['5173-isfrrzvtdzt80v0qqywhj-41cb09c2.sg2.manus.computer'],
    watch: {
      ignored: ['**/dist/**', '**/target/**']
    }
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'esnext',
    sourcemap: !!process.env.TAURI_DEBUG,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/tests/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      exclude: ['src/tests/**', '**/*.tsx', 'src/api/tauriTransport.ts'],
    },
  },
})
