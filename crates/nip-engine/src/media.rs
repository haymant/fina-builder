//! Cached audio/video artifacts produced by NIP's transcription jobs (and, in
//! future, other `comfy` pack outputs). The wrapper owns the filesystem,
//! metadata and safe playback paths; the pack owns processing.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Serialize;

const AUDIO_EXTENSIONS: &[&str] = &["mp3", "m4a", "aac", "ogg", "opus", "wav", "flac"];
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "m4v", "webm", "mkv", "mov"];
const MAX_ARTIFACTS: usize = 200;

#[derive(Debug, Clone, Serialize)]
pub struct MediaArtifact {
    pub job_id: String,
    pub name: String,
    /// Relative to the media endpoint base: `<job_id>/<name>`.
    pub url_path: String,
    pub kind: String,
    pub mime: String,
    pub bytes: u64,
    pub modified_at: DateTime<Utc>,
    pub title: Option<String>,
    pub source_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedArtifact {
    pub path: PathBuf,
    pub mime: String,
    pub name: String,
}

/// List cached audio/video files under the job workspace. Transcripts and job
/// reports are not media, so they stay visible in the transcript panel instead.
pub fn list_artifacts(root: &Path, limit: usize) -> Vec<MediaArtifact> {
    let mut artifacts = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return artifacts;
    };
    for entry in entries.filter_map(Result::ok) {
        let job_dir = entry.path();
        if !job_dir.is_dir() {
            continue;
        }
        let job_id = entry.file_name().to_string_lossy().into_owned();
        let report = fs::read_to_string(job_dir.join("job.json"))
            .ok()
            .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok());
        let title = report
            .as_ref()
            .and_then(|value| value.get("title"))
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        let source_id = report
            .as_ref()
            .and_then(|value| value.get("source_id"))
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        let Ok(files) = fs::read_dir(&job_dir) else {
            continue;
        };
        for file in files.filter_map(Result::ok) {
            let path = file.path();
            if !path.is_file() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            // The pack's temporary chunk files are working data, not review
            // artifacts; a killed run can leave them behind.
            if name.contains("-chunk-") || name.contains("-part-") {
                continue;
            }
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_lowercase();
            let kind = if AUDIO_EXTENSIONS.contains(&extension.as_str()) {
                "audio"
            } else if VIDEO_EXTENSIONS.contains(&extension.as_str()) {
                "video"
            } else {
                continue;
            };
            let Ok(metadata) = file.metadata() else {
                continue;
            };
            artifacts.push(MediaArtifact {
                job_id: job_id.clone(),
                name: name.to_owned(),
                url_path: format!("{job_id}/{name}"),
                kind: kind.into(),
                mime: mime_for(&extension).into(),
                bytes: metadata.len(),
                modified_at: metadata
                    .modified()
                    .ok()
                    .map(DateTime::<Utc>::from)
                    .unwrap_or_else(Utc::now),
                title: title.clone(),
                source_id: source_id.clone(),
            });
        }
    }
    artifacts.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    artifacts.truncate(limit.clamp(1, MAX_ARTIFACTS));
    artifacts
}

/// Resolve a playback request without allowing traversal outside the cache.
pub fn resolve_artifact(root: &Path, job_id: &str, name: &str) -> Result<ResolvedArtifact, String> {
    if !is_safe_component(job_id) || !is_safe_component(name) {
        return Err("invalid media path".into());
    }
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if !AUDIO_EXTENSIONS.contains(&extension.as_str())
        && !VIDEO_EXTENSIONS.contains(&extension.as_str())
    {
        return Err("unsupported media type".into());
    }
    let candidate = root.join(job_id).join(name);
    let canonical_root =
        fs::canonicalize(root).map_err(|_| "media cache is unavailable".to_owned())?;
    let canonical =
        fs::canonicalize(&candidate).map_err(|_| "media file was not found".to_owned())?;
    if !canonical.starts_with(&canonical_root) || !canonical.is_file() {
        return Err("media file was not found".into());
    }
    Ok(ResolvedArtifact {
        path: canonical,
        mime: mime_for(&extension).into(),
        name: name.to_owned(),
    })
}

fn is_safe_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains(['/', '\\', '\0'])
        && !value.starts_with('-')
}

fn mime_for(extension: &str) -> &'static str {
    match extension {
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn artifacts_include_review_metadata_and_skip_transcripts() {
        let temp = tempdir().unwrap();
        let job = temp.path().join("job-1");
        fs::create_dir_all(&job).unwrap();
        fs::write(job.join("source.mp3"), b"fixture audio").unwrap();
        fs::write(job.join("transcript.txt"), b"fixture transcript").unwrap();
        fs::write(job.join("abc-chunk-000.wav"), b"working chunk").unwrap();
        fs::write(job.join("abc-chunk-000-part-001.wav"), b"working part").unwrap();
        fs::write(
            job.join("job.json"),
            serde_json::json!({"title": "Fixture episode", "source_id": "fixture-show"})
                .to_string(),
        )
        .unwrap();
        let artifacts = list_artifacts(temp.path(), 10);
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].kind, "audio");
        assert_eq!(artifacts[0].mime, "audio/mpeg");
        assert_eq!(artifacts[0].url_path, "job-1/source.mp3");
        assert_eq!(artifacts[0].title.as_deref(), Some("Fixture episode"));
    }

    #[test]
    fn playback_rejects_traversal_and_non_media_files() {
        let temp = tempdir().unwrap();
        let job = temp.path().join("job-1");
        fs::create_dir_all(&job).unwrap();
        fs::write(job.join("source.mp3"), b"fixture").unwrap();
        fs::write(job.join("job.json"), b"{}").unwrap();
        assert!(resolve_artifact(temp.path(), "job-1", "source.mp3").is_ok());
        assert!(resolve_artifact(temp.path(), "..", "source.mp3").is_err());
        assert!(resolve_artifact(temp.path(), "job-1", "../job.json").is_err());
        assert!(resolve_artifact(temp.path(), "job-1", "job.json").is_err());
    }
}
