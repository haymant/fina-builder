CREATE TABLE IF NOT EXISTS nip_sources (
    source_id VARCHAR PRIMARY KEY,
    source_type VARCHAR NOT NULL CHECK (source_type IN ('podcast', 'local_document', 'other')),
    display_name VARCHAR NOT NULL,
    locator VARCHAR,
    rights_status VARCHAR NOT NULL DEFAULT 'unreviewed'
        CHECK (rights_status IN ('unreviewed', 'approved', 'blocked', 'purge_required')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS nip_events (
    event_id VARCHAR PRIMARY KEY,
    source_id VARCHAR NOT NULL,
    source_native_id VARCHAR,
    canonical_url VARCHAR,
    content_hash VARCHAR NOT NULL,
    content_text VARCHAR,
    published_at TIMESTAMPTZ,
    source_updated_at TIMESTAMPTZ,
    captured_at TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL,
    revision_of VARCHAR,
    schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0)
);

CREATE TABLE IF NOT EXISTS nip_ingestion_runs (
    run_id VARCHAR PRIMARY KEY,
    source_id VARCHAR,
    status VARCHAR NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
    started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ,
    error_code VARCHAR,
    safe_error_message VARCHAR
);
