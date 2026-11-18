//! Durable transcription job reports.
//!
//! A long episode can take minutes. The desktop starts a job, polls its state,
//! and keeps the downloaded audio and transcript as reviewable artifacts under
//! `<NIP_DATA_DIR>/asr-staging/<job_id>/`. Every step (`download`, `prepare`,
//! `transcribe`, `commit`) and every warning is persisted, so a failure names
//! the exact stage instead of collapsing into "transcription failed".

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::asr::AsrProgress;

pub const TERMINAL_STATES: &[&str] = &["transcribed", "failed", "cancelled"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionJobEvent {
    pub at: DateTime<Utc>,
    pub level: String,
    pub step: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionJob {
    pub job_id: String,
    pub source_id: String,
    pub source_native_id: Option<String>,
    pub canonical_url: Option<String>,
    pub title: Option<String>,
    pub state: String,
    pub step: String,
    pub detail: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub audio_bytes: Option<u64>,
    pub audio_content_type: Option<String>,
    pub audio_path: Option<String>,
    pub audio_url_path: Option<String>,
    pub audio_duration_seconds: Option<f64>,
    pub chunks_total: Option<usize>,
    pub chunks_completed: usize,
    pub transcript_characters: Option<u64>,
    pub transcript_preview: Option<String>,
    pub transcript_path: Option<String>,
    /// Canonical event id of the committed transcript, when available.
    #[serde(default)]
    pub event_id: Option<String>,
    pub warnings: Vec<String>,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub events: Vec<TranscriptionJobEvent>,
}

impl TranscriptionJob {
    pub fn is_terminal(&self) -> bool {
        TERMINAL_STATES.contains(&self.state.as_str())
    }

    /// Push a timestamped step event. The latest event is also mirrored into
    /// `step`/`detail` so the UI can render the current stage cheaply.
    pub fn record(&mut self, level: &str, step: &str, detail: impl Into<String>) {
        let detail = detail.into();
        let now = Utc::now();
        self.state = step.to_owned();
        self.step = step.to_owned();
        self.detail = Some(detail.clone());
        self.updated_at = now;
        if self.events.len() >= 200 {
            self.events.remove(0);
        }
        self.events.push(TranscriptionJobEvent {
            at: now,
            level: level.to_owned(),
            step: step.to_owned(),
            detail,
        });
    }

    pub fn fail(&mut self, step: &str, code: impl Into<String>, message: impl Into<String>) {
        let message = message.into();
        self.record("error", step, message.clone());
        self.state = "failed".into();
        self.error_code = Some(code.into());
        self.error_message = Some(message);
        let now = Utc::now();
        self.finished_at = Some(now);
        self.updated_at = now;
    }
}

#[derive(Clone)]
pub struct JobRegistry {
    root: PathBuf,
    jobs: Arc<Mutex<HashMap<String, TranscriptionJob>>>,
    cancel: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl JobRegistry {
    /// Load previous reports so the review panel survives an app restart.
    pub fn open(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        let mut jobs = HashMap::new();
        if let Ok(entries) = fs::read_dir(&root) {
            for entry in entries.filter_map(Result::ok) {
                let report = entry.path().join("job.json");
                if let Ok(body) = fs::read_to_string(report) {
                    if let Ok(job) = serde_json::from_str::<TranscriptionJob>(&body) {
                        // A job that was running when the process exited cannot
                        // resume; surface it as interrupted instead of active.
                        let mut job = job;
                        if !job.is_terminal() {
                            job.fail(
                                "interrupted",
                                "interrupted",
                                "the desktop stopped while this job was running",
                            );
                            cleanup_working_audio(&entry.path());
                        }
                        jobs.insert(job.job_id.clone(), job);
                    }
                }
            }
        }
        Self {
            root,
            jobs: Arc::new(Mutex::new(jobs)),
            cancel: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn job_dir(&self, job_id: &str) -> PathBuf {
        self.root.join(job_id)
    }

    pub fn create(&self, job: TranscriptionJob) -> TranscriptionJob {
        self.cancel
            .lock()
            .map(|mut flags| {
                flags.insert(job.job_id.clone(), Arc::new(AtomicBool::new(false)));
            })
            .ok();
        let job_id = job.job_id.clone();
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.insert(job_id.clone(), job.clone());
        }
        self.persist(&job_id);
        job
    }

    pub fn update<F>(&self, job_id: &str, mutate: F)
    where
        F: FnOnce(&mut TranscriptionJob),
    {
        if let Ok(mut jobs) = self.jobs.lock() {
            if let Some(job) = jobs.get_mut(job_id) {
                mutate(job);
                job.updated_at = Utc::now();
            }
        }
        self.persist(job_id);
    }

    pub fn get(&self, job_id: &str) -> Option<TranscriptionJob> {
        self.jobs
            .lock()
            .ok()
            .and_then(|jobs| jobs.get(job_id).cloned())
    }

    pub fn list(&self, source_id: Option<&str>, limit: usize) -> Vec<TranscriptionJob> {
        let mut jobs: Vec<TranscriptionJob> = self
            .jobs
            .lock()
            .map(|jobs| {
                jobs.values()
                    .filter(|job| source_id.is_none_or(|source| job.source_id == source))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        jobs.sort_by(|left, right| right.started_at.cmp(&left.started_at));
        jobs.truncate(limit.clamp(1, 100));
        jobs
    }

    /// The active job for an episode, used to make the start action idempotent.
    pub fn active_for(&self, source_id: &str, source_native_id: Option<&str>) -> Option<TranscriptionJob> {
        self.jobs.lock().ok()?.values().find_map(|job| {
            (!job.is_terminal()
                && job.source_id == source_id
                && source_native_id.is_none_or(|id| job.source_native_id.as_deref() == Some(id)))
            .then(|| job.clone())
        })
    }

    pub fn cancel_flag(&self, job_id: &str) -> Arc<AtomicBool> {
        if let Ok(mut flags) = self.cancel.lock() {
            return flags
                .entry(job_id.to_owned())
                .or_insert_with(|| Arc::new(AtomicBool::new(false)))
                .clone();
        }
        Arc::new(AtomicBool::new(false))
    }

    pub fn cancel(&self, job_id: &str) -> Option<TranscriptionJob> {
        let flag = self.cancel_flag(job_id);
        flag.store(true, Ordering::SeqCst);
        self.get(job_id)
    }

    pub fn remove(&self, job_id: &str, delete_artifacts: bool) -> bool {
        let removed = self
            .jobs
            .lock()
            .map(|mut jobs| jobs.remove(job_id).is_some())
            .unwrap_or(false);
        if let Ok(mut flags) = self.cancel.lock() {
            flags.remove(job_id);
        }
        if delete_artifacts {
            let _ = fs::remove_dir_all(self.job_dir(job_id));
        } else {
            let _ = fs::remove_file(self.job_dir(job_id).join("job.json"));
        }
        removed
    }

    /// Reflect the pack's progress lines on the job record.
    pub fn apply_progress(&self, job_id: &str, progress: &AsrProgress) {
        self.update(job_id, |job| match progress {
            AsrProgress::FreedMemory => {
                job.record("info", "transcribe", "ComfyUI released cached VRAM");
            }
            AsrProgress::Prepared {
                chunks,
                chunk_seconds,
            } => {
                job.chunks_total = Some(*chunks);
                job.record(
                    "info",
                    "transcribe",
                    format!("audio split into {chunks} chunk(s) of {chunk_seconds}s"),
                );
            }
            AsrProgress::ChunkStarted { index, total } => {
                job.record(
                    "info",
                    "transcribe",
                    format!("transcribing chunk {}/{}", index + 1, total),
                );
            }
            AsrProgress::ChunkFinished {
                index,
                total,
                characters,
            } => {
                job.chunks_completed = job.chunks_completed.max(index + 1);
                job.record(
                    "info",
                    "transcribe",
                    format!(
                        "chunk {}/{} transcribed ({characters} characters)",
                        index + 1,
                        total
                    ),
                );
            }
            AsrProgress::Retrying { reason, .. } => {
                job.warnings.push(reason.clone());
                job.record("warn", "transcribe", reason.clone());
            }
            AsrProgress::Warning { message } => {
                job.warnings.push(message.clone());
                job.record("warn", "transcribe", message.clone());
            }
        });
    }

    pub fn persist(&self, job_id: &str) {
        let Some(job) = self.get(job_id) else {
            return;
        };
        let directory = self.job_dir(job_id);
        if let Err(error) = fs::create_dir_all(&directory) {
            eprintln!(
                "{}",
                serde_json::json!({
                    "event": "nip_transcription_job_persist_failed",
                    "job_id": job_id,
                    "detail": error.to_string()
                })
            );
            return;
        }
        let body = match serde_json::to_string_pretty(&job) {
            Ok(body) => body,
            Err(_) => return,
        };
        let temporary = directory.join("job.json.tmp");
        if fs::write(&temporary, body).is_ok() {
            let _ = fs::rename(&temporary, directory.join("job.json"));
        }
    }
}

/// Remove the pack's temporary WAV chunks. A killed job (app exit) leaves them
/// behind because the CLI never reaches its own cleanup.
pub fn cleanup_working_audio(directory: &Path) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.ends_with(".wav") && (name.contains("-chunk-") || name.contains("-part-")) {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn job(id: &str) -> TranscriptionJob {
        let now = Utc::now();
        TranscriptionJob {
            job_id: id.into(),
            source_id: "fixture-show".into(),
            source_native_id: Some("episode-1".into()),
            canonical_url: None,
            title: Some("Fixture episode".into()),
            state: "queued".into(),
            step: "queued".into(),
            detail: None,
            error_code: None,
            error_message: None,
            audio_bytes: None,
            audio_content_type: None,
            audio_path: None,
            audio_url_path: None,
            audio_duration_seconds: None,
            chunks_total: None,
            chunks_completed: 0,
            transcript_characters: None,
            transcript_preview: None,
            transcript_path: None,
            event_id: None,
            warnings: Vec::new(),
            started_at: now,
            updated_at: now,
            finished_at: None,
            events: Vec::new(),
        }
    }

    #[test]
    fn progress_is_recorded_as_reviewable_steps_and_survives_reopen() {
        let temp = tempdir().unwrap();
        let registry = JobRegistry::open(temp.path());
        registry.create(job("job-1"));
        registry.apply_progress(
            "job-1",
            &AsrProgress::Prepared {
                chunks: 7,
                chunk_seconds: 45,
            },
        );
        registry.apply_progress(
            "job-1",
            &AsrProgress::ChunkFinished {
                index: 2,
                total: 7,
                characters: 900,
            },
        );
        let snapshot = registry.get("job-1").unwrap();
        assert_eq!(snapshot.chunks_total, Some(7));
        assert_eq!(snapshot.chunks_completed, 3);
        assert!(snapshot.events.iter().any(|event| event.detail.contains("chunk 3/7")));

        let reopened = JobRegistry::open(temp.path());
        let restored = reopened.get("job-1").unwrap();
        assert_eq!(restored.chunks_completed, 3);
    }

    #[test]
    fn a_job_interrupted_by_process_exit_is_marked_failed_not_active() {
        let temp = tempdir().unwrap();
        let registry = JobRegistry::open(temp.path());
        registry.create(job("job-1"));
        registry.persist("job-1");
        drop(registry);
        let reopened = JobRegistry::open(temp.path());
        let restored = reopened.get("job-1").unwrap();
        assert_eq!(restored.state, "failed");
        assert_eq!(restored.error_code.as_deref(), Some("interrupted"));
    }

    #[test]
    fn active_jobs_are_unique_per_episode_and_terminal_jobs_are_ignored() {
        let temp = tempdir().unwrap();
        let registry = JobRegistry::open(temp.path());
        registry.create(job("job-1"));
        assert!(registry
            .active_for("fixture-show", Some("episode-1"))
            .is_some());
        registry.update("job-1", |job| job.state = "failed".into());
        assert!(registry
            .active_for("fixture-show", Some("episode-1"))
            .is_none());
    }

    #[test]
    fn reopening_deletes_working_chunks_left_by_a_killed_job() {
        let temp = tempdir().unwrap();
        let registry = JobRegistry::open(temp.path());
        registry.create(job("job-1"));
        let directory = registry.job_dir("job-1");
        fs::write(directory.join("abc-chunk-000.wav"), b"working").unwrap();
        fs::write(directory.join("source.mp3"), b"audio").unwrap();
        drop(registry);
        let reopened = JobRegistry::open(temp.path());
        assert_eq!(reopened.get("job-1").unwrap().state, "failed");
        assert!(!directory.join("abc-chunk-000.wav").exists());
        assert!(directory.join("source.mp3").exists());
    }

    #[test]
    fn removing_a_job_can_delete_its_audio_and_transcript_artifacts() {
        let temp = tempdir().unwrap();
        let registry = JobRegistry::open(temp.path());
        registry.create(job("job-1"));
        let audio = registry.job_dir("job-1").join("source.mp3");
        fs::write(&audio, b"fixture").unwrap();
        assert!(registry.remove("job-1", true));
        assert!(!audio.exists());
        assert!(registry.get("job-1").is_none());
    }
}
