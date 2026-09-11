#!/usr/bin/env bash
#
# Holds the production migration path to the account it actually runs in.
#
# Every assertion here fails against the pre-#2652 script, which targeted the
# retired account: it exec'd into a Postgres container that the current node
# does not run, read the password from a parameter path that no longer exists,
# and connected to localhost. None of that can be caught by running the script,
# because running it needs the very account whose shape is in question — so the
# rendered text is the thing under test.

set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TOOLS=$(cd "$HERE/.." && pwd)

# Sourcing returns before the script's own body runs — see its source guard.
# shellcheck source=infra/tools/run-db-migrations.sh
source "$TOOLS/run-db-migrations.sh"

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

# --- the rendered remote script -------------------------------------------

DRY=$(render_remote_migration \
  "test-bucket" "clus.example.rds.amazonaws.com" "5432" "oxagen" "oxagen" "0" "0")

lacks "$DRY" "docker exec" "dry run: no docker exec anywhere"
lacks "$DRY" "/oxagen-data/postgres/password" "dry run: retired parameter path is gone"
contains "$DRY" "/oxagen-app/postgres/password" "dry run: reads the current parameter path"
lacks "$DRY" "localhost:5432" "dry run: does not connect to loopback"
contains "$DRY" "@clus.example.rds.amazonaws.com:5432/oxagen" "dry run: connects to the given endpoint"
contains "$DRY" "sslmode=require" "dry run: requires TLS"

# The connection carries the RLS bypass, and it is the reason a managed cluster
# can run this directory at all (#1368). Aurora has no superuser, so nothing
# bypasses RLS for free; the seed in 20260614000000 inserts mcp.registries'
# global row with org_id = NULL, and the tenant_isolation policy in force at
# that point in the history has the `org_id IS NULL` arm in USING and not in
# WITH CHECK. Without the GUC the apply stops there, 42501, on file 14 of the
# directory. Atlas replays in version order, so no forward migration can reach
# back and fix the policy the seed runs under — the connection is the only
# place this can live, which is why it is asserted here rather than in SQL.
contains "$DRY" "app.rls_bypass" "dry run: the migration connection carries the RLS bypass"
contains "$DRY" "options=-c%20app.rls_bypass%3Don" \
  "dry run: the bypass is percent-encoded, as a URL query value must be"
contains "$DRY" "sslmode=require&options=" \
  "dry run: appended to the existing query string with & rather than a second ?"
# A raw space or a raw `=` in the value would be read as URL structure and the
# parameter would arrive malformed or not at all — a failure that looks like
# the policy refusing the row rather than like a broken connection string.
lacks "$DRY" "options=-c app.rls_bypass=on" "dry run: the bypass is not left unencoded"

# The bug that split this file out: the upload used a variable and the
# download used a literal, so they could name different buckets.
contains "$DRY" "s3://test-bucket/_deploy/atlas-migrations.tgz" "dry run: bucket substituted into the download"
lacks "$DRY" "oxagen-deploy-578673726240" "dry run: no hardcoded old-account bucket"
lacks "$DRY" "__" "dry run: no placeholder survives"

# The password is read on the node, never here.
contains "$DRY" "set +x" "dry run: tracing is turned off around the secret"

# A dry run must not apply.
lacks "$DRY" "atlas migrate apply --env ci" "dry run: does not apply"
contains "$DRY" "atlas migrate status --env ci" "dry run: reports status"

APPLY=$(render_remote_migration \
  "test-bucket" "clus.example.rds.amazonaws.com" "5432" "oxagen" "oxagen" "1" "0")
contains "$APPLY" "atlas migrate apply --env ci" "apply: applies"
# The apply is the run that actually meets the seed, so it is the one that must
# carry the bypass. Asserted separately from the dry run because the two are
# rendered down different branches.
contains "$APPLY" "options=-c%20app.rls_bypass%3Don" "apply: carries the RLS bypass"
lacks "$APPLY" "--allow-dirty" "apply: clean by default"

DIRTY=$(render_remote_migration \
  "test-bucket" "clus.example.rds.amazonaws.com" "5432" "oxagen" "oxagen" "1" "1")
contains "$DIRTY" "atlas migrate apply --env ci --allow-dirty" "apply: --allow-dirty is opt-in"

# An empty argument renders a script that fails on the wrong thing.
if render_remote_migration "" "h" "5432" "d" "u" "0" "0" >/dev/null 2>&1; then
  fail "empty bucket should be refused"
else
  pass
fi
if render_remote_migration "b" "h" "5432" "d" "u" "0" >/dev/null 2>&1; then
  fail "wrong argument count should be refused"
else
  pass
fi

# --- the shipped outer script ---------------------------------------------

SCRIPT=$(cat "$TOOLS/run-db-migrations.sh")

lacks "$SCRIPT" "docker exec" "script: no docker exec anywhere"
lacks "$SCRIPT" "i-023d002d6e44f8f84" "script: retired instance is gone"
lacks "$SCRIPT" "oxagen-deploy-578673726240" "script: retired deploy bucket is gone"
lacks "$SCRIPT" "i-094fcb34c7e715cf8" "script: pins no instance id"
contains "$SCRIPT" "tag:Name,Values=" "script: resolves the app node by tag"
contains "$SCRIPT" "oxagen-deploy-916294258235" "script: targets the current deploy bucket"
contains "$SCRIPT" "oxagen-postgres" "script: names the Aurora cluster"

# --- how the SSM invocation is judged --------------------------------------
#
# Behaviour, not text: these three endings are the script's contract with
# whatever runs it, and the middle one used to be wrong. Running out of polls
# left the status at `InProgress`, which is not `Success`, so a command that
# had not finished was reported as one that had failed — and the obvious
# response to a failed migration is to run it again, over an apply still in
# flight.

verdict_code() {
  invocation_verdict "$@" >/dev/null 2>&1
  echo $?
}

verdict_stderr() {
  invocation_verdict "$@" 2>&1 >/dev/null
}

expect_code() {
  local want=$1 got=$2 label=$3
  if [[ $want == "$got" ]]; then pass; else fail "$label — wanted exit $want, got $got"; fi
}

expect_code 0 "$(verdict_code Success 0 cmd-1 i-abc us-east-1 600)" \
  "a completed successful invocation exits 0"
expect_code 1 "$(verdict_code Failed 0 cmd-1 i-abc us-east-1 600)" \
  "a completed failed invocation exits 1"
expect_code 1 "$(verdict_code TimedOut 0 cmd-1 i-abc us-east-1 600)" \
  "SSM's own TimedOut is a completed failure and exits 1"
expect_code 2 "$(verdict_code InProgress 1 cmd-1 i-abc us-east-1 600)" \
  "giving up waiting is its own outcome and exits 2, not 1"

# The distinction is only useful if the message carries it. A run that gave up
# waiting must say the command is still going and must say not to re-run.
STILL=$(verdict_stderr InProgress 1 cmd-1 i-abc us-east-1 600)
contains "$STILL" "NOT a failure" "still-running: says it is not a failure"
contains "$STILL" "Do NOT re-run" "still-running: forbids the dangerous next step"
contains "$STILL" "cmd-1" "still-running: names the command to watch"
contains "$STILL" "i-abc" "still-running: names the instance"
lacks "$STILL" "FAILED" "still-running: does not call itself a failure"

FAILED_MSG=$(verdict_stderr Failed 0 cmd-2 i-abc us-east-1 600)
contains "$FAILED_MSG" "FAILED" "failed: says so"
lacks "$FAILED_MSG" "Do NOT re-run" "failed: a real failure may be re-run once fixed"

# --- the silent output cap -------------------------------------------------
#
# ssm get-command-invocation returns at most 24,000 characters per stream and
# does not say when it cut. On an apply that ceiling lands in the middle of
# the list of migrations that ran against production.

SHORT=$(truncation_note stdout 100 2>&1)
[[ -z $SHORT ]] && pass || fail "a stream that fitted must produce no warning, got: $SHORT"

CUT=$(truncation_note stdout 24000 2>&1)
contains "$CUT" "truncated" "at the cap: warns the record is incomplete"
contains "$CUT" "stdout" "at the cap: names the stream"

# --- the atlas project the node is handed ----------------------------------
#
# Checked here rather than on the node: without env "ci" the remote fails two
# minutes in, after a tarball, an S3 upload and an SSM round trip, on a
# message about a project file that reads like a broken instance.

FIXTURE=$(mktemp -d "${TMPDIR:-/tmp}/atlas-fixture-XXXXXX")
trap 'rm -rf "$FIXTURE"' EXIT

mkdir -p "$FIXTURE/good/atlas/migrations"
printf 'env "ci" {\n  url = getenv("DATABASE_URL")\n}\n' > "$FIXTURE/good/atlas.hcl"
assert_atlas_project "$FIXTURE/good" 2>/dev/null && pass || fail "a complete project is accepted"

mkdir -p "$FIXTURE/no-hcl/atlas/migrations"
assert_atlas_project "$FIXTURE/no-hcl" 2>/dev/null && fail "a project with no atlas.hcl must be refused" || pass

mkdir -p "$FIXTURE/no-ci/atlas/migrations"
printf 'env "local" {\n  url = "postgres://localhost/x"\n}\n' > "$FIXTURE/no-ci/atlas.hcl"
assert_atlas_project "$FIXTURE/no-ci" 2>/dev/null && fail "an atlas.hcl without env \"ci\" must be refused" || pass
NO_CI=$(assert_atlas_project "$FIXTURE/no-ci" 2>&1)
contains "$NO_CI" 'env "ci"' "no ci env: the message names what is missing"

mkdir -p "$FIXTURE/no-migrations"
printf 'env "ci" {}\n' > "$FIXTURE/no-migrations/atlas.hcl"
assert_atlas_project "$FIXTURE/no-migrations" 2>/dev/null && fail "a project with no migrations dir must be refused" || pass

# The real database package is the thing this actually ships, so check it too.
REPO=$(cd "$TOOLS/../.." && pwd)
if [[ -d "$REPO/packages/database/atlas/migrations" ]]; then
  assert_atlas_project "$REPO/packages/database" 2>/dev/null \
    && pass || fail "packages/database does not satisfy the check the script makes of it"
fi

# --- result ---------------------------------------------------------------

if [[ $FAILED -gt 0 ]]; then
  echo "render-remote-migration: $FAILED of $CASES assertions failed" >&2
  exit 1
fi
echo "render-remote-migration: $CASES assertions passed"
