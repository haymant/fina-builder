# Fina Builder — Structured Product Payoff Explorer

An analytical workbench for inspecting structured-product payoffs and assembling
role-oriented dashboards. The UI is React/TypeScript; **all pricing and market data come
from the live engines** — `riga-flow` (`riga-mcp`) for products and `tac-engine` for market
data — vendored under `modules/`. The desktop shell (`src-tauri`) is a thin adapter that
drives them.

> **Scope:** a demonstrator, not a production pricing or risk system. Read
> [FEATURES.md](./FEATURES.md) for the feature inventory, the architecture, and the
> documented divergences. FEATURES.md Part I also records the pre-merge demo stack
> (`fina-kernel` + its transports), which was retired in `docs/49-merge-fina-to-riga.md`.

## Documentation

| Document | What it covers |
| --- | --- |
| **[FEATURES.md](./FEATURES.md)** | What is implemented: the engine surfaces, tiles, the chat panel and known gaps, followed by the migration specification and its completion record. |
| **[FINA.md](./FINA.md)** | The single control-plane configuration and launcher for local development, CI, future experiments, and releases. |
| **[AGENT-LOCAL.md](./AGENT-LOCAL.md)** | The RIGA assistant chat panel (desktop shell ↔ `riga-server`). |
| **[docs/51-portfolio-risk-architecture.md](./docs/51-portfolio-risk-architecture.md)** | Proposed canonical portfolio/position/instrument/market/sensitivity/P&L/scenario/risk-matrix documents, the complete SQLite/PostgreSQL relational schema (ER diagram + table definitions) and the extension architecture (PROPOSAL — not implemented). |
| **[docs/54-trade-fixing-workflows.md](./docs/54-trade-fixing-workflows.md)** | Individual and bulk Phoenix fixing capture, the due-observation queue, operational best practices and remaining correction/automation gaps. |
| **[docs/55-narrative-intelligence-aligned-brd.md](./docs/55-narrative-intelligence-aligned-brd.md)** | Narrative Intelligence requirements, including NIP-owned source/retention lifecycle and optional local ComfyUI inference behind a provider boundary. |
| **[docs/56-narrative-intelligence-implementation-plan.md](./docs/56-narrative-intelligence-implementation-plan.md)** | Phased NIP architecture and implementation sequence; consented RSS discovery backend is implemented, but UI, host scheduling, audio download/transcription and the ComfyUI adapter remain pending. |
| **[docs/57-narrative-intelligence-testing-plan.md](./docs/57-narrative-intelligence-testing-plan.md)** | User-journey, regression, storage/quality-gate and narrated Playwright plan; browser tests use fake ASR, with ComfyUI runtime smoke explicitly separate and opt-in. |
| **[docs/58-narrative-intelligence-phase-0-decisions.md](./docs/58-narrative-intelligence-phase-0-decisions.md)** | Closed local-first Phase 0 baseline for approved podcast RSS, local transcription and RIGA-configured analysis, with the narrow ASR-host amendment in ADR 59; no feed, worker, model, UI or live source is configured. |
| **[docs/59-comfyui-media-processing-architecture.md](./docs/59-comfyui-media-processing-architecture.md)** | Accepted boundary decision: optional local ComfyUI ASR/media execution, NIP-owned source lifecycle and purge, loopback-only integration gates, and the companion workflow's unverified runtime status. |
| **[docs/60-narrative-intelligence-comfyui-handoff.md](./docs/60-narrative-intelligence-comfyui-handoff.md)** | Copy-ready handoff prompt for the next agent to implement and validate the optional local ASR adapter without crossing the NIP/ComfyUI ownership boundary. |
| **[docs/63-nip-desktop-user-journey.md](./docs/63-nip-desktop-user-journey.md)** | User journey from the desktop app through first-run setup, approved feed configuration, local transcription, extraction consent, claim/evidence review, and the narrated Playwright demonstration. |
| [README.md](./README.md) (this file) | How to run it and how to release it. |

### Single control plane

The repository is moving toward one maintained control plane instead of requiring
developers to remember separate Cargo, npm, uv, MCP, and Git commands. The initial
version is [`fina.toml`](./fina.toml), driven by [`scripts/fina.mjs`](./scripts/fina.mjs):

```bash
node scripts/fina.mjs doctor
node scripts/fina.mjs config --json
node scripts/fina.mjs --profile ci config --json
node scripts/fina.mjs dev
node scripts/fina.mjs build
node scripts/fina.mjs test
```

Read [FINA.md](./FINA.md) for the control-plane requirements, configuration contract,
current scope, profile/path contract, and the planned experiment/release extensions.
`npm run test:control-plane` runs the focused launcher contract tests. Existing `npm run ...`
commands remain supported; the launcher delegates to them rather than duplicating their
implementation.

## Requirements

- Node.js **22.19.0 or newer** and npm (`package-lock.json` is committed).
- Rust/Cargo. The version is pinned in `rust-toolchain.toml` (currently **1.99.0**);
  `rustup` installs it automatically, so `cargo build` just works.
- **The engines.** `riga-flow` and `tac-engine` live under `modules/` as standalone
  workspaces (they are *excluded* from the root workspace). The `dev:http` launcher
  builds their HTTP binaries automatically; Rust/Cargo must be installed first:

  ```bash
  CARGO_TARGET_DIR="$PWD/modules/target" cargo build --release --manifest-path modules/riga-flow/Cargo.toml   # → modules/target/release/riga-mcp
  CARGO_TARGET_DIR="$PWD/modules/target" cargo build --release --manifest-path modules/tac-engine/Cargo.toml  # → modules/target/release/tac-engine
  ```

  `npm run mcp:sidecar:engines` stages them into `src-tauri/binaries/` for packaged builds.
- Desktop builds additionally need the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/).
  On Debian/Ubuntu one command does it — the same script CI uses:

  ```bash
  ./scripts/ci/install-tauri-linux-deps.sh
  ```

  It installs WebKitGTK, GTK, the Ayatana status-icon library, librsvg, libxdo, libssl,
  patchelf, CMake, Ninja and libclang, then verifies `pkg-config` can see the Tauri
  libraries. It is a no-op on non-Debian systems. The browser mode does not need them.

### Manus sandbox: one-shot setup

For a fresh Manus Ubuntu sandbox, run the following from the repository root. It installs the
native build prerequisites, installs the pinned Rust toolchain from `rust-toolchain.toml`,
installs JavaScript dependencies, installs the optional Tauri desktop libraries, and prepares
the shared `modules/.venv` qlib environment. The command does not require Alpaca, database, MLflow, or
other production credentials.

```bash
sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  cargo rustc pkg-config build-essential cmake ninja-build clang libssl-dev curl
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
export PATH="$HOME/.cargo/bin:$PATH"
rustup toolchain install 1.99.0 --profile minimal
git submodule update --init --recursive
npm ci
./scripts/ci/install-tauri-linux-deps.sh       # optional for browser-only work
npm run runtime:prepare                        # builds Rust sidecars and syncs shared TAC Python env
cargo --version && rustc --version && npm --version
```

The Ubuntu `cargo`/`rustc` packages are installed before `rustup` because Ubuntu packages
`rustup` as a conflicting alternative. The installer then places the upstream toolchain manager
in `~/.cargo/bin`; the repository pin selects Rust 1.99.0 automatically in this checkout. If
`uv` is not already available in the sandbox, install it using the official installer and reopen
the shell before running the qlib command:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
```

After setup, the normal validation entry points are `npm run test:run`,
`cargo test --workspace`, and `npm run build`. Engine-specific tests and builds are documented
below and do not migrate or contact production data.

## Run it

### 1. Web mode (browser + HTTP engines) — local service stack

Alpaca credentials are optional. Without them, `tac-engine` serves Yahoo Finance daily stock
history and free Yahoo/ECB daily FX rates; account/order tools and Alpaca-only data (such as
intraday bars, quotes, options, and streams) are unavailable. Set both `APCA_API_KEY_ID` and
`APCA_API_SECRET_KEY` in the shell, the checkout `.env`, or `modules/tac-engine/.env` to enable
those features (template: `modules/tac-engine/.env.example`). Like desktop mode, `dev:http`
loads the checkout `.env` and the two module `.env` files without overriding shell variables, so
browser and Tauri sessions see the same credentials. If `TAC_LAKE_DIR` is unset, `dev:http` uses
the absolute workspace path `.lake/`. When launched through `node scripts/fina.mjs dev_http`,
the control plane supplies the profile lake root (`FINA_DATA_ROOT/lake`) unless the checkout
`.env` sets `TAC_LAKE_DIR`; an explicit shell export always wins. The lake can be empty and will
be populated on demand with supported daily history. The launcher never supplies placeholder
credentials or synthetic market data.

```bash
npm ci
npm run dev:http          # builds both Rust backends, then starts the HTTP stack and Vite (CPU default)
# Optional: enable CUDA for riga-mcp; requires CUDA Toolkit 13+ and a visible NVIDIA GPU.
npm run dev:http -- --cuda
# Optional: bind Vite to 0.0.0.0 for a forwarded/public preview; backend ports remain local.
npm run dev:http -- --public
```

`npm run dev:all` remains available when both backend binaries have already been built. The
`dev:http` command builds `riga-mcp` and `tac-engine` before launching the local services,
checks that ports 5173/8788/8790/8792/8795/8796/8797 are free, and stops the other processes if a
required service exits. CPU is the default. The first build may take several minutes because
`tac-engine` bundles DuckDB; subsequent runs reuse the compiled artifacts. `--cuda` adds the
`riga-mcp` `gpu` Cargo feature (CUDA 13+); `tac-engine` remains CPU-only. The CUDA option is
explicit and fails early when the toolkit or NVIDIA GPU is not available; omit it on Manus. This
is separate from `tauri:dev:cuda`, which enables CUDA for RIGA's local GGUF inference in the
desktop shell.

| | |
| --- | --- |
| Frontend | Vite on <http://127.0.0.1:5173> |
| `riga-mcp` | MCP over HTTP on <http://127.0.0.1:8788> |
| `tac-engine` | MCP over HTTP on <http://127.0.0.1:8790> |
| Trade repository | MCP over HTTP on <http://127.0.0.1:8792> |
| `tac-qlib-book` | MCP over HTTP on <http://127.0.0.1:8795> |
| `tac-qlib-rd` | MCP over HTTP on <http://127.0.0.1:8796> |
| RiskCube | MCP over HTTP on <http://127.0.0.1:8797> |

The webview calls the same-origin paths `/riga/mcp`, `/tac/mcp`, `/trade-repo/mcp`,
`/book/mcp`, `/rd/mcp`, and `/riskcube/mcp`, which Vite proxies to the loopback services (see
`vite.config.ts`). The book, R&D, and RiskCube bridges are optional: `dev:http` keeps the core
stack running and reports them as unavailable when `uv`, the qlib environment, or
`RISK_CUBE_MCP_BIN` is missing. To run the pieces separately:

```bash
npm run backend:dev      # npm run mcp:http:riga   (riga-mcp --transport http)
npm run mcp:http:tac     # the tac-engine HTTP bridge
npm run mcp:http:trade-repo # seeded local trade repository MCP server
npm run mcp:http:book      # qlib round-book MCP bridge
npm run mcp:http:rd        # qlib/MLflow R&D MCP bridge
npm run mcp:http:riskcube  # RiskCube bridge (requires RISK_CUBE_MCP_BIN)
npm run dev:web          # frontend-only Vite process
```

`npm run dev` starts Vite plus the local trade-repository MCP server. Use `npm run dev:web`
when you intentionally need only the frontend (for example, Playwright starts its own isolated
trade-repository instance). To start the pricing/market-data engines as well, use
`npm run dev:http` or `npm run dev:all`.

Configuration: `VITE_RIGA_UPSTREAM` / `VITE_TAC_UPSTREAM` override the proxy targets, and
`VITE_RIGA_TRANSPORT=tauri|http` / `VITE_TAC_TRANSPORT=tauri|http` force a transport
(otherwise Tauri is auto-detected via `__TAURI_INTERNALS__`).

### 2. Desktop mode (Tauri IPC + stdio engines)

```bash
git submodule update --init --recursive
npm run tauri:dev      # window with IPC; starts trade-repo MCP + Vite and spawns engines over stdio
npm run tauri:build    # native bundles for the current platform
```

`git pull` updates the parent repository but does not populate or update gitlink submodules.
The Trading 2ⁿd MCP sidecar is built from the checked-out `modules/tac-engine` submodule and
the RIGA sidecar from `modules/riga-flow`; they are compiled locally rather than committed as
binaries. `npm run tauri:dev` builds them before starting the desktop app and synchronizes the
shared TAC Python environment at `modules/.venv`. If either submodule
is missing, startup now stops with an instruction to run the recursive submodule command
instead of allowing a later opaque “MCP connection closed” error.

After pulling source changes, restart a running desktop/dev process so its MCP services reload
the checkout. No separate frontend build or Python package reinstall is needed for development:
`tauri:dev` serves the frontend through Vite and the R&D/book launcher runs `uv sync --locked`
before importing the checked-out Python source. For an installed desktop bundle, a source `git
pull` does not replace the installed app; create and install an updated bundle with
`npm run tauri:build` (its Tauri hook runs the frontend build and runtime preparation for you).

The shell resolves `riga-mcp` / `tac-engine` from `RIGA_MCP_BIN` / `TAC_ENGINE_BIN`, then the
shared target path (`modules/target/{release,debug}`), then legacy submodule paths, and finally a
bundled sidecar. It
forwards `.env` files (repo root, app-data, `modules/tac-engine/.env`, `modules/riga-flow/.env`)
to the engine children, so `TAC_LAKE_DIR`, `APCA_*` and `FRED_API_KEY` work without exporting
shell variables. Keys live in the host environment or a user-owned `.env` only — never in the
UI, logs or persisted state.

The TAC desktop sidecar still uses the same stdio transport and full Alpaca tool set when both
API keys are configured. If both are omitted, it starts in the same Yahoo daily-stock/FX fallback
mode as web mode; account/order tools are omitted, and Alpaca-only market data remains unavailable.
When `TAC_LAKE_DIR` is not set, desktop mode passes the disposable workspace default
`<checkout>/.lake` to TAC and R&D, matching web mode. R&D is launched by the tracked
`scripts/tac-qlib-rd-mcp` wrapper, which runs `uv sync --project modules/tac-qlib --locked`
and starts `modules/tac-qlib/tac_qlib/rd_server.py` using `modules/.venv`; install `uv` before opening the desktop app.

### Sidecar catalog and setup

Sidecars are the default integration boundary for engines and data-owning services in fina-builder:
the renderer calls a typed MCP transport, while the host owns executable resolution, environment
construction, process lifetime, stdio/HTTP transport, cancellation and error mapping. A sidecar
must never be selected by an arbitrary renderer path, and secrets must remain in the host environment
or an app-data `.env` file.

| Sidecar/service | Ownership and role | Development command | Default endpoint/transport |
| --- | --- | --- | --- |
| `riga-mcp` | `modules/riga-flow`; structured-product pricing, risk and payoff tools | `npm run mcp:sidecar:riga` | stdio in Tauri; HTTP `127.0.0.1:8788` |
| `tac-engine` | `modules/tac-engine`; market data, lake, account and order tools | `npm run mcp:sidecar:tac` | stdio in Tauri; HTTP `127.0.0.1:8790` |
| Trade repository MCP | `scripts/lib/trade-repo`; fina-owned operational trade persistence | `npm run mcp:http:trade-repo` | HTTP `127.0.0.1:8792` |
| `nip-engine` | NIP narrative ingestion, evidence and media lifecycle | `npm run mcp:sidecar:nip` | Tauri/HTTP `127.0.0.1:8794` |
| `tac-qlib-rd` | `modules/tac-qlib`; TradeAC-derived research, experiment, model and result tools, including bounded YAML validation and dispatch | `uv sync --project modules/tac-qlib --locked`; `npm run mcp:http:rd` (browser) or `npm run mcp:stdio:rd` (desktop) | HTTP `127.0.0.1:8796/mcp`; Tauri-owned stdio |
| `tac-rd-book` (new) | `modules/tac-qlib`; TradeAC-derived round book, facts, intents, decisions and reconciliation | `uv sync --project modules/tac-qlib --locked`; `npm run mcp:stdio:book` | stdio; shared `modules/.venv` |
| Fina Phase 3A book adapter | fina-owned read-only DTO/transport boundary over the qlib book service | `npm run mcp:http:book` (browser) or `scripts/tac-qlib-book-mcp` (desktop) | HTTP `127.0.0.1:8795/mcp`; Tauri-owned stdio |
| RiskCube OLAP (planned) | A canonical `fina-pricer`/OLAP capability, not ordinary TAC market data | set host-only `RISK_CUBE_MCP_BIN` and run `npm run mcp:http:riskcube` | HTTP `127.0.0.1:8797/mcp`; Tauri-owned named sidecar |

Build and stage the compiled Rust sidecars for a packaged Tauri build with:

```bash
npm run runtime:prepare           # Rust sidecars plus shared TAC Python environment
npm run mcp:stdio:rd              # stdio service; Ctrl-C stops the child
npm run mcp:stdio:book             # stdio service; Ctrl-C stops the child
```

The TAC qlib RD and book services use the shared ignored environment `modules/.venv`; `uv.lock` is
committed so a clean checkout resolves the same Python dependencies. Set `TAC_QLIB_PYTHON_BIN` to
override the interpreter, while the old `modules/tac-qlib/.venv` remains a compatibility fallback.
The RD and book services are separate named
processes even though they share package source. They own qlib/MLflow and round-book calculations;
React must consume their DTOs rather than reimplementing metrics or reconciliation. The default
fina-builder test suite must use temporary fixtures and does not require Alpaca credentials,
PostgreSQL, MLflow, remote embeddings or a populated production lake. See
[modules/tac-qlib/README.tradeac.md](./modules/tac-qlib/README.tradeac.md) for the source package
reference and [docs/75-tradeac-migration.md](./docs/75-tradeac-migration.md) for migration scope.

The read-only RiskCube workspace uses a semantic, bounded request (`scope`, allowlisted
dimensions/measures, aggregation, filters, and limit) rather than renderer-supplied SQL. It
accepts only `riskcube_capabilities`, `risk_cube_partitions`, and `olap_query`; the browser and
Tauri host boundaries reject arbitrary tools, paths, URIs, SQL, tracking-store arguments, and
mutations. No canonical OLAP/pricer sidecar is selected or bundled yet. Without
`RISK_CUBE_MCP_BIN`, the bridge returns an explicit unavailable/setup response and the UI does
not display fabricated cube data. The named browser bridge listens on `127.0.0.1:8797` by
default (`RISKCUBE_MCP_HTTP_PORT` may change the local port), and Vite proxies `/riskcube` to it.
Run the deterministic fixture journey with `npm run test:e2e:journey:riskcube`.
There is intentionally no `modules/riskcube` Cargo submodule in this repository; desktop mode
does not attempt to build one and reports setup as unavailable until an approved host-side
`RISK_CUBE_MCP_BIN` is configured.

The R&D workspace is fixture-tested with an experiment → run → result → dataset journey. **R&D → Dataset** calls the named `rd_exp_dataset` operation; the service resolves the persisted run config, instrument universe, feature fields, split dates, and optional `PortAnaRecord` backtest window, then returns bounded pages sorted by date/time. `page` is 1-based, `page_size` is limited to 200, and only `train`, `valid`, `test`, or `backtest` plus an allowlisted instrument may be requested. Train/valid/test rows include `label`; backtest rows include `deal_price`. qlib, the lake, and MLflow remain sidecar-owned; the renderer never receives paths, URIs, SQL, or tracking-store arguments. Runs without a recoverable config, segment, backtest, or configured lake show an explicit unavailable/error state rather than fabricated rows. The Experiments card's **+ YAML** action opens a Qlib workflow editor; validation checks the bounded schema and preflights the persisted lake before the user reviews the summary and confirms the exact experiment/config fingerprint. Submitted YAML runs through the existing isolated R&D worker, not a renderer-side process. The R&D Notebook button has its own notes and a copyable prompt plus starter YAML for external agents, so authoring does not depend on RIGA availability.

```bash
npm run test:run -- src/api/__tests__/rdApi.test.ts
npm run test:run -- src/features/rd/components/WorkflowYamlDialog.test.tsx src/features/workspace/components/NotebookDrawer.test.tsx
npm run test:e2e:journey:rd
npm run test:run -- src/api/__tests__/riskcubeApi.test.ts src/api/__tests__/mcpAllowlist.test.ts
npm run test:e2e:journey:riskcube
```

The browser journey intercepts only `/rd/mcp` with synthetic JSON-RPC responses. It does not
require a lake, MLflow, credentials, or production artifacts. The YAML write path accepts only
the service's constrained declarative Qlib subset, caps payload size, rejects renderer-supplied
paths/providers/tracking URIs, and requires server validation plus an immediate dispatch
confirmation. It does not expose arbitrary filesystem or artifact writes.

#### Phase 3A metadata and book boundary

Phase 3A adds a fina-owned metadata repository for model-registry entries, validated scheduler
configuration, and manual execution-attempt metadata. SQLite is the default local adapter; the
PostgreSQL adapter is optional and selected by the host-side repository configuration. Set
`DATABASE_URL` only in the host environment or an app-data `.env` when a shared PostgreSQL
deployment is explicitly configured. Never put it in renderer configuration, Vite variables,
DTOs, logs, or committed files. The repository stores opaque qlib/MLflow references and does
not copy model files, runs, artifacts, or TradeAC records.

The fina book API is read-only and allowlists `round_list`, `round_get`, `trail_query`,
`trail_funnel`, and `round_metrics`. It does not expose round writes, order placement, fill
synchronization, cancellation, or broker mutations. For browser development, prepare the
shared qlib environment and start the bridge:

```bash
UV_PROJECT_ENVIRONMENT=modules/.venv uv sync --project modules/tac-qlib --locked
npm run mcp:http:book                 # http://127.0.0.1:8795/mcp
```

Vite proxies `/book` to that loopback endpoint. `BOOK_MCP_HTTP_PORT` may change the bridge
port; do not expose the bridge publicly. In Tauri desktop mode, the shell resolves and starts
the checked-in `scripts/tac-qlib-book-mcp` launcher over stdio, forwarding only the host-side
runtime configuration required by the qlib service. Missing `uv`, qlib dependencies, database
configuration, or the book service is reported as an explicit unavailable state rather than an
empty successful result. Authentication and renderer-supplied roles are intentionally deferred
for Phase 3 in both modes.

### Narrative Intelligence (NIP) in the desktop app

NIP ships as the `nip-engine` sidecar. In a development checkout, build/stage it once with
`npm run mcp:sidecar:nip`; `npm run tauri:dev` then starts one shared `nip-engine --transport
http` process and injects NIP-owned app-data paths plus a loopback RIGA provider bridge. The
Narrative tab and the RIGA chat both call that one process (RIGA over HTTP MCP; the Narrative
tab through the Tauri `nip_mcp_*` commands), so they share one DuckDB writer. Open
**Narrative → Narrative Intelligence** to see the first-run checklist. The full analyst
journey — approved feed, RSS discovery, local transcription, remote-consent gate,
evidence-linked claims, Radar/Timeline, graph, and the ETF/editorial boundaries — is
documented in [docs/63-nip-desktop-user-journey.md](./docs/63-nip-desktop-user-journey.md).

```bash
npm run test:e2e:journey:narrative-setup   # fast UI setup/rights/consent checks
PLAYWRIGHT_NIP=on npm run test:e2e:journey:narrative
PLAYWRIGHT_NIP=on npm run test:e2e:demo -- --grep @demo-narrative-research
```

Local transcription is performed by the independent `comfy` workflow pack, not by this
repository. NIP resolves the pack from `NIP_COMFY_DIR` (default `modules/comfy`), or clones
`NIP_COMFY_REPO` into that directory with the **Clone comfy pack** action, and invokes
`scripts/render.py asr-long`. Configure:

```bash
NIP_COMFYUI_URL=http://127.0.0.1:8190        # optional; overrides loopback auto-discovery
NIP_COMFY_DIR=/path/to/comfyui-flows         # optional; defaults to modules/comfy
NIP_COMFY_REPO=https://github.com/haymant/comfyui-flows.git  # optional auto-clone source
NIP_ASR_CHUNK_SECONDS=45                     # optional; Qwen3-ASR caps output at 256 tokens
```

The endpoint is discovered at call time, so no port needs to be pinned per machine:
an explicit `NIP_COMFYUI_URL` wins, then the pack's `COMFYUI_SERVER`, then the port
recorded by the running ComfyUI Desktop instance (`comfy-procs/*.json`), then the
documented default `8188`. Discovery is validated as a loopback URL, so it can never
point ASR at another host.

`nip_asr_status` names every missing prerequisite. A transcription run is a job: the
Narrative workspace shows its download/transcribe/commit stage, cached audio, warnings,
transcript preview, and the exact step that failed. Cached audio/video can be replayed from
the **Cached media** tile card and deleted explicitly.

The live tests use a disposable DuckDB store, a loopback RSS/audio fixture, and a deterministic
loopback provider bridge. They do not contact a public feed, remote ASR, or public model endpoint.

#### Optional NVIDIA CUDA backend

The default desktop build is portable and uses the CPU/OpenMP llama.cpp backend inside
`riga-server`. CUDA is an **opt-in compile-time backend**, not a runtime switch:

```bash
npm run tauri:dev:cuda      # development window with CUDA enabled
npm run tauri:build:cuda    # CUDA-enabled native bundle
```

The CUDA npm wrappers target compute capability **8.6** by default. For another NVIDIA GPU,
override it: `CMAKE_CUDA_ARCHITECTURES=89 npm run tauri:build:cuda` (numeric value, no `sm_`
prefix). The wrapper pins `CUDACXX`, `CMAKE_CUDA_COMPILER`, `CUDA_PATH` and `PATH` to one
detected toolkit when they are not already set. The CPU commands remain the safe fallback:
`npm run tauri:dev:cpu` / `npm run tauri:build:cpu`.

The CUDA profile is the `src-tauri` Cargo feature `cuda`, which enables `riga-server/cuda`
(and `metal` for Apple GPUs). If CUDA compilation or driver init is unavailable, use the CPU
commands rather than silently falling back inside a CUDA build.

### Chat panel (Tauri desktop only)

The **Chat** button opens RIGA's `@rigai/assistant-ui` side panel. Inference runs locally via
the `riga-server` engine; the shell owns the process and the MCP engine connections (the
webview never spawns a process). See [AGENT-LOCAL.md](./AGENT-LOCAL.md) for the wiring.

### Price an instrument from its trading-system JSON

```bash
npm run price:instrument -- 1.json   # market auto|file|lake, lanes flat|surface, --json
```

`price:instrument` reads an instrument JSON (e.g. an `ELIFCN_KI` KIKO note) and prices the
down-and-in put leg. Market data comes from the instrument's own `marketData` block when
present (Murex equity spots + dividends, correlation, the `eqVol` surface, and the discount
curve — `evaluationDate` anchors the tenors), otherwise it falls back to `tac-engine`
(`--market file|lake|auto`). It builds the `riga-flow` `PriceRequest` — including the Dupire
`local_vol.grids[]` from the surface — and reports both the flat-ATM and the surface-calibrated
lanes. It resolves the engines through `RIGA_MCP_BIN` / `TAC_ENGINE_BIN`, then
`modules/target/{release,debug}`, with legacy module-local target paths as fallbacks. To reconcile against another pricer, `--no-call` drops
the autocall gate, `--strike X` overrides the put strike, and `--vol a,b` overrides the flat
vols (and disables the surface grid).

### Terminal analytics (`riga-cli`)

The same engine tools the tiles use are available from the terminal via
`riga-cli` (`modules/riga/crates/riga-cli`), which drives the MCP servers registered
in `.mcp.json` and renders results as markdown tables. Run it **from the repo root**
(it reads `.mcp.json` and `skills/` from the working directory):

```bash
cargo build --release --manifest-path modules/riga-flow/Cargo.toml
cargo build --release --manifest-path modules/tac-engine/Cargo.toml
cargo build -p riga-cli --manifest-path modules/riga/Cargo.toml

./modules/riga/target/debug/riga-cli --tools   # engines reachable? (42 + 75 tools)
./modules/riga/target/debug/riga-cli --tui     # terminal UI (agent chat)

# model-free: one tool per call, markdown tables out
./modules/riga/target/debug/riga-cli --call riga-flow/price_put
./modules/riga/target/debug/riga-cli --call riga-flow/price_trade --set trade.strike=0.60
```

The `skills/` in this repo guide the agent, and `skills/riga-flow-cli/SKILL.md` holds
the command reference plus sample prompts. Design/plan: `docs/50-cli.md`.

### Other scripts

```bash
npm run build          # type-check + production frontend bundle
npm run lint           # oxlint
npm run test:run       # Vitest frontend unit/integration suite
npm run test:e2e       # Playwright browser E2E (starts an isolated Vite server)
npm run test:e2e:smoke # tagged high-value smoke subset
npm run test:e2e:journey:trade-fixings # individual and bulk fixing operations
npm run test:e2e:journey:trading2       # fixture-backed read-only Trading 2ⁿᵈ MCP journey
npm run test:e2e:demo  # records tests tagged @demo (forward --grep to pick one journey)
npm run test:e2e -- --grep @feature-notebook # feature subset
npm run test:coverage  # Vitest coverage
npm run smoke          # live e2e: MCP handshake + a tool call against the running engines
                       #   (--web goes through the Vite proxy and checks the page HTML)
npm run backend:test   # cargo test --workspace (the Tauri shell)
npm run version:set -- 0.1.1   # stamp one version into src-tauri/Cargo.toml + tauri.conf.json
```

## Repository map

**`modules/rehab-video-maker` is legacy and is being abandoned.** It is checked
out only because it builds a commentary video end to end (podcast transcript →
commentary script → slides → narration → MP4) and is the reference to consult
when fina-builder's own media workflow hits a problem. Do not add dependencies
on it, do not route product features through it, and do not treat its scripts or
skills as fina-builder's implementation. New work belongs in fina-builder (and,
for claim/feature research, in the plan of
[doc 65](./docs/65-entity-claims-features-signal-research.md)).


```text
modules/riga-flow/     The pricing engine (`riga-mcp`). Submodule, standalone workspace.
modules/tac-engine/    Market data (`tac-engine`: lake + Alpaca + FRED). Submodule.
modules/riga/          The RIGA agent (`riga-kernel` / `riga-server` / `riga-shell`). Submodule.
modules/linkZagShow/   LinkZag.Show studio + renderer (media render app). Submodule, reference.
modules/rehab-video-maker/  LEGACY, reference only. Submodule; see the note below.
src-tauri/             Desktop shell: MCP server registry + the RIGA agent host (IPC adapter only)
src/                   React frontend
  api/                 riga / tac MCP transports (http + tauri)
  features/riga/       riga-flow tiles, the `fina.instrument/v1` store, deep-form editor
  features/tac/        tac-engine market-data tiles
  features/dashboards/ tile catalog + types
  store/               Zustand UI state (dashboards, instrument, observability) + localStorage
scripts/               Engine sidecars, live-engine instrument pricing, coverage gates, version stamping
```

## Release a version

Pushing a `vX.Y.Z` tag builds every platform and publishes one GitHub Release
(`.github/workflows/release.yml`):

| Job | Output |
| --- | --- |
| `release-create` | Validates the tag, stamps the version into the manifests, opens a **draft** release |
| `desktop` | Linux x86_64 (AppImage, deb, rpm) · macOS Apple Silicon + Intel (dmg) · Windows x86_64 (msi, setup.exe) |
| `release-publish` | Publishes the draft — only if every platform build succeeded |

```bash
# 1. optional: keep the manifests in step with the tag (CI re-derives it anyway)
npm run version:set -- 0.1.1

# 2. tag and push — this is what triggers the release
git tag -a v0.1.1 -m "0.1.1"
git push origin v0.1.1
```

Watch it in the Actions tab; the Release appears under the tag once all matrix jobs are green.
Re-running a failed job is safe: assets are re-uploaded to the same draft.

Notes:

- Tags matching `v*.*.*` trigger the workflow; a `-rc.1`-style suffix is published as a
  GitHub **prerelease** and does not become the default download.
- A single platform can also be built on demand: **Actions → release → Run workflow**, with an
  existing tag as input.
- Builds are **unsigned** unless these repository secrets exist, in which case the Tauri CLI
  picks them up automatically: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`,
  `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`.

## Validation

| Command | Covers |
| --- | --- |
| `npm run test:run` | Vitest frontend unit/integration suite: riga/tac tile rendering, the instrument store, the golden transcript, stores |
| `npm run test:e2e` | Playwright Chromium browser flows; auto-starts Vite and does not require live engines |
| `npm run test:e2e:smoke` / `npm run test:e2e -- --grep @journey-dashboard-setup` | Playwright `@smoke`, user-journey, and feature slices; see [test taxonomy](./playwright/README.md) |
| `npm run test:e2e:demo -- --grep @demo-dashboard-note` | Records the selected tagged Playwright demo flow for narration |
| `npm run demo:narrate -- --voice andrew --script <cues.txt>` | Generates one narrator clip per cue; Andrew default, `steffan` / `thomas` / `eric` optional |
| `cargo test --workspace` | The Tauri shell (MCP client + engine resolution) |
| `cargo test --manifest-path modules/riga-flow/Cargo.toml -p riga-engine -p riga-mcp` | The engine's own unit + tool-surface tests (the submodule's CI covers these too) |
| `npm run smoke [-- --web]` | Live end-to-end: handshakes `riga-mcp` + `tac-engine` (directly or through the Vite proxy) and calls `price_put` |
| `npm run build` / `npm run lint` | TypeScript + Vite build, Oxlint |
| CI (`.github/workflows/ci.yml`) | frontend, desktop shell (fmt/clippy/tauri), coverage gates, and a guard that test mocks never reach a production bundle |

See [playwright/README.md](./playwright/README.md) for browser-suite setup, recording options, and the narrated demo workflow.

## Changing things

- **A number:** it lives in the engine, not here — `modules/riga-flow` (pricing) or
  `modules/tac-engine` (market data). This repo only carries the request/response mirrors in
  `src/features/riga/types.ts` and `src/features/tac/`.
- **A tile:** `src/features/dashboards/{types,catalog}.ts`, the view under `src/features/`
  (riga-flow tiles in `features/riga/components/`, tac tiles in `features/tac/components/`),
  and the `case` in `src/features/tiles/components/TileRenderer.tsx`.
- **The instrument document:** the canonical `fina.instrument/v1` schema lives in
  `src/features/riga/instrument/` (schema, adapters, `toRequest`).
- **Workspace state:** `src/store/` (dashboards in `explorerStore.ts`, the instrument in
  `instrumentStore.ts`). It persists to `localStorage` under the existing `fina-*` keys.


### Trading 2ⁿd and R&D writes

The current write slice is capability-first and host-authorized. Trading 2ⁿd exposes named TAC `place_order`, `get_order`, and `cancel_order` operations. Order fields are validated at both the browser bridge and Tauri host boundary, decimal quantities/prices remain strings, and the UI confirms the exact symbol, side, quantity, type, price, time-in-force, and host-controlled account/environment immediately before dispatch. After a mutation, the UI refreshes through the read API; it does not optimistically fabricate broker state. No automatic retry is performed after an ambiguous broker result.

R&D exposes the tracked `rd_trace_start`, `rd_trace_get`, `rd_trace_list`, `rd_train`, `rd_validate_workflow`, and `rd_run_workflow` operations through the named qlib service. The `+ YAML` editor submits only a bounded workflow document: the service validates its allowlisted Qlib classes/fields, preflights actual lake data, injects host-owned provider/tracking configuration, fixes LightGBM seed/thread/determinism settings, and dispatches through an isolated worker. The user confirms the exact experiment and config fingerprint immediately before dispatch. qlib/MLflow artifacts and model files remain owned by the service and are not copied into fina-builder. Renderer arguments cannot select a path, URI, tracking store, executable, database, or credentials. The separate R&D Notebook offers an external-agent authoring prompt and starter YAML, so RIGA is optional for this path. Scheduler create/update/enable/pause/resume remains explicitly unsupported until a canonical scheduler owner and lifecycle are selected.

The default tests use fixtures/stubs only. Passing fixture journeys does not imply live broker or production R&D readiness: host credentials, paper/live configuration, lake, MLflow/tracking store, and service availability remain runtime prerequisites.
