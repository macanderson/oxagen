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

# A failed SSM command used to leave this exiting 0.
# shellcheck disable=SC2016  # the single quotes are the point: this is the
# literal text to find in the script under test, not an expression to expand.
contains "$SCRIPT" 'if [[ $st != "Success" ]]; then' "script: a failed run exits non-zero"

# --- result ---------------------------------------------------------------

if [[ $FAILED -gt 0 ]]; then
  echo "render-remote-migration: $FAILED of $CASES assertions failed" >&2
  exit 1
fi
echo "render-remote-migration: $CASES assertions passed"
