# 61 — Narrative Intelligence Phase 2 embedding and vector-search decision

**Status:** Approved for implementation on 2026-11-17.

## Decision

Use **BAAI/bge-m3** as the default dense embedding model identity for NIP. It is a strong fit for narrative research because it supports more than 100 languages, inputs up to 8,192 tokens, and dense, sparse, and multi-vector retrieval. NIP initially uses its 1,024-dimensional dense representation plus a separate deterministic lexical sparse companion vector. The lexical companion preserves exact-term behavior and does not claim to be BGE-M3's learned sparse output.

Qdrant is an optional derived index. DuckDB remains the canonical ledger for events, claims, provenance, rights, and derived projection manifests. If Qdrant or the embedding endpoint is unavailable, NIP continues to provide authoritative text/metadata search and reports semantic search as unavailable; it never fabricates semantic results.

The Qdrant collection uses named vectors: `dense` with cosine distance and `lexical` as a sparse vector. Hybrid retrieval uses Qdrant reciprocal-rank fusion. Payloads contain only stable event references and indexing metadata; transcript text remains in DuckDB.

## Replaceable model boundary

The engine exposes an `EmbeddingProvider` boundary. The default configured model identity is `BAAI/bge-m3`, while the runtime provider is an explicitly configured loopback OpenAI-compatible embedding endpoint (`NIP_EMBEDDING_URL`) so model execution stays outside the Rust service and can be backed by local CPU, Metal, CUDA, or another approved runtime. `NIP_EMBEDDING_MODEL` and `NIP_EMBEDDING_DIMENSIONS` are explicit configuration values.

Every index manifest records the model ID, model revision, dimensions, chunking/normalization version, event content hash, and Qdrant collection. A model change creates a new versioned collection and rebuild; it never mutates vectors in place or mixes vector spaces. Search responses include the index manifest identity.

Narrative clustering is a deterministic, versioned derived projection over indexed event vectors. It is not a market or investment score. The first implementation uses deterministic online centroid assignment with a documented cosine threshold and stable event ordering. A future HDBSCAN/UMAP projection can replace it by creating a new derivation version without rewriting raw events.

## Source notes

- Qdrant collections documentation: <https://qdrant.tech/documentation/manage-data/collections/> — named vectors can coexist in one collection; sparse vectors are first-class named vectors alongside dense vectors.
- Qdrant hybrid queries documentation: <https://qdrant.tech/documentation/search/hybrid-queries/> — dense and sparse prefetches can be fused with reciprocal-rank fusion.
- BGE-M3 model card: <https://huggingface.co/BAAI/bge-m3> — 1,024 dimensions, 8,192-token sequence length, 100+ languages, and dense/sparse/ColBERT retrieval modes.
- BGE-M3 paper: <https://arxiv.org/abs/2402.03216> — reports multilingual, multi-functionality, and long-document retrieval design.

## Quality status and future gate

The implementation and live-service benchmark validate the replaceable provider boundary, Qdrant hybrid query path, payload-to-evidence linkage, versioned manifests, and deterministic clustering. They do **not** establish production semantic quality. The current populated benchmark used an 8-dimensional deterministic embedding fixture and is therefore a ranking-regression and integration check only; it is not evidence for BGE-M3 retrieval quality.

Before enabling semantic search as a quality-backed production feature, run the same benchmark with the configured BGE-M3-compatible local provider and a reviewed finance retrieval set that includes paraphrase queries, entity aliases, time-sensitive language, numerical/metric questions, cross-company distractors, and multilingual cases where applicable. Record Recall@k, Precision@k, MRR, nDCG@k, latency, index-build cost, and failure/degradation behavior. Define an approved minimum against the lexical baseline and require a human review of false positives and false negatives. Until that gate passes, semantic search remains experimental/optional and authoritative lexical DuckDB search remains the safe fallback.
