---
name: fina-playwright-demo
description: Run fina-builder Playwright browser tests and turn a selected successful test flow into a reviewed, narrated demo video. Use when asked to screen-record browser automation, add time-aligned narration, mix/export a walkthrough, or prepare a YouTube upload.
---

# Fina Playwright Demo

## Reliable workflow

1. Read `playwright/README.md`, `playwright.config.ts`, and the selected spec. Keep credentials, private account data, and unrelated desktop content out of recordings.
2. Install the browser and Playwright's recording helper when needed, then run a successful deterministic flow:

   ```bash
   npx playwright install chromium
   npx playwright install ffmpeg
   PLAYWRIGHT_VIDEO=on npm run test:e2e -- --grep "narrated demo: create a dashboard note"
   ```

   `--video=on` is not a supported Playwright CLI option in this project; the config reads `PLAYWRIGHT_VIDEO=on`. Recording requires Playwright's FFmpeg helper, not just Chromium. The config explicitly sets video size to 1280×720; without a video size, Playwright recorded 800×450 despite the 1280×720 page viewport. If using a system Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to its executable path. Successful test videos appear under `playwright/test-results/`.
3. Prefer `playwright/demo.spec.ts` for a narrated walkthrough. It creates a blank dashboard and renames a notebook note using only local UI state, with deliberate holds at each screen. The E2E suite aborts `/riga/mcp` and `/tac/mcp`; a tile that depends on RIGA can therefore show “Failed to fetch” even when the UI test itself passes. Do not use such a capture as a polished demo. If the requested demo needs an engine-backed tile, first start and verify that backend; never hide or fabricate an error state. Keep gallery locators specific to the exact title because accessible names can also match descriptions.
4. Confirm the test passed, then inspect the actual video before writing narration. Check the opening, every major UI transition, and final state. Use the recorded duration and visible event times; do not infer timing from the test source alone.
5. Draft narration that describes only visible actions. For synthetic speech, read `/home/ubuntu/skills/tts-prompter/SKILL.md` before calling `generate_speech`. Keep each `turns[].text` verbatim and separate from style. Split into sentence-sized clips when each thought needs its own cue point; use the same supported voice and language for all clips. Never clone, design, or imitate a real person's identifiable voice. A supplied voice sample may inform non-identity details such as pronunciation or pacing only; an authorized complete recording may be used as recorded, not extended in that voice.
6. Measure every narration clip and the screen recording with `ffprobe` (or WAV frame counts). Place clips at the corresponding UI states and leave a short natural pause between them. For repeatable timing, the demo spec's intentional waits are part of the recording design; if those waits change, capture again and recalculate the cues.
7. Use a two-stage audio/video export:
   - First make an audio-only master WAV: delay each narration clip with `adelay=<milliseconds>:all=1`, combine clips with `amix`, and add the intended ending silence with `apad`. Verify the master duration and transcribe it.
   - Then mux the screen WebM and master WAV in a separate FFmpeg command. Map the video and audio streams explicitly, set the target duration, and encode H.264 video plus AAC audio for a broadly playable MP4.

   Avoid mixing multiple delayed audio inputs directly in the same complex filter graph as the video while also using `-shortest`. That attempted approach produced a backward-timestamp warning and an invalid, tiny audio-only MP4. The separate master-WAV-then-mux sequence worked reliably.
8. Verify the finished MP4 with `ffprobe`: require both video and audio streams, expected dimensions, codecs, and duration. Run `manus-speech-to-text` on the final file to check the spoken lines, and use `manus-analyze-video` or frame sampling to confirm narration/action synchronization and absence of visible errors. Listen to the complete mix where possible; correct clipping, abrupt cuts, wrong pronunciation, or mismatched narration before delivery.
9. Keep raw WebM, intermediate WAVs, and analysis files in ignored working folders; provide the final MP4 download link rather than attaching intermediates. Do not add music unless requested.
10. For YouTube, first check for an authorized connector or authenticated browser. Before uploading, show the exact file, title, description, channel, visibility, and thumbnail choice, and obtain explicit confirmation for that exact upload. Verify the final URL and visibility; never claim an upload succeeded without them.

## Current demo cue reference

The tested `playwright/demo.spec.ts` is a short frontend-only example: empty dashboard → blank-dashboard template → dashboard notebook → new note renamed “Analysis note.” Its narration cues were placed around the corresponding states, then checked against the final video transcript and visual timeline. Treat those cue times as a starting point only; remeasure after changing app behavior, test waits, or the narration.
