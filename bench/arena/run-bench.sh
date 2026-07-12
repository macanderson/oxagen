#!/usr/bin/env bash
#
# Arena Benchmark Runner — Wrapper
#
# Ensures dependencies (especially Stella) are available before running benchmarks.
#
# Usage:
#   ./run-bench.sh [tsx run-benchmark.ts args...]
#
# Environment variables:
#   STELLA_SOURCE     — Path to stella-cli repo [default: ~/Workspaces/stella-cli]
#   STELLA_BIN        — Where to install stella binary [default: ~/.local/bin/stella]
#   FORCE_BUILD_STELLA — Set to 1 to force rebuild Stella

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source the Stella ensure script
if [[ -f "$SCRIPT_DIR/scripts/ensure-stella.sh" ]]; then
  # Run in subshell to export vars without affecting main shell
  source "$SCRIPT_DIR/scripts/ensure-stella.sh"
else
  echo "⚠️  ensure-stella.sh not found, skipping Stella setup"
fi

# Export STELLA_BIN for the TypeScript runner
export STELLA_BIN="${STELLA_BIN:-$HOME/.local/bin/stella}"

# Run the benchmark
echo "🚀 Running Arena benchmark..."
echo

exec tsx "$SCRIPT_DIR/scripts/run-benchmark.ts" "$@"
