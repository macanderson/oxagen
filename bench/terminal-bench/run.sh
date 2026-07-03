#!/usr/bin/env bash
#
# Run Terminal-Bench (Harbor) against the Oxagen coding agent.
#
# Usage:
#   ./run.sh                                  # default model, 4 parallel, full TB
#   OXAGEN_MODEL_SLUG=anthropic/claude-opus-4.8 ./run.sh
#   OXAGEN_ROUTE=1 ./run.sh                   # let Oxagen's cost-aware router pick
#   OXAGEN_BEST_OF_N=1 OXAGEN_BEST_OF_N_CANDIDATES=3 ./run.sh   # best-of-N (`oxagen solve`) per task
#   OXAGEN_DIFFERENTIATED=1 ./run.sh          # everything at once — see "Full differentiated config" below
#   N_CONCURRENT=8 N_ATTEMPTS=3 ./run.sh
#   DATASET="terminal-bench@2.0" ./run.sh
#   HARBOR_EXTRA="--include-task-name *hello-world" ./run.sh   # smoke-test a single task
#
# Prereqs: docker running, uv installed, AI_GATEWAY_API_KEY exported.
set -euo pipefail

cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"

MODEL_SLUG="${OXAGEN_MODEL_SLUG:-anthropic/claude-sonnet-5}"
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

# 4a) Full differentiated config: engage everything that makes Oxagen unique in
# ONE flag — persisted local code graph + embeddings, a fast gateway-tier
# coordinator for the pipeline's evaluate/route stage, and best-of-N. Expands
# to the individual flags below via bash's ${VAR:=default} (only fills in a
# var that isn't already set, so any piece can still be overridden
# individually alongside OXAGEN_DIFFERENTIATED=1).
#
#   OXAGEN_DIFFERENTIATED=1 ./run.sh
#   OXAGEN_DIFFERENTIATED=1 OXAGEN_BEST_OF_N_CANDIDATES=5 ./run.sh   # override just N
#
# init (local code graph) is ALREADY on by default — see OXAGEN_SKIP_INIT
# (this recipe leaves it unset). The one piece that's off by default and
# actually required for "local code graph" to mean anything is
# OXAGEN_INSTALL_DUCKDB: without it, install()'s `oxagen init` pre-build still
# runs, but builds an IN-MEMORY graph that's discarded the moment that process
# exits — the later `run()` invocation (a separate process) starts cold either
# way. OXAGEN_INSTALL_DUCKDB=1 is what makes the pre-build persist to disk so
# run() actually reuses it.
#
# OXAGEN_BEST_OF_N_PIPELINE=1 (dedicated gate, independent of
# OXAGEN_NO_PIPELINE, which only affects the one-shot baseline) makes every
# `solve` candidate run the FULL evaluate→enhance→route→execute→judge→revise
# pipeline — each candidate self-judges/revises BEFORE the comparative
# selector ever compares them. The double-judge is intentional (money no
# object, per the user's call): strongest-candidate-first, then compare.
# Meaningfully more expensive than a single per-candidate judge would suggest
# — roughly N extra judge-class calls plus N evaluate/enhance calls on top of
# what bare candidates already cost. See "Best-of-N mode" in the README.
#
# NOT part of this recipe: the on-device local coordinator
# (`runtime.coordinator: "on-device"` / `/coordinator local`). It's wired only
# into the interactive REPL — unreachable from the headless `--mode bypass` /
# `solve` paths this adapter uses — and even if it were reachable, the
# container never installs its native runtime dependency (node-llama-cpp) and
# a cold multi-GB CPU-only weight download+load would not fit a single task's
# time budget. It is a local-dev-only feature; the fast GATEWAY tier
# (OXAGEN_LLM_FAST) is the container-viable equivalent and is what "fast
# coordinator" means below.
#
# N=5, cross-family by default here (solve's own bare default is 3, same
# family): 3x anthropic/claude-fable-5 + 2x openai/gpt-5.5-pro via
# OXAGEN_BEST_OF_N_MODELS (forwarded straight to `solve --models`; see
# oxagen_agent.py's _best_of_n_models()). OXAGEN_BEST_OF_N_CANDIDATES still
# controls N alone — kept independent so overriding just the mix, or just N,
# works without touching the other.
#
# OXAGEN_BEST_OF_N_VERIFY=1 (verifyAuto, dedicated gate) unions the test/lint/
# build commands every candidate actually ran during its own turn and re-runs
# that whole union in EVERY surviving candidate's worktree before selection —
# so the comparative selector's "tests pass" signal is real, executed
# evidence across the whole pool, not just whatever subset of tests each
# candidate happened to run on its own. See BestOfNOptions.verifyAuto in
# apps/cli/src/agent/best-of-n.ts.
#
# OXAGEN_LLM_EVALUATOR / OXAGEN_LLM_ADVISOR pin the pipeline's prompt-
# evaluator and completeness-judge advisor (used when OXAGEN_BEST_OF_N_PIPELINE
# =1 puts each candidate through the full pipeline) to real, cross-vendor
# models instead of the cheaper local-heuristic/default-Fable fallbacks.
# OXAGEN_EFFORT=xhigh requests the deepest available reasoning effort for
# every candidate turn. OXAGEN_MAX_REVISE_ROUNDS=2 gives each candidate two
# judge→revise rounds under OXAGEN_BEST_OF_N_PIPELINE=1, so a candidate gets a
# real chance to fix what its own judge flags before the comparative selector
# ever sees the (already twice-revised) pool.
if [ "${OXAGEN_DIFFERENTIATED:-}" = "1" ]; then
  # Warn (don't silently unset) if any of this recipe's env knobs are already
  # exported from an earlier session — a stale override in the ambient shell
  # would silently win over the recipe's own default via the ${VAR:-default}
  # defaulting below, making the run non-reproducible.
  for _diff_var in OXAGEN_LLM_FAST OXAGEN_LLM_BALANCED OXAGEN_LLM_PRECISE \
    OXAGEN_LLM_EVALUATOR OXAGEN_LLM_ADVISOR OXAGEN_EFFORT OXAGEN_MAX_REVISE_ROUNDS \
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
  export OXAGEN_EFFORT="${OXAGEN_EFFORT:-xhigh}"
  export OXAGEN_MAX_REVISE_ROUNDS="${OXAGEN_MAX_REVISE_ROUNDS:-2}"
  echo "==> OXAGEN_DIFFERENTIATED=1 — persisted code graph + embeddings, fast coordinator (${OXAGEN_LLM_FAST}), full pipeline per candidate (evaluator=${OXAGEN_LLM_EVALUATOR}, advisor=${OXAGEN_LLM_ADVISOR}, effort=${OXAGEN_EFFORT}, max-revise=${OXAGEN_MAX_REVISE_ROUNDS}), best-of-${OXAGEN_BEST_OF_N_CANDIDATES} (${OXAGEN_BEST_OF_N_MODELS}), verify-auto=${OXAGEN_BEST_OF_N_VERIFY}."
fi

# 4b) Best-of-N: run Oxagen's `solve` differentiator (N independent candidates,
# comparative judge, winner's diff applied) instead of a single one-shot turn.
# Read directly by the adapter (oxagen_agent.py); nothing to compute here —
# just surface it in the console output like the other mode flags below.
if [ "${OXAGEN_BEST_OF_N:-}" = "1" ]; then
  _pipeline_note="bare (set OXAGEN_BEST_OF_N_PIPELINE=1 for full evaluate/enhance/judge per candidate)"
  [ "${OXAGEN_BEST_OF_N_PIPELINE:-}" = "1" ] && _pipeline_note="full pipeline per candidate"
  echo "==> OXAGEN_BEST_OF_N=1 — running oxagen solve --candidates ${OXAGEN_BEST_OF_N_CANDIDATES:-3} per task (${_pipeline_note})."
fi

# 4c) Warm / self-improvement mode.
#
# OXAGEN_WARM=1 enables cross-trial memory persistence so that task N's lessons
# are available to task N+1 — the self-improvement loop from eval-runbook §7.
#
# What it does:
#   - Sets OXAGEN_INSTALL_DUCKDB=1 so the DuckDB-backed context engine (episodic
#     memory, fleet memory, trace store) is live in every container.
#   - Sets OXAGEN_WARM_MEMORY_DIR (default: ./warm-memory) as the host-side dir
#     where the adapter persists ~/.config/oxagen between trials via
#     environment.upload_dir / environment.download_dir.
#   - The adapter (oxagen_agent.py) forwards HOME=<in-container path> so that
#     Oxagen writes all memory under that path, then downloads it to
#     OXAGEN_WARM_MEMORY_DIR after each trial and uploads it at the start of the
#     next trial's install().
#
# Usage:
#   OXAGEN_WARM=1 ./run.sh
#   OXAGEN_WARM=1 OXAGEN_WARM_MEMORY_DIR=./my-warm-dir ./run.sh
#
# To run a cold comparison side-by-side, run once without OXAGEN_WARM (the
# default: every trial starts from a fresh in-container HOME) and once with it.
# A rising pass rate across the warm sequence vs. the cold baseline is the
# learning signal (H4 monotonic clause); wipe OXAGEN_WARM_MEMORY_DIR and re-run
# to confirm the causal clause (H4 causal — performance should revert).
if [ "${OXAGEN_WARM:-}" = "1" ]; then
  export OXAGEN_INSTALL_DUCKDB=1
  if [ -z "${OXAGEN_WARM_MEMORY_DIR:-}" ]; then
    OXAGEN_WARM_MEMORY_DIR="$(pwd)/warm-memory"
    export OXAGEN_WARM_MEMORY_DIR
  fi
  mkdir -p "$OXAGEN_WARM_MEMORY_DIR"
  echo "==> OXAGEN_WARM=1 — DuckDB enabled; memory persisted across trials."
  echo "==>   Warm memory dir: $OXAGEN_WARM_MEMORY_DIR"
  echo "==>   (Upload into each trial container on install; download back after run.)"
fi

# 5) Go.
echo "==> harbor run  dataset=$DATASET  agent=oxagen  model=${MODEL_SLUG}  n=$N_CONCURRENT  attempts=$N_ATTEMPTS"
exec uv run harbor run \
  -d "$DATASET" \
  --agent oxagen_terminal_bench:OxagenAgent \
  "${MODEL_ARGS[@]}" \
  --n-concurrent "$N_CONCURRENT" \
  --n-attempts "$N_ATTEMPTS" \
  --jobs-dir "$JOBS_DIR" \
  ${HARBOR_EXTRA:-}
