#!/usr/bin/env bash
#
# Multi-vendor SWE-bench comparison: run Oxagen plus a configurable list of
# Harbor built-in competitor agents, sequentially, on the SAME dataset and
# the SAME base model, then emit a normalized swe-bench.eval.json for each
# run into the shared results/ dir the dashboard reads from.
#
# Fairness note (see README "Fairness & methodology" for the full argument):
# holding the dataset, harness, and base model constant is what makes this a
# fair *scaffold* comparison — it isolates the effect of Oxagen's agent
# scaffold (planning, tool use, context engineering) from the underlying
# model. It is NOT the same claim as a third-party leaderboard entry, which
# may use a different model, prompt, or task subset. Report both honestly;
# don't conflate them.
#
# Usage:
#   ./compare.sh                                     # oxagen + claude-code + codex + aider
#   COMPETITORS="claude-code codex" ./compare.sh
#   OXAGEN_MODEL_SLUG=anthropic/claude-opus-4.8 ./compare.sh
#   TASK_IDS="django__django-11099" N_CONCURRENT=1 ./compare.sh   # cheap smoke run
set -euo pipefail

cd "$(dirname "$0")"

COMPETITORS="${COMPETITORS:-claude-code codex aider}"
MODEL_SLUG="${OXAGEN_MODEL_SLUG:-anthropic/claude-sonnet-4.5}"
DATASET="${DATASET:-swe-bench/swe-bench-verified}"
RESULTS_DIR="./results"
mkdir -p "$RESULTS_DIR"

AGENTS=(oxagen)
# shellcheck disable=SC2206
AGENTS+=($COMPETITORS)

declare -a SUMMARY_ROWS=()

run_and_emit() {
  local agent="$1"
  local jobs_dir="./results-$agent"

  echo
  echo "================================================================"
  echo "  Running agent=$agent  dataset=$DATASET  model=$MODEL_SLUG"
  echo "================================================================"

  AGENT="$agent" OXAGEN_MODEL_SLUG="$MODEL_SLUG" DATASET="$DATASET" JOBS_DIR="$jobs_dir" \
    ./run.sh

  local newest
  newest="$(find "$jobs_dir" -mindepth 1 -maxdepth 1 -type d -exec test -e '{}/result.json' \; -print 2>/dev/null | sort | tail -n1)"
  if [ -z "$newest" ]; then
    echo "  [warn] no completed run directory found under $jobs_dir for agent=$agent — skipping emit" >&2
    return
  fi

  echo "==> Emitting normalized eval JSON for $newest"
  JOBS_DIR="$jobs_dir" python3 emit_eval_json.py "$newest"

  local emitted="$newest/swe-bench.eval.json"
  if [ -f "$emitted" ]; then
    local resolved
    resolved="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['run']['resolved_rate'])" "$emitted")"
    SUMMARY_ROWS+=("$agent	$resolved	$emitted")
  fi
}

for agent in "${AGENTS[@]}"; do
  run_and_emit "$agent"
done

echo
echo "================================================================"
echo "  Summary — resolved-rate per agent (dataset=$DATASET, model=$MODEL_SLUG)"
echo "================================================================"
printf "%-16s %-14s %s\n" "AGENT" "RESOLVED_RATE" "EVAL_JSON"
for row in "${SUMMARY_ROWS[@]}"; do
  IFS=$'\t' read -r agent resolved path <<< "$row"
  printf "%-16s %-14s %s\n" "$agent" "$resolved" "$path"
done
echo
echo "Normalized results also copied to: $RESULTS_DIR/"
echo "Ingest all of them with:"
echo "    pnpm eval:ingest bench/swe-bench/results/*.eval.json"
