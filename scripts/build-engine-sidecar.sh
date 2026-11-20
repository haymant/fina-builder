#!/usr/bin/env bash
# Stage an engine MCP server (riga-mcp / tac-engine) as a Tauri sidecar.
#
# The primary resolution path for these servers is the **submodule default
# relative path** (`modules/<dir>/target/release/<bin>`, §3.10), which the Rust
# resolver checks first. Staging into `src-tauri/binaries/` is a convenience for
# packaged builds only, so this script is **best-effort**: a missing submodule or
# a missing submodule or build failure must fail early with an actionable setup
# error rather than allowing Tauri to start and later report an opaque MCP
# connection-closed error.
#
#   bash scripts/build-engine-sidecar.sh riga-flow riga-mcp RIGA_MCP_BIN
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

dir="${1:?usage: build-engine-sidecar.sh <submodule-dir> <bin> <env-var>}"
bin="${2:?usage: build-engine-sidecar.sh <submodule-dir> <bin> <env-var>}"
env_var="${3:?usage: build-engine-sidecar.sh <submodule-dir> <bin> <env-var>}"

manifest="modules/$dir/Cargo.toml"
if [[ ! -f "$manifest" ]]; then
  echo "$bin sidecar: required submodule modules/$dir is not initialized. Run: git submodule update --init --recursive" >&2
  exit 1
fi

triple="$(rustc -vV | sed -n 's/^host: //p')"
exe_suffix=""; out="$bin"
if [[ "$triple" == *windows* ]]; then exe_suffix=".exe"; out="$bin.exe"; fi

echo "$bin sidecar: building modules/$dir for $triple"
if ! cargo build --release --manifest-path "$manifest" --bin "$bin"; then
  echo "$bin sidecar: build failed; install the pinned Rust toolchain and retry" >&2
  exit 1
fi

src="modules/$dir/target/release/$out"
dest="src-tauri/binaries/$bin-$triple$exe_suffix"
if [[ ! -f "$src" ]]; then
  echo "$bin sidecar: expected build output at $src" >&2
  exit 0
fi

mkdir -p "src-tauri/binaries"
if ! cp "$src" "$dest"; then
  echo "$bin sidecar: could not stage $dest (a running process may hold it); runtime will use the workspace path" >&2
  exit 0
fi
echo "$bin sidecar: staged $dest"
