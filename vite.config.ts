import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Resolve the vendored RIGA assistant package straight from its TypeScript
// sources (mirrors `modules/riga/demo/vite.config.ts`), so fina-builder does not
// need a published `@rigai/assistant-ui` install. The same paths are mapped in
// `tsconfig.app.json` for type-checking.
const rigaPkg = new URL('./modules/riga/packages/assistant-ui/src', import.meta.url).pathname

// The vendored shadcn-style component kit (`src/components/{ui,data-grid,deep-form}`)
// imports through the `@/…` root alias. Map it to `./src` here and in
// `tsconfig.app.json` `paths`. The `'@/'` prefix never collides with the
// `@rigai/*` or `@tauri-apps/*` package aliases below.
const rootSrc = new URL('./src', import.meta.url).pathname

// Vitest-only alias for the Tauri IPC mock. This MUST NOT apply to
// `vite build` / `tauri build`: rewriting `@tauri-apps/api/core` unconditionally
// bundles the throwing test mock into the desktop app, which then fails every
// command with "unmocked tauri command: register a mock in the test".

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      // Root source alias for the vendored component kit (`@/…`).
      { find: '@/', replacement: `${rootSrc}/` },
      // RIGA assistant surface (chat panel) — vendored package sources.
      { find: '@rigai/assistant-ui/styles.css', replacement: `${rigaPkg}/styles.css` },
      { find: '@rigai/assistant-ui/tauri', replacement: `${rigaPkg}/tauri/index.ts` },
      { find: '@rigai/assistant-ui/protocol', replacement: `${rigaPkg}/protocol/index.ts` },
      { find: '@rigai/assistant-ui/http', replacement: `${rigaPkg}/http/index.ts` },
      { find: '@rigai/assistant-ui', replacement: `${rigaPkg}/index.ts` },
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
    // Same-origin proxies. The webview cannot call the local engines directly:
    // riga-mcp sends no CORS / private-network headers, so the browser blocks the
    // request (leaving it pending). Proxying keeps every request same-origin.
    //   /riga/mcp -> http://127.0.0.1:8788/mcp   (riga-mcp --transport http)
    //   /tac/mcp  -> http://127.0.0.1:8790/mcp   (npm run mcp:http:tac)
    // riga-server (the RIGA agent) has its own endpoints on 8787 for browser mode.
    proxy: {
      '/riga': { target: process.env.VITE_RIGA_UPSTREAM ?? 'http://127.0.0.1:8788', changeOrigin: true, rewrite: (path) => path.replace(/^\/riga/, '') },
      '/tac': { target: process.env.VITE_TAC_UPSTREAM ?? 'http://127.0.0.1:8790', changeOrigin: true, rewrite: (path) => path.replace(/^\/tac/, '') },
      '/ws': { target: 'ws://127.0.0.1:8787', ws: true },
      '/health': { target: 'http://127.0.0.1:8787' },
      '/provider': { target: 'http://127.0.0.1:8787' },
      '/catalog': { target: 'http://127.0.0.1:8787' },
      '/sessions': { target: 'http://127.0.0.1:8787' },
      '/attachments': { target: 'http://127.0.0.1:8787' },
      '/workspace': { target: 'http://127.0.0.1:8787' },
      '/git': { target: 'http://127.0.0.1:8787' },
      '/local-models': { target: 'http://127.0.0.1:8787' },
    },
    watch: {
      // `.riga` is the agent's per-session worktree — writing a file there must
      // not trigger a Vite HMR reload. The MCP registry file is written at
      // startup and refreshed by the agent host, so it is ignored too.
      ignored: ['**/dist/**', '**/target/**', '**/.riga/**', '**/.riga-mcp-registry.json']
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
