# 49 — Merge fina into riga: retire the demo transports, port the charts

**Status:** PLAN — execute phase by phase. Each phase is one commit and must pass
its **exit gate** before the next phase starts. No phase may be skipped.

**Goal:** make **riga-flow the single product surface** and retire the demo
transport stack (`fina-cli`, then `fina-mcp` + `fina-server`) — without touching
riga-flow's performance-critical compute.

**Owner decision recorded here:** *"I don't want to maintain fina-server/cli/mcp
if riga-flow can cover them all, while I see many charts from fina are not
available in riga-flow, which I want available for riga too."*

---

## 1. What is actually being merged (and what is not)

The demo stack is **one kernel + three transports**; they are not three feature
sets:

| Layer | Contents | Consumed by | Merge action |
|---|---|---|---|
| **Kernel** | `crates/fina-kernel` (deterministic demo engine, 12 commands) | in-process by `src-tauri`; via `fina-server` in browser mode; via `fina-mcp` for external MCP clients | **Freeze** (P6) — keeps the parity golden |
| **Transports** | `fina-cli`, `fina-mcp`, `fina-server` | CI/release, external MCP, browser backend | **Retire** (P1, P5) |
| **UI tiles** | ~40 demo-group tiles | the workspace | **Port to riga** (P2), then **retire the lane** (P4) |
| **Engine features** | `compute_trade_analytics` (trade-parameter sensitivity) | 3 Trade-Design tiles | **Rebuild batched on riga** (P3) |

Command parity (already established): **11 of `fina-kernel`'s 12 commands already
have a riga-mcp equivalent**; only `compute_trade_analytics` has none.

---

## 2. Non-goals and hard guardrails (the performance doctrine)

riga-flow's speed depends on `riga-engine`: a trace-gated no-allocation hot loop
(`note.rs`), SIMD (`simd.rs`), optional CUDA (`gpu.rs`, `cfg(feature="gpu")`),
QMC (`qmc.rs`), and the block-cache scheduler (`riga-scheduler`). Therefore:

- **G1 — Never merge fina *code* into riga.** No `jsnum`/`dates`/demo-RNG, no
  scenario-forcing path synthesiser, no transport code enters `riga-*`. The
  "two systems must not be merged (40 §3)" invariant stands.
- **G2 — Never touch the hot path in a UI/tile phase.** `note.rs`, `simd.rs`,
  `gpu.rs`, `qmc.rs`, `pathcube.rs`, `riga-scheduler` must show **zero diff** in
  P2/P4 commits.
- **G3 — New engine work is batched and trace-gated.** Any new riga tool must do
  its evaluations in **one call** (mirroring `riga_risk::price_risk_batch`, which
  already does `1 + 4n + 4` CRN-paired valuations), and must return the aggregate
  only when `TraceLevel::Off`.
- **G4 — Additive engine contracts only.** The riga-mcp tool surface is frozen by
  SHA; new tools/params are additive and the SHA is bumped in the same commit.
- **G5 — Demo artefacts are never "fixed" in place.** `gamma ≡ 0`,
  `totalPaths = 100_000` (scaled ×1000), etc. stay exactly as pinned in the
  golden. They may be *replaced* by riga tiles, never edited.

**Answer to "would merging fina into riga impact performance?"** — Retiring
transports: **no**. Porting tiles: **no** (frontend shape work). Adding engine
features: **adds cost only when invoked**; it cannot regress the existing hot
path provided G2/G3 hold. The danger is only violating G1/G2.

---

## 3. Phase gate protocol (applies to every phase)

A phase is **done** only when, from a clean tree:

```sh
npx tsc -b                                  # 0 errors
npm run build                               # exit 0
npx vitest run                              # all pass
cargo test -p fina-kernel                   # (until P6)
cargo build --workspace                     # compiles (until P5)
# engine guard (submodule)
cargo test --manifest-path modules/riga-flow/Cargo.toml -p riga-engine
cargo test --manifest-path modules/riga-flow/Cargo.toml -p riga-mcp -- --test-threads=1
```

…**and** every phase-specific exit criterion in §4 is checked. Record the command
output in the commit message. One phase = one commit (docs + code together where
they change together).

---

## 4. Phases

### P0 — Plan + baseline freeze
**Entrance:** `main` green; `riga-engine` unmodified since the last release.
**Changes:** this document only.
**Baseline (2026-10-18):** `tsc` 0 · `build` exit 0 · `vitest` 40 files / 225
tests · `cargo test -p fina-kernel` 273 passed (2 ignored) · `cargo build
--workspace` exit 0 · `riga-engine` 43 passed · `riga-mcp` 9 passed.
**Exit:**
- [x] `docs/49-merge-fina-to-riga.md` present and reviewed.
- [x] Baseline recorded above (verbatim gate output in the commit body).
- [x] `git diff --stat` for the phase touches **only** `docs/`.

### P1 — Retire `fina-cli` (immediate)
**Entrance:** P0 exit met.
**Changes:**
- remove `"crates/fina-cli"` from `[workspace] members` in the root `Cargo.toml`;
- delete `crates/fina-cli/` (binary + its `tests/cli.rs`);
- `.github/workflows/ci.yml`: drop `-p fina-cli` from the `cargo test` step;
- `.github/workflows/release.yml`: delete the `cli` job, remove it from
  `release-publish`'s `needs`, and update the header job list;
- `scripts/gate-coverage.py`: drop the `fina-cli` threshold + path mapping;
- note the retirement in `FEATURES.md` (command-surface section).
**Exit (verified 2026-10-18):**
- [x] **No build/runtime reference remains:**
      `grep -rn "fina-cli\|fina_cli" Cargo.toml Cargo.lock .github scripts src-tauri src package.json`
      → nothing. (`FEATURES.md` keeps one explicitly-marked *retired* entry plus Part II
      history; those are not build/runtime references.)
- [x] `cargo metadata --no-deps` members = `fina-kernel, fina-server, fina-mcp,
      payoff-explorer` → no `fina-cli`; `crates/fina-cli/` deleted.
- [x] `cargo build --workspace` → exit 0 (lockfile refreshed, no `fina-cli`).
- [x] `cargo test -p fina-server` 9 passed · `cargo test -p fina-kernel` all pass.
- [x] Gate commands: `tsc` 0 · `build` 0 · `vitest` 40 files / 225 tests.
- [x] Engine guard unchanged: `riga-engine` 43 passed · `riga-mcp` 9 passed, **no
      riga-flow diff** (transport-only phase).

### P2 — Port the demo charts as riga tiles (frontend only)
Sub-phases, each its own commit, each **zero engine diff** (G2):
- **P2a** Monte Carlo diagnostics (10 demo tiles) ← `get_mc_diagnostics` + `get_distributions`
- **P2b** Distribution Analysis (3) ← `get_distributions`
- **P2c** Cashflow & PnL (5) ← `build_cashflows`
- **P2d** Path / cube / payoff-graph (Path Analysis 4) ← `query_path_cube`, `get_path`, `replay_path`
- **P2e** Market & Risk (5) ← `risk_batch`, `get_market`, `scenario`
- **P2f** Valuation Explainability (7) ← `valuation_explain`
- **P2g** Payoff Analysis + execution timeline/events ← `explain_pv_attribution`, `get_ledger`, `execution_events`

Per sub-phase **entrance:** the riga tool it consumes exists and is in the
recorded transcript.
Per sub-phase **exit:**
- [ ] the new riga tile(s) are registered (`catalog.ts`, `TileRenderer.tsx`,
      `TileTypes`) and render without throwing (`TileRenderer.test.tsx` count
      increases).
- [ ] one behaviour test per new tile asserts it renders populated data from the
      transcript.
- [ ] `git diff --stat` shows **no** file under `modules/riga-flow/crates/riga-engine`
      or `riga-scheduler` (G2).
- [ ] the six gate commands pass.
- [ ] Appendix A row(s) marked **ported**.

### P3 — Trade Design on the real engine (`compute_trade_analytics` replacement)
**Entrance:** P2 complete; the 3 demo tiles still have no riga source.
**Changes:**
- add a **batched** trade-parameter bump tool to `riga-risk` + `riga-mcp`
  (CRN, one call, `TraceLevel::Off` ⇒ aggregate only) — mirroring
  `price_risk_batch` (G3);
- bump the frozen tool-schema SHA in the same commit; re-record the transcript;
- add the 3 riga Trade-Design tiles (`EconomicsImpactSummary`, `SensitivityTornado`,
  `ParameterImpactMatrix`) against it.
**Exit:**
- [ ] `cargo test -p riga-risk -p riga-mcp` incl. a new test: the batch is
      CRN-consistent and **one call** powers all bumps (assert call count = 1).
- [ ] trace-off path test: `TraceLevel::Off` returns the aggregate without
      per-bump detail.
- [ ] `git diff --stat` shows **no** change to `note.rs`/`simd.rs`/`gpu.rs`/`qmc.rs` (G2).
- [ ] the 3 tiles render populated data; the six gate commands pass.

### P4 — Retire the demo UI lane
**Entrance:** every demo-group tile in Appendix A is **ported**.
**Changes:** remove the demo bundle from the tile path — no tile imports
`useSimulationStore` / `useSelectedPath` / `src/api`; remove the demo-group
catalog entries and `TileRenderer` cases; remove or force the `rigaSource`
toggle (lane labels + stand-down from docs/46/48 become moot); remove the demo
trade/market side-panels.
**Exit:**
- [ ] `grep -rn "useSimulationStore\|useSelectedPath" src/features --include=*.tsx`
      returns only non-tile infrastructure kept for tests (or nothing).
- [ ] `TILE_CATALOG` contains **no** demo-group tile.
- [ ] `npx vitest run` passes with the demo tile tests removed/adjusted.
- [ ] the six gate commands pass (frontend + kernel; riga guard unchanged).

### P5 — Retire `fina-server` + `fina-mcp`
**Entrance:** P4 complete (nothing in the shipped app uses the demo lane).
**Changes:** remove `crates/fina-server`, `crates/fina-mcp` from the workspace;
delete the crates; drop `scripts/build-mcp-sidecar.sh` + its CI/release wiring;
point browser mode at `riga-mcp --transport http` (already proxied at
`/riga/mcp`); remove `fina-server`/`fina-mcp` from `ci.yml`, `release.yml`,
`gate-coverage.py`; update `package.json` (`backend:dev`), `FEATURES.md`.
**Exit:**
- [ ] `cargo metadata --no-deps` lists only `fina-kernel` (+ `src-tauri`) from the demo side.
- [ ] `grep -rn "fina-server\|fina-mcp\|fina_server\|fina_mcp" Cargo.toml package.json .github scripts src-tauri`
      returns **only** this plan document.
- [ ] `npm run dev` + `riga-mcp --transport http` serves the app end to end.
- [ ] the six gate commands pass (minus the `fina-server` test).

### P6 — Freeze `fina-kernel` as the parity witness
**Entrance:** P5 complete; nothing at runtime depends on `fina-kernel`.
**Changes:** keep `crates/fina-kernel` + `golden.json` + parity tests; add a
deprecation banner to its `lib.rs` and a `FEATURES.md` note that it is a frozen
migration/parity artefact, not a product dependency; ensure it is not a
dependency of any shipped binary.
**Exit:**
- [ ] `cargo tree -p fina-kernel --workspace`/`grep` shows no runtime crate depends on it.
- [ ] `cargo test -p fina-kernel` still passes (parity preserved).
- [ ] `FEATURES.md` + `crates/fina-kernel/src/lib.rs` state the frozen status.

---

## 5. Appendix A — demo → riga coverage matrix

Status legend: **riga-ready** (data already exposed) · **ported** (P2 done) ·
**engine** (needs P3) · **n/a**.

| Demo group (tiles) | riga data source | Status |
|---|---|---|
| Monte Carlo Diagnostics (10) | `get_mc_diagnostics` | riga-ready |
| Distribution Analysis (3) | `get_distributions` | riga-ready |
| Cashflow & PnL (5) | `build_cashflows` | riga-ready |
| Path Analysis (4) | `query_path_cube`, `get_path`, `replay_path` | riga-ready |
| Market & Risk (5) | `risk_batch`, `get_market`, `scenario` | riga-ready |
| Valuation Explainability (7) | `valuation_explain` | riga-ready (Taylor; PLVA folded) |
| Payoff Analysis (2) | `explain_pv_attribution`, `get_ledger` | riga-ready |
| Execution Timeline / Events (2) | `execution_events` | riga-ready |
| Settlement / Payoff Evaluation / Observation Events (3) | ledger + branch stats | riga-ready |
| **Trade Design (4)** | **— none —** | **engine (P3)** |

---

## 6. Risks and rollback

| Risk | Mitigation |
|---|---|
| A tile port sneaks a hot-path change | G2 check (`git diff --stat` on `riga-engine`) in every phase gate |
| New engine feature slows pricing | G3 (one batched call, trace-gated) + a call-count test |
| Frozen tool-schema SHA breaks CI | additive change + SHA bump + transcript re-record in the same P3 commit |
| Removing `fina-cli` breaks release | P1 exit greps every reference; `cargo build --workspace` gate |
| Deleting `fina-server`/`fina-mcp` too early | gated behind P4 (no demo-lane consumer) |
| Losing the migration witness | P6 **freezes** `fina-kernel` + golden; never deleted |

Rollback: each phase is one commit; revert it. Nothing in P1–P5 alters
`fina-kernel`'s numbers, so the parity baseline survives any single revert.
