---
name: nip-transcription
description: Test NIP local transcription and its downstream events/signals through MCP before adding or debugging a Tauri surface.
---

# NIP transcription, API first

`transcribe_podcast_episode` is an MCP tool. Exercise it directly — the same
call the desktop uses — before changing the UI. This catches ASR availability,
download, parsing, and commit problems in seconds.

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
NIP_COMFYUI_URL=http://127.0.0.1:8190 \
  target/release/nip-engine --transport http --bind 127.0.0.1:8794
```

Then call tools over `POST http://127.0.0.1:8794/mcp` (JSON-RPC; send
`MCP-Protocol-Version: 2025-11-25`):

1. `capabilities` — confirm `local_audio_transcription`.
2. `list_episode_page {limit, offset, sort, title_contains, source_id}` — get a
   page, not the whole ledger. Use the first episode's `source_id` and
   `source_native_id`.
3. `transcribe_podcast_episode {source_id, source_native_id}` — this downloads
   the enclosure and runs local ASR. Expect `transcription_unavailable`,
   `audio_unavailable`, `unsupported_audio`, or `transcription_failed` with a
   real message on failure; never a fake success.
4. Re-read the page: the episode state becomes `transcribed`.
5. `search_events {limit: 10}` — the transcript is now a retained event.
6. `narrative_signal_snapshot` — the new dated event appears in Radar/Timeline.
7. `rebuild_narrative_graph` — the graph is a derived projection; rebuild it
   explicitly after the event exists.
8. `extract_claims_from_event {event_id}` — claims require this separate step;
   transcription alone does not create them.

## UI rules these calls enforce

- Do not show **Transcribe locally** unless `capabilities` says ASR is available.
- Do not show a spinner for a call that returns immediately with an error; show
  the error text in red with the exact missing configuration.
- After a successful commit, refresh events and signal snapshots, and rebuild
  the graph projection if the UI claims it updated.
- Never upload audio to a remote ASR service; NIP has no remote fallback.
