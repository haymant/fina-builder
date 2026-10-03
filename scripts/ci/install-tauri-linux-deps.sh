#!/usr/bin/env bash
# Installs the Linux system libraries the Tauri desktop shell links against
# (GTK, GLib, WebKit, the status-icon library, librsvg, patchelf) and the
# CMake/libclang toolchain required to build the bundled llama.cpp runtime.
#
#   ./scripts/ci/install-tauri-linux-deps.sh
#
# Why a script: the list is needed by three CI jobs (clippy, adapters, coverage)
# and by the Linux desktop release job, and it was already wrong once — an
# earlier CI file installed `libappindicator3-dev`, which Ubuntu 24.04 no longer
# ships (it is `libayatana-appindicator3-dev` since Tauri v2). One list, one place.
#
# No-op on anything that is not Debian/Ubuntu, so it is safe to call
# unconditionally from a cross-platform workflow.

set -euo pipefail

# Tauri's Linux prerequisites (v2): https://v2.tauri.app/start/prerequisites/
PACKAGES=(
  libwebkit2gtk-4.1-dev   # the webview
  libayatana-appindicator3-dev
  librsvg2-dev            # SVG assets in the bundle
  libgtk-3-dev            # GTK, pulled in by webkit2gtk but pinned here explicitly
  libxdo-dev              # tray/global shortcuts support in wry/tao
  libssl-dev              # TLS
  patchelf                # AppImage bundling rewrites RPATHs with it
  build-essential
  cmake
  ninja-build
  libclang-dev
  file
)

if [[ ! -r /etc/os-release ]]; then
  echo "install-tauri-linux-deps: no /etc/os-release; skipping."
  exit 0
fi

# shellcheck disable=SC1091
. /etc/os-release
if [[ "${ID:-}" != "debian" && "${ID:-}" != "ubuntu" ]]; then
  echo "install-tauri-linux-deps: ${ID:-unknown} is not Debian/Ubuntu; skipping."
  exit 0
fi

SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then
  if ! command -v sudo >/dev/null 2>&1; then
    echo "install-tauri-linux-deps: not root and sudo is unavailable; cannot install." >&2
    exit 1
  fi
  SUDO="sudo"
fi

echo "install-tauri-linux-deps: ${PRETTY_NAME:-${ID}} — installing ${#PACKAGES[@]} packages"
$SUDO apt-get update
# shellcheck disable=SC2086
$SUDO apt-get install -y --no-install-recommends "${PACKAGES[@]}"

# Fail loudly here rather than 400 lines into a glib-sys build script.
if ! pkg-config --exists glib-2.0 gtk+-3.0 webkit2gtk-4.1; then
  echo "install-tauri-linux-deps: pkg-config still cannot see the Tauri libraries:" >&2
  pkg-config --modversion glib-2.0 gtk+-3.0 webkit2gtk-4.1 >&2 || true
  exit 1
fi
echo "install-tauri-linux-deps: glib $(pkg-config --modversion glib-2.0), webkit2gtk-4.1 $(pkg-config --modversion webkit2gtk-4.1) — ok"
