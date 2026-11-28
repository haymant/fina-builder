# Narrative storage map (transition state)

This document records the existing physical layout and the target authority model. **The current branch is not yet a single-store implementation.** `NIP_LAKE_DIR` is a shared root, not proof that fina-scraper and nip-engine use one canonical store. See [`NIP_SINGLE_AUTHORITY_ARCHITECTURE.md`](NIP_SINGLE_AUTHORITY_ARCHITECTURE.md) for the phased execution plan.

## Root selection

All launch paths use this precedence for `NIP_LAKE_DIR`:

1. An explicit non-placeholder process environment value.
2. The first matching value in the common dotenv order: working-directory `.env`, application-data `.env`, checkout `.env`, `modules/tac-engine/.env`, then `modules/riga-flow/.env`.
3. A profile default.

Profile defaults are:

| Profile | Default `NIP_LAKE_DIR` |
| --- | --- |
| Development | `<checkout>/.fina/data/nip/lake` |
| CI | `<checkout>/.fina/ci-data/nip/lake` |
| Packaged desktop, no override | Tauri `app_data_dir()/NIPLake`; on macOS typically `~/Library/Application Support/com.fina.payoffexplorer/NIPLake` |

`NIP_DATA_DIR` is always derived as `<NIP_LAKE_DIR>/_nip`; a separately supplied value is ignored and diagnosed. Relative `NIP_LAKE_DIR` values from dotenv resolve from the checkout. `TAC_LAKE_DIR` continues to own the separate TradeAC market lake; no process writes narrative files into it.

## Existing physical layout

The layout below describes what the current code may read/write during the transition. It is **not** the final ownership design.

```text
$NIP_LAKE_DIR/
├── _meta/
│   ├── schema.json                 # current fina-scraper-v1 marker
│   └── source-init.json            # source/schedule seed status, if recorded
├── _config/
│   └── sites/*.yaml                # existing scraper site configuration
├── _schedules/
│   ├── <site_id>.json              # existing per-site schedules
│   └── schedules.yaml              # legacy input; read without rewriting
├── _state/
│   └── state.sqlite                # scraper operational dedup/run state
├── _runs/*.json                    # scraper run records
├── _backloads/                     # incremental backload manifests/state
├── _transcripts/                   # retained scraper transcript/commentary records
├── _theses/                        # append-only versioned scraper thesis records
├── _exports/scraper-output/        # non-Parquet scraper exports
├── items/dt=YYYY-MM-DD/site=.../run=....parquet
├── entities/dt=YYYY-MM-DD/site=.../run=....parquet
├── claims/dt=YYYY-MM-DD/site=.../run=....parquet
├── edges/dt=YYYY-MM-DD/site=.../run=....parquet
├── prices/dt=YYYY-MM-DD/site=.../run=....parquet
├── backtests/dt=YYYY-MM-DD/site=.../run=....parquet
└── _nip/
    ├── nip.duckdb                 # NIP-owned source/event/workflow store
    ├── media/                     # NIP-managed media
    ├── logs/nip-engine.log
    ├── nip-engine.pid
    └── asr-staging/               # temporary NIP-owned ASR inputs
```

Existing Parquet table names, columns, point-in-time rules, and Hive partitioning remain unchanged during the transition. A missing `availability_mode` in a pre-T1-1 file continues to mean `live`.

## Actual writers today (transitional, not the final authority model)

- fina-scraper currently writes and reads its site YAML, schedules, run/dedup state, Parquet evidence, transcripts, theses and exports under the lake root. These are active legacy/worker paths, not yet managed solely through a NIP-owned API.
- nip-engine currently writes and reads its DuckDB source/event/claim/research/thesis/video workflow data, rights/audit state, media and runtime metadata under `_nip`.
- NIP engine invokes the existing `fina-scraper init` CLI as a subordinate process, then derives site/feed inventory internally. Tauri resolves the worker binary path and starts NIP; it no longer links fina-scraper, initializes storage, or forwards a duplicate inventory. Normal development launchers can still start fina-scraper as a separate optional MCP service for compatibility/diagnostics.
- The Narrative UI still accesses both NIP and scraper APIs. The current repository facade is partial and does not unify product ownership.
- There is no automatic Parquet-to-DuckDB copy. The common root does not make the underlying stores one canonical database.

## Target authority model (planned; not yet fully implemented)

NIP is the sole product and canonical data authority. NIP owns source identity and rights, user-visible schedule/job lifecycle, acceptance/revision policy, canonical items/events/transcripts, claims/evidence, entity resolution, feature definitions/snapshots, research/thesis/video workflows, and product-facing reads/writes. fina-scraper becomes an embedded acquisition worker: NIP supplies a source binding and job request; the worker returns a typed, versioned result; NIP validates and commits it.

The NIP-owned `AcquisitionBatch` domain contract and NIP-supervised storage-init subprocess are foundations only. The subprocess initializes the shared layout and discovers configured sources, but does not yet start a long-running worker or persist an item. The contract preserves worker provenance and exact evidence spans and validates the envelope; neither change migrates a source/schedule or changes UI routing.

A worker may retain private operational state such as retry cursors or dedup caches, provided it is subordinate to NIP lifecycle and is not a second product-visible source, schedule, or evidence catalog. Legacy Parquet/SQLite/YAML/transcript records remain readable during transition and are not automatically copied, moved, rewritten, or deleted. Future physical consolidation requires its own inventory, dry-run mapping, backup/rollback plan, parity evidence, and explicit approval.

| Domain | Current writer | Final authority | Transition rule |
| --- | --- | --- | --- |
| Source identity, rights and product status | NIP DuckDB plus scraper site configuration | NIP | Create explicit NIP-source-to-worker-profile bindings; do not infer ownership from matching text IDs. |
| Schedule intent and product-visible job state | NIP source timer in some flows; scraper schedule/launcher in others | NIP | Introduce a single NIP orchestration API before disabling existing execution paths; never run duplicate polling loops. |
| Collection and extraction | fina-scraper | NIP orchestrates; worker executes | Keep worker mechanics, but return a typed result to NIP rather than exposing a peer catalog. |
| Item/event/transcript evidence | Scraper Parquet/transcript files and NIP DuckDB records in separate paths | NIP | Preserve hash, native IDs, producer run, times, availability, tiers, exact spans and revision history. Legacy data is compatibility/read-only until authorized migration. |
| Claims/entities/features | Scraper Parquet and NIP claim/evidence workflows | NIP | Do not flatten schemas by label; NIP validates claim evidence against canonical retained payloads and owns the feature/entity catalogs. |
| Thesis/research/video/consent/audit | Primarily NIP; scraper also has some thesis/backtest artifacts | NIP | Preserve NIP workflow gates; retain worker artifacts as referenced inputs until lossless mappings exist. |
| Trading market data | TradeAC under `TAC_LAKE_DIR` | TradeAC | Keep the separate root and ownership boundary. |

## Safe initialization and compatibility

Initialization is idempotent and protected against concurrent launchers. A missing root or existing empty directory is initialized. A root with a valid `fina-scraper-v1` marker is reused. A markerless root is accepted only when it contains recognized fina-scraper material (for example `_runs`, `_schedules`, known table partitions, or Parquet data); existing files are not rewritten. A foreign non-empty root fails before changes are made and reports the entries that prevented initialization.

The marker records schema name/version, creation time, and creating implementation. Recognized existing data is never reinitialized, wiped, or migrated. Source templates are copied by parsed site `id` only when that site YAML is missing. Existing local YAML edits always win. Default schedules are added only when neither an existing per-site JSON record nor a matching legacy YAML entry exists; explicit schedule edits use per-site JSON. Legacy `schedules.yaml` remains readable and is never rewritten by initialization.

The prior app-data `NIP` root and any former `.nip-data`/`.lake/nip` roots are not read, moved, copied, or deleted. Operators may manually set `NIP_LAKE_DIR` to an existing compatible lake; an unknown non-empty directory is rejected rather than guessed.

## Operator checks

```bash
node scripts/fina.mjs config --json
node scripts/fina.mjs doctor --json
```

Check the reported effective `NIP_LAKE_DIR` and derived `_nip` path. Do not create a second `NIP_DATA_DIR` setting. On macOS packaged installs, the no-override target is the `NIPLake` directory inside the Tauri app-data directory; do not copy old data into it. If a custom existing root is selected, inspect/backup it before starting the app. No migration is performed by fina-builder as part of the current architecture phase.
