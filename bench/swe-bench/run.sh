#!/usr/bin/env bash
#
# Run SWE-bench (Harbor) against the Oxagen coding agent, or any Harbor
# built-in competitor agent, on the same dataset.
#
# Usage:
#   AGENT=oxagen ./run.sh                     # Oxagen, default model, full Verified
#   OXAGEN_MODEL_SLUG=anthropic/claude-opus-4.8 ./run.sh
#   OXAGEN_ROUTE=1 ./run.sh                   # let Oxagen's cost-aware router pick
#   AGENT=claude-code ./run.sh                # Harbor built-in competitor
#   DATASET=swe-bench/swe-smith ./run.sh      # a different Harbor dataset slug
#   TASK_IDS="django__django-11099" ./run.sh  # smoke-test one instance
#   HARBOR_EXTRA="--include-task-name *django__django-11099" N_CONCURRENT=1 ./run.sh
#
# Prereqs: docker running; AI_GATEWAY_API_KEY exported when AGENT=oxagen
# (competitor agents may need their own provider keys — see their docs).
set -euo pipefail

cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"

AGENT="${AGENT:-oxagen}"
MODEL_SLUG="${OXAGEN_MODEL_SLUG:-anthropic/claude-sonnet-4.5}"
# Default to SWE-bench Verified (the OpenAI-curated, 500-task human-filtered
# subset of the original SWE-bench — see README "Fairness & methodology"). This
# is the exact namespaced slug published on the Harbor Hub
# (https://hub.harborframework.com/datasets). Override DATASET with any other
# Harbor dataset slug listed there (e.g. swe-bench/swe-smith, scale-ai/swe-bench-pro).
DATASET="${DATASET:-swe-bench/swe-bench-verified}"
N_CONCURRENT="${N_CONCURRENT:-4}"
N_ATTEMPTS="${N_ATTEMPTS:-1}"
JOBS_DIR="${JOBS_DIR:-./results-$AGENT}"

# TASK_IDS is a convenience alias for "--include-task-name <id>" (repeat for
# multiple). Harbor fnmatch-globs each pattern against the dataset's task
# names (harbor/models/job/config.py: _filter_task_ids), and package task
# names are namespaced by their source (e.g. "swe-bench/django__django-11099"
# for -d swe-bench/swe-bench-verified) — so a leading "*" matches the bare
# instance id regardless of the exact namespace prefix.
# HARBOR_EXTRA is raw passthrough for anything else Harbor supports.
TASK_ID_ARGS=()
if [ -n "${TASK_IDS:-}" ]; then
  for t in $TASK_IDS; do
    TASK_ID_ARGS+=(--include-task-name "*$t")
  done
fi

# 1) Preconditions.
if ! docker info >/dev/null 2>&1; then
  echo "Error: Docker is not running." >&2
  exit 1
fi
if [ "$AGENT" = "oxagen" ] && [ -z "${AI_GATEWAY_API_KEY:-}" ]; then
  echo "Error: AI_GATEWAY_API_KEY must be set (Oxagen routes LLM calls through the AI Gateway)." >&2
  exit 1
fi
if [ "$AGENT" != "oxagen" ]; then
  echo "==> AGENT=$AGENT — a Harbor built-in competitor. It may need its own" \
       "provider API key (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY) — see that" \
       "agent's docs. AI_GATEWAY_API_KEY is not required for this run."
fi

# 2) Headless session bypass — the oxagen CLI normally requires a logged-in
#    session (requireSession() in apps/cli/src/lib/session.ts); benchmark
#    containers never log in, so this flag makes it return a synthetic
#    session instead of exit(1). Harmless for competitor agents (unused).
export OXAGEN_ALLOW_NO_SESSION=1

# 3) Build the oxagen bundle only when actually benchmarking oxagen —
#    competitors don't need it.
if [ "$AGENT" = "oxagen" ]; then
  echo "==> Building Oxagen standalone bundle…"
  ( cd "$REPO_ROOT" && pnpm --filter @oxagen/cli bundle )
  export OXAGEN_CLI_BUNDLE="$REPO_ROOT/apps/cli/dist-standalone/oxagen.mjs"
  [ -f "$OXAGEN_CLI_BUNDLE" ] || { echo "Bundle not found at $OXAGEN_CLI_BUNDLE" >&2; exit 1; }
fi

# 4) Python env + adapter (editable so Harbor imports it by path; also pulls
#    in the sibling oxagen-terminal-bench package for the shared OxagenAgent).
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

# 5) Model / agent selection.
#    AGENT=oxagen uses the external-agent import path so Harbor loads our
#    adapter; any other value is passed straight through as a Harbor
#    built-in agent name (claude-code, codex, aider, openhands, gemini-cli,
#    swe-agent, oracle, nop, ...).
AGENT_ARGS=()
if [ "$AGENT" = "oxagen" ]; then
  # --agent accepts either a built-in agent name or a custom import path
  # (module.path:ClassName) — the same flag Harbor uses for both. The old
  # dedicated --agent-import-path flag still works but is a deprecated,
  # hidden alias (harbor/cli/trials.py: warn_deprecated_flag) that prints a
  # warning on every run and may be removed in a future Harbor release.
  AGENT_ARGS=(--agent oxagen_swe_bench:OxagenAgent)
else
  AGENT_ARGS=(--agent "$AGENT")
fi

MODEL_ARGS=(-m "$MODEL_SLUG")
if [ "${OXAGEN_ROUTE:-}" = "1" ] && [ "$AGENT" = "oxagen" ]; then
  echo "==> OXAGEN_ROUTE=1 — Oxagen's cost-aware router will choose the model per task."
  MODEL_ARGS=()
fi

# 6) Warm / self-improvement mode (oxagen only — see terminal-bench README).
if [ "${OXAGEN_WARM:-}" = "1" ] && [ "$AGENT" = "oxagen" ]; then
  export OXAGEN_INSTALL_DUCKDB=1
  if [ -z "${OXAGEN_WARM_MEMORY_DIR:-}" ]; then
    OXAGEN_WARM_MEMORY_DIR="$(pwd)/warm-memory"
    export OXAGEN_WARM_MEMORY_DIR
  fi
  mkdir -p "$OXAGEN_WARM_MEMORY_DIR"
  echo "==> OXAGEN_WARM=1 — DuckDB enabled; memory persisted across trials."
  echo "==>   Warm memory dir: $OXAGEN_WARM_MEMORY_DIR"
fi

# OXAGEN_NO_PIPELINE=1 (skip prompt-eval/context-injection/completeness-judge)
# passes straight through to the adapter via forwarded OXAGEN_* env — nothing
# to do here.

# 7) Go.
echo "==> harbor run  dataset=$DATASET  agent=$AGENT  model=${MODEL_SLUG}  n=$N_CONCURRENT  attempts=$N_ATTEMPTS  jobs-dir=$JOBS_DIR"
exec uv run harbor run \
  -d "$DATASET" \
  "${AGENT_ARGS[@]}" \
  "${MODEL_ARGS[@]}" \
  --n-concurrent "$N_CONCURRENT" \
  --n-attempts "$N_ATTEMPTS" \
  --jobs-dir "$JOBS_DIR" \
  "${TASK_ID_ARGS[@]}" \
  ${HARBOR_EXTRA:-}
