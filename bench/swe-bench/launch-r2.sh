#!/usr/bin/env bash
# Detached launcher for the optimal-bo3-r2 SWE-bench job + budget watchdog.
# Runs under setsid/nohup so it survives the invoking session's cleanup.
# Log: bench/swe-bench/launch-r2.log   Watchdog log: watchdog-r2.log
set -euo pipefail
cd "$(dirname "$0")"

export OXAGEN_CLI_BUNDLE=/Users/macanderson/Workspaces/oxagen-bench-20260707/apps/cli/dist-standalone/oxagen.mjs
export TASK_IDS="sympy__sympy-13031 matplotlib__matplotlib-13989 psf__requests-2317 pytest-dev__pytest-5631"
export OXAGEN_DIFFERENTIATED=1
export OXAGEN_BEST_OF_N_CANDIDATES=3
export OXAGEN_BEST_OF_N_MODELS="anthropic/claude-fable-5,anthropic/claude-fable-5,openai/gpt-5.5-pro"
export OXAGEN_PREWARMED=1
export N_CONCURRENT=2
export JOB_NAME=optimal-bo3-r2

# Budget watchdog: kill harbor if gateway balance drops below $12.
(
  for _ in $(seq 1 80); do
    sleep 180
    BAL=$(curl -s --max-time 20 https://ai-gateway.vercel.sh/v1/credits \
          -H "Authorization: Bearer ${AI_GATEWAY_API_KEY}" \
          | python3 -c "import json,sys; print(json.load(sys.stdin).get('balance','ERR'))" 2>/dev/null || echo ERR)
    echo "$(date '+%H:%M:%S') balance=$BAL" >> watchdog-r2.log
    pgrep -f ".venv/bin/harbor" >/dev/null 2>&1 || { echo "harbor gone; watchdog exit" >> watchdog-r2.log; exit 0; }
    if [[ "$BAL" =~ ^[0-9.]+$ ]] && python3 -c "import sys; sys.exit(0 if float('$BAL') < 12 else 1)"; then
      echo "$(date '+%H:%M:%S') BALANCE $BAL < 12 — killing harbor" >> watchdog-r2.log
      pkill -f ".venv/bin/harbor"
      exit 2
    fi
  done
) &

exec ./run.sh
