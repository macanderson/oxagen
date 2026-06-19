#!/usr/bin/env bash
# Stop hook — the enforcing half of "wrap up finished work with visible proof".
#
# If THIS session edited project files (recorded by oxagen-run-record-edit.sh) and
# we have not already reminded since the last edit, block the stop ONCE and ask for
# proof via the oxagen-run skill. The `reminded` marker guarantees the next Stop
# attempt succeeds, so there is no infinite loop; a freshly-touched `edits` marker
# (newer than `reminded`) re-arms the nudge for the next batch of work. Silent
# (lets the stop proceed) on read-only / chat turns where nothing was edited.
#
# Description-based skill triggering was measured at ~5/9 on positive prompts for
# this action-skill, so "always prove your work" is enforced here deterministically
# rather than left to the model noticing the skill.
set -uo pipefail

in=$(cat)
sid=$(printf '%s' "$in" | jq -r '.session_id // "nosession"' 2>/dev/null || echo nosession)
d="${TMPDIR:-/tmp}/claude-oxagen-run"
e="$d/${sid}.edits"
r="$d/${sid}.reminded"

# Nothing edited this session -> let the stop proceed.
[ -f "$e" ] || exit 0

# Already reminded since the last edit -> let the stop proceed (prevents a loop).
if [ -f "$r" ] && [ ! "$e" -nt "$r" ]; then
  exit 0
fi

touch "$r"

jq -n '{
  decision: "block",
  reason: "Wrap-up check (oxagen-run): you edited project files this session but have not yet shown visible proof the change works in the running app. Before you finish, use the oxagen-run skill: bring the local stack up safely (reuse it if already healthy; do not kill servers a parallel session is using), log in with creds.json, exercise the surface you changed, and capture screenshots of the success state. For changes with no visible surface, capture the equivalent runtime evidence instead (the API response, a SELECT after a migration, or the Inngest dev log). Then present that proof. If proof is genuinely not applicable to this change, say one line on why and then stop."
}'

exit 0
