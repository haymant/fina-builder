# Browser E2E tests

The end-to-end suite lives in `playwright/*.spec.ts` and uses `@playwright/test`. The configuration starts a dedicated Vite server at `http://127.0.0.1:4173`; it does not require the Rust engines, Alpaca credentials, or the public preview.

## Install and run

```bash
npm ci
npx playwright install chromium
npm run test:e2e
```

For video recording, also install Playwright's FFmpeg helper with `npx playwright install ffmpeg`; installing Chromium alone is not sufficient. On Linux, if the browser reports missing system libraries, install Playwright's Chromium dependencies with `npx playwright install --with-deps chromium`. To use an already-installed Chromium executable instead of Playwright's downloaded browser:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:e2e
```

The suite runs in Chromium at a 1280×720 desktop viewport. It seeds a small, isolated workspace in each browser context and aborts `/riga/mcp` and `/tac/mcp` requests, so the tests cover front-end user flows rather than live engine or market-data behavior.

Useful commands:

```bash
npm run test:e2e -- --grep "creates a blank dashboard"
npm run test:e2e -- --headed
npm run test:e2e:ui
```

The suite covers workspace rendering, blank dashboard creation and persistence, template filtering/creation, tile insertion, notebook note editing, theme persistence, and a paced dashboard-and-note demo flow for narration recording.

## Record a test run

Playwright can record the browser context while the automation runs:

```bash
PLAYWRIGHT_VIDEO=on npm run test:e2e -- --grep "narrated demo: create a dashboard note"
```

The dedicated narrated-demo test includes brief holds at each UI state so narration can be aligned without slowing down the regular E2E cases. It produces a `.webm` recording under `playwright/test-results/`. By default, video is retained only for failures; `PLAYWRIGHT_VIDEO=on` records successful tests too. Screenshots and traces are retained for failures by default. These generated artifacts are ignored by Git. Use `--headed` only where a display is available; video capture also works in headless mode.

To make a narrated demo, read [`skills/demo/SKILL.md`](./skills/demo/SKILL.md). It explains recording a clean test flow, aligning narration against the actual recording duration, checking the final mix, and confirming upload details before any YouTube upload. Built-in speech generation does not clone or imitate a person's voice. An optional sample can inform non-identity details such as language, pronunciation, or pacing, but not vocal identity.
