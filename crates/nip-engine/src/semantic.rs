use chrono::Utc;
use nip_domain::{
    EmbeddingIndexManifest, EventRecord, NarrativeCluster, NarrativeClusterMember,
    SemanticSearchResult,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use thiserror::Error;
use ureq::Agent;

pub const DEFAULT_MODEL_ID: &str = "BAAI/bge-m3";
pub const DEFAULT_MODEL_REVISION: &str = "main";
pub const DEFAULT_DIMENSIONS: usize = 1024;
pub const CHUNKING_VERSION: &str = "nip-chunk-v1";
pub const CLUSTER_ALGORITHM_VERSION: &str = "centroid-v1-threshold-0.78";

#[derive(Debug, Clone, PartialEq)]
pub struct EmbeddingVector {
    pub dense: Vec<f32>,
    pub lexical_indices: Vec<u32>,
    pub lexical_values: Vec<f32>,
}

#[derive(Debug, Error)]
pub enum SemanticError {
    #[error("embedding provider is unavailable")]
    ProviderUnavailable,
    #[error("embedding response is invalid")]
    InvalidEmbedding,
    #[error("Qdrant vector index is unavailable")]
    IndexUnavailable,
    #[error("Qdrant response is invalid")]
    InvalidIndexResponse,
}

pub trait EmbeddingProvider: Send + Sync {
    fn model_id(&self) -> &str;
    fn model_revision(&self) -> &str;
    fn dimensions(&self) -> usize;
    fn embed(&self, text: &str) -> Result<EmbeddingVector, SemanticError>;
}

#[derive(Debug, Clone)]
pub struct DeterministicEmbeddingProvider {
    dimensions: usize,
}

impl DeterministicEmbeddingProvider {
    pub fn new(dimensions: usize) -> Self {
        Self {
            dimensions: dimensions.max(8),
        }
    }
}

impl EmbeddingProvider for DeterministicEmbeddingProvider {
    fn model_id(&self) -> &str {
        "deterministic-test-embedding"
    }
    fn model_revision(&self) -> &str {
        "v1"
    }
    fn dimensions(&self) -> usize {
        self.dimensions
    }
    fn embed(&self, text: &str) -> Result<EmbeddingVector, SemanticError> {
        let mut dense = vec![0.0; self.dimensions];
        for token in text
            .split_whitespace()
            .map(|token| token.to_ascii_lowercase())
        {
            let digest = Sha256::digest(token.as_bytes());
            let index =
                u64::from_le_bytes(digest[0..8].try_into().unwrap()) as usize % self.dimensions;
            dense[index] += 1.0;
        }
        normalize(&mut dense);
        Ok(EmbeddingVector {
            dense,
            ..lexical_vector(text)
        })
    }
}

#[derive(Debug, Clone)]
pub struct HttpEmbeddingProvider {
    endpoint: String,
    model_id: String,
    model_revision: String,
    dimensions: usize,
    agent: Agent,
}

impl HttpEmbeddingProvider {
    pub fn new(
        endpoint: String,
        model_id: String,
        model_revision: String,
        dimensions: usize,
    ) -> Self {
        Self {
            endpoint,
            model_id,
            model_revision,
            dimensions,
            agent: Agent::new_with_defaults(),
        }
    }
}

#[derive(Serialize)]
struct EmbeddingRequest<'a> {
    input: [&'a str; 1],
    model: &'a str,
}
#[derive(Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingData>,
}
#[derive(Deserialize)]
struct EmbeddingData {
    embedding: Vec<f32>,
}

impl EmbeddingProvider for HttpEmbeddingProvider {
    fn model_id(&self) -> &str {
        &self.model_id
    }
    fn model_revision(&self) -> &str {
        &self.model_revision
    }
    fn dimensions(&self) -> usize {
        self.dimensions
    }
    fn embed(&self, text: &str) -> Result<EmbeddingVector, SemanticError> {
        let response = self
            .agent
            .post(&format!(
                "{}/embeddings",
                self.endpoint.trim_end_matches('/')
            ))
            .send_json(EmbeddingRequest {
                input: [text],
                model: &self.model_id,
            })
            .map_err(|_| SemanticError::ProviderUnavailable)?;
        let parsed: EmbeddingResponse = response
            .into_body()
            .read_json()
            .map_err(|_| SemanticError::InvalidEmbedding)?;
        let dense = parsed
            .data
            .into_iter()
            .next()
            .ok_or(SemanticError::InvalidEmbedding)?
            .embedding;
        if dense.len() != self.dimensions {
            return Err(SemanticError::InvalidEmbedding);
        }
        Ok(EmbeddingVector {
            dense,
            ..lexical_vector(text)
        })
    }
}

fn normalize(values: &mut [f32]) {
    let norm = values.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > 0.0 {
        for value in values {
            *value /= norm;
        }
    }
}

fn lexical_vector(text: &str) -> EmbeddingVector {
    let mut map: HashMap<u32, f32> = HashMap::new();
    for token in text
        .split_whitespace()
        .map(|token| token.to_ascii_lowercase())
    {
        let digest = Sha256::digest(token.as_bytes());
        let index = u32::from_le_bytes(digest[0..4].try_into().unwrap());
        *map.entry(index).or_default() += 1.0;
    }
    let norm = map
        .values()
        .map(|value| value * value)
        .sum::<f32>()
        .sqrt()
        .max(1.0);
    let mut pairs = map.into_iter().collect::<Vec<_>>();
    pairs.sort_by_key(|(index, _)| *index);
    let (indices, values) = pairs
        .into_iter()
        .map(|(index, value)| (index, value / norm))
        .unzip();
    EmbeddingVector {
        dense: Vec::new(),
        lexical_indices: indices,
        lexical_values: values,
    }
}

#[derive(Debug, Clone)]
pub struct QdrantIndex {
    endpoint: String,
    collection: String,
    dimensions: usize,
    agent: Agent,
}

impl QdrantIndex {
    pub fn new(endpoint: String, collection: String, dimensions: usize) -> Self {
        Self {
            endpoint: endpoint.trim_end_matches('/').to_owned(),
            collection,
            dimensions,
            agent: Agent::new_with_defaults(),
        }
    }

    fn url(&self, suffix: &str) -> String {
        format!(
            "{}/collections/{}/{}",
            self.endpoint, self.collection, suffix
        )
    }

    pub fn ensure_collection(&self) -> Result<(), SemanticError> {
        if self
            .agent
            .get(&format!(
                "{}/collections/{}",
                self.endpoint, self.collection
            ))
            .call()
            .is_ok()
        {
            return Ok(());
        }
        let body = serde_json::json!({
            "vectors": { "dense": { "size": self.dimensions, "distance": "Cosine" } },
            "sparse_vectors": { "lexical": {} }
        });
        self.agent
            .put(&format!(
                "{}/collections/{}",
                self.endpoint, self.collection
            ))
            .send_json(body)
            .map(|_| ())
            .map_err(|_| SemanticError::IndexUnavailable)
    }

    pub fn upsert(
        &self,
        event: &EventRecord,
        vector: &EmbeddingVector,
        index_id: &str,
    ) -> Result<(), SemanticError> {
        let point_id = stable_point_id(event.event_id.as_str());
        let body = serde_json::json!({ "points": [{
            "id": point_id,
            "vector": { "dense": vector.dense, "lexical": { "indices": vector.lexical_indices, "values": vector.lexical_values } },
            "payload": { "event_id": event.event_id.as_str(), "content_hash": event.content_hash, "index_id": index_id }
        }] });
        self.agent
            .put(&format!("{}?wait=true", self.url("points")))
            .send_json(body)
            .map(|_| ())
            .map_err(|_| SemanticError::IndexUnavailable)
    }

    pub fn search(
        &self,
        vector: &EmbeddingVector,
        index_id: &str,
        events: &HashMap<String, EventRecord>,
        limit: u32,
    ) -> Result<Vec<SemanticSearchResult>, SemanticError> {
        let body = serde_json::json!({
            "prefetch": [
                { "query": vector.dense, "using": "dense", "limit": limit.max(10) },
                { "query": { "indices": vector.lexical_indices, "values": vector.lexical_values }, "using": "lexical", "limit": limit.max(10) }
            ], "query": { "rrf": {} }, "limit": limit, "with_payload": true
        });
        let response = self
            .agent
            .post(&self.url("points/query"))
            .send_json(body)
            .map_err(|_| SemanticError::IndexUnavailable)?;
        let value: serde_json::Value = response
            .into_body()
            .read_json()
            .map_err(|_| SemanticError::InvalidIndexResponse)?;
        let points = parse_search_points(&value)?;
        let mut results = Vec::new();
        for (event_id, score) in points {
            if let Some(event) = events.get(&event_id) {
                results.push(SemanticSearchResult {
                    event: event.clone(),
                    score,
                    index_id: index_id.to_owned(),
                });
            }
        }
        Ok(results)
    }
}

fn parse_search_points(value: &serde_json::Value) -> Result<Vec<(String, f32)>, SemanticError> {
    value
        .get("result")
        .and_then(|result| result.get("points"))
        .and_then(|points| points.as_array())
        .ok_or(SemanticError::InvalidIndexResponse)?
        .iter()
        .map(|point| {
            let score = point
                .get("score")
                .and_then(|score| score.as_f64())
                .unwrap_or(0.0) as f32;
            let event_id = point
                .get("payload")
                .and_then(|payload| payload.get("event_id"))
                .and_then(|id| id.as_str())
                .ok_or(SemanticError::InvalidIndexResponse)?
                .to_owned();
            Ok((event_id, score))
        })
        .collect()
}

fn stable_point_id(event_id: &str) -> u64 {
    u64::from_le_bytes(
        Sha256::digest(event_id.as_bytes())[0..8]
            .try_into()
            .unwrap(),
    )
}

pub fn cluster_events(
    events: &[(EventRecord, Vec<f32>)],
    derivation_run_id: String,
) -> Vec<NarrativeCluster> {
    let mut centroids: Vec<Vec<f32>> = Vec::new();
    let mut members: Vec<Vec<NarrativeClusterMember>> = Vec::new();
    for (event, vector) in events {
        let mut best = None;
        for (index, centroid) in centroids.iter().enumerate() {
            let similarity = cosine(vector, centroid);
            if similarity >= 0.78
                && best
                    .map(|(_, score): (usize, f32)| score < similarity)
                    .unwrap_or(true)
            {
                best = Some((index, similarity));
            }
        }
        let (cluster_index, similarity) = best.unwrap_or_else(|| {
            centroids.push(vector.clone());
            members.push(Vec::new());
            (centroids.len() - 1, 1.0)
        });
        if cluster_index < centroids.len() && similarity < 1.0 {
            let count = members[cluster_index].len() as f32;
            for (target, source) in centroids[cluster_index].iter_mut().zip(vector) {
                *target = (*target * count + *source) / (count + 1.0);
            }
            normalize(&mut centroids[cluster_index]);
        }
        let rank = members[cluster_index].len() as u32 + 1;
        members[cluster_index].push(NarrativeClusterMember {
            event_id: event.event_id.clone(),
            similarity_millis: (similarity.clamp(0.0, 1.0) * 1000.0) as u16,
            rank,
        });
    }
    members
        .into_iter()
        .enumerate()
        .map(|(index, members)| NarrativeCluster {
            cluster_id: format!("cluster-{}", index + 1),
            derivation_run_id: derivation_run_id.clone(),
            label: members
                .first()
                .map(|member| member.event_id.as_str().to_owned())
                .unwrap_or_else(|| "empty".into()),
            algorithm_version: CLUSTER_ALGORITHM_VERSION.into(),
            member_count: members.len() as u32,
            created_at: Utc::now(),
            members,
        })
        .collect()
}

fn cosine(left: &[f32], right: &[f32]) -> f32 {
    left.iter().zip(right).map(|(a, b)| a * b).sum()
}

pub fn manifest(
    index_id: String,
    provider: &dyn EmbeddingProvider,
    collection_name: String,
    status: &str,
    event_count: u32,
) -> EmbeddingIndexManifest {
    EmbeddingIndexManifest {
        index_id,
        model_id: provider.model_id().into(),
        model_revision: provider.model_revision().into(),
        dimensions: provider.dimensions() as u32,
        chunking_version: CHUNKING_VERSION.into(),
        collection_name,
        status: status.into(),
        event_count,
        created_at: Utc::now(),
        completed_at: (status == "ready").then_some(Utc::now()),
    }
}

pub fn event_map(events: &[EventRecord]) -> HashMap<String, EventRecord> {
    events
        .iter()
        .map(|event| (event.event_id.as_str().to_owned(), event.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deterministic_provider_is_stable_and_model_switchable() {
        let provider = DeterministicEmbeddingProvider::new(32);
        let first = provider.embed("policy inflation").unwrap();
        assert_eq!(first, provider.embed("policy inflation").unwrap());
        assert_eq!(provider.dimensions(), 32);
        assert!(!first.lexical_indices.is_empty());
    }

    #[test]
    fn qdrant_search_requires_payload_event_ids_for_evidence_linkage() {
        let value = serde_json::json!({
            "result": { "points": [{ "score": 0.75, "payload": { "event_id": "event-1" } }] }
        });
        assert_eq!(
            parse_search_points(&value).unwrap(),
            vec![("event-1".into(), 0.75)]
        );

        let without_payload = serde_json::json!({
            "result": { "points": [{ "score": 0.75 }] }
        });
        assert!(matches!(
            parse_search_points(&without_payload),
            Err(SemanticError::InvalidIndexResponse)
        ));
    }
}
