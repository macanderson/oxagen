#!/usr/bin/env bash
# Detached launcher for the single-shot-r3 SWE-bench job (cheap mode: default
# one-shot scaffold, no best-of-N — the config that resolved django-11099 at
# $0.30 in smoke-sonnet5). Watchdog floor $3.
set -euo pipefail
cd "$(dirname "$0")"

export OXAGEN_CLI_BUNDLE=/Users/macanderson/Workspaces/oxagen-bench-20260707/apps/cli/dist-standalone/oxagen.mjs
export TASK_IDS="sympy__sympy-13031 matplotlib__matplotlib-13989 psf__requests-2317 pytest-dev__pytest-5631"
export OXAGEN_PREWARMED=1
export N_CONCURRENT=2
export JOB_NAME=single-shot-r3

(
  for _ in $(seq 1 60); do
    sleep 180
    BAL=$(curl -s --max-time 20 https://ai-gateway.vercel.sh/v1/credits \
          -H "Authorization: Bearer ${AI_GATEWAY_API_KEY}" \
          | python3 -c "import json,sys; print(json.load(sys.stdin).get('balance','ERR'))" 2>/dev/null || echo ERR)
    echo "$(date '+%H:%M:%S') balance=$BAL" >> watchdog-r3.log
    pgrep -f ".venv/bin/harbor" >/dev/null 2>&1 || { echo "harbor gone; watchdog exit" >> watchdog-r3.log; exit 0; }
    if [[ "$BAL" =~ ^[0-9.]+$ ]] && python3 -c "import sys; sys.exit(0 if float('$BAL') < 3 else 1)"; then
      echo "$(date '+%H:%M:%S') BALANCE $BAL < 3 — killing harbor" >> watchdog-r3.log
      pkill -f ".venv/bin/harbor"
      exit 2
    fi
  done
) &

exec ./run.sh
