#!/bin/sh
# Oxagen CLI installer — https://docs.oxagen.sh/docs/cli/installation
#
# What this script does (and nothing else):
#   1. Detects your platform (macOS/Linux, arm64/x64).
#   2. Tries to fetch the matching prebuilt `oxagen` binary and verify its
#      SHA-256 checksum, installing it to ~/.local/bin (no sudo, ever).
#   3. If no prebuilt binary is published for your platform yet, falls back
#      to a global npm install of @oxagen/cli.
#
# Read it before you run it — we insist.

set -eu

RELEASE_BASE="${OXAGEN_INSTALL_BASE:-https://cli.oxagen.sh/releases/latest}"
INSTALL_DIR="${OXAGEN_INSTALL_DIR:-$HOME/.local/bin}"
BINARY="$INSTALL_DIR/oxagen"

info() { printf '\033[2m▸\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ── 1. platform ─────────────────────────────────────────────────────────────
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$OS" in
  darwin|linux) ;;
  *) fail "unsupported OS: $OS (macOS and Linux only)" ;;
esac
case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64" ;;
  *) fail "unsupported architecture: $ARCH" ;;
esac
info "detecting platform · ${OS}-${ARCH}"

# ── 2. prebuilt binary, checksum-verified ───────────────────────────────────
ASSET="oxagen-${OS}-${ARCH}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if curl -fsSL -o "$TMP/oxagen" "${RELEASE_BASE}/${ASSET}" 2>/dev/null; then
  info "fetching oxagen · verifying checksum"
  curl -fsSL -o "$TMP/oxagen.sha256" "${RELEASE_BASE}/${ASSET}.sha256" \
    || fail "binary downloaded but its .sha256 file is missing — refusing to install unverified"
  EXPECTED=$(cut -d' ' -f1 < "$TMP/oxagen.sha256")
  if command -v shasum >/dev/null 2>&1; then
    ACTUAL=$(shasum -a 256 "$TMP/oxagen" | cut -d' ' -f1)
  else
    ACTUAL=$(sha256sum "$TMP/oxagen" | cut -d' ' -f1)
  fi
  [ "$EXPECTED" = "$ACTUAL" ] || fail "checksum mismatch — expected $EXPECTED, got $ACTUAL"

  mkdir -p "$INSTALL_DIR"
  install -m 755 "$TMP/oxagen" "$BINARY"
  ok "install: $BINARY"

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ok "oxagen is on your PATH — run \`oxagen\` to get started" ;;
    *) printf '\033[33m!\033[0m add %s to your PATH, e.g.  export PATH="%s:$PATH"\n' "$INSTALL_DIR" "$INSTALL_DIR" ;;
  esac
  exit 0
fi

# ── 3. npm fallback ─────────────────────────────────────────────────────────
info "no prebuilt binary published for ${OS}-${ARCH} yet — falling back to npm"
command -v npm >/dev/null 2>&1 || fail "npm not found — install Node.js 20+ first (https://nodejs.org)"
NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20+ required (found $(node --version 2>/dev/null || echo none))"

npm install -g @oxagen/cli
if oxagen --version >/dev/null 2>&1; then
  ok "installed via npm — $(oxagen --version)"
else
  printf '\033[33m!\033[0m npm install completed but `oxagen --version` failed.\n'
  printf '  See https://docs.oxagen.sh/docs/cli/installation for the monorepo and\n'
  printf '  standalone-bundle install methods, which work everywhere today.\n'
  exit 1
fi
