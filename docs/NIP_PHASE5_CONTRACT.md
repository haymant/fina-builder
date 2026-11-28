# NIP Phase 5 Contract and Read Surface

**Status:** Implementation and serial Rust test gates are complete in the working tree; final diff checks and commit/push remain pending. Targeted rustfmt checks pass. Full Clippy is unverified because the native DuckDB archive build exhausted sandbox disk. Schema version 23 is additive. The approved preservation choice is **preserve all existing data; do not migrate, convert, backfill, rewrite, or delete legacy records**.

NIP remains the sole authority for retained evidence and its canonical interpretation. Phase 5 writes only NIP-owned DuckDB records under `NIP_LAKE_DIR/_nip/nip.duckdb`; it does not read or modify fina-scraper's legacy claim/entity stores or TradeAC's market lake.

## Acquisition versions

`AcquisitionBatch.contract_version = 1` remains compatible with the Phase 4 item shape and accepts evidence-backed, unlinked structured claims and entity mentions. The optional contract-v2 claim fields are omitted during serialization when absent so a v1 item keeps its prior serialized representation. V1 triplets are rendered deterministically as `subject — predicate — object`; this display string is marked `triplet_rendering`, not evidence.

`contract_version = 2` requires an item derivation manifest with explicit claim/entity completeness, counts, covered-window counts, and a SHA-256 output hash over the claims and entity mentions. V2 claims require a producer paraphrase as `claim_text`, preserve optional typed semantics, and may link to entity candidates only through explicit namespaced `worker_entity_id` plus a role. Each reference must resolve to one mention in that exact item. Missing optional meaning stays missing; NIP does not infer polarity, certainty, horizon, attribution, or ticker identity from text.

All claim and mention evidence quotes are checked against the exact retained item-content or transcript payload using Unicode-scalar offsets. A bad item hash, transcript hash, quote, offset, reference, unsupported feature, or contract field rejects the entire transaction. Worker `canonical_id` and ticker values are stored only as candidate hints.

## Identity, replay, and reprocessing

The Phase 4 source binding, rights, URL, timestamp, item-content hash, and event identity gates still run before persistence. The initial item and its first accepted derivation are committed in one transaction. A source/item identity replay with a changed item payload remains a conflict.

Later extraction must use the derivation-only operation. It requires a current explicit binding, approved rights, the exact retained event body and content hash, and—when resubmitted—the exact retained transcript bytes/hash. It appends a new derivation run and immutable claim versions; it never updates the event/transcript. Replaying the same derivation run/output is a no-op; changing output under that run ID is rejected. Re-extraction requires a new run ID.

Claim review decisions (`accepted`, `rejected`, `correction_requested`), entity resolution/rejection decisions, and claim relations are append-only. Producer extraction tier/review remains provenance and is not an NIP decision. A claim with no NIP review is `pending` and is not eligible for the default descriptive feature snapshot.

## Entity resolution and traceability

Every accepted entity candidate is an evidence-backed `nip_entity_mentions` row, not a canonical entity. A reviewer may explicitly resolve it to an existing NIP entity, create a NIP entity and resolve it, or reject it, with reviewer and reason. A worker ID, ticker, or candidate canonical ID never promotes itself. Role-bearing claim-to-mention links preserve the explicit worker reference; resolution history preserves the link from mention to the canonical entity. No string-matching or automatic ticker resolution is performed.

## Descriptive feature registry

The migration seeds these numeric definition/version records:

| Key | Unit | Formula |
| --- | --- | --- |
| `nip.claim_observation_count` | observations | Count distinct `(source_id, event_id, normalized subject-predicate-object)` facts eligible for the resolved entity. |
| `nip.distinct_source_count` | sources | Count distinct NIP source IDs among those eligible observations. This is not a claim of independent corroboration. |
| `nip.positive_claim_count` | claims | Count distinct source/event/fact observations with an explicitly supplied positive polarity. |
| `nip.neutral_claim_count` | claims | Same, for explicit neutral polarity. |
| `nip.negative_claim_count` | claims | Same, for explicit negative polarity. |

Eligibility is point-in-time: the claim derivation and latest NIP acceptance decision must be known by `as_of`; a role-bearing mention must have a latest resolution decision to the requested entity known by that same cutoff; and the claim-validity interval must intersect the requested half-open window `[window_start, window_end)`. Unspecified polarity is not inferred. Same-source/event repeats of the same normalized fact do not increase the observation or polarity counts; cross-source observations stay distinct.

A snapshot records the requested window and `as_of`, the exact sorted input hash, definition-set hash, counts, run ID, and numeric values. Identical input and definition sets yield the same run identity. Values with fewer observations than their registered minimum are `insufficient` with `null` numeric value, never zero-filled; reconstructed evidence is flagged. These corpus descriptions are not validated predictive signals or investment advice.

Worker-provided feature values remain rejected. Feature matrix export and TradeAC/qlib integration are outside Phase 5.

## MCP operations

The NIP MCP surface adds: `derive_acquisition_item`, `list_nip_claim_annotations`, `review_nip_claim`, `list_nip_claim_review_history`, `add_nip_claim_relation`, `list_nip_claim_relations`, `list_nip_claim_entity_links`, `list_nip_entity_mentions`, `list_nip_entities`, `review_nip_entity_mention`, `list_nip_entity_resolution_history`, `compute_nip_feature_snapshot`, and `list_nip_feature_snapshots`. Write requests do not accept caller-supplied `known_at` or creation timestamps; NIP assigns trust timestamps within persistence. `as_of` is a caller-selected read cutoff, not a write timestamp. Existing raw legacy claim reads remain available and are not silently reinterpreted as typed Phase 5 annotations.

The initial entity-review surface supports explicit `resolve` and `reject` decisions, including reviewer-created entities and linking to an existing NIP entity. Alias authoring/automatic alias matching, merge/split workflows, reviewed instrument mappings, and TradeAC/qlib export remain outside this release; producer ticker/canonical-ID values stay hints only.
