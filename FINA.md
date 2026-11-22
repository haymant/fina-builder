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

Run the launcher from the repository or any descendant directory:

```bash
node scripts/fina.mjs help
node scripts/fina.mjs doctor
node scripts/fina.mjs doctor --json
node scripts/fina.mjs config --json
```

The `doctor` command checks the configured checkout and reports required tools. Missing `uv` is currently a warning because frontend and Rust-only work can proceed without the qlib runtime.

Configured lifecycle aliases delegate to the existing package scripts:

```bash
node scripts/fina.mjs dev
node scripts/fina.mjs web
node scripts/fina.mjs dev_http
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

The launcher currently uses Node's standard library only. Do not add a second configuration parser or copy command definitions into CI. When a lifecycle operation is promoted into the control plane, update `fina.toml`, this document, and the relevant tests together.

## Current scope and next steps

This is the initial control-plane layer, not yet the full experiment manager. It does not currently create Git branches/worktrees, install runtimes, inject secrets, start all MCP sidecars, or package releases. Those capabilities should be added incrementally behind commands such as:

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
