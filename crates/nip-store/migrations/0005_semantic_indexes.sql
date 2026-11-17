CREATE TABLE IF NOT EXISTS nip_embedding_indexes (
    index_id VARCHAR PRIMARY KEY,
    model_id VARCHAR NOT NULL,
    model_revision VARCHAR NOT NULL,
    dimensions INTEGER NOT NULL,
    chunking_version VARCHAR NOT NULL,
    collection_name VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    event_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    UNIQUE (model_id, model_revision, dimensions, chunking_version, collection_name)
);

CREATE TABLE IF NOT EXISTS nip_narrative_clusters (
    cluster_id VARCHAR NOT NULL,
    derivation_run_id VARCHAR NOT NULL,
    label VARCHAR NOT NULL,
    algorithm_version VARCHAR NOT NULL,
    member_count INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (derivation_run_id, cluster_id)
);

CREATE TABLE IF NOT EXISTS nip_cluster_memberships (
    derivation_run_id VARCHAR NOT NULL,
    cluster_id VARCHAR NOT NULL,
    event_id VARCHAR NOT NULL,
    similarity_millis INTEGER NOT NULL,
    rank INTEGER NOT NULL,
    PRIMARY KEY (derivation_run_id, cluster_id, event_id),
    FOREIGN KEY (derivation_run_id, cluster_id)
        REFERENCES nip_narrative_clusters (derivation_run_id, cluster_id)
);
