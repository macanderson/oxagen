#!/usr/bin/env bash
# Detached launcher for the bo3-headtohead-r4 job: the recommended optimal
# (differentiated) config, best-of-3 cross-family, on the two tasks that also
# have single-shot verdicts (requests-2317, sympy-13031) — the direct
# cheap-vs-optimal comparison. Serialized (N_CONCURRENT=1) so the budget
# watchdog stops between trials, not mid-flight. Floor $5.
set -euo pipefail
cd "$(dirname "$0")"

export OXAGEN_CLI_BUNDLE=/Users/macanderson/Workspaces/oxagen-bench-20260707/apps/cli/dist-standalone/oxagen.mjs
export TASK_IDS="psf__requests-2317 sympy__sympy-13031"
export OXAGEN_DIFFERENTIATED=1
export OXAGEN_BEST_OF_N_CANDIDATES=3
# Cost-rational judge stack (gateway /v1/models pricing, 2026-07-07):
# gpt-5.5-pro is $30/$180 per 1M — 15x gemini-3-pro, 18x sonnet-5. Judge and
# advisor read verify-auto's EXECUTED test evidence, so discrimination quality
# survives the downgrade; candidate #3 keeps cross-family diversity on the
# non-pro gpt-5.5 ($5/$30) instead of pro.
export OXAGEN_BEST_OF_N_MODELS="anthropic/claude-fable-5,anthropic/claude-fable-5,openai/gpt-5.5"
export OXAGEN_LLM_ADVISOR="google/gemini-3-pro-preview"
export OXAGEN_LLM_SELECTOR="anthropic/claude-sonnet-5"
export OXAGEN_PREWARMED=1
export N_CONCURRENT=1
export JOB_NAME=bo3-headtohead-r4

(
  for _ in $(seq 1 80); do
    sleep 180
    BAL=$(curl -s --max-time 20 https://ai-gateway.vercel.sh/v1/credits \
          -H "Authorization: Bearer ${AI_GATEWAY_API_KEY}" \
          | python3 -c "import json,sys; print(json.load(sys.stdin).get('balance','ERR'))" 2>/dev/null || echo ERR)
    echo "$(date '+%H:%M:%S') balance=$BAL" >> watchdog-r4.log
    pgrep -f ".venv/bin/harbor" >/dev/null 2>&1 || { echo "harbor gone; watchdog exit" >> watchdog-r4.log; exit 0; }
    if [[ "$BAL" =~ ^[0-9.]+$ ]] && python3 -c "import sys; sys.exit(0 if float('$BAL') < 5 else 1)"; then
      echo "$(date '+%H:%M:%S') BALANCE $BAL < 5 — killing harbor" >> watchdog-r4.log
      pkill -f ".venv/bin/harbor"
      exit 2
    fi
  done
) &

exec ./run.sh
