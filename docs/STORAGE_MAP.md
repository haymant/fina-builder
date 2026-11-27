# Narrative storage map

This document defines where narrative data lives and what each launcher may initialize. `NIP_LAKE_DIR` is the single configured root. `NIP_DATA_DIR` is a derived path only: `$NIP_LAKE_DIR/_nip`.

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

For shell examples, set `NIP_LAKE_DIR` only when intentionally overriding the profile. `NIP_DATA_DIR` is always derived as `<lake>/_nip`; a separately supplied value is ignored and diagnosed. Relative `NIP_LAKE_DIR` values from dotenv resolve from the checkout. `TAC_LAKE_DIR` continues to own the separate TradeAC market lake; no process writes narrative files into it.

## Directory layout

```text
$NIP_LAKE_DIR/
├── _meta/
│   ├── schema.json                 # fina-scraper-v1 marker
│   └── source-init.json            # source/schedule seed status, if recorded
├── _config/
│   └── sites/*.yaml                # lake-local editable copies of scraper sites
├── _schedules/
│   ├── <site_id>.json              # current per-site schedule records
│   └── schedules.yaml              # legacy input; read without rewriting
├── _state/
│   └── state.sqlite                # dedup and run state
├── _runs/*.json                    # immutable run records
├── _backloads/                     # incremental backload manifests/state
├── _transcripts/                   # retained scraper transcript records
├── _theses/                        # append-only versioned thesis records
├── _exports/scraper-output/        # non-Parquet scraper exports
├── items/dt=YYYY-MM-DD/site=.../run=....parquet
├── entities/dt=YYYY-MM-DD/site=.../run=....parquet
├── claims/dt=YYYY-MM-DD/site=.../run=....parquet
├── edges/dt=YYYY-MM-DD/site=.../run=....parquet
├── prices/dt=YYYY-MM-DD/site=.../run=....parquet
├── backtests/dt=YYYY-MM-DD/site=.../run=....parquet
└── _nip/
    ├── nip.duckdb                 # canonical NIP event/source store
    ├── media/                     # NIP-managed media
    ├── logs/nip-engine.log
    ├── nip-engine.pid
    └── asr-staging/               # temporary NIP-owned ASR inputs
```

Existing Parquet table names, columns, point-in-time rules, and Hive partitioning remain unchanged. A missing `availability_mode` in a pre-T1-1 file continues to mean `live`.

## Safe initialization and compatibility

Initialization is idempotent and protected against concurrent launchers. A missing root or existing empty directory is initialized. A root with a valid `fina-scraper-v1` marker is reused. A markerless root is accepted only when it contains recognized fina-scraper material (for example `_runs`, `_schedules`, known table partitions, or Parquet data); its existing files are not rewritten. A foreign non-empty root fails before changes are made and reports the entries that prevented initialization.

The marker records schema name/version, creation time, and creating implementation. Recognized existing data is never reinitialized, wiped, or migrated. Source templates are copied by their parsed site `id` only when that site YAML is missing. Existing local YAML edits always win. Default schedules are added only when neither an existing per-site JSON record nor a matching legacy YAML entry exists; explicit schedule edits use per-site JSON. Legacy `schedules.yaml` remains readable and is never rewritten by initialization.

The prior app-data `NIP` root and any former `.nip-data`/`.lake/nip` roots are not read, moved, copied, or deleted. Operators may manually set `NIP_LAKE_DIR` to an existing compatible lake; an unknown non-empty directory is rejected rather than guessed.

## Ownership and boundaries

- fina-scraper owns automated discovery, deduplication, Parquet narrative tables, transcripts/ASR, schedules, and lake run state for sources defined by the lake-local YAMLs.
- nip-engine owns the canonical DuckDB events/sources, retained-event workflow, NIP media, and its service log/pidfile, all under `_nip`.
- When an NIP podcast subscription's normalized feed URL matches a scraper YAML feed, the scraper YAML is the authoritative poll/ingestion owner. Reconciliation is read-only for existing DuckDB records; matching NIP subscriptions must not trigger a second fetch or be silently deleted. Non-matching retained-event workflows keep their current behavior.
- TAC owns market bars and related market data beneath `TAC_LAKE_DIR`. Cross-lake joins remain query-time/agent work; neither subsystem writes into the other's root.

No storage-path change alters source-rights gates, point-in-time semantics, dedup contracts, live versus reconstructed availability, T-1 reconstruction rules, thesis/video tiers, or the desktop F3 timer.

## Operator checks

```bash
node scripts/fina.mjs config --json
node scripts/fina.mjs doctor --json
```

Check the reported effective `NIP_LAKE_DIR` and derived `_nip` path. Do not create a second `NIP_DATA_DIR` setting. On macOS packaged installs, the no-override target is the `NIPLake` directory inside the Tauri app-data directory; do not copy old data into it. If a custom existing root is selected, inspect/backup it yourself before starting the app. No migration is performed by fina-builder.
