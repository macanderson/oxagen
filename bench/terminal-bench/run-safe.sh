#!/usr/bin/env bash
# Hardened Terminal-Bench launcher — safe by construction after the 2026-07-08
# $186 orphan-spend incident. Guarantees:
#   1. TEARDOWN ON EVERY EXIT — a trap runs stop-bench.sh (docker rm -f of every
#      trial container) on normal exit, Ctrl-C, or SIGTERM, so no in-container
#      agent is ever orphaned to keep spending.
#   2. SPEND CEILING that STOPS CONTAINERS — the balance watchdog calls
#      stop-bench.sh (not `pkill harbor`, which leaves containers spending) once
#      cumulative spend since launch reaches SPEND_CAP.
#   3. STUCK-TASK REAPER — kills any single trial container running longer than
#      MAX_TASK_MIN, bounding worst-case per-task cost even if a task hangs.
#   4. DOCKER PREFLIGHT — refuses to start on an unhealthy daemon, and pins
#      N_CONCURRENT=1 on a low-memory Docker VM (2 heavy containers + the 3
#      datastores OOM-crash the 7.75GB VM — the root cause of the run instability).
#
# Env overrides: OXAGEN_MODEL_SLUG, OXAGEN_EFFORT, DATASET, N_CONCURRENT,
# OXAGEN_MAX_STEPS, SPEND_CAP, MAX_TASK_MIN, JOB_NAME, HARBOR_EXTRA.
set -euo pipefail
cd "$(dirname "$0")"
STOP="$(cd .. && pwd)/stop-bench.sh"

# ── 1. teardown trap ─────────────────────────────────────────────────────────
cleanup() { echo "==> run-safe: teardown"; "$STOP" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

# ── 4. Docker preflight ──────────────────────────────────────────────────────
if ! docker info >/dev/null 2>&1; then
  echo "run-safe: Docker daemon not healthy — start Docker Desktop and retry." >&2
  exit 1
fi
MEM_BYTES="$(docker info --format '{{.MemTotal}}' 2>/dev/null || echo 0)"
MEM_GB=$(awk "BEGIN{printf \"%.1f\", ${MEM_BYTES}/1073741824}")
N_CONCURRENT="${N_CONCURRENT:-1}"
# Under ~12GB VM, force concurrency 1 (heavy task containers + datastores OOM).
if awk "BEGIN{exit !(${MEM_GB} < 12)}" && [ "$N_CONCURRENT" -gt 1 ]; then
  echo "run-safe: Docker VM is ${MEM_GB}GB (<12) — forcing N_CONCURRENT=1 to avoid an OOM daemon crash." >&2
  N_CONCURRENT=1
fi
export N_CONCURRENT

export OXAGEN_MODEL_SLUG="${OXAGEN_MODEL_SLUG:-anthropic/claude-sonnet-5}"
export OXAGEN_EFFORT="${OXAGEN_EFFORT:-xhigh}"
export OXAGEN_CLI_DEBUG="${OXAGEN_CLI_DEBUG:-1}"
export DATASET="${DATASET:-terminal-bench@2.0}"
export OXAGEN_MAX_STEPS="${OXAGEN_MAX_STEPS:-60}"
export HARBOR_EXTRA="${HARBOR_EXTRA:---agent-setup-timeout-multiplier 4}"
JOB_NAME="${JOB_NAME:-tbench-$(date -u +%Y%m%d-%H%M%S)}"
export JOB_NAME
SPEND_CAP="${SPEND_CAP:-120}"
MAX_TASK_MIN="${MAX_TASK_MIN:-25}"
WLOG="watchdog-safe.log"

bal() { curl -s --max-time 20 https://ai-gateway.vercel.sh/v1/credits \
  -H "Authorization: Bearer ${AI_GATEWAY_API_KEY}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('balance','ERR'))" 2>/dev/null || echo ERR; }

START_BAL="$(bal)"
echo "$(date '+%H:%M:%S') START bal=$START_BAL cap=\$$SPEND_CAP conc=$N_CONCURRENT reaper=${MAX_TASK_MIN}min vm=${MEM_GB}GB" >> "$WLOG"

# ── 2+3. watchdog (spend ceiling) + reaper (stuck containers) ────────────────
(
  sleep 20
  while true; do
    # reaper: kill any non-datastore trial container older than MAX_TASK_MIN.
    now=$(python3 -c "import time;print(int(time.time()))")
    for id in $(docker ps --format '{{.ID}} {{.Names}}' 2>/dev/null | grep -vE " (oxagen-v2|confident_bohr)" | awk '{print $1}'); do
      started="$(docker inspect -f '{{.State.StartedAt}}' "$id" 2>/dev/null || echo '')"
      [ -z "$started" ] && continue
      age=$(python3 -c "
import sys,datetime,time
try:
    t=datetime.datetime.fromisoformat('$started'.replace('Z','+00:00')).timestamp()
    print(int(time.time()-t))
except Exception: print(0)" 2>/dev/null || echo 0)
      if [ "$age" -gt $((MAX_TASK_MIN*60)) ]; then
        echo "$(date '+%H:%M:%S') REAPER killing $id (age ${age}s > ${MAX_TASK_MIN}min)" >> "$WLOG"
        docker rm -f "$id" >/dev/null 2>&1 || true
      fi
    done
    # spend ceiling: stop CONTAINERS (via stop-bench), not just harbor.
    B="$(bal)"
    if [[ "$START_BAL" =~ ^[0-9.]+$ ]] && [[ "$B" =~ ^[0-9.]+$ ]]; then
      SPENT=$(python3 -c "print(f'{float('$START_BAL')-float('$B'):.2f}')")
      echo "$(date '+%H:%M:%S') bal=$B spent=$SPENT" >> "$WLOG"
      if python3 -c "import sys; sys.exit(0 if float('$SPENT') >= float('$SPEND_CAP') else 1)"; then
        echo "$(date '+%H:%M:%S') SPENT $SPENT >= cap $SPEND_CAP — FULL STOP (stop-bench)" >> "$WLOG"
        "$STOP" >> "$WLOG" 2>&1
        exit 2
      fi
    fi
    pgrep -f "\.venv/bin/harbor" >/dev/null 2>&1 || { echo "$(date '+%H:%M:%S') harbor gone" >> "$WLOG"; exit 0; }
    sleep 45
  done
) &

echo "==> run-safe: harbor run dataset=$DATASET model=$OXAGEN_MODEL_SLUG conc=$N_CONCURRENT job=$JOB_NAME cap=\$$SPEND_CAP"
caffeinate -i ./run.sh
# trap's cleanup() runs here on exit — tears down any surviving container.
