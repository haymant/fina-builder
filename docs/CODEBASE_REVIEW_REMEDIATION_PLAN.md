# Main-Branch Design, Implementation, and Test Plan

**Status:** Plan approved for execution by the user on 2026-11-28. Based on the read-only review of `main` at `fd1a9f7`. Phases 1 and 2 implementation and focused test gates have passed; phases 3–8 have not started. Each phase ends with recorded evidence, a commit, a push, and a handoff before the next phase begins.

## Goals

Reduce security and data-integrity risk; align product behavior with the NIP single-authority design; make packaged operation and worker failure states explicit; fix UI states that misrepresent ownership or results; and remove design/build drift. Preserve all legacy scraper and NIP data. Do not backfill, migrate, rewrite, delete, or consolidate legacy records as part of this remediation. Keep `TAC_LAKE_DIR` and TradeAC-owned data out of scope.

## Review baseline and constraints

The review was static and read-only. No tests or builds were run during review; findings are hypotheses grounded in current code paths, not runtime confirmation. The checkout was clean at `fd1a9f7`. The sandbox filesystem was at approximately 98% usage with about 1.1 GB free, while `target/` occupied roughly 32 GB. Before any build, check available space and run the narrowest relevant tests serially. Do not delete build output or user data without inspecting and establishing that it is safe and inactive. Use Rust from `~/.rustup`.

Each phase must:

1. Stay within its stated scope and preserve the existing data boundary.
2. Add regression tests for changed behavior and run focused tests plus relevant static/format/diff checks.
3. Record exact commands/results, limitations, changed files, and data-safety outcome in its handoff.
4. Commit and push to `main` only after its gates pass; stop at the phase boundary and provide the handoff before beginning the next phase.

## Phase sequence

### Phase 1 — HTTP exposure containment

**Scope:** Make remote HTTP binding fail closed until authenticated remote access is deliberately designed. Keep stdio and loopback HTTP behavior. Treat `--allowed-host` as Host/DNS-rebinding validation, not authentication. Ensure auxiliary `/health` and `/media` routes cannot become remotely reachable through an accepted configuration without authentication.

**Implementation:** Validate that HTTP bind addresses are loopback; return a clear startup/configuration error for wildcard or non-loopback addresses. Document that remote authenticated deployment is not yet supported. Add unit tests for IPv4/IPv6 loopback acceptance, wildcard/remote rejection, and unchanged stdio behavior.

**Exit gates:** Focused NIP engine binary tests pass; usage/config help accurately documents the constraint; no service route bypasses the bind policy; formatting and `git diff --check` pass. No data or schema changes.

### Phase 2 — Acquisition authorization and source-lifecycle integrity

**Scope:** Address binding staleness after feed/profile changes, disabled profiles, paused sources, stale binding on source deletion/reuse, and service-level rights-confirmation bypass.

**Implementation:** Define a single current-profile/source authorization predicate and enforce it in bind, ingest, derivation, and the transactional store boundary. Include enabled/profile locator and active-source state in the checked evidence. Explicitly unbind or invalidate bindings during source deletion. Make rights confirmation explicit at the service/use-case boundary. Preserve audit history; do not infer or auto-bind.

**Exit gates:** Regression tests cover locator change, disabled profile, paused/removed source, source deletion and ID reuse, unconfirmed service call, and transactional recheck. Existing binding/replay tests remain green. No legacy migration/backfill.

### Phase 3 — Worker availability and explicit acquisition job protocol

**Scope:** Make NIP remain available when the subordinate scraper is missing, and close the gap between a supervised MCP child, an externally supplied ingestion batch, and NIP-owned job lifecycle.

**Implementation:** Represent worker availability as health/capability state; allow unrelated NIP service startup when the worker is unavailable. Design and implement a narrow typed request/result adapter and NIP-owned job state (identity, idempotency, queued/running/terminal states, attempts, progress, cancellation, accepted result linkage). Route result acceptance through existing binding, rights, hash, evidence, and replay gates. Define a least-privilege worker configuration/credential boundary; never log secrets. Keep worker-local retry caches subordinate and non-product-facing.

**Exit gates:** Tests cover worker absent/launch failure/handshake failure without blocking NIP reads, accepted and rejected typed results, duplicate request/result idempotency, cancellation and failure states, and secret non-disclosure. No legacy scraper write tool is used as the acceptance shortcut. Any new NIP schema is additive and tested on fresh and prior-schema fixture databases; no legacy rows are rewritten.

### Phase 4 — One schedule/job authority and packaged desktop transport

**Scope:** Resolve the default packaged Tauri scraper route gap and remove product-visible dual schedule/job ownership only after NIP equivalents are available.

**Implementation:** Route Narrative schedule intent, trigger, status, and accepted results through the Phase 3 NIP job API. Decide and document a single NIP-owned schedule model and execution path; distinguish it from podcast subscription refresh. For packaged Tauri, use the NIP-facing transport; provide explicit health and unavailable states rather than silently relying on the Vite-only `/fina-scraper` proxy. Keep any transitional scraper diagnostics clearly labeled and non-authoritative. Do not migrate legacy schedule records; preserve them as compatibility/diagnostic data unless a separate approved migration is designed.

**Exit gates:** Packaged-runtime integration tests verify the transport/service path; schedule create/pause/resume/trigger and run-status journeys use NIP APIs; only one product scheduler is active; worker-unavailable UI behavior is explicit. Legacy schedule files and TradeAC data are unchanged.

### Phase 5 — Persistence, replay, and temporal integrity

**Scope:** Fix event pagination truncation, partial claim commits, ambiguous source creation outcomes, thesis citation/review/status invariants, backtest replay comparison, caller-controlled editorial timestamps, and migration/test-helper defects.

**Implementation:** Add complete paginated/batched event reads; make multi-claim writes atomic; model source registration separately from refresh or return explicit idempotent partial success; validate cited claims and required review grade; enforce thesis status transitions/revisions; compare complete immutable backtest payloads on replay; use server-generated authoritative review timestamps; restore dropped indexes and make migration target-version behavior truthful.

**Exit gates:** Regression tests exceed the former 200-event boundary, inject mid-batch failures, exercise source refresh failure/retry, missing/unqualified thesis citations, terminal thesis rewrite, changed backtest payload under same ID, timestamp boundaries, index presence after upgrade, and intermediate migration targets. Existing point-in-time and Phase 5 tests pass. No destructive migration or legacy promotion.

### Phase 6 — Narrative UI correctness and provenance

**Scope:** Fix route synchronization, source-read error versus empty state, timestamp provenance, budget zero parsing, schedule-ID validation/collision behavior, and truthful partial-result handling for mixed-owner operations during transition.

**Implementation:** Make route state authoritative; expose read errors distinctly and disable ownership-dependent writes until necessary data is available; label timestamps by their actual source; preserve numeric zero and distinguish blank/invalid input; validate schedule IDs against loaded inventory and backend policy; report per-item outcomes and refresh after partial writes. After Phase 4, remove transitional direct scraper product writes rather than masking them.

**Exit gates:** Component and repository tests cover route changes, read failure, empty results, timestamp fallback, zero/blank budgets, unknown/colliding site IDs, and failure after an earlier bulk write. Playwright verifies key Narrative journeys, provenance visibility, and worker-unavailable states.

### Phase 7 — Build, CI, dependency, and worker reliability

**Scope:** Resolve CI sidecar staging risk, explicit `uv` provisioning, npm/pnpm lock divergence, release Cargo lock stamping, required NIP browser journey coverage, and steady-state scraper Retry-After/backoff behavior.

**Implementation:** Run relevant CI build paths; ensure declared Tauri resources are supplied or use an intentional CI configuration; provision pinned `uv`; choose one package manager or enforce synchronized lock policy; make release stamping reproducible and validate `--locked`; add bounded NIP journey coverage; capture response status/Retry-After and apply bounded retry backoff without confusing it with schedule cadence.

**Exit gates:** A clean CI-equivalent build/test run passes for affected targets; release lock validation succeeds from tagged/stamped metadata; dependency policy is single-source or checked; NIP Playwright integration is required or explicitly guarded; tests cover retry-after precedence and max backoff. No broad dependency upgrade unless separately justified.

### Phase 8 — Documentation and historical checkpoint reconciliation

**Scope:** Reconcile live architecture/ownership statements, Phase 5 pre-implementation baseline language, Phase 3/4 historical handoffs, and stale acquisition comments against the implemented code.

**Implementation:** Label phase handoffs as dated historical snapshots with links to the current authority plan. Make the current schedule/worker/packaging state explicit. Preserve historical test evidence, but distinguish it from current main state. Update storage map and current plan only to claim behavior that tests and current code demonstrate.

**Exit gates:** Search for contradictory live-status phrases and compare key ownership claims to code/API tests; `git diff --check` passes; no behavior or user data changes in the documentation-only phase.

## Cross-phase invariants

- NIP remains the sole product-facing authority for accepted narrative evidence and canonical interpretation.
- fina-scraper remains subordinate; worker IDs and tickers are not identity authority.
- Keep TradeAC and `TAC_LAKE_DIR` separate; no qlib/export integration is added by this review remediation.
- Preserve old data and skip legacy migration/conversion/backfill/reconciliation/rewrite/deletion.
- Keep trust timestamps server-generated, preserve exact evidence/provenance and point-in-time semantics, and make partial success explicit.
- Do not silently fall back between services or represent unavailable data as empty/healthy.
- Any schema change is additive, forward-only, and covered by fresh-schema and upgrade-preservation tests.

## Execution record

### Phase 1 — HTTP exposure containment

- `nip-engine` now rejects non-loopback bind addresses when using HTTP. Stdio is unchanged. CLI usage explicitly states remote HTTP is unsupported until authentication is implemented; Host allowlisting is not treated as authentication.
- Regression coverage: `CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline -p nip-engine --bin nip-engine transport -- --test-threads=1` — **3 passed, 0 failed** (IPv4/IPv6 loopback allowed; wildcard and remote HTTP binds rejected; stdio remains unrestricted by this HTTP rule).
- `rustfmt --check --edition 2021 --config skip_children=true crates/nip-engine/src/main.rs` and `git diff --check` passed.
- Cargo emitted existing unused-import warnings in `crates/nip-engine/src/lib.rs` and an existing dead-code warning for `WorkerState::Starting` in `acquisition.rs`; they are outside this phase's change.
- After the focused Cargo build, sandbox disk headroom fell to about 277 MB (100% used). Do not run further builds until safe disk headroom is available; do not remove existing build outputs without establishing that they are inactive and expendable.
- Data-safety result: no database, legacy data, or schema was changed.

### Phase 2 — Acquisition authorization and source-lifecycle integrity

- Acquisition resolution now requires an enabled podcast profile whose current locator matches the bound source; inactive, disabled, changed, or non-podcast profiles do not authorize ingestion. Service-level bind, ingest, and derivation checks also require an active source and a current matching profile.
- The store transaction independently validates approved podcast rights, active source state, and source locator when binding; ingestion and derivation transaction predicates now require `state = 'active'`. Store entry points also reject normalized worker/source locator mismatches, including direct calls that bypass service validation.
- Source deletion transactionally invalidates associated bindings and records an audit note, so reusing the source ID cannot silently restore authorization. `NipService::create_source` requires explicit rights confirmation; the MCP handler forwards its validated confirmation value.
- Focused engine tests passed serially and offline (1 passed each):
  - `CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline -p nip-engine --lib explicit_acquisition_binding_is_confirmed_audited_and_stale_safe -- --test-threads=1`
  - `CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline -p nip-engine --lib typed_worker_ingest_requires_explicit_binding_and_rejects_changed_or_stale_items -- --test-threads=1`
  - `CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline -p nip-engine --lib scraper_site_id_collision_is_rejected_before_nip_source_creation -- --test-threads=1`
  - `CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline -p nip-engine --lib source_binding_requires_exact_feed_evidence_and_never_creates_sources -- --test-threads=1`
- Focused store tests passed serially and offline (1 passed each):
  - `CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline -p nip-store --lib acquisition_binding_records -- --test-threads=1`
  - `CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline -p nip-store --lib unbound_or_rights_unapproved_source_cannot_persist_worker_items -- --test-threads=1`
  - `CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline -p nip-store --lib deleting_a_source_is_refused_while_events_reference_it -- --test-threads=1` (also exercises binding invalidation and source-ID reuse)
  - `CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline -p nip-store --lib derivation_only_replay_fingerprints_manifest_and_producer_metadata -- --test-threads=1`
- `CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo test --offline -p nip-engine --bin nip-engine --no-run` compiled the updated MCP binary. Targeted `rustfmt --check --edition 2021 --config skip_children=true` across all four changed Rust files and `git diff --check` passed. Workspace-wide formatting is not claimed because unrelated baseline formatting differences were previously observed.
- Existing warnings remain: unused imports in `nip-engine/src/lib.rs` during binary compilation and the pre-existing unconstructed `WorkerState::Starting` variant. A separate `cargo check --offline -p nip-engine --bin nip-engine` triggered a long DuckDB C++ check-profile rebuild and was stopped to protect disk space; the partial generated check-profile output was removed. Final observed free space was about 1.5 GB.
- Data-safety result: no migration, backfill, legacy-data rewrite, or TradeAC data operation was performed. Changes are code-only; regression tests used temporary fixture databases. No production database was opened or modified.
