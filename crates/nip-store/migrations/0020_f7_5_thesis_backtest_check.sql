-- F7-5 (final e2e 2026-11-26): the F4 thesis flow added `thesis_backtest`
-- to the VideoAnalysisMode enum, but the 0011 CHECK on video_narratives
-- still allows only the four pre-thesis modes, so saving a thesis-led
-- narrative fails with a CHECK violation (surfaced to MCP callers only as
-- the coarse "NIP storage could not be initialized"). The review_status
-- CHECKs are widened to match the VideoReviewStatus enum for the same
-- reason: 0011 omitted 'in_review' on narratives and 'candidate' on
-- storyboards, while the enum (and the F4 flow) uses both.
-- 0011 is an applied migration and must not be edited; DuckDB 1.5.5 cannot
-- ALTER a CHECK, so the tables are rebuilt following the 0009/0019
-- precedent (CREATE _rebuild, INSERT SELECT, DROP, RENAME). The widened
-- sets match video_analysis_mode_as_str / video_review_status_as_str
-- exactly, so the validator and the tables can never disagree again.
-- NOTE: the rebuild CREATEs keep the original physical column order
-- (0011 columns first, 0019 ALTER columns appended): existing tests insert
-- into these tables with positional VALUES lists, so reordering columns
-- would break them.
CREATE TABLE video_narratives_rebuild (
    narrative_id VARCHAR NOT NULL,
    episode_id VARCHAR NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    summary VARCHAR,
    thesis VARCHAR,
    analysis_mode VARCHAR NOT NULL CHECK (analysis_mode IN ('human_authored', 'deterministic_candidate', 'model_assisted', 'mixed', 'thesis_backtest')),
    review_status VARCHAR NOT NULL CHECK (review_status IN ('draft', 'candidate', 'in_review', 'approved', 'rejected')),
    derivation_run_id VARCHAR,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    thesis_id VARCHAR,
    thesis_basis VARCHAR,
    as_of TIMESTAMPTZ,
    backtest_ids_json VARCHAR DEFAULT '[]',
    transcript_hash VARCHAR,
    PRIMARY KEY (narrative_id, revision)
);
INSERT INTO video_narratives_rebuild
    (narrative_id, episode_id, revision, summary, thesis, analysis_mode,
     review_status, derivation_run_id, thesis_id, thesis_basis, as_of,
     backtest_ids_json, transcript_hash, created_at, updated_at)
SELECT narrative_id, episode_id, revision, summary, thesis, analysis_mode,
     review_status, derivation_run_id, thesis_id, thesis_basis, as_of,
     backtest_ids_json, transcript_hash, created_at, updated_at
FROM video_narratives;
DROP TABLE video_narratives;
ALTER TABLE video_narratives_rebuild RENAME TO video_narratives;

CREATE TABLE video_storyboards_rebuild (
    storyboard_id VARCHAR NOT NULL,
    narrative_id VARCHAR NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    schema_version VARCHAR NOT NULL,
    review_status VARCHAR NOT NULL CHECK (review_status IN ('draft', 'candidate', 'in_review', 'approved', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    thesis_id VARCHAR,
    backtest_refs_json VARCHAR DEFAULT '[]',
    source_transcript_hash VARCHAR,
    PRIMARY KEY (storyboard_id, revision)
);
INSERT INTO video_storyboards_rebuild
    (storyboard_id, narrative_id, revision, schema_version, review_status,
     thesis_id, backtest_refs_json, source_transcript_hash, created_at, updated_at)
SELECT storyboard_id, narrative_id, revision, schema_version, review_status,
     thesis_id, backtest_refs_json, source_transcript_hash, created_at, updated_at
FROM video_storyboards;
DROP TABLE video_storyboards;
ALTER TABLE video_storyboards_rebuild RENAME TO video_storyboards;
