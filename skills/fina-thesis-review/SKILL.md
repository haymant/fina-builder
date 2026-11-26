---
name: fina-thesis-review
description: Review theses in fina-builder's Thesis tab through their gate stages — sweep, triage, deep dive, thesis gate, ablation backtest, transcript — and judge whether a thesis may advance, must stop, or is "no thesis today". Use when an agent must triage narrative candidates, deep-dive claims, gate a thesis, read an ablation result, or send a thesis to video. Provisional theses never advance; a thesis that stopped at triage is recorded, not hidden.
---

# Thesis review (Thesis tab)

You are the reviewer, not the storage engine. fina-scraper owns
narrative evidence and the transcript; fina-builder owns the
Thesis tab records, the TAC lake, Qlib backtesting, and video.
You call both MCP servers' tools; you never write either side's
database, never fabricate a run, a feature, or a review, and
never advance a thesis past a gate it did not pass.

The Thesis tab is `src/features/narrative/components/ThesisView.tsx`.
Teach and follow what it implements — not the revamp spec, and
not a flow the UI cannot do.

## Servers (verify with tools/list first)

- **fina-scraper** (stdio sidecar via `scripts/fina-scraper-mcp.mjs`,
  configured in `.mcp.json`; the desktop reaches it over stdio
  through its own sidecar spawn — there is no HTTP 8798 endpoint
  to call directly): `query_watchlist_changes`,
  `query_sentiment_trend`, `query_novelty`, `query_cooccurrence`,
  `query_triage`, `get_item`, `get_claim_evidence`,
  `query_claim_corroboration`, `query_event_study`,
  `query_symbol_features`, `export_symbol_features`,
  `record_llm_review`, `record_backtest_evidence`,
  `write_commentary_transcript`, `list_transcripts`,
  `get_transcript`, `export_narrative_for_fina`.
- **fina-builder tac-engine**: `get_lake_coverage`,
  `get_lake_bars`, TA/SP feature reads, `get_lake_status`,
  `validate_lake_dataset`, `ingest_narrative_features`
  (the `narr` family ingest — built; check
  `export_symbol_features`' `backtest_ready` /
  `backtest_blocked_by` first, and if it is false, record
  exactly what `backtest_blocked_by` names instead of
  assuming which extension is missing).
- **fina-builder tac-qlib-rd**: bounded YAML workflow —
  `rd_status`, `rd_exp_input`, `rd_train`, `rd_predict`,
  `rd_strategy_targets`, `rd_backtest`, `rd_exp_get_run`,
  `rd_exp_result`. Follow the `tradeac-rd` skill for YAML
  authoring.
- **fina-builder NIP / Video**: the Thesis tab records and
  the Video Workspace. The video flow itself is the
  `fina-commentary-video` skill; the thesis-to-video
  handoff is §6 below.

## 0. The gate stages

A thesis moves through visible stages, each with its gate
result. The tab's pipeline panel reads, left to right:

**sweep → triage → deep dive → thesis gate → backtest → transcript**

Thesis statuses in the tab (`draft → llm_reviewed → backtested →
transcript_ready → video_ready → published`, plus `rejected` and
`invalidated`) track the same journey. The list sorts by newest
decision `as_of` first and filters by status / basis / symbol.
Every stage is recorded; a thesis that stopped early is listed
as stopped, not vanished.

One decision `as_of` governs everything: every feature read,
backtest, and claim check is point-in-time at that `as_of`.
A feature computed after `as_of` is look-ahead — exclude it
and say so. Missing data is null, shown as "—", never 0.

## 1. Sweep (Radar / Entities — no LLM)

Start from what moved. Radar is hourly, per-entity (z-score,
burst, `n`, distinct sources, `llm_verified_share`); the
weekly narrative-cluster radar is a secondary tab for
editorial planning, not the triage input. Entities rank by
change; discard `n < 5` for a trend claim (a single item can
still matter — see §2 — but it is not a trend). Budgets:
LLM deep dive max 15 items/day, thesis max 3/day. If a
budget is hit, queue the rest for the next run — never
silently drop, never auto-expand.

## 2. Triage — the panel, and "no thesis today"

Run `query_triage` for the tickers/entities under review.
The triage panel shows, per candidate: ticker/entity, `z`
(z-score), `burst` (burst ratio), `n`, `llm_worth_it` (with
the formula and its inputs), and the reason. It also shows
`rejected_count` and `rejected_reasons` — every rejected
candidate with its reason, in a collapsible list.

Triage rules (from the staged pipeline):

- **Tier A whitelist is always deep-dived.**
- A **first-seen claim is triaged in even with n=1**.
- A **single claim with confidence ≥ 0.8 is never dropped
  by the n ≥ 5 rule**.
- Otherwise, rank by change and spend LLM time on the
  top 1–3 (~5–15 deep dives/day). Lookback is adaptive:
  burst high → 1–4h + 7d check; trend building → 30d
  baseline + 7d slope; nothing moving → stop, do not
  expand the lookback to hunt for movement.

**"No thesis today" is a first-class outcome.** If no
candidate earned LLM time, the panel says so in plain
language — "No thesis today — stopped at triage: no
candidate earned LLM time" — and nothing is invented to
fill the day. A thesis stopped at triage is listed as
"no thesis — stopped at triage (z=…, burst=…, n=…)"
rather than vanishing. Record the triage result honestly
and stop. Do not lower the bar, do not re-run triage with
a wider lookback to manufacture a candidate, and do not
write a provisional thesis to have something to show.

## 3. Deep dive — LLM review, per claim

Deep-dive only triaged candidates: `get_item` /
`get_claim_evidence` → `record_llm_review` for every claim
the thesis will rely on. A thesis rests only on
`review_status = llm_verified | llm_corrected`,
`extraction_tier = tier2_llm` claims. Fast glance
(`tier0_lexicon` / `tier1_onnx`) decides whether to spend
LLM time; it is never thesis-grade, and the tab labels it
as such (`mostly_fast_glance` where `llm_verified_coverage`
< 0.5). Rejected claims the analyst considered stay visible
in a collapsed "considered and rejected" section, with
reasons — an audit trail, not a hiding place.

## 4. Thesis gate — and the provisional rule

The thesis gate passes with ≥1 `llm_verified` corroborated
claim (or a single Tier A claim) plus a supporting feature
view (`get_features_at` / `query_symbol_features` at the
decision `as_of`, per tier, with `llm_verified_coverage`).
The thesis card states the falsifiable statement, direction
(`long` / `short` / `neutral` — as a *proposal*, never a
trade instruction), horizon (e.g. 1–3 days), entry condition,
invalidation condition, confidence, and "what would change
my mind". A thesis with no invalidation condition cannot
reach video (`invalidation_missing`).

**Provisional theses are listed, badged, and never advance.**
A thesis with `thesis_basis: provisional_fast_glance` is
shown with a red "PROVISIONAL — NOT THESIS-GRADE" badge and
the note "Provisional — listed for the audit trail, never
advances past draft." The gate is in the data, not just the
UI: the store refuses the transition into `backtested` or
any later stage. The only way forward is to deep-dive the
claims, record LLM reviews, and re-issue the thesis as
`llm_verified_only`. Never work around this — no backtest,
no transcript, no video from a provisional thesis. The
transcript tool itself refuses to write one for a
provisional thesis, so there is nothing downstream to gate.

If any gate fails, **stop and record which gate failed**.
A stopped thesis keeps its stage, its evidence, and its
rejected claims visible.

## 5. Backtest — the ablation is the evidence

Run A (TA+macro) vs Run B (TA+macro+`$narr_*` tier2_llm):
identical seed, universe, dates, model, costs, benchmark;
label horizon = thesis horizon; point-in-time features only.
Check `export_symbol_features`' `backtest_ready` /
`backtest_blocked_by` first. Author the bounded Qlib YAML
per `tradeac-rd`, present the exact experiment name, model,
universe, dates, seed, config SHA-256 and coverage, get the
user's explicit approval for that exact run, dispatch, then
verify readback with `rd_exp_result` — report that the
worker was submitted, not that it succeeded, until the
result has been read. Record the run verbatim with
`record_backtest_evidence` (metrics exactly as returned;
missing = null, never 0).

The tab shows Run A vs Run B side by side (IC/ICIR, Sharpe,
return, max drawdown, feature importances, run_ids, config
fingerprints) and the **delta A→B out-of-sample**, which is
the evidence. Read the verdict as recorded:

- `supported` — the thesis is SUPPORTED by the backtest;
  it may advance to transcript.
- `not_supported` — "thesis NOT supported by the backtest"
  (Run B did not beat Run A out-of-sample); the thesis
  cannot advance. Say so in plain language; do not soften
  it into a pass.
- `could_not_run` — the ablation could not run; the panel
  records exactly why (`could_not_run_reason`) and never
  shows a missing panel that looks like a pass. The thesis
  cannot advance to `transcript_ready` without an ablation.

Re-running the backtest creates a new run_id; old runs are
kept. The thesis advances only on the newest recorded
ablation.

## 6. Transcript — then Send to Video

`write_commentary_transcript` with `thesis_basis:
llm_verified_only` writes `_transcripts/<thesis_id>.md|.json`
(beats with per-beat evidence footnotes — claim/item/backtest
ids — plus `transcript_hash`). Every beat needs at least one
evidence ref: a `llm_verified` claim with its exact
`evidence_span`, and/or a recorded backtest ref. No beat
without evidence. No BUY/SELL instruction, no position-size
instruction (a size proposal for human approval is allowed,
labelled as such). The tab shows the transcript beats, the
hash, and a "Send to Video" action.

**Send to Video** unlocks only once a transcript exists for
an `llm_verified_only` thesis at `transcript_ready` or later.
It opens the Video Workspace at the thesis entry with this
transcript loaded. From there the `fina-commentary-video`
skill takes over: re-verification, the 8-beat thesis
storyboard, backtest panel, QA + visual review, and the
publish gate (human approval only).

## 7. Actions — invalidate honestly

- **Re-run backtest** — new run_id, old runs kept.
- **Export fina-import JSON** — via `export_narrative_for_fina`.
- **Send to Video** — §6; gated as above.
- **Mark invalidated** — with the reason **and the
  observation that invalidated it** (not just a label).
  An invalidated thesis stays listed with its evidence, so
  the record shows what was believed and what changed it.
- **Publish** — human approval only, from the Video
  Workspace publish gate (see `fina-commentary-video`);
  never from the Thesis tab alone.

## 8. Schedules — what executes a scrape, honestly

Schedules are **recorded** with fina-scraper
`scrape_schedule` (and listed via `scrape_status`, which
also reports per-schedule last-run results and budget
consumption: LLM used today, theses today). Recording a
schedule does not execute it. Execution today is
`fina-scraper run --loop`, or system cron calling
`fina-scraper run --once` for headless use. The desktop's
6h refresh loop does **not** yet execute per-schedule
scrapes — until the nip-engine timer is generalised, a
recorded schedule's next run is computed from its last
run, not driven by the desktop timer. Do not tell the user
(or the UI) that the desktop timer runs their schedules;
say which executor is actually running, and if none is,
say the schedule is recorded but not executing. The
Schedules view states this; the skill must not contradict
it.

## What a good review looks like

One decision `as_of`, one falsifiable thesis, two to five
attributed `llm_verified` claims, a feature view at the same
`as_of`, an ablation with a stated delta (or a stated reason
it could not run), and a transcript whose every beat cites
its evidence. Or: no thesis today, recorded with the triage
numbers that stopped it. Both are correct outcomes; only
an unrecorded or un-gated advance is a failure.
