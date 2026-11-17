-- 0009: source registry independent of the podcast adapter.
--
-- `source_type` stays the coarse class used by event queries
-- ('podcast' | 'local_document' | 'other'); `source_kind` is the registry kind
-- that the UI and agents manage (podcast, company_meeting, filing, reddit, x,
-- web, local_document, other).
--
-- DuckDB cannot add NOT NULL columns, so the columns are added with a default
-- (which backfills existing rows) and the backfill below makes the value
-- explicit for every pre-existing row.

ALTER TABLE nip_sources ADD COLUMN IF NOT EXISTS source_kind VARCHAR DEFAULT 'other';
ALTER TABLE nip_sources ADD COLUMN IF NOT EXISTS state VARCHAR DEFAULT 'active';
ALTER TABLE nip_sources ADD COLUMN IF NOT EXISTS topics_json VARCHAR DEFAULT '[]';
ALTER TABLE nip_sources ADD COLUMN IF NOT EXISTS poll_interval_minutes INTEGER DEFAULT 360;
ALTER TABLE nip_sources ADD COLUMN IF NOT EXISTS per_scan_limit INTEGER DEFAULT 3;
ALTER TABLE nip_sources ADD COLUMN IF NOT EXISTS notes VARCHAR;
ALTER TABLE nip_sources ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

UPDATE nip_sources SET source_kind = 'podcast' WHERE source_type = 'podcast';
UPDATE nip_sources SET source_kind = 'local_document' WHERE source_type = 'local_document';
UPDATE nip_sources SET source_kind = 'other' WHERE source_kind IS NULL;
UPDATE nip_sources SET state = 'active' WHERE state IS NULL;
UPDATE nip_sources SET topics_json = '[]' WHERE topics_json IS NULL;
UPDATE nip_sources SET poll_interval_minutes = 360 WHERE poll_interval_minutes IS NULL;
UPDATE nip_sources SET per_scan_limit = 3 WHERE per_scan_limit IS NULL;
UPDATE nip_sources SET updated_at = created_at WHERE updated_at IS NULL;

-- Carry the podcast subscription lifecycle into the registry so pause/remove is
-- a registry fact, not an adapter detail.
UPDATE nip_sources
SET state = COALESCE(
    (SELECT s.state FROM nip_podcast_subscriptions s WHERE s.source_id = nip_sources.source_id),
    'active'
);

CREATE INDEX IF NOT EXISTS idx_nip_sources_kind_state ON nip_sources(source_kind, state);

-- DuckDB enforces a foreign key on UPDATE by rewriting the parent row, which
-- fails as soon as a child row exists ("still referenced by a foreign key").
-- The registry must update `nip_sources` and `nip_podcast_subscriptions` in
-- place, so the podcast adapter tables are rebuilt without FK constraints.
-- Referential integrity stays an application invariant: every delete goes
-- through `Store::delete_source`, which removes children in one transaction.
CREATE TABLE nip_podcast_subscriptions_rebuild (
    source_id VARCHAR PRIMARY KEY,
    feed_url VARCHAR NOT NULL,
    show_name VARCHAR NOT NULL,
    rights_statement VARCHAR NOT NULL,
    rights_confirmed_at TIMESTAMPTZ NOT NULL,
    state VARCHAR NOT NULL CHECK (state IN ('active', 'paused', 'removed')),
    etag VARCHAR,
    last_modified VARCHAR,
    last_checked_at TIMESTAMPTZ,
    next_poll_at TIMESTAMPTZ,
    last_error_code VARCHAR,
    consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0)
);

CREATE TABLE nip_podcast_episodes_rebuild (
    episode_id VARCHAR PRIMARY KEY,
    source_id VARCHAR NOT NULL,
    identity_key VARCHAR NOT NULL,
    source_native_id VARCHAR,
    canonical_url VARCHAR,
    title VARCHAR,
    enclosure_url VARCHAR,
    published_at TIMESTAMPTZ,
    discovered_at TIMESTAMPTZ NOT NULL,
    state VARCHAR NOT NULL CHECK (state IN ('awaiting_local_transcription', 'transcription_unavailable', 'transcribed', 'failed')),
    UNIQUE (source_id, identity_key)
);

CREATE TABLE nip_podcast_transcripts_rebuild (
    episode_id VARCHAR PRIMARY KEY,
    transcript_text VARCHAR NOT NULL,
    content_hash VARCHAR NOT NULL,
    detected_language VARCHAR,
    provenance_json VARCHAR NOT NULL,
    transcribed_at TIMESTAMPTZ NOT NULL
);

INSERT INTO nip_podcast_subscriptions_rebuild
    (source_id, feed_url, show_name, rights_statement, rights_confirmed_at, state, etag,
     last_modified, last_checked_at, next_poll_at, last_error_code, consecutive_failures)
SELECT source_id, feed_url, show_name, rights_statement, rights_confirmed_at, state, etag,
       last_modified, last_checked_at, next_poll_at, last_error_code, consecutive_failures
FROM nip_podcast_subscriptions;

INSERT INTO nip_podcast_episodes_rebuild
    (episode_id, source_id, identity_key, source_native_id, canonical_url, title, enclosure_url,
     published_at, discovered_at, state)
SELECT episode_id, source_id, identity_key, source_native_id, canonical_url, title, enclosure_url,
       published_at, discovered_at, state
FROM nip_podcast_episodes;

INSERT INTO nip_podcast_transcripts_rebuild
    (episode_id, transcript_text, content_hash, detected_language, provenance_json, transcribed_at)
SELECT episode_id, transcript_text, content_hash, detected_language, provenance_json, transcribed_at
FROM nip_podcast_transcripts;

DROP TABLE nip_podcast_transcripts;
DROP TABLE nip_podcast_episodes;
DROP TABLE nip_podcast_subscriptions;

ALTER TABLE nip_podcast_subscriptions_rebuild RENAME TO nip_podcast_subscriptions;
ALTER TABLE nip_podcast_episodes_rebuild RENAME TO nip_podcast_episodes;
ALTER TABLE nip_podcast_transcripts_rebuild RENAME TO nip_podcast_transcripts;

CREATE INDEX IF NOT EXISTS idx_nip_podcast_episodes_source_discovered
    ON nip_podcast_episodes(source_id, discovered_at);
