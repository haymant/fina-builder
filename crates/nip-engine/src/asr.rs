use std::env;
use std::fs;
use std::net::{IpAddr, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use ureq::Agent;
use url::Url;

const MAX_AUDIO_BYTES: usize = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const HISTORY_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_HISTORY_POLLS: usize = 300;
const WORKFLOW_VERSION: &str = "qwen3-asr-local-v1";
const WORKFLOW_JSON: &str =
    include_str!("../../../modules/comfy/workflows/api/qwen3_asr_local.api.json");

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AsrRequest {
    pub job_id: String,
    pub audio: Vec<u8>,
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
    #[error("ASR operation was cancelled")]
    Cancelled,
}

/// NIP's narrow local-ASR boundary. Implementations must not fetch source URLs,
/// write canonical records, or select a remote fallback.
pub trait AsrProvider: Send + Sync {
    fn transcribe(&self, request: &AsrRequest) -> Result<AsrResult, AsrError>;
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

#[derive(Debug)]
pub struct ComfyUiAsrProvider {
    endpoint: LoopbackUrl,
    staging_root: PathBuf,
    agent: Agent,
}

impl ComfyUiAsrProvider {
    pub fn from_env(staging_root: impl Into<PathBuf>) -> Result<Option<Self>, AsrError> {
        match env::var("NIP_COMFYUI_URL") {
            Ok(endpoint) if !endpoint.trim().is_empty() => {
                Self::new(&endpoint, staging_root).map(Some)
            }
            Ok(_) | Err(env::VarError::NotPresent) => Ok(None),
            Err(env::VarError::NotUnicode(_)) => Err(AsrError::InvalidInput),
        }
    }

    pub fn new(endpoint: &str, staging_root: impl Into<PathBuf>) -> Result<Self, AsrError> {
        Ok(Self {
            endpoint: LoopbackUrl::parse(endpoint)?,
            staging_root: staging_root.into(),
            agent: Agent::config_builder()
                .http_status_as_error(false)
                .timeout_global(Some(DEFAULT_TIMEOUT))
                .build()
                .into(),
        })
    }

    pub fn endpoint(&self) -> &str {
        self.endpoint.as_str()
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

    fn upload_audio(&self, path: &Path, file_name: &str, mime_type: &str) -> Result<(), AsrError> {
        let bytes = fs::read(path).map_err(|_| AsrError::Unavailable)?;
        let boundary = "nip-comfy-boundary";
        let mut body = Vec::with_capacity(bytes.len() + 512);
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        body.extend_from_slice(
            format!(
                "Content-Disposition: form-data; name=\"image\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
                safe_file_name(file_name),
                mime_type
            )
            .as_bytes(),
        );
        body.extend_from_slice(&bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let url = format!("{}/upload/image", self.endpoint.as_str());
        let response = self
            .agent
            .post(&url)
            .header(
                "Content-Type",
                &format!("multipart/form-data; boundary={boundary}"),
            )
            .send(body)
            .map_err(|_| AsrError::Unavailable)?;
        if response.status().as_u16() >= 300 {
            return Err(AsrError::Unavailable);
        }
        Ok(())
    }

    fn submit_workflow(&self, file_name: &str, request: &AsrRequest) -> Result<String, AsrError> {
        let mut workflow: Value =
            serde_json::from_str(WORKFLOW_JSON).map_err(|_| AsrError::Unavailable)?;
        let nodes = workflow.as_object_mut().ok_or(AsrError::Unavailable)?;
        let audio = nodes
            .get_mut("1")
            .and_then(Value::as_object_mut)
            .and_then(|node| node.get_mut("inputs"))
            .and_then(Value::as_object_mut)
            .ok_or(AsrError::Unavailable)?;
        audio.insert("audio".into(), Value::String(file_name.to_owned()));
        if let Some(language) = request.language.as_deref() {
            if let Some(inputs) = nodes
                .get_mut("3")
                .and_then(Value::as_object_mut)
                .and_then(|node| node.get_mut("inputs"))
                .and_then(Value::as_object_mut)
            {
                inputs.insert("language".into(), Value::String(language.to_owned()));
            }
        }
        if let Some(inputs) = nodes
            .get_mut("3")
            .and_then(Value::as_object_mut)
            .and_then(|node| node.get_mut("inputs"))
            .and_then(Value::as_object_mut)
        {
            inputs.insert(
                "return_timestamps".into(),
                Value::Bool(request.return_timestamps),
            );
        }
        let payload = json!({"prompt": workflow, "client_id": request.job_id});
        let mut response = self
            .agent
            .post(&format!("{}/prompt", self.endpoint.as_str()))
            .header("Content-Type", "application/json")
            .send(payload.to_string())
            .map_err(|_| AsrError::Unavailable)?;
        if response.status().as_u16() >= 300 {
            return Err(AsrError::Unavailable);
        }
        let body = response
            .body_mut()
            .read_to_string()
            .map_err(|_| AsrError::MalformedOutput)?;
        let value: Value = serde_json::from_str(&body).map_err(|_| AsrError::MalformedOutput)?;
        value
            .get("prompt_id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or(AsrError::MalformedOutput)
    }

    fn read_history(&self, prompt_id: &str) -> Result<AsrResult, AsrError> {
        for _ in 0..MAX_HISTORY_POLLS {
            let mut response = self
                .agent
                .get(&format!("{}/history/{}", self.endpoint.as_str(), prompt_id))
                .call()
                .map_err(|_| AsrError::Unavailable)?;
            if response.status().as_u16() >= 300 {
                return Err(AsrError::Unavailable);
            }
            let body = response
                .body_mut()
                .read_to_string()
                .map_err(|_| AsrError::MalformedOutput)?;
            let value: Value =
                serde_json::from_str(&body).map_err(|_| AsrError::MalformedOutput)?;
            if let Some(result) = parse_history_result(&value)? {
                return Ok(result);
            }
            thread::sleep(HISTORY_POLL_INTERVAL);
        }
        Err(AsrError::Timeout)
    }
}

impl AsrProvider for ComfyUiAsrProvider {
    fn transcribe(&self, request: &AsrRequest) -> Result<AsrResult, AsrError> {
        validate_request(request)?;
        if request.audio.len() > MAX_AUDIO_BYTES {
            return Err(AsrError::InvalidInput);
        }
        let directory = self.job_dir(&request.job_id)?;
        fs::create_dir_all(&directory).map_err(|_| AsrError::Unavailable)?;
        let file_name = safe_file_name(&request.file_name);
        let path = directory.join(&file_name);
        let result = (|| {
            fs::write(&path, &request.audio).map_err(|_| AsrError::Unavailable)?;
            self.upload_audio(&path, &file_name, &request.mime_type)?;
            let prompt_id = self.submit_workflow(&file_name, request)?;
            self.read_history(&prompt_id)
        })();
        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir(&directory);
        result
    }
}

fn validate_request(request: &AsrRequest) -> Result<(), AsrError> {
    if request.job_id.trim().is_empty()
        || request.audio.is_empty()
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

fn parse_history_result(value: &Value) -> Result<Option<AsrResult>, AsrError> {
    let entry = value
        .as_object()
        .and_then(|object| object.values().next())
        .and_then(Value::as_object);
    let Some(entry) = entry else {
        return Ok(None);
    };
    if entry
        .get("status")
        .and_then(|status| status.get("completed"))
        == Some(&Value::Bool(false))
    {
        return Ok(None);
    }
    let text = find_text(value).ok_or(AsrError::MalformedOutput)?;
    if text.len() > MAX_TRANSCRIPT_BYTES || text.trim().is_empty() {
        return Err(AsrError::MalformedOutput);
    }
    Ok(Some(AsrResult {
        text,
        language: find_string(value, &["language", "detected_language"]),
        timings: Vec::new(),
        provenance: AsrProvenance {
            workflow_version: WORKFLOW_VERSION.into(),
            workflow_hash: stable_hash(WORKFLOW_JSON.as_bytes()),
            device: find_string(value, &["device", "backend"]),
            precision: find_string(value, &["precision", "dtype"]),
            model: "Qwen/Qwen3-ASR-0.6B".into(),
            node: "DarioFT/ComfyUI-Qwen3-ASR".into(),
        },
    }))
}

fn find_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return (!text.trim().is_empty()).then(|| text.to_owned());
    }
    value.as_object().and_then(|object| {
        ["text", "transcript", "output", "string"]
            .iter()
            .find_map(|key| object.get(*key).and_then(find_text))
            .or_else(|| object.values().find_map(find_text))
    })
}

fn find_string(value: &Value, keys: &[&str]) -> Option<String> {
    value.as_object().and_then(|object| {
        keys.iter()
            .find_map(|key| object.get(*key).and_then(Value::as_str).map(str::to_owned))
            .or_else(|| object.values().find_map(|value| find_string(value, keys)))
    })
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
    fn adapter_rejects_unsafe_job_ids_without_creating_staging_files() {
        let temp = tempdir().unwrap();
        let provider = ComfyUiAsrProvider::new("http://127.0.0.1:8188", temp.path()).unwrap();
        let mut request = request();
        request.job_id = "../escape".into();
        assert_eq!(provider.transcribe(&request), Err(AsrError::InvalidInput));
        assert_eq!(temp.path().read_dir().unwrap().count(), 0);
    }

    #[test]
    fn history_parser_rejects_empty_and_accepts_nested_transcript_output() {
        assert_eq!(parse_history_result(&json!({})), Ok(None));
        assert_eq!(
            parse_history_result(&json!({"job": {"outputs": {"text": ""}}})),
            Err(AsrError::MalformedOutput)
        );
        let result = parse_history_result(&json!({
            "job": {"outputs": {"node": {"transcript": "reviewed output"}}}
        }))
        .unwrap()
        .unwrap();
        assert_eq!(result.text, "reviewed output");
    }
}
