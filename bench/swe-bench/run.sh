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
#   OXAGEN_PREWARMED=1 ./run.sh               # run pre-baked task images (see PREWARM.md)
#   OXAGEN_DIFFERENTIATED=1 ./run.sh          # full recommended recipe: best-of-N cross-family
#                                             # + full pipeline + auto-verify (see step 2c)
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

# 2c) Full differentiated config — the recommended maximum-accuracy recipe,
#     ported from bench/terminal-bench/run.sh so SWE-bench runs support it
#     natively. One flag turns on: persisted code graph + embeddings
#     (OXAGEN_INSTALL_DUCKDB=1), best-of-N cross-family candidates via
#     `oxagen solve` (3x anthropic/claude-fable-5 + 2x openai/gpt-5.5-pro by
#     default), the full evaluate→enhance→route→execute→judge→revise pipeline
#     per candidate, executed-evidence auto-verify before selection, a real
#     cross-vendor evaluator/advisor pair, deepest reasoning effort, and two
#     judge→revise rounds per candidate. Each knob keeps its ${VAR:-default}
#     form so any single piece can be overridden alongside
#     OXAGEN_DIFFERENTIATED=1 (e.g. OXAGEN_BEST_OF_N_CANDIDATES=3 to scale
#     cost down). See bench/terminal-bench/run.sh and oxagen_agent.py for the
#     full rationale of each knob.
if [ "${OXAGEN_DIFFERENTIATED:-}" = "1" ] && [ "$AGENT" = "oxagen" ]; then
  # Warn (don't silently unset) if any recipe knob is already exported — a
  # stale ambient override would silently win over the recipe default below,
  # making the run non-reproducible.
  for _diff_var in OXAGEN_LLM_FAST OXAGEN_LLM_BALANCED OXAGEN_LLM_PRECISE \
    OXAGEN_LLM_EVALUATOR OXAGEN_LLM_ADVISOR OXAGEN_MAX_REVISE_ROUNDS \
    OXAGEN_BEST_OF_N_CANDIDATES OXAGEN_BEST_OF_N_MODELS OXAGEN_BEST_OF_N_VERIFY; do
    if [ -n "${!_diff_var:-}" ]; then
      echo "==> WARNING: ${_diff_var}=${!_diff_var} is already set in your shell — OXAGEN_DIFFERENTIATED=1 will use it as-is rather than its own default. Run 'env -u ${_diff_var} ...' first if that's stale, not intentional." >&2
    fi
  done
  export OXAGEN_INSTALL_DUCKDB="${OXAGEN_INSTALL_DUCKDB:-1}"
  export OXAGEN_BEST_OF_N="${OXAGEN_BEST_OF_N:-1}"
  export OXAGEN_BEST_OF_N_CANDIDATES="${OXAGEN_BEST_OF_N_CANDIDATES:-5}"
  export OXAGEN_BEST_OF_N_MODELS="${OXAGEN_BEST_OF_N_MODELS:-anthropic/claude-fable-5,anthropic/claude-fable-5,anthropic/claude-fable-5,openai/gpt-5.5-pro,openai/gpt-5.5-pro}"
  export OXAGEN_BEST_OF_N_PIPELINE="${OXAGEN_BEST_OF_N_PIPELINE:-1}"
  export OXAGEN_BEST_OF_N_VERIFY="${OXAGEN_BEST_OF_N_VERIFY:-1}"
  export OXAGEN_LLM_FAST="${OXAGEN_LLM_FAST:-anthropic/claude-haiku-4-5}"
  export OXAGEN_LLM_EVALUATOR="${OXAGEN_LLM_EVALUATOR:-anthropic/claude-sonnet-5}"
  export OXAGEN_LLM_ADVISOR="${OXAGEN_LLM_ADVISOR:-openai/gpt-5.5-pro}"
  export OXAGEN_MAX_REVISE_ROUNDS="${OXAGEN_MAX_REVISE_ROUNDS:-2}"
  echo "==> OXAGEN_DIFFERENTIATED=1 — persisted code graph + embeddings, fast coordinator (${OXAGEN_LLM_FAST}), full pipeline per candidate (evaluator=${OXAGEN_LLM_EVALUATOR}, advisor=${OXAGEN_LLM_ADVISOR}, effort=${OXAGEN_EFFORT}, max-revise=${OXAGEN_MAX_REVISE_ROUNDS}), best-of-${OXAGEN_BEST_OF_N_CANDIDATES} (${OXAGEN_BEST_OF_N_MODELS}), verify-auto=${OXAGEN_BEST_OF_N_VERIFY}."
fi

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

# 3b) Pre-baked ("prewarmed") task images — see PREWARM.md. With
#     OXAGEN_PREWARMED=1 the run uses PrewarmedDockerEnvironment, which swaps
#     each trial onto its pre-baked image (Node 22 + oxagen bundle + rg baked
#     in) whenever the content-addressed tag exists locally, collapsing the
#     ~109s/task agent_setup to near-zero. Everything is best-effort: a
#     missing image or failed bake transparently falls back to Harbor's
#     normal build + the adapter's runtime install.
ENV_ARGS=()
if [ "${OXAGEN_PREWARMED:-}" = "1" ] && [ "$AGENT" = "oxagen" ]; then
  OXAGEN_BUNDLE_SHA256="$(shasum -a 256 "$OXAGEN_CLI_BUNDLE" | awk '{print $1}')"
  export OXAGEN_BUNDLE_SHA256
  ENV_ARGS=(--env oxagen_swe_bench.prewarm_env:PrewarmedDockerEnvironment)
  echo "==> OXAGEN_PREWARMED=1 — bundle sha256 $OXAGEN_BUNDLE_SHA256; trials use pre-baked images when present."
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

# 4b) Bake the prewarmed images for the resolved tasks (best-effort — a
#     prewarm failure must never abort the run; affected trials just fall
#     back to the normal build path). Needs the venv from step 4 (imports
#     harbor's environment_content_hash). With no TASK_IDS (full dataset)
#     the builder is skipped — pre-bake explicitly via
#     `uv run python prewarm.py <task-ids>`; already-baked images are still
#     picked up by PrewarmedDockerEnvironment either way.
if [ "${OXAGEN_PREWARMED:-}" = "1" ] && [ "$AGENT" = "oxagen" ]; then
  if [ -n "${TASK_IDS:-}" ]; then
    echo "==> Prewarming task images for: $TASK_IDS"
    # shellcheck disable=SC2086 — word-splitting TASK_IDS is intentional
    uv run python prewarm.py $TASK_IDS || \
      echo "==> Prewarm build failed (non-fatal); trials fall back to normal image builds." >&2
  else
    echo "==> OXAGEN_PREWARMED=1 with no TASK_IDS — skipping the prewarm builder;" \
         "already-baked images are still used."
  fi
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

# 7b) Agent-setup timeout headroom. With OXAGEN_INSTALL_DUCKDB=1 (the
#     differentiated recipe's default) agent setup runs `npm install duckdb`
#     (native module, slow under Rosetta emulation) plus the `oxagen init`
#     code-graph pre-build (tree-sitter parse of the whole task repo, 2–3 min
#     on large repos). The adapter's own per-step budgets (600s install +
#     300s init) exceed Harbor's default 360s *total* setup cap, which killed
#     pytest-dev__pytest-5631 in job optimal-bo3-20260707 with
#     AgentSetupTimeoutError before a single LLM call. Raise the cap to fit
#     the adapter's real budgets unless the caller already set one.
SETUP_TIMEOUT_ARGS=()
if [ "${OXAGEN_INSTALL_DUCKDB:-}" = "1" ] && [ "$AGENT" = "oxagen" ] \
   && [[ "${HARBOR_EXTRA:-}" != *"agent-setup-timeout"* ]]; then
  SETUP_TIMEOUT_ARGS=(--agent-setup-timeout-multiplier 4)
fi

# 8) Go.
echo "==> harbor run  dataset=$DATASET  agent=$AGENT  model=${MODEL_SLUG}  n=$N_CONCURRENT  attempts=$N_ATTEMPTS  jobs-dir=$JOBS_DIR  job-name=$JOB_NAME"
# The ${ARR[@]+"${ARR[@]}"} form is the bash-3.2-safe empty-array expansion:
# under `set -u`, a plain "${ARR[@]}" on an EMPTY array is an "unbound
# variable" error on macOS's /bin/bash 3.2 (fixed in bash 4.4). MODEL_ARGS
# (OXAGEN_ROUTE=1), TASK_ID_ARGS (full-dataset run), ENV_ARGS (no prewarm) and
# SETUP_TIMEOUT_ARGS (no duckdb) can each legitimately be empty.
exec uv run harbor run \
  -d "$DATASET" \
  ${AGENT_ARGS[@]+"${AGENT_ARGS[@]}"} \
  ${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"} \
  --n-concurrent "$N_CONCURRENT" \
  --n-attempts "$N_ATTEMPTS" \
  --jobs-dir "$JOBS_DIR" \
  --job-name "$JOB_NAME" \
  ${TASK_ID_ARGS[@]+"${TASK_ID_ARGS[@]}"} \
  ${ENV_ARGS[@]+"${ENV_ARGS[@]}"} \
  ${SETUP_TIMEOUT_ARGS[@]+"${SETUP_TIMEOUT_ARGS[@]}"} \
  ${HARBOR_EXTRA:-}
