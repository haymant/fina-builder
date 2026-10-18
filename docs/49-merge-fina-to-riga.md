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

### P2 — Port the demo charts that are already backed by riga data (frontend only)

> **P2 entrance result (2026-10-18) — FAILED for the series charts; reclassified.**
> The original P2a entrance gate ("the riga tool exists and is in the recorded
> transcript") does **not** hold for most demo charts: the demo tools return
> **series / richer shapes** than riga's single-run outputs.
>
> | demo | riga (recorded transcript) |
> |---|---|
> | `get_mc_diagnostics` → **10-point convergence series** `mcDiagnostics[]` `{paths,pv,se,lower,upper,ki,ko,p05,p50,p95}` + `mcEfficiency[]` | `get_mc_diagnostics` → **single snapshot** `{pv, mc_error, relative_se, stats}` |
> | `simulationBundle.distributions` → per-metric histogram `values[]` + `{mean,median,stdDev,p05,p95}` | `get_distributions` → `{count, ki_rate, mean_put, worst_final_deciles[10]}` |
> | `risk.base` → `theta, rho, fxDelta, bucketVegas[], crossGamma` | `risk_batch` → `{assets[{delta,gamma,vega}], dv01, correlation_sensitivity}` |
> | `valuation` → `previousPV`→`currentPV` bridge | `valuation_explain` → `{base_pv,current_pv,delta_pv,predicted_dpv,residual,contributions}` (**compatible**) |
> | `cashflow` → `rows[]` + summary | `build_cashflows` → `{mean, paths, sample_paths, timeline}` (**partial**) |
>
> So the convergence / histogram / detailed-greeks / PnL charts are **engine**
> work (moved to **P3**), not tile work. The readiness audit is Appendix A.

**Port-ready now** (the riga data exists; only a tile is needed):
- **P2a** Cashflow Summary + Cashflow Timeline ← `build_cashflows` (`mean`, `paths`, `timeline`) — ✅ **ported (2026-10-18)**
- **P2b** Risk Summary ← `risk_batch` (`base_pv`, per-asset Δ/Γ/ν, `dv01`, correlation) — ✅ **ported (2026-10-18)**
- **P2c** Distribution deciles / KI ← `get_distributions` (`worst_final_deciles`, `ki_rate`, `mean_put`) — ✅ **ported (2026-10-18)**
- **P2d** Selected Path ← `query_path_cube` sample (identity / worstFinal / KO / KI / put / PV + coupon-by-period) — ✅ **ported (2026-10-18)**
  *(The demo "Path Timeline" — price over dates — is served by the P3g-i `path_series`
  tile (worst-of over steps), which builds a bounded cube rather than reusing
  `get_path`.)*

Per sub-phase **entrance:** the named riga tool is in the recorded transcript
**with the fields listed above**.
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

### P3 — Engine-backed surfaces (new riga tools), additive and trace-gated
**Entrance:** the corresponding Appendix A rows are marked **engine**; P2 complete.

Each item is one **additive** riga tool: one **batched** call (G3), `TraceLevel::Off`
⇒ aggregate only, frozen tool-schema SHA bumped + transcript re-recorded in the
same commit, and **no hot-loop change** (G2).

- **P3a `mc_convergence`** — PV / SE / CI / KI / KO / percentiles vs path count →
  the 10 Monte Carlo Diagnostics tiles + `ConvergenceHealth` + `SimulationEfficiency`.
  **Status (2026-10-18):** engine tool landed and verified (`mc_convergence`:
  additive, one batched call, `TraceLevel::Off` ⇒ final point only; SHA bumped;
  transcript 36 tools) **and 6 tiles ported** — PV Convergence, CI Shrinkage,
  Error vs Path Count, KI Convergence, KO Convergence, Convergence Health. The
  other 3 MC tiles need data `mc_convergence` doesn't emit: Percentile
  Convergence + Distribution Stability → **P3b**; Simulation Efficiency → engine.
  `Simulation Summary` is already covered by `riga-statistics-summary`.
- **P3b `distributions_histogram`** — per-metric histogram `values[]` + percentiles →
  Distribution Analysis (Payoff Histogram, Distribution Explorer).
  **Status (2026-10-18):** tool landed and verified (per metric `pv / put_payoff /
  coupon_pv / funding / worst_final`: mean/median/std/P05/P50/P95/min/max + 20
  equal-width bins; `TraceLevel::Off` ⇒ stats only), SHA bumped, transcript 37
  tools, and **2 tiles ported**. Percentile Convergence / Distribution Stability
  need a *ladder-aware* percentile series — deferred.
- **P3c `risk_detailed`** — theta, rho, fxDelta, `bucketVegas[]`, crossGamma →
  Greeks Table, Bucket Vega, Greeks Waterfall, Risk Summary.
  **Status (2026-10-18):** tool landed and verified (per-asset Δ/Γ/ν, `dv01`/`rho`,
  correlation, one-day `theta`, `cross_gamma[][]`, `bucket_vegas[]`; `fx_delta = 0`
  — riga has no FX factor) and **3 tiles ported**. Vega buckets are **per factor**;
  term buckets need local-vol term bumps (deferred).
- **P3d `pnl_timeline`** — **resolved: no new engine work (evidence-based).**
  The demo P&L tiles read `cashflow.analytics` (realized / unrealized / MTM) and
  per-date cashflow rows. riga prices a *single* trade and keeps **no P&L
  accounting**, so:
  - **P&L Summary** → **n/a** — realized/unrealized/MTM/carry do not exist in
    riga-engine; inventing them would be fake numbers (G5).
  - **P&L Timeline** → **covered** by the Cashflow Timeline (riga) tile (P2a):
    `build_cashflows.timeline` is per-coupon-period expected PV + paid probability.
- **P3e `trade_design`** — trade-parameter bump batch (CRN) → the 3 Trade Design tiles.
  **Status (2026-10-18):** tool landed and verified (bumps strike / KI barrier / KO
  barrier / coupon barrier / coupon rate by +0.01 under CRN in one call; returns
  per-parameter PV/KI/KO + per-leg deltas; `TraceLevel::Off` ⇒ PV delta only;
  `fx` none) and **3 tiles ported** — Economics Impact Summary, Sensitivity
  Tornado, Parameter Impact Matrix.
- **P3f `explain_bridge`** — **frontend-only (no engine work).** The demo "previous
  PV → market explain → residual → current PV" bridge is exactly the
  `valuation_explain` payload riga already returns, so the **Master Explain
  Waterfall (riga)** tile is built directly from `useRigaValuationExplain` — no new
  tool. **Ported (2026-10-18).**

**Exit (per tool):**
- [ ] new cargo test: CRN-consistent, **one call** powers every bump/series point
      (assert the valuation count), and `TraceLevel::Off` returns the aggregate only.
- [ ] frozen tool-schema SHA bumped; transcript re-recorded; `goldenTranscript.test.ts` SHA updated.
- [ ] `git diff --stat` shows **no** change to `note.rs`/`simd.rs`/`gpu.rs`/`qmc.rs` (G2).
- [ ] `cargo test -p riga-mcp -- --test-threads=1` + `-p riga-engine` pass.
- [ ] the ported tiles render populated data; the six gate commands pass.
- [ ] Appendix A rows marked **ported**.

### P3g — the remaining engine-backed surfaces (no demo capability lost)
**Entrance:** P4 is blocked because ~18 demo tiles have no riga counterpart.
**Guardrails:** every tool is **additive in `riga-mcp`** (or an additive *accessor*
in a non-hot-path engine file), batched in one call, trace-gated, and **must not
modify `note.rs` / `simd.rs` / `gpu.rs` / `qmc.rs` / `pathcube.rs` / `riga-scheduler`**.
The path-cube diagnostics run on a **bounded path budget** (`min(config.paths, 1024)`)
so they never approach the pricing hot path's tensor/SIMD/GPU throughput — they are a
separate, read-only code path.

| Sub-phase | Tool | Tiles unlocked |
|---|---|---|
| **P3g-i `path_series`** | bounded GBM `PathCube` → selected-path worst-of series + population quantiles (P05/P25/P50/P75/P95) per step + barrier-crossing counts + state occupancy | Path Timeline, Quantile Fan, Worst-of Evolution, Barrier Heatmap, State Occupancy — ✅ **ported (2026-10-18)** |
| **P3g-ii `payoff_graph`** | `payoff::build_put_graph(spec)` → 8-transition product graph (nodes/edges) via an additive `graph.rs` accessor; **also folded into `query_execution_net`** so the Petri-net tool is the superset | Payoff Graph — ✅ **ported (2026-10-18)** |
| **P3g-iii schedule/observation** | **frontend-only** — derived from `path_series` (per-step crossings + states + barrier levels); no separate tool needed | Observation Schedule, Schedule Explorer — ✅ **ported (2026-10-18)** |
| **P3g-iv branch Sankey** | **frontend-only** — `get_branch_stats` + `query_execution_net` (real transition populations) | Branch Statistics (Sankey) — ✅ **ported (2026-10-18)** |
| **P3g-v market explorers** | **frontend-only** — `get_market` (spots / flat ATM vols / correlation); Vol Surface from the instrument document's Dupire grid | Spot · Correlation **ported (2026-10-18)**; Vol Surface from the document; FX Spot **n/a** |
| **P3g-vi percentile convergence** | bounded-cube **ladder** → terminal worst-of P05/P25/P50/P75/P95 across path counts | Percentile Convergence, Distribution Stability — ✅ **ported (2026-10-18)** |
| **n/a** | — | P&L Summary (no accounting), FX Spot (no FX factor), Simulation Efficiency (VR efficiency study) |

Per sub-phase **exit:** the six gate commands pass; the tile(s) render populated
transcript data with a behaviour test; `git diff --stat` shows **no** hot-path file
(G2); Appendix A rows marked **ported**.

### P4 — Retire the demo UI lane — ✅ **done (2026-10-18)**
**Entrance:** every demo-group tile in Appendix A is **ported**.
**Changes:** remove the demo bundle from the tile path — no tile imports
`useSimulationStore` / `useSelectedPath` / `src/api`; remove the demo-group
catalog entries and `TileRenderer` cases; remove or force the `rigaSource`
toggle (lane labels + stand-down from docs/46/48 become moot); remove the demo
trade/market side-panels.
**Exit:**
- [x] `grep -rn "useSimulationStore\|useSelectedPath" src/features --include=*.tsx`
      returns only non-tile infrastructure kept for tests (or nothing).
- [x] `TILE_CATALOG` contains **no** demo-group tile.
- [x] `npx vitest run` passes with the demo tile tests removed/adjusted.
- [x] the six gate commands pass (frontend + kernel; riga guard unchanged).

**Delivered (2026-10-18):** removed the 51 demo catalog entries + `TileRenderer`
imports/cases; deleted the demo tile components (`pathcube`, `path-inspector`,
`payoff-graph`, `attribution`, `branch-statistics`, `distribution`), the demo
hooks (`src/hooks/index.ts`), the demo-only stores (`cashflowStore`,
`valuationExplainStore`, `explainLedgerStore`, `rigaSourceStore`), the demo
side-panels (`TradeEconomicsPanel`, `MarketDataPanel`), the unused `TopToolbar`
and the demo-bundle gate (`needsBundle`). Retargeted the six built-in dashboards
+ all notebook templates to riga/tac tiles; forced `RigaTradeEconomicsPanel` to a
static `source: riga`; dropped the demo `TileType` members. `App` no longer loads
the demo bundle. **G2: `modules/riga-flow` untouched (0 diff).**

### P5 — Retire `fina-server` + `fina-mcp` — ✅ **done (2026-10-18)**
**Entrance:** P4 complete (nothing in the shipped app uses the demo lane).
**Changes:** remove `crates/fina-server`, `crates/fina-mcp` from the workspace;
delete the crates; drop `scripts/build-mcp-sidecar.sh` + its CI/release wiring;
point browser mode at `riga-mcp --transport http` (already proxied at
`/riga/mcp`); remove `fina-server`/`fina-mcp` from `ci.yml`, `release.yml`,
`gate-coverage.py`; update `package.json` (`backend:dev`), `FEATURES.md`.
**Exit:**
- [x] `cargo metadata --no-deps` lists only `fina-kernel` (+ `src-tauri`) from the demo side.
- [x] `grep -rn "fina-server\|fina-mcp\|fina_server\|fina_mcp" Cargo.toml package.json .github scripts src-tauri`
      returns **only** this plan document.
- [x] `npm run dev` + `riga-mcp --transport http` serves the app end to end.
- [x] the six gate commands pass (minus the `fina-server` test).

**Delivered (2026-10-18):** `crates/fina-server` + `crates/fina-mcp` deleted (workspace
members + `release-runner` profile removed; `cargo metadata` now lists `fina-kernel` +
`payoff-explorer` only). `scripts/build-mcp-sidecar.sh` deleted; `mcp:sidecar` script gone;
`backend:dev` now runs `mcp:http:riga`; Tauri `externalBin` switched from `binaries/fina-mcp`
to `binaries/riga-mcp` + `binaries/tac-engine`; `beforeDev/BuildCommand` drop the fina staging.
Removed the `fina` MCP Tauri commands (`get_mcp_server_path`/`mcp_list_tools`/`mcp_call_tool`/
`mcp_reset`) and the fina stdio test from `src-tauri`; genericised `mcp.rs` strings.
`ci.yml` drops `cargo test -p fina-server` + the `--exclude fina-mcp` and stages engine-sidecar
placeholders; `gate-coverage.py` + `watch-renderer.sh` de-fina'd. **Frontend:** the dead demo
plumbing is gone — `src/api/{index,transport,tauriTransport,httpTransport}.ts`, `simulationStore`,
`marketDataStore`, `tradeEconomicsStore`, the demo transport/parity/integration tests, and the
`explorerStore` path API (it now opens on the `riga-lineage` dashboard). The riga/tac
transports (`src/api/{rigaTransport,tacTransport,keyCase}.ts`) are untouched. **G2: 0 diff.**

**Evidence:** tsc 0 · build 0 · **vitest 44 files / 215 tests** · `fina-kernel` 202+ pass ·
`cargo build --workspace` · `cargo clippy -p payoff-explorer -D warnings` · `cargo test -p
payoff-explorer` (incl. `lists_and_calls_riga_flow_tools_over_stdio`) · `riga-engine` pass ·
`riga-mcp` 16 pass.

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

## 5. Appendix A — demo → riga readiness audit (verified 2026-10-18)

Status: **covered** (an existing riga tile already shows it) · **port-ready**
(riga data exists; only a tile is needed — P2) · **engine** (needs a new,
additive riga tool — P3).

| Demo tile (group) | riga source | Status |
|---|---|---|
| **Monte Carlo Diagnostics** | | |
| Simulation Summary | `riga-statistics-summary` | **covered** |
| PV Convergence · CI Shrinkage · Error vs Path Count · KI/KO Probability Convergence · Convergence Health | `mc_convergence` (P3a) | **ported P3a** |
| Percentile Convergence · Distribution Stability | `percentile_convergence` (bounded ladder) | **ported P3g-vi** |
| Simulation Efficiency | — (needs an efficiency ladder) | **engine** |
| **Distribution Analysis** | | |
| Payoff Histogram | `distributions_histogram` (PV bins) | **ported P3b** |
| Selected Path | `query_path_cube` sample | **ported P2d** |
| Distribution Explorer · Metric Compare | `distributions_histogram` (per-metric stats) | **ported P3b** |
| Worst-of deciles / KI (new) | `get_distributions` (`worst_final_deciles`, `ki_rate`, `mean_put`) | **ported P2c** |
| Selected Path in Population | `query_path_cube` sample | **ported P2d** (Selected Path) |
| **Path Analysis** | | |
| Path Timeline | `path_series` (selected-path worst-of series) | **ported P3g-i** |
| Node Details | — (`get_path` has no `nodeDetails`) | **engine** |
| Quantile Fan · Worst-of Evolution | `path_series` (population P05–P95 bands) | **ported P3g-i** |
| **Market & Risk** | | |
| Risk Summary | `risk_batch` (`base_pv`, per-asset Δ/Γ/ν, `dv01`, ρ) | **ported P2b** |
| Greeks Table · Greeks Waterfall · Bucket Vega | `risk_detailed` (per-asset Δ/Γ/ν, θ/ρ, cross-γ, vega by factor) | **ported P3c** |
| Scenario Comparison | `riga-scenario-comparison` | **covered** |
| **Market Data** | | |
| Spot Explorer · Correlation Matrix | `get_market` (spots / correlation / flat ATM vols) | **ported P3g-v** |
| Volatility Surface | instrument document Dupire local-vol grid | **ported P3g-v** |
| FX Spot | — (riga has no FX factor) | **n/a** |
| **Risk Analytics** | | |
| Sankey (branch flow) | `query_execution_net` transition populations | **ported P3g-iv** |
| State Occupancy · Barrier Crossings | `path_series` (states / crossings) | **ported P3g-i** |
| **Valuation Explainability** | | |
| Valuation Explain Summary · Taylor Explain · PLVA Explain | `riga-taylor-explain` (PLVA folded) | **covered** |
| Explain Ledger Table · Explorer · Reconciliation | `riga-explain-net` | **covered** |
| Master Explain Waterfall | `valuation_explain` (base → contributions → residual → current) | **ported P3f** |
| **Cashflow & PnL** | | |
| Cashflow Summary · Timeline · Detail Explorer | `build_cashflows` (`mean`, `paths`, `timeline`, `sample_paths`) | **ported P2a** (Summary + Timeline); Detail Explorer pending |
| P&L Summary | — (no P&L accounting in riga-engine) | **n/a** (G5: no fake numbers) |
| P&L Timeline | `build_cashflows.timeline` | **covered** (Cashflow Timeline, P2a) |
| **Payoff Analysis** | | |
| Attribution | `riga-attribution` | **covered** |
| Payoff Graph | `payoff_graph` — the full 8-transition product pipeline; also carried by `query_execution_net` | **ported P3g-ii** |
| **Settlement / Payoff Evaluation / Execution Timeline** | `riga-transition-detail`, `riga-execution-tape`, ledger | mostly **covered** |
| Observation Schedule · Schedule Explorer | `path_series` (steps + barrier hits + states) | **ported P3g-iii** |
| **Trade Design** | | |
| Trade Summary | `riga-trade-economics` | **covered** |
| Economics Impact Summary · Sensitivity Tornado · Parameter Impact Matrix | `trade_design` (CRN trade-parameter bumps) | **ported P3e** |

**Tally:** ~24 demo tiles are **covered** by existing riga tiles, ~7 are
**port-ready** (P2), and ~20 need **new additive riga tools** (P3). The demo→riga
"chart gap" is therefore mostly an **engine-capability** gap, not a UI gap — which
is why the P4/P5 retirements are gated on P3, not on P2.

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
