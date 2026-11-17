ALTER TABLE nip_sources ADD COLUMN IF NOT EXISTS rights_statement VARCHAR;

CREATE TABLE IF NOT EXISTS nip_claims (
    claim_id VARCHAR PRIMARY KEY,
    claim_text VARCHAR NOT NULL,
    speaker_or_author VARCHAR,
    confidence_millis INTEGER NOT NULL CHECK (confidence_millis BETWEEN 0 AND 1000),
    extraction_run_id VARCHAR NOT NULL,
    provider VARCHAR NOT NULL,
    model VARCHAR NOT NULL,
    prompt_version VARCHAR NOT NULL,
    extracted_at TIMESTAMPTZ NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0)
);

CREATE TABLE IF NOT EXISTS nip_claim_evidence (
    claim_id VARCHAR NOT NULL,
    event_id VARCHAR NOT NULL,
    quote VARCHAR,
    start_offset INTEGER,
    end_offset INTEGER,
    PRIMARY KEY (claim_id, event_id),
    FOREIGN KEY (claim_id) REFERENCES nip_claims(claim_id),
    FOREIGN KEY (event_id) REFERENCES nip_events(event_id)
);
