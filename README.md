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
| **[AGENT-LOCAL.md](./AGENT-LOCAL.md)** | The RIGA assistant chat panel (desktop shell ↔ `riga-server`). |
| [README.md](./README.md) (this file) | How to run it and how to release it. |

## Requirements

- Node.js **22.19.0 or newer** and npm (`package-lock.json` is committed).
- Rust/Cargo. The version is pinned in `rust-toolchain.toml` (currently **1.99.0**);
  `rustup` installs it automatically, so `cargo build` just works.
- **The engines.** `riga-flow` and `tac-engine` live under `modules/` as standalone
  workspaces (they are *excluded* from the root workspace). The `dev:http` launcher
  builds their HTTP binaries automatically; Rust/Cargo must be installed first:

  ```bash
  cargo build --release --manifest-path modules/riga-flow/Cargo.toml   # → modules/riga-flow/target/release/riga-mcp
  cargo build --release --manifest-path modules/tac-engine/Cargo.toml  # → modules/tac-engine/target/release/tac-engine
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

## Run it

### 1. Web mode (browser + HTTP engines) — three processes

Alpaca credentials are optional. Without them, `tac-engine` serves Yahoo Finance daily stock
history and free Yahoo/ECB daily FX rates; account/order tools and Alpaca-only data (such as
intraday bars, quotes, options, and streams) are unavailable. Set both `APCA_API_KEY_ID` and
`APCA_API_SECRET_KEY` in the shell or `modules/tac-engine/.env` to enable those features (template:
`modules/tac-engine/.env.example`). If `TAC_LAKE_DIR` is unset, `dev:http` uses the absolute
workspace path `.lake/`; an explicit environment or `.env` value takes precedence. The lake can be
empty and will be populated on demand with supported daily history. The launcher never supplies
placeholder credentials or synthetic market data.

```bash
npm ci
npm run dev:http          # builds both Rust backends, then starts them with Vite (CPU default)
# Optional: enable CUDA for riga-mcp; requires CUDA Toolkit 13+ and a visible NVIDIA GPU.
npm run dev:http -- --cuda
# Optional: bind Vite to 0.0.0.0 for a forwarded/public preview; backend ports remain local.
npm run dev:http -- --public
```

`npm run dev:all` remains available when both backend binaries have already been built. The
`dev:http` command builds `riga-mcp` and `tac-engine` before launching all three services,
checks that ports 5173/8788/8790 are free, and stops the other processes if one exits. CPU is
the default. The first build may take several minutes because `tac-engine` bundles DuckDB;
subsequent runs reuse the compiled artifacts. `--cuda` adds the `riga-mcp` `gpu` Cargo feature (CUDA 13+); `tac-engine` remains
CPU-only. The CUDA option is explicit and fails early when the toolkit or NVIDIA GPU is not
available; omit it on Manus. This is separate from `tauri:dev:cuda`, which enables CUDA for
RIGA's local GGUF inference in the desktop shell.

| | |
| --- | --- |
| Frontend | Vite on <http://127.0.0.1:5173> |
| `riga-mcp` | MCP over HTTP on <http://127.0.0.1:8788> |
| `tac-engine` | MCP over HTTP on <http://127.0.0.1:8790> |

The webview calls the same-origin paths `/riga/mcp` and `/tac/mcp`, which Vite proxies to
the two engines (see `vite.config.ts`). To run the pieces separately:

```bash
npm run backend:dev      # npm run mcp:http:riga   (riga-mcp --transport http)
npm run mcp:http:tac     # the tac-engine HTTP bridge
npm run dev              # vite
```

> Starting only `npm run dev` gives you a frontend with **no** engines; the tiles then show
> their unavailable/error state (they never fall back to fake data). Use `npm run dev:http`
> to build and start the HTTP backends with the frontend.

Configuration: `VITE_RIGA_UPSTREAM` / `VITE_TAC_UPSTREAM` override the proxy targets, and
`VITE_RIGA_TRANSPORT=tauri|http` / `VITE_TAC_TRANSPORT=tauri|http` force a transport
(otherwise Tauri is auto-detected via `__TAURI_INTERNALS__`).

### 2. Desktop mode (Tauri IPC + stdio engines)

```bash
npm run tauri:dev      # window with IPC; the shell spawns the engines over stdio
npm run tauri:build    # native bundles for the current platform
```

The shell resolves `riga-mcp` / `tac-engine` from `RIGA_MCP_BIN` / `TAC_ENGINE_BIN`, else the
submodule default path (`modules/<dir>/target/{release,debug}`), else a bundled sidecar. It
forwards `.env` files (repo root, app-data, `modules/tac-engine/.env`, `modules/riga-flow/.env`)
to the engine children, so `TAC_LAKE_DIR`, `APCA_*` and `FRED_API_KEY` work without exporting
shell variables. Keys live in the host environment or a user-owned `.env` only — never in the
UI, logs or persisted state.

The TAC desktop sidecar still uses the same stdio transport and full Alpaca tool set when both
API keys are configured. If both are omitted, it starts in the same Yahoo daily-stock/FX fallback
mode as web mode; account/order tools are omitted, and Alpaca-only market data remains unavailable.

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
lanes. It resolves the engines exactly like the app (`RIGA_MCP_BIN` / `TAC_ENGINE_BIN`, else
`modules/<dir>/target/release/<bin>`). To reconcile against another pricer, `--no-call` drops
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
npm run test:e2e:demo  # records tests tagged @demo (forward --grep to pick one journey)
npm run test:e2e -- --grep @feature-notebook # feature subset
npm run test:coverage  # Vitest coverage
npm run smoke          # live e2e: MCP handshake + a tool call against the running engines
                       #   (--web goes through the Vite proxy and checks the page HTML)
npm run backend:test   # cargo test --workspace (the Tauri shell)
npm run version:set -- 0.1.1   # stamp one version into src-tauri/Cargo.toml + tauri.conf.json
```

## Repository map

```text
modules/riga-flow/     The pricing engine (`riga-mcp`). Submodule, standalone workspace.
modules/tac-engine/    Market data (`tac-engine`: lake + Alpaca + FRED). Submodule.
modules/riga/          The RIGA agent (`riga-kernel` / `riga-server` / `riga-shell`). Submodule.
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
