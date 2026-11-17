CREATE TABLE IF NOT EXISTS nip_graph_projections (
    graph_id VARCHAR PRIMARY KEY,
    derivation_run_id VARCHAR NOT NULL,
    algorithm_version VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    graph_json JSON NOT NULL
);
