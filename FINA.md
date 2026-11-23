# Fina control plane

`fina.toml` and `scripts/fina.mjs` are the initial control plane for Fina Builder. They provide one repository-owned entry point for development checks and lifecycle commands while keeping Cargo, npm, uv, Vite, Rust sidecars, and Git implementation details behind a stable interface.

The control plane is intentionally small at this stage. It does not replace ecosystem lockfiles or existing package scripts. Instead, it establishes the contract that future runtime, experiment, and release automation will consume.

## Design requirements

- `fina.toml` is the canonical, non-secret project configuration.
- `scripts/fina.mjs` is the canonical developer and CI entry point.
- `package-lock.json`, `pnpm-lock.yaml`, `Cargo.lock`, `rust-toolchain.toml`, and `modules/tac-qlib/uv.lock` remain authoritative for their own dependency ecosystems.
- Secrets must not be committed to `fina.toml`, `.mcp.json`, experiment branches, logs, or generated diagnostics.
- Paths in the configuration are repository-relative and are resolved to absolute paths by the launcher.
- Existing npm scripts remain the implementation for now; later lifecycle features should be added behind `fina` rather than as another set of documented commands.
- Development, CI, and packaged execution should eventually use the same logical configuration with profile-specific path resolution.

## Configuration

The root [`fina.toml`](./fina.toml) currently defines:

- `[project]`: project identity and control-plane schema version.
- `[toolchain]`: minimum Node version and toolchain declarations.
- `[paths]`: repository-relative locations for skills, modules, Rust output, qlib, local data, and experiments.
- `[mcp]`: the workspace MCP manifest location.
- `[profiles.*]`: initial development, CI, and packaged data/build policies.
- `[commands]`: the small set of lifecycle aliases exposed by the launcher.

The configuration is deliberately declarative and secret-free. Machine-specific overrides and credentials are future work; they should be external to the committed file.

## Usage

Run the launcher from the repository or any descendant directory. The default profile is
`development`; select `ci` or `packaged` explicitly when validating those path policies:

```bash
node scripts/fina.mjs help
node scripts/fina.mjs doctor
node scripts/fina.mjs doctor --json
node scripts/fina.mjs config --json
node scripts/fina.mjs --profile ci config --json
node scripts/fina.mjs --profile packaged doctor --json
```

The `doctor` command checks the configured checkout and reports required tools. Missing `uv` is currently a warning because frontend and Rust-only work can proceed without the qlib runtime.

Configured lifecycle aliases delegate to the existing package scripts:

```bash
node scripts/fina.mjs dev
node scripts/fina.mjs web
node scripts/fina.mjs dev_http
node scripts/fina.mjs desktop
node scripts/fina.mjs build
node scripts/fina.mjs test
node scripts/fina.mjs lint
node scripts/fina.mjs runtime_prepare
node scripts/fina.mjs package
```

The same aliases can be invoked explicitly through `run`:

```bash
node scripts/fina.mjs run build
node scripts/fina.mjs run test -- src/api/__tests__/rdApi.test.ts
```

The selected profile controls the resolved data root and is exposed to delegated commands
through the following environment contract. The launcher supplies these variables when a
configured command is invoked with `fina ...` or `node scripts/fina.mjs run ...`; they are
not required in the shell just to run `config` or `doctor`.

| Variable | Meaning | Development value in this checkout |
| --- | --- | --- |
| `FINA_PROFILE` | Selected policy profile (`development`, `ci`, or `packaged`). | `development` |
| `FINA_ROOT` | Absolute path to the discovered Fina checkout containing `fina.toml`. | `/home/ubuntu/fina-builder` |
| `FINA_WORKSPACE_ROOT` | Absolute active workspace root. This is explicit so sidecars and future experiment worktrees do not infer a root from their current directory. | `/home/ubuntu/fina-builder` |
| `FINA_DATA_ROOT` | Profile-owned writable data root for local state, artifacts, databases, and logs. | `/home/ubuntu/fina-builder/.fina/data` |
| `FINA_RUST_TARGET_DIR` | Shared Rust build-output directory selected by the control plane. Delegated commands also receive this as `CARGO_TARGET_DIR` unless the caller already supplied `CARGO_TARGET_DIR`. | `/home/ubuntu/fina-builder/modules/target` |
| `FINA_QLIB_ROOT` | Absolute source root for the qlib/TAC research module. The Python environment remains managed by `uv` and its lockfile. | `/home/ubuntu/fina-builder/modules/tac-qlib` |
| `TAC_LAKE_DIR` | Profile-owned TradeAC market lake root. | `/home/ubuntu/fina-builder/.fina/data/lake` |
| `NIP_DATA_DIR` | Profile-owned NIP canonical DuckDB/state directory. | `/home/ubuntu/fina-builder/.fina/data/nip` |
| `NIP_LAKE_DIR` | Profile-owned NIP Parquet export directory, separate from the TAC lake. | `/home/ubuntu/fina-builder/.fina/data/nip/lake` |
| `TAC_ENGINE_BIN` | Profile-resolved release `tac-engine` binary path; an explicit caller value is preserved. | `/home/ubuntu/fina-builder/modules/target/release/tac-engine` |
| `TAC_QLIB_PYTHON_BIN` | Shared qlib interpreter path under `modules/.venv`; `uv` creates it when preparing runtimes. | `/home/ubuntu/fina-builder/modules/.venv/bin/python` |

All paths are absolute and derived from `fina.toml` plus the selected profile data root;
credentials are not loaded or copied by the launcher. These variables are the stable boundary
for scripts and sidecars. Explicit caller values for service paths and binary overrides are
preserved. Provider settings such as `VITE_*` remain service-specific because they are not
filesystem or runtime path contracts.

### Full E2E verification in a Manus sandbox

For the normal path, do not hand-maintain these environment variables. Run the launcher from the checkout;
it discovers the root, resolves the development profile, exports the variables for delegated
commands, and sets `CARGO_TARGET_DIR` for Rust builds:

```bash
cd /home/ubuntu/fina-builder
git submodule update --init --recursive
npm ci
node scripts/fina.mjs doctor --json
node scripts/fina.mjs runtime_prepare
```

Start the complete local HTTP stack in one terminal:

```bash
cd /home/ubuntu/fina-builder
node scripts/fina.mjs dev_http
```

Then, in a second terminal, run the deterministic journeys. The narrative journeys use
repository fixtures and do not require production credentials or an OpenAI-compatible endpoint
unless a specific test is intentionally configured for a live provider:

```bash
cd /home/ubuntu/fina-builder
npm run test:e2e:journey:narrative
npm run test:e2e:journey:narrative-evidence
npm run test:e2e:journey:external-agent
```

Run the complete Playwright suite with `npm run test:e2e`. If a script must be started directly
rather than through the launcher, the equivalent development values are:

```bash
export FINA_PROFILE=development
export FINA_ROOT=/home/ubuntu/fina-builder
export FINA_WORKSPACE_ROOT=/home/ubuntu/fina-builder
export FINA_DATA_ROOT=/home/ubuntu/fina-builder/.fina/data
export FINA_RUST_TARGET_DIR=/home/ubuntu/fina-builder/modules/target
export FINA_QLIB_ROOT=/home/ubuntu/fina-builder/modules/tac-qlib
export CARGO_TARGET_DIR="$FINA_RUST_TARGET_DIR"
```

Manual exports are mainly useful for custom child processes or debugging. They do not replace
profile resolution and they do not provide secrets. Keep Alpaca, FRED, database, or provider
credentials in the host environment or an ignored user-owned `.env` file only.

### TAC/TradeAC variables

`TAC_LAKE_DIR` and the engine binary override serve different purposes:

- `TAC_LAKE_DIR` is now injected automatically by the control plane. In the development profile
  it resolves to `/home/ubuntu/fina-builder/.fina/data/lake`; CI and packaged profiles receive
  their own profile data-root variant. Set it explicitly only when you intentionally use a
  pre-populated lake outside the profile data root.
- `TAC_ENGINE_BIN` is the supported override for a prebuilt `tac-engine` executable. It is not
  needed for normal development: `dev_http` builds the locked release binary and resolves it
  from `CARGO_TARGET_DIR`, while the desktop sidecar scripts use the same override if present.
- `TRADEAC_ENGINE_BIN` is not used by this repository and should not be set. For the qlib
  services, the relevant optional interpreter override is `TAC_QLIB_PYTHON_BIN`; otherwise the
  wrapper uses the locked `uv` environment at `modules/.venv`.

`dev_http` is an npm script rather than the control-plane launcher. Like the desktop host it
reads the checkout `.env` and the two module `.env` files (shell values win), so browser mode
receives the same Alpaca credentials and database configuration as the Tauri sidecar. The
control-plane lake root (`FINA_DATA_ROOT/lake`) is used unless the checkout `.env` sets
`TAC_LAKE_DIR`; an explicit shell export always wins. The control-plane launcher itself still
does not load or copy secrets.

For a predictable full local stack, the following override is valid but optional:

```bash
export TAC_LAKE_DIR=/home/ubuntu/fina-builder/.fina/data/lake
mkdir -p "$TAC_LAKE_DIR"
node scripts/fina.mjs dev_http
```

The launcher’s focused contract tests run with:

```bash
npm run test:control-plane
```

The launcher currently uses Node's standard library only. Do not add a second configuration parser or copy command definitions into CI. When a lifecycle operation is promoted into the control plane, update `fina.toml`, this document, and the relevant tests together.

## Current scope and next steps

This is the stabilized profile-aware control-plane layer, not yet the full experiment manager.
It does not currently create Git branches/worktrees, install runtimes, inject secrets, start all
MCP sidecars, or package releases. Those capabilities should be added incrementally behind commands such as:

```text
fina experiment create <id>
fina experiment status <id>
fina experiment run <id>
fina release verify
```

Before adding those commands, the runtime contract should define the immutable installation root, user data root, active experiment worktree, artifact root, environment profile, and MCP registration set. The launcher should then validate that contract and fail closed rather than silently falling back to another workspace.

## CI requirement

GitHub Actions should call the same launcher commands used locally, for example:

```yaml
- run: node scripts/fina.mjs doctor --json
- run: node scripts/fina.mjs run lint
- run: node scripts/fina.mjs run test
- run: node scripts/fina.mjs run build
```

Workflow YAML should not duplicate repository paths, sidecar locations, Python environment setup, or experiment Git logic. Those belong in the control plane as the implementation grows.
