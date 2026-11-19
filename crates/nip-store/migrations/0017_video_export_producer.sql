-- Verified output of the managed EDL export producer. Legacy v1 manifests remain unchanged.
CREATE TABLE IF NOT EXISTS video_export_manifests_v1 (
    manifest_id VARCHAR PRIMARY KEY,
    project_id VARCHAR NOT NULL,
    project_revision INTEGER NOT NULL CHECK (project_revision > 0),
    manifest_json VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_export_v1_project
    ON video_export_manifests_v1(project_id, project_revision, created_at);

CREATE TABLE IF NOT EXISTS video_export_run_requests (
    request_id VARCHAR PRIMARY KEY,
    payload_hash VARCHAR NOT NULL,
    job_id VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS video_export_asset_lineage_v1 (
    asset_id VARCHAR NOT NULL,
    asset_revision INTEGER NOT NULL CHECK (asset_revision > 0),
    upstream_kind VARCHAR NOT NULL,
    upstream_id VARCHAR NOT NULL,
    upstream_revision INTEGER,
    relationship VARCHAR NOT NULL,
    input_hash VARCHAR,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (asset_id, asset_revision, upstream_kind, upstream_id, relationship)
);
