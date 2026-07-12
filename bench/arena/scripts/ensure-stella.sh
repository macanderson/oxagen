#!/usr/bin/env bash
#
# Ensure Stella CLI is built and available
#
# Usage: source scripts/ensure-stella.sh or ./scripts/ensure-stella.sh
#
# This script:
# 1. Checks if stella binary exists
# 2. If not, or if --force flag is set, builds from ~/Workspaces/stella-cli
# 3. Verifies the binary works
# 4. Exports STELLA_BIN for use in benchmark runners

set -euo pipefail

STELLA_SOURCE="${STELLA_SOURCE:-$HOME/Workspaces/stella-cli}"
STELLA_BIN="${STELLA_BIN:-$HOME/.local/bin/stella}"
FORCE_BUILD="${FORCE_BUILD:-0}"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE_BUILD=1 ;;
    --source) STELLA_SOURCE="$2"; shift ;;
    --bin) STELLA_BIN="$2"; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
  shift
done

# Check if binary exists and is working
check_stella() {
  if [[ ! -f "$STELLA_BIN" ]]; then
    return 1
  fi

  if "$STELLA_BIN" --version &>/dev/null; then
    return 0
  fi

  return 1
}

# Build Stella from source
build_stella() {
  echo "🔨 Building Stella from $STELLA_SOURCE..."

  if [[ ! -d "$STELLA_SOURCE" ]]; then
    echo "❌ Stella source not found at $STELLA_SOURCE"
    echo "   Clone it first: git clone https://github.com/oxageninc/stella-cli ~/Workspaces/stella-cli"
    exit 1
  fi

  cd "$STELLA_SOURCE"

  # Ensure dependencies
  if [[ ! -f "Cargo.toml" ]]; then
    echo "❌ Not a Rust project (no Cargo.toml)"
    exit 1
  fi

  # Build release binary
  cargo build --release

  # Copy to target location
  mkdir -p "$(dirname "$STELLA_BIN")"
  cp target/release/stella "$STELLA_BIN"
  chmod +x "$STELLA_BIN"

  echo "✅ Stella built and installed to $STELLA_BIN"
}

# Main
main() {
  if [[ "$FORCE_BUILD" -eq 1 ]]; then
    echo "🔄 Force build requested..."
    build_stella
  elif ! check_stella; then
    echo "📦 Stella not found or not working, building..."
    build_stella
  else
    echo "✅ Stella already available at $STELLA_BIN"
    "$STELLA_BIN" --version
  fi

  # Export for subprocesses
  export STELLA_BIN
  export PATH="$(dirname "$STELLA_BIN"):$PATH"
}

# Run if executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main
fi
