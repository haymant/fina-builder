#!/usr/bin/env bash
# Build and stage the root-workspace nip-engine MCP server for Tauri packaging.
set -uo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
triple="$(rustc -vV | sed -n 's/^host: //p')"
suffix=""; out="nip-engine"
if [[ "$triple" == *windows* ]]; then suffix=".exe"; out="nip-engine.exe"; fi
if ! cargo build --release -p nip-engine --bin nip-engine; then
  echo "nip-engine sidecar: build failed; runtime workspace path will be used" >&2
  exit 0
fi
src="target/release/$out"
dest="src-tauri/binaries/nip-engine-$triple$suffix"
if [[ ! -f "$src" ]]; then echo "nip-engine sidecar: missing $src" >&2; exit 0; fi
mkdir -p src-tauri/binaries
if ! cp "$src" "$dest"; then
  echo "$bin sidecar: could not stage $dest (a running process may hold it); runtime will use the workspace path" >&2
  exit 0
fi
echo "nip-engine sidecar: staged $dest"
