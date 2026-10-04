#!/usr/bin/env bash
# Linux dev launcher that disables the WebKitGTK GPU paths.
#
# Symptom this targets: the window goes blank at random, while the Tauri
# process stays alive. That points at the *web content process*
# (WebKitWebProcess), which is a separate binary from the app — an attach to
# the app shows a healthy idle `ppoll` loop even while the UI is gone.
#
# WebKitGTK's DMABuf-based accelerated renderer and its GL compositing mode
# are the usual culprits on VMs, remote desktops, and machines without a
# working GPU driver. Both fall back to software rendering here, at a cost in
# paint performance. This is a *diagnostic* switch: if the blanking stops with
# it set, the crash is in the WebKit renderer and not in app code.
#
# Usage:
#   scripts/dev-linux-stable-webview.sh                 # disable all three
#   scripts/dev-linux-stable-webview.sh --no-dmabuf     # DMABuf renderer only
#   scripts/dev-linux-stable-webview.sh --no-compositing
#   scripts/dev-linux-stable-webview.sh --no-softwaregl
#
# Confirm a renderer crash independently with:
#   dmesg | grep -iE 'segfault|WebKitWebProcess' | tail -20

set -euo pipefail

cd "$(dirname "$0")/.."

dmabuf=1
compositing=1
softwaregl=1

for arg in "$@"; do
  case "$arg" in
    --no-dmabuf) dmabuf=0 ;;
    --no-compositing) compositing=0 ;;
    --no-softwaregl) softwaregl=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# Keep these exported so tauri's own child processes inherit them. Use `if`
# rather than `[ ... ] && export`: under `set -e` a false test as the left side
# of an `&&` list fails the whole list and would abort the script.
if [ "$dmabuf" -eq 0 ]; then export WEBKIT_DISABLE_DMABUF_RENDERER=1; fi
if [ "$compositing" -eq 0 ]; then export WEBKIT_DISABLE_COMPOSITING_MODE=1; fi
if [ "$softwaregl" -eq 0 ]; then export LIBGL_ALWAYS_SOFTWARE=1; fi

echo "webview renderer flags:"
echo "  WEBKIT_DISABLE_DMABUF_RENDERER=${WEBKIT_DISABLE_DMABUF_RENDERER:-0}"
echo "  WEBKIT_DISABLE_COMPOSITING_MODE=${WEBKIT_DISABLE_COMPOSITING_MODE:-0}"
echo "  LIBGL_ALWAYS_SOFTWARE=${LIBGL_ALWAYS_SOFTWARE:-0}"

# The flags above are consumed by this script; do not forward them to tauri.
exec npm run tauri:dev