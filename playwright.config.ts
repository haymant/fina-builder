import { defineConfig, devices } from '@playwright/test'

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE

export default defineConfig({
  testDir: './playwright',
  testMatch: '**/*.spec.ts',
  outputDir: 'playwright/test-results',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
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
      command: 'npm run dev -- --host 127.0.0.1 --port 4173 --strictPort',
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
        DATABASE_URL: 'sqlite:playwright/.data/trade-repo.sqlite',
        TRADE_REPO_HTTP_PORT: '8792',
      },
    },
  ],
})
