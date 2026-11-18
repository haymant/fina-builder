-- Video Workspace V1: bounded visual specifications and typed export manifests.
-- Visual specs are canonical production records; LinkZag scene JSON remains an execution artifact.

CREATE TABLE IF NOT EXISTS video_visual_specs (
    spec_id VARCHAR NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    schema_version VARCHAR NOT NULL,
    project_id VARCHAR NOT NULL,
    episode_id VARCHAR NOT NULL,
    scene_id VARCHAR,
    shot_id VARCHAR,
    template VARCHAR NOT NULL CHECK (template IN ('evidence_card', 'quote_card', 'kinetic_text', 'chart_transition', 'caption', 'scene_transition')),
    spec_json VARCHAR NOT NULL,
    deterministic BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (spec_id, revision)
);

CREATE TABLE IF NOT EXISTS video_visual_spec_sources (
    spec_id VARCHAR NOT NULL,
    spec_revision INTEGER NOT NULL CHECK (spec_revision > 0),
    source_kind VARCHAR NOT NULL CHECK (source_kind IN ('event', 'claim', 'transcript_span', 'signal_snapshot')),
    source_id VARCHAR NOT NULL,
    source_revision INTEGER NOT NULL DEFAULT -1,
    start_offset INTEGER NOT NULL DEFAULT -1,
    end_offset INTEGER NOT NULL DEFAULT -1,
    quote VARCHAR,
    PRIMARY KEY (spec_id, spec_revision, source_kind, source_id, source_revision, start_offset, end_offset)
);

CREATE TABLE IF NOT EXISTS video_export_manifests (
    manifest_id VARCHAR PRIMARY KEY,
    schema_version VARCHAR NOT NULL,
    project_id VARCHAR NOT NULL,
    project_revision INTEGER NOT NULL CHECK (project_revision > 0),
    episode_id VARCHAR,
    storyboard_id VARCHAR,
    export_kind VARCHAR NOT NULL CHECK (export_kind IN ('storyboard', 'shot_list', 'asset_requirements', 'linkzag_scene', 'timeline', 'media_bundle')),
    deterministic BOOLEAN NOT NULL,
    manifest_json VARCHAR NOT NULL,
    content_hash VARCHAR,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS video_export_manifest_files (
    manifest_id VARCHAR NOT NULL,
    relative_path VARCHAR NOT NULL,
    format VARCHAR NOT NULL,
    content_hash VARCHAR,
    byte_size BIGINT,
    mime_type VARCHAR,
    width INTEGER,
    height INTEGER,
    duration_ms BIGINT,
    PRIMARY KEY (manifest_id, relative_path)
);

CREATE TABLE IF NOT EXISTS video_export_manifest_evidence (
    manifest_id VARCHAR NOT NULL,
    evidence_kind VARCHAR NOT NULL CHECK (evidence_kind IN ('event', 'claim')),
    evidence_id VARCHAR NOT NULL,
    start_offset INTEGER NOT NULL DEFAULT -1,
    end_offset INTEGER NOT NULL DEFAULT -1,
    PRIMARY KEY (manifest_id, evidence_kind, evidence_id, start_offset, end_offset)
);

CREATE INDEX IF NOT EXISTS idx_video_visual_specs_project ON video_visual_specs(project_id, revision);
CREATE INDEX IF NOT EXISTS idx_video_visual_spec_sources_source ON video_visual_spec_sources(source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_video_export_manifests_project ON video_export_manifests(project_id, project_revision, created_at);
