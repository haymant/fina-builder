# Phase 3 Artifact Readiness

**Review date:** 2026-11-28  
**Scope:** `lake/`, `modules/tac-qlib/tac-rd-output/`, and `workflows/`  
**Disposition:** Reviewed in place. No files were moved, rewritten, deleted, or staged.

## Ownership boundary

These directories are local R&D/TAC execution artifacts and must remain separate from NIP's canonical narrative authority:

| Path | Current role | Phase 3 disposition |
| --- | --- | --- |
| `lake/` | Local TAC market-data lake, calendar/coverage metadata, logs, and SQLite MLflow tracking store | Keep outside NIP ownership and outside canonical narrative writes. Treat as a local/generated artifact root. |
| `modules/tac-qlib/tac-rd-output/` | Generated Qlib/R&D pickle outputs (`label.pkl`, `params.pkl`, `pred.pkl`) | Keep as generated outputs. Do not use as an authoritative experiment registry or copy into NIP storage. |
| `workflows/` | Declarative R&D workflow input; currently `rd_baseline_etf.yaml` | Candidate versioned workflow source. Promote only after adding explicit revision/lineage handling. |

The NIP Phase 3 work concerns source identity and schedule intent for narrative acquisition. It must not turn the TAC lake, Qlib outputs, or R&D workflow artifacts into NIP-owned narrative records.

## Observed inventory

### `lake/`

- `manifest.yaml` declares `lake_version: 1`, US market, IEX feed, raw adjustment, and UTC timezone.
- Twenty ETF partition files are present under `market=US/timeframe=1d/`, covering the configured baseline universe: SPY, QQQ, IWM, DIA, EFA, EEM, TLT, IEF, LQD, HYG, GLD, SLV, USO, VNQ, XLF, XLK, XLE, XLV, XLI, and XLY.
- `calendar.parquet`, `coverage.parquet`, and `symbols.parquet` are present.
- `mlruns.db` contains five experiments and five runs. One run is still recorded as `RUNNING`; this must be reconciled by the R&D/MLflow owner before it is treated as a completed lineage node.
- `logs/rd-workflow-tac-rd-experiment-20261123-045523.log` records a historical Qlib workflow, including a warning that `DATABASE_URL` was not set and that the local SQLite store was used. The log is evidence of an execution attempt, not a canonical run ledger.

### `modules/tac-qlib/tac-rd-output/`

The directory contains three pickle artifacts:

- `label.pkl`
- `params.pkl`
- `pred.pkl`

They have no adjacent manifest identifying the producing workflow revision, source lake snapshot, model configuration, run ID, schema version, or serialization compatibility. They should therefore be treated as opaque generated artifacts until a typed artifact manifest is added.

### `workflows/`

`rd_baseline_etf.yaml` defines a 20-ETF Qlib baseline with:

- `TAC_LAKE_DIR` as the provider root;
- a 2022-01-03 through 2026-11-20 dataset window;
- train, validation, and test segments;
- a LightGBM model;
- technical and cross-market features;
- a TopkDropout strategy and SPY benchmark;
- an SQLite MLflow URI of `sqlite:///mlruns.db`.

The workflow is useful as a reproducible input, but its MLflow artifact location is relative and its generated outputs are not yet linked to a workflow digest or repository revision.

## Phase 3 readiness gaps

1. **Workflow identity:** Add a stable workflow ID, schema version, revision/digest, and repository commit to every dispatched run.
2. **Artifact lineage:** Add a sidecar manifest for generated outputs containing artifact names, producer version, workflow digest, lake manifest digest, run ID, model/config identifiers, and serialization/schema versions.
3. **Lake snapshot identity:** Extend the lake manifest with a generated-at timestamp, source/provider metadata, coverage bounds, symbol list or symbol-list digest, and a content digest strategy. Do not rewrite existing market data merely to add metadata.
4. **MLflow URI discipline:** Resolve the tracking database and artifact root from the explicit R&D runtime configuration instead of relying on the current working directory. Existing absolute artifact paths must remain readable.
5. **Run reconciliation:** Investigate the `RUNNING` local run before any archival or promotion decision. Do not infer success from the presence of pickle files or log output.
6. **Separation from NIP:** Keep all TAC/R&D artifact reads behind TAC/R&D contracts. Do not expose these files as NIP narrative source, evidence, or canonical ingestion operations.
7. **Generated-data policy:** Keep raw lake data, SQLite tracking state, logs, and pickle outputs out of ordinary source commits. Version workflow definitions and small manifests; use an explicit artifact store or experiment repository for larger outputs.

## Safe next actions

The next implementation slice should add typed, non-destructive metadata contracts and validation at workflow dispatch boundaries:

1. validate `rd_baseline_etf.yaml` before dispatch;
2. compute and record the workflow file digest and current code revision;
3. resolve and record the lake manifest/dataset identity without copying the lake;
4. require a run-scoped output directory and write an artifact manifest beside generated outputs;
5. reconcile run status through the R&D service rather than reading raw SQLite rows from the product UI;
6. keep the resulting R&D lineage separate from NIP Phase 3 source/schedule ownership.

Until those actions are implemented, the reviewed directories are **reviewed and preserved, but not promotion-ready**. No experiment result, metric, or workflow completion claim is made by this document.
