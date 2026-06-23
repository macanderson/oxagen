#!/usr/bin/env bash
# Single-flight + debounce guard for Claude Code hooks.
#
# WHY: hooks fire per tool-call across EVERY subagent. With parallel agents,
# heavy hook commands (telemetry backfill via tsx, `pnpm lint`, `pnpm gate`)
# spawn faster than they finish and pile up — each a multi-hundred-MB Node
# tree — ballooning memory to OOM and killing the host terminal. This guard:
#   * single-flight: only ONE run per lock name at a time (atomic mkdir),
#   * debounce: skip if the same hook ran within N seconds,
#   * stale-lock reaping: a holder that died without releasing won't wedge it.
# It also collapses duplicate project+user hook definitions (same lock name).
#
# Usage: hook-guard.sh <lock-name> <debounce-seconds> '<inner shell command>'
# The inner command runs via `eval` from $CLAUDE_PROJECT_DIR (bash).
set -u

lockname="${1:?lock name required}"
debounce="${2:?debounce seconds required}"
shift 2
cmd="$*"

now=$(date +%s)
lockdir="${TMPDIR:-/tmp}/oxagen-hook-${lockname}.lock"
stamp="${TMPDIR:-/tmp}/oxagen-hook-${lockname}.stamp"

# Reap a stale lock whose holder died before releasing (older than 15 min).
# Must exceed the slowest guarded command's runtime, or a live holder gets its
# lock reaped mid-run and the next hook fires a SECOND copy on top of it — which
# is exactly how concurrent full gates stacked and OOM'd the box (2026-06-23).
# `find -mmin` has identical syntax on BSD and GNU; `stat -f` does not
# (GNU `stat -f` means --file-system, which silently breaks this check).
if [ -d "$lockdir" ] && find "$lockdir" -maxdepth 0 -mmin +15 2>/dev/null | grep -q .; then
  rmdir "$lockdir" 2>/dev/null
fi

# Single-flight: mkdir is atomic. If another run holds the lock, bail quietly.
mkdir "$lockdir" 2>/dev/null || exit 0
trap 'rmdir "$lockdir" 2>/dev/null' EXIT

# Debounce: skip if we already ran within the window.
last=$(cat "$stamp" 2>/dev/null || echo 0)
if [ $((now - last)) -lt "$debounce" ]; then
  exit 0
fi
echo "$now" > "$stamp"

cd "${CLAUDE_PROJECT_DIR:-$(pwd)}" 2>/dev/null || exit 0
eval "$cmd"
