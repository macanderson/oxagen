#!/usr/bin/env bash
# Bulletproof teardown for ANY bench run (swe-bench or terminal-bench).
#
# THE $186 LESSON (2026-07-08): killing `harbor` does NOT stop spend. The
# oxagen agent runs INSIDE each Docker trial container; a bare `pkill harbor`
# leaves those containers running and their in-container agents keep making
# gateway LLM calls (to maxSteps) — orphaned agents from repeated launches
# burned ~$186 over hours. The ONLY safe stop is to remove every trial
# container. Run this to stop a run, and let launchers trap to it on exit.
#
# Never touches the shared datastores (oxagen-v2 postgres/clickhouse/neo4j) or
# other explicitly-protected containers.
set -uo pipefail

PROTECT_RE='oxagen-v2|confident_bohr'

echo "==> stop-bench: killing orchestrators…"
pkill -9 -f "launch-tbench" 2>/dev/null
pkill -9 -f "launch-r[0-9]"  2>/dev/null
pkill -9 -f "\.venv/bin/harbor" 2>/dev/null
pkill -9 -f "uv run harbor"     2>/dev/null
pkill -9 -f "bench/.*run\.sh"   2>/dev/null
pkill -9 -f "caffeinate -i .*run.sh" 2>/dev/null

echo "==> stop-bench: removing ALL trial containers (in-container agents = the real spenders)…"
# Two passes with a short grace so a container spawned during teardown is caught.
# Filter by name via grep -vE against the protect regex (datastores survive).
for pass in 1 2; do
  ids="$(docker ps -a --format '{{.ID}} {{.Names}}' 2>/dev/null | grep -vE " (${PROTECT_RE})" | awk '{print $1}')"
  [ -z "$ids" ] && break
  printf '%s\n' "$ids" | xargs -r -P8 docker rm -f >/dev/null 2>&1
  sleep 1
done

echo "==> stop-bench: done. Protected (datastores) still up:"
docker ps --format '  {{.Names}}' 2>/dev/null | grep -E "$PROTECT_RE" || echo "  (none)"
echo "==> non-datastore containers remaining: $(docker ps --format '{{.Names}}' 2>/dev/null | grep -vcE "$PROTECT_RE")"
