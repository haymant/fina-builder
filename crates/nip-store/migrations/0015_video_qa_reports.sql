CREATE TABLE IF NOT EXISTS video_qa_reports_v2 (
    report_id VARCHAR PRIMARY KEY,
    timeline_id VARCHAR NOT NULL,
    timeline_revision INTEGER NOT NULL CHECK (timeline_revision > 0),
    project_id VARCHAR NOT NULL,
    input_fingerprint VARCHAR NOT NULL,
    evaluator_version VARCHAR NOT NULL,
    profile_id VARCHAR NOT NULL,
    profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
    report_json VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (timeline_id, timeline_revision, input_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_video_qa_v2_timeline ON video_qa_reports_v2(timeline_id, timeline_revision, created_at);
CREATE TABLE IF NOT EXISTS video_qa_run_requests (
    request_id VARCHAR PRIMARY KEY,
    payload_hash VARCHAR NOT NULL,
    job_id VARCHAR NOT NULL,
    report_id VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);
