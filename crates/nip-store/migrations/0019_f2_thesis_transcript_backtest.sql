-- F2 (NIP dashboard revamp §e.2): mirror fina-scraper extraction tiers and
-- review statuses on the claim/event read models, and add thesis, transcript,
-- and backtest-evidence record types (§c.5, §d.2). fina-builder stores what
-- fina-scraper returns at import/record time; it never re-derives NLP.
-- New columns are NULL for legacy rows: a claim/event without a tier is
-- unlabelled, never silently treated as verified.
-- NOTE: DuckDB 1.5.5 supports neither an inline CHECK on ADD COLUMN
-- ("Adding columns with constraints not yet supported") nor ALTER TABLE
-- ADD CONSTRAINT ("No support for that ALTER TABLE option yet"), so these
-- columns carry no SQL CHECK. The value domains are enforced in Rust
-- instead: writes go through the ExtractionTier / ClaimReviewStatus /
-- ThesisBasis enums (as_str), reads parse back and treat unknown strings
-- as unlabelled (None). The CHECKs on the new CREATE TABLEs below still
-- apply, since CREATE TABLE accepts them.
ALTER TABLE nip_events ADD COLUMN IF NOT EXISTS extraction_tier VARCHAR;
ALTER TABLE nip_events ADD COLUMN IF NOT EXISTS review_status VARCHAR;
ALTER TABLE nip_claims ADD COLUMN IF NOT EXISTS extraction_tier VARCHAR;
ALTER TABLE nip_claims ADD COLUMN IF NOT EXISTS review_status VARCHAR;

-- Thesis list/detail (§c.5). claim_ids / rejected_claims are JSON arrays;
-- rejected claims stay listed with reasons as an audit trail.
CREATE TABLE IF NOT EXISTS nip_theses (
    thesis_id VARCHAR PRIMARY KEY,
    title VARCHAR NOT NULL,
    entity_symbol VARCHAR,
    direction VARCHAR NOT NULL CHECK (direction IN ('long', 'short', 'neutral')),
    horizon VARCHAR,
    as_of TIMESTAMPTZ NOT NULL,
    thesis_basis VARCHAR NOT NULL
        CHECK (thesis_basis IN ('llm_verified_only', 'provisional_fast_glance')),
    confidence_millis INTEGER
        CHECK (confidence_millis IS NULL
               OR confidence_millis BETWEEN 0 AND 1000),
    reason VARCHAR,
    status VARCHAR NOT NULL
        CHECK (status IN ('draft', 'llm_reviewed', 'backtested', 'transcript_ready',
                          'video_ready', 'published', 'rejected', 'invalidated')),
    invalidation_condition VARCHAR,
    what_would_change_mind VARCHAR,
    claim_ids_json VARCHAR NOT NULL DEFAULT '[]',
    rejected_claims_json VARCHAR NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nip_theses_status_asof
    ON nip_theses(status, as_of);
CREATE INDEX IF NOT EXISTS idx_nip_theses_entity_asof
    ON nip_theses(entity_symbol, as_of);

-- Commentary transcripts (§c.5/§d.2). A transcript for a provisional thesis
-- does not exist; the store refuses to record one (see save_transcript).
CREATE TABLE IF NOT EXISTS nip_transcripts (
    transcript_id VARCHAR PRIMARY KEY,
    thesis_id VARCHAR NOT NULL,
    transcript_hash VARCHAR NOT NULL,
    summary VARCHAR,
    beats_json VARCHAR NOT NULL DEFAULT '[]',
    fina_import_path VARCHAR,
    created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nip_transcripts_thesis_created
    ON nip_transcripts(thesis_id, created_at);

-- Recorded ablation evidence (§c.5/§d.2): Run A (TA+macro) vs Run B
-- (TA+macro+$narr_* tier2_llm). Metrics/delta are JSON objects; missing
-- metrics are null inside the JSON, never 0.
CREATE TABLE IF NOT EXISTS nip_backtest_evidence (
    backtest_id VARCHAR PRIMARY KEY,
    thesis_id VARCHAR NOT NULL,
    run_id_a VARCHAR NOT NULL,
    run_id_b VARCHAR NOT NULL,
    config_fingerprint VARCHAR,
    metrics_a_json VARCHAR NOT NULL DEFAULT '{}',
    metrics_b_json VARCHAR NOT NULL DEFAULT '{}',
    delta_json VARCHAR NOT NULL DEFAULT '{}',
    verdict VARCHAR NOT NULL
        CHECK (verdict IN ('supported', 'not_supported', 'could_not_run')),
    could_not_run_reason VARCHAR,
    recorded_at TIMESTAMPTZ NOT NULL,
    source VARCHAR NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nip_backtest_evidence_thesis_recorded
    ON nip_backtest_evidence(thesis_id, recorded_at);

-- Video flow fields (§d.2). Old rows read back with NULL/empty values.
ALTER TABLE video_episodes ADD COLUMN IF NOT EXISTS thesis_id VARCHAR;
ALTER TABLE video_episodes ADD COLUMN IF NOT EXISTS transcript_id VARCHAR;
ALTER TABLE video_episodes ADD COLUMN IF NOT EXISTS transcript_hash VARCHAR;
ALTER TABLE video_episodes ADD COLUMN IF NOT EXISTS origin VARCHAR;
ALTER TABLE video_narratives ADD COLUMN IF NOT EXISTS thesis_id VARCHAR;
ALTER TABLE video_narratives ADD COLUMN IF NOT EXISTS thesis_basis VARCHAR;
ALTER TABLE video_narratives ADD COLUMN IF NOT EXISTS as_of TIMESTAMPTZ;
ALTER TABLE video_narratives ADD COLUMN IF NOT EXISTS backtest_ids_json VARCHAR
    DEFAULT '[]';
ALTER TABLE video_narratives ADD COLUMN IF NOT EXISTS transcript_hash VARCHAR;
ALTER TABLE video_storyboards ADD COLUMN IF NOT EXISTS thesis_id VARCHAR;
ALTER TABLE video_storyboards ADD COLUMN IF NOT EXISTS backtest_refs_json VARCHAR
    DEFAULT '[]';
ALTER TABLE video_storyboards ADD COLUMN IF NOT EXISTS source_transcript_hash VARCHAR;

-- Widen the evidence-kind CHECKs (§d.2). The 0011/0012 tables only allowed
-- ('event', 'claim'), so a 'backtest'/'thesis' ref that
-- validate_video_evidence accepts was rejected by the table on INSERT.
-- 0011/0012 are applied migrations and must not be edited; DuckDB 1.5.5
-- cannot ALTER a CHECK, so the tables are rebuilt following the 0009
-- precedent (CREATE _rebuild, INSERT SELECT, DROP, RENAME). The widened
-- sets match valid_video_evidence_kind exactly, so the validator and the
-- tables can never disagree again. Upstream kinds (video_asset_lineage)
-- are untouched: lineage upstreams stay event/claim/media by design.
CREATE TABLE video_episode_evidence_rebuild (
    episode_id VARCHAR NOT NULL,
    episode_revision INTEGER NOT NULL CHECK (episode_revision > 0),
    evidence_kind VARCHAR NOT NULL CHECK (evidence_kind IN ('event', 'claim', 'backtest', 'thesis')),
    evidence_id VARCHAR NOT NULL,
    start_offset INTEGER NOT NULL DEFAULT -1,
    end_offset INTEGER NOT NULL DEFAULT -1,
    quote VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (start_offset >= -1),
    CHECK (end_offset >= -1),
    CHECK (start_offset = -1 OR end_offset = -1 OR start_offset <= end_offset),
    PRIMARY KEY (episode_id, episode_revision, evidence_kind, evidence_id, start_offset, end_offset)
);
INSERT INTO video_episode_evidence_rebuild
    (episode_id, episode_revision, evidence_kind, evidence_id, start_offset, end_offset, quote, created_at)
SELECT episode_id, episode_revision, evidence_kind, evidence_id, start_offset, end_offset, quote, created_at
FROM video_episode_evidence;
DROP TABLE video_episode_evidence;
ALTER TABLE video_episode_evidence_rebuild RENAME TO video_episode_evidence;

CREATE TABLE video_narrative_evidence_rebuild (
    narrative_id VARCHAR NOT NULL,
    narrative_revision INTEGER NOT NULL CHECK (narrative_revision > 0),
    evidence_kind VARCHAR NOT NULL CHECK (evidence_kind IN ('event', 'claim', 'backtest', 'thesis')),
    evidence_id VARCHAR NOT NULL,
    start_offset INTEGER NOT NULL DEFAULT -1,
    end_offset INTEGER NOT NULL DEFAULT -1,
    quote VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (start_offset >= -1),
    CHECK (end_offset >= -1),
    CHECK (start_offset = -1 OR end_offset = -1 OR start_offset <= end_offset),
    PRIMARY KEY (narrative_id, narrative_revision, evidence_kind, evidence_id, start_offset, end_offset)
);
INSERT INTO video_narrative_evidence_rebuild
    (narrative_id, narrative_revision, evidence_kind, evidence_id, start_offset, end_offset, quote, created_at)
SELECT narrative_id, narrative_revision, evidence_kind, evidence_id, start_offset, end_offset, quote, created_at
FROM video_narrative_evidence;
DROP TABLE video_narrative_evidence;
ALTER TABLE video_narrative_evidence_rebuild RENAME TO video_narrative_evidence;

CREATE TABLE video_scene_evidence_rebuild (
    scene_id VARCHAR NOT NULL,
    scene_revision INTEGER NOT NULL CHECK (scene_revision > 0),
    evidence_kind VARCHAR NOT NULL CHECK (evidence_kind IN ('event', 'claim', 'backtest', 'thesis')),
    evidence_id VARCHAR NOT NULL,
    start_offset INTEGER NOT NULL DEFAULT -1,
    end_offset INTEGER NOT NULL DEFAULT -1,
    quote VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (start_offset >= -1),
    CHECK (end_offset >= -1),
    CHECK (start_offset = -1 OR end_offset = -1 OR start_offset <= end_offset),
    PRIMARY KEY (scene_id, scene_revision, evidence_kind, evidence_id, start_offset, end_offset)
);
INSERT INTO video_scene_evidence_rebuild
    (scene_id, scene_revision, evidence_kind, evidence_id, start_offset, end_offset, quote, created_at)
SELECT scene_id, scene_revision, evidence_kind, evidence_id, start_offset, end_offset, quote, created_at
FROM video_scene_evidence;
DROP TABLE video_scene_evidence;
ALTER TABLE video_scene_evidence_rebuild RENAME TO video_scene_evidence;

CREATE TABLE video_shot_evidence_rebuild (
    shot_id VARCHAR NOT NULL,
    shot_revision INTEGER NOT NULL CHECK (shot_revision > 0),
    evidence_kind VARCHAR NOT NULL CHECK (evidence_kind IN ('event', 'claim', 'backtest', 'thesis')),
    evidence_id VARCHAR NOT NULL,
    start_offset INTEGER NOT NULL DEFAULT -1,
    end_offset INTEGER NOT NULL DEFAULT -1,
    quote VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (start_offset >= -1),
    CHECK (end_offset >= -1),
    CHECK (start_offset = -1 OR end_offset = -1 OR start_offset <= end_offset),
    PRIMARY KEY (shot_id, shot_revision, evidence_kind, evidence_id, start_offset, end_offset)
);
INSERT INTO video_shot_evidence_rebuild
    (shot_id, shot_revision, evidence_kind, evidence_id, start_offset, end_offset, quote, created_at)
SELECT shot_id, shot_revision, evidence_kind, evidence_id, start_offset, end_offset, quote, created_at
FROM video_shot_evidence;
DROP TABLE video_shot_evidence;
ALTER TABLE video_shot_evidence_rebuild RENAME TO video_shot_evidence;

CREATE TABLE video_export_manifest_evidence_rebuild (
    manifest_id VARCHAR NOT NULL,
    evidence_kind VARCHAR NOT NULL CHECK (evidence_kind IN ('event', 'claim', 'backtest', 'thesis')),
    evidence_id VARCHAR NOT NULL,
    start_offset INTEGER NOT NULL DEFAULT -1,
    end_offset INTEGER NOT NULL DEFAULT -1,
    PRIMARY KEY (manifest_id, evidence_kind, evidence_id, start_offset, end_offset)
);
INSERT INTO video_export_manifest_evidence_rebuild
    (manifest_id, evidence_kind, evidence_id, start_offset, end_offset)
SELECT manifest_id, evidence_kind, evidence_id, start_offset, end_offset
FROM video_export_manifest_evidence;
DROP TABLE video_export_manifest_evidence;
ALTER TABLE video_export_manifest_evidence_rebuild RENAME TO video_export_manifest_evidence;

CREATE TABLE video_visual_spec_sources_rebuild (
    spec_id VARCHAR NOT NULL,
    spec_revision INTEGER NOT NULL CHECK (spec_revision > 0),
    source_kind VARCHAR NOT NULL CHECK (source_kind IN ('event', 'claim', 'transcript_span', 'signal_snapshot', 'backtest', 'thesis')),
    source_id VARCHAR NOT NULL,
    source_revision INTEGER NOT NULL DEFAULT -1,
    start_offset INTEGER NOT NULL DEFAULT -1,
    end_offset INTEGER NOT NULL DEFAULT -1,
    quote VARCHAR,
    PRIMARY KEY (spec_id, spec_revision, source_kind, source_id, source_revision, start_offset, end_offset)
);
INSERT INTO video_visual_spec_sources_rebuild
    (spec_id, spec_revision, source_kind, source_id, source_revision, start_offset, end_offset, quote)
SELECT spec_id, spec_revision, source_kind, source_id, source_revision, start_offset, end_offset, quote
FROM video_visual_spec_sources;
DROP TABLE video_visual_spec_sources;
ALTER TABLE video_visual_spec_sources_rebuild RENAME TO video_visual_spec_sources;
CREATE INDEX IF NOT EXISTS idx_video_visual_spec_sources_source ON video_visual_spec_sources(source_kind, source_id);
