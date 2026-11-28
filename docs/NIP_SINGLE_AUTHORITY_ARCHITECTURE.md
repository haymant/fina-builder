# NIP Single-Authority Architecture and Execution Plan

**Status:** Phase 0 audit, Phase 1 contract foundation, Phase 2A acquisition-boundary work, Phase 2B worker supervision, and the Phase 3 source-binding ownership slice are implemented. Typed batch ingestion and canonical item persistence remain later phases.

## Executive decision

NIP is the single product and canonical data authority for Narrative Intelligence. fina-scraper is an embedded acquisition worker used by NIP—not a peer product, source registry, evidence catalog, schedule manager, or UI backend. The worker performs site-specific fetching, parsing, transcription, dedup assistance, and extraction when NIP asks it to. NIP owns source identity, rights and policy, scheduling intent, run/job lifecycle, acceptance and revision decisions, canonical records, application workflows, and all product-facing reads and writes.

“Embedded” describes ownership and lifecycle, not a requirement that every scraper function be compiled into the NIP process. The worker may initially remain a Rust library or NIP-supervised child process. It must not have an independent product lifecycle or canonical write authority. A standalone scraper MCP may remain temporarily as a developer/operator diagnostic, but must not be part of the normal user journey or offer a competing source/evidence write path after NIP orchestration is available.

The final architecture has one canonical NIP record for each product concept. A worker may maintain private operational state needed to execute efficiently (for example, retry cursors or a dedup cache), but that state is subordinate implementation detail, not a second editable source/schedule/evidence catalog. Existing scraper Parquet, SQLite, YAML, schedule, transcript, and run files are preserved as legacy/compatibility material until a separately planned and authorized migration or retirement. They are not silently copied, rewritten, or deleted by the initial phases.

The immediate target is **one logical authority and one product API**. Physical consolidation is deliberately later: the final storage design must be chosen based on point-in-time/version semantics, feature-query scale, DuckDB constraints, backup/rollback, and the cost of preserving existing Parquet history. Do not claim the physical stores are unified until that migration actually happens.

## Current baseline and proof points

The current branch still has split ownership and should not be described as the final design:

- `NIP_LAKE_DIR` is a common configured root, not a single canonical database. fina-scraper currently initializes its `_config`, `_schedules`, `_state`, `_runs`, transcript, and Parquet layout at the root; nip-engine stores `nip.duckdb` under `_nip`.
- Tauri resolves the subordinate fina-scraper binary for nip-engine; it does not initialize scraper storage or forward scraper-owned inventory. NIP initializes the acquisition layout, discovers inventory, and supervises the worker process.
- Development launchers can start fina-scraper as a separate optional MCP service. Narrative UI components still access NIP and scraper adapters; the repository is a partial routing facade, not one NIP API.
- There is no automatic Parquet-to-DuckDB import. Similar item/event/claim/entity labels do not prove that the rows are currently duplicates.
- NIP has unique workflows that must survive: rights and consent/audit, retained event identity and exact quote-offset validation, podcast transcript state, graph/research/thesis workflows, and the detailed video project/storyboard/asset/QA/lineage model.
- fina-scraper has valuable collection mechanics and evidence semantics that must survive: feed/site adapters, dedup and revisions, ASR/NLP tiers, run lineage, live/reconstructed availability, valid-time and as-of queries, feature extraction, and backload support.

The new `nip-domain::AcquisitionBatch` contract is defined and unit-tested in isolation. Phase 2A moves acquisition initialization/inventory under NIP, and Phase 2B adds NIP-owned worker lifecycle supervision; typed batch ingestion and canonical persistence remain later phases.

## Canonical ownership target

| Concept | Final authority | Worker role | Compatibility rule |
| --- | --- | --- | --- |
| Source identity, locator, rights, user-visible status | NIP | Resolve a NIP-provided source binding to a worker adapter/profile | Existing scraper `site_id`/YAML stays readable until explicit mapping; string-ID equality alone is not identity proof. |
| Schedule intent, enable/disable, trigger policy | NIP | Execute the requested job and return progress/results | Existing scraper schedules are legacy worker configuration, not a second product scheduler. Do not start duplicate poll loops. |
| Fetch, parse, ASR, dedup assistance | NIP orchestrates; scraper performs acquisition mechanics | Return typed results and operational diagnostics | Worker-only retry/cursor cache may remain subordinate; no user-facing source or evidence authority. |
| Item/event and transcript content | NIP canonical event/transcript records | Produce content, hashes, timestamps, transcript and source provenance | Existing Parquet/transcript files remain non-destructive compatibility/read-only data until a separately authorized migration. |
| Claims and evidence spans | NIP | Produce claims with structured triplets, tier/review, extraction provenance and exact spans | NIP validates evidence against its canonical retained payload; no automatic trust upgrade or parallel claim catalog. |
| Entity mentions and resolution | NIP | Produce attributed mentions and candidate mappings | NIP must define the canonical entity-resolution model; do not mistake NIP's unresolved agent candidates for a complete entity catalog. |
| Feature definitions and snapshots | NIP | Compute values for NIP-registered feature keys | Worker cannot create/rename feature definitions as a side effect. Preserve as-of, valid-time, availability, run, model and review metadata. |
| Thesis, graph/research, video workflows, consent/audit | NIP | Supply acquisition evidence only | Preserve NIP revisions, gates, lineage and exact evidence checks. Scraper thesis/backtest artifacts are referenced until their schemas are mapped losslessly. |
| Ingestion job/run status | NIP product job record | Report worker run ID, state, progress and diagnostics | Internal scraper run files may remain for retries/diagnostics, but do not define a second user-visible job lifecycle. |
| Market data / TAC lake | TradeAC (separate domain) | None | Keep `TAC_LAKE_DIR` separate; no narrative writes into the trading lake. |

## Boundary contract introduced in Phase 1

`crates/nip-domain/src/lib.rs` defines a versioned `AcquisitionBatch` produced by the worker and consumed by NIP in a later phase. It includes:

- producer name/version, worker run ID, start/end times, and a NIP `source_id` plus a separately namespaced `worker_source_key`;
- stable worker item ID, source URL/title, content kind/text/hash, publication/ingestion/validity timestamps, and live/reconstructed availability;
- optional transcript text/hash/language/method/model/time;
- structured claims and entities with extraction tier, model/version, prompt version, extraction confidence, review state, and exact evidence spans;
- feature values referring to NIP-registered feature keys, with as-of/valid-time/availability and extraction provenance.

The domain validator checks contract version, required values, duplicate item/claim/entity/feature identifiers, validity intervals, confidence ranges, and exact quote/offset matches. Offsets count Unicode scalar values, matching the retained-transcript quote validator. Store-level checks remain mandatory: source existence and mapping, rights approval, content-hash verification, feature-key registration, idempotency/revision policy, and atomic persistence. The worker cannot grant rights, register a source, approve its own content, set NIP review state, or redefine feature catalogs.

This contract is intentionally not an importer yet. In particular, do not reuse `import_local_event` unchanged: it is a local-document operation with explicit user rights confirmation and current idempotency behavior, not a complete scraper item/revision contract.

## Phased execution and exit gates

### Phase 0 — Audit and target architecture (complete)

**Work:** Inspect runtime/process boundaries, stores and schema ownership, UI call graph, existing compatibility guards, tests, and user-data safety. Decide one authority model and distinguish current physical layout from the target.

**Exit criteria:**
- Existing writers/readers and the current split are documented without claiming automatic Parquet-to-DuckDB copying.
- NIP is explicitly the final product/canonical authority; scraper is an acquisition worker.
- NIP-unique workflows, scraper temporal/extraction semantics, and non-destructive data constraints are listed.
- First code boundary and phase-gated implementation sequence are selected.

**Result:** Satisfied by this architecture document and the refreshed storage map. No persisted user data was read for migration or changed.

### Phase 1 — NIP-owned worker result contract (foundation complete; integration pending)

**Work:** Define the NIP domain envelope for a worker-produced batch, preserve source/run/content/extraction lineage, and reject missing or inexact evidence spans before persistence is attempted.

**Exit criteria:**
- Contract is versioned, strict about unknown fields, and represents item/transcript/claim/entity/feature values without creating a second catalog.
- Tests cover serialization, Unicode offsets, missing transcript evidence, inexact quotes, unsupported versions, and duplicate IDs.
- No writes, migrations, or changes to existing user data are part of the contract definition.

**Result:** Contract and focused tests added. All 10 `nip-domain` unit tests pass in an isolated temporary crate. The normal workspace command is blocked before compilation by an existing dependency-resolution conflict (`riga-server` pins `rmcp=2.0.0`; the fina-scraper dependency pins `rmcp=2.2.0`). The pinned Rust toolchain is installed. This conflict and the remaining integration work are recorded, not hidden. The test helper's isolated crate was created under `/tmp` only.

### Phase 2A — Move acquisition storage initialization and inventory under NIP

**Work:** Move storage initialization behind NIP using the existing `fina-scraper init` CLI as a subordinate subprocess, rather than linking the scraper crate into either Tauri or nip-engine. Direct crate linkage pulls its optional `rmcp=2.2.0` into the workspace and conflicts with RIGA's `rmcp=2.0.0` pin. NIP startup initializes the existing compatible lake layout and derives site/feed inventory itself. Tauri resolves the worker binary and passes its path to NIP; it does not initialize scraper storage or forward a second copy of inventory. This subphase does not invoke legacy acquisition run APIs or change existing UI routes.

**Exit criteria:**
- Tauri has no direct `fina-scraper` crate dependency and no scraper storage initialization/inventory forwarding; it only resolves the subordinate binary path.
- NIP invokes only the idempotent storage-init CLI, with a cleared/minimal child environment; no legacy acquisition writer tools are enabled.
- NIP initializes acquisition storage and populates ownership only from values discovered in that lake; legacy launcher inventory variables are no longer parsed.
- Temporary-root initialization is repeatable and yields stable inventory; existing source/feed ownership guards remain tested.
- `NIP_LAKE_DIR` and derived `_nip` remain unchanged; no data is migrated, rewritten, or deleted.

**Status:** Phase 2A is implemented. NIP starts the bundled/resolved `fina-scraper init` executable with a cleared environment containing only the lake path and `PATH`, then validates the returned inventory. Tauri no longer links the scraper crate, initializes the lake, or supplies site/feed ownership. The process boundary avoids pulling the scraper's optional `rmcp=2.2.0` into the workspace, where it conflicts with RIGA's pinned `rmcp=2.0.0`.

**Verification:** `cargo test -p nip-engine` passes (132 library tests and 14 binary tests); a real `fina-scraper init` run against a fresh temporary lake returned valid JSON and the same 22 site/feed identity records on repeat initialization. Rust formatting, `git diff --check`, the E2E launcher's Node syntax, and Tauri config JSON checks pass. A full Tauri crate compile/package check was not run because sandbox disk usage reached 93%; no user data or unrelated worktrees were removed. Existing data roots were not changed.

### Phase 2B — Supervise one worker lifecycle from NIP

**Work:** NIP owns worker process startup, health, cancellation/shutdown, and product-visible job state. The desktop should not start a peer scraper MCP on the normal path. Preserve a separately named diagnostic path only while existing UI/API compatibility requires it. Do not enable legacy scraper run tools as product operations: they persist worker-owned outputs and cannot yet return the typed `AcquisitionBatch` without side effects.

**Exit criteria:**
- NIP owns the worker process and shutdown/error handling; worker health/unavailable state is surfaced through NIP.
- Normal product launch has one narrative entry point; any temporary compatibility/diagnostic process is explicitly labeled and cannot write canonical NIP data.
- Temporary-root startup, early-exit, shutdown, and safe reuse tests pass.
- Legacy acquisition calls remain disabled from the product surface until the worker returns a validated typed batch for NIP ingestion.
- `NIP_LAKE_DIR` and derived `_nip` remain unchanged; the phase does not migrate, rewrite, or delete existing data.

**Status:** Implemented in the working tree. `nip-engine` now resolves the subordinate
`fina-scraper` binary, starts `mcp --transport stdio`, completes the MCP initialize
handshake, retains the child for the NIP process lifetime, reports ready/early-exit/stopped
state through `acquisition_worker_status` and the HTTP health response, and kills/waits for
the child during teardown. The supervisor exposes no generic scraper tool-call method, so
legacy run/backload writes remain outside the NIP product surface. Standalone scraper MCP
launchers remain compatibility/diagnostic paths only.

**Focused verification:** The temporary-root supervisor tests cover typed startup and safe
reuse, early-exit reporting, and idempotent shutdown. `git diff --check` passes. Full Rust
format/test execution is pending a compatible Rust toolchain in this sandbox: the installed
Cargo 1.75 rejects the repository's pinned edition-2024 RIGA submodule before compiling
`nip-engine`, and `rustfmt` is not installed. No lake data was migrated, rewritten, or
deleted.

### Phase 3 — Make source identity and schedule intent NIP-owned

**Work:** Build explicit NIP-source-to-worker-profile bindings; make NIP source identity, rights, product lifecycle and schedule intent canonical. Worker profile contains only adapter/extraction implementation details. Match existing entries by explicit mapping and canonical URL/type evidence; ambiguous entries stay unresolved/read-only.

**Exit criteria:**
- Each configured acquisition site maps to one NIP source; no source is created just because a worker profile exists.
- Schedule CRUD/pause/resume/trigger is NIP API only; there is one poll/execution path.
- Rights and consent gates are not inferred from scraped registration.
- Existing DuckDB source/subscription rows and scraper YAML/schedules remain readable and unchanged; compatibility mapping is test-backed.

**Status:** Phase 3 ownership plumbing is implemented in the working tree. NIP now retains the
full worker profile inventory, exposes a read-only `list_acquisition_source_bindings` report,
and resolves a binding only when one NIP source has the same canonical feed locator and
compatible `podcast` kind. Worker site IDs never become NIP source IDs, worker profiles never
create NIP sources, and missing/ambiguous matches remain explicitly unresolved. Source
lifecycle, subscription state, poll interval, refresh, and manual trigger operations remain
NIP APIs; the only process-lifetime scheduler is NIP's in-process scheduler, which reads NIP
subscription state and never starts or mutates the scraper scheduler.

**Data gate:** The implementation does not invent mappings for worker profiles that lack a canonical locator. A forward-only NIP migration now stores explicit binding review records in `nip_acquisition_bindings`; bind requires an observed worker profile, compatible `podcast` kind, exact canonical feed locator, an existing active NIP source, approved source rights, a non-empty reviewer, and explicit user confirmation. Unbind is also explicit and audited. Listing merges derived evidence with reviewed records and marks stale evidence unresolved rather than silently retaining authority. Existing DuckDB source rows and scraper YAML/schedules were not changed.

**Focused verification:** Added persistent upsert/unbind review coverage, strict MCP bind/unbind
parameters, and the binding ownership/error paths. `git diff --check` and the E2E launcher's
Node syntax check pass. Full Rust execution remains blocked before compilation by the sandbox
Cargo 1.75/edition-2024 limitation recorded under Phase 2B; `rustfmt` is unavailable.

### Phase 4 — Canonical item/event/transcript ingestion

**Work:** Add a scraper-specific NIP ingestion operation for one rights-approved NIP source and one worker item. NIP validates source binding, timestamps, hash, payload, and idempotency before committing the canonical NIP event/transcript. Keep worker site/item/run identity namespaced.

**Exit criteria:**
- A fixture item becomes one canonical NIP record, retains the exact hash/text/source identity/run/provenance and live-versus-reconstructed status.
- Exact replay is a no-op; a changed body for an existing source-native identity is explicitly rejected or recorded as a tested NIP revision—never silently overwritten.
- Missing/unapproved source, URL mismatch, collision, malformed metadata, and wrong hash yield zero partial writes.
- Existing event quote validation and podcast workflow tests still pass.

**Constraint:** Do not bulk-import the lake or change the semantics of `import_local_event` as a shortcut.

### Phase 5 — Canonical claims, entities, and features

**Work:** Attach worker claims to the canonical NIP event; preserve structured subject/predicate/object, native claim ID, exact quote and character offsets, supersession/version, review/tier, availability and producer metadata. Define NIP entity mention/resolution and feature-definition contracts before accepting worker values.

**Exit criteria:**
- Every accepted claim's evidence exactly matches the canonical retained payload; no tier/review upgrade occurs.
- Entity mentions retain source evidence and are not conflated with unresolved-agent candidates.
- Feature values use registered NIP keys and preserve as-of/valid-time/live/reconstructed/run/model metadata.
- Duplicate/changed claim versions and feature replay are idempotent or rejected under explicit tested policies.

### Phase 6 — One NIP-facing UI and tool surface

**Work:** Route Narrative components and external agent tools through NIP APIs. Show worker jobs/status/results as NIP-owned workflow state. Remove product-facing dual-registry/dual-schedule presentations and direct scraper writes after equivalent NIP operations exist. Preserve compatibility reads behind NIP.

**Exit criteria:**
- Product UI and external-agent tools have one source/evidence lifecycle API.
- No UI or tool can mutate NIP and scraper stores as competing authorities or silently fall back between them.
- Sources, schedules, search, radar, entities, thesis, evidence and video journeys continue to work with origin/provenance visible.
- Playwright setup/evidence/commentary-video journeys and targeted worker-unavailable tests pass.

### Phase 7 — Reconcile legacy data and choose physical consolidation (separate migration project)

**Work:** Inventory legacy Parquet/SQLite/YAML/transcripts and DuckDB records with counts, identities, hashes, versions, rights and readers. Design dry-run import/archive mappings and rollback. Decide whether NIP canonical records use DuckDB plus NIP-managed immutable files/Parquet or another representation, preserving point-in-time semantics.

**Exit criteria:**
- User receives a migration proposal with dry-run counts/hash reconciliation, backups, rollback, downtime, retention/archive choice, and explicit approval before any mutation.
- Legacy rows are either imported losslessly, kept as read-only/archive compatibility data, or retired only after proven parity and approval.
- No one-store claim is made unless physical authority and readers actually converge.

**No migration is authorized or performed by Phases 0–6.**

## Global invariants and test policy

- NIP is the sole product-facing authority. At most one canonical NIP record exists for each accepted concept/identity; worker runs do not become a second product catalog.
- Preserve source rights, consent, audit, extraction tier/review, source/run lineage, content hashes, revisions, exact evidence spans, publication/ingestion/valid-time, as-of, and live/reconstructed semantics.
- No automatic copy, move, rewrite, backfill, or delete of user data. No broad cleanup or submodule reset. The pre-existing `modules/riga` worktree modification is unrelated and remains untouched.
- Keep `TAC_LAKE_DIR` separate. Keep the NIP root selection policy unchanged until a dedicated storage phase.
- Test fixtures and temporary stores only. Avoid live provider credentials and production source probes.
- At every phase gate, stop and report exact files/changes, tests (including blocked/unverified gates), data-safety status, and the next-phase handoff prompt. Do not commit or push without the user's explicit confirmation at that gate.

## Phase-gate handoff prompt

> **Next phase: Phase 2 — NIP-owned worker lifecycle.** Move the fina-scraper integration seam from the Tauri shell into nip-engine, make NIP supervise exactly one acquisition worker lifecycle, remove the normal-launch peer scraper MCP path only after the NIP worker path has health/shutdown coverage, and add temporary-root lifecycle tests. Do not migrate, rewrite, or delete any existing data. Preserve the pre-existing `modules/riga` submodule worktree modification. Before continuing, ask whether the user wants this completed phase committed and pushed; do not do so without explicit approval.
