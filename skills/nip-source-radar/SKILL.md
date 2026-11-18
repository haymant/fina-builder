---
name: nip-source-radar
description: Fetch and rank candidate episodes/observations from NIP sources with hard per-source caps — the bounded replacement for sweeping every configured feed.
---

# NIP source radar (bounded fetch → rank → pick)

Adapted from `../rehab-video-maker/skills/podcast-content-agent/scripts/trending.py`
and `investment_sources.py`, minus their failure mode.

## What went wrong there (do not copy it)

Rehab's preflight `daily_ready.py ensure` ran
`investment_sources.py list --per-feed 10` over **all 17 curated feeds** with no
tier, date or used filter, returning ~163–165 episodes per business day
(`state/daily-ledger.json`, `"rss": 163…165`) for exactly **one** final pick.
Its ranker (`trending.py list`) was a separate step, so the fetch was never
shaped by the ranking.

Lesson: **the fetch must be shaped by the question.** Per-source limit, a small
source set, and a global candidate cap come first; ranking runs on what came
back, never as a reason to fetch everything.

## Procedure

1. **Read the registry.** `list_sources` → filter `state == "active"` and the
   requested kind. If the user named a topic, keep only sources whose `topics`
   intersect it.
2. **Choose a bounded set.** Explicit `source_ids` if the user named sources;
   otherwise take at most **5** by `per_scan_limit` × recency of last activity.
   State the set before fetching.
3. **Fetch only that set.** Podcasts:
   `refresh_podcast_feeds` (every active feed, ignoring the six-hour window; a
   paused or removed source is skipped). Never loop `refresh` over the whole
   registry.
   The episode ceiling per source is `per_scan_limit` (default 3, max 10).
4. **Read candidates.** `list_podcast_episodes` for each chosen source. For
   non-podcast kinds there is no fetch adapter yet — say so and work from
   retained events instead.
5. **Rank deterministically.** For each candidate compute and show the terms:
   - `recency` — newer `published_at` first; undated candidates go last and are
     excluded from dated windows (doc 55 §4.2).
   - `source_priority` — operator-declared order, e.g. company meetings >
     filings > podcasts > Reddit/X.
   - `topic_match` — count of source `topics` matching the request.
   - `duration` — prefer long-form when the task is thesis work (≥ 40 min in
     rehab's picker).
   - `novelty` — drop anything already retained for that `source_id`
     (`source_native_id` or canonical URL) or already used.
6. **Pick one and justify it.** Report the ranked shortlist with scores, the
   chosen item, and what was skipped. Never present the chosen item as a
   recommendation to trade.

## Caps to quote when asked "why not fetch everything?"

- ≤ 5 sources per scan unless the user names more,
- ≤ `per_scan_limit` episodes per source (1–10),
- ranking never triggers additional network calls,
- transcription is one explicit step per chosen episode
  (`transcribe_podcast_episode`), not a batch.

## Output template

```
Scope: 3 active podcast sources, per_scan_limit 3 → 9 candidates max
Fetched: source-a (1 new), source-b (not modified), source-c (2 new)
Ranked: 1) … recency 0.9 topic 2/3 2) … 3) …
Pick: source-c / episode-…
Skipped: 6 (5 used, 1 off-topic)
```
