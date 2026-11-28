# NIP Single-Authority Architecture — Phase 4 Handoff

**Status:** Phase 4 implementation and verification are complete. This handoff defines the Phase 5 boundary; Phase 5 has not started.

## Delivered

Phase 4 adds a NIP-owned, one-item acquisition sink. The NIP service and MCP operation accept only one typed `fina-scraper` item under an explicit, current worker-profile/source binding and approved NIP podcast rights. NIP verifies worker identity, HTTP(S) item URL, normalized content and transcript hashes, time bounds, and payload identity before committing the canonical event and the separate acquisition transcript (when present), with NIP run/item lineage in the same transaction.

An exact replay is a no-op, including when a later worker run returns the same item. A changed payload for the same worker identity is rejected. Batch items carrying claims, entity mentions, or feature values are rejected rather than silently ignored or partially written. The engine's binding view now supplies the exact reviewed locator to the persistence check, including when the configured feed URL differs only by a trailing slash.

This is a typed ingestion sink, not an end-to-end worker call path. NIP's existing worker supervisor still handles process lifecycle and MCP initialization only; it does not invoke an acquisition tool or receive a typed batch from fina-scraper.

## Files changed

- `Cargo.lock` and `crates/nip-store/Cargo.toml` — direct URL parsing dependency.
- `crates/nip-store/migrations/0022_single_item_acquisition.sql` — additive run, item, and transcript tables/indexes.
- `crates/nip-store/src/lib.rs` — binding/rights and payload validation, normalized hash verification, replay/collision policy, atomic persistence, transcript readback, and fixture tests.
- `crates/nip-engine/src/lib.rs` — service-side current binding/rights gate, canonical reviewed-locator propagation, transcript readback, and service tests.
- `crates/nip-engine/src/main.rs` — MCP ingestion and transcript readback tools.
- `crates/nip-engine/src/acquisition.rs` — correct the early-exit fixture to complete MCP initialization before exiting, so it tests post-handshake worker exit reporting; production supervisor behavior is unchanged.
- `docs/STORAGE_MAP.md` — transition-state ownership and acquisition-ledger boundary.
- `docs/NIP_SINGLE_AUTHORITY_ARCHITECTURE.md` — Phase 4 status, invariants, and next-phase handoff.
- `docs/NIP_PHASE4_HANDOFF.md` — this handoff.

No fina-scraper source or submodule was modified.

## Verification

- `cargo test -p nip-domain -p nip-store -p nip-engine` using Rust 1.100 from `~/.rustup`: **10 domain, 137 engine library, 14 engine binary, and 42 store tests passed; 0 failed**. The store cases include fresh migration 22, a simulated version-21 upgrade, normalized-hash verification, exact replay/collision, rights/binding rejection, atomic rollback, timestamp bounds, and rejection of claims/entities/features.
- The initial combined run exposed a malformed early-exit test fixture: it exited before consuming the required `notifications/initialized` message, causing `Broken pipe`. The fixture now completes the MCP handshake before exiting; the full combined suite, including that regression test, passes. No production supervisor behavior changed.
- `git diff --check` passes. Package-scoped `cargo fmt --package nip-store --package nip-engine -- --check` still reports formatting differences in pre-existing Phase 2/3 code; no Phase 4-added Rust sections have remaining formatter suggestions after manually wrapping the new test imports.

## Data-safety status

The migration is additive. The only databases opened during tests were temporary fixture stores; no existing NIP database or user lake was migrated. No legacy scraper Parquet/SQLite/YAML/transcript data was imported, copied, rewritten, or deleted. No TradeAC market data or NIP data was changed outside disposable test fixtures. The sandbox's ignored Rust `target` cache had accumulated duplicate inactive DuckDB C++ build outputs; only inspected obsolete cache directories from completed attempts were removed after a full-disk linker failure. All source files, the current build outputs, and submodule worktrees were preserved.

## Phase 5 handoff — not started

Define and test NIP-owned entity mentions/resolution, claim revisions/supersession, and registered feature-definition/value contracts before accepting any of these item fields. Reuse the Phase 4 canonical event and separate transcript as immutable evidence. Preserve exact Unicode quote offsets, extraction tier/review without upgrades, run/producer lineage, as-of and valid-time semantics, and live-versus-reconstructed availability. Do not infer or auto-register feature keys, bulk-import the worker lake, or migrate/rewrite/delete legacy data. No Phase 5 work has been started.
