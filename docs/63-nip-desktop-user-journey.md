# 63 — NIP desktop user journey: setup, feeds, transcription, extraction

**Status:** Implemented and demonstrated on 2026-11-17 with the real NIP Streamable HTTP service, a disposable DuckDB ledger, a loopback RSS/audio fixture, and a deterministic loopback RIGA provider bridge. No public feed, public model endpoint, real podcast audio, or production credential was used. The browser journey is not a packaged-desktop smoke; a release installer must still be exercised separately.

This document is the user-facing complement to the NIP plans in docs 55–60. It describes how an analyst gets from the desktop app to a source-linked, evidence-backed narrative workspace, and records the automated/narrated demonstration that proves the flow.

## 1. Get NIP desktop

Narrative Intelligence is part of the fina-builder desktop shell. It is not a separate installer.

- **Installed build:** install the platform release from the project’s GitHub Releases. The desktop bundle includes the `nip-engine` sidecar (`src-tauri/tauri.conf.json` → `bundle.externalBin`).
- **Local build:** `npm ci`, then `npm run mcp:sidecar:nip` and `npm run tauri:dev`. The desktop host starts the NIP sidecar and injects NIP-only app-data paths plus the loopback RIGA bridge URL/token.
- **Browser development:** `npm run nip:http` starts NIP at `127.0.0.1:8794`; Vite exposes it same-origin at `/nip/mcp`. Browser code never spawns processes or calls a private port directly.

At startup the NIP process owns an in-process refresh scheduler. It checks due feeds immediately and every six hours while the process remains alive.

## 2. First-run setup

Open the **Narrative** menu and choose **Narrative Intelligence**. The first-run checklist tracks five gates:

1. **Local service** — the NIP sidecar is reachable and the DuckDB ledger/schema is ready.
2. **Extraction provider** — a local or remote model is selected in RIGA. A remote model shows **Consent needed** until NIP-specific consent is granted.
3. **Approved source** — at least one feed has an explicit access/retention rights confirmation.
4. **Retained transcript** — at least one immutable event with source provenance exists.
5. **Evidence-linked claims** — at least one extraction run has committed claims with evidence.

The **Local readiness** card shows the DuckDB schema/API version, approved-feed count, search mode, and optional semantic-index state. The **Operational monitor** shows ledger size, event/claim/run counts, graph edges, scheduler cadence, latest provider/model/run, and safe warnings. The **Extraction provider** card shows the exact provider/model binding, local-versus-remote mode, consent status, disclosure text, and grant/revoke actions.

If the provider bridge is absent or unavailable, extraction stays unavailable. NIP never falls back to a different provider or to the deterministic fake provider.

## 3. Configure one approved feed

Use **Add an approved podcast**:

- Source ID (stable local identifier)
- Exact RSS feed URL
- Show name
- Rights statement describing permission to fetch, process, and retain the source
- Explicit **I confirm access and retention rights for this source** checkbox

The **Approve and sync** action is disabled until the confirmation is checked. The service persists the approval timestamp and subscription state before making the initial fetch. It then discovers RSS episode metadata, not transcripts. No episode audio is downloaded by the subscription action alone.

The **Approved sources** and **Refresh status** cards show feed URL, rights-confirmation time, state, last check, next poll, consecutive failures, and safe error codes. **Run now** performs an explicit due-feed refresh; the process scheduler remains authoritative for automatic refreshes.

## 4. Transcribe a discovered episode

The **Discovered episodes** card is the primary ingestion surface. It lists RSS metadata (episode GUID, title, publication time, enclosure, state) and never asks the user to import each episode file.

For an episode in `awaiting_local_transcription`, choose **Transcribe locally**. In the current test/demo environment this calls the deterministic local ASR fixture. In a production configuration, local transcription remains gated on a validated ComfyUI/ASR runtime and the cleanup/retention acceptance tests in docs 59/60. The UI reports transcription as unavailable rather than uploading audio to a remote ASR service or silently substituting a cloud provider.

A successful run commits one immutable event with:

- source ID and episode GUID/canonical URL
- transcript text
- content hash
- distinct `published_at`, `captured_at`, and `ingested_at` times
- ASR/provider provenance

Temporary enclosure audio is not part of the retained event or Parquet export.

## 5. Extract claims and narratives

Open the retained event and choose **Extract claims**. The configured RIGA provider/model is resolved by the desktop host; NIP receives only a loopback bridge URL/token and never owns provider credentials.

- **Local model:** extraction proceeds with the selected local model and no remote-content consent.
- **Remote model:** extraction is blocked until the analyst accepts the disclosure that transcript text and the claim-extraction prompt will leave the device. Consent is bound to the provider profile and model. Revocation appends an audit event and blocks later extraction.
- **No bridge / provider unavailable / model changed:** extraction is explicitly unavailable; no fallback occurs.

Each committed claim keeps the claim text, speaker/author, confidence, extraction run ID, provider kind/profile, model, reasoning effort, prompt/schema version, extraction time, and one or more evidence links (event ID, quote, optional offsets).

## 6. Review evidence and derived views

- **Event review** — immutable source observations with provenance and timestamps.
- **Claim Explorer** — claim list plus source evidence quote, event ID, confidence, speaker, run, provider, model, and prompt version.
- **Graph** — versioned derived projection. **Rebuild clusters** and **Rebuild graph** create new projections; every edge retains source event IDs. Selecting an evidence chip returns to the immutable event and scrolls it into view.
- **Radar / Timeline** — descriptive views over completed Monday-00:00-UTC weeks. Radar displays current/prior counts, delta per day, persistence, category counts, coverage state, and data-quality flags. A zero prior count produces “no comparable baseline” and a null percent change rather than a fabricated score.
- **ETF Themes** — manual, dated research mappings with rationale and evidence. Ticker existence, market-data coverage, mapping validity, and backtest availability remain separate explicit states. Backtesting stays disabled until point-in-time total-return inputs exist.
- **Editorial Planning** — ranked topic candidates for human review. It does not claim finished content, CTR prediction, or novelty without an approved methodology.

## 7. Automated coverage

The user-visible flow is covered by:

```bash
# Fast UI-only setup, rights, transcription, consent, and extraction checks
npx playwright test playwright/narrative-intelligence-setup.spec.ts

# Real loopback service journey (starts NIP, RSS/audio fixtures, and the fake RIGA bridge)
PLAYWRIGHT_NIP=on npm run test:e2e:journey:narrative

# Narrated screen recording (sets PLAYWRIGHT_VIDEO=on)
PLAYWRIGHT_NIP=on npm run test:e2e:demo -- --grep @demo-narrative-research
```

The live slice uses `scripts/nip-fixture-server.mjs` for the synthetic RSS/audio feed and `scripts/nip-provider-bridge-fixture.mjs` for the deterministic loopback host bridge. `scripts/start-nip-e2e.mjs` starts NIP with a disposable `playwright/.data/nip/` DuckDB store, no `DATABASE_URL`, no `VECTOR_DB_URL`, and no ComfyUI endpoint. The bridge is test-only and never contacts a remote provider.

Relevant tags: `@journey-narrative-setup`, `@journey-narrative-ingestion`, `@journey-narrative-evidence-review`, `@feature-narrative-setup`, `@feature-narrative-sources`, `@feature-narrative-events`, `@feature-narrative-claims`, `@requires-nip`, `@demo-narrative-research`.

## 8. Narrated demonstration

Artifact: `playwright/recordings/narrative-intelligence/nip-desktop-journey.mp4`

- 1280×720 H.264 video, AAC stereo 48 kHz audio
- 100.8 seconds
- Narrator: Andrew (`en-US-AndrewNeural`), rate `+10%`
- Raw WebM, cue clips, WAV master, and cue script remain in the Git-ignored `playwright/recordings/narrative-intelligence/` directory

Narration transcript (timing is the final mix):

| Start | Narration |
| --- | --- |
| 0:00 | Narrative Intelligence runs inside the desktop app. Open the Narrative menu and choose it. |
| 0:06 | Five setup gates: service, provider, source, transcript, and claims. |
| 0:12 | Rights confirmation comes before any fetch. One approval subscribes and syncs. |
| 0:19 | RSS discovery finds the episode automatically, with no file import. |
| 0:25 | Transcribe locally. Audio is temporary; the transcript keeps source and hash. |
| 0:31 | The retained event is immutable and separates publication, capture, and ingestion time. |
| 0:36 | Remote extraction needs consent, bound to this provider and model. |
| 0:43 | Extraction commits evidence-linked claims with full derivation provenance. |
| 0:49 | Every claim links to its source event and quote, with confidence and run provenance. |
| 0:56 | Clusters and the graph are versioned projections; every edge keeps source evidence. |
| 1:02 | An evidence chip returns to the immutable event, closing the loop. |
| 1:07 | Radar compares completed UTC weeks and labels unknown coverage and missing baselines. |
| 1:14 | Timeline uses the same evidence and point-in-time windows. It does not invent a score. |
| 1:20 | ETF mappings are dated research records; backtests stay disabled. |
| 1:25 | Editorial Planning ranks topics for human review, not finished content or CTR. |
| 1:31 | The checklist is complete: service, provider consent, source, transcript, and claims. That is the journey. |

Verification: `ffprobe` reports one H.264 1280×720 video stream and one AAC 48 kHz stereo audio stream, both 100.8 seconds. Volume analysis reports mean −24.3 dB and max −5.5 dB (no clipping). A local faster-whisper `tiny.en` pass recovered every cue in order.

## 9. Known boundaries

- The demo uses a **synthetic fixture feed and deterministic provider bridge**, not a live podcast, not a live model, and not ComfyUI.
- The packaged-installer smoke and installed-build restart/recovery run remain pending.
- Optional Qdrant semantic search remains disabled in the demo (`VECTOR_DB_URL` unset). DuckDB lexical search is authoritative.
- No investment recommendation, backtest, paper portfolio, CTR, or predictive signal is claimed.

## 6. Troubleshooting: `NIP service unavailable — the local NIP endpoint did not respond`

The host spawns and stops the `nip-engine` sidecar on demand. That message means
the sidecar exited before answering, not that the network is down.

1. Run the sidecar by hand against the same data directory the app uses
   (`~/.local/share/com.fina.payoffexplorer/NIP` on Linux):

   ```bash
   NIP_DATA_DIR=~/.local/share/com.fina.payoffexplorer/NIP \
     ./src-tauri/binaries/nip-engine-x86_64-unknown-linux-gnu --transport stdio < /dev/null
   ```

   A storage failure prints `startup_failed` with the underlying store error on
   stderr. `connection closed: initialize request` means the database opened
   correctly and the process simply had no client.
2. If the error mentions the WAL, a stale `nip.duckdb.wal` was left by a process
   that was killed mid-checkpoint (for example while the sidecar binary was
   replaced under a running app). Move it aside and retry — the database file
   itself is at the current schema:

   ```bash
   mv ~/.local/share/com.fina.payoffexplorer/NIP/nip.duckdb.wal /tmp/nip-wal-backup.wal
   ```

   DuckDB replays ordinary writes from a WAL; it cannot replay the catalog
   records from migration 0009's table rebuild, which is why the store now runs
   `CHECKPOINT` immediately after any migration.
3. Never re-stage `src-tauri/binaries/nip-engine-*` while a sidecar from the
   same path is running: `cp` fails with `Text file busy`, and the build
   scripts now report that instead of claiming the binary was staged. Stop the
   app, stage, then start it.
