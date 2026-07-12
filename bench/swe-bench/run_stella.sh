#!/usr/bin/env bash
#
# Run SWE-bench (Harbor) against the Stella (Rust) coding agent.
#
# Usage:
#   ./run_stella.sh                           # Stella, default model, full Verified
#   STELLA_MODEL=zai/glm-5.2 ./run_stella.sh
#   TASK_IDS="django__django-11099" ./run_stella.sh  # smoke-test one instance
#   STELLA_BUDGET=5.0 ./run_stella.sh        # per-task USD cap
#
# Prereqs: docker running; STELLA_API_KEY exported (or provider-specific key)
#
# Every run writes results-stella/<job-name>/bench-config.json — a secret-free
# snapshot of this run's config.
#
set -euo pipefail

cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"

AGENT="stella"
MODEL_SLUG="${STELLA_MODEL:-anthropic/claude-sonnet-5}"
DATASET="${DATASET:-swe-bench/swe-bench-verified}"
N_CONCURRENT="${N_CONCURRENT:-4}"
N_ATTEMPTS="${N_ATTEMPTS:-1}"
JOBS_DIR="${JOBS_DIR:-./results-stella}"

# TASK_IDS is a convenience alias for "--include-task-name <id>".
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

# 2) Build stella if not already built.
if [ -n "${STELLA_BINARY:-}" ]; then
  echo "==> Using pre-built Stella binary: $STELLA_BINARY"
else
  echo "==> Building Stella (Rust CLI)…"
  ( cd "$REPO_ROOT/crates" && cargo build --release -p oxagen-cli )
  STELLA_BINARY="$REPO_ROOT/crates/target/release/stella"
fi
[ -f "$STELLA_BINARY" ] || { echo "Binary not found at $STELLA_BINARY" >&2; exit 1; }

# 3) Python env + adapter.
if [ ! -d .venv ]; then
  echo "==> Creating venv + installing harbor and adapter…"
  uv venv --python 3.13
  # shellcheck disable=SC1091
  source .venv/bin/activate
  uv pip install -e ".[dev]"
else
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

# 4) Snapshot config before run.
JOB_NAME="${JOB_NAME:-$(date -u +%Y-%m-%d__%H-%M-%S)}"
RUN_DIR="$JOBS_DIR/$JOB_NAME"
mkdir -p "$RUN_DIR"
BENCH_GIT_SHA="$(cd "$REPO_ROOT" && git rev-parse HEAD 2>/dev/null || echo "")"
STELLA_VERSION="$("$STELLA_BINARY" --version 2>/dev/null || echo "unknown")"
python3 - "$RUN_DIR/bench-config.json" "$BENCH_GIT_SHA" "$STELLA_VERSION" "$DATASET" "$N_CONCURRENT" "${TASK_IDS:-}" <<'PYEOF'
import json
import os
import sys

out_path, git_sha, stella_version, dataset, n_concurrent, task_ids = sys.argv[1:6]

config = {k: v for k, v in os.environ.items() if k.startswith("STELLA_")}
config["DATASET"] = dataset
config["N_CONCURRENT"] = n_concurrent
if task_ids:
    config["TASK_IDS"] = task_ids

snapshot = {
    "gitSha": git_sha,
    "stellaVersion": stella_version,
    "config": config,
}
with open(out_path, "w") as f:
    json.dump(snapshot, f, indent=2)
    f.write("\n")
print(f"==> Wrote bench replay config: {out_path}")
PYEOF

# 5) Go.
echo "==> harbor run  dataset=$DATASET  agent=$AGENT  model=${MODEL_SLUG}  n=$N_CONCURRENT  attempts=$N_ATTEMPTS  jobs-dir=$JOBS_DIR"
exec uv run harbor run \
  -d "$DATASET" \
  --agent oxagen_swe_bench:StellaAgent \
  -m "$MODEL_SLUG" \
  --n-concurrent "$N_CONCURRENT" \
  --n-attempts "$N_ATTEMPTS" \
  --jobs-dir "$JOBS_DIR" \
  --job-name "$JOB_NAME" \
  ${TASK_ID_ARGS[@]+"${TASK_ID_ARGS[@]}"} \
  ${HARBOR_EXTRA:-}
