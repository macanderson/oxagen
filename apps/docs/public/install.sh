#!/bin/sh
# Oxagen CLI installer: https://docs.oxagen.sh/docs/cli/installation
#
# This script does three things:
#   1. Finds your platform: macOS on Apple silicon or Intel, or Linux on x86_64.
#   2. Downloads the matching `oxagen` executable from downloads.oxagen.sh,
#      checks it against its published SHA-256, and installs it to
#      ~/.local/bin. It never uses sudo.
#   3. Installs @oxagen/cli from npm instead when no executable exists for
#      your platform (Linux on arm64) or the download fails.
#
# Read it before you run it.

set -eu

BASE="${OXAGEN_INSTALL_BASE:-https://downloads.oxagen.sh/latest}"
INSTALL_DIR="${OXAGEN_INSTALL_DIR:-$HOME/.local/bin}"
BINARY="$INSTALL_DIR/oxagen"

info() { printf '\033[2m▸\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

path_hint() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *) warn "$INSTALL_DIR is not on your PATH. Add this line to your shell profile: export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
  esac
}

# 1. Platform. downloads.oxagen.sh names each executable by its Rust target
# triple (EXECUTABLE_TARGETS in apps/desktop/src/downloads.ts). An empty
# triple means no executable exists for the platform.
OS=$(uname -s)
ARCH=$(uname -m)
TRIPLE=""
case "$OS-$ARCH" in
  Darwin-arm64|Darwin-aarch64) TRIPLE="aarch64-apple-darwin" ;;
  Darwin-x86_64)               TRIPLE="x86_64-apple-darwin" ;;
  Linux-x86_64|Linux-amd64)    TRIPLE="x86_64-unknown-linux-gnu" ;;
  Linux-aarch64|Linux-arm64)   ;;
  Darwin-*|Linux-*) fail "unsupported architecture: $ARCH" ;;
  *) fail "unsupported OS: $OS. This script supports macOS and Linux. On Windows, download oxagen-x86_64-pc-windows-msvc.exe from https://downloads.oxagen.sh/" ;;
esac

# 2. The executable, checked against its published SHA-256.
if [ -n "$TRIPLE" ]; then
  ASSET="oxagen-$TRIPLE"
  URL="$BASE/$ASSET"
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT

  info "downloading $URL"
  if curl -fsSL -o "$TMP/oxagen" "$URL"; then
    curl -fsSL -o "$TMP/oxagen.sha256" "$URL.sha256" \
      || fail "downloaded $ASSET but not its checksum file. Nothing was installed."
    EXPECTED=$(cut -d' ' -f1 < "$TMP/oxagen.sha256")
    if command -v shasum >/dev/null 2>&1; then
      ACTUAL=$(shasum -a 256 "$TMP/oxagen" | cut -d' ' -f1)
    else
      ACTUAL=$(sha256sum "$TMP/oxagen" | cut -d' ' -f1)
    fi
    [ "$EXPECTED" = "$ACTUAL" ] \
      || fail "checksum mismatch: expected $EXPECTED, got $ACTUAL. Nothing was installed."
    ok "checksum matches"

    mkdir -p "$INSTALL_DIR"
    install -m 755 "$TMP/oxagen" "$BINARY"
    ok "installed $BINARY ($("$BINARY" --version 2>/dev/null || echo "version unknown"))"
    path_hint
    exit 0
  fi
  REASON="The download from $URL failed"
else
  REASON="No oxagen executable is published for Linux on $ARCH"
fi

# 3. npm, when no executable could be installed.
warn "$REASON, so this script installs @oxagen/cli from npm instead."
command -v npm >/dev/null 2>&1 \
  || fail "npm was not found. Install Node.js 20 or newer from https://nodejs.org, then run this script again."
NODE_MAJOR=$(node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 20 ] \
  || fail "Node.js 20 or newer is required. Found $(node --version 2>/dev/null || echo none)."

NPM_VERSION=$(npm view @oxagen/cli version 2>/dev/null || echo unknown)
info "npm holds @oxagen/cli $NPM_VERSION, which can be older than the executable on downloads.oxagen.sh"
npm install -g @oxagen/cli
if oxagen --version >/dev/null 2>&1; then
  ok "installed from npm: oxagen $(oxagen --version)"
else
  warn "npm finished, but \`oxagen --version\` failed."
  warn "See https://docs.oxagen.sh/docs/cli/installation for the other ways to install."
  exit 1
fi
