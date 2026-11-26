---
name: fina-scraper-thesis-backtest-video
description: Make a thesis from a fina-scraper deep dive, backtest it with fina-builder Qlib tools, and write an evidence-linked commentary transcript for fina-builder video. Use when an agent must turn narrative evidence into a falsifiable thesis, test it with Qlib, and produce a transcript whose every beat cites claims and backtest results.
---

# Thesis → backtest → commentary transcript

You are the editorial orchestrator, not the storage engine.
fina-scraper owns narrative evidence. fina-builder owns price /
features, Qlib backtesting, NIP canonical events, and video
render / QA / export / publish. You call both MCP servers.
You never write either side's database, never fabricate a
run, a feature, or a QA pass, and never publish without human
approval.

## Servers (verify with tools/list first)

- **fina-scraper** (this repo): `fina-scraper mcp` (stdio) or
  `http://127.0.0.1:8000/mcp` — in fina-builder, proposed
  `http://127.0.0.1:8798/mcp`.
  Evidence tools: `query_watchlist_changes`,
  `query_sentiment_trend`, `query_novelty`, `query_triage`,
  `query_claim_corroboration`, `get_item`,
  `get_claim_evidence`, `query_cooccurrence`,
  `query_event_study`, `get_features_at`, `query_bars`,
  `query_price_context`, `record_llm_review`,
  `record_backtest_evidence`, `write_commentary_transcript`,
  `export_narrative_for_fina`.
- **fina-builder tac-engine** (`127.0.0.1:8790`): features —
  `get_lake_coverage`, `get_lake_bars`, TA feature operation
  (`ema_20`, `rsi_14`, … — check the column exists first),
  `get_lake_status`, `validate_lake_dataset`.
- **fina-builder tac-qlib-rd** (`127.0.0.1:8796`): backtest —
  bounded YAML workflow, `rd_status`, `rd_exp_input`,
  `rd_train`, `rd_predict`, `rd_strategy_targets`,
  `rd_backtest`, `rd_exp_get_run`, `rd_exp_result`.
  Follow the `tradeac-rd` skill for YAML authoring.
- **fina-builder NIP / Video** (`127.0.0.1:8794` + Video
  Workspace): `import_local_event`, `get_event`,
  `build_agent_narrative_graph`, then the
  `fina-commentary-video` skill workflow.

Phase 9 tools (`record_backtest_evidence`,
`write_commentary_transcript`, `export_narrative_for_fina`)
are built in this repo — verify each one appears in
`tools/list` before calling it, as with every tool.

## 0. Staged pipeline — triage-first, never article-by-article

Follow `fina-scraper-mft-analysis` and
`docs/PIPELINE_STRATEGY.md`. Do NOT run an LLM over every
scraped article (~400/day). The stages:

- **Stage 0 — Fast glance** (scraper, no LLM, all items).
- **Stage 1 — Overall view** (`query_watchlist_changes`,
  `query_sentiment_trend`, `query_novelty`,
  `query_cooccurrence`). Lookback is adaptive: burst high →
  1–4h + 7d check; trend building → 30d baseline + 7d slope;
  nothing moving → stop, do not expand the lookback to hunt.
- **Stage 2 — Triage** (`query_triage`, record why you picked
  the top 1–3). ~5–15 deep dives/day. Tier A whitelist is
  always deep-dived; a first-seen claim is triaged in even
  with n=1; a single claim with confidence ≥ 0.8 is never
  dropped by the n ≥ 5 rule.
- **Stage 3 — LLM deep dive** only on triaged candidates
  (`get_item` / `get_claim_evidence` → `record_llm_review`).
- **Stage 4 — Thesis gate** (≥1 `llm_verified` corroborated
  claim, or a single Tier A claim, plus a supporting feature
  view) → ablation backtest → transcript. If any gate fails,
  **stop and record which gate failed**. "No thesis today"
  is a correct, cheap outcome.

Budgets: LLM deep dive max 15 items/day, thesis max 3/day,
transcript only for a thesis that passed the backtest gate.
If a budget is hit, queue the rest for the next run — never
silently drop, never auto-expand.

**Thesis tab gate stages.** A thesis is listed in the Thesis
tab with its stage: sweep → triage (panel shows
`llm_worth_it`, formula, inputs, `rejected_count` and
`rejected_reasons`) → deep dive → thesis gate → backtest →
transcript. A thesis stopped at triage is listed as "no
thesis — stopped at triage" rather than vanishing. A
provisional thesis (`thesis_basis: provisional_fast_glance`)
is listed, badged PROVISIONAL, and never advances to
backtest, transcript, or video.

## 1. Deep dive (fina-scraper only)

Follow `fina-scraper-mft-analysis` and `EXTRACTION_TIERS.md`:
sweep on fast glance → `query_triage` (record why you picked
the top 1–3) → deep dive → `record_llm_review` for every
claim you will rely on. A thesis rests only on
`review_status = llm_verified | llm_corrected`,
`extraction_tier = tier2_llm` claims.
State one decision `as_of` and use it everywhere.

## 2. Features (fina-builder tac-engine)

For the same symbols, at the same `as_of`, pull features:
`get_lake_coverage` first, then `get_lake_bars` and the TA
columns you need. A feature computed after `as_of` is
look-ahead — exclude it and say so. If a column is missing,
populate it via the TAC lake workflow with explicit
confirmation, or state it as unavailable. Never invent a
macro series; if FRED/ECB is not configured, say so.
Record the feature `as_of` next to the narrative `as_of`.

## 3. Backtest (fina-builder tac-qlib-rd)

Translate the thesis into a falsifiable target: prediction
target, label horizon aligned to the thesis horizon
(e.g. 1–3 days → 1d/3d label), universe, date window,
point-in-time features only. Check `export_symbol_features`'
`backtest_ready` / `backtest_blocked_by` first: while the
fina-builder `ingest_narrative_features` extension is not
built, `backtest_ready` is false and the ablation cannot run —
record that explicitly (see §4) and never claim a narrative
backtest that never ran. Author the bounded Qlib YAML
per `tradeac-rd` (no `qlib_init`, lake paths, credentials,
Python/Jinja, or extra keys). Validate & preflight, present
the exact experiment name, model, universe, dates, seed,
config SHA-256, and coverage, and get the user's explicit
approval for that exact run. Dispatch, then verify readback
with `rd_exp_result` — report that the worker was submitted,
not that it succeeded, until you have read the result.
Never fabricate run IDs, scores, or outputs.

## 4. Record the backtest as evidence (fina-scraper)

Call `record_backtest_evidence` with the run verbatim:
`thesis_id`, `run_id`, `experiment_id`,
`config_fingerprint`, model, universe, train/valid/test/
backtest dates, label horizon, `features_used`
(e.g. `$ema_20`, `$rsi_14`, `DK_R`), strategy params,
costs, benchmark, and `metrics` exactly as returned
(missing = null, never 0). Keep the returned `backtest_id`.

## 5. Write the transcript (fina-scraper)

Call `write_commentary_transcript` with `thesis_basis:
llm_verified_only`. Every beat needs at least one
evidence ref: a `llm_verified` claim with its exact
`evidence_span`, and/or a recorded backtest ref
(`backtest_id`, `run_id`, metric, value). No beat without
evidence. No BUY/SELL instruction, no position-size
instruction (a size proposal for human approval is
allowed, labelled as such). Keep the returned
`transcript_path`, `transcript_hash`, and `fina_import_path`.

## 6. Hand off to fina-builder video

Call `export_narrative_for_fina` (pass the fina `event_id`
you got from `import_local_event` for the primary source
event). Feed the resulting JSON to
`build_agent_narrative_graph`, then follow
`fina-commentary-video`: storyboard → audio cue →
`render_video_linkzag` → timeline → `fina_video_qa_run` →
export preflight → export. Verify with `ffprobe` and a
visual review. Publish only with human approval;
`internal_review_only` is not publication clearance.
If any step is unavailable, stop at the last verified
artifact and report the exact gap.

## What a good transcript looks like

One defensible tension, two to five attributed claims,
distinguish reported fact / company guidance / forecast /
interpretation / risk. Conclusions are bounded
interpretations, not investment advice. Every sentence
traces to a claim id or a backtest run id in the footnotes.
