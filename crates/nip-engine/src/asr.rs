//! NIP's narrow local-ASR boundary.
//!
//! The `comfy` pack is an independent audio/video workflow repository with a
//! documented CLI. fina-builder never embeds those graphs or re-implements the
//! ComfyUI protocol: this adapter resolves `modules/comfy/scripts/render.py`
//! (or the checkout named by `NIP_COMFY_DIR` / `NIP_COMFY_RENDER`, optionally
//! cloned from `NIP_COMFY_REPO`) and runs its `asr-long` mode once per episode.
//!
//! Everything that needs GPU knowledge — chunking, releasing VRAM, recovering
//! from `torch.OutOfMemoryError`, and warning about the Qwen3-ASR 256-token cap
//! — lives in the pack. This file only runs the tool and maps its progress
//! lines and exit status onto NIP's progress/error types.

use std::env;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::net::{IpAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use url::Url;

/// Podcast enclosures are capped before they are held in memory by the engine.
const MAX_AUDIO_BYTES: usize = 256 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES: usize = 2 * 1024 * 1024;
/// 45 seconds of speech stays below the `Qwen3ASRLoader` 256-token cap for
/// English; the pack's `asr-long` mode warns when a chunk still looks cut.
pub const DEFAULT_CHUNK_SECONDS: u32 = 45;
const DEFAULT_CHUNK_TIMEOUT: Duration = Duration::from_secs(7_200);
const PROGRESS_PREFIX: &str = "[asr-long]";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AsrRequest {
    pub job_id: String,
    pub audio: Vec<u8>,
    /// Set when the caller already persisted the download (the desktop job
    /// store does). Otherwise the adapter writes the bytes into its staging
    /// directory before invoking the CLI.
    pub audio_path: Option<PathBuf>,
    pub file_name: String,
    pub mime_type: String,
    pub language: Option<String>,
    pub return_timestamps: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AsrTiming {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AsrProvenance {
    pub workflow_version: String,
    pub workflow_hash: String,
    pub device: Option<String>,
    pub precision: Option<String>,
    pub model: String,
    pub node: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AsrResult {
    pub text: String,
    pub language: Option<String>,
    pub timings: Vec<AsrTiming>,
    pub provenance: AsrProvenance,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AsrError {
    #[error("ASR input is invalid")]
    InvalidInput,
    #[error("ASR provider is unavailable")]
    Unavailable,
    #[error("ASR provider timed out")]
    Timeout,
    #[error("ASR provider returned malformed or empty output")]
    MalformedOutput,
    #[error("audio could not be prepared for the ASR provider")]
    AudioPreparation,
    #[error("ASR operation was cancelled")]
    Cancelled,
    #[error("local ASR ran out of GPU memory")]
    OutOfMemory,
    #[error("{0}")]
    ProviderError(String),
}

impl AsrError {
    /// Stable code shown by the UI and recorded on the episode/job.
    pub fn code(&self) -> &'static str {
        match self {
            AsrError::InvalidInput => "invalid_audio",
            AsrError::Unavailable => "transcription_unavailable",
            AsrError::Timeout => "transcription_timeout",
            AsrError::MalformedOutput => "transcription_empty",
            AsrError::AudioPreparation => "audio_preparation_failed",
            AsrError::Cancelled => "transcription_cancelled",
            AsrError::OutOfMemory => "transcription_oom",
            AsrError::ProviderError(_) => "transcription_failed",
        }
    }
}

/// Progress reported while a long episode is transcribed. The desktop records
/// these as human-readable job steps so an operator can see which stage failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AsrProgress {
    FreedMemory,
    Prepared {
        chunks: usize,
        chunk_seconds: u32,
    },
    ChunkStarted {
        index: usize,
        total: usize,
    },
    ChunkFinished {
        index: usize,
        total: usize,
        characters: usize,
    },
    Retrying {
        index: usize,
        total: usize,
        reason: String,
    },
    Warning {
        message: String,
    },
}

/// NIP's narrow local-ASR boundary. Implementations must not fetch source URLs,
/// write canonical records, or select a remote fallback.
pub trait AsrProvider: Send + Sync {
    fn transcribe(&self, request: &AsrRequest) -> Result<AsrResult, AsrError>;

    /// Default implementation keeps simple providers (and tests) unchanged.
    fn transcribe_with_progress(
        &self,
        request: &AsrRequest,
        _progress: &dyn Fn(AsrProgress),
    ) -> Result<AsrResult, AsrError> {
        self.transcribe(request)
    }
}

#[derive(Debug, Clone)]
pub struct DeterministicFakeAsrProvider {
    transcript: String,
    language: Option<String>,
}

impl DeterministicFakeAsrProvider {
    pub fn new(transcript: impl Into<String>, language: Option<String>) -> Result<Self, AsrError> {
        let transcript = transcript.into();
        if transcript.trim().is_empty() {
            return Err(AsrError::InvalidInput);
        }
        Ok(Self {
            transcript,
            language,
        })
    }
}

impl AsrProvider for DeterministicFakeAsrProvider {
    fn transcribe(&self, request: &AsrRequest) -> Result<AsrResult, AsrError> {
        validate_request(request)?;
        Ok(AsrResult {
            text: self.transcript.clone(),
            language: self.language.clone(),
            timings: Vec::new(),
            provenance: AsrProvenance {
                workflow_version: "deterministic-fake-v1".into(),
                workflow_hash: "fixture-only".into(),
                device: Some("fake".into()),
                precision: None,
                model: "deterministic-fake".into(),
                node: "fake-asr".into(),
            },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopbackUrl(String);

impl LoopbackUrl {
    pub fn parse(value: &str) -> Result<Self, AsrError> {
        let url = Url::parse(value).map_err(|_| AsrError::InvalidInput)?;
        if !matches!(url.scheme(), "http" | "https")
            || url.username() != ""
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(AsrError::InvalidInput);
        }
        let host = url.host_str().ok_or(AsrError::InvalidInput)?;
        if !is_loopback_host(host) {
            return Err(AsrError::InvalidInput);
        }
        let port = url.port_or_known_default().ok_or(AsrError::InvalidInput)?;
        let resolved = (host, port)
            .to_socket_addrs()
            .map_err(|_| AsrError::InvalidInput)?;
        if !resolved
            .into_iter()
            .all(|address| address.ip().is_loopback())
        {
            return Err(AsrError::InvalidInput);
        }
        Ok(Self(url.to_string().trim_end_matches('/').to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/// Sidecar written by `render.py asr-long` next to the transcript.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AsrLongReport {
    #[serde(default)]
    pub chunks: usize,
    #[serde(default)]
    pub chunk_seconds: u32,
    #[serde(default)]
    pub duration_seconds: Option<f64>,
    #[serde(default)]
    pub warnings: Vec<String>,
    #[serde(default)]
    pub device: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

/// Local ASR driven by the independent `comfy` pack CLI.
///
/// The wrapper owns only process invocation and artifact/status reporting.
#[derive(Debug)]
pub struct ComfyUiAsrProvider {
    endpoint: LoopbackUrl,
    staging_root: PathBuf,
    render_script: PathBuf,
    python: String,
    chunk_seconds: u32,
    chunk_timeout: Duration,
    cancel: Option<Arc<AtomicBool>>,
}

impl ComfyUiAsrProvider {
    pub fn from_env(staging_root: impl Into<PathBuf>) -> Result<Option<Self>, AsrError> {
        let configured = env::var("NIP_COMFYUI_URL").ok();
        match crate::comfy_discovery::from_process(configured.as_deref()) {
            Some(endpoint) => Self::new(endpoint.url.as_str(), staging_root).map(Some),
            None => Ok(None),
        }
    }

    /// Resolve the CLI from the environment. Prefer
    /// [`ComfyUiAsrProvider::with_render_script`] so the resolved workspace in
    /// `NipConfig` is the single source of truth.
    pub fn new(endpoint: &str, staging_root: impl Into<PathBuf>) -> Result<Self, AsrError> {
        let render_script = env::var("NIP_COMFY_RENDER")
            .ok()
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .or_else(|| {
                let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
                let candidate = repo.join("modules/comfy/scripts/render.py");
                candidate.is_file().then_some(candidate)
            })
            .ok_or_else(|| {
                AsrError::ProviderError(
                    "the comfy pack CLI was not found; set NIP_COMFY_DIR or NIP_COMFY_RENDER"
                        .into(),
                )
            })?;
        Self::with_render_script(endpoint, staging_root, render_script, DEFAULT_CHUNK_SECONDS)
    }

    pub fn with_render_script(
        endpoint: &str,
        staging_root: impl Into<PathBuf>,
        render_script: impl Into<PathBuf>,
        chunk_seconds: u32,
    ) -> Result<Self, AsrError> {
        let chunk_timeout = env::var("NIP_ASR_CHUNK_TIMEOUT_SECONDS")
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .filter(|value| *value >= 30)
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_CHUNK_TIMEOUT);
        Ok(Self {
            endpoint: LoopbackUrl::parse(endpoint)?,
            staging_root: staging_root.into(),
            render_script: render_script.into(),
            python: env::var("NIP_PYTHON_BIN")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "python3".to_owned()),
            chunk_seconds: chunk_seconds.clamp(10, 600),
            chunk_timeout,
            cancel: None,
        })
    }

    /// Stop the pack CLI when the operator cancels the job. The process owns
    /// the GPU work, so cancellation must terminate it rather than wait.
    pub fn with_cancel(mut self, cancel: Arc<AtomicBool>) -> Self {
        self.cancel = Some(cancel);
        self
    }

    fn cancelled(&self) -> bool {
        self.cancel
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::SeqCst))
    }

    pub fn endpoint(&self) -> &str {
        self.endpoint.as_str()
    }

    pub fn render_script(&self) -> &Path {
        &self.render_script
    }

    pub fn chunk_seconds(&self) -> u32 {
        self.chunk_seconds
    }

    fn job_dir(&self, job_id: &str) -> Result<PathBuf, AsrError> {
        if job_id.trim().is_empty()
            || !job_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        {
            return Err(AsrError::InvalidInput);
        }
        Ok(self.staging_root.join(job_id))
    }

    /// Persist the downloaded audio so the CLI (and the operator) can review
    /// exactly what was transcribed. The desktop job store normally sets
    /// `audio_path`; this covers direct MCP/skill invocations.
    fn stage_audio(&self, directory: &Path, request: &AsrRequest) -> Result<PathBuf, AsrError> {
        if let Some(path) = request.audio_path.as_ref().filter(|path| path.is_file()) {
            return Ok(path.clone());
        }
        let input = directory.join(safe_file_name(&request.file_name));
        fs::write(&input, &request.audio).map_err(|_| AsrError::Unavailable)?;
        Ok(input)
    }

    fn run_cli(
        &self,
        audio: &Path,
        output: &Path,
        request: &AsrRequest,
        progress: &dyn Fn(AsrProgress),
    ) -> Result<(), AsrError> {
        if self.cancelled() {
            return Err(AsrError::Cancelled);
        }
        let log = output.with_extension("log");
        let stderr = fs::File::create(&log).map_err(|_| AsrError::Unavailable)?;
        let mut command = Command::new(&self.python);
        command
            .arg(&self.render_script)
            .arg("asr-long")
            .arg("--server")
            .arg(self.endpoint.as_str())
            .arg("--audio")
            .arg(audio)
            .arg("--output")
            .arg(output)
            .arg("--chunk-seconds")
            .arg(self.chunk_seconds.to_string())
            .arg("--work-dir")
            .arg(output.parent().unwrap_or(Path::new(".")))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(stderr);
        if let Some(language) = request
            .language
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            command.arg("--language").arg(language);
        }
        let mut child = command.spawn().map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AsrError::ProviderError(format!(
                    "the ASR CLI could not start: {} {} (set NIP_PYTHON_BIN)",
                    self.python,
                    self.render_script.display()
                ))
            } else {
                AsrError::Unavailable
            }
        })?;
        let started = Instant::now();
        let mut offset = 0_u64;
        loop {
            offset = drain_progress(&log, offset, progress);
            if self.cancelled() {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AsrError::Cancelled);
            }
            if let Some(status) = child.try_wait().map_err(|_| AsrError::Unavailable)? {
                // Flush whatever the CLI wrote just before exiting.
                drain_progress(&log, offset, progress);
                let detail = read_tail(&log, 4_000);
                return if status.success() {
                    Ok(())
                } else {
                    Err(classify_failure(status.code(), &detail))
                };
            }
            if started.elapsed() > self.chunk_timeout {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AsrError::Timeout);
            }
            thread::sleep(Duration::from_millis(400));
        }
    }
}

impl AsrProvider for ComfyUiAsrProvider {
    fn transcribe(&self, request: &AsrRequest) -> Result<AsrResult, AsrError> {
        self.transcribe_with_progress(request, &|_| {})
    }

    fn transcribe_with_progress(
        &self,
        request: &AsrRequest,
        progress: &dyn Fn(AsrProgress),
    ) -> Result<AsrResult, AsrError> {
        validate_request(request)?;
        if request.audio.len() > MAX_AUDIO_BYTES {
            return Err(AsrError::InvalidInput);
        }
        let directory = self.job_dir(&request.job_id)?;
        fs::create_dir_all(&directory).map_err(|_| AsrError::Unavailable)?;
        let audio = self.stage_audio(&directory, request)?;
        let output = directory.join("transcript.txt");
        self.run_cli(&audio, &output, request, progress)?;
        let text = fs::read_to_string(&output)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .ok_or(AsrError::MalformedOutput)?;
        if text.len() > MAX_TRANSCRIPT_BYTES {
            return Err(AsrError::MalformedOutput);
        }
        let report = read_report(&output);
        for warning in &report.warnings {
            progress(AsrProgress::Warning {
                message: warning.clone(),
            });
        }
        let script_hash = fs::read(&self.render_script)
            .map(|bytes| stable_hash(&bytes))
            .unwrap_or_else(|_| "unavailable".into());
        Ok(AsrResult {
            text,
            language: None,
            timings: Vec::new(),
            provenance: AsrProvenance {
                workflow_version: "comfy-cli-asr-long-v1".into(),
                workflow_hash: script_hash,
                device: report.device,
                precision: None,
                model: report.model.unwrap_or_else(|| "Qwen/Qwen3-ASR-0.6B".into()),
                node: "modules/comfy/scripts/render.py asr-long".into(),
            },
        })
    }
}

fn read_report(output: &Path) -> AsrLongReport {
    let sidecar = output.with_extension("json");
    fs::read_to_string(sidecar)
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_default()
}

/// Parse the pack's `[asr-long]` progress lines from the growing stderr log.
/// Returns the new offset so the next poll only reads fresh bytes.
fn drain_progress(log: &Path, offset: u64, progress: &dyn Fn(AsrProgress)) -> u64 {
    let Ok(mut file) = fs::File::open(log) else {
        return offset;
    };
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return offset;
    }
    let mut fresh = String::new();
    if file.read_to_string(&mut fresh).is_err() {
        return offset;
    }
    let mut consumed = offset + fresh.len() as u64;
    // Keep a trailing partial line for the next poll.
    if !fresh.ends_with('\n') {
        if let Some(last_newline) = fresh.rfind('\n') {
            consumed = offset + (last_newline as u64) + 1;
            fresh.truncate(last_newline + 1);
        } else {
            return offset;
        }
    }
    for line in fresh.lines() {
        if let Some(event) = parse_progress_line(line) {
            progress(event);
        }
    }
    consumed
}

fn parse_progress_line(line: &str) -> Option<AsrProgress> {
    let body = line.trim().strip_prefix(PROGRESS_PREFIX)?.trim();
    let body = body.strip_prefix("event=").unwrap_or(body);
    let mut parts = body.split_whitespace();
    match parts.next()? {
        "free" => Some(AsrProgress::FreedMemory),
        "prepared" => {
            let mut chunks = 0;
            let mut chunk_seconds = DEFAULT_CHUNK_SECONDS;
            for part in parts {
                if let Some(value) = part.strip_prefix("chunks=") {
                    chunks = value.parse().unwrap_or(0);
                } else if let Some(value) = part.strip_prefix("chunk_seconds=") {
                    chunk_seconds = value.parse().unwrap_or(DEFAULT_CHUNK_SECONDS);
                }
            }
            Some(AsrProgress::Prepared {
                chunks,
                chunk_seconds,
            })
        }
        "chunk_start" | "chunk" => {
            let (index, total) = parse_chunk_pair(parts.next().unwrap_or("0/0"))?;
            Some(AsrProgress::ChunkStarted { index, total })
        }
        "chunk_done" => {
            let pair = parts.next().unwrap_or("0/0");
            let (index, total) = parse_chunk_pair(pair)?;
            let characters = body
                .split_whitespace()
                .find_map(|part| part.strip_prefix("chars="))
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            Some(AsrProgress::ChunkFinished {
                index,
                total,
                characters,
            })
        }
        "retry" | "oom" => {
            let reason = body
                .split_once("reason=")
                .map(|(_, value)| value.trim().to_owned())
                .unwrap_or_else(|| "the pack retried the chunk".into());
            Some(AsrProgress::Retrying {
                index: 0,
                total: 0,
                reason,
            })
        }
        "warning" => Some(AsrProgress::Warning {
            message: body
                .strip_prefix("warning")
                .unwrap_or(body)
                .trim()
                .to_owned(),
        }),
        _ => None,
    }
}

fn parse_chunk_pair(value: &str) -> Option<(usize, usize)> {
    let (index, total) = value.split_once('/')?;
    let index = index.parse::<usize>().ok()?;
    let total = total.parse::<usize>().ok()?;
    Some((index.saturating_sub(1), total))
}

fn read_tail(path: &Path, limit: usize) -> String {
    let text = fs::read_to_string(path).unwrap_or_default();
    let trimmed = text.trim();
    if trimmed.chars().count() <= limit {
        return trimmed.to_owned();
    }
    trimmed
        .chars()
        .rev()
        .take(limit)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

/// Turn the CLI's stderr into an actionable typed error. The pack prints the
/// ComfyUI execution error (including `torch.OutOfMemoryError`), so the UI can
/// show the real cause instead of "transcription failed".
fn classify_failure(code: Option<i32>, detail: &str) -> AsrError {
    let lower = detail.to_lowercase();
    if lower.contains("out of memory") || lower.contains("outofmemory") {
        return AsrError::OutOfMemory;
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return AsrError::Timeout;
    }
    if lower.contains("cannot reach comfyui") || lower.contains("connection refused") {
        return AsrError::Unavailable;
    }
    let summary = first_error_line(detail);
    if summary.is_empty() {
        AsrError::ProviderError(format!(
            "the local ASR CLI exited with status {}",
            code.map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".into())
        ))
    } else {
        AsrError::ProviderError(format!("local ASR failed: {summary}"))
    }
}

fn first_error_line(value: &str) -> String {
    let lines: Vec<&str> = value
        .lines()
        .map(str::trim)
        // Progress lines are not errors; keep the first real diagnostic.
        .filter(|line| {
            !line.is_empty() && !line.starts_with(PROGRESS_PREFIX) && !line.starts_with("note:")
        })
        .collect();
    let preferred = lines.iter().find(|line| {
        let lower = line.to_lowercase();
        lower.contains("error")
            || lower.contains("failed")
            || lower.contains("timed out")
            || lower.contains("out of memory")
            || lower.contains("cannot reach")
            || lower.starts_with("comfyui finished")
    });
    preferred
        .or_else(|| lines.first())
        .map(|line| line.chars().take(400).collect())
        .unwrap_or_default()
}

fn validate_request(request: &AsrRequest) -> Result<(), AsrError> {
    let has_audio = !request.audio.is_empty()
        || request
            .audio_path
            .as_ref()
            .is_some_and(|path| path.is_file());
    if request.job_id.trim().is_empty()
        || !has_audio
        || request.audio.len() > MAX_AUDIO_BYTES
        || request.file_name.trim().is_empty()
        || request.mime_type.trim().is_empty()
    {
        return Err(AsrError::InvalidInput);
    }
    Ok(())
}

fn safe_file_name(value: &str) -> String {
    let name = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audio.bin");
    name.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn stable_hash(bytes: &[u8]) -> String {
    let mut hash = 2166136261_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(1099511628211);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn request() -> AsrRequest {
        AsrRequest {
            job_id: "job-1".into(),
            audio: b"synthetic audio".to_vec(),
            audio_path: None,
            file_name: "episode.mp3".into(),
            mime_type: "audio/mpeg".into(),
            language: None,
            return_timestamps: false,
        }
    }

    #[test]
    fn fake_provider_is_deterministic_and_has_provenance() {
        let provider =
            DeterministicFakeAsrProvider::new("reviewed fixture transcript", Some("en".into()))
                .unwrap();
        let result = provider.transcribe(&request()).unwrap();
        assert_eq!(result.text, "reviewed fixture transcript");
        assert_eq!(result.language.as_deref(), Some("en"));
        assert_eq!(result.provenance.workflow_version, "deterministic-fake-v1");
    }

    #[test]
    fn fake_provider_rejects_empty_audio() {
        let provider = DeterministicFakeAsrProvider::new("fixture", None).unwrap();
        let mut request = request();
        request.audio.clear();
        assert_eq!(provider.transcribe(&request), Err(AsrError::InvalidInput));
    }

    #[test]
    fn loopback_url_rejects_credentials_and_remote_hosts() {
        assert!(LoopbackUrl::parse("http://user:pass@127.0.0.1:8188").is_err());
        assert!(LoopbackUrl::parse("https://example.com:8188").is_err());
        assert!(LoopbackUrl::parse("http://127.0.0.1:8188/path").is_ok());
    }

    #[test]
    fn failures_are_classified_for_the_ui() {
        let oom = "ComfyUI execution failed:\n\"exception_type\": \"torch.OutOfMemoryError\"";
        assert_eq!(classify_failure(Some(1), oom), AsrError::OutOfMemory);
        assert_eq!(
            classify_failure(Some(1), "cannot reach ComfyUI at http://127.0.0.1:8190"),
            AsrError::Unavailable
        );
        assert_eq!(
            classify_failure(Some(1), "ComfyUI execution failed: node type mismatch"),
            AsrError::ProviderError(
                "local ASR failed: ComfyUI execution failed: node type mismatch".into()
            )
        );
        assert_eq!(
            classify_failure(None, ""),
            AsrError::ProviderError("the local ASR CLI exited with status unknown".into())
        );
    }

    #[test]
    fn progress_lines_are_parsed_without_inventing_a_schema() {
        assert_eq!(
            parse_progress_line("[asr-long] event=free"),
            Some(AsrProgress::FreedMemory)
        );
        assert_eq!(
            parse_progress_line("[asr-long] event=prepared chunks=7 chunk_seconds=60"),
            Some(AsrProgress::Prepared {
                chunks: 7,
                chunk_seconds: 60
            })
        );
        assert_eq!(
            parse_progress_line("[asr-long] event=chunk_start 3/7"),
            Some(AsrProgress::ChunkStarted { index: 2, total: 7 })
        );
        assert_eq!(
            parse_progress_line("[asr-long] chunk_done 3/7 chars=1235"),
            Some(AsrProgress::ChunkFinished {
                index: 2,
                total: 7,
                characters: 1235
            })
        );
        assert_eq!(
            parse_progress_line("[asr-long] warning chunk 4/7 may be truncated"),
            Some(AsrProgress::Warning {
                message: "chunk 4/7 may be truncated".into()
            })
        );
        assert_eq!(parse_progress_line("ordinary log line"), None);
    }

    #[test]
    fn adapter_rejects_unsafe_job_ids_without_creating_staging_files() {
        let temp = tempdir().unwrap();
        let provider = ComfyUiAsrProvider::new("http://127.0.0.1:8188", temp.path()).unwrap();
        let mut request = request();
        request.job_id = "../escape".into();
        assert_eq!(provider.transcribe(&request), Err(AsrError::InvalidInput));
        assert_eq!(temp.path().read_dir().unwrap().count(), 0);
    }

    #[test]
    fn adapter_runs_the_documented_cli_for_a_fixture_script() {
        let temp = tempdir().unwrap();
        let script = temp.path().join("render.py");
        let fixture = format!(
            "import pathlib,sys\nout=pathlib.Path(sys.argv[sys.argv.index('--output')+1])\nout.parent.mkdir(parents=True,exist_ok=True)\nout.write_text('fixture transcript')\nout.with_suffix('.json').write_text('{{\"chunks\":1,\"chunk_seconds\":60,\"warnings\":[\"fixture warning\"]}}')\nsys.stderr.write('[asr-long] event=prepared chunks=1 chunk_seconds=60\\n')\nsys.stderr.write('[asr-long] event=chunk_start 1/1\\n')\nsys.stderr.write('[asr-long] event=chunk_done 1/1 chars=18\\n')\n"
        );
        fs::write(&script, fixture).unwrap();
        let provider = ComfyUiAsrProvider::with_render_script(
            "http://127.0.0.1:8188",
            temp.path(),
            &script,
            60,
        )
        .unwrap();
        let seen = std::sync::Mutex::new(Vec::new());
        let result = provider
            .transcribe_with_progress(&request(), &|progress| seen.lock().unwrap().push(progress))
            .unwrap();
        let seen = seen.into_inner().unwrap();
        assert_eq!(result.text, "fixture transcript");
        assert_eq!(
            result.provenance.node,
            "modules/comfy/scripts/render.py asr-long"
        );
        assert_eq!(
            seen.iter()
                .filter(|progress| matches!(progress, AsrProgress::ChunkFinished { .. }))
                .count(),
            1
        );
        assert!(matches!(seen.last(), Some(AsrProgress::Warning { .. })));
        assert!(temp.path().join("job-1/transcript.json").is_file());
    }

    #[test]
    fn adapter_requires_the_documented_cli_instead_of_reimplementing_the_graph() {
        let temp = tempdir().unwrap();
        let provider = ComfyUiAsrProvider::new("http://127.0.0.1:8188", temp.path()).unwrap();
        assert!(provider.render_script().is_file());
        assert_eq!(provider.chunk_seconds(), DEFAULT_CHUNK_SECONDS);
        assert!(provider
            .render_script()
            .to_string_lossy()
            .ends_with("modules/comfy/scripts/render.py"));
    }
}
