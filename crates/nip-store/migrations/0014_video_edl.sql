-- Native, immutable EDL v1 records. Legacy video_timelines remain unchanged.
CREATE TABLE IF NOT EXISTS video_edl_timelines (
    timeline_id VARCHAR NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    project_id VARCHAR NOT NULL,
    project_revision INTEGER NOT NULL CHECK (project_revision > 0),
    episode_id VARCHAR NOT NULL,
    episode_revision INTEGER NOT NULL CHECK (episode_revision > 0),
    storyboard_id VARCHAR NOT NULL,
    storyboard_revision INTEGER NOT NULL CHECK (storyboard_revision > 0),
    profile_id VARCHAR NOT NULL,
    profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
    schema_version VARCHAR NOT NULL,
    build_version VARCHAR NOT NULL,
    build_status VARCHAR NOT NULL CHECK (build_status = 'ready'),
    timeline_hash VARCHAR NOT NULL,
    input_fingerprint VARCHAR NOT NULL,
    manifest_json VARCHAR NOT NULL,
    findings_json VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (timeline_id, revision),
    UNIQUE (input_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_video_edl_project ON video_edl_timelines(project_id, project_revision, created_at);

-- Stores at most the latest 1000 request keys. Payload hashes prevent key reuse
-- with changed input; blocked diagnostics are also replayable without persisting
-- a blocked timeline as a ready record.
CREATE TABLE IF NOT EXISTS video_edl_build_requests (
    request_id VARCHAR PRIMARY KEY,
    payload_hash VARCHAR NOT NULL,
    result_json VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_video_edl_build_requests_created ON video_edl_build_requests(created_at, request_id);
