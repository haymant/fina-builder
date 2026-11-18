---
name: nip-transcription
description: Test NIP local transcription and its downstream events/signals through MCP before adding or debugging a Tauri surface.
---

# NIP transcription, API first

Transcription is a long-running local job. The desktop starts it with
`start_podcast_transcription`, polls `podcast_transcription_status`, and shows
every stage plus the cached audio. Use `nip_asr_status` first: it names the
external `comfy` pack workspace/commit, Python, ffmpeg, the loopback ComfyUI
server and the exact blockers. `transcribe_podcast_episode` remains the
synchronous call for scripts and the chat, but it blocks until the episode is
finished and reports less progress.

## Preconditions

1. Rights are already confirmed for the source (NIP never fetches without it).
2. A local ASR is configured: `NIP_COMFYUI_URL` points at a loopback ComfyUI
   with the Qwen3-ASR graph. Use the `comfyui` skill to check the server:
   `curl -fsS <url>/object_info` and check for `Qwen3ASRLoader`/`Qwen3ASRTranscribe`, or run `python3 modules/comfy/scripts/render.py asr --audio <clip>`.
3. `capabilities.features.local_audio_transcription` is `true`. If it is false,
   stop and fix the ASR configuration; do not substitute a remote provider.

## MCP test sequence

Use the desktop NIP endpoint or start one explicitly:

```bash
NIP_DATA_DIR=/tmp/nip-asr-test NIP_LAKE_DIR=/tmp/nip-asr-test/lake \
  target/release/nip-engine --transport http --bind 127.0.0.1:8794
```

Then call tools over `POST http://127.0.0.1:8794/mcp` (JSON-RPC; send
`MCP-Protocol-Version: 2025-11-25`):

1. `capabilities` — confirm `local_audio_transcription`.
2. `nip_asr_status` — confirm `ready: true`. If not, fix the listed blocker;
   `ensure_comfy_workspace` clones `NIP_COMFY_REPO` into `NIP_COMFY_DIR` when
   the CLI is missing.
3. `list_episode_page {limit, offset, sort, title_contains, source_id}` — get a
   page, not the whole ledger. Use the first episode's `source_id` and
   `source_native_id`.
4. `start_podcast_transcription {source_id, source_native_id}` — returns a job
   immediately. Poll `podcast_transcription_status {job_id}`:
   `download` → `downloaded` (size/duration) → `transcribe` (chunk n/N) →
   `commit` → `transcribed`. A failure records the failing step, error code,
   message, warnings and the cached audio. `cancel_podcast_transcription`
   stops the pack CLI.
5. Review artifacts: `list_podcast_transcription_jobs` (history),
   `list_media_artifacts` (cached audio/video), `delete_media_artifact` /
   `delete_podcast_transcription_job {delete_artifacts: true}` (explicit
   cleanup). Audio is kept for replay until the user deletes it.
6. Re-read the page: the episode state becomes `transcribed`.
7. `search_events {limit: 10}` — the transcript is now a retained event.
8. `narrative_signal_snapshot` — the new dated event appears in Radar/Timeline.
9. `rebuild_narrative_graph` — the graph is a derived projection; rebuild it
   explicitly after the event exists.
10. `extract_claims_from_event {event_id}` — claims require this separate step;
    transcription alone does not create them.

## UI rules these calls enforce

- Do not show **Transcribe locally** unless `capabilities` says ASR is available.
- Show the `nip_asr_status` blockers and next actions verbatim instead of a dead
  button, and offer **Clone comfy pack** only when `repo_url` is configured.
- A running job must show its current stage and chunk progress; a failed job
  must name the failing step (`download`, `transcribe`, `commit`) and code.
- Keep the downloaded audio and transcript reviewable, with an explicit delete
  action. Never upload audio to a remote ASR service.
- After a successful commit, refresh events and signal snapshots, and rebuild
  the graph projection if the UI claims it updated.
- Never upload audio to a remote ASR service; NIP has no remote fallback.
