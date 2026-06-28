#!/usr/bin/env bash
#
# Run Terminal-Bench (Harbor) against the Oxagen coding agent.
#
# Usage:
#   ./run.sh                                  # default model, 4 parallel, full TB
#   OXAGEN_MODEL_SLUG=anthropic/claude-opus-4.8 ./run.sh
#   OXAGEN_ROUTE=1 ./run.sh                   # let Oxagen's cost-aware router pick
#   N_CONCURRENT=8 N_ATTEMPTS=3 ./run.sh
#   DATASET="terminal-bench@2.0" ./run.sh
#   HARBOR_EXTRA="--task-id hello-world" ./run.sh   # smoke-test a single task
#
# Prereqs: docker running, uv installed, AI_GATEWAY_API_KEY exported.
set -euo pipefail

cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"

MODEL_SLUG="${OXAGEN_MODEL_SLUG:-anthropic/claude-sonnet-4.5}"
DATASET="${DATASET:-terminal-bench@2.0}"
N_CONCURRENT="${N_CONCURRENT:-4}"
N_ATTEMPTS="${N_ATTEMPTS:-1}"
JOBS_DIR="${JOBS_DIR:-./oxagen-tbench-results}"

# 1) Preconditions.
if [ -z "${AI_GATEWAY_API_KEY:-}" ]; then
  echo "Error: AI_GATEWAY_API_KEY must be set (Oxagen routes LLM calls through the AI Gateway)." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Error: Docker is not running." >&2
  exit 1
fi

# 2) Build the self-contained Oxagen CLI bundle that gets uploaded into each task container.
echo "==> Building Oxagen standalone bundle…"
( cd "$REPO_ROOT" && pnpm --filter @oxagen/cli bundle )
export OXAGEN_CLI_BUNDLE="$REPO_ROOT/apps/cli/dist-standalone/oxagen.mjs"
[ -f "$OXAGEN_CLI_BUNDLE" ] || { echo "Bundle not found at $OXAGEN_CLI_BUNDLE" >&2; exit 1; }

# 3) Python env + adapter (editable so Harbor imports it by path).
if [ ! -d .venv ]; then
  echo "==> Creating venv + installing harbor and adapter…"
  uv venv --python 3.13          # harbor requires Python >=3.13
  # shellcheck disable=SC1091
  source .venv/bin/activate
  uv pip install -e ".[dev]"
else
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

# 4) Pin a model, or let Oxagen route when OXAGEN_ROUTE is set.
MODEL_ARGS=(-m "$MODEL_SLUG")
if [ "${OXAGEN_ROUTE:-}" = "1" ]; then
  echo "==> OXAGEN_ROUTE=1 — Oxagen's cost-aware router will choose the model per task."
  MODEL_ARGS=()
fi

# 5) Go.
echo "==> harbor run  dataset=$DATASET  agent=oxagen  model=${MODEL_SLUG}  n=$N_CONCURRENT  attempts=$N_ATTEMPTS"
exec uv run harbor run \
  -d "$DATASET" \
  --agent-import-path oxagen_terminal_bench:OxagenAgent \
  "${MODEL_ARGS[@]}" \
  --n-concurrent "$N_CONCURRENT" \
  --n-attempts "$N_ATTEMPTS" \
  --jobs-dir "$JOBS_DIR" \
  ${HARBOR_EXTRA:-}
