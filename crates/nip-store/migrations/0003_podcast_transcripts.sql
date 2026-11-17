CREATE TABLE IF NOT EXISTS nip_podcast_transcripts (
    episode_id VARCHAR PRIMARY KEY REFERENCES nip_podcast_episodes(episode_id),
    transcript_text VARCHAR NOT NULL,
    content_hash VARCHAR NOT NULL,
    detected_language VARCHAR,
    provenance_json VARCHAR NOT NULL,
    transcribed_at TIMESTAMPTZ NOT NULL
);
