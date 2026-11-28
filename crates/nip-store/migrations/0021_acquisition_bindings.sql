-- 0021: explicit NIP-owned worker-profile/source binding review records.
-- Worker site IDs are compatibility keys only; this table never promotes them
-- to canonical source identity and is not a write-through scraper catalog.

CREATE TABLE IF NOT EXISTS nip_acquisition_bindings (
    worker_site_id VARCHAR PRIMARY KEY,
    source_id VARCHAR NOT NULL,
    worker_kind VARCHAR NOT NULL,
    worker_locator VARCHAR NOT NULL,
    state VARCHAR NOT NULL CHECK (state IN ('bound', 'unbound')),
    reviewed_by VARCHAR NOT NULL,
    review_note VARCHAR,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_nip_acquisition_bindings_source
    ON nip_acquisition_bindings(source_id);
