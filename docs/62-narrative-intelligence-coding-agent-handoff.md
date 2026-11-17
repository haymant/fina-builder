# 62 — Narrative Intelligence coding-agent handoff

## Mission

Continue the Narrative Intelligence Platform (NIP) in `/home/ubuntu/fina-builder` without regressing the existing structured-product, TAC, RIGA, trade-repository, or agent-native MCP boundaries. This repository contains the completed Phase 1 foundation, Phase 2 semantic/signals/graph slice, and Phase 3 manual ETF/editorial slice. The next agent must finish only the explicitly gated work below and must preserve DuckDB as canonical truth.

## Verified baseline

- Rust crates: `nip-domain`, `nip-store`, and `nip-engine` are implemented with DuckDB schema v8, Streamable HTTP MCP, stdio MCP, RSS subscriptions, local ASR boundary, claims/evidence, Parquet snapshot/restore, optional Qdrant semantic search, deterministic signals, clusters, evidence-linked graph projection, ETF mappings, editorial review records, configured RIGA provider bridging, and append-only remote-consent audit.
- Frontend: `src/features/narrative/` contains Event Review, Claim Explorer, Radar, Timeline, Graph, ETF Themes, Editorial Planning, subscription/run status, and the Operational Monitor.
- Operational MCP tools: `nip_resource_status`, `nip_extraction_status`, `rebuild_narrative_graph`, and `list_narrative_graph`.
- Resource/extraction UI tests cover populated, loading, empty/unavailable, and degraded-warning states.
- The real narrated journey passes with the disposable NIP service:

```bash
PLAYWRIGHT_NIP=on \
PLAYWRIGHT_NIP_STARTUP_TIMEOUT=600000 \
npm run test:e2e:demo -- --grep @demo-narrative-research
```

- Current expected focused UI result: 15 tests passing. The narrated recording is `playwright/recordings/narrative-intelligence/final.mp4`.
- Plans and evidence: `docs/56-narrative-intelligence-implementation-plan.md` and `docs/57-narrative-intelligence-testing-plan.md`.

## Remaining work, in priority order

### 1. Validate the optional local ComfyUI ASR runtime

The `modules/comfy` pointer is intentionally advanced to the latest checked-out ASR-capable revision. Do not make ComfyUI a Phase 1 hard dependency. Run an opt-in smoke only with synthetic or rights-cleared audio and pre-provisioned weights. Validate Metal/MPS, CUDA/ROCm where available, and CPU fallback according to the current `modules/comfy` documentation. Prove temporary audio and content-bearing ComfyUI history/output deletion on success, failure, timeout, cancellation, and restart. Record workflow/node/model/runtime versions without logging audio or transcript content. Update docs 59/60 and doc 57 with actual evidence; do not claim ASR quality from a connectivity-only check.

### 2. Implement the configured RIGA provider bridge and NIP-specific remote consent

NIP currently uses deterministic fake extraction for tests/demo. The production boundary must resolve the user's existing RIGA-selected local or remote provider/model through a typed host bridge. Never copy credentials into NIP configuration, Vite variables, logs, or repository files. Before remote transcript text/excerpts leave the device, require consent bound to provider profile/model, display what leaves the device, allow revocation, and show pending/unavailable instead of silently falling back. Add loopback tests proving no remote request occurs before consent and that provider/model/prompt provenance is stored per derivation.

### 3. Harden Phase 3 persistence and review audit if needed

Keep ETF mappings and editorial candidates immutable/versioned. Any correction is a new revision or review audit row; do not overwrite source evidence. Preserve separate ticker syntax, ticker existence, market-data coverage, mapping validity, and backtest availability states. Do not implement paper performance, CTR prediction, scalar novelty, or investment recommendations without the approved data/methodology gates in docs 55 and 58.

### 4. Production desktop integration

Integrate the NIP sidecar/IPC lifecycle into the Tauri desktop shell only after preserving the current RIGA/TAC process resolution. Browser development continues through same-origin Vite `/nip/mcp`; browser code must not spawn processes or call private ports directly. Add packaged desktop smoke coverage and restart/recovery checks using user-visible NIP app-data paths.

### 5. Quality and capacity gates

Run the finance retrieval benchmark with a real BGE-M3-compatible local provider before enabling semantic search by default. Compare against DuckDB lexical retrieval, report ranking quality and latency, inspect false positives/negatives, and obtain explicit quality sign-off. Qdrant remains optional, rebuildable, and non-canonical. Do not claim 100M-event capacity or production ASR quality without representative data and measured p50/p95 results.

## Non-negotiable boundaries

- DuckDB is the authoritative ledger. Qdrant is a rebuildable derived index only.
- Every claim, cluster, graph edge, ETF mapping, and editorial candidate must retain immutable source-event evidence.
- Use agent-native stdio and Streamable HTTP MCP conventions.
- Keep source rights, retention, purge, timestamps, and point-in-time semantics explicit.
- Do not use Playwright to bypass provider restrictions or authenticated paywalls.
- Do not modify the dirty `modules/riga` worktree as part of unrelated NIP work. It contains separate uncommitted RIGA edits and must be handled by its owner.
- The parent commit intentionally records the `modules/comfy` submodule pointer update, but not the internal dirty RIGA changes.

## Required verification before handoff completion

```bash
export PATH=/usr/local/rustup/toolchains/1.97.1-x86_64-unknown-linux-gnu/bin:$PATH
export RUSTC=/usr/local/rustup/toolchains/1.97.1-x86_64-unknown-linux-gnu/bin/rustc
cargo fmt --all -- --check
cargo test -p nip-domain -p nip-store -p nip-engine
cargo clippy -p nip-domain -p nip-store -p nip-engine --all-targets -- -D warnings
npm run build
npm run test:run -- src/features/narrative/__tests__ src/features/workspace/__tests__
git diff --check
```

For any new narrated milestone, use the existing demo runner, keep the recording at 1280×720, and update doc 57 with the exact command, result, artifact path, and known non-blocking warnings.

## Completion status — 2026-11-17

- **Item 2 (configured RIGA provider bridge + NIP consent): implemented.** Schema v8 adds append-only `nip_provider_consents`, claim provider provenance, and `nip_editorial_review_audit`. The host bridge is `src-tauri/src/nip_bridge.rs`; NIP config binds `NIP_RIGA_BRIDGE_URL`/`NIP_RIGA_BRIDGE_TOKEN` (loopback-only, token required, redacted `Debug`) and injects them into the `nip` child only. New MCP tools: `nip_provider_status`, `nip_grant_remote_consent`, `nip_revoke_remote_consent`, `extract_claims_from_event`, `list_editorial_review_audit`. Loopback tests prove no request before consent, revocation blocking, model-change rebinding, provenance persistence, and explicit unavailable states. No credential enters NIP config, Vite variables, logs or the repository.
- **Item 3 (Phase 3 persistence/review audit): hardened.** Editorial review corrections append to `nip_editorial_review_audit`; reviewed derivation runs cannot be regenerated in place; ETF revisions must reference an existing same-narrative/ticker mapping and extend its supersession chain exactly one version.
- **Item 4 (production desktop integration): partially verified.** The host bridge starts in Tauri setup, the NIP-only environment is injected per server, and restart tests confirm token rotation and non-leakage. A packaged desktop smoke and installed-build restart/recovery run remains unexecuted.
- **Item 1 (ComfyUI ASR) and item 5 (real BGE-M3 benchmark): still blocked.** No local ComfyUI runtime, ASR node, weights or accelerator/CPU runtime is available; only the deterministic 8-dim fixture benchmark exists. Neither quality nor 100M-event capacity is claimed.
- Gate evidence is recorded in doc 57. `cargo fmt --all -- --check` fails only in the untouched vendored `modules/riga` checkout; the focused formatter, NIP crate tests/clippy, `payoff-explorer` tests/clippy, focused frontend tests, production build, and `git diff --check` all pass.
