#!/usr/bin/env bash
# PostToolUse(Write|Edit) hook — half of the "wrap up with visible proof" pair.
#
# Records that THIS session edited a file *inside the project*, so the Stop hook
# (oxagen-run-wrapup-reminder.sh) knows real work happened and can nudge for proof
# via the oxagen-run skill. Edits outside $CLAUDE_PROJECT_DIR (auto-memory under
# ~/.claude, /tmp scratch, etc.) are ignored, so chat/admin/read turns never arm
# the reminder. Keyed on session_id so parallel sessions don't cross-pollinate.
#
# Intentionally trivial (one jq parse + a touch) and NOT routed through
# hook-guard.sh: it must run on every edit, and debouncing would drop edits.
set -uo pipefail

in=$(cat)
f=$(printf '%s' "$in" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null || true)

case "$f" in
  "${CLAUDE_PROJECT_DIR:-/nonexistent}"/*)
    sid=$(printf '%s' "$in" | jq -r '.session_id // "nosession"' 2>/dev/null || echo nosession)
    d="${TMPDIR:-/tmp}/claude-oxagen-run"
    mkdir -p "$d"
    touch "$d/${sid}.edits"
    ;;
esac

exit 0
