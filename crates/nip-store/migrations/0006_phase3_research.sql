CREATE TABLE IF NOT EXISTS nip_etf_mappings (
    mapping_id VARCHAR PRIMARY KEY,
    narrative_id VARCHAR NOT NULL,
    ticker VARCHAR NOT NULL,
    rationale VARCHAR NOT NULL,
    evidence_event_ids JSON NOT NULL,
    author VARCHAR NOT NULL,
    reviewer VARCHAR,
    version INTEGER NOT NULL,
    effective_from TIMESTAMPTZ NOT NULL,
    effective_to TIMESTAMPTZ,
    known_at TIMESTAMPTZ NOT NULL,
    review_status VARCHAR NOT NULL,
    ticker_status VARCHAR NOT NULL,
    market_data_coverage VARCHAR NOT NULL,
    mapping_validity VARCHAR NOT NULL,
    supersedes_mapping_id VARCHAR,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (narrative_id, ticker, version)
);

CREATE TABLE IF NOT EXISTS nip_editorial_candidates (
    candidate_id VARCHAR PRIMARY KEY,
    title_angle VARCHAR NOT NULL,
    narrative_ids JSON NOT NULL,
    claim_ids JSON NOT NULL,
    evidence_event_ids JSON NOT NULL,
    rank INTEGER NOT NULL,
    component_values JSON NOT NULL,
    derivation_run_id VARCHAR NOT NULL,
    review_status VARCHAR NOT NULL,
    review_reason VARCHAR,
    reviewer VARCHAR,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL
);
