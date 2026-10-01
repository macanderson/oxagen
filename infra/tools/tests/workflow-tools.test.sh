#!/usr/bin/env bash
#
# Keeps workflow shell steps to commands GitHub's hosted runners carry.
#
# infra.yml's discover step piped its changed paths to `rg`, which
# ubuntu-latest does not install. Every run printed "rg: command not found",
# the node-tools check read false, and from 2026-09-29 (0e1b29a215) until
# 2026-10-01 no push to main published a change under infra/tools/node/. A
# step that needs a pattern match uses grep.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)

# `rg` at the start of a command: line start, after a pipe, `;`, `&`, `(`, or
# `$(`. Comment lines are skipped.
hits=$(grep -nE '(^|[|;&(]|\$\()[[:space:]]*rg[[:space:]]' "$ROOT"/.github/workflows/*.yml \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)

if [[ -n $hits ]]; then
  echo "FAIL: GitHub's hosted runners have no ripgrep. Use grep in these workflow steps:" >&2
  echo "$hits" >&2
  exit 1
fi
echo "workflow-tools: no workflow step calls rg"
