# NIP Phase 3 Coding-Agent Handoff

## Current checkpoint

The Phase 3 explicit source-identity and schedule-ownership slice is complete. NIP remains the only product authority and the only process-lifetime scheduler. This handoff is the commit/push checkpoint; later Phase 4 ingestion work must not begin until this slice is accepted.

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
- Forward-only `nip_acquisition_bindings` persistence with reviewed `bound`/`unbound` state, reviewer, note, and timestamps.
- Strict bind/unbind operations requiring explicit confirmation, reviewer identity, exact kind/locator evidence, active source state, and approved NIP rights.
- Stale or missing-profile explicit records remain unresolved in the read-only binding report; they do not silently recreate or retain source authority.
- Artifact review in `docs/PHASE3_ARTIFACT_READINESS.md`.

## Important verification limitation

`git diff --check` and `node --check scripts/start-nip-e2e.mjs` pass. The Rust test command is blocked before compiling `nip-engine` because this sandbox has Cargo 1.75.0, while the workspace's RIGA submodule requires the edition-2024 Cargo feature. Do not claim the new Rust tests passed until a compatible toolchain is available.

## Data and compatibility safety

Do not modify or stage these preserved local artifacts:

- `lake/`
- `modules/tac-qlib/tac-rd-output/`
- `workflows/`

Do not migrate, rewrite, copy, or delete existing NIP or scraper data. Existing scraper YAML, schedules, and storage remain compatibility/read-only material. TAC/R&D lake data remains separate from NIP.

## Completed Phase 3 data gate

The resolver intentionally reports worker profiles without canonical locators as unresolved. The binding workflow does not infer mappings from worker site IDs, display names, seed status, or scraper registration. It persists only explicit, rights-reviewed mappings backed by canonical URL/type evidence; ambiguous and stale matches remain unresolved.

The persistent binding table is a NIP-owned forward-only migration and does not use scraper YAML or schedules as a write-through store. The binding API supports list, explicit bind, unbind/review, and audit metadata, while legacy acquisition write tools remain outside the product surface.

## Recommended next steps

1. Obtain a compatible Rust toolchain and run `cargo fmt --all` and focused `nip-store`/`nip-engine` tests.
2. Add the Phase 3 diagnostics view showing bound, unresolved, stale, and unbound profiles without presenting unresolved profiles as active sources.
3. Exercise the bind/unbind MCP journey against a fixture-backed NIP store and verify no scraper YAML/schedule mutation.
4. Begin Phase 4 only after the user accepts this commit/push checkpoint: typed worker batch validation and canonical item/event/transcript persistence.
