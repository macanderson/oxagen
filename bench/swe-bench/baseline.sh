#!/usr/bin/env bash
#
# Fixed-subset baseline: oxagen vs claude-code, same model, same gateway.
#
# Both agents route through the Vercel AI Gateway (oxagen natively; claude-code
# via its Anthropic-compatible /v1/messages endpoint + ANTHROPIC_BASE_URL), so
# model, provider path, and network are held constant — a pure scaffold
# comparison per README "Fairness & methodology".
#
# Usage:
#   AI_GATEWAY_API_KEY=... ./baseline.sh              # both agents
#   AGENTS="oxagen" ./baseline.sh                     # one agent only
#   TASKS_OVERRIDE="django__django-11099" ./baseline.sh
set -euo pipefail
cd "$(dirname "$0")"

# Fixed 10-task subset of SWE-bench Verified spanning all major repos.
# Keep this list STABLE across iterations so runs stay comparable.
TASKS="${TASKS_OVERRIDE:-django__django-11099 astropy__astropy-14995 sympy__sympy-11618 scikit-learn__scikit-learn-10297 pytest-dev__pytest-5631 sphinx-doc__sphinx-10323 matplotlib__matplotlib-13989 pylint-dev__pylint-6386 psf__requests-2317 pydata__xarray-3095}"

MODEL="${OXAGEN_MODEL_SLUG:-anthropic/claude-sonnet-5}"
AGENTS="${AGENTS:-oxagen claude-code}"
N_CONCURRENT="${N_CONCURRENT:-2}"
STAMP="$(date +%Y%m%d-%H%M%S)"

[ -n "${AI_GATEWAY_API_KEY:-}" ] || { echo "AI_GATEWAY_API_KEY required" >&2; exit 1; }

for agent in $AGENTS; do
  echo "================================================================"
  echo "  baseline[$STAMP] agent=$agent model=$MODEL n_concurrent=$N_CONCURRENT"
  echo "================================================================"
  if [ "$agent" = "claude-code" ]; then
    # Same gateway + same slug as oxagen. Harbor keeps the full slug when
    # ANTHROPIC_BASE_URL is set and pins all model aliases to it.
    export ANTHROPIC_API_KEY="$AI_GATEWAY_API_KEY"
    export ANTHROPIC_BASE_URL="https://ai-gateway.vercel.sh"
  else
    unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL || true
  fi
  AGENT="$agent" OXAGEN_MODEL_SLUG="$MODEL" TASK_IDS="$TASKS" \
    N_CONCURRENT="$N_CONCURRENT" JOBS_DIR="./results-$agent" ./run.sh

  newest="$(find "./results-$agent" -mindepth 1 -maxdepth 1 -type d -exec test -e '{}/result.json' \; -print 2>/dev/null | sort | tail -n1)"
  if [ -n "$newest" ]; then
    JOBS_DIR="./results-$agent" python3 emit_eval_json.py "$newest" || true
  fi
done

echo
echo "==> Per-agent summary"
python3 summarize.py ./results-oxagen ./results-claude-code 2>/dev/null || true
