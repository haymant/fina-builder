# 65 — Entity-linked claims, temporal features, and tradeac signal research (draft)

**Status:** draft for review. Nothing in this document is implemented. The work is
gated on the tradeac / tac-engine / lake migration into fina-builder
([TAC lake skill](../modules/tac-engine/skills/tradeac-lake/SKILL.md),
[doc 58](./58-narrative-intelligence-phase-0-decisions.md)).

**Reference module.** `modules/rehab-video-maker/` is a **legacy** checkout kept
only as an end-to-end commentary-video reference (see the README note); it is not
a dependency of this plan. Its transcript/commentary workflow informs the
bounded-window extraction and the skill shape below.

**Target.** Turn NIP from "extract sentences from transcripts" into a
**temporal entity-and-claim graph** whose weekly features can be exported,
joined to point-in-time market data, and tested as candidate trading signals
with tradeac / LightGBM.

**Non-goals (for this draft and the first implementation rounds).** No live
trading, no automatic recommendations, no return claims without a reproducible
walk-forward evaluation, and no scalar "novelty" or "influence" score before a
labelled review set exists (see [doc 55](./55-narrative-intelligence-aligned-brd.md) §4.2).

---

## 1. Why 50 claims is the wrong output

Measured on a 39,112-character episode transcript (2026-11-18):

- the bridge split it into **5 windows** and committed **50 claims** — the
  merge cap, not a quality target;
- each claim is free text plus an optional quote, with no type, entity,
  direction, horizon or novelty key;
- the same fact reappears in several windows in different words (exact-text
  dedupe only removes identical strings);
- nothing asserts that a claim is *about a tradable subject*, so claims cannot
  be aggregated per ticker, compared across sources, or tracked over time;
- extraction precision has never been measured, so a false claim becomes a
  false feature silently.

A claim is an **observation**. A feature is an **aggregation over observations
for an entity and a window**. A signal is a **tested hypothesis over features**.
Shipping 50 untyped observations skips two of those three layers.

## 2. Principles carried over from the BRD

1. **Immutable events, versioned derivations.** Claims, entities, links,
   features and signals are rebuildable projections with run IDs.
2. **Point-in-time or it does not exist.** Every derived row records
   `known_at`; every read takes `as_of`. Features built at `as_of` may only use
   evidence with `known_at <= as_of`, even if `published_at` is earlier.
3. **Evidence before interpretation.** Every claim keeps quote + span + event;
   every entity link keeps the surface form and resolver version.
4. **Precision over recall.** 20 correct, typed claims beat 50 plausible ones.
   Extraction quality is measured on a human-reviewed sample per phase.
5. **Absence is visible.** Missing coverage, unresolved entities and short
   samples are explicit flags, never imputed.

## 3. Target data model

Suggested migrations: `0011_entity_graph.sql`, `0012_entity_features.sql`,
`0013_signal_specs.sql` (numbering after `0010_publisher_transcripts.sql`).

### 3.1 Entities

| Table | Columns (draft) |
|---|---|
| `nip_entities` | `entity_id`, `kind` (`company`,`ticker`,`person`,`product`,`theme`,`index`,`other`), `canonical_name`, `tickers[]`, `parent_entity_id`, `resolution_version`, `created_at`, `known_at` |
| `nip_entity_aliases` | `entity_id`, `alias`, `alias_kind` (`name`,`ticker`,`handle`,`transliteration`), `source_scope`, `confidence_millis` |

Resolution order: exact ticker → exact alias → normalised alias → provider
suggestion → human review queue. Merges and splits are new versions, never
in-place edits.

### 3.2 Typed claims

Keep the existing evidence contract (`ClaimEvidence`) and add annotation fields
to `ClaimRecord`:

| Field | Purpose |
|---|---|
| `claim_type` | `guidance`, `forecast`, `measurement`, `causal`, `risk`, `opinion`, `fact` |
| `subject_entity_id` / `object_entity_id` | tradable subject and, when present, the object of the relation |
| `polarity` | `-1 / 0 / +1` |
| `magnitude_value`, `magnitude_unit` | e.g. `150`, `USD_billion`; nullable |
| `horizon` | `day`, `week`, `quarter`, `year`, `unspecified` |
| `attribution` | speaker + role (`ceo`, `cfo`, `host`, `analyst`, `unknown`) |
| `certainty` | `asserted` / `hedged` |
| `novelty_key` | normalised `subject · predicate · object · horizon` |
| `valid_from` / `valid_until` | claim validity, distinct from `published_at` |
| `annotation_version`, `annotation_run_id` | which extraction contract produced this row |
| `review_status` | `machine`, `confirmed`, `rejected` |

`claim_text` stays immutable per annotation run. A re-annotation creates a new
run; readers select the latest non-rejected run per event.

### 3.3 Claim relations

`nip_claim_relations`: `from_claim_id`, `to_claim_id`, `relation`
(`supersedes`, `confirms`, `contradicts`, `restates`), `confidence_millis`,
`derivation_run_id`, `known_at`. Built deterministically from `novelty_key`
first; semantic similarity and source comparison second.

### 3.4 Temporal entity features

`nip_entity_features`, one row per `entity_id × window × as_of`:

| Feature | Definition (draft) |
|---|---|
| `claim_count` | typed claims for the entity in the window |
| `mention_velocity` | window count ÷ trailing 4-window mean |
| `net_direction` | Σ polarity × confidence × source_weight |
| `novelty_rate` | new `novelty_key`s ÷ all claims |
| `restatement_ratio` | restates ÷ all claims |
| `source_dispersion` | distinct sources, and agreement vs contradiction share |
| `guidance_revision` | signed magnitude of `supersedes` chains |
| `co_mention_centrality` | degree in the entity co-mention graph |
| `speaker_quality` | share attributed to executives vs hosts |
| `coverage` / `data_quality_flags` | source completeness, undated evidence, short sample |

Each row also carries `formula_version`, `derivation_run_id` and `known_at`.

### 3.5 Signal specifications and experiments

`nip_signal_specs` (NIP): hypothesis text, feature list, formula version,
horizon, universe, coverage/falsification requirements, status
(`draft`,`testing`,`validated`,`retired`), link to experiment IDs.

Experiments (fit, split, metrics, artefacts) live in **tradeac**, not NIP; NIP
exports matrices and consumes accepted specs for display. Duplicating an
experiment registry in NIP would create two sources of truth.

## 4. End-to-end flow

```text
approved sources
      │  (bounded) backfill + feed refresh
      ▼
discovered episodes ──► publisher transcript / local ASR ──► retained events
                                                             │
                                          typed claims + entity links
                                                             │
                                      claim relations (restates/supersedes)
                                                             │
                              weekly entity features (as_of, formula_version)
                                                             │
                            point-in-time feature matrix (Parquet + manifest)
                                                             │
                        tradeac: labels, splits, LightGBM experiments
                                                             │
                                   signal specs (validated only) ──► UI
```

## 5. Proposed skills

Skills orchestrate bounded procedures and call MCP tools; deterministic
computation stays in the Rust engine. Each skill records its inputs, run IDs and
coverage in its output so a later review can reproduce it.

### 5.1 `nip-history-backfill`

- **Job:** build the historical corpus for a reviewed source without sweeping
  every feed.
- **Inputs:** `source_id`, date floor, per-run cap, transcript preference.
- **Flow:** `list_podcast_subscriptions` → `list_episode_page` (bounded, by
  date) → for each episode use the publisher transcript when
  `transcript_url` exists, otherwise `start_podcast_transcription` under the
  local-ASR gate → poll `podcast_transcription_status` → report coverage.
- **Outputs:** per-source coverage report (episodes discovered / transcribed /
  publisher vs ASR / failures by reason), plus the event IDs created.
- **Guardrails:** rights-confirmed sources only; bounded batch; no audio upload;
  resumable; skip episodes that already have an event.
- **Done:** coverage report written, no duplicate events, failures list every
  exact step.

### 5.2 `nip-claim-typing`

- **Job:** extract few, high-value, typed, entity-bearing, deduplicated claims.
- **Flow:** choose retained events (one episode or a bounded set) → call the
  extended `extract_claims_from_event` with `schema_version` and
  `max_claims_per_window = 4` → reject claims without a resolved entity or
  quote → dedupe by `novelty_key` → link `restates`/`supersedes`.
- **Outputs:** typed claims with annotation run ID; a precision sample sheet for
  human review.
- **Guardrails:** precision target ≥ 0.8 on the sample before scaling; no
  claim without evidence span; cap per episode (e.g. 20) regardless of length.
- **Done:** claim count per episode falls while review precision rises.

### 5.3 `nip-entity-registry`

- **Job:** maintain canonical entities and claim links.
- **Flow:** collect unresolved mentions from new claims → deterministic ticker
  and alias resolution → provider suggestion for the remainder → human review
  queue → versioned merge/split.
- **Outputs:** `nip_entities`, `nip_entity_aliases`, `nip_claim_entities`;
  resolver coverage and error sample.
- **Guardrails:** never silently overwrite a canonical name; record resolver
  version; unresolved mentions stay unresolved rather than guessed.
- **Done:** resolution precision ≥ 0.9 on a reviewed sample; no claim points at
  a deleted entity.

### 5.4 `nip-temporal-features`

- **Job:** compute weekly point-in-time features per entity.
- **Flow:** `rebuild_entity_features(as_of, window)` → deterministic formulas →
  snapshot with `formula_version` and coverage flags → spot-check reproducibility
  by recomputing the same `as_of` and diffing.
- **Outputs:** `nip_entity_features` rows + coverage report.
- **Guardrails:** no evidence with `known_at > as_of`; entities with fewer than
  N observations are flagged, not scored; features are descriptive, not
  recommendations.
- **Done:** identical inputs reproduce identical rows; coverage gaps are listed.

### 5.5 `nip-edge-experiments`

- **Job:** turn features into a reproducible experiment, then a decision.
- **Flow:** `export_feature_matrix(from, to, as_of, label_horizon)` → hand the
  Parquet + manifest to tradeac → define labels, purged walk-forward splits,
  baselines and metrics → record the experiment → accept/reject the hypothesis.
- **Outputs:** experiment record (hypothesis, snapshot IDs, params, metrics,
  decision) in tradeac; a short summary in NIP linked to the signal spec.
- **Guardrails:** preregistered hypothesis and window; no feature computed after
  the label start; report sample size and confidence intervals; a single
  in-sample win is not a decision.
- **Done:** a reviewer can rerun the experiment from the snapshot and reproduce
  the metrics.

### 5.6 `nip-signal-specs` (later)

- **Job:** promote only validated hypotheses into versioned signal specs with
  coverage thresholds and falsification criteria.
- **Flow:** draft spec → link experiment → set status → publish a snapshot to
  the UI.
- **Guardrails:** no spec without an accepted experiment; retired specs remain
  auditable; the UI labels research, never advice.

## 6. MCP tools: existing and proposed

Existing and usable now: `list_sources`, `create_source`, `update_source`,
`set_source_state`, `delete_source`, `list_podcast_subscriptions`,
`refresh_podcast_feeds`, `list_podcast_episodes`, `list_episode_page`,
`start_podcast_transcription`, `podcast_transcription_status`,
`list_podcast_transcription_jobs`, `cancel_podcast_transcription`,
`transcribe_podcast_episode`, `search_events`, `find_podcast_episode_event`,
`import_local_event`, `list_claims`, `extract_claims_from_event`,
`rebuild_narrative_clusters`, `rebuild_narrative_graph`,
`narrative_signal_snapshot`, `semantic_search`, `rebuild_semantic_index`,
`export_parquet_snapshot`, `list_etf_mappings`, `save_etf_mapping`,
`replace_editorial_candidates`, `list_editorial_candidates`,
`nip_provider_status`, `nip_extraction_status`, `nip_resource_status`.

Proposed extensions (names are drafts):

| Tool | Purpose | Used by |
|---|---|---|
| `backfill_podcast_transcripts` | bounded, resumable historical transcription per source; publisher-first | history-backfill |
| `podcast_transcript_coverage` | discovered / transcribed / publisher-vs-ASR counts by date | history-backfill |
| `extract_claims_from_event` (extended) | `schema_version`, `max_claims`, returns typed claims with entities and `novelty_key` | claim-typing |
| `list_claim_relations` / `rebuild_claim_relations` | restatement/supersession edges | claim-typing |
| `list_entities`, `upsert_entity`, `merge_entities`, `list_entity_mentions` | registry and links, versioned | entity-registry |
| `resolve_entity_mentions` | deterministic-first resolution report with unresolved queue | entity-registry |
| `rebuild_entity_features`, `list_entity_features` | weekly point-in-time features | temporal-features |
| `export_feature_matrix` | Parquet + manifest for a date range, `as_of` and label horizon | edge-experiments |
| `save_signal_spec`, `list_signal_specs` | versioned hypotheses and lifecycle | signal-specs |

Design note: extraction returns *structured* claims, but NIP still owns
validation (model/provider binding, offsets, caps) and persistence. The bridge
stays a transport; it must not become a second domain store.

## 7. Point-in-time and quality rules

1. `known_at` for a claim = max `ingested_at` of its evidence (and re-annotation
   time only if the annotation itself is the subject; it is not).
2. A feature row stamped `as_of` may use claims whose evidence was known by
   `as_of`; mixing later knowledge is a defect, not a convenience.
3. Labels start at the first tradable price **after** `known_at + publication
   lag` (for podcasts, the next session open, not the publication minute).
4. Dedupe: exact `novelty_key`, then embedding similarity above a reviewed
   threshold; never merge claims from different entities.
5. Precision review: 50–100 sampled claims per phase, stratified by
   provider/model and claim type; store the sample and the labels.
6. Coverage: every feature row states which sources were expected, which were
   delivered, and which weeks are missing.
7. Re-annotation: new `annotation_run_id`; readers use the latest non-rejected
   run; older runs remain queryable for audit.

## 8. tradeac / LightGBM contract (after migration)

- **Feature matrix:** one row per `entity_id × week_start`; columns
  `as_of`, `known_at`, feature values, coverage flags; `entity_id`, universe
  membership and sector as metadata, never as features unless point-in-time.
- **Manifest:** row count, date range, `formula_version`, extraction
  `annotation_run_id`, resolver version, source coverage, content hash.
- **Labels:** forward total return per horizon (1w/2w/4w), excess over the
  benchmark, aligned to the trading calendar; delisted names handled explicitly.
- **Splits:** purged walk-forward with an embargo of `label horizon +
  publication lag`; never a random split.
- **Baselines:** naive count/polarity features; constant; shuffled labels as a
  leakage smoke test.
- **Metrics:** rank IC, AUC (if classified), top-decile spread, turnover,
  Sharpe after fees and slippage; confidence intervals and sample size.
- **Decision:** preregister hypothesis, feature list, window and metric; record
  the decision with the snapshot IDs. Reject and iterate; do not tune on the
  test window.
- **Prerequisites from the migration:** lake layout (`market=*`, `features/`),
  trading calendar, corporate actions, point-in-time universe and ETF mappings.

## 9. Phases and gates

| Phase | Scope | Gate before the next phase |
|---|---|---|
| P0 | typed-claim contract, 4 claims/window, novelty dedupe, precision sample | precision ≥ 0.8; ≤ 20 claims per episode |
| P1 | entity registry + claim links | resolution precision ≥ 0.9; unresolved queue visible |
| P2 | weekly entity features + coverage | deterministic recompute; no `known_at` leakage |
| P3 | feature export + tradeac experiments (post-migration) | reproducible walk-forward; leakage checklist passed |
| P4 | signal specs and UI | accepted experiment per published spec |

## 10. Open questions for review

1. Entity scope: tickers only, or people/products/themes from the start?
2. Who owns the ticker/alias taxonomy, and how are delistings handled?
3. Does re-annotation replace existing claims in listings, or coexist by run?
4. Per-episode claim cap vs recall: is 4 per window / 20 per episode right?
5. Where do experiments live (proposed: tradeac) and how does NIP link to them?
6. Label horizon and publication lag per source type (podcast vs filing vs X)?
7. Minimum coverage/sample size before any signal may be called "tested"?
8. Rights and storage cost of backfilling hundreds of episodes per source?
9. Human review budget: who reviews claims/entities, and at what cadence?

## 11. Appendix — draft shapes

Typed claim (illustrative):

```json
{
  "claim_text": "NVIDIA announced an additional $150B authorized share repurchase.",
  "claim_type": "guidance",
  "subject_entity_id": "entity:nvda",
  "object_entity_id": null,
  "polarity": 1,
  "magnitude_value": 150,
  "magnitude_unit": "USD_billion",
  "horizon": "unspecified",
  "attribution": "guest:ceo",
  "certainty": "asserted",
  "novelty_key": "nvda|buyback|authorized-150b|unspecified",
  "evidence": [{ "event_id": "event-…", "quote": "…one hundred fifty billion dollar additional authorized share repurchase…" }],
  "annotation_version": "claims-v2",
  "annotation_run_id": "run-…"
}
```

Feature row (illustrative):

```json
{
  "entity_id": "entity:nvda",
  "week_start": "2026-11-09",
  "as_of": "2026-11-16T00:00:00Z",
  "known_at": "2026-11-15T18:40:00Z",
  "claim_count": 6,
  "mention_velocity": 2.1,
  "net_direction": 0.83,
  "novelty_rate": 0.5,
  "restatement_ratio": 0.17,
  "source_dispersion": 0.66,
  "guidance_revision": 150.0,
  "coverage": "partial",
  "data_quality_flags": ["missing_source:rss-forward-guidance"],
  "formula_version": "entity-features-v1",
  "derivation_run_id": "feature-run-…"
}
```
