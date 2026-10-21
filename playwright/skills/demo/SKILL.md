---
name: fina-playwright-demo
description: Select classified fina-builder Playwright journeys, capture a successful tagged flow, and produce a reviewed, time-synchronized narrated demo. Use for browser-test screen recordings, narrated walkthroughs, MP4 export, or YouTube preparation.
---

# Fina Playwright Demo

## Select a user journey

1. Read `playwright/README.md`, `playwright/support/tags.ts`, `playwright/support/workspaceState.ts`, `playwright.config.ts`, and the relevant spec. Choose one deterministic test tagged `@demo` plus a specific `@demo-*` classification. Use native `tag` metadata, not filename matching. Prefer a focused user journey/feature slice over recording the entire suite.
2. Run only the selected flow and confirm it passes:

   ```bash
   npm run test:e2e:demo -- --grep @demo-dashboard-note
   ```

   The runner sets `PLAYWRIGHT_VIDEO=on`. The config sets 1280×720; preserve that explicit video size. Install both browser and recording dependency if absent: `npx playwright install chromium` and `npx playwright install ffmpeg`. When using system Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Do not pass `--video=on`: it is unsupported; the project uses the environment switch. The capture appears under `playwright/test-results/`.
3. Inspect the captured video at the opening, each important state transition, and the end. Read the test's `test.step` names as the user-journey outline, but confirm actual video timing and state before drafting speech. Demo `waitForTimeout` calls are deliberate narration holds; ordinary tests should not add fixed sleeps.
4. Check dependency tags and route policy. The shared UI fixture stubs `/riga/mcp` and `/tac/mcp` by default; integration scopes can opt out with `test.use({ stubEngines: false })`. A passing shell test may still show an engine connection error. Do not present that as a successful feature demo or hide the error. Choose a backend-independent journey, or provision and verify the required service before recording an engine-dependent flow.

## Create narration and export

5. Draft narration only for visible, successful actions. For generated speech, read `/home/ubuntu/skills/tts-prompter/SKILL.md` before calling `generate_speech`; keep spoken text verbatim in `turns[].text`, style separate, and use one supported voice consistently. Do not clone or imitate a real person's identifiable voice. A sample may inform non-identity traits only; an authorized complete recording may be used as-is, not extended in that voice.
6. Create one short audio clip per cue when timing matters. Measure the video and every WAV with `ffprobe` or WAV frame counts. Align clips to the actual UI state/action timestamps with short natural pauses. If the flow, test holds, or script changes, record again and recalculate cue times.
7. Use a two-stage FFmpeg export:
   - Build an audio-only master WAV: delay each voice clip with `adelay=<milliseconds>:all=1`, combine using `amix`, pad the intended tail with `apad`, and verify its duration/transcript.
   - In a separate command, mux the WebM and WAV using explicit stream maps and target duration; encode H.264 video and AAC audio in MP4.

   Do not combine several independently delayed narration inputs directly into the video mux while also using `-shortest`. This caused backward timestamps and a tiny invalid audio-only MP4. Creating and validating the WAV master first avoided the issue.
8. Validate the final MP4 with `ffprobe` for both streams, codecs, 1280×720 dimensions (or requested dimensions), and expected duration. Run `manus-speech-to-text` on the MP4 to verify every line and ordering. Use `manus-analyze-video` or timestamped frame checks to verify speech/action sync and check for errors; listen through the complete mix for clipping, abrupt cutoffs, bad pronunciation, and level balance. Fix defects before delivery.
9. Keep WebM, narration clips, WAV master, transcripts, and analysis reports in ignored folders. Attach the final MP4 only; avoid delivering embedded intermediate assets separately. Do not add music unless requested. The classification runner records screen video only; narration synthesis and MP4 assembly remain explicit workflow steps.

## YouTube

10. Check for an authorized publishing connector or authenticated browser. Before upload, show the exact file, title, description, target channel, visibility, and thumbnail choice, and get confirmation for that exact upload. Verify the final URL and visibility. If no publishing route is authorized, deliver the downloadable MP4 and say it was not uploaded.
