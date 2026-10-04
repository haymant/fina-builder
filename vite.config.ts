import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Vitest-only alias for the Tauri IPC mock. This MUST NOT apply to
// `vite build` / `tauri build`: rewriting `@tauri-apps/api/core` unconditionally
// bundles the throwing test mock into the desktop app, which then fails every
// command with "unmocked tauri command: register a mock in the test".

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: [
      // The pi-mcp package root re-exports its stdio transport, which reads
      // `process.platform` at module init and imports `node:child_process`.
      // Both crash in the Tauri webview (blank chat panel). The shim re-exports
      // only the browser-safe client/content/jsonrpc pieces. Match only the
      // bare specifier so the shim's own `/dist/*` deep imports are untouched.
      {
        find: /^@earendil-works\/pi-mcp$/,
        replacement: new URL(
          './src/features/local-agent/piMcpShim.ts',
          import.meta.url,
        ).pathname,
      },
      // pi-mcp's `exports` map blocks deep imports, so map the browser-safe
      // modules the shim needs to their real files.
      {
        find: /^@earendil-works\/pi-mcp\/dist\/(.*)$/,
        replacement: new URL(
          './node_modules/@earendil-works/pi-mcp/dist/$1',
          import.meta.url,
        ).pathname,
      },
      ...(process.env.VITEST
        ? [
            {
              find: '@tauri-apps/api/core',
              replacement: new URL(
                './src/tests/mocks/tauriMock.ts',
                import.meta.url,
              ).pathname,
            },
          ]
        : []),
    ],
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
