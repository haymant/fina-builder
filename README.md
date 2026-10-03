# Fina Builder — Structured Product Payoff Explorer

An analytical workbench for inspecting synthetic Worst-of Phoenix Autocall paths and
assembling role-oriented dashboards. The UI is React/TypeScript; **all domain logic lives in a
single Rust crate** (`fina-kernel`) behind thin adapters, so the browser build, the desktop
build, the CLI and (later) MCP return byte-identical numbers.

> **Scope:** a demonstrator, not a production pricing or risk system. The data and most
> calculations are deterministic or illustrative. Read [FEATURES.md](./FEATURES.md) for the
> feature inventory, the architecture, and the documented divergences from a real model.

## Documentation

| Document | What it covers |
| --- | --- |
| **[FEATURES.md](./FEATURES.md)** | Part I: what the product does (surfaces, the 12 commands, kernel modules, the 51-tile UI, known gaps). Part II: the migration specification and its completion record (Appendices A–F). |
| [README.md](./README.md) (this file) | How to run it and how to release it. |

## Requirements

- Node.js 22 and npm (`package-lock.json` is committed).
- Rust/Cargo for every backend mode — web backend, CLI and desktop all compile Rust.
- Desktop builds additionally need the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/).
  On Debian/Ubuntu:

  ```bash
  sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
    libxdo-dev libssl-dev patchelf build-essential file
  ```

  The browser + web-backend mode does not need the WebKit libraries.

## Run it

### 1. Web mode (browser + HTTP backend) — two processes

```bash
npm ci
npm run dev:all
```

| | |
| --- | --- |
| Frontend | Vite on <http://127.0.0.1:5173> |
| Backend | `fina-server` on <http://127.0.0.1:8787> |

`npm run dev:all` starts both. To run them separately:

```bash
npm run backend:dev    # cargo run -p fina-server   (--host / --port to change)
npm run dev            # vite
```

> Starting only `npm run dev` gives you a frontend with **no** backend; every command then
> fails with `ERR_CONNECTION_REFUSED`. That is the expected symptom of a missing
> `fina-server`, not a frontend bug.

Smoke-test the backend directly:

```bash
curl -s http://127.0.0.1:8787/health
curl -s -X POST http://127.0.0.1:8787/api/cmd/get_branch_stats \
  -H 'content-type: application/json' -d '{}'
```

Configuration: `VITE_FINA_BASE_URL` overrides the backend URL, `VITE_FINA_TRANSPORT=http|tauri`
forces a transport (otherwise Tauri is auto-detected via `__TAURI_INTERNALS__`).

### 2. Desktop mode (Tauri IPC)

```bash
npm run tauri:dev      # window with IPC; no HTTP backend needed
npm run tauri:build    # native bundles for the current platform
```

### 3. CLI mode (headless)

```bash
cargo run -p fina-cli -- generate-paths --seed 42 --paths 100 --out bundle.json
cargo run -p fina-cli -- compute-risk --trade trade.json --market market.json
cargo run -p fina-cli -- --help
```

stdout is JSON only (pipe it into `jq`); progress goes to stderr as NDJSON.

### Other scripts

```bash
npm run build          # type-check + production frontend bundle
npm run lint           # oxlint
npm run test:run       # 49 Vitest tests
npm run test:coverage  # Vitest coverage
npm run backend:test   # cargo test --workspace (296 tests)
npm run version:set -- 0.1.1   # stamp one version into Cargo.toml, src-tauri/Cargo.toml, tauri.conf.json
```

## Repository map

```text
crates/fina-kernel/     All domain logic. Deps: serde, serde_json, thiserror. Nothing else.
  src/api.rs            The 12-command wire contract + dispatch/dispatch_sync
  src/path_generator.rs Deterministic demo path engine
  src/{economics,risk_engine,diagnostics,valuation,execution}.rs
  src/{jsnum,rng,dates}.rs   JavaScript-exact numerics, PRNG, calendar
  tests/                Golden parity, path semantics, toFixed conformance, dep hygiene
crates/fina-server/     HTTP adapter (actix-web): /health, /api/cmd/{cmd}, /api/stream/{cmd}
crates/fina-cli/        CLI adapter (clap) over the same dispatcher
crates/fina-mcp/        Stub — deferred
src-tauri/              Desktop adapter: #[tauri::command] pass-throughs + Channel progress
src/                    React frontend (unchanged location)
  api/                  Transport-agnostic command client (Tauri | HTTP)
  features/             Tiles, workspace, payoff graph, pathcube, attribution, …
  store/                Zustand input/UI state + localStorage persistence
scripts/                Golden fixture tooling, coverage gates, version stamping
```

## Release a version

Pushing a `vX.Y.Z` tag builds every platform and publishes one GitHub Release
(`.github/workflows/release.yml`):

| Job | Output |
| --- | --- |
| `release-create` | Validates the tag, stamps the version into the manifests, opens a **draft** release |
| `desktop` | Linux x86_64 (AppImage, deb, rpm) · macOS Apple Silicon + Intel (dmg) · Windows x86_64 (msi, setup.exe) |
| `cli` | `fina-cli` for Linux (gnu, static musl, arm64), macOS (x64, arm64), Windows x86_64 |
| `release-publish` | Publishes the draft — only if every platform build succeeded |

```bash
# 1. optional: keep the manifests in step with the tag (CI re-derives it anyway)
npm run version:set -- 0.1.1
cargo check -p fina-cli          # refresh Cargo.lock, then commit the three files + lockfile

# 2. tag and push — this is what triggers the release
git tag -a v0.1.1 -m "0.1.1"
git push origin v0.1.1
```

Watch it in the Actions tab; the Release appears under the tag once all matrix jobs are green.
Re-running a failed job is safe: assets are re-uploaded to the same draft.

Notes:

- Tags matching `v*.*.*` trigger the workflow; a `-rc.1`-style suffix is published as a
  GitHub **prerelease** and does not become the default download.
- A single platform can also be built on demand: **Actions → release → Run workflow**, with
  an existing tag as input.
- Builds are **unsigned** unless these repository secrets exist, in which case the Tauri CLI
  picks them up automatically: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`,
  `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`.
- The desktop matrix assumes the standard Linux/macOS/Windows runner images. Neither
  workflow has completed a full green run on a real runner yet, so treat the first tag push
  as the shakedown.

## Validation

| Command | Covers |
| --- | --- |
| `cargo test --workspace` | 296 tests: kernel units, golden parity against the original TypeScript, adapter parity (server, CLI, Tauri) |
| `npm run test:run` | 49 Vitest tests: stores, hooks, transports, transport parity, tile rendering |
| `npm run build` / `npm run lint` | TypeScript + Vite build, Oxlint |
| CI (`.github/workflows/ci.yml`) | frontend, Rust core, adapters, coverage gates, kernel dependency hygiene, and a guard that test mocks never reach a production bundle |

There is no browser E2E suite, by design.

## Changing things

- **A number:** it lives in `crates/fina-kernel`. Formulas were ported verbatim, so changing
  one is a decision, not a fix — update the golden fixture expectations in the same commit.
- **A tile:** `src/features/dashboards/{types,catalog}.ts`, the view under `src/features/`, and
  the `case` in `src/features/tiles/components/TileRenderer.tsx`.
- **The command surface:** `crates/fina-kernel/src/api.rs`. Adapters follow automatically —
  they hold no command table of their own.
- **Workspace state:** `src/store/explorerStore.ts`; trade and market inputs in
  `tradeEconomicsStore.ts` / `marketDataStore.ts`. All of it persists to `localStorage` under
  the existing `fina-*` keys.
