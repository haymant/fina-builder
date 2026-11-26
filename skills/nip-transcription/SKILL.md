---
name: nip-transcription
description: Process podcast audio and retained transcripts through fina-builder NIP, or prepare evidence-linked narrative JSON for import. Use for local transcription, direct model extraction, working-directory agents, and external agents without NIP MCP access.
---

# NIP transcription and transcript analysis

## Choose the available workflow

1. **Direct NIP processing:** Use NIP's local transcription path for audio, then `extract_claims_from_event` for ordinary evidence-linked claims. The configured provider and NIP consent policy remain authoritative; remote text extraction requires active NIP-specific consent. Never upload audio to remote ASR or silently fall back to a remote provider.
2. **Agent in the fina-builder working directory:** Read this skill and the repository's NIP implementation. Use a registered NIP MCP server **when it is accessible**. Prefer `build_agent_narrative_graph` for a structured narrative, typed claims, and event-scoped entity candidates. If the server is unavailable, do not invent a tool or claim persistence; use the checked-out code/CLI only when present, or prepare the import JSON described below.
3. **External agent without fina-builder access:** Work only from the complete skill, transcript, event metadata, and schema copied from NIP Dashboard Notebook. Return one JSON object matching `schema/processed-transcript-import.schema.json`; do not assume MCP access or return tool-call instructions as a substitute for the JSON.

RIGA may be used by a coding agent as its available model/runtime, but it does not bypass NIP's source rights, transcript privacy, evidence validation, or provider-consent rules. Caller-declared external producer/model fields are not verified by NIP.

## Thesis path vs event path

Publisher transcripts and local ASR remain the **event** path:
they produce retained events and ordinary claims. The
**thesis** path starts from fina-scraper items — which may
themselves be transcript-first podcast episodes — and runs
through triage, LLM deep dive, the thesis gate, the ablation
backtest, and `write_commentary_transcript` (see the
`fina-thesis-review` and `fina-scraper-thesis-backtest-video`
skills). The two paths converge at `import_local_event`, not
before: a thesis video's transcript is imported as its
primary source event input, and the thesis arrives with the
transcript rather than being re-derived from it.

## Rights, privacy, and readiness

- Process only sources with confirmed rights. NIP must not fetch an episode before the source's rights are confirmed.
- For audio, check `capabilities.features.local_audio_transcription` and `nip_asr_status`. The ASR endpoint must be a loopback ComfyUI instance with the Qwen3-ASR graph. If ASR is unavailable, report its blockers and do not substitute remote ASR.
- Before remote transcript-text extraction, check `nip_provider_status`; require its NIP-specific consent state to be `granted`. Do not change provider settings or grant consent on the user's behalf.
- Prefer the retained event as the canonical transcript. Do not silently replace an existing transcript or edit raw event content.

## Local transcription MCP sequence

Use the connected NIP MCP server when accessible. For a local standalone test, the repository can start the engine with:

```bash
NIP_DATA_DIR=/tmp/nip-asr-test NIP_LAKE_DIR=/tmp/nip-asr-test/lake \
  target/release/nip-engine --transport http --bind 127.0.0.1:8794
```

Call tools over `POST http://127.0.0.1:8794/mcp` (JSON-RPC; send `MCP-Protocol-Version: 2025-11-25`):

1. `capabilities` — confirm `local_audio_transcription`.
2. `nip_asr_status` — confirm `ready: true`; if not, report its exact blockers. `ensure_comfy_workspace` clones `NIP_COMFY_REPO` into `NIP_COMFY_DIR` when the CLI is missing.
3. `list_episode_page {limit, offset, sort, title_contains, source_id}` — page through discovered episodes; capture `source_id` and `source_native_id`.
4. `start_podcast_transcription {source_id, source_native_id}` — returns a durable job. Poll `podcast_transcription_status {job_id}` through `download` → `downloaded` → `transcribe` → `commit` → `transcribed`. Report failures with their step, code, message, warnings, and cached-audio status. `cancel_podcast_transcription` stops the pack CLI.
5. Review job/media artifacts with `list_podcast_transcription_jobs` and `list_media_artifacts`; cleanup is explicit via `delete_media_artifact` or `delete_podcast_transcription_job {delete_artifacts: true}`.
6. Re-read the episode page and find the committed event with `find_podcast_episode_event` or `search_events`.
7. `narrative_signal_snapshot` reads descriptive Radar/Timeline signals from canonical events. `rebuild_narrative_graph` rebuilds the graph projection.
8. `extract_claims_from_event {event_id}` performs the separate configured-provider claim extraction; transcription alone does not create claims.

## Structured external-agent analysis and import

Use `build_agent_narrative_graph` only when the NIP MCP tool is available and the caller has already generated the analysis. Otherwise ask an agent to produce the exact JSON import object defined in `schema/processed-transcript-import.schema.json`, then use the NIP Notebook's **Import** action. This bundled schema is authoritative; the Notebook's **Copy skill + transcript** action embeds its full contents in the agent prompt, and a separate **Download import JSON Schema** link is available. The object fields map directly to `build_agent_narrative_graph` parameters: `event_id`, `producer`, `model`, `prompt_version`, `narrative_title`, `narrative_thesis`, `narrative_summary`, `entities`, and `claims`.

- Use the exact selected `event_id`; the event must already contain retained transcript text.
- Include at least one entity candidate and one claim. Every claim must name one or more declared `entities[].canonical_name` values.
- Copy each `evidence_quote` as one contiguous substring directly from the supplied transcript. Preserve ASR spellings, punctuation, whitespace, and capitalization exactly; do not paraphrase, autocorrect, or normalize the wording. It must occur exactly once. Entity evidence must also contain its `surface_form` exactly as it appears in the quote. NIP validates exact text and computes Unicode offsets; never guess offsets. If an exact unique quote cannot be verified, ask for clarification rather than fabricating evidence.
- Use only the schema's accepted claim/entity types and limits. Do not add unsupported fields, ticker mappings, security IDs, or generated Radar values.
- Distinguish transcript statements from interpretation, retain uncertainty, and do not add outside facts. Entity candidates remain unresolved until a separate resolution/review workflow exists.
- `producer`, `model`, and `prompt_version` are caller-declared provenance, not provider attestation. The import persists claims and the narrative analysis and rebuilds the evidence graph; it does not invoke an LLM.
- Radar and Timeline are computed from the retained event ledger, not from caller-supplied scores. Refresh them after import, but do not claim imported annotations changed their underlying counts.

For an external handoff, return only the JSON object (no Markdown fence, commentary, extra wrapper, or fabricated success message). If the transcript is missing, an exact quote is ambiguous, or a requirement cannot be met, explain the blocker instead of fabricating evidence.

## UI behavior and evidence rules

- Do not show **Transcribe locally** unless NIP capabilities say local ASR is available; show ASR blockers/next actions instead of a dead button.
- A running job shows its current stage and chunk progress. A failed job names the failing step (`download`, `transcribe`, or `commit`) and code.
- Keep the downloaded audio and transcript reviewable, with an explicit delete action. Never upload audio to a remote ASR service.
- After a successful transcript commit, refresh events and signal snapshots. Rebuild clusters/graph only when the UI says they were rebuilt.
- Raw events are immutable source observations; derived claims and narrative analyses must retain evidence links.
