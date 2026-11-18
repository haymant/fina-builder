# 64 — Source registry: CRUD, corrected locators, and ingestion beyond podcasts

**Status:** Plan + implementation. Backend registry, MCP tools, desktop UI and
skills are implemented in this change; non-podcast *fetch adapters* remain
gated (see §7). Supersedes nothing in docs 55–58; it extends them and records
where the BRD was silent.

## 1. What the BRD actually specifies

[Doc 55](./55-narrative-intelligence-aligned-brd.md) §4.2 covers the source
lifecycle only partially:

| Capability | BRD position | Delivered before this change |
|---|---|---|
| Create (subscribe) with rights confirmation | Required, per-feed, explicit | Yes — **Add an approved podcast** |
| Read (list feeds and polling state) | Required ("list approved feeds") | Engine + one sidebar card, no detail |
| Update (correct a wrong feed URL, rename, change rights/policy) | **Not specified** | **No** |
| Pause / resume | Required ("the user can pause or remove each feed") | Engine tool `set_podcast_subscription_state`; **no UI** |
| Delete / remove | Required ("pause or remove") | Engine soft-remove only; **no UI**, no hard delete |
| Non-podcast sources | Explicitly **later-phase** ("Corporate reports/blogs, X/Twitter and other connectors remain later-phase scope"; "Reddit is conditional") | `nip_sources.source_type` has only `podcast`, `local_document`, `other` |

So the complaint is accurate: the UI shipped Create + Read and silently omitted
Update, pause/resume and delete. That is an implementation gap, not a BRD
omission — except for **editing a wrong feed URL**, which the BRD never
mentions at all and which is the one operation a user needs most when setup is
wrong.

## 2. Why the registry must not be podcast-only

NIP's product output is a *temporal thesis graph* — claims linked to immutable
observations with point-in-time provenance (docs 55 §4.3, 56 §2). Nothing about
that model is podcast-shaped: the ledger already stores `source_type`,
`locator`, `rights_status`, `rights_statement` and four timestamps. A podcast
is just one adapter that produces observations.

Priority order for a research desk (highest first), matching the earlier
recommendation:

1. **Company meetings** — management calls, investor days, board-approved
   transcripts. Highest signal-to-noise, explicit rights, dated.
2. **Filings / corporate reports** — 10-K/20-F, 8-K, annual reports, IR decks.
3. **Podcasts** — already implemented; useful for thesis formation, weaker
   provenance (host framing, edit risk).
4. **Reddit / X** — sentiment and crowding only, conditional on provider terms,
   never auto-scraped; draft-only per doc 55.
5. **Web / blogs / local documents** — fallback, user-owned or licensed.

The registry therefore stores a **kind** independent of the fetch adapter, so a
new adapter never needs a schema migration.

## 3. What ../rehab-video-maker does (and why tens of feeds were fetched)

Read-only study of `/home/data/git/haymant/rehab-video-maker`:

- Discovery is **two hard-coded curated lists**, not a crawl:
  `skills/podcast-content-agent/config/investment-sources.json` (17 RSS feeds)
  and `config/trending-sources.json` (20 YouTube channels).
- The preflight gate `daily_ready.py ensure` runs `_scan()`
  (`skills/podcast-youtuber-agent/scripts/daily_ready.py:129-166`), which calls
  `investment_sources.py list --per-feed 10`. That function
  (`scripts/investment_sources.py:82-101`) loops over **every** configured feed
  with no tier/date/used filter, then returns them in feed order. There is no
  ranking in that path.
- Result: ~17 × 10 ≈ **163–165 episodes fetched per business day**
  (`state/daily-ledger.json`, `"rss": 163…165`; artifact
  `build/autopilot/scan-rss-*.json`), of which exactly **one** is selected
  (`build/autopilot/autopilot-manual.log:14`). The separate ranker
  (`trending.py list`) produced 17 ranked candidates in the same run.
- There is **no CRUD**: create = append to `state/used-episodes.json`; read =
  `fetch_popular.py list|get`; update = rewrite the ledger; delete = absent.
- There is **no generic source type**: the candidate schema is podcast-only
  (`rss | youtube | podcasttranscript`), and Reddit/X appear only as
  distribution targets, never as ingestion sources.

Lessons adopted here:

1. Fetching is **bounded and explicit**: per-source limit, max sources per scan,
   and a global cap — never "all feeds × N".
2. Ranking is a **separate, versioned step** over already-retained metadata; it
   never fetches in order to rank.
3. A source registry with real CRUD is a precondition for trusting the graph.

## 4. Design

### 4.1 Schema (migration 0009)

`nip_sources` keeps `source_type` (coarse class used by event queries:
`podcast | local_document | other`) and gains the fine-grained registry fields:

```
source_kind            VARCHAR NOT NULL DEFAULT 'other'
                       -- podcast | company_meeting | filing | reddit | x | web | local_document | other
state                  VARCHAR NOT NULL DEFAULT 'active'   -- active | paused | removed
rights_statement       VARCHAR                             -- already existed (0004)
topics_json            VARCHAR NOT NULL DEFAULT '[]'
poll_interval_minutes  INTEGER NOT NULL DEFAULT 360        -- podcasts only
per_scan_limit         INTEGER NOT NULL DEFAULT 3          -- hard per-source cap
notes                  VARCHAR
updated_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
```

Backfill maps existing rows (`podcast` → `podcast`, `local_document` →
`local_document`, `other` → `other`) and copies subscription state into
`state` so pause/remove survives in one place.

Podcast rows still own a `nip_podcast_subscriptions` row (feed URL, ETag,
poll bookkeeping); `nip_sources.locator` mirrors the feed URL for every kind.
URL correction clears `etag`, `last_modified`, `next_poll_at`,
`last_error_code`, `consecutive_failures` so the next refresh is a full fetch.

### 4.2 States and lifecycle

- `active` — eligible for refresh/scan.
- `paused` — retained, excluded from scans; can be resumed.
- `removed` — soft delete, hidden from the default list, retained for audit
  because events may reference it. Podcast subscription state mirrors it.
- Hard delete is allowed **only** when the source owns zero events; it removes
  the subscription and episode metadata in the same transaction. A source with
  events must go through `removed` and the BRD §4.1 purge path (separate,
  explicit, audited).

### 4.3 Fetch policy

Every scan is bounded by construction:

- `per_scan_limit` per source (default 3, hard max 10),
- explicit `source_ids` or at most `max_sources` (default 5) due sources,
- a global candidate cap (default 30),
- ranking after retrieval, never during.

## 5. MCP tool surface

New tools (all also usable from RIGA, since RIGA calls the same NIP service):

| Tool | Purpose |
|---|---|
| `list_sources` | All registry rows with kind, state, rights, topics, scan policy, event count. |
| `create_source` | Create any kind. `podcast` delegates to `subscribe_podcast_feed` (rights + initial sync preserved). |
| `update_source` | Correct locator/name/rights/topics/policy; podcast URL change resets fetch state and can re-sync. |
| `set_source_state` | `active` / `paused` / `removed`. |
| `delete_source` | Hard delete only when the source has no events; otherwise returns `source_has_events`. |

Existing `subscribe_podcast_feed`, `list_podcast_subscriptions`,
`refresh_podcast_feeds`, `list_podcast_episodes`,
`set_podcast_subscription_state` and `transcribe_podcast_episode` stay for
compatibility; `set_podcast_subscription_state` now delegates to the registry.

## 6. Desktop UI

- **Sources** card replaces **Approved sources**: kind chip, name, locator,
  state, rights, per-scan limit, event count, and per-row **Edit / Pause /
  Resume / Remove / Delete**.
- Inline edit corrects the feed URL, show name, rights statement, topics and
  scan limit; a podcast URL change offers "refresh now".
- **Add source** form gains a kind selector; podcast keeps the rights checkbox
  and initial sync, other kinds create a registry row only (no fetch).
- Nothing is created without an explicit rights statement; `removed` sources are
  shown behind a toggle so a wrong URL can be restored rather than re-created.

## 7. Phases

- **P1 (this change):** registry + migration, CRUD tools, podcast URL
  correction, UI, skills, tests.
- **P2:** adapters for company meetings (uploaded/approved transcript or IR
  URL), filings (SEC/IR fetch with rate limits), and web pages; each adapter
  emits observations through the existing immutability/idempotency rules.
- **P3:** cross-kind candidate ranking (`recency × rights × kind weight × topic
  match`, versioned) and a bounded "scan → rank → pick" flow that replaces the
  rehab-style sweep.

Reddit/X remain gated on provider terms; no browser automation to bypass them
(doc 55 §4.2).

## 8. Testing plan

Rust (`crates/nip-store`, `crates/nip-engine`):

1. Migration reaches v9, backfills kind/state, and keeps existing feeds usable.
2. Create/read/update for each kind; duplicate locator rejected.
3. Podcast locator correction updates both tables and clears ETag/backoff.
4. `set_source_state` mirrors into the subscription for podcasts; `active`
   sources only are scanned.
5. `delete_source` deletes a zero-event source (and its episodes), refuses with
   `source_has_events` otherwise; `removed` still lists when requested.

Frontend (`vitest`):

6. Sources card lists all kinds with state/actions.
7. Edit saves a corrected URL through `update_source` and shows the new value.
8. Pause/resume/remove call `set_source_state`; delete shows the event guard.
9. Add-source kind selector routes podcasts to `subscribe_podcast_feed`.

E2E (Playwright, loopback fixtures): Journey K — add a feed with a wrong URL,
edit it to the fixture feed, refresh, and see the episode appear; pause →
no new episode after refresh; remove → hidden from the active list; delete a
zero-event source.

Acceptance: a wrong podcast URL can be corrected without deleting retained
evidence; every non-podcast source kind can be created, renamed, paused and
removed from both the workspace and RIGA; a scan can never exceed its declared
caps.
