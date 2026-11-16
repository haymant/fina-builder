CREATE TABLE IF NOT EXISTS nip_podcast_subscriptions (
    source_id VARCHAR PRIMARY KEY REFERENCES nip_sources(source_id),
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

CREATE TABLE IF NOT EXISTS nip_podcast_episodes (
    episode_id VARCHAR PRIMARY KEY,
    source_id VARCHAR NOT NULL REFERENCES nip_podcast_subscriptions(source_id),
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

CREATE INDEX IF NOT EXISTS idx_nip_podcast_episodes_source_discovered
    ON nip_podcast_episodes(source_id, discovered_at);
