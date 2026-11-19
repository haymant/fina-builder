//! Direct local LLM adapter for NIP claim extraction.
//!
//! This path calls a user-configured OpenAI-compatible server on loopback; it
//! does not use the RIGA bridge, remote endpoints, credentials, or fallback
//! providers. Model output remains untrusted until exact transcript spans pass
//! validation below.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use chrono::Utc;
use nip_domain::{ClaimEvidence, ClaimRecord, EventRecord};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use thiserror::Error;
use ureq::Agent;

use crate::asr::LoopbackUrl;
use crate::config::LocalLlmConfig;
use crate::{ClaimExtractionProvider, NipError};

pub const PROMPT_VERSION: &str = "nip-claims-direct-local-openai-v1";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(660);
const MAX_CLAIMS: usize = 50;
const MAX_CLAIM_CHARS: usize = 4_000;
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;
static RUN_COUNTER: AtomicU64 = AtomicU64::new(1);

const SYSTEM_PROMPT: &str = r#"Extract only factual claims explicitly stated in the supplied transcript. Do not add outside knowledge, infer missing details, or rewrite uncertainty as certainty. Return one JSON object with a `claims` array; an empty array is valid when no supportable claims exist. Each claim object must contain:
- `text`: a concise, faithful statement of one claim;
- `speaker_or_author`: the transcript speaker or null when attribution is unavailable;
- `confidence_millis`: integer from 0 through 1000, or null;
- `quote`: an exact, contiguous, verbatim substring of the transcript;
- `start_offset` and `end_offset`: zero-based Unicode scalar-value offsets into the exact transcript, using a half-open [start,end) range that selects exactly `quote`.
Do not emit a claim without an exact quote and both offsets. Do not return Markdown fences or any text outside the JSON object."#;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum LocalModelError {
    #[error("the configured local model endpoint is unavailable")]
    Unavailable,
    #[error("the configured model is not listed by the local endpoint")]
    ModelNotFound,
}

#[derive(Debug, Deserialize)]
struct ModelList {
    data: Vec<ModelItem>,
}

#[derive(Debug, Deserialize)]
struct ModelItem {
    id: String,
}

#[derive(Debug, Deserialize)]
struct ChatResponse {
    model: String,
    choices: Vec<ChatChoice>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Debug, Deserialize)]
struct ChatMessage {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClaimPayload {
    claims: Vec<ExtractedClaim>,
}

#[derive(Debug, Deserialize)]
struct ExtractedClaim {
    text: String,
    #[serde(default)]
    speaker_or_author: Option<String>,
    #[serde(default)]
    confidence_millis: Option<u16>,
    quote: String,
    start_offset: u32,
    end_offset: u32,
}

/// Direct local provider; its base URL has already passed loopback-only
/// validation in `NipConfig` and the model is a user-selected exact identifier.
pub struct LocalOpenAiClaimProvider {
    base_url: LoopbackUrl,
    model: String,
    agent: Agent,
}

impl LocalOpenAiClaimProvider {
    pub fn new(config: &LocalLlmConfig) -> Self {
        Self {
            base_url: LoopbackUrl::parse(config.base_url())
                .expect("NipConfig only stores a validated loopback URL"),
            model: config.model().to_owned(),
            agent: Agent::config_builder()
                .http_status_as_error(false)
                .proxy(None)
                .max_redirects(0)
                .timeout_global(Some(REQUEST_TIMEOUT))
                .build()
                .into(),
        }
    }

    /// Check that the endpoint is reachable and advertises the exact configured
    /// model. No transcript content is sent during this readiness check.
    pub fn check_model(&self) -> Result<(), LocalModelError> {
        let mut response = self
            .agent
            .get(&format!("{}/models", self.base_url.as_str()))
            .call()
            .map_err(|_| LocalModelError::Unavailable)?;
        if response.status().as_u16() != 200 {
            return Err(LocalModelError::Unavailable);
        }
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_RESPONSE_BYTES)
            .read_to_string()
            .map_err(|_| LocalModelError::Unavailable)?;
        let models: ModelList =
            serde_json::from_str(&body).map_err(|_| LocalModelError::Unavailable)?;
        if models.data.iter().any(|item| item.id == self.model) {
            Ok(())
        } else {
            Err(LocalModelError::ModelNotFound)
        }
    }

    fn extract_local(&self, event: &EventRecord) -> Result<Vec<ClaimRecord>, NipError> {
        let transcript = event.content_text.as_deref().unwrap_or("");
        if transcript.trim().is_empty() {
            return Err(NipError::ExtractionFailed);
        }
        let payload = json!({
            "model": self.model,
            "temperature": 0,
            "stream": false,
            "response_format": { "type": "json_object" },
            "messages": [
                { "role": "system", "content": SYSTEM_PROMPT },
                { "role": "user", "content": format!(
                    "event_id: {}\nTranscript (offsets count Unicode scalar values):\n{}",
                    event.event_id.as_str(), transcript
                ) }
            ]
        });
        let mut response = self
            .agent
            .post(&format!("{}/chat/completions", self.base_url.as_str()))
            .header("Content-Type", "application/json")
            .send_json(payload)
            .map_err(|_| NipError::ProviderUnavailable)?;
        let status = response.status().as_u16();
        if status != 200 {
            return Err(NipError::ExtractionRejected(format!(
                "the direct local model endpoint returned HTTP {status}"
            )));
        }
        let body = response
            .body_mut()
            .with_config()
            .limit(MAX_RESPONSE_BYTES)
            .read_to_string()
            .map_err(|_| NipError::ExtractionFailed)?;
        let chat: ChatResponse =
            serde_json::from_str(&body).map_err(|_| NipError::ExtractionFailed)?;
        if chat.model != self.model || chat.choices.len() != 1 {
            return Err(NipError::ExtractionFailed);
        }
        let content = chat.choices[0]
            .message
            .content
            .as_deref()
            .ok_or(NipError::ExtractionFailed)?;
        let claims: ClaimPayload =
            serde_json::from_str(content).map_err(|_| NipError::ExtractionFailed)?;
        if claims.claims.len() > MAX_CLAIMS {
            return Err(NipError::ExtractionFailed);
        }
        build_claim_records(event, &self.model, claims.claims)
    }
}

impl ClaimExtractionProvider for LocalOpenAiClaimProvider {
    fn extract(&self, event: &EventRecord) -> Result<Vec<ClaimRecord>, NipError> {
        self.extract_local(event)
    }
}

fn build_claim_records(
    event: &EventRecord,
    model: &str,
    claims: Vec<ExtractedClaim>,
) -> Result<Vec<ClaimRecord>, NipError> {
    let transcript = event.content_text.as_deref().unwrap_or("");
    let characters = transcript.chars().collect::<Vec<_>>();
    let run_sequence = RUN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let run_id = format!(
        "direct-local-{}-{}",
        Utc::now().timestamp_millis(),
        run_sequence
    );
    claims
        .into_iter()
        .enumerate()
        .map(|(index, claim)| {
            let claim_text = claim.text.trim().to_owned();
            let quote = claim.quote;
            let start =
                usize::try_from(claim.start_offset).map_err(|_| NipError::ExtractionFailed)?;
            let end = usize::try_from(claim.end_offset).map_err(|_| NipError::ExtractionFailed)?;
            if claim_text.is_empty()
                || claim_text.chars().count() > MAX_CLAIM_CHARS
                || quote.trim().is_empty()
                || end <= start
                || end > characters.len()
                || characters[start..end].iter().collect::<String>() != quote
                || claim
                    .confidence_millis
                    .is_some_and(|confidence| confidence > 1_000)
            {
                return Err(NipError::ExtractionFailed);
            }
            let identity = format!("{run_id}\0{index}\0{claim_text}");
            Ok(ClaimRecord {
                claim_id: format!("claim-{}", &stable_hash(&identity)[..24]),
                claim_text,
                speaker_or_author: claim
                    .speaker_or_author
                    .map(|value| value.trim().to_owned())
                    .filter(|value| !value.is_empty()),
                confidence_millis: claim.confidence_millis.unwrap_or(500),
                extraction_run_id: run_id.clone(),
                provider: "direct_local_openai_compatible".into(),
                model: model.to_owned(),
                prompt_version: PROMPT_VERSION.into(),
                provider_kind: Some("local".into()),
                provider_profile_id: Some("direct-local".into()),
                reasoning_effort: None,
                extracted_at: Utc::now(),
                evidence: vec![ClaimEvidence {
                    event_id: event.event_id.clone(),
                    quote: Some(quote),
                    start_offset: Some(claim.start_offset),
                    end_offset: Some(claim.end_offset),
                }],
            })
        })
        .collect()
}

fn stable_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread::{self, JoinHandle};

    use crate::config::NipConfig;
    use nip_domain::{EventId, EventTimes, SourceId};
    use tempfile::tempdir;

    fn fixture_event(content: &str) -> EventRecord {
        let now = Utc::now();
        EventRecord {
            schema_version: 1,
            event_id: EventId::new("event-local-provider-test").unwrap(),
            source_id: SourceId::new("source-local-provider-test").unwrap(),
            source_native_id: Some("episode-1".into()),
            canonical_url: None,
            content_hash: "fixture-hash".into(),
            content_text: Some(content.into()),
            times: EventTimes {
                published_at: None,
                source_updated_at: None,
                captured_at: now,
                ingested_at: now,
            },
            revision_of: None,
        }
    }

    fn config_for(base_url: &str) -> LocalLlmConfig {
        let values = BTreeMap::from([
            ("NIP_LOCAL_LLM_URL".into(), base_url.into()),
            ("NIP_LOCAL_LLM_MODEL".into(), "fixture-model".into()),
        ]);
        let root = tempdir().unwrap();
        NipConfig::resolve(&values, root.path(), None, true)
            .unwrap()
            .local_llm()
            .unwrap()
            .clone()
    }

    fn read_request(stream: &mut TcpStream) -> String {
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 4096];
        let mut header_end = None;
        let mut expected_total = None;
        loop {
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0, "client closed before sending a complete request");
            bytes.extend_from_slice(&chunk[..read]);
            if header_end.is_none() {
                if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                    let end = index + 4;
                    let headers = String::from_utf8_lossy(&bytes[..index]);
                    let content_length = headers
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    header_end = Some(end);
                    expected_total = Some(end + content_length);
                }
            }
            if expected_total.is_some_and(|total| bytes.len() >= total) {
                break;
            }
        }
        String::from_utf8(bytes).unwrap()
    }

    fn respond(stream: &mut TcpStream, value: serde_json::Value) {
        let body = value.to_string();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
        stream.flush().unwrap();
    }

    fn fixture_server(
        content: String,
        advertised_models: Vec<&'static str>,
        expected_requests: usize,
    ) -> (String, JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let mut requests = Vec::new();
            for _ in 0..expected_requests {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream);
                if request.starts_with("GET /v1/models ") {
                    respond(
                        &mut stream,
                        json!({"data": advertised_models.iter().map(|id| json!({"id":id})).collect::<Vec<_>>() }),
                    );
                } else {
                    respond(
                        &mut stream,
                        json!({
                            "model":"fixture-model",
                            "choices":[{"message":{"content":content}}]
                        }),
                    );
                }
                requests.push(request);
            }
            requests
        });
        (format!("http://{address}/v1"), handle)
    }

    fn redirect_server(location: String) -> (String, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            write!(
                stream,
                "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .unwrap();
            stream.flush().unwrap();
            request
        });
        (format!("http://{address}/v1"), handle)
    }

    #[test]
    fn direct_local_extracts_only_exact_unicode_evidence_without_auth() {
        let transcript = "🛰️ The company announced a $4 billion investment.";
        let quote = "The company announced a $4 billion investment.";
        let start = transcript.find(quote).unwrap();
        let start_chars = transcript[..start].chars().count();
        let end_chars = start_chars + quote.chars().count();
        let content = json!({
            "claims":[{
                "text":"The company announced a $4 billion investment.",
                "speaker_or_author":"Host",
                "confidence_millis":850,
                "quote":quote,
                "start_offset":start_chars,
                "end_offset":end_chars
            }]
        })
        .to_string();
        let (base_url, server) = fixture_server(content, vec!["fixture-model"], 2);
        let config = config_for(&base_url);
        let provider = LocalOpenAiClaimProvider::new(&config);
        provider.check_model().unwrap();
        let event = fixture_event(transcript);
        let claims = provider.extract(&event).unwrap();
        let requests = server.join().unwrap();

        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].provider, "direct_local_openai_compatible");
        assert_eq!(claims[0].provider_kind.as_deref(), Some("local"));
        assert_eq!(claims[0].model, "fixture-model");
        assert_eq!(claims[0].evidence[0].quote.as_deref(), Some(quote));
        assert_eq!(claims[0].evidence[0].start_offset, Some(start_chars as u32));
        assert_eq!(claims[0].evidence[0].end_offset, Some(end_chars as u32));
        assert!(requests[0].starts_with("GET /v1/models "));
        assert!(requests[1].starts_with("POST /v1/chat/completions "));
        assert!(!requests
            .iter()
            .any(|request| request.to_ascii_lowercase().contains("authorization:")));
        let chat_body = requests[1].split_once("\r\n\r\n").unwrap().1;
        let payload: serde_json::Value = serde_json::from_str(chat_body).unwrap();
        assert_eq!(payload["model"], "fixture-model");
        assert_eq!(payload["response_format"]["type"], "json_object");
        assert!(payload["messages"][1]["content"]
            .as_str()
            .unwrap()
            .contains(transcript));
    }

    #[test]
    fn local_endpoint_redirects_are_not_followed() {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let target_address = target.local_addr().unwrap();
        let (base_url, server) = redirect_server(format!("http://{target_address}/v1/models"));
        let config = config_for(&base_url);
        let provider = LocalOpenAiClaimProvider::new(&config);
        assert_eq!(provider.check_model(), Err(LocalModelError::Unavailable));
        assert!(server.join().unwrap().starts_with("GET /v1/models "));
        thread::sleep(Duration::from_millis(25));
        assert!(matches!(
            target.accept(),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock
        ));
    }

    #[test]
    fn local_agent_ignores_environment_proxy_configuration() {
        let provider = LocalOpenAiClaimProvider::new(&config_for("http://127.0.0.1:1234/v1"));
        assert!(provider.agent.config().proxy().is_none());
        assert_eq!(provider.agent.config().max_redirects(), 0);
    }

    #[test]
    fn proxy_environment_does_not_receive_local_model_requests() {
        const CHILD_MARKER: &str = "NIP_DIRECT_LOCAL_PROXY_TEST_CHILD";
        if std::env::var_os(CHILD_MARKER).is_some() {
            let endpoint = std::env::var("NIP_DIRECT_LOCAL_TEST_ENDPOINT").unwrap();
            let provider = LocalOpenAiClaimProvider::new(&config_for(&endpoint));
            provider.check_model().unwrap();
            return;
        }

        let (base_url, model_server) = fixture_server("{}".into(), vec!["fixture-model"], 1);
        let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
        proxy.set_nonblocking(true).unwrap();
        let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
        let proxy_observer = thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            while std::time::Instant::now() < deadline {
                match proxy.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
                        let _ = read_request(&mut stream);
                        let _ = write!(
                            stream,
                            "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        );
                        return true;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => return true,
                }
            }
            false
        });
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "local_model::tests::proxy_environment_does_not_receive_local_model_requests",
                "--nocapture",
            ])
            .env(CHILD_MARKER, "1")
            .env("NIP_DIRECT_LOCAL_TEST_ENDPOINT", &base_url)
            .env("HTTP_PROXY", &proxy_url)
            .env("http_proxy", &proxy_url)
            .env("HTTPS_PROXY", &proxy_url)
            .env("https_proxy", &proxy_url)
            .env("ALL_PROXY", &proxy_url)
            .env("all_proxy", &proxy_url)
            .env("NO_PROXY", "")
            .env("no_proxy", "")
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            stdout.contains("1 passed"),
            "child test did not run: {stdout}"
        );
        let model_requests = model_server.join().unwrap();
        assert!(model_requests[0].starts_with("GET /v1/models "));
        assert!(!proxy_observer.join().unwrap());
    }

    #[test]
    fn oversized_local_model_list_is_rejected() {
        let model_id = Box::leak("m".repeat(MAX_RESPONSE_BYTES as usize).into_boxed_str());
        let (base_url, server) = fixture_server("ignored".into(), vec![model_id], 1);
        let provider = LocalOpenAiClaimProvider::new(&config_for(&base_url));
        assert_eq!(provider.check_model(), Err(LocalModelError::Unavailable));
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET /v1/models "));
    }

    #[test]
    fn configured_local_model_must_be_advertised_and_invalid_spans_fail_closed() {
        let (base_url, server) = fixture_server("ignored".into(), vec!["other-model"], 1);
        let config = config_for(&base_url);
        let provider = LocalOpenAiClaimProvider::new(&config);
        assert_eq!(provider.check_model(), Err(LocalModelError::ModelNotFound));
        let _ = server.join().unwrap();

        let event = fixture_event("A quote is present.");
        let invalid = ExtractedClaim {
            text: "A quote is present.".into(),
            speaker_or_author: None,
            confidence_millis: None,
            quote: "not in source".into(),
            start_offset: 0,
            end_offset: 3,
        };
        assert!(build_claim_records(&event, "fixture-model", vec![invalid]).is_err());
        assert!(build_claim_records(&event, "fixture-model", Vec::new())
            .unwrap()
            .is_empty());
    }
}
