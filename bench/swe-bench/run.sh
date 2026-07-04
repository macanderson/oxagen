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
#   JOB_NAME=my-run ./run.sh                  # pin the results subdirectory name
#
# Every run writes results-$AGENT/<job-name>/bench-config.json — a secret-free
# snapshot of this run's config (see packages/telemetry/src/bench/ingest.ts),
# so `oxagen bench replay` / a backfill script can reconstruct the exact env.
#
# Prereqs: docker running; AI_GATEWAY_API_KEY exported when AGENT=oxagen
# (competitor agents may need their own provider keys — see their docs).
set -euo pipefail

cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"

AGENT="${AGENT:-oxagen}"
MODEL_SLUG="${OXAGEN_MODEL_SLUG:-anthropic/claude-sonnet-5}"
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

# 2b) Reasoning effort — prior runs sent NO effort config, so Anthropic models
#     ran at their own defaults (Sonnet 5: adaptive thinking at effort=high;
#     Opus 4.7/4.8: no thinking at all) and never at xhigh, the recommended
#     depth for hard agentic coding (and Claude Code's default). Lingxi V2.0's
#     81.2% used "High Reasoning". Default to xhigh; override per run.
export OXAGEN_EFFORT="${OXAGEN_EFFORT:-xhigh}"

# 3) Build the oxagen bundle only when actually benchmarking oxagen —
#    competitors don't need it.
if [ "$AGENT" = "oxagen" ]; then
  if [ -n "${OXAGEN_CLI_BUNDLE:-}" ]; then
    # A pre-built bundle was supplied (e.g. built in an isolated worktree so a
    # parallel session switching branches in the main tree can't poison it).
    echo "==> Using pre-built Oxagen bundle: $OXAGEN_CLI_BUNDLE"
  else
    echo "==> Building Oxagen standalone bundle…"
    ( cd "$REPO_ROOT" && pnpm --filter @oxagen/cli bundle )
    export OXAGEN_CLI_BUNDLE="$REPO_ROOT/apps/cli/dist-standalone/oxagen.mjs"
  fi
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

# 7) Snapshot the resolved run config into the results dir *before* harbor
#    runs, so the run is self-describing for `oxagen bench replay` even if
#    the job itself is later killed (credit wall, timeout). Harbor's own
#    --job-name defaults to a timestamp it picks internally; we pick it here
#    instead (same format) so we know the exact directory to write into.
#    Pre-creating that directory is safe — Harbor's "resume" check
#    (job.py _maybe_init_existing_job) only looks for its OWN config.json/
#    lock.json, not for other files, so an extra bench-config.json alongside
#    doesn't trip it.
JOB_NAME="${JOB_NAME:-$(date -u +%Y-%m-%d__%H-%M-%S)}"
RUN_DIR="$JOBS_DIR/$JOB_NAME"
mkdir -p "$RUN_DIR"
BENCH_GIT_SHA="$(cd "$REPO_ROOT" && git rev-parse HEAD 2>/dev/null || echo "")"
python3 - "$RUN_DIR/bench-config.json" "$BENCH_GIT_SHA" "$DATASET" "$N_CONCURRENT" "${TASK_IDS:-}" <<'PYEOF'
# Writes bench-config.json: {gitSha, config, conditions} — the shape
# packages/telemetry/src/bench/ingest.ts's BenchConfigSnapshot expects.
# `config` is every OXAGEN_* env var actually forwarded into the trial
# container (see oxagen_agent.py _forwarded_env()) — never a secret, since
# forwarding is scoped to that prefix and AI_GATEWAY_API_KEY/ANTHROPIC_API_KEY/
# etc. never match it — plus the run.sh-level DATASET/N_CONCURRENT/TASK_IDS.
import json
import os
import platform
import sys

out_path, git_sha, dataset, n_concurrent, task_ids = sys.argv[1:6]

config = {k: v for k, v in os.environ.items() if k.startswith("OXAGEN_") and k != "OXAGEN_CLI_BUNDLE"}
config["DATASET"] = dataset
config["N_CONCURRENT"] = n_concurrent
if task_ids:
    config["TASK_IDS"] = task_ids

snapshot = {
    "gitSha": git_sha,
    "config": config,
    "conditions": {"host": platform.node(), "os": sys.platform, "cpu": platform.machine()},
}
with open(out_path, "w") as f:
    json.dump(snapshot, f, indent=2, sort_keys=True)
    f.write("\n")
print(f"==> Wrote bench replay config snapshot: {out_path}")
PYEOF

# 8) Go.
echo "==> harbor run  dataset=$DATASET  agent=$AGENT  model=${MODEL_SLUG}  n=$N_CONCURRENT  attempts=$N_ATTEMPTS  jobs-dir=$JOBS_DIR  job-name=$JOB_NAME"
exec uv run harbor run \
  -d "$DATASET" \
  "${AGENT_ARGS[@]}" \
  "${MODEL_ARGS[@]}" \
  --n-concurrent "$N_CONCURRENT" \
  --n-attempts "$N_ATTEMPTS" \
  --jobs-dir "$JOBS_DIR" \
  --job-name "$JOB_NAME" \
  "${TASK_ID_ARGS[@]}" \
  ${HARBOR_EXTRA:-}
