# Mode 1 parity — outcome tracker

Mode 3's external-agent fixture journey is verified for its current slice. It does not establish Mode 1 parity or full storyboard/audio/video-provider parity.

## Current slice: make claim choice explicit in Video Workspace

- [x] After a retained NIP event is linked to a Video episode, show the claims whose canonical evidence cites that event.
- [x] Label extracted claims as claims, not verbatim quotations; show their speaker/author, provider/model provenance, exact supporting quote, and source offsets.
- [x] Let the editor explicitly select one or more claims; claims without exact matching retained evidence are not selectable.
- [x] Persist selected claim evidence references and build the storyboard from the selected claims only. Preserve event/claim IDs and exact source spans through VisualSpec and rendered-asset lineage.
- [x] If the event has no retained eligible claims, explain that the editor must extract/review claims in NIP first; do not invent a claim or silently use a generic three-beat substitute.

## Video Workspace UX closure

- [x] Replace manually copied event IDs with an accessible searchable picker over retained transcript text/source IDs.
- [x] Verify that multiple eligible claims can be selected together and produce separate storyboard beats with exact claim/event lineage.
- [x] Add a Claim Explorer quick-create dialog for a selected claim, an exact-span-verified source event, and a new or existing Video project; persist route IDs and open the episode.
- [x] Add a red project-delete action guarded by exact case-sensitive project-name confirmation; remove only project-owned Video records and preserve canonical NIP evidence, global media, and ambiguous job history.
- [x] Fix dark-theme primary-button text contrast and retain a browser regression assertion.

## Mode 1 direct provider parity — still open

- [ ] Provide a self-contained desktop app with an embedded AI workflow that can use explicitly configured local or remote LLM, audio, and video models.
- [ ] Fina Builder and Comfy can call models directly to analyze NIP and handle video generation without requiring external agents or embedded RIGA.
- [ ] Keep credentials in the host/OS secret boundary, bind remote consent to the exact provider/profile/model/operation, show real readiness, and never silently fall back or claim an unavailable model ran.
- [x] Add a direct local NIP claim-extraction provider independent of RIGA, with loopback-only endpoint policy, real model readiness, provenance, and exact quote/offset validation.
- [x] Add Tauri-persisted direct-local provider settings and exact-model readiness controls; keep browser mode explicit about its host-runtime requirement.
- [ ] Add consented remote profiles and direct Comfy TTS/image/video adapters as separately gated capabilities.
- [ ] Preserve exact evidence-span verification, source rights, provider/model/prompt provenance, durable job state, QA, and export lineage for model-assisted output.
