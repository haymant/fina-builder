CREATE TABLE IF NOT EXISTS nip_agent_narrative_analyses (
    analysis_id VARCHAR PRIMARY KEY,
    event_id VARCHAR NOT NULL,
    source_content_hash VARCHAR NOT NULL,
    extraction_run_id VARCHAR NOT NULL,
    producer VARCHAR NOT NULL,
    model VARCHAR NOT NULL,
    prompt_version VARCHAR NOT NULL,
    narrative_title VARCHAR NOT NULL,
    narrative_thesis VARCHAR NOT NULL,
    narrative_summary VARCHAR NOT NULL,
    provenance_status VARCHAR NOT NULL CHECK (provenance_status = 'caller_declared_external_agent_unattested'),
    created_at TIMESTAMPTZ NOT NULL,
    analysis_json VARCHAR NOT NULL,
    FOREIGN KEY (event_id) REFERENCES nip_events(event_id)
);

CREATE INDEX IF NOT EXISTS nip_agent_analysis_event_idx
    ON nip_agent_narrative_analyses(event_id, created_at);

CREATE TABLE IF NOT EXISTS nip_agent_entity_candidates (
    entity_id VARCHAR PRIMARY KEY,
    analysis_id VARCHAR NOT NULL,
    event_id VARCHAR NOT NULL,
    canonical_name VARCHAR NOT NULL,
    entity_type VARCHAR NOT NULL,
    surface_form VARCHAR NOT NULL,
    resolution_status VARCHAR NOT NULL CHECK (resolution_status = 'unresolved_candidate'),
    quote VARCHAR NOT NULL,
    start_offset INTEGER NOT NULL,
    end_offset INTEGER NOT NULL,
    FOREIGN KEY (analysis_id) REFERENCES nip_agent_narrative_analyses(analysis_id),
    FOREIGN KEY (event_id) REFERENCES nip_events(event_id)
);

CREATE TABLE IF NOT EXISTS nip_agent_claim_annotations (
    claim_id VARCHAR PRIMARY KEY,
    analysis_id VARCHAR NOT NULL,
    claim_type VARCHAR NOT NULL,
    polarity VARCHAR,
    horizon VARCHAR,
    FOREIGN KEY (claim_id) REFERENCES nip_claims(claim_id),
    FOREIGN KEY (analysis_id) REFERENCES nip_agent_narrative_analyses(analysis_id)
);

CREATE TABLE IF NOT EXISTS nip_agent_claim_entity_candidates (
    claim_id VARCHAR NOT NULL,
    entity_id VARCHAR NOT NULL,
    PRIMARY KEY (claim_id, entity_id),
    FOREIGN KEY (claim_id) REFERENCES nip_agent_claim_annotations(claim_id),
    FOREIGN KEY (entity_id) REFERENCES nip_agent_entity_candidates(entity_id)
);
