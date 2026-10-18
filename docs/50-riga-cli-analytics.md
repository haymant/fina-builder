# 50 — `riga-cli` as a first-class MCP analytics client (TUI, markdown-first)

**Status:** PLAN — execute phase by phase. Each phase is one commit and must pass
its **exit gate** before the next starts.

**Goal.** Make `riga-cli` (`modules/riga/crates/riga-cli`) able to start with every
configured MCP server/tool reachable and do the **same riga-flow analytics the
dashboard shows**, but from the terminal, presenting results as **markdown
tables** — with **pre-filled trade/market templates** the user can adjust quickly
in the TUI, and no model required.

Deliverables:
1. `riga-cli` runs with `riga-flow` + `tac-engine` connected; every tool callable.
2. A direct **tool runner** (`/run`), a **JSON → markdown** renderer, and
   **analytics packs** that batch tools into a markdown report.
3. Editable **templates** for trade economics and market data, passed **inline**
   (`request`) so the on-disk fixture is never edited.
4. `skills/riga-flow-dashboard/SKILL.md` refreshed; new `skills/riga-flow-cli/SKILL.md`.
5. New MCP tool(s) only if a pack would otherwise make avoidable round-trips.

**Non-goals.** No change to `modules/riga-flow`'s hot path (`note.rs`/`simd.rs`/
`gpu.rs`/`qmc.rs`/`pathcube.rs`/`riga-scheduler`). No model required for analytics.
No new pricing math — every number comes from an engine tool.

---

## 1. Current state (recon, 2026-10-19)

| Fact | Evidence |
|---|---|
| `riga-cli` is an IPC client of `riga-server` with a Ratatui TUI | `crates/riga-cli/src/{main,app,ui,transport}.rs` (~11.4k lines) |
| It already renders **markdown tables** | `markdown.rs` handles `Tag::Table/TableRow/TableCell` |
| MCP servers/tools are **discovered** and browsable (`/mcp`, `/tools`, `/skills`) | `app.rs` `open_catalog_scope`, `main.rs` `completion_candidates` |
| Both engines are already registered for a repo-root launch | `.mcp.json` → `modules/riga-flow/target/release/riga-mcp --transport stdio`, `modules/tac-engine/target/release/tac-engine` |
| Skills load from `<workspace>/skills/<name>/SKILL.md` (`description:` line) | `riga-server/src/catalog.rs::load_skills` |
| There is **no direct tool invocation** from the TUI | no `/run`; tools are only prompt context for the agent |
| Every riga-mcp fixture tool accepts an inline `request` | docs/46 §8; `fixtureRequestInjection.test.tsx` |
| Catalogues | riga-mcp **42** tools; tac-engine advertises **75** (26 recorded as read-only) |

**The gap** is therefore not connectivity — it is (a) a model-free call path,
(b) JSON→markdown rendering, (c) template-driven input, (d) skill docs.

---

## 2. Design

### 2.1 Layering

```
riga-cli ── IPC ──▶ riga-server ── MCP stdio ──▶ riga-mcp / tac-engine
   │                     │
   │ analytics packs     └── catalog: servers + tools + skills
   ▼
 trade/market template  ── request: {...} ──▶ (inline, never the on-disk fixture)
```

- **One store per axis**: a *trade document* and a *market document* held by the
  CLI; the composed `PriceRequest` is passed as the `request` param of every tool
  call (the same contract the dashboard uses).
- **Presentation is deterministic**: a `json_to_markdown` renderer turns a tool's
  `structuredContent` into markdown (objects → key/value table; arrays of objects
  → table; deep/nested → fenced JSON). No LLM in the path.

### 2.2 Best-practice input (the answer to "how should a user input?")

Three tiers, cheapest first:

1. **Named template + overrides** — `--template termsheet1` (pre-filled worst-of
   Phoenix), then `--set trade.strike=0.60 --set market.vols[0]=0.48`. Scriptable,
   diffable, no UI needed. This is the default for reproducibility.
2. **TUI form** — `/trade` and `/market` open a field editor (the same field
   list the app's `TabularForm` uses), with a **preset row** (Base Case / Defensive
   Phoenix / Aggressive Yield / Deep Barrier) and per-field validation. Enter
   applies; `Esc` reverts.
3. **Raw JSON** — `/trade json` / `/market json` paste the `fina.instrument/v1`
   document. For power users and for importing a Mendix/Murex chunk.

Rules: the **engine is the authority** (a rejected field shows `{code,message}`);
the CLI never invents a default; every report footer cites `run_id` /
`market_snapshot_id`.

### 2.3 Presentation contract

Each analytics pack renders one markdown section per tile-equivalent, so the CLI
and the dashboard read the same:

```
## Pricing
| Field | Value |
|---|---|
| pv | 1.000265 |
| ki_probability | 0.1127 |
```

---

## 3. Phases (entry / exit / evidence)

### P1 — Refresh the dashboard skill
**Entry:** §1 recon above complete.
**Changes:** rewrite `skills/riga-flow-dashboard/SKILL.md` for the **current**
surface: 67 tiles (55 riga-flow + 12 tac), the Petri-net refactor (one source of
truth + source-of-truth layer switch; Risk/Explain Net are *watchers*), the tiles
added since the doc was written (percentile convergence, distribution stability,
observation/schedule, branch flow, market/vol explorers, payoff graph, tac
market-data), and the folded `P&L Attribution`.
**Exit / evidence:**
- [ ] every `TILE_CATALOG` type appears in the skill (a script diff of the 67
      catalog titles against the skill's tile rows returns none missing).
- [ ] no stale rows: no "P&L Attribution" tile row; Risk Net/Explain Net described
      as watchers (no canvas); the net section names the layer switch.
- [ ] `load_skills` parses it (headless `riga-cli --catalog` shows the skill with
      its `description:`).

### P2 — CLI starts with every MCP tool reachable
**Entry:** P1 done.
**Changes:** `riga-cli` headless `--tools` (merged server→tool markdown listing,
with a `--json` variant); a startup **preflight** that reports each configured
server as `connected | unreachable` with the failing binary path; `/mcp` gains a
`status` argument. (`.mcp.json` already registers both engines — no change needed
unless the preflight finds otherwise.)
**Exit / evidence:**
- [ ] `cargo test -p riga-cli` green.
- [ ] `riga-cli --tools` prints `riga-flow` (42) **and** `tac-engine` (75) with
      their tool names, and exits 0.
- [ ] `riga-cli --tools --json` emits the same as JSON; a test pins the shape.
- [ ] preflight output names both servers `connected` when their binaries exist.

### P3 — Model-free tool runner + JSON→markdown
**Entry:** P2 done.
**Changes:** `/run <server>/<tool> [json]` in the TUI and `--call <server>/<tool>
[--json] [--input <file>]` headless; a pure `json_to_markdown(value)` renderer;
results appended to the transcript as markdown (reusing `markdown.rs`).
**Exit / evidence:**
- [ ] unit tests for `json_to_markdown`: scalar/object/array-of-objects/nested/empty.
- [ ] `riga-cli --call riga-flow/price_put` renders a markdown table containing
      `pv` and `ki_probability` (baseline fixture).
- [ ] a tool-level error (`isError`) renders the structured `{code,message}`, not a
      panic; a test covers it.
- [ ] `cargo test -p riga-cli` green.

### P4 — Trade & market templates (inline `request`)
**Entry:** P3 done.
**Changes:** a `TemplateDocument` (trade + market) seeded from
`modules/riga-flow/docs/fixture/termsheet1.json`; `/trade` and `/market` TUI
editors (+ `--template` / `--set` / `--trade-file` / `--market-file`); the composed
`PriceRequest` is injected as `request` into every call.
**Exit / evidence:**
- [ ] `/trade` applies `strike 0.78 → 0.60`; `price_trade` PV **rises** and
      `query_execution_net` probabilities change — both from the **same** inline
      request.
- [ ] a test asserts the request is present on fixture tools and absent on `health`.
- [ ] `--set trade.strike=0.6` (headless) produces the same numbers as the TUI edit.
- [ ] no fixture file on disk is modified (a test compares the fixture hash before/after).

### P5 — Analytics packs (markdown reports)
**Entry:** P4 done.
**Changes:** `/analytics <pack>` + `--report <pack>` for packs:
`pricing` (`price_trade`, `health`), `execution` (`query_execution_net`,
`get_branch_stats`), `risk` (`risk_batch`, `risk_detailed`, `query_risk_net`,
`validate_greeks`), `explain` (`get_ledger`, `valuation_explain`, `pl_explain`),
`convergence` (`mc_convergence`, `percentile_convergence`), `distributions`
(`get_distributions`, `distributions_histogram`), `path` (`path_series`,
`query_path_cube`).
**Exit / evidence:**
- [ ] each pack renders its sections with the recorded fixture baselines
      (`pv=1.000265`, `ki_rate=0.1127`, `dv01`, …).
- [ ] a snapshot test pins the `pricing` + `risk` packs.
- [ ] trace-gated tools are skipped with a note when `trace_level = off`.

### P6 — New MCP tool(s) — only if P5 proves they are needed
**Entry:** P5 done; a pack makes ≥3 round-trips that the engine could batch in one
trace-gated call.
**Candidate:** `analytics_report { request, packs[] }` → markdown-ready sections
(reuses the existing batch internals; aggregate only when `TraceLevel::Off`).
**Exit / evidence:**
- [ ] additive tool; frozen `TOOL_SCHEMA_SHA256` bumped; transcript re-recorded;
      `goldenTranscript.test.ts` updated.
- [ ] `cargo test -p riga-mcp -- --test-threads=1` green; the pack output is
      byte-identical to the P5 multi-call output.
- [ ] `git -C modules/riga-flow diff --stat` shows no hot-path file (G2).
- If **not** needed: record "P6 skipped — N round-trips is acceptable" with the
  measured count.

### P7 — The CLI skill
**Entry:** P6 done (or skipped with a recorded reason).
**Changes:** `skills/riga-flow-cli/SKILL.md` — the commands, flags, templates and
packs, with a worked example per pack; cross-links the dashboard skill.
**Exit / evidence:**
- [ ] `load_skills` parses it; `riga-cli --catalog` lists `riga-flow-cli`.
- [ ] every command/flag in the skill exists (`--help` output diff), no invented flags.
- [ ] the worked examples use real fixture baselines.

### P8 — Verification, docs, release
**Entry:** P7 done.
**Changes:** `docs/48` gains a "TUI analytics" validation section; `docs/50`
statuses land; commit `modules/riga` + the submodule pointer.
**Exit / evidence:**
- [ ] `cargo test -p riga-cli -p riga-server` green.
- [ ] fina-builder six gates green (`tsc`, `build`, `lint`, `vitest`, fmt/clippy,
      `cargo build --workspace`).
- [ ] a real `riga-cli --report pricing --report risk` run against the built engines
      produces the expected tables (transcript pasted into the commit).

---

## 4. Risks & guardrails

| Risk | Mitigation |
|---|---|
| Engine binaries absent → CLI shows zero tools | P2 preflight prints the failing path + the build command; `--tools` exits non-zero. |
| A TUI editor desyncs from the engine's field rules | The engine is the authority: apply → call `price_trade` → surface `{code,message}`; never validate locally beyond shape. |
| Markdown renderer drifts from the app's tables | One shared shape (key/value + records); P5 snapshot tests. |
| Editing the fixture by accident | The CLI is inline-`request` only; P4 asserts the fixture hash is unchanged. |
| Scope creep into `riga-flow` | P6 is conditional and additive; G2 checked every phase. |
