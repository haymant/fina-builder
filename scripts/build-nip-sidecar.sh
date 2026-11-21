#!/usr/bin/env bash
# Build and stage the root-workspace nip-engine MCP server for Tauri packaging.
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$root/modules/target}"
triple="$(rustc -vV | sed -n 's/^host: //p')"
suffix=""; out="nip-engine"
if [[ "$triple" == *windows* ]]; then suffix=".exe"; out="nip-engine.exe"; fi
if ! cargo build --release -p nip-engine --bin nip-engine; then
  echo "nip-engine sidecar: build failed; install the pinned Rust toolchain and retry" >&2
  exit 1
fi
src="$CARGO_TARGET_DIR/release/$out"
dest="src-tauri/binaries/nip-engine-$triple$suffix"
if [[ ! -f "$src" ]]; then echo "nip-engine sidecar: expected build output at $src" >&2; exit 1; fi
mkdir -p src-tauri/binaries
if ! cp "$src" "$dest"; then
  echo "nip-engine sidecar: could not stage $dest (a running process may hold it); runtime will use the workspace path" >&2
  exit 0
fi
echo "nip-engine sidecar: staged $dest"
