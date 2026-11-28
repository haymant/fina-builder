-- 0023: Phase 5 NIP-owned interpretation records. Existing claim, evidence,
-- acquisition, and agent-candidate rows are not backfilled or rewritten.
ALTER TABLE nip_claim_evidence ADD COLUMN IF NOT EXISTS payload_kind VARCHAR;
ALTER TABLE nip_claim_evidence ADD COLUMN IF NOT EXISTS payload_hash VARCHAR;

CREATE TABLE IF NOT EXISTS nip_derivation_runs (
    derivation_run_id VARCHAR PRIMARY KEY,
    event_id VARCHAR NOT NULL,
    source_id VARCHAR NOT NULL,
    worker_site_id VARCHAR NOT NULL,
    worker_item_id VARCHAR NOT NULL,
    worker_run_id VARCHAR NOT NULL,
    producer_name VARCHAR NOT NULL,
    producer_version VARCHAR NOT NULL,
    contract_version INTEGER NOT NULL CHECK (contract_version IN (1, 2)),
    output_hash VARCHAR NOT NULL,
    run_payload_hash VARCHAR NOT NULL,
    claim_status VARCHAR NOT NULL CHECK (claim_status IN ('complete', 'partial', 'not_requested', 'failed', 'unspecified')),
    entity_status VARCHAR NOT NULL CHECK (entity_status IN ('complete', 'partial', 'not_requested', 'failed', 'unspecified')),
    claim_count INTEGER NOT NULL CHECK (claim_count >= 0),
    entity_count INTEGER NOT NULL CHECK (entity_count >= 0),
    claim_windows_covered INTEGER NOT NULL CHECK (claim_windows_covered >= 0),
    entity_windows_covered INTEGER NOT NULL CHECK (entity_windows_covered >= 0),
    availability VARCHAR NOT NULL CHECK (availability IN ('live', 'reconstructed')),
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ NOT NULL,
    known_at TIMESTAMPTZ NOT NULL,
    UNIQUE (worker_site_id, event_id, worker_run_id),
    FOREIGN KEY (event_id) REFERENCES nip_events(event_id),
    FOREIGN KEY (source_id) REFERENCES nip_sources(source_id)
);

CREATE TABLE IF NOT EXISTS nip_claim_annotations (
    claim_id VARCHAR PRIMARY KEY,
    derivation_run_id VARCHAR NOT NULL,
    worker_site_id VARCHAR NOT NULL,
    worker_item_id VARCHAR NOT NULL,
    worker_claim_id VARCHAR NOT NULL,
    subject VARCHAR NOT NULL,
    predicate VARCHAR NOT NULL,
    object VARCHAR NOT NULL,
    claim_text_origin VARCHAR NOT NULL CHECK (claim_text_origin IN ('producer_paraphrase', 'triplet_rendering')),
    claim_type VARCHAR CHECK (claim_type IN ('assertion', 'forecast', 'commitment', 'causal', 'comparative', 'other')),
    polarity VARCHAR CHECK (polarity IN ('positive', 'neutral', 'negative', 'mixed')),
    certainty_millis INTEGER CHECK (certainty_millis BETWEEN 0 AND 1000),
    horizon VARCHAR,
    magnitude_millis INTEGER,
    attribution VARCHAR,
    valid_from TIMESTAMPTZ,
    valid_to TIMESTAMPTZ,
    availability VARCHAR NOT NULL CHECK (availability IN ('live', 'reconstructed')),
    known_at TIMESTAMPTZ NOT NULL,
    source_output_hash VARCHAR NOT NULL,
    UNIQUE (derivation_run_id, worker_claim_id),
    FOREIGN KEY (claim_id) REFERENCES nip_claims(claim_id),
    FOREIGN KEY (derivation_run_id) REFERENCES nip_derivation_runs(derivation_run_id),
    CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from)
);

CREATE TABLE IF NOT EXISTS nip_claim_review_history (
    review_id VARCHAR PRIMARY KEY,
    claim_id VARCHAR NOT NULL,
    review_status VARCHAR NOT NULL CHECK (review_status IN ('accepted', 'rejected', 'correction_requested')),
    reviewer VARCHAR NOT NULL,
    reason VARCHAR,
    known_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (claim_id) REFERENCES nip_claim_annotations(claim_id)
);

CREATE TABLE IF NOT EXISTS nip_entities (
    entity_id VARCHAR PRIMARY KEY,
    entity_kind VARCHAR NOT NULL CHECK (entity_kind IN ('company', 'security', 'person', 'product', 'theme', 'index', 'other')),
    display_name VARCHAR NOT NULL,
    created_by VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS nip_entity_mentions (
    mention_id VARCHAR PRIMARY KEY,
    derivation_run_id VARCHAR NOT NULL,
    event_id VARCHAR NOT NULL,
    source_id VARCHAR NOT NULL,
    worker_site_id VARCHAR NOT NULL,
    worker_item_id VARCHAR NOT NULL,
    worker_entity_id VARCHAR NOT NULL,
    surface_form VARCHAR NOT NULL,
    producer_entity_type VARCHAR NOT NULL,
    canonical_id_hint VARCHAR NOT NULL,
    ticker_hint VARCHAR,
    availability VARCHAR NOT NULL CHECK (availability IN ('live', 'reconstructed')),
    known_at TIMESTAMPTZ NOT NULL,
    UNIQUE (derivation_run_id, worker_entity_id),
    FOREIGN KEY (derivation_run_id) REFERENCES nip_derivation_runs(derivation_run_id),
    FOREIGN KEY (event_id) REFERENCES nip_events(event_id),
    FOREIGN KEY (source_id) REFERENCES nip_sources(source_id)
);

CREATE TABLE IF NOT EXISTS nip_entity_mention_evidence (
    mention_id VARCHAR NOT NULL,
    evidence_ordinal INTEGER NOT NULL CHECK (evidence_ordinal >= 0),
    payload_kind VARCHAR NOT NULL CHECK (payload_kind IN ('item_content', 'transcript')),
    payload_hash VARCHAR NOT NULL,
    quote VARCHAR NOT NULL,
    start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
    end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
    PRIMARY KEY (mention_id, evidence_ordinal),
    FOREIGN KEY (mention_id) REFERENCES nip_entity_mentions(mention_id)
);

CREATE TABLE IF NOT EXISTS nip_entity_aliases (
    alias_id VARCHAR PRIMARY KEY,
    entity_id VARCHAR NOT NULL,
    alias VARCHAR NOT NULL,
    normalized_alias VARCHAR NOT NULL,
    source_id VARCHAR,
    valid_from TIMESTAMPTZ,
    valid_to TIMESTAMPTZ,
    known_at TIMESTAMPTZ NOT NULL,
    created_by VARCHAR NOT NULL,
    reason VARCHAR NOT NULL,
    FOREIGN KEY (entity_id) REFERENCES nip_entities(entity_id),
    FOREIGN KEY (source_id) REFERENCES nip_sources(source_id),
    CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from)
);

CREATE TABLE IF NOT EXISTS nip_entity_resolution_history (
    resolution_id VARCHAR PRIMARY KEY,
    mention_id VARCHAR,
    entity_id VARCHAR,
    decision_kind VARCHAR NOT NULL CHECK (decision_kind IN ('resolve', 'reject', 'merge', 'split')),
    reviewer VARCHAR NOT NULL,
    reason VARCHAR NOT NULL,
    known_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (mention_id) REFERENCES nip_entity_mentions(mention_id),
    FOREIGN KEY (entity_id) REFERENCES nip_entities(entity_id)
);

CREATE TABLE IF NOT EXISTS nip_claim_entity_links (
    claim_id VARCHAR NOT NULL,
    mention_id VARCHAR NOT NULL,
    role VARCHAR NOT NULL CHECK (role IN ('subject', 'object', 'speaker', 'author', 'other')),
    derivation_run_id VARCHAR NOT NULL,
    known_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (claim_id, mention_id, role),
    FOREIGN KEY (claim_id) REFERENCES nip_claim_annotations(claim_id),
    FOREIGN KEY (mention_id) REFERENCES nip_entity_mentions(mention_id),
    FOREIGN KEY (derivation_run_id) REFERENCES nip_derivation_runs(derivation_run_id)
);

CREATE TABLE IF NOT EXISTS nip_claim_relations (
    relation_id VARCHAR PRIMARY KEY,
    source_claim_id VARCHAR NOT NULL,
    target_claim_id VARCHAR NOT NULL,
    relation_kind VARCHAR NOT NULL CHECK (relation_kind IN ('restates', 'supports', 'contradicts', 'supersedes', 'duplicate_candidate')),
    provenance VARCHAR NOT NULL,
    producer VARCHAR NOT NULL,
    known_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (source_claim_id) REFERENCES nip_claim_annotations(claim_id),
    FOREIGN KEY (target_claim_id) REFERENCES nip_claim_annotations(claim_id),
    CHECK (source_claim_id <> target_claim_id)
);

CREATE TABLE IF NOT EXISTS nip_entity_instruments (
    mapping_id VARCHAR PRIMARY KEY,
    entity_id VARCHAR NOT NULL,
    tradeac_instrument_id VARCHAR NOT NULL,
    symbol VARCHAR NOT NULL,
    venue VARCHAR NOT NULL,
    review_status VARCHAR NOT NULL CHECK (review_status IN ('pending', 'accepted', 'rejected')),
    valid_from TIMESTAMPTZ,
    valid_to TIMESTAMPTZ,
    known_at TIMESTAMPTZ NOT NULL,
    reviewer VARCHAR NOT NULL,
    reason VARCHAR NOT NULL,
    FOREIGN KEY (entity_id) REFERENCES nip_entities(entity_id),
    CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from)
);

CREATE TABLE IF NOT EXISTS nip_feature_definitions (
    feature_key VARCHAR NOT NULL,
    definition_version INTEGER NOT NULL CHECK (definition_version > 0),
    description VARCHAR NOT NULL,
    unit VARCHAR NOT NULL,
    formula_version VARCHAR NOT NULL,
    formula_description VARCHAR NOT NULL,
    minimum_observations INTEGER NOT NULL CHECK (minimum_observations >= 0),
    registered_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (feature_key, definition_version)
);

CREATE TABLE IF NOT EXISTS nip_feature_runs (
    feature_run_id VARCHAR PRIMARY KEY,
    entity_id VARCHAR NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    as_of TIMESTAMPTZ NOT NULL,
    known_at TIMESTAMPTZ NOT NULL,
    input_hash VARCHAR NOT NULL,
    definition_set_hash VARCHAR NOT NULL,
    claim_count INTEGER NOT NULL CHECK (claim_count >= 0),
    source_count INTEGER NOT NULL CHECK (source_count >= 0),
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (entity_id, window_start, window_end, as_of, input_hash),
    FOREIGN KEY (entity_id) REFERENCES nip_entities(entity_id),
    CHECK (window_end > window_start)
);

CREATE TABLE IF NOT EXISTS nip_entity_feature_values (
    feature_run_id VARCHAR NOT NULL,
    feature_key VARCHAR NOT NULL,
    definition_version INTEGER NOT NULL,
    entity_id VARCHAR NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    as_of TIMESTAMPTZ NOT NULL,
    value_numeric DOUBLE,
    availability VARCHAR NOT NULL CHECK (availability IN ('available', 'insufficient', 'unavailable')),
    sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
    quality_flags VARCHAR NOT NULL,
    PRIMARY KEY (feature_run_id, feature_key, definition_version),
    FOREIGN KEY (feature_run_id) REFERENCES nip_feature_runs(feature_run_id),
    FOREIGN KEY (feature_key, definition_version) REFERENCES nip_feature_definitions(feature_key, definition_version),
    FOREIGN KEY (entity_id) REFERENCES nip_entities(entity_id),
    CHECK ((availability = 'available' AND value_numeric IS NOT NULL) OR (availability <> 'available' AND value_numeric IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_nip_derivation_event_known
    ON nip_derivation_runs(event_id, known_at);
CREATE INDEX IF NOT EXISTS idx_nip_claim_annotations_worker
    ON nip_claim_annotations(worker_site_id, worker_item_id, worker_claim_id);
CREATE INDEX IF NOT EXISTS idx_nip_entity_mentions_event
    ON nip_entity_mentions(event_id, known_at);
CREATE INDEX IF NOT EXISTS idx_nip_entity_mentions_worker
    ON nip_entity_mentions(worker_site_id, worker_item_id, worker_entity_id);
CREATE INDEX IF NOT EXISTS idx_nip_entity_aliases_normalized
    ON nip_entity_aliases(normalized_alias, source_id);
CREATE INDEX IF NOT EXISTS idx_nip_entity_resolution_mention
    ON nip_entity_resolution_history(mention_id, known_at);
CREATE INDEX IF NOT EXISTS idx_nip_claim_relations_source
    ON nip_claim_relations(source_claim_id, known_at);
CREATE INDEX IF NOT EXISTS idx_nip_feature_values_entity_asof
    ON nip_entity_feature_values(entity_id, as_of, feature_key);

INSERT INTO nip_feature_definitions
    (feature_key, definition_version, description, unit, formula_version,
     formula_description, minimum_observations, registered_at)
VALUES
    ('nip.claim_observation_count', 1, 'Distinct accepted source-event/fact observations for an entity in a window.', 'observations', 'v1', 'Trim, lowercase, and collapse whitespace in subject, predicate, and object; count distinct source/event/normalized-fact observations known by as_of and valid in the window.', 1, CURRENT_TIMESTAMP),
    ('nip.distinct_source_count', 1, 'Distinct NIP sources represented by accepted observations for an entity in a window.', 'sources', 'v1', 'Count distinct source IDs among eligible observations known by as_of and valid in the window.', 1, CURRENT_TIMESTAMP),
    ('nip.positive_claim_count', 1, 'Accepted source/event/fact observations with explicit positive polarity for an entity in a window.', 'observations', 'v1', 'Count distinct source/event/normalized-fact observations with positive polarity; normalization trims, lowercases, and collapses whitespace, and polarity is never inferred from text.', 1, CURRENT_TIMESTAMP),
    ('nip.neutral_claim_count', 1, 'Accepted source/event/fact observations with explicit neutral polarity for an entity in a window.', 'observations', 'v1', 'Count distinct source/event/normalized-fact observations with neutral polarity; normalization trims, lowercases, and collapses whitespace, and polarity is never inferred from text.', 1, CURRENT_TIMESTAMP),
    ('nip.negative_claim_count', 1, 'Accepted source/event/fact observations with explicit negative polarity for an entity in a window.', 'observations', 'v1', 'Count distinct source/event/normalized-fact observations with negative polarity; normalization trims, lowercases, and collapses whitespace, and polarity is never inferred from text.', 1, CURRENT_TIMESTAMP);
