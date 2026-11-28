import { defineConfig, devices } from '@playwright/test'

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
const nipEnabled = process.env.PLAYWRIGHT_NIP === 'on'
const runLabel = (process.env.NIP_E2E_RUN_ID ?? process.env.PLAYWRIGHT_RUN_ID ?? 'adhoc').replace(/[^a-zA-Z0-9._-]/gu, '-').slice(0, 60)
const tradeRepoRunId = `${runLabel}-${process.pid}-${Date.now()}`

export default defineConfig({
  testDir: './playwright',
  testMatch: '**/*.spec.ts',
  outputDir: 'playwright/test-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // NIP service-backed journeys share one disposable DuckDB ledger. Keep them
  // serial so an opt-in `PLAYWRIGHT_NIP=on` run cannot race on feed/consent state.
  workers: nipEnabled ? 1 : process.env.CI ? 2 : undefined,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: {
      mode: process.env.PLAYWRIGHT_VIDEO === 'on' ? 'on' : 'retain-on-failure',
      size: { width: 1280, height: 720 },
    },
    ...(executablePath
      ? { launchOptions: { executablePath, args: ['--no-sandbox'] } }
      : {}),
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'npm run dev:web -- --host 127.0.0.1 --port 4173 --strictPort',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // The trade repository is a local Node MCP server, not a Rust engine. It is
      // deterministic and seeded, so the UI suite can rely on it without credentials.
      command: 'node scripts/trade-repo-mcp-http.mjs --reset --seed',
      url: 'http://127.0.0.1:8792/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        DATABASE_URL: `sqlite:playwright/.data/trade-repo-e2e/${tradeRepoRunId}.sqlite`,
        TRADE_REPO_HTTP_PORT: '8792',
      },
    },
    ...(nipEnabled
      ? [
          {
            command: 'node scripts/nip-fixture-server.mjs',
            url: 'http://127.0.0.1:8795/health',
            reuseExistingServer: false,
            timeout: 60_000,
          },
          {
            // Deterministic stand-in for the desktop host's loopback RIGA
            // provider bridge. It keeps the browser journey on the real NIP
            // consent/extraction path without contacting a public provider.
            command: 'node scripts/nip-provider-bridge-fixture.mjs',
            url: 'http://127.0.0.1:8796/health',
            reuseExistingServer: false,
            timeout: 60_000,
            env: {
              NIP_BRIDGE_FIXTURE_TOKEN: process.env.NIP_BRIDGE_FIXTURE_TOKEN ?? 'nip-e2e-bridge-token',
            },
          },
          {
            command: 'node scripts/start-nip-e2e.mjs',
            url: 'http://127.0.0.1:8794/health',
            reuseExistingServer: false,
            timeout: Number(process.env.PLAYWRIGHT_NIP_STARTUP_TIMEOUT ?? 600_000),
          },
        ]
      : []),
  ],
})
