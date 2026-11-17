-- Schema v8: configured-provider provenance and append-only review/consent
-- audit. DuckDB remains the canonical ledger; consent rows are audit events,
-- never in-place updates.

ALTER TABLE nip_claims ADD COLUMN IF NOT EXISTS provider_kind VARCHAR;
ALTER TABLE nip_claims ADD COLUMN IF NOT EXISTS provider_profile_id VARCHAR;
ALTER TABLE nip_claims ADD COLUMN IF NOT EXISTS reasoning_effort VARCHAR;

CREATE TABLE IF NOT EXISTS nip_provider_consents (
    consent_id VARCHAR PRIMARY KEY,
    action VARCHAR NOT NULL CHECK (action IN ('granted', 'revoked')),
    provider_kind VARCHAR NOT NULL,
    provider_id VARCHAR,
    model VARCHAR NOT NULL,
    scope VARCHAR NOT NULL,
    disclosure VARCHAR NOT NULL,
    actor VARCHAR NOT NULL,
    reason VARCHAR,
    recorded_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nip_provider_consents_binding
    ON nip_provider_consents (provider_kind, provider_id, model, scope, recorded_at);

CREATE TABLE IF NOT EXISTS nip_editorial_review_audit (
    review_id VARCHAR PRIMARY KEY,
    candidate_id VARCHAR NOT NULL,
    review_status VARCHAR NOT NULL,
    review_reason VARCHAR NOT NULL,
    reviewer VARCHAR NOT NULL,
    reviewed_at TIMESTAMPTZ NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nip_editorial_review_audit_candidate
    ON nip_editorial_review_audit (candidate_id, recorded_at);
