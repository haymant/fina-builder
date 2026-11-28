# NIP Single-Authority Architecture — Phase 5 Handoff

**Status:** Phase 5 is complete and was committed and pushed to `main` as `e5a75b9` (`feat(nip): implement phase 5 interpretation layer`). Serial Rust tests, targeted rustfmt checks, and diff hygiene checks passed. Full Clippy remains unverified because the native DuckDB archive build exhausted sandbox disk. This handoff records the Phase 5 exit and does not start Phase 6.

## Delivered

Phase 5 adds an additive schema-23 NIP interpretation layer on top of Phase 4's retained events and separate acquisition transcripts. Contract v1 stays backward-compatible; contract v2 adds an explicit derivation manifest, optional typed claim semantics, and role-bearing references to namespaced entity mentions. Claims and mentions retain producer provenance and exact evidence payload/hash/Unicode offsets. Derivation-only reprocessing is atomic, exact replays are no-ops, and changed output or producer/manifest metadata under the same derivation identity is rejected.

NIP now persists append-only typed claim annotations, separate NIP claim-review history, evidence-backed entity mentions, explicit claim-to-mention links, reviewer-created canonical entities, resolve/reject history, and provenance-bearing claim relations. Five registered numeric descriptive feature definitions can be materialized as reproducible point-in-time snapshots. Eligibility applies the requested window and `as_of` to derivation known-time, latest NIP review, latest entity resolution, and feature-definition registration. Same-source/event claims with normalized-equivalent facts remain individually traceable while feature observation counts deduplicate them. Store-generated trust timestamps are not writable through the public service/MCP API.

## Verification

Using Rust 1.100 from `~/.rustup`, the complete serial command passed:

```text
cargo test -p nip-domain -p nip-store -p nip-engine -- --test-threads=1
```

Results: **11 `nip-domain`, 137 `nip-engine` library, 14 `nip-engine` binary, and 47 `nip-store` tests passed; 0 failed.** This includes contract validation, first-ingestion and derivation-only persistence, replay conflicts, evidence references, atomic rollback under a real duplicate-key constraint, review/relation/resolution history, independent review and resolution `as_of` cutoffs, same-source feature deduplication, fresh schema, schema-22 legacy-row preservation, and a simulated version-21 upgrade through versions 22 and 23.

A parallel test attempt once encountered `Text file busy` in the existing worker-supervisor executable fixture; the full serial run completed successfully. Clippy did not complete: its separate native DuckDB archive build failed with `No space left on device` while archiving DuckDB objects, after disk usage reached 98%. Treat Clippy as **unverified**, not passed. The attempt emitted existing `clone_on_copy` warnings in domain test helpers; no warning assessment is complete until Clippy can finish.

## Data-safety and boundaries

The user selected **preserve old data; skip migration/conversion**. Migration 23 is additive. The schema-22 temporary fixture confirms that an existing event, legacy claim, and evidence remain readable, that legacy evidence's new payload metadata remains `NULL`, and that no legacy annotation/entity is auto-created. Phase 5 performs no scraper Parquet/SQLite/YAML/transcript import, conversion, backfill, reconciliation, rewrite, or deletion; it does not mutate TradeAC's `TAC_LAKE_DIR` or connect the NIP feature store to qlib.

Worker entity IDs, canonical-ID hints, and tickers are not identity authority. Reviewer-driven resolution is explicit. Alias authoring/matching, entity merge/split, reviewed instrument mapping, feature-matrix export, worker request/RPC integration, predictive-signal claims, and UI routing are deferred. The alias table in migration 23 is reserved schema, not an active API. Phase 5 does not claim that NIP and TradeAC share one physical store.

## Changed files

- `crates/nip-domain/src/lib.rs` — v1/v2 contract types, validation, and fixtures.
- `crates/nip-store/migrations/0023_nip_phase5.sql` — additive schema, indexes, and registered descriptive definitions.
- `crates/nip-store/src/lib.rs` — transactional persistence, read/review/resolution/relation APIs, feature snapshots, migrations, and regression tests.
- `crates/nip-engine/src/lib.rs` — service wrappers and schema-version expectations.
- `crates/nip-engine/src/main.rs` — MCP DTOs and Phase 5 tools.
- `docs/NIP_PHASE5_CONTRACT.md` — API, contract, and point-in-time semantics.
- `docs/NIP_PHASE5_ARCHITECTURE_PLAN.md` — implementation decisions, gates, and deferred scope.
- `docs/NIP_SINGLE_AUTHORITY_ARCHITECTURE.md` and `docs/STORAGE_MAP.md` — current architecture and ownership update.
- `docs/NIP_PHASE5_HANDOFF.md` — this handoff.

## Next-phase boundary

Phase 6 may consolidate the product-facing UI/tool journey behind NIP APIs. Before doing so, preserve the Phase 5 review/resolution gates and keep legacy stores and TradeAC separate. This Phase 5 handoff is complete; Phase 6 work is a separate phase and is not included here.
