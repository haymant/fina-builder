# NIP Phase 3 Coding-Agent Handoff

## Current checkpoint

Phase 3 source-identity and schedule-ownership plumbing is implemented in the working tree. NIP remains the only product authority and the only process-lifetime scheduler. No commit or push had been made before this checkpoint.

The checkpoint includes:

- Full worker profile inventory retained by NIP after `fina-scraper init`.
- Read-only `list_acquisition_source_bindings` NIP MCP tool.
- Exact-evidence binding resolver: one canonical feed URL plus compatible `podcast` source kind is required.
- Explicit `bound`, `unresolved`, and `ambiguous` binding states.
- No worker site ID is treated as a NIP source ID.
- No worker profile creates a source, grants rights, or changes canonical NIP data.
- NIP-owned source lifecycle, subscription state, poll interval, refresh, and manual trigger paths remain the only product schedule operations.
- NIP's in-process scheduler remains the only process-lifetime scheduler; it reads NIP subscription state and does not start or mutate the scraper scheduler.
- Temporary-root inventory coverage and exact-feed/unresolved binding tests.
- Artifact review in `docs/PHASE3_ARTIFACT_READINESS.md`.

## Important verification limitation

`git diff --check` and `node --check scripts/start-nip-e2e.mjs` pass. The Rust test command is blocked before compiling `nip-engine` because this sandbox has Cargo 1.75.0, while the workspace's RIGA submodule requires the edition-2024 Cargo feature. Do not claim the new Rust tests passed until a compatible toolchain is available.

## Data and compatibility safety

Do not modify or stage these preserved local artifacts:

- `lake/`
- `modules/tac-qlib/tac-rd-output/`
- `workflows/`

Do not migrate, rewrite, copy, or delete existing NIP or scraper data. Existing scraper YAML, schedules, and storage remain compatibility/read-only material. TAC/R&D lake data remains separate from NIP.

## Remaining Phase 3 data gate

The resolver intentionally reports worker profiles without canonical locators as unresolved. The next agent must not infer mappings from worker site IDs, display names, seed status, or scraper registration. To complete the data gate, add an explicit, rights-aware NIP binding workflow backed by canonical URL/type evidence, then review the current inventory and create only approved mappings. Ambiguous matches must remain unresolved.

The next agent should also verify whether a persistent binding table is warranted. If added, use a forward-only migration and preserve all existing rows; do not use scraper YAML or schedules as a write-through store. The binding API should support list, explicit bind, unbind/review, and audit metadata, while keeping legacy acquisition write tools outside the product surface.

## Recommended next steps

1. Obtain a compatible Rust toolchain and run `cargo fmt --all` and `cargo test -p nip-engine`.
2. Add service/tool tests for the binding report and source/schedule ownership behavior.
3. Define and implement persistent explicit binding records only after deciding the canonical mapping UX and rights gate.
4. Add a diagnostics view showing bound, unresolved, and ambiguous profiles without presenting unresolved profiles as active sources.
5. Update the Phase 3 architecture status only after the configured inventory has been reviewed and every intended active worker profile has an explicit NIP mapping.
6. Stop and request confirmation before any later commit/push if the user has not authorized it.
