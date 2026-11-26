---
name: fina-scraper-mft-analysis
description: Analyse fina-scraper narrative evidence as a medium-frequency trading analyst — staged triage-first, from sweep to a falsifiable thesis — using only the MCP evidence tools. Use when an agent must turn the day's scraped items into ranked candidates, deep-dive the few worth LLM time, and decide whether a thesis exists, without ever issuing a trade signal itself.
---

# MFT analysis: sweep → triage → deep dive → thesis gate

You are the analyst, not the signal. The MCP server returns
evidence and deterministic aggregates only. It never issues
BUY/SELL/HOLD, never sizes a position, never mixes sentiment,
novelty, and price into one opaque score. You return
components with their formulas, `n`, baselines, and top
contributing items — and a falsifiable thesis with an
invalidation, or an honest "no thesis today".

## Server (verify with tools/list first)

- stdio: `fina-scraper mcp` (default transport; logs go to stderr)
- HTTP: `fina-scraper mcp --transport streamable-http --bind 127.0.0.1:8000`
  then `POST http://127.0.0.1:8000/mcp`
- Requires `NIP_LAKE_DIR`. Read `fina-scraper-query` first
  for the `as_of` rule and the tier labels; everything below
  assumes them.

## The staged pipeline (normative — do not skip stages)

**Stage 0 — Fast glance (the scraper, no LLM, all items).**
Tier 0 lexicon / Tier 1 ONNX rows already in the lake.
This is the only stage that touches every article.

**Stage 1 — Overall view (aggregate queries, no LLM).**
Decide the lookback from what the view shows, adaptively:
- Burst / novelty high → short lookback (last 1–4h) + a 7d
  check for "has this happened before?".
- Trend building (z rising over buckets) → 30d baseline for
  the z-score, 7d for the trend slope.
- Nothing moving → STOP. Do not expand the lookback to go
  hunting for a thesis; an expanded lookback on flat data
  manufactures a signal from noise.
- A single high-confidence claim in a Tier A source →
  look back 90d for that entity only, to check repeat/reversal.

Tools, in order:
1. `query_watchlist_changes(tickers[], as_of_prev, as_of_now)` —
   what changed since the previous window, per ticker.
   `as_of_now` is the last completed scrape, not wall-clock now.
2. `query_sentiment_trend(entity|ticker, as_of, bucket=1h|4h|1d,
   window_hours=24, baseline_days=30)` — buckets with `n`,
   `mean_sentiment`, `baseline_mean`, `baseline_std`, `z_score`.
   `z = (last_mean − baseline_mean) / baseline_std`; `z` is
   `null` with reason `insufficient_baseline` unless
   `baseline_n >= 5` and `std != 0`. Never invent a z-score.
3. `query_novelty(entity|ticker, as_of, window_min=60,
   baseline_days=30)` — `burst_ratio = mentions_window /
   max(1, mean mentions per equal window in baseline)`,
   `first_seen_at`, `is_first_in_baseline`, `top_items[]`.
4. `query_cooccurrence(entity|ticker, as_of, window_hours=24,
   min_count=2)` — drill up: what else moves with this entity.

**Radar (the NIP dashboard's per-entity view).** The radar is
hourly per entity, not weekly counts: rank by `|z|` and
`burst_ratio` from the Stage 1 calls above, show `n` and the
baseline next to every number, and keep the weekly radar as a
secondary tab only. An entity with high mentions but `z ~ 0`
is noise, not a signal — it ranks last. **Discard an entity
from the ranking when its window `n < 5`** (or its z is null
for an insufficient baseline): a loud move on two items is not
a ranked signal. Show it as "insufficient data", never rank it
on a null z and never promote it on mention count alone.

**Stage 2 — Triage (rule-based, no LLM).**
`query_triage(entity|tickers[], as_of, budget?)` returns
ranked candidates with `llm_worth_it = true` iff
`(|z| >= 1.5 OR burst_ratio >= 2 OR corroborated fast-glance
claim) AND n >= 5`, plus `rejected_count` and
`rejected_reasons` for everything it turned down. Pick the
top 1–3 candidates and record *why* you picked each one.
Expected volume: ~5–15 deep dives/day out of ~400 items —
a ~97% reduction in LLM calls. The triage result is the
audit trail: a candidate that was never triaged in must
never be deep-dived.

Safeguards (triage never drops these):
- **Tier A whitelist, always deep-dived:** Alpaca breaking
  news, FOMC / central-bank statements, earnings-call
  guidance changes, any fast-glance claim with
  `confidence >= 0.8` on a watchlist symbol.
- **Novelty:** a first-seen claim on a watchlist symbol is
  triaged in even with `n = 1`.
- **Single high-confidence claim** is never dropped by the
  `n >= 5` rule — that rule applies to aggregate sentiment,
  not to one strong claim.
- **Audit:** rejected items keep their fast-glance row and
  triage inputs, so a later run can re-triage without
  re-scraping or re-spending LLM time.

**Stage 3 — LLM deep dive (only on triaged candidates).**
`get_item(item_id)` / `get_claim_evidence(claim_id)` — read
the spans, check the span is a substring of the item body,
then `record_llm_review(item_id|claim_id, verdict=
verified|corrected|rejected|disputed, corrected_text?,
confidence, model_id, prompt_version, evidence_span)`.
A corrected claim keeps the fast-glance text as
`superseded_text`; a rejected claim stays queryable by
`review_status=llm_rejected`. This is the *only* stage that
spends LLM tokens on extraction.

**Entities view.** For one entity, `get_features_at(entity|ticker,
as_of)` returns the feature vector (`sentiment_1h/4h/24h`,
`mentions`, `velocity`, `novelty`, `claim_count`,
`distinct_sources`, price features) split by tier
(`features_by_tier`, `llm_verified_coverage`; coverage < 0.5
is labelled `mostly_fast_glance`). An entity whose window
`n < 5` is not ranked in Entities either — the same discard
rule as Radar: show "insufficient data", not a rank.
`query_symbol_features` (built in Phase 9) returns the same vector
in the formal `narr-v1` schema with top claims and evidence ids. Missing is `null`, never 0.

**Stage 4 — Thesis gate, then backtest, then transcript.**
A thesis requires ≥1 `llm_verified` (or `llm_corrected`)
claim with corroboration — or a single Tier A claim — and a
supporting feature view (`get_features_at` at the decision
`as_of`, recorded verbatim). Then the ablation backtest
(Run A: TA+macro only, vs Run B: TA+macro+`$narr_*` — see
`fina-scraper-thesis-backtest-video`). If any gate fails,
**stop and record which gate failed** (triage / LLM review /
corroboration / backtest delta). "No thesis today" is a
correct, cheap outcome. Never present a provisional thesis
(`thesis_basis: provisional_fast_glance`, labelled
"PROVISIONAL — NOT THESIS-GRADE") as a signal.

## Budgets (normative)

- LLM deep dive: max **15 items/day** (schedule record
  `llm_daily_budget`). If hit, queue the rest for the next
  run with their triage scores — never silently drop, never
  auto-expand.
- Thesis: max **3/day** (`thesis_daily_budget`).
- Transcript: only for a thesis that passed the backtest gate.

## Corroboration, timeline, event study

- `query_claim_corroboration(claim_id, as_of)` —
  `corroboration_score = distinct_source_count`; contradicting
  = same subject+predicate, different object, `confidence >= 0.5`.
  One source is an anecdote; two independent sources are a
  signal candidate. (Fast-glance seeds need
  `include_fast_glance: true` — the thesis-grade default
  excludes them.)
- `query_claim_timeline(subject, as_of)` — the claim over time.
- `query_event_study(event_item_id|(entity, event_time), as_of,
  pre_hours=4, post_hours=4)` — pre/post sentiment and price.
  Post window is clipped to `as_of`; price uses Alpaca bars
  with `bar_time <= as_of` only. If no price is available as
  of `as_of`, `price` is `null` with a reason.
- `query_bars` / `query_price_context` — see
  `fina-scraper-query`. State which price source and feed you
  used for every return; never mix feeds in one return window.

## The as_of rule, worked

Correct: decision `as_of = 2026-11-24T16:00:00Z` stated up
front; every query uses it; `get_features_at` at that `as_of`
is recorded verbatim in the report; no returned row has
`ingested_at > as_of`.

WRONG: sweeping with `as_of_now` = wall-clock now, then
backtesting a thesis "as of yesterday" on the same numbers —
the sweep saw items ingested after the decision time, so the
thesis was chosen with future information. The sweep and the
decision share one `as_of`, or the analysis is invalid.

## What a thesis looks like

Exactly one falsifiable thesis: direction, entity, horizon,
entry condition, invalidation ("what would change my mind"),
confidence + reason. Every claim cited carries its `claim_id`,
`evidence_span`, `extraction_tier`, and `review_status`.
A distractor (single source, low confidence, no corroboration,
no burst, no price move) is rejected with a reason, not
ignored. No trade execution; any size is a proposal for human
approval, labelled as such.
