//! Narrow typed boundary between NIP and the desktop host's configured RIGA
//! provider. Provider credentials never enter NIP configuration, logs, or the
//! frontend: the host exposes only a loopback HTTP endpoint protected by a
//! per-process bearer token and performs the provider call server-side.

use std::time::Duration;

use nip_domain::{ClaimEvidence, ClaimRecord, EventRecord};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use ureq::Agent;

use crate::asr::LoopbackUrl;
use crate::{ClaimExtractionProvider, NipError};

/// Consent scope for sending transcript text to a configured remote provider.
pub const REMOTE_EXTRACTION_SCOPE: &str = "remote_transcript_extraction";
/// Versioned claim-extraction prompt/schema sent across the host bridge.
pub const BRIDGE_PROMPT_VERSION: &str = "nip-claims-riga-bridge-v1";
// Sits above the host bridge's ten-minute run cap: a full episode transcript
// is tens of thousands of characters, and a smaller budget cancelled the run
// while the model was still reading it.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(660);
const MAX_CLAIMS: usize = 50;
const MAX_CLAIM_CHARS: usize = 4_000;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum BridgeError {
    #[error("the RIGA provider bridge is not configured")]
    NotConfigured,
    #[error("the RIGA provider bridge is unavailable")]
    Unavailable,
    #[error("the RIGA provider bridge rejected the request")]
    Rejected,
    #[error("the RIGA provider bridge returned an invalid provider status")]
    InvalidStatus,
    #[error("the RIGA provider bridge returned malformed claim extraction output")]
    InvalidOutput,
}

/// Safe provider summary returned by the host bridge. It deliberately has no
/// endpoint path, API key, or other credential material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RigaBridgeProviderStatus {
    #[serde(default)]
    pub configured: bool,
    #[serde(default)]
    pub provider_kind: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub provider_api: Option<String>,
    #[serde(default)]
    pub provider_type: Option<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

impl RigaBridgeProviderStatus {
    pub fn remote(&self) -> bool {
        self.provider_kind.as_deref() == Some("remote")
    }

    pub fn validate(&self) -> Result<(), BridgeError> {
        if !self.configured {
            return Ok(());
        }
        match self.provider_kind.as_deref() {
            Some("local" | "remote") => {}
            _ => return Err(BridgeError::InvalidStatus),
        }
        if self
            .model
            .as_deref()
            .is_none_or(|model| model.trim().is_empty())
        {
            return Err(BridgeError::InvalidStatus);
        }
        Ok(())
    }

    /// Human-readable provider identity used in consent disclosures. Never
    /// includes an endpoint or key.
    pub fn provider_label(&self) -> String {
        self.provider_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned)
            .or_else(|| self.provider_type.clone())
            .or_else(|| self.provider_api.clone())
            .unwrap_or_else(|| "the configured provider".into())
    }

    pub fn consent_disclosure(&self) -> String {
        format!(
            "Transcript text and the claim-extraction prompt will be sent to {} ({}) for remote claim extraction. The provider's own retention terms may apply.",
            self.provider_label(),
            self.model.as_deref().unwrap_or("unknown model")
        )
    }
}

#[derive(Debug, Serialize)]
struct ExtractionRequest<'a> {
    event_id: &'a str,
    content_text: &'a str,
    prompt_version: &'a str,
}

#[derive(Debug, Deserialize)]
struct ExtractionResponse {
    extraction_run_id: String,
    provider_kind: String,
    #[serde(default)]
    provider_id: Option<String>,
    model: String,
    #[serde(default)]
    reasoning_effort: Option<String>,
    #[serde(default)]
    prompt_version: Option<String>,
    claims: Vec<ExtractedClaim>,
}

#[derive(Debug, Deserialize)]
struct ExtractedClaim {
    text: String,
    #[serde(default)]
    speaker_or_author: Option<String>,
    #[serde(default)]
    confidence_millis: Option<u16>,
    #[serde(default)]
    quote: Option<String>,
    #[serde(default)]
    start_offset: Option<u32>,
    #[serde(default)]
    end_offset: Option<u32>,
}

/// Client for the host-owned provider bridge. The bridge never accepts
/// credentials from NIP; it resolves the user's configured RIGA provider in the
/// desktop process and performs the completion there.
pub struct RigaBridgeClaimProvider {
    endpoint: LoopbackUrl,
    token: String,
    agent: Agent,
}

impl RigaBridgeClaimProvider {
    pub fn new(endpoint: &str, token: impl Into<String>) -> Result<Self, BridgeError> {
        let token = token.into();
        if token.trim().is_empty() || token.chars().any(char::is_whitespace) {
            return Err(BridgeError::NotConfigured);
        }
        Ok(Self {
            endpoint: LoopbackUrl::parse(endpoint).map_err(|_| BridgeError::NotConfigured)?,
            token,
            agent: Agent::config_builder()
                .http_status_as_error(false)
                .timeout_global(Some(DEFAULT_TIMEOUT))
                .build()
                .into(),
        })
    }

    pub fn provider_status(&self) -> Result<RigaBridgeProviderStatus, BridgeError> {
        let mut response = self
            .agent
            .get(&format!("{}/provider_status", self.endpoint.as_str()))
            .header("Authorization", &format!("Bearer {}", self.token))
            .call()
            .map_err(|_| BridgeError::Unavailable)?;
        match response.status().as_u16() {
            200 => {}
            401 | 403 => return Err(BridgeError::Rejected),
            _ => return Err(BridgeError::Unavailable),
        }
        let body = response
            .body_mut()
            .read_to_string()
            .map_err(|_| BridgeError::InvalidStatus)?;
        let status: RigaBridgeProviderStatus =
            serde_json::from_str(&body).map_err(|_| BridgeError::InvalidStatus)?;
        status.validate()?;
        Ok(status)
    }

    /// Extract claims using a status snapshot already resolved for the current
    /// derivation. The response must resolve to the same provider/model binding.
    pub fn extract_with_status(
        &self,
        event: &EventRecord,
        status: &RigaBridgeProviderStatus,
    ) -> Result<Vec<ClaimRecord>, NipError> {
        if !status.configured {
            return Err(NipError::ProviderUnavailable);
        }
        let text = event.content_text.as_deref().unwrap_or("").trim();
        if text.is_empty() {
            return Err(NipError::ExtractionFailed);
        }
        let request = ExtractionRequest {
            event_id: event.event_id.as_str(),
            content_text: text,
            prompt_version: BRIDGE_PROMPT_VERSION,
        };
        let payload = serde_json::to_string(&request).map_err(|_| NipError::ExtractionFailed)?;
        let mut response = self
            .agent
            .post(&format!("{}/claims/extract", self.endpoint.as_str()))
            .header("Authorization", &format!("Bearer {}", self.token))
            .header("Content-Type", "application/json")
            .send(payload)
            .map_err(|_| NipError::ProviderUnavailable)?;
        let status_code = response.status().as_u16();
        if status_code != 200 {
            // The bridge reports why the run failed (endpoint down, provider
            // not configured, model missing, run timed out). Keep that reason:
            // "provider unavailable" alone tells the operator nothing.
            let body = response.body_mut().read_to_string().unwrap_or_default();
            let message = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| {
                    value
                        .get("message")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_owned)
                })
                .filter(|message| !message.trim().is_empty())
                .unwrap_or_else(|| format!("the provider bridge returned HTTP {status_code}"));
            return Err(NipError::ExtractionRejected(message));
        }
        let body = response
            .body_mut()
            .read_to_string()
            .map_err(|_| NipError::ExtractionFailed)?;
        let extraction: ExtractionResponse =
            serde_json::from_str(&body).map_err(|_| NipError::ExtractionFailed)?;
        self.to_claims(event, status, extraction)
    }

    fn to_claims(
        &self,
        event: &EventRecord,
        status: &RigaBridgeProviderStatus,
        extraction: ExtractionResponse,
    ) -> Result<Vec<ClaimRecord>, NipError> {
        if extraction.extraction_run_id.trim().is_empty()
            || extraction.claims.is_empty()
            || extraction.claims.len() > MAX_CLAIMS
            || extraction.model != status.model.as_deref().unwrap_or_default()
            || Some(extraction.provider_kind.as_str()) != status.provider_kind.as_deref()
            || extraction.provider_id != status.provider_id
            || extraction
                .prompt_version
                .as_deref()
                .is_some_and(|version| version != BRIDGE_PROMPT_VERSION)
        {
            return Err(NipError::ExtractionFailed);
        }
        let reasoning_effort = extraction
            .reasoning_effort
            .clone()
            .or_else(|| status.reasoning_effort.clone());
        let text_length = event
            .content_text
            .as_deref()
            .map(|text| text.chars().count() as u32)
            .unwrap_or(0);
        extraction
            .claims
            .into_iter()
            .enumerate()
            .map(|(index, claim)| {
                let claim_text = claim.text.trim().to_owned();
                if claim_text.is_empty() || claim_text.chars().count() > MAX_CLAIM_CHARS {
                    return Err(NipError::ExtractionFailed);
                }
                let confidence_millis = claim.confidence_millis.unwrap_or(500);
                if confidence_millis > 1_000 {
                    return Err(NipError::ExtractionFailed);
                }
                let quote = claim
                    .quote
                    .map(|value| value.trim().to_owned())
                    .filter(|value| !value.is_empty());
                if claim.start_offset.is_some_and(|offset| offset > text_length)
                    || claim.end_offset.is_some_and(|offset| offset > text_length)
                    || matches!((claim.start_offset, claim.end_offset), (Some(start), Some(end)) if start > end)
                {
                    return Err(NipError::ExtractionFailed);
                }
                Ok(ClaimRecord {
                    claim_id: format!(
                        "claim-{}",
                        &stable_hash(format!(
                            "{}\0{index}\0{}",
                            extraction.extraction_run_id, claim_text
                        ))[..24]
                    ),
                    claim_text,
                    speaker_or_author: claim
                        .speaker_or_author
                        .map(|value| value.trim().to_owned())
                        .filter(|value| !value.is_empty()),
                    confidence_millis,
                    extraction_run_id: extraction.extraction_run_id.clone(),
                    provider: "riga_bridge".into(),
                    model: extraction.model.clone(),
                    prompt_version: BRIDGE_PROMPT_VERSION.into(),
                    provider_kind: Some(extraction.provider_kind.clone()),
                    provider_profile_id: extraction.provider_id.clone(),
                    reasoning_effort: reasoning_effort.clone(),
                    extracted_at: chrono::Utc::now(),
                    evidence: vec![ClaimEvidence {
                        event_id: event.event_id.clone(),
                        quote,
                        start_offset: claim.start_offset,
                        end_offset: claim.end_offset,
                    }],
                })
            })
            .collect()
    }
}

impl ClaimExtractionProvider for RigaBridgeClaimProvider {
    fn extract(&self, event: &EventRecord) -> Result<Vec<ClaimRecord>, NipError> {
        let status = self
            .provider_status()
            .map_err(|_| NipError::ProviderUnavailable)?;
        self.extract_with_status(event, &status)
    }
}

fn stable_hash(value: String) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event() -> EventRecord {
        EventRecord {
            schema_version: 1,
            event_id: nip_domain::EventId::new("event-1").unwrap(),
            source_id: nip_domain::SourceId::new("fixture-show").unwrap(),
            source_native_id: None,
            canonical_url: None,
            content_hash: "hash".into(),
            content_text: Some("A retained transcript".into()),
            times: nip_domain::EventTimes {
                published_at: None,
                source_updated_at: None,
                captured_at: "2026-11-18T01:00:00Z".parse().unwrap(),
                ingested_at: "2026-11-18T01:00:01Z".parse().unwrap(),
            },
            revision_of: None,
        }
    }

    fn configured_status() -> RigaBridgeProviderStatus {
        RigaBridgeProviderStatus {
            configured: true,
            provider_kind: Some("remote".into()),
            provider_id: Some("provider-a".into()),
            model: Some("model-a".into()),
            reasoning_effort: Some("low".into()),
            provider_api: Some("chat".into()),
            provider_type: Some("open_ai_compatible".into()),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn a_failed_provider_run_keeps_the_bridge_reason() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 4096];
            let _ = stream.read(&mut buffer);
            let body =
                r#"{"code":"extraction_failed","message":"the provider run did not complete"}"#;
            let response = format!(
                "HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
        });
        let provider = RigaBridgeClaimProvider::new(&format!("http://{address}"), "token").unwrap();
        let error = provider
            .extract_with_status(&event(), &configured_status())
            .unwrap_err();
        // "provider unavailable" alone leaves an operator with no next step;
        // the bridge knows whether the endpoint or the run failed.
        assert!(
            matches!(&error, NipError::ExtractionRejected(message) if message == "the provider run did not complete"),
            "unexpected error: {error}"
        );
        server.join().unwrap();
    }

    #[test]
    fn status_validation_requires_a_kind_and_model_only_when_configured() {
        let unconfigured = RigaBridgeProviderStatus {
            configured: false,
            provider_kind: None,
            provider_id: None,
            model: None,
            reasoning_effort: None,
            provider_api: None,
            provider_type: None,
            warnings: vec!["not_configured".into()],
        };
        assert!(unconfigured.validate().is_ok());

        let mut configured = RigaBridgeProviderStatus {
            configured: true,
            provider_kind: Some("remote".into()),
            provider_id: Some("provider-a".into()),
            model: Some("model-a".into()),
            reasoning_effort: Some("low".into()),
            provider_api: Some("chat".into()),
            provider_type: Some("open_ai_compatible".into()),
            warnings: Vec::new(),
        };
        assert!(configured.validate().is_ok());
        configured.provider_kind = Some("unexpected".into());
        assert_eq!(configured.validate(), Err(BridgeError::InvalidStatus));
    }

    #[test]
    fn bridge_rejects_empty_or_whitespace_bearer_tokens() {
        assert!(matches!(
            RigaBridgeClaimProvider::new("http://127.0.0.1:12345", " "),
            Err(BridgeError::NotConfigured)
        ));
        assert!(matches!(
            RigaBridgeClaimProvider::new("http://127.0.0.1:12345", "a b"),
            Err(BridgeError::NotConfigured)
        ));
    }

    #[test]
    fn disclosure_names_the_provider_and_model_without_an_endpoint() {
        let status = RigaBridgeProviderStatus {
            configured: true,
            provider_kind: Some("remote".into()),
            provider_id: Some("provider-a".into()),
            model: Some("model-a".into()),
            reasoning_effort: None,
            provider_api: None,
            provider_type: None,
            warnings: Vec::new(),
        };
        let disclosure = status.consent_disclosure();
        assert!(disclosure.contains("provider-a"));
        assert!(disclosure.contains("model-a"));
        assert!(!disclosure.contains("http"));
    }
}
