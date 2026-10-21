# Browser E2E tests

The browser suite uses `@playwright/test` and starts an isolated Vite server at `http://127.0.0.1:4173`. It does not require Rust engines, Alpaca credentials, or the public preview. Browser contexts are isolated per test; the shared fixture seeds local workspace state and stubs `/riga/mcp` and `/tac/mcp` for UI-focused tests by default.

## Architecture for growth

Keep specs focused on user intent and outcomes; put reusable behavior and selectors in the supporting layers:

```text
playwright/
├── assertions/          # domain-level expectations, separate from selectors
├── components/          # reusable UI regions (template dialog, notebook)
├── fixtures/            # isolated state, route policy, page-object fixtures
├── pages/               # page-level locators and user actions
├── support/             # canonical tags and fresh test-data factories
├── workspace.spec.ts    # short independent tests
└── demo.spec.ts         # paced, tagged recording journey
```

Prefer accessible role, label, and placeholder locators. Keep unavoidable CSS selectors scoped in page/component objects; tests should not repeat selector details. Keep domain assertions in `assertions/`, test-data setup in fixtures or typed data factories, and specs readable as arrange/act/assert user stories. Avoid giant page objects, global mutable state, arbitrary sleeps in normal tests, and abstraction that only wraps one Playwright call. The demo spec is the exception for deliberate `waitForTimeout` holds; those create readable capture time for narration and are not needed by ordinary tests.

`fixtures/test.ts` provides a fresh default state and a `workspaceSeed` option. Use `createWorkspaceSeed()` from `support/workspaceState.ts` to vary a journey's starting state instead of copying localStorage setup into test files:

```ts
import { expect, test } from './fixtures/test'
import { createWorkspaceSeed } from './support/workspaceState'

test.describe('light theme journeys', () => {
  test.use({ workspaceSeed: createWorkspaceSeed({ theme: 'light' }) })
  test('shows the light theme preference', async ({ workspace }) => {
    const theme = await workspace.page.evaluate(() =>
      JSON.parse(localStorage.getItem('fina-workspace') ?? '{}').theme,
    )
    expect(theme).toBe('light')
  })
})
```

An integration scope that needs running engines can opt out of the default UI stubs with `test.use({ stubEngines: false })`; pair it with `@requires-riga` or `@requires-tac` and run it only in a job that provisions those services. Keep this opt-out local to the integration scope rather than weakening the default UI fixture.

## Install and run

```bash
npm ci
npx playwright install chromium
npm run test:e2e
```

For video recording, also install Playwright's FFmpeg helper with `npx playwright install ffmpeg`; installing Chromium alone is not sufficient. On Linux, install system browser libraries if needed with `npx playwright install --with-deps chromium`. To use an already-installed Chromium executable:

```bash
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:e2e
```

## Classify tests and select user journeys

Use Playwright's native `tag` metadata with canonical tags from `support/tags.ts`. Give each test at least one `@journey-*` tag and one `@feature-*` tag. Add `@smoke` only to the fast, high-value release checks; use `@requires-*` to identify tests whose meaningful behavior depends on a live engine or external service. Apply `@demo` and a specific `@demo-*` tag only to deterministic flows suitable for screen recording. Use test titles for readable intent; tags are classification metadata, not a substitute for meaningful names.

Current vocabulary includes `@journey-dashboard-setup`, `@journey-dashboard-review`, `@journey-notebook-capture`, `@journey-visualization-add`, `@journey-preferences`, and features such as `@feature-dashboards`, `@feature-templates`, `@feature-notebook`, `@feature-visualizations`, and `@feature-theme`.

```bash
npm run test:e2e:smoke
npm run test:e2e:journey:dashboard
npm run test:e2e:feature:notebook
npm run test:e2e -- --grep @feature-dashboards
npm run test:e2e -- --grep '(?=.*@journey-dashboard-setup)(?=.*@feature-templates)'
```

Playwright `--grep` treats tag values as regular expressions. Use `|` for OR and lookaheads for intersections. Keep tag spelling in `support/tags.ts`; use tags, not brittle file-name conventions or duplicated scripts, to select future test slices.

## Record and narrate a classified flow

The dedicated demo test uses test steps named for user-visible actions. Record its WebM with:

```bash
npm run test:e2e:demo
```

That runs all `@demo` tests and sets `PLAYWRIGHT_VIDEO=on`. To record only one classified flow:

```bash
npm run test:e2e:demo -- --grep @demo-dashboard-note
```

`@demo-visualization-add` is engine-backed; start `npm run mcp:http:riga` before recording it (the test opts out of the default `/riga/mcp` stub with `test.use({ stubEngines: false })`).

The Playwright config explicitly records 1280×720. Successful recordings are under `playwright/test-results/`; generated test artifacts and finished videos under `playwright/recordings/` are ignored by Git. The runner only captures the selected browser flow; use [`skills/demo/SKILL.md`](./skills/demo/SKILL.md) to derive narration from its `test.step` names, synthesize and synchronize audio, export MP4, and verify the result. It does not automatically create speech or upload video. Narration uses the local `edge-tts` narrator selected with `npm run demo:narrate` — Andrew by default, with `steffan`, `thomas`, or `eric` as alternatives; speech generation does not clone or imitate a real person's voice.

Install FFmpeg helper separately if recording fails:

```bash
npx playwright install ffmpeg
```

The runner's video toggle is `PLAYWRIGHT_VIDEO=on`; `--video=on` is not a supported CLI flag here. Chromium's 1280×720 viewport alone does not guarantee output resolution, so retain the explicit `video.size` in `playwright.config.ts`. The default UI fixture is front-end-only; engine-dependent flows such as `@demo-visualization-add` opt out of the stub and need a verified engine. Without it, the recording shows a real connection error—do not present that as a successful demo.

## Reporting and maintenance

```bash
npm run test:e2e -- --grep "creates a blank dashboard"
npm run test:e2e -- --headed
npm run test:e2e:ui
```

Keep tests independent and deterministic. Prefer role/label-based actions and web-first assertions over fixed sleeps, except for deliberate demo holds. For large suites, keep the fast smoke slice on every change, run journey/feature slices in parallel where safe, and reserve service-dependent tests for jobs that provision those dependencies. Keep test names readable even when tags already classify them.
