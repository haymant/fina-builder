-- Publisher-provided transcripts advertised in the RSS feed via
-- <podcast:transcript>. Discovery records the reference only; retrieval stays a
-- separate, bounded operation so a feed cannot force a download.
ALTER TABLE nip_podcast_episodes ADD COLUMN transcript_url VARCHAR;
ALTER TABLE nip_podcast_episodes ADD COLUMN transcript_type VARCHAR;
