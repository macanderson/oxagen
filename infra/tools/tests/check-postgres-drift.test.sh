#!/usr/bin/env bash
#
# Holds the Postgres drift check to the one thing it is for: saying so when a
# committed Atlas migration has not reached production (#1275).
#
# Every assertion is about what the script CONCLUDES from `atlas migrate
# status` output, which is the part a live run exercises worst. A production
# database that happens to be current proves nothing about the three states
# that matter — behind, never-stamped, and unreadable — and it can only be in
# one of them at a time. They must not collapse into one another: the response
# to "apply the pending migration" and to "the revision table is empty, do not
# apply" are opposites, and the response to "unknown" is neither.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TOOLS=$(cd "$HERE/.." && pwd)

# Sourcing returns before the script talks to production — see its source guard.
# shellcheck source=infra/tools/check-postgres-drift.sh
source "$TOOLS/check-postgres-drift.sh"

FAILED=0
CASES=0

pass() { CASES=$((CASES + 1)); }
fail() {
  CASES=$((CASES + 1))
  FAILED=$((FAILED + 1))
  echo "FAIL: $1" >&2
}

contains() {
  local haystack=$1 needle=$2 label=$3
  case "$haystack" in
    *"$needle"*) pass ;;
    *) fail "$label — expected to find: $needle" ;;
  esac
}

lacks() {
  local haystack=$1 needle=$2 label=$3
  case "$haystack" in
    *"$needle"*) fail "$label — expected NOT to find: $needle" ;;
    *) pass ;;
  esac
}

expect_code() {
  local want=$1 got=$2 label=$3
  if [[ $want == "$got" ]]; then pass; else fail "$label — wanted exit $want, got $got"; fi
}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/postgres-drift-test-XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# --- a store at the head ---------------------------------------------------

cat > "$WORK/ok.txt" <<'EOF'
Migration Status: OK
  -- Current Version: 20260919120000
  -- Next Version:    Already at latest version
  -- Executed Files:  188
  -- Pending Files:   0
EOF
OUT=$(classify_atlas_status "$WORK/ok.txt" 188); CODE=$?
expect_code 0 "$CODE" "a store at the head is current"
contains "$OUT" "current" "the current message says so"
lacks "$OUT" "::error::" "a current store raises no error annotation"

# Atlas omits the zero `Pending Files` line in some versions. That must read as
# current, not as a parse failure — OK is the verdict and the field only
# corroborates it.
cat > "$WORK/ok-terse.txt" <<'EOF'
Migration Status: OK
  -- Current Version: 20260919120000
  -- Executed Files:  188
EOF
OUT=$(classify_atlas_status "$WORK/ok-terse.txt" 188); CODE=$?
expect_code 0 "$CODE" "OK without a Pending Files line is still current"

# --- a store one migration behind ------------------------------------------

cat > "$WORK/pending.txt" <<'EOF'
Migration Status: PENDING
  -- Current Version: 20260918090000
  -- Next Version:    20260919120000
  -- Executed Files:  187
  -- Pending Files:   1
  -- 20260919120000_add_durable_token_usage.sql
EOF
OUT=$(classify_atlas_status "$WORK/pending.txt" 188); CODE=$?
expect_code 1 "$CODE" "a store behind the repository is behind"
contains "$OUT" "::error::" "being behind is annotated as an error"
contains "$OUT" "behind this repository" "the message names the condition"
contains "$OUT" "20260919120000_add_durable_token_usage.sql" "the message names the pending file"
contains "$OUT" "run-db-migrations.sh packages/database --apply" \
  "the message names the script that reaches Aurora"
contains "$OUT" "DB Migrate (manual)" "the message names the dispatch that runs the same script"

# The pending list is a convenience, not the verdict. A version of Atlas that
# prints no file names must still block.
cat > "$WORK/pending-nolist.txt" <<'EOF'
Migration Status: PENDING
  -- Current Version: 20260918090000
  -- Next Version:    20260919120000
  -- Executed Files:  187
  -- Pending Files:   1
EOF
OUT=$(classify_atlas_status "$WORK/pending-nolist.txt" 188); CODE=$?
expect_code 1 "$CODE" "a pending store with no file list is still behind"

# --- a store whose revision table is empty ---------------------------------
#
# The distinction this script exists to draw. Applying from here re-creates
# objects that already exist, so the message must not read as "apply this".

cat > "$WORK/virgin.txt" <<'EOF'
Migration Status: PENDING
  -- Current Version: No migration applied yet
  -- Next Version:    20250101000000
  -- Executed Files:  0
  -- Pending Files:   188
EOF
OUT=$(classify_atlas_status "$WORK/virgin.txt" 188); CODE=$?
expect_code 1 "$CODE" "an unstamped store blocks like any other behind store"
contains "$OUT" "revision table is empty" "the message names the real cause"
contains "$OUT" "do NOT apply" "the message refuses the apply that would break it"
lacks "$OUT" "apply with infra/tools/run-db-migrations.sh" \
  "an unstamped store is not told to apply — that is the opposite of the right move"

# --- output that answers nothing -------------------------------------------
#
# The failure that put this family of checks in the repository was a tool
# exiting 0 with no rows and the caller reading it as a clean store (#3036).
# Unknown must never be current.

: > "$WORK/empty.txt"
OUT=$(classify_atlas_status "$WORK/empty.txt" 188); CODE=$?
expect_code 2 "$CODE" "no output at all is unknown, not current"

cat > "$WORK/garbage.txt" <<'EOF'
An error occurred (AccessDeniedException) when calling the SendCommand operation
EOF
OUT=$(classify_atlas_status "$WORK/garbage.txt" 188); CODE=$?
expect_code 2 "$CODE" "output with no status line is unknown, not current"
contains "$OUT" "unknown, not current" "the unknown message refuses to claim currency"

cat > "$WORK/unknown-verdict.txt" <<'EOF'
Migration Status: UNDER_DEVELOPMENT
  -- Executed Files:  188
EOF
OUT=$(classify_atlas_status "$WORK/unknown-verdict.txt" 188); CODE=$?
expect_code 2 "$CODE" "a verdict this check cannot read is unknown, not current"

# A contradiction is unknown too. OK with pending files means the output is not
# what it appears to be, and guessing which half to believe is how a gate
# passes a store it should have stopped.
cat > "$WORK/contradiction.txt" <<'EOF'
Migration Status: OK
  -- Executed Files:  187
  -- Pending Files:   1
EOF
OUT=$(classify_atlas_status "$WORK/contradiction.txt" 188); CODE=$?
expect_code 2 "$CODE" "OK alongside pending files is unknown, not current"

# OK against a shorter directory than this commit declares. Pending is zero
# because that older directory is fully applied. The gate must still block.
cat > "$WORK/ok-short.txt" <<'EOF'
Migration Status: OK
  -- Current Version: 20260918090000
  -- Executed Files:  187
  -- Pending Files:   0
EOF
OUT=$(classify_atlas_status "$WORK/ok-short.txt" 188); CODE=$?
expect_code 1 "$CODE" "OK with fewer executed files than declared is behind"
contains "$OUT" "not taken against this commit" "the message names the mismatched directory"

cat > "$WORK/ok-long.txt" <<'EOF'
Migration Status: OK
  -- Executed Files:  189
  -- Pending Files:   0
EOF
OUT=$(classify_atlas_status "$WORK/ok-long.txt" 188); CODE=$?
expect_code 2 "$CODE" "OK with more executed files than declared is unknown"

# A pending list longer than the 20-line SSM tail used to hide the verdict.
# shellcheck source=infra/tools/run-db-migrations.sh
source "$TOOLS/run-db-migrations.sh"
{
  echo "Migration Status: PENDING"
  echo "  -- Executed Files:  0"
  echo "  -- Pending Files:   188"
  i=0
  while [[ $i -lt 30 ]]; do
    printf '  -- 202601010000%02d_file.sql\n' "$i"
    i=$((i + 1))
  done
} > "$WORK/long-status.txt"
visible_stream "$(cat "$WORK/long-status.txt")" > "$WORK/tailed.txt"
OUT=$(classify_atlas_status "$WORK/tailed.txt" 188); CODE=$?
expect_code 1 "$CODE" "a tailed status that kept the header is still the empty-revision case"
contains "$OUT" "revision table is empty" "the tailed output still names the empty revision table"

# --- the script never applies ----------------------------------------------
#
# The same guarantee check-store-drift.test.sh holds over its own script. A
# read-only gate that grew an apply would become the thing that migrates
# production from a deploy job, which is the decision CLAUDE.md made the other
# way.

# Comments are stripped first. The header discusses `--apply` at length — that
# prose is the point, and asserting over it would match the documentation
# rather than the code. The `echo` lines go too: the behind verdict names the
# apply command for the operator to run by hand, and an echo applies nothing.
CODE_ONLY=$(sed 's/#.*$//' "$TOOLS/check-postgres-drift.sh")
CODE_COMMANDS=$(printf '%s\n' "$CODE_ONLY" | awk '$1 != "echo"')
lacks "$CODE_COMMANDS" "--apply" "the drift check never passes --apply"
lacks "$CODE_ONLY" "migrate apply" "the drift check never invokes atlas migrate apply"
contains "$CODE_ONLY" "run-db-migrations.sh" "the drift check reaches production the one way that works"

# The early label has to see the ClickHouse baseline. check-store-drift.sh
# applies packages/telemetry/src/schema.sql on every migrate, outside the ledger.
LABEL_WF="$TOOLS/../../.github/workflows/migration-label.yml"
contains "$(cat "$LABEL_WF")" "packages/telemetry/src/schema.sql" \
  "migration-label watches the ClickHouse baseline schema"

# --- the declared count is not optional in practice -------------------------
#
# Passing 0 keeps the verdict right and only loses the message's specificity.
# Asserted so a caller that cannot count files still gets a blocking answer
# rather than a pass.

OUT=$(classify_atlas_status "$WORK/pending.txt" 0); CODE=$?
expect_code 1 "$CODE" "a pending store with no declared count is still behind"

OUT=$(classify_atlas_status "$WORK/virgin.txt" 0); CODE=$?
expect_code 1 "$CODE" "an unstamped store with no declared count is still behind"

# ---------------------------------------------------------------------------

if [[ $FAILED -gt 0 ]]; then
  echo "check-postgres-drift: $FAILED of $CASES assertions failed" >&2
  exit 1
fi
echo "check-postgres-drift: $CASES assertions passed"
