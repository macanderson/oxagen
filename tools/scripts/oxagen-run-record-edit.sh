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
  "${CLAUDE_PROJECT_DIR:-/nonexistent}"/.claude/worktrees/*)
    # Subagents launched into an isolated worktree (EnterWorktree name:) share
    # the PARENT session's session_id but write under
    # $CLAUDE_PROJECT_DIR/.claude/worktrees/<agent>/ — without this exclusion
    # those edits would fall into the general case below and continuously
    # re-touch the PARENT's edits marker, re-arming the Stop hook
    # (oxagen-run-wrapup-reminder.sh) on every turn even when the orchestrating
    # session itself made no edits. Those worktrees are isolated agent
    # branches with their own proof obligations (their own PR/verification),
    # not this session's — so their edits are ignored here. Must come before
    # the general project-dir pattern below since case matches the first hit.
    ;;
  "${CLAUDE_PROJECT_DIR:-/nonexistent}"/*)
    sid=$(printf '%s' "$in" | jq -r '.session_id // "nosession"' 2>/dev/null || echo nosession)
    d="${TMPDIR:-/tmp}/claude-oxagen-run"
    mkdir -p "$d"
    touch "$d/${sid}.edits"
    ;;
esac

exit 0
