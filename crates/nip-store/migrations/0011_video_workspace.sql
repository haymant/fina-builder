-- Video Workspace V0: production metadata and evidence lineage.
-- NIP events/claims remain canonical; these tables store only a versioned
-- production projection and validated references back to that canonical ledger.

CREATE TABLE IF NOT EXISTS video_projects (
    project_id VARCHAR NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    title VARCHAR NOT NULL,
    language VARCHAR NOT NULL DEFAULT 'en',
    target_platform VARCHAR NOT NULL,
    target_duration_ms BIGINT,
    audience VARCHAR,
    style_profile VARCHAR,
    status VARCHAR NOT NULL CHECK (status IN ('draft', 'in_review', 'ready', 'rendering', 'exported', 'archived')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (project_id, revision)
);

CREATE TABLE IF NOT EXISTS video_project_heads (
    project_id VARCHAR PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS video_episodes (
    episode_id VARCHAR NOT NULL,
    project_id VARCHAR NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    title VARCHAR,
    as_of TIMESTAMPTZ,
    disclosure VARCHAR,
    status VARCHAR NOT NULL CHECK (status IN ('draft', 'in_review', 'ready', 'archived')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (episode_id, revision)
);

CREATE TABLE IF NOT EXISTS video_episode_heads (
    episode_id VARCHAR PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS video_episode_evidence (
    episode_id VARCHAR NOT NULL,
    episode_revision INTEGER NOT NULL CHECK (episode_revision > 0),
    evidence_kind VARCHAR NOT NULL CHECK (evidence_kind IN ('event', 'claim')),
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

CREATE TABLE IF NOT EXISTS video_narratives (
    narrative_id VARCHAR NOT NULL,
    episode_id VARCHAR NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    summary VARCHAR,
    thesis VARCHAR,
    analysis_mode VARCHAR NOT NULL CHECK (analysis_mode IN ('human_authored', 'deterministic_candidate', 'model_assisted', 'mixed')),
    review_status VARCHAR NOT NULL CHECK (review_status IN ('draft', 'candidate', 'approved', 'rejected')),
    derivation_run_id VARCHAR,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (narrative_id, revision)
);

CREATE TABLE IF NOT EXISTS video_narrative_evidence (
    narrative_id VARCHAR NOT NULL,
    narrative_revision INTEGER NOT NULL CHECK (narrative_revision > 0),
    evidence_kind VARCHAR NOT NULL CHECK (evidence_kind IN ('event', 'claim')),
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

CREATE TABLE IF NOT EXISTS video_storyboards (
    storyboard_id VARCHAR NOT NULL,
    narrative_id VARCHAR NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    schema_version VARCHAR NOT NULL,
    review_status VARCHAR NOT NULL CHECK (review_status IN ('draft', 'in_review', 'approved', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (storyboard_id, revision)
);

CREATE TABLE IF NOT EXISTS video_scenes (
    scene_id VARCHAR NOT NULL,
    storyboard_id VARCHAR NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    purpose VARCHAR NOT NULL,
    narration_text VARCHAR,
    visual_intent VARCHAR,
    duration_ms BIGINT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (scene_id, revision)
);

CREATE TABLE IF NOT EXISTS video_scene_evidence (
    scene_id VARCHAR NOT NULL,
    scene_revision INTEGER NOT NULL CHECK (scene_revision > 0),
    evidence_kind VARCHAR NOT NULL CHECK (evidence_kind IN ('event', 'claim')),
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

CREATE TABLE IF NOT EXISTS video_shots (
    shot_id VARCHAR NOT NULL,
    scene_id VARCHAR NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    shot_type VARCHAR NOT NULL,
    duration_ms BIGINT NOT NULL CHECK (duration_ms > 0),
    camera_motion VARCHAR,
    visual_prompt VARCHAR,
    status VARCHAR NOT NULL CHECK (status IN ('planned', 'ready', 'rendering', 'blocked', 'complete')),
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (shot_id, revision)
);

CREATE TABLE IF NOT EXISTS video_shot_evidence (
    shot_id VARCHAR NOT NULL,
    shot_revision INTEGER NOT NULL CHECK (shot_revision > 0),
    evidence_kind VARCHAR NOT NULL CHECK (evidence_kind IN ('event', 'claim')),
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

CREATE TABLE IF NOT EXISTS video_assets (
    asset_id VARCHAR NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    asset_kind VARCHAR NOT NULL,
    relative_path VARCHAR,
    mime_type VARCHAR,
    content_hash VARCHAR,
    width INTEGER,
    height INTEGER,
    duration_ms BIGINT,
    provider VARCHAR NOT NULL,
    workflow_id VARCHAR,
    model VARCHAR,
    reproducibility VARCHAR NOT NULL CHECK (reproducibility IN ('deterministic', 'seeded_nondeterministic', 'nondeterministic', 'fixture', 'unknown')),
    capability_state VARCHAR NOT NULL CHECK (capability_state IN ('ready', 'not_configured', 'runtime_unavailable', 'model_missing', 'candidate_only', 'human_review_required', 'failed')),
    license_state VARCHAR NOT NULL,
    job_id VARCHAR,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (asset_id, revision)
);

CREATE TABLE IF NOT EXISTS video_asset_lineage (
    asset_id VARCHAR NOT NULL,
    asset_revision INTEGER NOT NULL CHECK (asset_revision > 0),
    upstream_kind VARCHAR NOT NULL CHECK (upstream_kind IN ('event', 'claim', 'visual_spec', 'asset', 'scene', 'shot')),
    upstream_id VARCHAR NOT NULL,
    upstream_revision INTEGER,
    relationship VARCHAR NOT NULL,
    input_hash VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (asset_id, asset_revision, upstream_kind, upstream_id, relationship)
);

CREATE TABLE IF NOT EXISTS video_shot_assets (
    shot_id VARCHAR NOT NULL,
    shot_revision INTEGER NOT NULL CHECK (shot_revision > 0),
    asset_id VARCHAR NOT NULL,
    asset_revision INTEGER NOT NULL,
    role VARCHAR NOT NULL CHECK (role IN ('required', 'selected', 'produced', 'rejected')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (shot_id, shot_revision, asset_id, asset_revision, role)
);

CREATE TABLE IF NOT EXISTS video_workflows (
    workflow_id VARCHAR NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    capability VARCHAR NOT NULL,
    provider_adapter VARCHAR NOT NULL,
    schema_version VARCHAR NOT NULL,
    model_identity VARCHAR,
    parameters_json VARCHAR NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (workflow_id, revision)
);

CREATE TABLE IF NOT EXISTS video_jobs (
    job_id VARCHAR PRIMARY KEY,
    operation VARCHAR NOT NULL,
    status VARCHAR NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    input_revision INTEGER,
    progress_millis INTEGER NOT NULL DEFAULT 0 CHECK (progress_millis BETWEEN 0 AND 100000),
    cancellation_requested BOOLEAN NOT NULL DEFAULT FALSE,
    resource_estimate_json VARCHAR,
    output_manifest_json VARCHAR,
    safe_error_message VARCHAR,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS video_qa_reports (
    report_id VARCHAR PRIMARY KEY,
    project_id VARCHAR NOT NULL,
    input_revision INTEGER NOT NULL,
    status VARCHAR NOT NULL CHECK (status IN ('passed', 'warning', 'blocked')),
    findings_json VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS video_timelines (
    timeline_id VARCHAR NOT NULL,
    project_id VARCHAR NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    timeline_json VARCHAR NOT NULL,
    export_revision INTEGER NOT NULL DEFAULT 1 CHECK (export_revision > 0),
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (timeline_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_video_episode_project ON video_episodes(project_id, revision);
CREATE INDEX IF NOT EXISTS idx_video_narrative_episode ON video_narratives(episode_id, revision);
CREATE INDEX IF NOT EXISTS idx_video_storyboard_narrative ON video_storyboards(narrative_id, revision);
CREATE INDEX IF NOT EXISTS idx_video_scene_storyboard ON video_scenes(storyboard_id, revision, ordinal);
CREATE INDEX IF NOT EXISTS idx_video_shot_scene ON video_shots(scene_id, revision, ordinal);
CREATE INDEX IF NOT EXISTS idx_video_asset_job ON video_assets(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs(status, created_at);
