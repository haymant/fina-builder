import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: {
      // §6.2: tests never talk to a real Tauri runtime; both the test files and
      // tauriTransport resolve this same module.
      '@tauri-apps/api/core': new URL('./src/tests/mocks/tauriMock.ts', import.meta.url).pathname,
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts: ['5173-i1f3w3wk4vqmpb4gf4qf4-f4a0e4c8.sg2.manus.computer'],
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
