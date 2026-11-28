-- 0022: canonical NIP records accepted from an explicitly bound worker.
-- This is a NIP-owned ledger, not a mirror of the worker's Parquet catalog.
CREATE TABLE IF NOT EXISTS nip_acquisition_runs (
    run_id VARCHAR PRIMARY KEY,
    worker_site_id VARCHAR NOT NULL,
    worker_run_id VARCHAR NOT NULL,
    source_id VARCHAR NOT NULL,
    producer_name VARCHAR NOT NULL,
    producer_version VARCHAR NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (worker_site_id, worker_run_id)
);

CREATE TABLE IF NOT EXISTS nip_acquisition_items (
    worker_site_id VARCHAR NOT NULL,
    worker_item_id VARCHAR NOT NULL,
    worker_source_key VARCHAR NOT NULL,
    source_id VARCHAR NOT NULL,
    event_id VARCHAR NOT NULL UNIQUE,
    run_id VARCHAR NOT NULL,
    source_url VARCHAR NOT NULL,
    title VARCHAR NOT NULL,
    content_kind VARCHAR NOT NULL CHECK (content_kind IN ('article', 'transcript', 'filing', 'other')),
    availability VARCHAR NOT NULL CHECK (availability IN ('live', 'reconstructed')),
    worker_content_hash VARCHAR NOT NULL,
    payload_hash VARCHAR NOT NULL,
    worker_ingested_at TIMESTAMPTZ NOT NULL,
    valid_from TIMESTAMPTZ NOT NULL,
    valid_to TIMESTAMPTZ,
    recorded_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (worker_site_id, worker_item_id)
);

CREATE TABLE IF NOT EXISTS nip_acquisition_transcripts (
    event_id VARCHAR PRIMARY KEY,
    transcript_text VARCHAR NOT NULL,
    content_hash VARCHAR NOT NULL,
    language VARCHAR,
    method VARCHAR NOT NULL,
    model VARCHAR,
    model_version VARCHAR,
    transcribed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nip_acquisition_items_source
    ON nip_acquisition_items(source_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_nip_acquisition_items_event
    ON nip_acquisition_items(event_id);
CREATE INDEX IF NOT EXISTS idx_nip_acquisition_runs_source
    ON nip_acquisition_runs(source_id, started_at);
