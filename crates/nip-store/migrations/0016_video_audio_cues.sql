CREATE TABLE IF NOT EXISTS video_audio_cues (
    cue_id VARCHAR NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
    project_id VARCHAR NOT NULL, project_revision INTEGER NOT NULL CHECK (project_revision > 0),
    episode_id VARCHAR NOT NULL, episode_revision INTEGER NOT NULL CHECK (episode_revision > 0),
    storyboard_id VARCHAR NOT NULL, storyboard_revision INTEGER NOT NULL CHECK (storyboard_revision > 0),
    scene_id VARCHAR, scene_revision INTEGER,
    asset_id VARCHAR NOT NULL, asset_revision INTEGER NOT NULL CHECK (asset_revision > 0),
    cue_json VARCHAR NOT NULL, created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (cue_id, revision),
    CHECK ((scene_id IS NULL AND scene_revision IS NULL) OR (scene_id IS NOT NULL AND scene_revision > 0))
);
CREATE INDEX IF NOT EXISTS idx_video_audio_cues_storyboard ON video_audio_cues(storyboard_id, storyboard_revision, cue_id, revision);
CREATE INDEX IF NOT EXISTS idx_video_audio_cues_asset ON video_audio_cues(asset_id, asset_revision);
