---
name: playwright-demo
description: Record narrated product demo videos with Playwright using overlay highlights, spotlight dimming for verification targets, and deliberate 5-second pauses. Use when asked for a demo/walkthrough video, a narrated product tour, or to update the demo specs after a UI change.
---

# Playwright demo videos

Demos are ordinary Playwright tests, tagged `@demo-*`, that drive the real app.
The video is a recording of that run. Do not script a separate "fake" UI and do
not modify page elements to make them look highlighted.

**A demo is not finished when the test passes.** It is finished when the MP4 has
audible narration, the narration matches the visible states, and the file has
exactly one H.264 video stream and one AAC audio stream. A silent screen
recording is a failed demo, not a draft. `export-demo.mjs` enforces this gate.

## The overlay director

`playwright/support/demo.ts` injects a fixed overlay layer above the app:

- soft neon glow with a pulse, no hard border (`highlight`)
- spotlight dimming around one component (`verify`, `dim`)
- floating callout/annotation text (`annotate`)
- lower-third caption with a "Verify:" line (`caption`)
- click ripple before a click (`click`)
- `clear()` between steps — nothing is left in the DOM
- a machine-readable beat timeline (`timeline()`) written by the fixture

It is available as the `demo` fixture, or `createDemo(page)`.

```ts
import { expect, test } from './fixtures/test'

test('demo', async ({ page, demo }) => {
  await demo.step('Create an agent', async () => {
    await demo.highlight(page.getByRole('button', { name: 'Create' }), 'Create your first agent')
    await demo.caption('Agents', 'Verify: the agent is stored locally, not uploaded.')
    await demo.pause()            // 5s by default
    await demo.click(page.getByRole('button', { name: 'Create' }), 'Create your first agent')
    await expect(page.getByText('Agent created')).toBeVisible()
    await demo.pause()
  })
})
```

### Highlight vs. verify

Use `demo.verify(target, label)` whenever the viewer must **inspect or verify**
a component: a checklist, provenance panel, consent gate, claim detail, graph
edge, radar card, empty-state boundary, cached media, or final status.

`verify` dims everything outside the target with four click-through panels,
keeps the soft pulsing glow, and leaves the target at full brightness. Do not use
it for ordinary navigation clicks — use `highlight` there.

```ts
// Navigation: light highlight.
await demo.highlight(page.getByTestId('menu-narrative'), 'Narrative workspace')

// Verification: the rest of the page dims so the eye lands on the evidence.
await demo.verify(page.locator('.event-detail'), 'Origin event with source, times and content hash')
await demo.caption('Retained event', 'Verify: source, published/captured/ingested timestamps, and content hash.')
await demo.pause(6_500)
```

`demo.dim()` with no target dims the whole page; pass a locator to leave a
cut-out. `demo.clear()` (called by `demo.step`) removes the dim panels, glow,
callout and caption together.

Rules:

1. **Never change the page.** No injected classes, no CSS overrides on real
   elements. Overlays are `pointer-events: none` and live above the app.
2. **Pause 5 seconds** wherever the viewer must read, compare, or verify
   something. `demo.pause()` defaults to 5000 ms; use 6000–6500 ms for dense
   panels and 8500 ms for the closing frame.
3. **Annotate the "why".** One callout per step, and one `caption(title, verify)`
   that states what the viewer should verify on that tab.
4. **Highlight before you click.** Use `demo.click(locator, label)` so the click
   ripple and glow appear in the same frame.
5. **Clear between steps** (`demo.step` does it). A stale box is worse than none.
6. Keep assertions in the test. A demo that fails silently is not a demo.

## Recording

```bash
# The fixture records the WebM and writes demo-timeline.json next to it.
PLAYWRIGHT_NIP=on PLAYWRIGHT_VIDEO=on npx playwright test \
  playwright/narrative-intelligence-demo.spec.ts \
  --grep @demo-narrative-research

# Find the run directory: video.webm + demo-timeline.json
ls -la playwright/test-results/*narrative*/
```

`demo.timeline()` records one beat at the start of every `demo.step()`. Keep the
narration cue file in the same order as the steps; the exporter uses the beat
timestamps so speech starts when the state appears. Do not hand-guess cue
offsets when a timeline exists.

If Chromium is not installed: `npx playwright install chromium`. A custom
binary is supported through `PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

## Narration

Narration is part of the deliverable. Use one curated synthetic voice for the
whole video; do not clone or imitate an identifiable person's voice. Andrew
(`en-US-AndrewNeural`) is the default.

```bash
# .venv-tts is the project narrator environment.
EDGE_TTS_BIN="$PWD/.venv-tts/bin/edge-tts" \
node skills/playwright-demo/scripts/export-demo.mjs \
  --video playwright/test-results/<run>/video.webm \
  --timeline playwright/test-results/<run>/demo-timeline.json \
  --cues skills/playwright-demo/cues/narrative-intelligence.txt \
  --out artifacts/demo/narrative-intelligence-final.mp4 \
  --title-card artifacts/demo/title.mp4 \
  --voice andrew --rate +10%
```

The exporter:

1. synthesizes one clip per cue through `playwright/skills/demo/scripts/demo-narration.mjs`;
2. checks that every clip fits before the next beat (fails on overlap);
3. builds a stereo 48 kHz WAV master with each cue at its beat time;
4. muxes H.264 1280×720 + AAC 192 kbps, optionally prepending a title card;
5. fails if the result is silent, has the wrong streams, or drifts from the
   recording duration;
6. writes `export-report.json` with cue starts, labels, streams and audio levels.

Write copy for the **visible** state only. Short sentences, present tense, no
claims about live data, no investment advice. If a cue does not fit, tighten the
line or extend the demo hold and record again; do not speed the narrator until
it is hard to understand. Add music only when explicitly requested.

## Verify before publishing

```bash
ffprobe -v error \
  -show_entries stream=codec_type,codec_name,width,height,sample_rate,channels \
  -show_entries format=duration -of json \
  artifacts/demo/narrative-intelligence-final.mp4

ffmpeg -hide_banner -i artifacts/demo/narrative-intelligence-final.mp4 \
  -af volumedetect -f null - 2>&1 | grep -E 'mean_volume|max_volume'
```

Required result: one H.264 video stream at 1280×720, one AAC stereo stream at
48 kHz, duration within 0.5 s of the timeline, `mean_volume` well above −45 dB
and `max_volume` below 0 dB. Watch the whole MP4 start to finish; confirm the
dimming target is the component named in the "Verify:" line and that no stale
overlay remains between steps. If speech-to-text is available, transcribe the
MP4 and compare the lines and order with `cues.txt`.

## What to verify per Narrative tab

- **Event review** — rights, feed identity, episode metadata; after transcription
  the job stage, cached audio, transcript preview, failing step if any.
- **Retained event detail** — source, published/captured/ingested times, content
  hash, original text.
- **Claim Explorer** — claim text, confidence, provider/model/prompt provenance,
  and the evidence quote with a link to the event.
- **Graph** — origin (event) nodes, claim/narrative nodes, evidence-linked edges;
  clicking an origin opens the immutable event.
- **Radar / Timeline** — descriptive counts, honest `coverage`, no score/advice.
- **ETF Themes / Editorial** — no invented mappings or candidates; human review
  is required and shown as such.
- **Consent** — remote extraction stays blocked until explicitly granted.

## Uploading

Use the existing `modules/rehab-video-maker` YouTube skill/script for OAuth and
upload **only**. Do not use that module to generate the demo.

Generate a title, description, tags and a thumbnail that describe this as a
**product demo**, not investment advice. Mark synthetic media when the narration
is TTS. Keep the source recording; do not upscale or re-encode more than once.

```bash
modules/rehab-video-maker/.venv/bin/python \
  modules/rehab-video-maker/skills/podcast-youtuber-agent/scripts/youtube_upload.py \
  --video artifacts/demo/narrative-intelligence-final.mp4 \
  --metadata artifacts/demo/youtube-metadata.json \
  --thumbnail artifacts/demo/narrative-intelligence-thumbnail.png \
  --privacy unlisted
```

Check `--help` for the uploader's current flags, keep OAuth credentials in
`~/.config/podcast-youtuber-agent/`, and verify the returned video ID, URL,
visibility and synthetic-media flag. Never upload a silent file.
