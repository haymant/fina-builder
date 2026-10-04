#!/usr/bin/env bash
# Stage the `fina-mcp` stdio server as a Tauri sidecar.
#
# Tauri's `bundle.externalBin` expects each binary at
# `src-tauri/binaries/<name>-<target-triple>` (a `.exe` suffix on Windows).
# This script builds the workspace binary and copies it into that location so
# both `tauri dev` and `tauri build` can find and bundle it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

triple="$(rustc -vV | sed -n 's/^host: //p')"
if [[ -z "$triple" ]]; then
  echo "fina-mcp sidecar: could not determine the host target triple" >&2
  exit 1
fi

exe_suffix=""
name="fina-mcp"
if [[ "$triple" == *windows* ]]; then
  exe_suffix=".exe"
  name="fina-mcp.exe"
fi

echo "fina-mcp sidecar: building for $triple"
cargo build -p fina-mcp --bin fina-mcp

src="target/debug/$name"
dest="src-tauri/binaries/fina-mcp-$triple$exe_suffix"

if [[ ! -f "$src" ]]; then
  echo "fina-mcp sidecar: expected build output at $src" >&2
  exit 1
fi

mkdir -p "src-tauri/binaries"
cp "$src" "$dest"
echo "fina-mcp sidecar: staged $dest"
